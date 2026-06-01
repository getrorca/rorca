/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockSpawn = jest.fn();
const mockQuestion = jest.fn();
const mockClose = jest.fn();

jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock('readline/promises', () => ({
  createInterface: () => ({
    question: (...args: unknown[]) => mockQuestion(...args),
    close: (...args: unknown[]) => mockClose(...args),
  }),
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
      .mockReturnValueOnce(createChildProcess(0));
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
