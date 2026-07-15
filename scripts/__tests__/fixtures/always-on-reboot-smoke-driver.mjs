#!/usr/bin/env node
/**
 * Test-only subprocess driver. Every external command is intercepted by the
 * runtime below; this file never imports or invokes the production runtime.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execute } from '../../always-on-reboot-smoke-lib.mjs';

const rootIndex = process.argv.indexOf('--root');
if (rootIndex < 0 || !process.argv[rootIndex + 1]) throw new Error('test driver requires --root');
const root = path.resolve(process.argv[rootIndex + 1]);
const commandLog = process.env.MOCK_COMMAND_LOG;
if (!commandLog) throw new Error('MOCK_COMMAND_LOG is required; refusing to run without the command interceptor audit');

const bootSeconds = Number(process.env.MOCK_BOOT_SECONDS || 1000);
let nowMs = Number(process.env.MOCK_NOW_MS || bootSeconds * 1000 + 10_000);

function record(command, args) {
  appendFileSync(commandLog, `${JSON.stringify({ mock: true, command, args })}\n`);
}

function success(stdout = '', encoding = 'utf8') {
  return {
    status: 0,
    stdout: encoding === null ? Buffer.from(stdout) : stdout,
    stderr: encoding === null ? Buffer.alloc(0) : '',
  };
}

function mockedRun(command, args, options = {}) {
  record(command, args);
  if (command === '/usr/sbin/sysctl') return success(`{ sec = ${bootSeconds}, usec = 0 }\n`);
  if (command === '/bin/ps') return success('');
  if (command === '/bin/sync' || command === '/usr/bin/plutil') return success('');
  if (command === '/usr/bin/git') {
    if (args[0] === 'rev-parse') return success('0123456789abcdef0123456789abcdef01234567\n', options.encoding);
    return success('', options.encoding);
  }
  if (command === '/bin/launchctl') {
    if (args[0] === 'bootout') return success('');
    const target = args[1] || '';
    if (target.includes('login-smoke')) return { status: 1, stdout: '', stderr: 'not loaded' };
    return success('state = running\npid = 4242\nruns = 1\n');
  }
  if (command === '/mock/node') {
    return success(JSON.stringify({ ok: true, checks: [{ scope: 'mock', name: 'all mocked', ok: true }] }));
  }
  if (command === '/usr/bin/sudo' && args.join(' ') === '/sbin/shutdown -r now') {
    const reached = process.env.MOCK_SHUTDOWN_REACHED;
    if (reached) writeFileSync(reached, 'mock shutdown reached\n');
    const hold = process.env.MOCK_SHUTDOWN_HOLD;
    while (hold && existsSync(hold)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    const status = Number(process.env.MOCK_SHUTDOWN_STATUS || 0);
    return { status, stdout: '', stderr: status === 0 ? '' : 'mock shutdown failure' };
  }
  throw new Error(`unhandled external command in test runtime: ${command} ${args.join(' ')}`);
}

const runtime = {
  kind: 'mock-test-only',
  scriptPath: path.join(root, 'scripts', 'always-on-reboot-smoke.mjs'),
  platform: 'darwin',
  uid: 501,
  home: path.resolve(process.env.MOCK_HOME || path.join(root, 'mock-home')),
  execPath: '/mock/node',
  stdinIsTTY: process.env.MOCK_TTY !== 'false',
  stdoutIsTTY: process.env.MOCK_TTY !== 'false',
  now: () => {
    const value = new Date(nowMs);
    nowMs += 10;
    return value;
  },
  uuid: () => randomUUID(),
  sleep: async () => {},
  run: mockedRun,
  stdout: (message) => console.log(message),
};

execute(process.argv.slice(2), runtime)
  .then((result) => {
    process.exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : 0;
  })
  .catch((error) => {
    console.error(`[mock-reboot-smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
