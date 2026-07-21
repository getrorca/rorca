/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
/** Trusted CONNECT broker exposing only explicitly configured model API hosts. */
import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
let server = null;
let socketPath = null;
function configuredHosts(env) {
    const raw = String(env.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS ?? '').trim();
    if (!raw)
        throw new Error('RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS is required for isolated model execution');
    const hosts = raw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (hosts.length === 0 || hosts.length > 32)
        throw new Error('Autonomous model egress host list is invalid');
    for (const host of hosts) {
        if (host === 'localhost' || host === 'github.com' || host.endsWith('.github.com')
            || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com')
            || net.isIP(host) !== 0 || host.includes('*')
            || !/^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z0-9][a-z0-9-]{0,62}$/.test(host)) {
            throw new Error(`Autonomous model egress host is not an exact public DNS name: ${host}`);
        }
    }
    return new Set(hosts);
}
function isPublicAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 198 && (b === 18 || b === 19)));
    }
    if (net.isIPv6(address)) {
        const normalized = address.toLowerCase();
        if (normalized.startsWith('::ffff:'))
            return isPublicAddress(normalized.slice(7));
        return normalized !== '::' && normalized !== '::1'
            && !normalized.startsWith('fc') && !normalized.startsWith('fd')
            && !normalized.startsWith('fe8') && !normalized.startsWith('fe9')
            && !normalized.startsWith('fea') && !normalized.startsWith('feb')
            && !normalized.startsWith('ff');
    }
    return false;
}
function reject(socket, status = '403 Forbidden') {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}
async function connectAllowed(socket, header, allowed) {
    const firstLine = header.split('\r\n', 1)[0] ?? '';
    const match = /^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]$/i.exec(firstLine);
    if (!match)
        return reject(socket, '405 Method Not Allowed');
    const host = match[1].toLowerCase();
    const port = Number(match[2]);
    if (port !== 443 || !allowed.has(host))
        return reject(socket);
    const resolved = await dns.lookup(host, { all: true, verbatim: true });
    const selected = resolved.find(candidate => isPublicAddress(candidate.address));
    if (!selected || resolved.some(candidate => !isPublicAddress(candidate.address)))
        return reject(socket);
    const upstream = net.connect({ host: selected.address, port, family: selected.family });
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.pipe(upstream);
        upstream.pipe(socket);
    });
    upstream.once('error', () => reject(socket, '502 Bad Gateway'));
    socket.once('error', () => upstream.destroy());
}
function handle(socket, allowed) {
    socket.setTimeout(15_000, () => socket.destroy());
    let bytes = 0;
    let header = '';
    const onData = (chunk) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024)
            return reject(socket, '431 Request Header Fields Too Large');
        header += chunk.toString('latin1');
        const end = header.indexOf('\r\n\r\n');
        if (end < 0)
            return;
        socket.off('data', onData);
        const remainder = Buffer.from(header.slice(end + 4), 'latin1');
        void connectAllowed(socket, header.slice(0, end), allowed).then(() => {
            if (remainder.length > 0 && !socket.destroyed)
                socket.unshift(remainder);
        }).catch(() => reject(socket, '502 Bad Gateway'));
    };
    socket.on('data', onData);
}
/** Start one engine-owned, Unix-socket CONNECT broker. It is not an orchestrator. */
export async function ensureAutonomousModelEgress(env = process.env) {
    if (env.RORCA_AUTONOMOUS_ISOLATION !== 'linux-bwrap')
        return null;
    if (server && socketPath)
        return socketPath;
    const inherited = String(env.RORCA_AUTONOMOUS_EGRESS_SOCKET ?? '').trim();
    if (inherited) {
        const stat = fs.statSync(inherited);
        if (!stat.isSocket())
            throw new Error('Inherited autonomous model egress endpoint is not a Unix socket');
        return inherited;
    }
    const allowed = configuredHosts(env);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-model-egress-'));
    const candidate = path.join(dir, 'proxy.sock');
    server = net.createServer(client => handle(client, allowed));
    await new Promise((resolve, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(candidate, () => {
            server.off('error', rejectPromise);
            resolve();
        });
    });
    fs.chmodSync(candidate, 0o600);
    server.unref();
    socketPath = candidate;
    env.RORCA_AUTONOMOUS_EGRESS_SOCKET = candidate;
    const cleanup = () => {
        try {
            server?.close();
        }
        catch { /* exiting */ }
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        catch { /* exiting */ }
    };
    process.once('exit', cleanup);
    return candidate;
}
export async function closeAutonomousModelEgressForTests() {
    const current = server;
    const currentPath = socketPath;
    server = null;
    socketPath = null;
    delete process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET;
    if (current)
        await new Promise(resolve => current.close(() => resolve()));
    if (currentPath)
        fs.rmSync(path.dirname(currentPath), { recursive: true, force: true });
}
