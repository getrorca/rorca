import * as ptyManager from '../pty-manager';
import * as opencodeDetector from '../opencode-detector';
import * as db from '../../db';

const mockPtys: Array<Record<string, jest.Mock>> = [];

jest.mock('../opencode-detector');
jest.mock('../../db', () => ({
  execute: jest.fn().mockResolvedValue({ rowCount: 1 }),
  queryOne: jest.fn().mockResolvedValue(undefined),
  transaction: jest.fn(async (fn: (client: any) => Promise<any>) => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('RETURNING total_output_bytes')) {
          return { rows: [{ total_output_bytes: '0' }] };
        }
        return { rows: [] };
      }),
    };
    return fn(client);
  }),
}));

jest.mock('ws', () => ({
  WebSocket: {
    OPEN: 1,
  },
}));

jest.mock('node-pty', () => ({
  spawn: jest.fn(() => {
    const pty = {
      onData: jest.fn(),
      onExit: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      write: jest.fn(),
    };
    mockPtys.push(pty);
    return pty;
  }),
}));

describe('pty-manager', () => {
  const mockExecute = db.execute as jest.Mock;
  const mockTransaction = db.transaction as jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPtys.length = 0;
    for (const session of ptyManager.activeSessions()) {
      await ptyManager.shutdownAll();
      break;
    }
    (opencodeDetector.detectOpenCode as jest.Mock).mockReturnValue({
      opencodeInstalled: true,
      opencodeVersion: '0.1.0',
      opencodeBinPath: '/usr/local/bin/opencode',
    });
  });

  describe('createSession', () => {
    it('should throw when opencode binary not found', async () => {
      (opencodeDetector.detectOpenCode as jest.Mock).mockReturnValue({
        opencodeInstalled: false,
        opencodeVersion: null,
        opencodeBinPath: null,
      });

      await expect(
        ptyManager.createSession('', 'Workspace', '', {}, 24, 80)
      ).rejects.toThrow('opencode binary not found');
    });

    it('should spawn opencode with correct PTY dimensions and cwd', async () => {
      const nodePty = require('node-pty');
      const sessionId = await ptyManager.createSession('', 'Workspace', '', {}, 30, 120);

      expect(sessionId).toBeTruthy();
      expect(nodePty.spawn).toHaveBeenCalledWith(
        '/usr/local/bin/opencode',
        [],
        expect.objectContaining({
          name: 'xterm-256color',
          rows: 30,
          cols: 120,
          cwd: '/workspace',
        })
      );
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO terminal_sessions'),
        expect.arrayContaining([sessionId, '1', '/workspace', 30, 120])
      );
    });

    it('injects shell integration env var for bash/zsh sessions', async () => {
      const nodePty = require('node-pty');
      await ptyManager.createSession('', 'Workspace', '', { SHELL: '/bin/bash' }, 30, 120);

      expect(nodePty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            RORCA_SHELL_INTEGRATION: '1',
          }),
        })
      );
    });
  });

  describe('processSessionOutput', () => {
    it('strips OSC 133 sequences and emits command_end shell events', async () => {
      const sessionId = await ptyManager.createSession('', 'Workspace', '', { SHELL: '/bin/bash' }, 24, 80);

      let parsed = ptyManager.processSessionOutput(sessionId, 'echo hi\u001b]133;B\u0007hello');
      expect(parsed.cleanData).toBe('echo hihello');
      expect(parsed.shellEvents).toHaveLength(0);

      parsed = ptyManager.processSessionOutput(sessionId, '\u001b]133;D;0\u0007');
      expect(parsed.cleanData).toBe('');
      expect(parsed.shellEvents).toHaveLength(1);
      expect(parsed.shellEvents[0]).toMatchObject({ type: 'shell_event', event: 'command_end', exitCode: 0 });
    });

    it('buffers partial OSC 133 sequences across chunks', async () => {
      const sessionId = await ptyManager.createSession('', 'Workspace', '', { SHELL: '/bin/zsh' }, 24, 80);

      const first = ptyManager.processSessionOutput(sessionId, 'abc\u001b]133;D;');
      expect(first.cleanData).toBe('abc');
      expect(first.shellEvents).toHaveLength(0);

      const second = ptyManager.processSessionOutput(sessionId, '7\u0007');
      expect(second.cleanData).toBe('');
      expect(second.shellEvents).toHaveLength(1);
      expect(second.shellEvents[0]).toMatchObject({ exitCode: 7 });
    });
  });

  describe('flushSession', () => {
    it('should batch buffered chunks into one multi-row insert', async () => {
      const nodePty = require('node-pty');
      let onDataHandler: ((data: string) => void) | undefined;

      nodePty.spawn.mockReturnValue({
        onData: jest.fn((handler: (data: string) => void) => {
          onDataHandler = handler;
        }),
        onExit: jest.fn(),
        resize: jest.fn(),
        kill: jest.fn(),
        write: jest.fn(),
      });

      const mockClientQuery = jest.fn(async (sql: string) => {
        if (sql.includes('RETURNING total_output_bytes')) {
          return { rows: [{ total_output_bytes: '6' }] };
        }
        return { rows: [] };
      });
      mockTransaction.mockImplementation(async (fn: (client: any) => Promise<any>) => fn({ query: mockClientQuery }));

      const sessionId = await ptyManager.createSession( as any, 'Workspace', '', {}, 24, 80);
      onDataHandler?.('abc');
      onDataHandler?.('def');

      await ptyManager.flushSession(sessionId);

      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO terminal_output_chunks'),
        [sessionId, 1, 'abc', sessionId, 2, 'def']
      );
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE terminal_sessions'),
        [sessionId, 6]
      );
    });

    it('should disable DB writes and insert sentinel after crossing 100MB', async () => {
      const nodePty = require('node-pty');
      let onDataHandler: ((data: string) => void) | undefined;

      nodePty.spawn.mockReturnValue({
        onData: jest.fn((handler: (data: string) => void) => {
          onDataHandler = handler;
        }),
        onExit: jest.fn(),
        resize: jest.fn(),
        kill: jest.fn(),
        write: jest.fn(),
      });

      const mockClientQuery = jest.fn(async (sql: string) => {
        if (sql.includes('RETURNING total_output_bytes')) {
          return { rows: [{ total_output_bytes: String(100 * 1024 * 1024 + 1) }] };
        }
        return { rows: [] };
      });
      mockTransaction.mockImplementation(async (fn: (client: any) => Promise<any>) => fn({ query: mockClientQuery }));

      const sessionId = await ptyManager.createSession( as any, 'Workspace', '', {}, 24, 80);
      onDataHandler?.('x');

      await ptyManager.flushSession(sessionId);

      const session = ptyManager.getSession(sessionId);
      expect(session?.dbWriteDisabled).toBe(true);
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('VALUES ($1, $2, $3)'),
        [sessionId, 2, '\r\n[Output limit reached — streaming continues but history is truncated]\r\n']
      );
    });
  });

  describe('session limits', () => {
    it('should enforce the maximum session limit', async () => {
      const existingSessions = ptyManager.activeSessions();
      for (let i = existingSessions.length; i < 20; i += 1) {
        await ptyManager.createSession(i + 1, '/workspace', {}, 24, 80);
      }

      await expect(ptyManager.createSession(, 'Workspace', '', {}, 24, 80)).rejects.toMatchObject({
        statusCode: 429,
        message: 'Maximum terminal sessions reached',
      });
    });
  });

  describe('resizeSession', () => {
    it('should call pty resize with correct arguments', async () => {
      const sessionId = await ptyManager.createSession('', 'Workspace', '', {}, 24, 80);
      const session = ptyManager.getSession(sessionId);
      const mockResize = session?.ptyProcess.resize as jest.Mock;

      ptyManager.resizeSession(sessionId, 40, 100);

      expect(mockResize).toHaveBeenCalledWith(100, 40);
    });
  });

  describe('killSession', () => {
    it('should kill PTY and remove session', async () => {
      const sessionId = await ptyManager.createSession('', 'Workspace', '', {}, 24, 80);
      const session = ptyManager.getSession(sessionId);
      const mockKill = session?.ptyProcess.kill as jest.Mock;

      expect(ptyManager.getSession(sessionId)).toBeDefined();

      ptyManager.killSession(sessionId);

      expect(mockKill).toHaveBeenCalled();
      expect(ptyManager.getSession(sessionId)).toBeUndefined();
    });
  });

  describe('activeSessions', () => {
    it('should return all active sessions', async () => {
      const sessionId1 = await ptyManager.createSession('', 'Workspace', '', {}, 24, 80);
      const sessionId2 = await ptyManager.createSession('', 'Workspace', '', {}, 24, 80);

      const active = ptyManager.activeSessions();
      expect(active).toHaveLength(2);
      expect(active.map((s) => s.sessionId)).toContain(sessionId1);
      expect(active.map((s) => s.sessionId)).toContain(sessionId2);
    });
  });

  describe('shutdownAll', () => {
    it('flushes chunks, marks killed, notifies sockets, and kills PTYs', async () => {
      const sessionId = await ptyManager.createSession('', 'Workspace', '', {}, 24, 80);
      const session = ptyManager.getSession(sessionId)!;

      const dataHandler = (session.ptyProcess.onData as jest.Mock).mock.calls[0][0];
      dataHandler('hello');

      const socket = {
        readyState: 1,
        send: jest.fn(),
        close: jest.fn(),
      };
      ptyManager.attachSocket(sessionId, socket as any);

      await ptyManager.shutdownAll();

      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE terminal_sessions'),
        [sessionId, 'killed', -1]
      );
      expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'exit', exitCode: -1 }));
      expect(socket.close).toHaveBeenCalled();
      expect(session.ptyProcess.kill).toHaveBeenCalled();
      expect(ptyManager.getSession(sessionId)).toBeUndefined();
    });
  });

  describe('input size cap', () => {
    it('should reject websocket payloads larger than 1MB', () => {
      const overLimit = Buffer.alloc(1_048_577, 'a');
      const withinLimit = Buffer.alloc(1_048_576, 'a');

      expect(ptyManager.isInputTooLarge(overLimit)).toBe(true);
      expect(ptyManager.isInputTooLarge(withinLimit)).toBe(false);
    });
  });
});

describe('pty-manager killSessionsForWorkspace helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (opencodeDetector.detectOpenCode as jest.Mock).mockReturnValue({
      opencodeInstalled: true,
      opencodeVersion: '0.1.0',
      opencodeBinPath: '/usr/local/bin/opencode',
    });
    const existing = ptyManager.activeSessions();
    existing.forEach((session) => ptyManager.killSession(session.sessionId));
  });

  it('kills only matching workspace sessions', async () => {
    const sessionId1 = await ptyManager.createSession('', 'Workspace', '', {}, 24, 80);
    const sessionId2 = await ptyManager.createSession('', 'Workspace', '', {}, 24, 80);
    const sessionId3 = await ptyManager.createSession('', 'Workspace', '', {}, 24, 80);

    expect(ptyManager.activeSessions()).toHaveLength(3);

    ptyManager.killSessionsForWorkspace('ws-a');

    const remaining = ptyManager.activeSessions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sessionId).toBe(sessionId2);
    expect(remaining.find((session) => session.sessionId === sessionId1)).toBeUndefined();
    expect(remaining.find((session) => session.sessionId === sessionId3)).toBeUndefined();
  });
});
