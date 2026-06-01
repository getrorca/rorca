/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execSync } from 'child_process';

jest.mock('child_process');

const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;

const mockLoggerError = jest.fn();
const mockLoggerInfo = jest.fn();
jest.mock('../logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args), info: (...args: unknown[]) => mockLoggerInfo(...args), warn: jest.fn(), debug: jest.fn() },
}));

// Import semverGte directly — it's a pure function, no module state issues
import { semverGte } from '../opencode-detector';

describe('opencode-detector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENCODE_BIN;
  });

  describe('semverGte', () => {
    it('returns true for equal versions', () => {
      expect(semverGte('0.1.0', '0.1.0')).toBe(true);
    });

    it('returns true for greater major', () => {
      expect(semverGte('1.0.0', '0.9.9')).toBe(true);
    });

    it('returns true for greater minor', () => {
      expect(semverGte('0.2.0', '0.1.9')).toBe(true);
    });

    it('returns true for greater patch', () => {
      expect(semverGte('0.1.1', '0.1.0')).toBe(true);
    });

    it('returns false for lesser version', () => {
      expect(semverGte('0.0.9', '0.1.0')).toBe(false);
    });

    it('strips prerelease for comparison', () => {
      expect(semverGte('0.1.0-beta.1', '0.1.0')).toBe(true);
    });
  });

  describe('detectOpenCode', () => {
    // Use direct import since detectOpenCode uses the mocked child_process
    const { detectOpenCode } = require('../opencode-detector');

    it('returns installed=false when binary not found', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = detectOpenCode();

      expect(result.opencodeInstalled).toBe(false);
      expect(result.opencodeVersion).toBeNull();
      expect(result.opencodeBinPath).toBeNull();
    });

    it('resolves binary via which and parses version', () => {
      mockedExecSync
        .mockReturnValueOnce('/usr/local/bin/opencode\n' as any)  // which opencode
        .mockReturnValueOnce('opencode v0.2.0\n' as any);          // opencode --version

      const result = detectOpenCode();

      expect(result.opencodeInstalled).toBe(true);
      expect(result.opencodeVersion).toBe('0.2.0');
      expect(result.opencodeBinPath).toBe('/usr/local/bin/opencode');
    });

    it('uses OPENCODE_BIN env var when set', () => {
      process.env.OPENCODE_BIN = '/custom/path/opencode';
      mockedExecSync.mockReturnValueOnce('0.1.0\n' as any); // --version

      const result = detectOpenCode();

      expect(result.opencodeBinPath).toBe('/custom/path/opencode');
      expect(result.opencodeVersion).toBe('0.1.0');
      // which should NOT have been called
      expect(mockedExecSync).not.toHaveBeenCalledWith(
        'which opencode',
        expect.anything()
      );
    });

    it('handles --version failure gracefully', () => {
      mockedExecSync
        .mockReturnValueOnce('/usr/local/bin/opencode\n' as any)  // which
        .mockImplementationOnce(() => { throw new Error('segfault'); }); // --version

      const result = detectOpenCode();

      expect(result.opencodeInstalled).toBe(true);
      expect(result.opencodeVersion).toBeNull();
      expect(result.opencodeBinPath).toBe('/usr/local/bin/opencode');
    });

    it('parses version with prerelease suffix', () => {
      mockedExecSync
        .mockReturnValueOnce('/usr/local/bin/opencode\n' as any)
        .mockReturnValueOnce('opencode 1.0.0-beta.3\n' as any);

      const result = detectOpenCode();

      expect(result.opencodeVersion).toBe('1.0.0-beta.3');
    });
  });

  describe('requireOpenCode', () => {
    const { requireOpenCode, MIN_OPENCODE_VERSION } = require('../opencode-detector');
    let mockExit: jest.SpyInstance;

    beforeEach(() => {
      mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      mockLoggerError.mockClear();
      mockLoggerInfo.mockClear();
    });

    afterEach(() => {
      mockExit.mockRestore();
    });

    it('exits with code 1 when opencode not installed', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      requireOpenCode();

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('OpenCode not installed. Run: npm i -g opencode')
      );
    });

    it('exits with code 1 when version is below minimum', () => {
      mockedExecSync
        .mockReturnValueOnce('/usr/local/bin/opencode\n' as any)
        .mockReturnValueOnce('opencode v0.0.1\n' as any);

      requireOpenCode();

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining(`below minimum required ${MIN_OPENCODE_VERSION}`)
      );
    });

    it('logs success when opencode is found and version is sufficient', () => {
      mockedExecSync
        .mockReturnValueOnce('/usr/local/bin/opencode\n' as any)
        .mockReturnValueOnce('opencode v0.1.0\n' as any);

      const result = requireOpenCode();

      expect(mockExit).not.toHaveBeenCalled();
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining('Detected opencode 0.1.0')
      );
      expect(result.opencodeInstalled).toBe(true);
    });

    it('does not exit when version is unknown (binary exists but version parse fails)', () => {
      mockedExecSync
        .mockReturnValueOnce('/usr/local/bin/opencode\n' as any)
        .mockImplementationOnce(() => { throw new Error('no output'); });

      const result = requireOpenCode();

      expect(mockExit).not.toHaveBeenCalled();
      expect(result.opencodeInstalled).toBe(true);
      expect(result.opencodeVersion).toBeNull();
    });
  });
});
