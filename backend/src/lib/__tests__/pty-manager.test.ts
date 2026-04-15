import * as ptyManager from '../pty-manager';
import * as opencodeDetector from '../opencode-detector';
import * as db from '../../db';

const mockSockets: any[] = [];
const mockPtyFactory = () => ({
  onData: jest.fn(),
  onExit: jest.fn(),
  resize: jest.fn(),
  kill: jest.fn(),
  write: jest.fn(),
});

jest.mock('../opencode-detector');
jest.mock('../../db', () => ({
  execute: jest.fn().mockResolvedValue({ rowCount: 1 }),
  queryOne: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('ws', () => ({
  WebSocket: {
    OPEN: 1,
  },
}));
jest.mock('node-pty', () => ({
  spawn: jest.fn(() => mockPtyFactory()),
}));

describe('pty-manager', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
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

  it('creates a session and persists metadata', async () => {
    const sessionId = await ptyManager.createSession('ws-1', '/workspace', {}, 30, 120);

    expect(sessionId).toBeTruthy();
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO terminal_sessions'),
      expect.arrayContaining([sessionId, 'ws-1', '/workspace', 30, 120])
    );
  });

  it('shutdownAll flushes chunks, marks killed, notifies sockets, and kills PTYs', async () => {
    const sessionId = await ptyManager.createSession('ws-1', '/workspace', {}, 24, 80);
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

    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO terminal_output_chunks'),
      [sessionId, 1, 'hello']
    );
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE terminal_sessions'),
      [sessionId, 'killed', -1]
    );
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'exit', exitCode: -1 }));
    expect(socket.close).toHaveBeenCalled();
    expect(session.ptyProcess.kill).toHaveBeenCalled();
    expect(ptyManager.getSession(sessionId)).toBeUndefined();
  });
});
