import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// The module executes main() on import, which calls connect() and hangs
// waiting for stdin. We mock StdioServerTransport to prevent that.
jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    close: jest.fn(),
    onmessage: null,
    onerror: null,
    onclose: null,
    send: jest.fn(),
  })),
}));

// Must require after mock setup
let server: McpServer;
let RORCHA_API: string;

beforeAll(() => {
  const mod = require('../server');
  server = mod.server;
  RORCHA_API = mod.RORCHA_API;
});

test('server is an instance of McpServer', () => {
  expect(server).toBeInstanceOf(McpServer);
});

test('server has underlying Server with name "rorcha" and version "1.0.0"', () => {
  // McpServer wraps a Server instance at server.server
  // The Server stores serverInfo privately but exposes it via the
  // initialize handshake. We verify the inner server exists.
  expect(server.server).toBeDefined();

  // Access the serverInfo via the internal property (set in constructor)
  const innerServer = server.server as unknown as Record<string, unknown>;
  const serverInfo = innerServer['_serverInfo'] as { name: string; version: string };
  expect(serverInfo.name).toBe('rorcha');
  expect(serverInfo.version).toBe('1.0.0');
});

test('RORCHA_API falls back to http://localhost:3030 when env not set', () => {
  expect(RORCHA_API).toBe('http://localhost:3030');
});
