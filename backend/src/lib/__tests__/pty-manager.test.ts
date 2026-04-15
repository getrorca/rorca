// ─── PTY Manager Tests ──────────────────────────────────────────────────────
// OCT-001: Verify PTY session lifecycle and error handling

import * as ptyManager from '../pty-manager';
import * as opencodeDetector from '../opencode-detector';

jest.mock('../opencode-detector');
jest.mock('node-pty', () => ({
  spawn: jest.fn(() => ({
    onData: jest.fn(),
    onExit: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
  })),
}));

describe('pty-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clean up all active sessions before each test
    const sessions = ptyManager.activeSessions();
    sessions.forEach((s) => ptyManager.killSession(s.sessionId));
  });

  describe('createSession', () => {
    it('should throw when opencode binary not found', async () => {
      (opencodeDetector.detectOpenCode as jest.Mock).mockReturnValue({
        opencodeInstalled: false,
        opencodeVersion: null,
        opencodeBinPath: null,
      });

      await expect(
        ptyManager.createSession('1', '/tmp', {}, 24, 80)
      ).rejects.toThrow('opencode binary not found');
    });

    it('should spawn opencode with correct PTY dimensions and cwd', async () => {
      const nodePty = require('node-pty');
      (opencodeDetector.detectOpenCode as jest.Mock).mockReturnValue({
        opencodeInstalled: true,
        opencodeVersion: '0.1.0',
        opencodeBinPath: '/usr/local/bin/opencode',
      });

      const sessionId = await ptyManager.createSession('1', '/workspace', {}, 30, 120);

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
    });
  });

  describe('resizeSession', () => {
    it('should call ptyProcess.resize without throwing', async () => {
      const nodePty = require('node-pty');
      const mockResize = jest.fn();
      nodePty.spawn.mockReturnValue({
        onData: jest.fn(),
        onExit: jest.fn(),
        resize: mockResize,
        kill: jest.fn(),
      });

      (opencodeDetector.detectOpenCode as jest.Mock).mockReturnValue({
        opencodeInstalled: true,
        opencodeVersion: '0.1.0',
        opencodeBinPath: '/usr/local/bin/opencode',
      });

      const sessionId = await ptyManager.createSession('1', '/tmp', {}, 24, 80);
      ptyManager.resizeSession(sessionId, 40, 100);

      expect(mockResize).toHaveBeenCalledWith(100, 40); // cols, rows
    });
  });

  describe('killSession', () => {
    it('should terminate process and remove session from map', async () => {
      const nodePty = require('node-pty');
      const mockKill = jest.fn();
      nodePty.spawn.mockReturnValue({
        onData: jest.fn(),
        onExit: jest.fn(),
        resize: jest.fn(),
        kill: mockKill,
      });

      (opencodeDetector.detectOpenCode as jest.Mock).mockReturnValue({
        opencodeInstalled: true,
        opencodeVersion: '0.1.0',
        opencodeBinPath: '/usr/local/bin/opencode',
      });

      const sessionId = await ptyManager.createSession('1', '/tmp', {}, 24, 80);
      expect(ptyManager.getSession(sessionId)).toBeDefined();

      ptyManager.killSession(sessionId);

      expect(mockKill).toHaveBeenCalled();
      expect(ptyManager.getSession(sessionId)).toBeUndefined();
    });
  });

  describe('activeSessions', () => {
    it('should return all active sessions', async () => {
      const nodePty = require('node-pty');
      nodePty.spawn.mockReturnValue({
        onData: jest.fn(),
        onExit: jest.fn(),
        resize: jest.fn(),
        kill: jest.fn(),
      });

      (opencodeDetector.detectOpenCode as jest.Mock).mockReturnValue({
        opencodeInstalled: true,
        opencodeVersion: '0.1.0',
        opencodeBinPath: '/usr/local/bin/opencode',
      });

      const sessionId1 = await ptyManager.createSession('1', '/tmp', {}, 24, 80);
      const sessionId2 = await ptyManager.createSession('2', '/tmp', {}, 24, 80);

      const active = ptyManager.activeSessions();
      expect(active).toHaveLength(2);
      expect(active.map((s) => s.sessionId)).toContain(sessionId1);
      expect(active.map((s) => s.sessionId)).toContain(sessionId2);
    });
  });
});

describe('pty-manager killSessionsForWorkspace helper', () => {
  it('kills only matching workspace sessions', async () => {
    const nodePty = require('node-pty');
    nodePty.spawn.mockReturnValue({
      onData: jest.fn(),
      onExit: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
    });

    (opencodeDetector.detectOpenCode as jest.Mock).mockReturnValue({
      opencodeInstalled: true,
      opencodeVersion: '0.1.0',
      opencodeBinPath: '/usr/local/bin/opencode',
    });

    const existing = ptyManager.activeSessions();
    existing.forEach((session) => ptyManager.killSession(session.sessionId));

    const sessionId1 = await ptyManager.createSession('ws-a', '/tmp', {}, 24, 80);
    const sessionId2 = await ptyManager.createSession('ws-b', '/tmp', {}, 24, 80);
    const sessionId3 = await ptyManager.createSession('ws-a', '/tmp', {}, 24, 80);

    expect(ptyManager.activeSessions()).toHaveLength(3);

    ptyManager.killSessionsForWorkspace('ws-a');

    const remaining = ptyManager.activeSessions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sessionId).toBe(sessionId2);
    expect(remaining.find((session) => session.sessionId === sessionId1)).toBeUndefined();
    expect(remaining.find((session) => session.sessionId === sessionId3)).toBeUndefined();
  });
});
