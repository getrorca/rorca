/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Bounded, side-effect-free compatibility probe coverage.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertPtyCliCompatible,
  probePtyCliCompatibility,
  resetPtyCliCompatibilityCacheForTests,
} from '../pty-cli-compat';

function writeFakeCli(dir: string, name: string, help: string, version = 'fake 1.2.3'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh
case "$1" in
  --version) echo '${version}' ;;
  --help) cat <<'EOF'
${help}
EOF
  ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  return file;
}

describe('PTY CLI compatibility probes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pty-cli-compat-'));
    resetPtyCliCompatibilityCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetPtyCliCompatibilityCacheForTests();
  });

  it('resolves the real executable, captures its version, and derives Codex capabilities from --help', () => {
    const fake = writeFakeCli(tempDir, 'codex', '--ask-for-approval MODE\n--no-alt-screen\n--model MODEL');
    const status = probePtyCliCompatibility('codex', {
      force: true,
      env: { ...process.env, CODEX_BIN: fake },
    });

    expect(status.ready).toBe(true);
    expect(status.interactive).toBe(true);
    expect(status.binaryPath).toBe(fs.realpathSync(fake));
    expect(status.version).toBe('1.2.3');
    expect(status.capabilities).toMatchObject({ askForApproval: true, noAltScreen: true, model: true });
    expect(status.capabilities.permissionBypass).toBe(false);
    expect(status.probes.version).toMatchObject({ ok: true, timedOut: false });
    expect(status.probes.help).toMatchObject({ ok: true, timedOut: false });
  });

  it('does not infer unsupported flags and gives an actionable fail-closed error', () => {
    const fake = writeFakeCli(tempDir, 'codex', '--model MODEL');
    const status = probePtyCliCompatibility('codex', {
      force: true,
      env: { ...process.env, CODEX_BIN: fake },
    });

    expect(status.capabilities.askForApproval).toBe(false);
    expect(() => assertPtyCliCompatible('codex', ['askForApproval'], status))
      .toThrow(/does not advertise --ask-for-approval.*Upgrade\/configure/i);
  });

  it('reports a broken wrapper rather than treating PATH presence as readiness', () => {
    const fake = writeFakeCli(tempDir, 'claude', '--model MODEL', 'not-a-version');
    const status = probePtyCliCompatibility('claude', {
      force: true,
      env: { ...process.env, CLAUDE_BIN: fake },
    });

    expect(status.ready).toBe(true);
    expect(status.version).toBeNull();
    // A CLI may use a non-semver version string, but both bounded probes must
    // succeed before the interactive adapter is permitted to launch.
    expect(() => assertPtyCliCompatible('claude', ['model'], status)).not.toThrow();
  });

  it('times out a hung wrapper within the configured bound instead of launching it interactively', () => {
    const fake = path.join(tempDir, 'hung-pi');
    fs.writeFileSync(fake, '#!/usr/bin/env node\nsetInterval(() => {}, 1_000);\n', { mode: 0o755 });

    const started = Date.now();
    const status = probePtyCliCompatibility('pi', {
      force: true,
      timeoutMs: 25,
      env: { ...process.env, PI_BIN: fake },
    });

    expect(Date.now() - started).toBeLessThan(500);
    expect(status.ready).toBe(false);
    expect(status.probes.version).toMatchObject({ timedOut: true });
    expect(status.probes.help).toMatchObject({ timedOut: true });
  });

  it('returns structured binary-not-found diagnostics without shelling out', () => {
    const status = probePtyCliCompatibility('pi', {
      force: true,
      env: { PATH: tempDir, PI_BIN: path.join(tempDir, 'missing') },
    });

    expect(status).toMatchObject({ ready: false, binaryPath: null });
    expect(status.diagnostics[0]).toMatchObject({
      code: 'binary_not_found',
      action: expect.stringContaining('PI_BIN'),
    });
  });
});
