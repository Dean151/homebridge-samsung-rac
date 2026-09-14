import { HttpProtocolError, parseResponse } from '../../src/transport/httpOverTls';

/**
 * Byte-for-byte what the reference unit answered on 2026-09-15, captured with
 * curl. Note `X-API-Version : v1.0.0` — the space before the colon is why this
 * module exists at all.
 */
const realResponse = [
  'HTTP/1.1 200 OK',
  'Server: nginx/1.2.7',
  'Date: Mon, 14 Sep 2026 22:06:19 GMT',
  'Content-Type: application/json',
  'Content-Length: 21',
  'Connection: close',
  'X-API-Version : v1.0.0',
  '',
  '{"Devices":[{"id":0}]}',
].join('\r\n');

describe('parseResponse', () => {
  it('accepts the malformed header Node refuses outright', () => {
    // RFC 7230 forbids whitespace before the colon and llhttp rejects the whole
    // response over it, with no way to opt out. This unit sends it anyway.
    const response = parseResponse(Buffer.from(realResponse, 'utf8'));

    expect(response.status).toBe(200);
    expect(response.headers['x-api-version']).toBe('v1.0.0');
    expect(response.body).toContain('"Devices"');
  });

  it('lower-cases header names so lookups do not depend on the unit\'s spelling', () => {
    const response = parseResponse(Buffer.from(realResponse, 'utf8'));
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['server']).toBe('nginx/1.2.7');
  });

  it('carries a non-200 status through instead of throwing', () => {
    const raw = 'HTTP/1.1 401 Unauthorized\r\nContent-Length: 47\r\n\r\n'
      + '{"errorCode":"0","errorDescription":"Token is not valid"}';
    expect(parseResponse(Buffer.from(raw)).status).toBe(401);
  });

  it('decodes a chunked body', () => {
    const raw = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'
      + '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n';
    expect(parseResponse(Buffer.from(raw)).body).toBe('hello world');
  });

  it('reads a close-delimited body with no length at all', () => {
    const raw = 'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{"ok":true}';
    expect(parseResponse(Buffer.from(raw)).body).toBe('{"ok":true}');
  });

  it('refuses a response that was cut off mid-headers', () => {
    expect(() => parseResponse(Buffer.from('HTTP/1.1 200 OK\r\nServer: ngi')))
      .toThrow(HttpProtocolError);
  });

  it('refuses something that is not HTTP at all', () => {
    expect(() => parseResponse(Buffer.from('garbage\r\n\r\nbody')))
      .toThrow(HttpProtocolError);
  });
});
