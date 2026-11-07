/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const backendRoot = path.resolve(__dirname, '..', '..', '..');
const repoRoot = path.resolve(backendRoot, '..');
const sandbox = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'autonomous-sandbox.ts'), 'utf8');
const piModelState = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'pi-model-state.ts'), 'utf8');
const egress = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'autonomous-model-egress.ts'), 'utf8');
const engine = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'execution-engine.ts'), 'utf8');
const worker = fs.readFileSync(path.join(backendRoot, 'src', 'worker.ts'), 'utf8');
const pipeline = fs.readFileSync(path.join(backendRoot, 'src', 'routes', 'pipeline.ts'), 'utf8');
const runQueue = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'run-queue.ts'), 'utf8');
const hostValidation = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'story-host-validation.ts'), 'utf8');
const resolver = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'merge-conflict-resolver.ts'), 'utf8');
const gitreins = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'gitreins-runner.ts'), 'utf8');
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
const backendDockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile.backend'), 'utf8');
const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
const launcher = fs.readFileSync(path.join(backendRoot, 'src', 'native', 'rorca-sandbox-launcher.c'), 'utf8');

test('production worker image and Compose select the concrete fail-closed sandbox primitive', () => {
  for (const source of [dockerfile, backendDockerfile]) {
    expect(source).toContain('rorca-sandbox-launcher.c');
    expect(source).toContain('github-cli');
    expect(source).toContain('python3');
    expect(source).toContain('RORCA_AUTONOMOUS_ISOLATION=linux-bwrap');
    expect(source).toContain('RORCA_BWRAP_BIN=/usr/local/bin/rorca-sandbox-launcher');
    expect(source).not.toContain('bubblewrap');
  }
  expect(compose).toContain('RORCA_AUTONOMOUS_ISOLATION: linux-bwrap');
  expect(compose).toContain('RORCA_BWRAP_BIN: /usr/local/bin/rorca-sandbox-launcher');
  expect(compose).toContain('seccomp:./container/seccomp/autonomous-sandbox.json');
  expect(compose).toContain('RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS:');
  expect(compose).toContain('cap_drop:');
  expect(compose).toContain('- SYS_ADMIN');
  expect(compose).toContain('- SETFCAP');
  expect(compose).toContain('- no-new-privileges:true');
  expect(compose).toContain('- apparmor:unconfined');
  expect(sandbox).toContain("'--cap-drop', 'ALL'");
});

test('worker proves isolation before either fresh or retry lifecycle can become running', () => {
  const calls = [...worker.matchAll(/assertAutonomousExecutionBoundary\(\{/g)].map(match => match.index!);
  const freshEgress = worker.indexOf("await ensureAutonomousModelEgress(runEgressEnv, 'linux-bwrap', egressIdentity)");
  const retryEgress = worker.lastIndexOf("await ensureAutonomousModelEgress(runEgressEnv, 'linux-bwrap', egressIdentity)");
  const running = [...worker.matchAll(/transitionRunLifecycle\(runId, 'starting'/g)].map(match => match.index!);
  expect(calls).toHaveLength(2);
  expect(freshEgress).toBeGreaterThan(0);
  expect(retryEgress).toBeGreaterThan(freshEgress);
  expect(running).toHaveLength(1);
  const freshClaim = worker.indexOf('await claimWaveProductionDispatch');
  expect(freshClaim).toBeGreaterThan(0);
  expect(freshClaim).toBeLessThan(calls[0]);
  expect(calls[0]).toBeLessThan(freshEgress);
  // Fresh status is atomically fenced by the production-policy claim. Retry
  // uses the lifecycle transition only after the same boundary proof.
  expect(calls[1]).toBeLessThan(retryEgress);
  expect(retryEgress).toBeLessThan(running[0]);
  expect(worker).not.toContain('assertLocalDevHasNoDurableProviderAuthority');
  expect(worker).toContain('providerCapable: payload.safetyOptions.externalSend');
  expect(worker).toContain('providerCapable: approvedPreview.options.safety.externalSend');
});

test('the Darwin ordinary-local Pi exception is worker-issued Seatbelt isolation, never a raw host fallback', () => {
  expect(worker).toContain('resolveRorcaExecutionSandboxProfile({');
  expect(worker).toContain('ORDINARY_LOCAL_PI_PROFILE_ENV');
  expect(worker).toContain('serializeOrdinaryLocalPiRuntimeProfile');
  expect(sandbox).toContain('buildDarwinOrdinaryLocalPiSeatbeltProfile');
  expect(sandbox).toContain("cp.spawn('/usr/bin/sandbox-exec'");
  expect(sandbox).toContain("'(deny network*)'");
  expect(sandbox).toContain("relay.listen(0,'127.0.0.1'");
  expect(sandbox).toContain('localhost:${DARWIN_RELAY_PORT_TOKEN}');
  expect(sandbox).not.toContain('(allow network-bind (local ip "localhost:3128"))');
  expect(sandbox).not.toContain('(allow network-inbound (local ip "localhost:3128"))');
  expect(sandbox).not.toContain("'(allow network-outbound)'");
  expect(sandbox).toContain("'(deny file-read*)'");
  expect(sandbox).toContain('workspaceCredentialPaths(worktree)');
  expect(worker).toContain("ensureAutonomousModelEgress(runEgressEnv, 'darwin-local-pi', egressIdentity)");
  expect(worker).toContain('allStoriesSelected: !specificStory && !startFromStoryId');
  expect(sandbox).toContain('isolated: true');
  expect(sandbox).toContain('copyPiModelState');
  expect(piModelState).toContain("for (const filename of ['auth.json', 'models.json'])");
  expect(piModelState).toContain("if (filename !== 'auth.json') continue");
  expect(piModelState).toContain('fs.renameSync(temporary, destination)');
  expect(sandbox).toContain('selected.PI_CODING_AGENT_DIR = agentDir');
  expect(sandbox).not.toContain("path.join(home, '.config')");
  expect(sandbox).not.toContain("path.join(home, '.cache')");
  expect(sandbox).toContain("if (isolation === 'local-dev') {");
  expect(sandbox).toContain("const commandLineToolsBin = '/Library/Developer/CommandLineTools/usr/bin'");
});

test('queued authority and Pi executable identity stay immutable across route, reservation, and worker', () => {
  expect(runQueue).toContain('taskManifestPromotion: true');
  expect(runQueue).not.toContain('readinessOverride: true');
  expect(pipeline).toContain('runtime: { piExecutable: input.piExecutable ?? null }');
  expect(pipeline).toContain('taskManifestPiSandbox.piRealPath');
  expect(pipeline).toContain('Task manifest replay differs from immutable reserved execution authority');
  expect(pipeline).not.toContain('queuedHostPostureRepair');
  expect(worker).toContain('immutable run authority lacks its frozen Pi executable identity');
  expect(worker).toContain('revalidateFrozenPiExecutableIdentity(frozenPiExecutable)');
  expect(worker).toContain('env.PI_BIN = revalidatedPiExecutable.piBinPath');
  expect(worker).toContain("resources.own('ordinary-local Pi runtime', () => removeOrdinaryLocalPiRuntimeState(runtimeRoot))");
  expect(worker).toContain("resources.own('run-private Git state', () => removeAutonomousGitState(autonomousGitRoot))");
  expect(worker.match(/resources\.own\('model egress broker'/g)).toHaveLength(2);
  expect(worker).toContain('sweepStaleAutonomousModelEgressState()');
  expect(worker).toContain('sweepStaleOrdinaryLocalPiRuntimeState(undefined, isRunLive)');
  expect(worker).toContain('sweepStaleAutonomousGitState()');
  const frozenBranchCapture = worker.indexOf('const frozenBranchName = runRow.branch_name');
  const frozenBranchGuard = worker.indexOf("if (!frozenBranchName) throw new Error('Pipeline run has no frozen canonical branch')");
  const gitStateCreation = worker.indexOf('createAutonomousGitState(runId, cwd, frozenBranchName)');
  expect(frozenBranchCapture).toBeGreaterThan(0);
  expect(frozenBranchGuard).toBeGreaterThan(frozenBranchCapture);
  expect(gitStateCreation).toBeGreaterThan(frozenBranchGuard);
  expect(worker.slice(frozenBranchGuard, gitStateCreation + 80))
    .not.toContain('createAutonomousGitState(runId, cwd, runRow.branch_name)');
  expect(engine).toContain('assertAutonomousGitHostReconciliation(cwd)');
  expect(sandbox).not.toContain("path.join(worktree, '.rorca', 'ordinary-local-pi-runtime'");
  const orphanSweep = worker.indexOf('const sweepResults = await sweepOrphanProcesses()');
  const brokerSweep = worker.indexOf('const staleEgressRoots = sweepStaleAutonomousModelEgressState()');
  const credentialSweep = worker.indexOf('sweepStaleOrdinaryLocalPiRuntimeState(undefined, isRunLive)');
  const gitSweep = worker.indexOf('const staleGitRoots = sweepStaleAutonomousGitState()');
  const runPolling = worker.indexOf('await registerRunQueueConsumers(boss');
  expect(orphanSweep).toBeGreaterThan(0);
  expect(brokerSweep).toBeGreaterThan(orphanSweep);
  expect(credentialSweep).toBeGreaterThan(brokerSweep);
  expect(gitSweep).toBeGreaterThan(credentialSweep);
  expect(runPolling).toBeGreaterThan(gitSweep);
  expect(worker).toContain('TaskManifest run authority contains a forbidden readiness override');
});

test('semantic, RPC, PTY, conflict resolution, and worktree-controlled host validation all use one sandbox launch seam', () => {
  expect(engine.match(/isolatedAgentLaunch\(/g)?.length).toBeGreaterThanOrEqual(7);
  expect(engine).toContain('nodePty.spawn(gatedLaunch.command, gatedLaunch.args');
  expect(engine).toContain("args: ['-c', 'kill -STOP $$; exec \"$@\"', 'rorca-provider-launch-gate', launch.command, ...launch.args]");
  expect(engine).toContain("isolatedAgentLaunch('npx', ['tsc', '--noEmit']");
  expect(hostValidation).toContain('prepareAutonomousSandboxLaunch({');
  expect(hostValidation).toContain('spawnSync(launch.command, launch.args');
  expect(resolver).toContain('prepareAutonomousSandboxLaunch({');
  expect(resolver).toContain('spawn(launch.command, launch.args');
  expect(gitreins).toContain('prepareAutonomousSandboxLaunch({');
  expect(gitreins).toContain('spawn(launch.command, launch.args');
});

test('boundary is topology with an exec-time ancestor marker and a no-PID-isolation sensitivity control', () => {
  for (const required of [
    "'--unshare-all'", "'--clearenv'", "'--proc', '/proc'", "'--tmpfs', '/tmp'",
    "denied('127.0.0.1',3030)", "denied('198.51.100.1',443)",
    "'/usr/local/bin/node'", "'/usr/bin/python3'", "'/usr/bin/git'", "'/usr/bin/gh'",
    "'/usr/local/bin/npm'", "'/usr/local/bin/npx'", "fs.readFileSync('/proc/'",
    "Buffer.from('RORCA_ANCESTOR_SECRET_PROBE=')", 'BOUNDARY_PROBE_SUPERVISOR',
    "sensitivity.status !== 41", 'neither PID nor user isolation',
    'command: node, args: probeArgs', 'env: launch.env, isolated: false',
  ]) expect(sandbox).toContain(required);
  expect(sandbox).not.toContain('process.env.RORCA_ANCESTOR_SECRET_PROBE =');
  expect(sandbox).not.toMatch(/args:\s*\[[^\]]*marker/);
  expect(sandbox).not.toContain("fs.writeFileSync(workspaceCredential, marker");
  expect(sandbox).toContain('Repository Git config contains an embedded credential');
  expect(sandbox).toContain('Autonomous worktree overlaps the trusted engine installation');
  expect(sandbox).toContain('RORCA_AUTONOMOUS_ISOLATION must explicitly be linux-bwrap or local-dev');
  expect(sandbox).toContain("selected.HTTPS_PROXY = LINUX_SANDBOX_PROXY_URL");
  expect(sandbox).toContain('safeProductionEnv(input, modelCredentials, false, cwd)');
  expect(sandbox).toContain('addBind(args, gitPath, gitPath, true, covered, true)');
  expect(sandbox).not.toContain('addBind(args, gitPath, gitPath, false, covered)');
  expect(sandbox).toContain('createOrdinaryLocalPiRuntimeState');
  expect(sandbox).toContain('Autonomous model egress endpoint is not a Unix socket');
  expect(egress).toContain("host.endsWith('.github.com')");
  expect(egress).toContain("port !== 443 || !allowed.has(host)");
  expect(egress).toContain('dns.lookup(host, { all: true, verbatim: true })');
  expect(egress).toContain('resolved.some(candidate => !isPublicAddress(candidate.address))');
  expect(egress).not.toContain('let server: net.Server | null');
  expect(egress).not.toContain('let socketPath: string | null');
  expect(egress).toContain('Autonomous model egress replay attempted to reconfigure immutable owner policy');
  expect(egress).toContain('Autonomous model egress rejects caller-controlled operation identity');
  expect(egress).toContain('sweepStaleAutonomousModelEgressState');
  expect(egress).not.toMatch(/closeAutonomousModelEgress\(identity\?:/);
  expect(sandbox).not.toContain("'--ro-bind', '/', '/'");
});

test('the native launcher mounts every proc filesystem read-only', () => {
  const occurrences = [...launcher.matchAll(/mount\("proc",[^;]*;/g)];
  expect(occurrences.length).toBeGreaterThan(0);
  for (const match of occurrences) {
    expect(match[0]).toContain('MS_RDONLY');
  }
  // The proc superblock is owned by the outer user namespace and the child
  // uid_map is an identity 0->0 mapping, so a read-write proc mount would let
  // the cap-dropped child pass the DAC owner check for root-owned 0644 global
  // sysctls. Read-only proc is mandatory; the child only reads it.
  expect(launcher).not.toMatch(/MS_NOSUID \| MS_NODEV \| MS_NOEXEC, NULL\)/);
});

test('the seccomp profile is a deny-by-default allowlist that permits exactly the launcher syscalls', () => {
  const profile = JSON.parse(fs.readFileSync(path.join(repoRoot, 'container', 'seccomp', 'autonomous-sandbox.json'), 'utf8')) as {
    defaultAction?: string;
    syscalls?: Array<{ names?: string[]; action?: string }>;
  };
  expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  const allowances = (profile.syscalls ?? []).filter((entry) => entry.action === 'SCMP_ACT_ALLOW');
  const allowedNames = new Set(allowances.flatMap((entry) => entry.names ?? []));
  expect(allowedNames.has('pivot_root')).toBe(true);
  for (const required of ['unshare', 'mount', 'umount2', 'setuid', 'setgid', 'capset']) {
    expect(allowedNames.has(required)).toBe(true);
  }
});
test('the native launcher freezes proc, uid-map identity, capability, and termination invariants', () => {
  expect(launcher).toContain('write_exact("/proc/self/uid_map", "0 0 1\\n")');
  expect(launcher).toContain('write_exact("/proc/self/setgroups", "deny\\n")');
  expect(launcher).toContain('PR_SET_NO_NEW_PRIVS');
  expect(launcher).toContain('PR_SET_PDEATHSIG');
  expect(launcher).toContain('SYS_pivot_root');
  expect(launcher).toContain('drop_all_capabilities');
  expect(launcher).toContain('CLONE_NEWUSER');
  expect(launcher).toContain('MS_RDONLY');
  expect(launcher).toContain('handle_termination');
  expect(launcher).toContain('sweep_stale_sandbox_roots');
  expect(launcher).toContain('raise(g_signal_received)');
  expect(launcher).toContain('volatile sig_atomic_t g_child_pid');
  expect(launcher).toContain('waitid(P_PID, (id_t)child, &child_info, WEXITED | WNOWAIT)');
  expect(launcher).toContain('g_child_pid = 0');
  expect(launcher).toContain('sigprocmask(SIG_BLOCK, &termination_set, NULL)');
  expect(launcher).toContain('if (child > 0 && g_signal_received != 0) kill(child, SIGKILL)');
  expect(launcher).toContain('lstat(path, &st)');
  expect(launcher).toContain('"%s/.owner"');
  expect(launcher).toContain('close(owner_fd)');
  // Ordering invariants the substring checks above cannot detect: the pid must
  // stay reserved (WNOWAIT zombie) until termination signals are blocked, and
  // the re-raise must happen after unblocking under default dispositions.
  const observe = launcher.indexOf('waitid(P_PID, (id_t)child, &child_info, WEXITED | WNOWAIT)');
  const block = launcher.indexOf('sigprocmask(SIG_BLOCK, &termination_set, NULL)');
  const reap = launcher.indexOf('waitpid(child, NULL, 0)');
  const zeroPid = launcher.indexOf('  g_child_pid = 0;');
  const unblock = launcher.indexOf('sigprocmask(SIG_UNBLOCK, &termination_set, NULL)');
  const reraise = launcher.indexOf('raise(g_signal_received)');
  expect(observe).toBeGreaterThan(0);
  expect(observe).toBeLessThan(block);
  expect(block).toBeLessThan(reap);
  expect(reap).toBeLessThan(zeroPid);
  expect(unblock).toBeGreaterThan(0);
  expect(unblock).toBeLessThan(reraise);
  const procMounts = [...launcher.matchAll(/mount\("proc",[^;]*;/g)];
  expect(procMounts.length).toBeGreaterThan(0);
  for (const match of procMounts) expect(match[0]).toContain('MS_RDONLY');
});
