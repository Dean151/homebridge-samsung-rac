import * as tls from 'node:tls';
import { tlsOptions } from './tls';

/**
 * A minimal HTTP/1.1 client spoken directly over a TLS socket.
 *
 * Node's own HTTP client cannot talk to this hardware at all. The unit answers
 * with a header spelled
 *
 *     X-API-Version : v1.0.0
 *
 * — a space between the field name and the colon, which RFC 7230 forbids.
 * llhttp rejects the whole response with HPE_INVALID_HEADER_TOKEN, and that
 * check is deliberately NOT relaxed by `insecureHTTPParser` or by
 * `--insecure-http-parser` (verified on Node 26): whitespace before the colon is
 * a request-smuggling vector, so it is refused unconditionally. curl accepts it,
 * which is why the transport looked fine when it was first proven with shell
 * scripts, and only broke once real code ran.
 *
 * The surface we need is tiny — one request per connection, JSON in and out,
 * Content-Length or close-delimited — so parsing it here costs less than
 * fighting the platform, and the tolerance is scoped to this one appliance
 * instead of being turned on process-wide.
 */

export interface HttpRequest {
  host: string;
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  pem: Buffer;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export class HttpProtocolError extends Error {}

/** Split `Name: value`, tolerating the whitespace the unit puts before the colon. */
function parseHeaders(lines: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function decodeChunked(body: Buffer): string {
  const decoded: Buffer[] = [];
  let offset = 0;

  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) {
      break;
    }
    const size = parseInt(body.subarray(offset, lineEnd).toString('ascii').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) {
      break;
    }
    const start = lineEnd + 2;
    decoded.push(body.subarray(start, start + size));
    offset = start + size + 2;
  }

  return Buffer.concat(decoded).toString('utf8');
}

/**
 * Parse a complete response. Exported so the malformed header this whole module
 * exists for can be tested without any hardware.
 */
export function parseResponse(raw: Buffer): HttpResponse {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    throw new HttpProtocolError('The response ended before its headers were complete.');
  }

  const [statusLine, ...headerLines] = raw.subarray(0, headerEnd).toString('utf8').split('\r\n');
  const status = Number(statusLine.split(' ')[1]);
  if (!Number.isFinite(status)) {
    throw new HttpProtocolError(`Unintelligible status line: ${JSON.stringify(statusLine)}`);
  }

  const headers = parseHeaders(headerLines);
  const body = raw.subarray(headerEnd + 4);

  return {
    status,
    headers,
    body: headers['transfer-encoding'] === 'chunked' ? decodeChunked(body) : body.toString('utf8'),
  };
}

/** True once `raw` holds a whole response, so the socket can be closed early. */
function isComplete(raw: Buffer): boolean {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    return false;
  }

  const headers = parseHeaders(raw.subarray(0, headerEnd).toString('utf8').split('\r\n').slice(1));
  if (headers['transfer-encoding'] === 'chunked') {
    return raw.includes('\r\n0\r\n');
  }

  const length = Number(headers['content-length']);
  if (!Number.isFinite(length)) {
    // No length and not chunked: the body runs until the unit closes the socket.
    return false;
  }
  return raw.length - (headerEnd + 4) >= length;
}

export const tlsTransport: HttpTransport = (request) => new Promise<HttpResponse>((resolve, reject) => {
  const headers = { ...request.headers, Host: `${request.host}:${request.port}`, Connection: 'close' };
  const head = [
    `${request.method} ${request.path} HTTP/1.1`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '', '',
  ].join('\r\n');

  const socket = tls.connect({
    host: request.host,
    port: request.port,
    ...tlsOptions(request.pem),
  });

  let raw = Buffer.alloc(0);
  let settled = false;

  const succeed = () => {
    if (settled) {
      return;
    }
    settled = true;
    socket.destroy();
    try {
      resolve(parseResponse(raw));
    } catch (error) {
      reject(error);
    }
  };

  const fail = (error: Error) => {
    if (settled) {
      return;
    }
    settled = true;
    socket.destroy();
    reject(error);
  };

  socket.setTimeout(request.timeoutMs, () => {
    fail(new Error(`${request.method} ${request.path} timed out after ${request.timeoutMs}ms.`));
  });

  socket.on('secureConnect', () => {
    socket.write(head);
    if (request.body !== undefined) {
      socket.write(request.body);
    }
  });

  socket.on('data', (chunk: Buffer) => {
    raw = Buffer.concat([raw, chunk]);
    if (isComplete(raw)) {
      succeed();
    }
  });

  // The unit answers Connection: close, so end-of-socket is the normal way a
  // close-delimited response finishes.
  socket.on('end', succeed);
  socket.on('close', () => {
    if (raw.length) {
      succeed();
    } else {
      fail(new Error('The connection closed before any response arrived.'));
    }
  });
  socket.on('error', fail);
});
