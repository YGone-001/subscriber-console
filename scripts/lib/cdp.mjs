/*
 * Minimal Chrome DevTools Protocol client.
 *
 * The capture scripts must run on the repository's declared engine floor
 * (Node >= 20.19). `globalThis.WebSocket` only became available unflagged in
 * Node 22.4, so this module prefers the platform implementation and otherwise
 * falls back to a self-contained RFC 6455 client built on `node:net`.
 *
 * Only the subset CDP needs is implemented: text frames, fragmentation,
 * ping/pong, and close. No extensions, no permessage-deflate.
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

function encodeClientFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const length = data.length;
  const mask = crypto.randomBytes(4);

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x80 | opcode;
  mask.copy(header, header.length - 4);

  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = data[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, masked]);
}

/** Decode as many complete frames as the buffer holds. */
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = buffer.readUInt32BE(cursor + 4);
      cursor += 8;
    }

    let maskKey = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      maskKey = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + length > buffer.length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= maskKey[index % 4];
      }
    }
    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function socketWebSocket(url) {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'wss:';
  const port = Number(parsed.port || (secure ? 443 : 80));
  const key = crypto.randomBytes(16).toString('base64');

  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname })
      : net.connect({ host: parsed.hostname, port });

    let handshakeDone = false;
    let pending = Buffer.alloc(0);
    let fragmentOpcode = null;
    let fragments = [];
    const listeners = { message: [], close: [] };

    const fail = (error) => {
      if (!handshakeDone) reject(error);
      else listeners.close.forEach((fn) => fn(error));
    };

    socket.on('error', fail);
    socket.on('close', () => listeners.close.forEach((fn) => fn(new Error('socket closed'))));

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      if (!handshakeDone) {
        const terminator = pending.indexOf('\r\n\r\n');
        if (terminator === -1) return;
        const head = pending.subarray(0, terminator).toString('utf8');
        pending = pending.subarray(terminator + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) {
          fail(new Error(`websocket handshake rejected: ${head.split('\r\n')[0]}`));
          socket.destroy();
          return;
        }
        handshakeDone = true;
        resolve(api);
      }

      const { frames, rest } = decodeFrames(pending);
      pending = rest;
      for (const frame of frames) {
        if (frame.opcode === OPCODE_PING) {
          socket.write(encodeClientFrame(OPCODE_PONG, frame.payload));
          continue;
        }
        if (frame.opcode === OPCODE_PONG) continue;
        if (frame.opcode === OPCODE_CLOSE) {
          listeners.close.forEach((fn) => fn(new Error('closed by peer')));
          socket.end();
          continue;
        }
        if (frame.opcode === OPCODE_CONTINUATION) {
          fragments.push(frame.payload);
        } else {
          fragmentOpcode = frame.opcode;
          fragments = [frame.payload];
        }
        if (frame.fin) {
          const payload = Buffer.concat(fragments);
          fragments = [];
          const text = fragmentOpcode === OPCODE_BINARY
            ? payload.toString('base64')
            : payload.toString('utf8');
          listeners.message.forEach((fn) => fn(text));
          fragmentOpcode = null;
        }
      }
    });

    const api = {
      sendText(text) { socket.write(encodeClientFrame(OPCODE_TEXT, text)); },
      onMessage(handler) { listeners.message.push(handler); },
      onClose(handler) { listeners.close.push(handler); },
      close() {
        try { socket.write(encodeClientFrame(OPCODE_CLOSE, Buffer.alloc(0))); } catch { /* best effort */ }
        socket.end();
      },
    };

    socket.write(
      `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\n`
      + `Host: ${parsed.host}\r\n`
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Key: ${key}\r\n`
      + 'Sec-WebSocket-Version: 13\r\n\r\n',
    );
  });
}

function nativeWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); // eslint-disable-line no-undef
    const listeners = { message: [], close: [] };
    ws.onmessage = (event) => listeners.message.forEach((fn) => fn(event.data));
    ws.onerror = () => reject(new Error('websocket error'));
    ws.onclose = () => listeners.close.forEach((fn) => fn(new Error('closed by peer')));
    ws.onopen = () => resolve({
      sendText: (text) => ws.send(text),
      onMessage: (handler) => listeners.message.push(handler),
      onClose: (handler) => listeners.close.push(handler),
      close: () => ws.close(),
    });
  });
}

/**
 * Connect and return a CDP command client: `send(method, params) -> Promise<result>`.
 * Rejects when Chrome answers with a protocol error, matching the previous helper.
 */
export async function createCdpClient(wsUrl) {
  const transport = typeof WebSocket === 'function'
    ? await nativeWebSocket(wsUrl)
    : await socketWebSocket(wsUrl);

  let nextId = 1;
  const pending = new Map();
  const eventListeners = [];

  transport.onMessage((raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message.id) {
      eventListeners.forEach((handler) => handler(message));
      return;
    }
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        transport.sendText(JSON.stringify({ id, method, params }));
      });
    },
    /** Subscribe to CDP events (messages without an `id`). */
    onEvent(handler) { eventListeners.push(handler); },
    close() { transport.close(); },
    transport: typeof WebSocket === 'function' ? 'native' : 'socket',
  };
}

/** Launch Chrome headless and wait until its debugging endpoint answers. */
export async function launchChrome({ chromePath, port, userDataDir, width, height, extraArgs = [] }) {
  const { spawn } = await import('node:child_process');
  const child = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    ...extraArgs,
    'about:blank',
  ], { stdio: 'ignore' });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return child;
    } catch { /* not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  try { child.kill(); } catch { /* already gone */ }
  throw new Error(`timeout waiting for Chrome debugging endpoint on ${port}`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
