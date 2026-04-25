import net from 'node:net';
import { spawn } from 'node:child_process';

const BACKEND_HOST = process.env.RORCA_DEV_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.PORT || process.env.RORCA_DEV_PORT || 3030);
const CHECK_PATH = '/api/health';

function run(command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function isPortOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function isRorcaBackendHealthy(host, port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://${host}:${port}${CHECK_PATH}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return false;
    const json = await res.json().catch(() => null);
    return Boolean(json && typeof json === 'object');
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const portOpen = await isPortOpen(BACKEND_HOST, BACKEND_PORT);

  if (!portOpen) {
    console.log(`[dev-smart] No backend detected on ${BACKEND_HOST}:${BACKEND_PORT}; starting full dev stack.`);
    run('npm', ['run', 'dev:full']);
    return;
  }

  const healthy = await isRorcaBackendHealthy(BACKEND_HOST, BACKEND_PORT);
  if (healthy) {
    console.log(`[dev-smart] Detected running Rorca backend on ${BACKEND_HOST}:${BACKEND_PORT}; starting frontend only.`);
    run('npm', ['run', 'dev:frontend-only']);
    return;
  }

  console.error(`[dev-smart] Port ${BACKEND_PORT} is already in use, but it does not look like a healthy Rorca backend.`);
  console.error('[dev-smart] Stop the conflicting process or set PORT/RORCA_DEV_PORT before retrying.');
  process.exit(1);
}

main().catch((err) => {
  console.error('[dev-smart] Failed to determine dev startup mode:', err);
  process.exit(1);
});
