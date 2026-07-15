#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rorca platform contract '));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}\n${result.stderr || ''}`);
  return result;
}

async function cleanPackageRoot() {
  const packageRootIndex = process.argv.indexOf('--package-root');
  if (packageRootIndex >= 0) return path.resolve(process.argv[packageRootIndex + 1]);
  const output = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', tempRoot], { cwd: repoRoot }).stdout)[0];
  run('tar', ['-xzf', path.join(tempRoot, output.filename), '-C', tempRoot]);
  return path.join(tempRoot, 'package');
}

try {
  const packageRoot = await cleanPackageRoot();
  const runtimePath = path.join(packageRoot, 'packages', 'rorca-capture', 'dist', 'always-on.js');
  assert(existsSync(runtimePath), 'packed capture service runtime is missing');
  const {
    renderLaunchdPlist,
    renderSystemdUserService,
    renderWindowsFallbackScript,
    renderWindowsTaskSchedulerRegistration,
    resolveCaptureServicePaths,
    runCaptureServiceAction,
  } = await import(`${pathToFileURL(runtimePath).href}?smoke=${Date.now()}`);

  const home = path.join(tempRoot, 'Home With Spaces');
  const workspacePath = path.join(tempRoot, "Workspace's 100% Ready");
  const command = path.join(packageRoot, 'packages', 'rorca-capture', 'dist', 'cli.js');
  const workspace = { id: 'platform-demo', label: 'Platform Demo', path: workspacePath };
  mkdirSync(home, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  const config = { apiUrl: 'http://127.0.0.1:3030' };

  const darwinPaths = resolveCaptureServicePaths(workspace, 'darwin', home);
  const linuxPaths = resolveCaptureServicePaths(workspace, 'linux', home);
  const windowsPaths = resolveCaptureServicePaths(workspace, 'win32', home);
  assert(darwinPaths.serviceFile.startsWith(home));
  assert(linuxPaths.serviceFile.startsWith(home));
  assert(windowsPaths.serviceFile.startsWith(workspacePath));
  assert(windowsPaths.taskRegistrationFile?.endsWith('register-rorca-capture-platform-demo-task.ps1'));

  const nodeV1 = path.join(tempRoot, 'Node Runtime v1', process.platform === 'win32' ? 'node.exe' : 'node');
  const nodeV2 = path.join(tempRoot, 'Node Runtime v2', process.platform === 'win32' ? 'node.exe' : 'node');
  const launchd = renderLaunchdPlist({ workspace, command, nodePath: nodeV1, homeDir: home, paths: darwinPaths, ...config });
  const systemd = renderSystemdUserService({ workspace, command, nodePath: nodeV1, paths: linuxPaths, ...config });
  const windows = renderWindowsFallbackScript({ workspace, command, nodePath: nodeV1, ...config });
  const taskScheduler = renderWindowsTaskSchedulerRegistration({ workspace, serviceFile: windowsPaths.serviceFile, powershellPath: 'pwsh.exe' });

  assert(launchd.includes(nodeV1.replace(/&/g, '&amp;')));
  assert(launchd.includes('ProgramArguments'));
  assert(systemd.includes('ExecStart='));
  assert(systemd.includes('"') && systemd.includes('%% Ready'), 'systemd paths must quote spaces and escape percent specifiers');
  assert(windows.includes("Set-Location -LiteralPath"));
  assert(windows.includes("Workspace''s 100% Ready"), 'PowerShell paths must escape apostrophes');
  assert(taskScheduler.includes('Register-ScheduledTask'));
  assert(taskScheduler.includes('operator action required'));
  assert(!taskScheduler.includes('pack-test-token-value'));

  // A service reinstall is the supported Node-path upgrade operation. Rendering
  // must replace the old absolute runtime without touching queue/state files.
  const upgradedSystemd = renderSystemdUserService({ workspace, command, nodePath: nodeV2, paths: linuxPaths, ...config });
  assert(systemd.includes(nodeV1));
  assert(!upgradedSystemd.includes(nodeV1));
  assert(upgradedSystemd.includes(nodeV2));

  let runnerCalls = 0;
  const runner = () => { runnerCalls += 1; throw new Error('dry-run attempted a live service-manager command'); };
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const action of ['install', 'start', 'stop', 'restart', 'uninstall']) {
      const result = runCaptureServiceAction({ action, platform, workspace, command, nodePath: nodeV1, homeDir: home, ...config, dryRun: true, runner });
      assert.equal(result.ok, true);
    }
  }
  assert.equal(runnerCalls, 0, 'contract smoke must never invoke launchctl/systemctl/Task Scheduler');

  const renderedDir = path.join(tempRoot, 'rendered');
  mkdirSync(renderedDir, { recursive: true });
  const plistFile = path.join(renderedDir, 'capture.plist');
  const unitFile = path.join(renderedDir, 'capture.service');
  const psFile = path.join(renderedDir, 'capture.ps1');
  const taskFile = path.join(renderedDir, 'register-task.ps1');
  writeFileSync(plistFile, launchd, 'utf8');
  // Use the real host Node executable for systemd-analyze's executable check;
  // synthetic old/new paths above remain render-only upgrade assertions.
  writeFileSync(unitFile, renderSystemdUserService({ workspace, command, nodePath: process.execPath, paths: linuxPaths, ...config }), 'utf8');
  writeFileSync(psFile, windows, 'utf8');
  writeFileSync(taskFile, taskScheduler, 'utf8');

  let hostCheck = 'render-only';
  if (process.platform === 'darwin') {
    run('plutil', ['-lint', plistFile]);
    hostCheck = 'macOS plutil syntax (no launchctl mutation)';
  } else if (process.platform === 'linux') {
    const analyzer = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
    if (analyzer.status === 0) {
      run('systemd-analyze', ['verify', unitFile]);
      hostCheck = 'Linux systemd-analyze verify (no systemctl mutation)';
    } else {
      hostCheck = 'Linux render assertions; systemd-analyze unavailable';
    }
  } else if (process.platform === 'win32') {
    const shell = process.env.PWShPath || 'powershell.exe';
    const parseCommand = "$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:RORCA_PS_FILE,[ref]$null,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }";
    run(shell, ['-NoProfile', '-NonInteractive', '-Command', parseCommand], { env: { ...process.env, RORCA_PS_FILE: psFile } });
    run(shell, ['-NoProfile', '-NonInteractive', '-Command', parseCommand], { env: { ...process.env, RORCA_PS_FILE: taskFile } });
    hostCheck = 'Windows PowerShell parser (no Task Scheduler mutation)';
  }

  console.log(`PASS capture platform contract: ${process.platform}; ${hostCheck}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
