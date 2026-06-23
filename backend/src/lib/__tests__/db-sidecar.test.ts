/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockSpawn = jest.fn();
const mockQuestion = jest.fn();
const mockClose = jest.fn();
const mockSetDbMode = jest.fn();

jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock('readline/promises', () => ({
  createInterface: () => ({
    question: (...args: unknown[]) => mockQuestion(...args),
    close: (...args: unknown[]) => mockClose(...args),
  }),
}));

jest.mock('../db-strategy', () => ({
  setDbMode: (...args: unknown[]) => mockSetDbMode(...args),
  describePgvectorFix: (mode: string) =>
    mode === 'docker'
      ? 'pgvector is not available in the Docker Postgres image. Rerun `rorca db start`.'
      : `pgvector is not available (${mode}).`,
}));

function createChildProcess(
  code: number | null,
  stdout: string = '',
  stderr: string = ''
): {
  stdout: { on: (event: string, cb: (chunk: Buffer) => void) => void };
  stderr: { on: (event: string, cb: (chunk: Buffer) => void) => void };
  on: (event: string, cb: (...args: unknown[]) => void) => void;
} {
  return {
    stdout: {
      on: (event, cb) => {
        if (event === 'data' && stdout) cb(Buffer.from(stdout));
      },
    },
    stderr: {
      on: (event, cb) => {
        if (event === 'data' && stderr) cb(Buffer.from(stderr));
      },
    },
    on: (event, cb) => {
      if (event === 'error') return;
      if (event === 'close') cb(code);
    },
  };
}

describe('db-sidecar', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockSetDbMode.mockReset();
  });

  it('dbStart throws DOCKER_UNAVAILABLE when docker info fails', async () => {
    mockSpawn.mockReturnValueOnce(createChildProcess(1, '', 'docker not running'));
    const { dbStart } = require('../db-sidecar');
    await expect(dbStart()).rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
  });

  it('dbStart is idempotent when the container is already running', async () => {
    mockSpawn
      .mockReturnValueOnce(createChildProcess(0))
      .mockReturnValueOnce(createChildProcess(0, 'true'))
      .mockReturnValueOnce(createChildProcess(0))
      .mockReturnValueOnce(createChildProcess(0))
      // vectorExtensionEnabled probe → '1'
      .mockReturnValueOnce(createChildProcess(0, '1'));
    const { dbStart } = require('../db-sidecar');
    await dbStart();
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['inspect', 'rorca-db', '--format', '{{.State.Running}}'],
      expect.any(Object)
    );
    expect(mockSpawn).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['run']),
      expect.any(Object)
    );
    expect(mockSpawn).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['start', 'rorca-db']),
      expect.any(Object)
    );
    expect(mockSetDbMode).toHaveBeenCalledWith('docker');
  });

  it('dbStart creates the AGE container, enables extensions, and persists docker mode (Miguel full-graph path)', async () => {
    mockSpawn
      // docker info (requireDocker)
      .mockReturnValueOnce(createChildProcess(0))
      // docker inspect → container does not exist
      .mockReturnValueOnce(createChildProcess(1))
      // docker run
      .mockReturnValueOnce(createChildProcess(0))
      // pg_isready (waitForReady)
      .mockReturnValueOnce(createChildProcess(0))
      // enableAgeExtension psql CREATE EXTENSION
      .mockReturnValueOnce(createChildProcess(0))
      // vectorExtensionEnabled probe → '1'
      .mockReturnValueOnce(createChildProcess(0, '1'));

    const { dbStart } = require('../db-sidecar');
    await dbStart();

    // Regression guard: the managed container is provisioned from the apache/age image
    // on the canonical 5432 port + named volume — Miguel's Full-Graph startup contract.
    const runCall = mockSpawn.mock.calls.find(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('run'),
    );
    expect(runCall).toBeDefined();
    const runArgs = runCall![1] as string[];
    expect(runArgs).toEqual(expect.arrayContaining(['--name', 'rorca-db']));
    expect(runArgs).toEqual(expect.arrayContaining(['-p', '5432:5432']));
    expect(runArgs).toEqual(expect.arrayContaining(['-v', 'rorca-db-data:/var/lib/postgresql/data']));
    expect(runArgs).toContain('apache/age:latest');

    // AGE + pgvector extensions are created so the graph comes up in Full mode.
    const psqlCall = mockSpawn.mock.calls.find(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('CREATE EXTENSION IF NOT EXISTS age; CREATE EXTENSION IF NOT EXISTS vector;'),
    );
    expect(psqlCall).toBeDefined();

    expect(mockSetDbMode).toHaveBeenCalledWith('docker');
  });

  it('dbStart starts an existing stopped container without recreating it', async () => {
    mockSpawn
      // docker info
      .mockReturnValueOnce(createChildProcess(0))
      // docker inspect → exists but stopped
      .mockReturnValueOnce(createChildProcess(0, 'false'))
      // docker start
      .mockReturnValueOnce(createChildProcess(0))
      // pg_isready
      .mockReturnValueOnce(createChildProcess(0))
      // enableAgeExtension
      .mockReturnValueOnce(createChildProcess(0))
      // vectorExtensionEnabled probe → '1'
      .mockReturnValueOnce(createChildProcess(0, '1'));

    const { dbStart } = require('../db-sidecar');
    await dbStart();

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['start', 'rorca-db']),
      expect.any(Object),
    );
    expect(mockSpawn).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['run']),
      expect.any(Object),
    );
    expect(mockSetDbMode).toHaveBeenCalledWith('docker');
  });

  it('dbStatus reports AGE- and pgvector-enabled when the container is running with both extensions', async () => {
    mockSpawn
      // docker inspect → running
      .mockReturnValueOnce(createChildProcess(0, 'true'))
      // psql AGE probe → '1'
      .mockReturnValueOnce(createChildProcess(0, '1'))
      // psql vector probe → '1'
      .mockReturnValueOnce(createChildProcess(0, '1'));

    const { dbStatus } = require('../db-sidecar');
    await expect(dbStatus()).resolves.toEqual({
      running: true,
      containerExists: true,
      ageEnabled: true,
      vectorEnabled: true,
    });
  });

  it('dbStart throws a pgvector fix path when the vector extension never bootstraps', async () => {
    mockSpawn
      // docker info (requireDocker)
      .mockReturnValueOnce(createChildProcess(0))
      // docker inspect → does not exist
      .mockReturnValueOnce(createChildProcess(1))
      // docker run
      .mockReturnValueOnce(createChildProcess(0))
      // pg_isready (waitForReady)
      .mockReturnValueOnce(createChildProcess(0))
      // enableAgeExtension psql CREATE EXTENSION
      .mockReturnValueOnce(createChildProcess(0))
      // vectorExtensionEnabled probe → empty (missing)
      .mockReturnValueOnce(createChildProcess(0, ''));

    const { dbStart } = require('../db-sidecar');
    await expect(dbStart()).rejects.toThrow(/pgvector is not available in the Docker Postgres image/i);
    // The Docker path must not be persisted when pgvector is missing.
    expect(mockSetDbMode).not.toHaveBeenCalled();
  });

  it('dbStatus never throws and returns false flags on docker errors', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('boom');
    });
    const { dbStatus } = require('../db-sidecar');
    await expect(dbStatus()).resolves.toEqual({
      running: false,
      containerExists: false,
      ageEnabled: false,
      vectorEnabled: false,
    });
  });

  it('dbReset exits early when confirmation is declined', async () => {
    mockQuestion.mockResolvedValue('n');
    const { dbReset } = require('../db-sidecar');
    await dbReset();
    expect(mockClose).toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
