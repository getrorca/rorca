/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { EventEmitter } from 'events';
import * as os from 'os';

// Mock modules before importing the module under test
jest.mock('child_process');
jest.mock('../opencode-detector');
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    openSync: jest.fn().mockReturnValue(99),
    closeSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(false),
    unlinkSync: jest.fn(),
  };
});

import { spawn } from 'child_process';
import * as fs from 'fs';
import { detectOpenCode } from '../opencode-detector';
import { OpenCodeServer } from '../opencode-server';

const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockedDetectOpenCode = detectOpenCode as jest.MockedFunction<typeof detectOpenCode>;
const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockedUnlinkSync = fs.unlinkSync as jest.MockedFunction<typeof fs.unlinkSync>;

/** Create a mock ChildProcess that emits events */
function createMockChild(): EventEmitter & { pid: number; unref: jest.Mock; kill: jest.Mock } {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: jest.Mock; kill: jest.Mock };
  child.pid = 12345;
  child.unref = jest.fn();
  child.kill = jest.fn();
  return child;
}

describe('OpenCodeServer', () => {
  let mockChild: ReturnType<typeof createMockChild>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockChild = createMockChild();
    mockedSpawn.mockReturnValue(mockChild as any);

    mockedDetectOpenCode.mockReturnValue({
      opencodeInstalled: true,
      opencodeVersion: '0.2.0',
      opencodeBinPath: '/usr/local/bin/opencode',
    });

    mockedExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('resolves binary via detectOpenCode by default', () => {
      const server = new OpenCodeServer();
      expect(mockedDetectOpenCode).toHaveBeenCalled();
      expect(server.getState()).toBe('stopped');
    });

    it('uses binPath option when provided', () => {
      const _server = new OpenCodeServer({ binPath: '/custom/opencode' });
      expect(mockedDetectOpenCode).not.toHaveBeenCalled();
    });

    it('throws when binary not found', () => {
      mockedDetectOpenCode.mockReturnValue({
        opencodeInstalled: false,
        opencodeVersion: null,
        opencodeBinPath: null,
      });

      expect(() => new OpenCodeServer()).toThrow('OpenCode binary not found');
    });

    it('starts in stopped state', () => {
      const server = new OpenCodeServer();
      expect(server.getState()).toBe('stopped');
      expect(server.getPid()).toBeNull();
      expect(server.getSocketPath()).toBeNull();
    });
  });

  describe('start()', () => {
    it('spawns opencode server with socket path', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      // Socket appears on first poll
      mockedExistsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('rorca-oc-')) return true;
        return false;
      });

      const startPromise = server.start();
      jest.advanceTimersByTime(200);
      await startPromise;

      expect(mockedSpawn).toHaveBeenCalledWith(
        '/usr/local/bin/opencode',
        ['server', '--socket', expect.stringContaining('rorca-oc-')],
        expect.objectContaining({
          detached: true,
          stdio: ['ignore', 99, 99],
        }),
      );
      expect(mockChild.unref).toHaveBeenCalled();
      expect(server.getState()).toBe('running');
      expect(server.getPid()).toBe(12345);
    });

    it('calls onPidReady callback with PID', async () => {
      const onPidReady = jest.fn();
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode', onPidReady });

      mockedExistsSync.mockReturnValue(true);

      const startPromise = server.start();
      jest.advanceTimersByTime(200);
      await startPromise;

      expect(onPidReady).toHaveBeenCalledWith(12345);
    });

    it('rejects when server exits prematurely', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      const startPromise = server.start();

      // Simulate premature exit
      mockChild.emit('exit', 1);

      await expect(startPromise).rejects.toThrow('exited prematurely with code 1');
      expect(server.getState()).toBe('error');
    });

    it('rejects when spawn error occurs', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      const startPromise = server.start();

      mockChild.emit('error', new Error('ENOENT'));

      await expect(startPromise).rejects.toThrow('failed to spawn: ENOENT');
      expect(server.getState()).toBe('error');
    });

    it('rejects on startup timeout (10s)', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      // Socket never appears
      mockedExistsSync.mockReturnValue(false);

      const startPromise = server.start();

      // Advance past the 10s timeout
      jest.advanceTimersByTime(11_000);

      await expect(startPromise).rejects.toThrow('failed to start within 10000ms');
      expect(server.getState()).toBe('error');
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('is idempotent when already running', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      mockedExistsSync.mockReturnValue(true);

      const startPromise = server.start();
      jest.advanceTimersByTime(200);
      await startPromise;

      // Second start should no-op
      await server.start();

      expect(mockedSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('attach()', () => {
    it('returns socket path when server is running', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      mockedExistsSync.mockReturnValue(true);

      const startPromise = server.start();
      jest.advanceTimersByTime(200);
      await startPromise;

      const socketPath = server.attach();
      expect(socketPath).toContain('rorca-oc-');
      expect(socketPath).toContain(os.tmpdir());
    });

    it('throws when server is not running', () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });
      expect(() => server.attach()).toThrow('not running');
    });
  });

  describe('isAlive()', () => {
    it('returns false when no process', () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });
      expect(server.isAlive()).toBe(false);
    });

    it('returns true when process is alive', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      mockedExistsSync.mockReturnValue(true);

      const startPromise = server.start();
      jest.advanceTimersByTime(200);
      await startPromise;

      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
      expect(server.isAlive()).toBe(true);
      killSpy.mockRestore();
    });

    it('returns false when process is dead', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      mockedExistsSync.mockReturnValue(true);

      const startPromise = server.start();
      jest.advanceTimersByTime(200);
      await startPromise;

      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
      expect(server.isAlive()).toBe(false);
      killSpy.mockRestore();
    });
  });

  describe('restart()', () => {
    it('attempts restart and succeeds', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      mockedExistsSync.mockReturnValue(true);

      // First start
      const startPromise = server.start();
      jest.advanceTimersByTime(200);
      await startPromise;

      // Simulate crash
      mockChild.emit('exit', 1);
      expect(server.getState()).toBe('stopped');

      // Create a new mock child for the restart
      const newChild = createMockChild();
      newChild.pid = 67890;
      mockedSpawn.mockReturnValue(newChild as any);

      const restartPromise = server.restart();
      jest.advanceTimersByTime(200);
      const result = await restartPromise;

      expect(result).toBe(true);
      expect(server.getState()).toBe('running');
      expect(server.getPid()).toBe(67890);
    });

    it('only allows one restart attempt', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      mockedExistsSync.mockReturnValue(true);

      const startPromise = server.start();
      jest.advanceTimersByTime(200);
      await startPromise;

      // First restart
      mockChild.emit('exit', 1);
      const newChild = createMockChild();
      mockedSpawn.mockReturnValue(newChild as any);

      const r1 = server.restart();
      jest.advanceTimersByTime(200);
      expect(await r1).toBe(true);

      // Second restart — should return false
      const r2 = await server.restart();
      expect(r2).toBe(false);
    });
  });

  describe('stop()', () => {
    it('sends SIGTERM and cleans up socket', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      mockedExistsSync.mockReturnValue(true);

      const startPromise = server.start();
      jest.advanceTimersByTime(200);
      await startPromise;

      // isAlive check in stop()
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);

      const stopPromise = server.stop();

      // Simulate process exiting after SIGTERM
      mockChild.emit('exit', 0);

      await stopPromise;

      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(server.getState()).toBe('stopped');
      expect(mockedUnlinkSync).toHaveBeenCalled();

      killSpy.mockRestore();
    });

    it('no-ops when already stopped', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });
      await server.stop();
      expect(server.getState()).toBe('stopped');
    });

    it('handles already-dead process', async () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });

      mockedExistsSync.mockReturnValue(true);

      const startPromise = server.start();
      jest.advanceTimersByTime(200);
      await startPromise;

      // Process already dead
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });

      await server.stop();
      expect(server.getState()).toBe('stopped');
      expect(mockedUnlinkSync).toHaveBeenCalled();

      killSpy.mockRestore();
    });
  });

  describe('getLogPath()', () => {
    it('returns path in os.tmpdir()', () => {
      const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });
      expect(server.getLogPath()).toContain(os.tmpdir());
      expect(server.getLogPath()).toContain('rorca-opencode-server-');
    });
  });
});
