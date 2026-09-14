import * as net from 'node:net';
import * as tls from 'node:tls';
import { PAIRING_CALLBACK_PORT } from '../settings';
import { devicesFrom, RacDevicesResponse } from '../racStatus';
import { LocalApi } from './localApi';
import { tlsOptions } from './tls';

/**
 * The device-token pairing ritual.
 *
 * This is not an API call. The AC does NOT return a token in the response to
 * /devicetoken/request: it opens a *new* connection back to whoever asked, on
 * port 8889, once it powers on. Hence the order below, which users get wrong
 * unless the UI walks them through it:
 *
 *   1. the AC must be powered OFF
 *   2. we start listening on 8889
 *   3. we POST /devicetoken/request
 *   4. the user powers the AC ON
 *   5. the AC calls back and posts {"DeviceToken": "..."}
 *
 * The callback is TLS, not plain HTTP. That distinction cost two failed
 * attempts to establish: a plain http.Server accepts the connection and then
 * stalls on the ClientHello without logging anything, which is indistinguishable
 * from the air conditioner never calling back at all.
 */

export type PairingStage =
  | 'listening'
  | 'requested'
  | 'waiting'
  | 'connected'
  | 'received'
  | 'verified';

export interface PairingProgress {
  stage: PairingStage;
  message: string;
}

export interface PairingOptions {
  host: string;
  pem: Buffer;
  port?: number;
  callbackPort?: number;
  /** How long to wait for the AC to call back once the request has gone out. */
  timeoutMs?: number;
  onProgress?: (progress: PairingProgress) => void;
  signal?: AbortSignal;
}

export interface PairingResult {
  token: string;
  deviceUuid?: string;
  model?: string;
  name?: string;
}

export class PairingError extends Error {}

/**
 * Accept any JSON key ending in `token`, plus a loose regex fallback.
 *
 * The reference unit sends `DeviceToken`, but a firmware variant spelling it
 * differently should not be silently dropped after the user has already power
 * cycled their air conditioner.
 */
export function extractToken(payload: string): string | null {
  const json = payload.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]);
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (key.toLowerCase().endsWith('token') && typeof value === 'string' && value) {
            return value;
          }
        }
      }
    } catch {
      // Fall through to the loose match below.
    }
  }

  const loose = payload.match(/["']?[Dd]evice[Tt]oken["']?\s*[:=]\s*["']([^"']+)["']/);
  return loose ? loose[1] : null;
}

/** Read one HTTP request off a stream, honouring Content-Length. */
function readRequest(stream: NodeJS.ReadableStream, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    let data = Buffer.alloc(0);
    let settled = false;

    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(data.toString('utf8'));
      }
    };
    const timer = setTimeout(finish, timeoutMs);

    stream.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const headerEnd = data.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const length = /content-length:\s*(\d+)/i.exec(data.subarray(0, headerEnd).toString('utf8'));
      const wanted = length ? Number(length[1]) : 0;
      if (data.length - (headerEnd + 4) >= wanted) {
        finish();
      }
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

/** Listen on 8889 until the AC posts a token, or we give up. */
function awaitCallback(
  pem: Buffer,
  callbackPort: number,
  timeoutMs: number,
  onProgress: (progress: PairingProgress) => void,
  signal: AbortSignal | undefined,
): { started: Promise<void>; token: Promise<string>; close: () => void } {
  const secureContext = tls.createSecureContext(tlsOptions(pem));
  const server = net.createServer();

  let resolveToken: (token: string) => void;
  let rejectToken: (error: Error) => void;
  const token = new Promise<string>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  const timer = setTimeout(() => {
    rejectToken(new PairingError(
      `The air conditioner did not call back on port ${callbackPort} within ${Math.round(timeoutMs / 1000)}s. `
      + 'Check that it was powered off when pairing started and on afterwards, that this machine is on the same '
      + 'network, and that inbound connections to that port are not blocked by a firewall or container network.',
    ));
  }, timeoutMs);

  const close = () => {
    clearTimeout(timer);
    server.close();
  };

  signal?.addEventListener('abort', () => rejectToken(new PairingError('Pairing was cancelled.')), { once: true });

  server.on('connection', (socket) => {
    socket.setTimeout(20000, () => socket.destroy());

    socket.once('data', (chunk: Buffer) => {
      socket.pause();
      socket.unshift(chunk);

      // 0x16 0x03 is a TLS handshake record. The AC speaks TLS here; anything
      // else is logged and parsed anyway rather than dropped.
      const isTls = chunk.length >= 2 && chunk[0] === 0x16 && chunk[1] === 0x03;
      onProgress({
        stage: 'connected',
        message: `The air conditioner connected back (${isTls ? 'TLS' : 'plain text'}).`,
      });

      const stream: NodeJS.ReadWriteStream = isTls
        ? new tls.TLSSocket(socket, { isServer: true, secureContext })
        : socket;

      stream.on('error', () => undefined);

      readRequest(stream).then((payload) => {
        const captured = extractToken(payload);
        try {
          stream.write(
            'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{"status":"ok"}',
          );
          stream.end();
        } catch {
          // The AC does not care whether it got an answer.
        }
        if (captured) {
          onProgress({ stage: 'received', message: 'Device token received.' });
          resolveToken(captured);
        }
      });

      process.nextTick(() => socket.resume());
    });
  });

  const started = new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new PairingError(
          `Port ${callbackPort} is already in use. A listener from an earlier pairing attempt is probably still `
          + 'holding it — that failure looks exactly like the air conditioner never calling back. Stop it and retry.',
        ));
        return;
      }
      reject(error);
    });
    server.listen(callbackPort, '0.0.0.0', () => resolve());
  });

  return { started, token, close };
}

export async function pairDevice(options: PairingOptions): Promise<PairingResult> {
  const callbackPort = options.callbackPort ?? PAIRING_CALLBACK_PORT;
  const timeoutMs = options.timeoutMs ?? 180000;
  const onProgress = options.onProgress ?? (() => undefined);

  const listener = awaitCallback(options.pem, callbackPort, timeoutMs, onProgress, options.signal);
  await listener.started;
  onProgress({ stage: 'listening', message: `Listening on port ${callbackPort} for the air conditioner.` });

  const api = new LocalApi({ host: options.host, pem: options.pem, port: options.port, timeoutMs: 10000 });

  try {
    // No token yet, so this is expected to be refused in some firmwares — what
    // matters is that the unit records who asked. Errors are reported but not
    // fatal for that reason.
    try {
      await api.post('/devicetoken/request', {});
      onProgress({ stage: 'requested', message: 'Token request sent to the air conditioner.' });
    } catch (error) {
      onProgress({
        stage: 'requested',
        message: `Token request returned an error (${(error as Error).message}); continuing to listen anyway.`,
      });
    }

    onProgress({ stage: 'waiting', message: 'Now power the air conditioner ON.' });
    const token = await listener.token;

    // Prove the token before storing it, so a failure surfaces here rather than
    // as a puzzling 401 on the first poll.
    const verifier = new LocalApi({ host: options.host, pem: options.pem, port: options.port, token, timeoutMs: 10000 });
    let device;
    try {
      device = devicesFrom(await verifier.get<RacDevicesResponse>('/devices'))[0];
    } finally {
      verifier.close();
    }

    if (!device) {
      throw new PairingError('The token was accepted but the air conditioner reported no devices.');
    }

    onProgress({ stage: 'verified', message: `Paired with ${device.description ?? 'the air conditioner'}.` });

    return { token, deviceUuid: device.uuid, model: device.description, name: device.name };
  } finally {
    listener.close();
    api.close();
  }
}
