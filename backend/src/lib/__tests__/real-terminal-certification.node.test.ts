/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runRealTerminalCertificationCapture,
  type ProviderCaptureGrant,
  type RealTerminalCaptureDependencies,
} from '../real-terminal-certification';
import { RELEASE_TERMINAL_RUNTIME } from '../terminal-runtime-contract';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeSource(root: string): string {
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.email', 'rb02@example.test');
  git(source, 'config', 'user.name', 'RB-02 Fixture');
  fs.writeFileSync(path.join(source, 'README.md'), 'fixture\n');
  git(source, 'add', 'README.md');
  git(source, 'commit', '-m', 'fixture');
  return source;
}

function writePrivate(file: string, content: Buffer | string): void {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function grantFor(root: string, credentialBytes: Buffer, source: string): ProviderCaptureGrant {
  const pi = path.join(root, 'pi');
  const opencode = path.join(root, 'opencode');
  writePrivate(pi, '#!/bin/sh\n');
  writePrivate(opencode, '#!/bin/sh\n');
  fs.chmodSync(pi, 0o700);
  fs.chmodSync(opencode, 0o700);
  const fixtureIdentity = {
    platform: 'linux' as const,
    architecture: 'arm64',
    kernel: '7.0.12-test',
    resourceNonceSha256: sha256('fixture-resource'),
    sourceArchiveSha256: sha256('fixture-archive'),
    sourceArchiveCommit: git(source, 'rev-parse', 'HEAD'),
    sourceArchiveTree: git(source, 'rev-parse', 'HEAD^{tree}'),
  };
  return {
    schemaVersion: 'rorca.provider-capture-grant.v1',
    purpose: 'rb02-real-terminal-certification',
    grantId: 'rb02-test-grant-0001',
    issuedAt: '2026-07-25T00:00:00.000Z',
    expiresAt: '2026-07-25T01:00:00.000Z',
    maxCostUsd: 1,
    fixture: {
      identity: fixtureIdentity,
      identitySha256: sha256(JSON.stringify(Object.fromEntries(Object.entries(fixtureIdentity).sort()))),
    },
    credentialFileSha256: sha256(credentialBytes),
    allowedHosts: ['api.openai.com'],
    runtime: {
      isolation: 'linux-bwrap',
      bwrapPath: '/usr/bin/bwrap',
      toolRoots: ['/usr', '/bin'],
    },
    engines: {
      pi: {
        executable: pi,
        version: RELEASE_TERMINAL_RUNTIME.pi.version,
        provider: 'openai',
        model: 'gpt-5.4',
        credentialEnv: 'OPENAI_API_KEY',
        expectedMarker: 'RORCA_RB02_PI_CAPTURE_OK_0001',
        timeoutMs: 10_000,
      },
      opencode: {
        executable: opencode,
        version: RELEASE_TERMINAL_RUNTIME.opencode.version,
        provider: 'openai',
        model: 'gpt-4o',
        credentialEnv: 'OPENAI_API_KEY',
        expectedMarker: 'RORCA_RB02_OPENCODE_CAPTURE_OK_0001',
        timeoutMs: 10_000,
      },
    },
  };
}

async function fakeDependencies(
  root: string,
  options: { versionOverride?: string; emptyTranscript?: boolean } = {},
): Promise<{ dependencies: Partial<RealTerminalCaptureDependencies>; calls: Array<Record<string, unknown>> }> {
  const calls: Array<Record<string, unknown>> = [];
  const socket = path.join(root, 'broker.sock');
  let server: net.Server | null = null;
  const ensureSocket = async (): Promise<void> => {
    if (server) return;
    server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socket, resolve);
    });
    fs.chmodSync(socket, 0o600);
    process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET = socket;
  };

  return {
    calls,
    dependencies: {
      now: () => new Date('2026-07-25T00:30:00.000Z'),
      platformIdentity: () => ({ platform: 'linux', architecture: 'arm64', kernel: '7.0.12-test' }),
      probeVersion: executable => {
        const engine = path.basename(executable) === 'pi' ? 'pi' : 'opencode';
        return options.versionOverride ?? RELEASE_TERMINAL_RUNTIME[engine].version;
      },
      prepareLaunch: async input => {
        await ensureSocket();
        calls.push({ type: 'prepare', ...input, credential: input.env.OPENAI_API_KEY ? 'present' : 'missing' });
        return {
          command: '/usr/bin/bwrap',
          args: [
            '--ro-bind', socket, '/run/rorca-egress/proxy.sock',
            '--setenv', 'HTTPS_PROXY', 'http://127.0.0.1:3128',
            '--', input.command, ...input.args,
          ],
          cwd: input.cwd,
          env: { TERM: 'xterm-256color' },
          isolated: true,
        };
      },
      spawnPty: (_command, args, ptyOptions) => {
        const marker = args.find(value => value.includes('RORCA_RB02_'))?.match(/RORCA_RB02_[A-Z0-9_]+/)?.[0] ?? '';
        const engine = marker.includes('OPENCODE') ? 'opencode' : 'pi';
        calls.push({ type: 'spawn', engine, ptyOptions, args });
        let dataHandler: ((data: string) => void) | null = null;
        let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | null = null;
        setImmediate(() => {
          if (!options.emptyTranscript) {
            const event = engine === 'pi'
              ? { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: marker }] } }
              : { type: 'assistant', content: marker };
            dataHandler?.(`${JSON.stringify(event)}\r\n`);
          }
          exitHandler?.({ exitCode: 0 });
        });
        return {
          onData(callback) { dataHandler = callback; },
          onExit(callback) { exitHandler = callback; },
          kill() {},
        };
      },
      closeBroker: async () => {
        const current = server;
        server = null;
        if (current) await new Promise<void>(resolve => current.close(() => resolve()));
        fs.rmSync(socket, { force: true });
        delete process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET;
      },
    },
  };
}

async function withFixture(
  run: (fixture: {
    root: string;
    source: string;
    output: string;
    grantFile: string;
    credentialFile: string;
    grant: ProviderCaptureGrant;
  }) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-real-terminal-cert-'));
  const originalSocket = process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET;
  delete process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET;
  try {
    const source = makeSource(root);
    const credentialBytes = Buffer.from('OPENAI_API_KEY=scoped-test-secret-value\n');
    const credentialFile = path.join(root, 'provider.env');
    writePrivate(credentialFile, credentialBytes);
    const grant = grantFor(root, credentialBytes, source);
    const grantFile = path.join(root, 'grant.json');
    writePrivate(grantFile, `${JSON.stringify(grant, null, 2)}\n`);
    await run({ root, source, output: path.join(root, 'output'), grantFile, credentialFile, grant });
  } finally {
    if (originalSocket === undefined) delete process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET;
    else process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET = originalSocket;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('captures Pi and OpenCode sequentially at exact versions and fixed geometry through the broker', async () => {
  await withFixture(async fixture => {
    const fake = await fakeDependencies(fixture.root);
    const artifact = await runRealTerminalCertificationCapture({
      sourceRoot: fixture.source,
      outputDir: fixture.output,
      grantFile: fixture.grantFile,
      credentialFile: fixture.credentialFile,
    }, fake.dependencies);

    assert.equal(artifact.status, 'passed');
    assert.equal(artifact.actual, true);
    assert.equal(artifact.skipped, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.output, 'terminal-captures.json'), 'utf8'));
    for (const engine of ['pi', 'opencode']) {
      assert.equal(manifest.captures[engine].status, 'passed');
      assert.equal(manifest.captures[engine].actual, true);
      assert.equal(manifest.captures[engine].skipped, 0);
      assert.deepEqual(manifest.captures[engine].terminal, { cols: 80, rows: 24 });
      assert.equal(manifest.captures[engine].engineWorkspaceRemoved, true);
      for (const key of ['rawTranscript', 'normalizedTranscript']) {
        const evidence = manifest.captures[engine][key];
        const bytes = fs.readFileSync(path.join(fixture.output, evidence.path));
        assert.equal(bytes.length, evidence.bytes);
        assert.equal(sha256(bytes), evidence.sha256);
        assert.doesNotMatch(bytes.toString('utf8'), /scoped-test-secret-value/);
      }
    }
    assert.match(manifest.networkPolicy.brokerInstanceSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.captures.pi.brokerInstanceSha256, manifest.networkPolicy.brokerInstanceSha256);
    assert.equal(manifest.captures.opencode.brokerInstanceSha256, manifest.networkPolicy.brokerInstanceSha256);
    const prepareCalls = fake.calls.filter(call => call.type === 'prepare');
    assert.equal(prepareCalls.length, 2);
    for (const call of prepareCalls) {
      const env = call.env as Record<string, string>;
      assert.equal(env.PI_OFFLINE, '1');
      assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, 'true');
      assert.equal(env.OPENCODE_DISABLE_DEFAULT_PLUGINS, 'true');
    }
    const spawnCalls = fake.calls.filter(call => call.type === 'spawn');
    assert.equal(spawnCalls.length, 2);
    for (const call of spawnCalls) {
      assert.equal((call.ptyOptions as { cols: number }).cols, 80);
      assert.equal((call.ptyOptions as { rows: number }).rows, 24);
    }
    assert.equal(fs.existsSync(path.join(fixture.output, 'capture-workspaces')), false);
    assert.equal(manifest.teardown.status, 'passed');
  });
});

test('rejects a grant that does not bind the executing Linux fixture', async () => {
  await withFixture(async fixture => {
    const fake = await fakeDependencies(fixture.root);
    fake.dependencies.platformIdentity = () => ({ platform: 'darwin', architecture: 'arm64', kernel: 'unsupported' });
    await assert.rejects(runRealTerminalCertificationCapture({
      sourceRoot: fixture.source,
      outputDir: fixture.output,
      grantFile: fixture.grantFile,
      credentialFile: fixture.credentialFile,
    }, fake.dependencies), /does not bind the executing Linux platform/);
    assert.equal(fs.existsSync(fixture.output), false);
  });
});

test('rejects an ambient/inherited broker instead of reusing ordinary authority', async () => {
  await withFixture(async fixture => {
    const fake = await fakeDependencies(fixture.root);
    process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET = path.join(fixture.root, 'ambient.sock');
    await assert.rejects(runRealTerminalCertificationCapture({
      sourceRoot: fixture.source,
      outputDir: fixture.output,
      grantFile: fixture.grantFile,
      credentialFile: fixture.credentialFile,
    }, fake.dependencies), /refuses an ambient\/inherited egress socket/);
    assert.equal(fake.calls.some(call => call.type === 'spawn'), false);
  });
});

test('fails before capture when an executable is missing', async () => {
  await withFixture(async fixture => {
    fixture.grant.engines.pi.executable = path.join(fixture.root, 'missing-pi');
    writePrivate(fixture.grantFile, `${JSON.stringify(fixture.grant, null, 2)}\n`);
    const fake = await fakeDependencies(fixture.root);
    await assert.rejects(runRealTerminalCertificationCapture({
      sourceRoot: fixture.source,
      outputDir: fixture.output,
      grantFile: fixture.grantFile,
      credentialFile: fixture.credentialFile,
    }, fake.dependencies), /pi executable is missing/);
    assert.equal(fake.calls.some(call => call.type === 'spawn'), false);
  });
});

test('fails before capture on executable version mismatch', async () => {
  await withFixture(async fixture => {
    const fake = await fakeDependencies(fixture.root, { versionOverride: '0.0.0' });
    await assert.rejects(runRealTerminalCertificationCapture({
      sourceRoot: fixture.source,
      outputDir: fixture.output,
      grantFile: fixture.grantFile,
      credentialFile: fixture.credentialFile,
    }, fake.dependencies), /pi version mismatch/);
    assert.equal(fake.calls.some(call => call.type === 'spawn'), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.output, 'capture-failure.json'), 'utf8')).status, 'failed');
  });
});

test('fails closed when a raw provider transcript is missing', async () => {
  await withFixture(async fixture => {
    const fake = await fakeDependencies(fixture.root, { emptyTranscript: true });
    await assert.rejects(runRealTerminalCertificationCapture({
      sourceRoot: fixture.source,
      outputDir: fixture.output,
      grantFile: fixture.grantFile,
      credentialFile: fixture.credentialFile,
    }, fake.dependencies), /pi raw transcript is missing/);
    assert.equal(fs.existsSync(path.join(fixture.output, 'terminal-captures.json')), false);
  });
});

test('rejects missing model/provider authority and expired grants without a skip path', async () => {
  await withFixture(async fixture => {
    fixture.grant.engines.pi.model = '';
    fixture.grant.expiresAt = '2026-07-25T00:10:00.000Z';
    writePrivate(fixture.grantFile, `${JSON.stringify(fixture.grant, null, 2)}\n`);
    const fake = await fakeDependencies(fixture.root);
    await assert.rejects(runRealTerminalCertificationCapture({
      sourceRoot: fixture.source,
      outputDir: fixture.output,
      grantFile: fixture.grantFile,
      credentialFile: fixture.credentialFile,
    }, fake.dependencies), /not currently valid|model authority/);
    assert.equal(fs.existsSync(fixture.output), false);
  });
});
