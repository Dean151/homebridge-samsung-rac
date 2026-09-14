import type { HttpRequest, HttpResponse } from '../../src/transport/httpOverTls';
import {
  CertificateRejectedError, LocalApi, LocalApiError, TokenInvalidError, UnreachableError,
} from '../../src/transport/localApi';

const pem = Buffer.from('not-a-real-certificate');

interface Harness {
  api: LocalApi;
  sent: HttpRequest[];
}

// `null` means unpaired — passing `undefined` would just hit the default.
function build(reply: Partial<HttpResponse> | Error, token: string | null = 'test-token'): Harness {
  const sent: HttpRequest[] = [];

  const api = new LocalApi({
    host: '10.0.0.9',
    pem,
    token: token ?? undefined,
    timeoutMs: 500,
    transport: async (request) => {
      sent.push(request);
      if (reply instanceof Error) {
        throw reply;
      }
      return { status: 200, headers: {}, body: '', ...reply };
    },
  });

  return { api, sent };
}

describe('LocalApi tracing', () => {
  function traced(reply: Partial<HttpResponse> | Error) {
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const api = new LocalApi({
      host: '10.0.0.9',
      pem,
      token: 'test-token',
      timeoutMs: 500,
      log: log as never,
      transport: async () => {
        if (reply instanceof Error) {
          throw reply;
        }
        return { status: 200, headers: {}, body: '', ...reply };
      },
    });
    return { api, lines: () => log.debug.mock.calls.map((call) => call.join(' ')) };
  }

  it('summarises a polled GET body instead of printing kilobytes of JSON', async () => {
    const { api, lines } = traced({ body: '{"Devices":[]}' });

    await api.get('/devices');

    expect(lines()[0]).toContain('10.0.0.9:8888 > GET /devices');
    expect(lines()[1]).toMatch(/< 200 GET \/devices in \d+ms \(14 bytes\)/);
  });

  it('prints a write and its answer in full', async () => {
    const { api, lines } = traced({ body: '{"ok":true}' });

    await api.put('/devices/0/wind', { Wind: { direction: 'Up_And_Low' } });

    expect(lines()[0]).toContain('> PUT /devices/0/wind {"Wind":{"direction":"Up_And_Low"}}');
    expect(lines()[1]).toContain('{"ok":true}');
  });

  it('traces a failure with the underlying reason', async () => {
    const { api, lines } = traced(new Error('ETIMEDOUT'));

    await expect(api.get('/devices')).rejects.toThrow(UnreachableError);
    expect(lines()[1]).toContain('x GET /devices after');
    expect(lines()[1]).toContain('ETIMEDOUT');
  });
});

describe('LocalApi', () => {
  it('sends the token and the API version the unit expects', async () => {
    const { api, sent } = build({ body: '{"Devices":[]}' });

    await expect(api.get('/devices')).resolves.toEqual({ Devices: [] });
    expect(sent[0]).toMatchObject({
      method: 'GET',
      path: '/devices',
      port: 8888,
      headers: expect.objectContaining({
        'Authorization': 'Bearer test-token',
        'X-API-Version': 'v1.0.0',
      }),
    });
  });

  it('sends no authorization header before pairing, which is how pairing starts', async () => {
    const { api, sent } = build({ status: 200 }, null);
    await api.post('/devicetoken/request', {});
    expect(sent[0].headers['Authorization']).toBeUndefined();
  });

  it('sends a write as JSON with a length', async () => {
    const { api, sent } = build({ status: 200 });
    await api.put('/devices/0/wind', { Wind: { direction: 'Up_And_Low' } });

    expect(sent[0].body).toBe('{"Wind":{"direction":"Up_And_Low"}}');
    expect(sent[0].headers['Content-Length']).toBe('35');
  });

  it('names the certificate as the problem when nginx refuses the connection', async () => {
    // Without a client certificate the unit answers with this, and the useful
    // fix ("re-fetch the certificate") is nowhere in the raw message.
    const { api } = build({
      status: 400,
      body: '<html>400 Bad Request\nNo required SSL certificate was sent</html>',
    });

    await expect(api.get('/devices')).rejects.toBeInstanceOf(CertificateRejectedError);
  });

  it('names the token as the problem when the unit rejects it', async () => {
    const { api } = build({
      status: 401,
      body: '{"errorCode":"0","errorDescription":"Token is not valid"}',
    });

    const error = await api.get('/devices').catch((caught) => caught) as Error;
    expect(error).toBeInstanceOf(TokenInvalidError);
    expect(error.message).toContain('Pair again');
  });

  it('keeps any other failure as a plain API error carrying the status', async () => {
    const { api } = build({ status: 500, body: 'boom' });

    const error = await api.get('/devices').catch((caught) => caught) as LocalApiError;
    expect(error).toBeInstanceOf(LocalApiError);
    expect(error).not.toBeInstanceOf(TokenInvalidError);
    expect(error.status).toBe(500);
  });

  it('reports a unit that cannot be reached at all', async () => {
    const { api } = build(new Error('connect EHOSTUNREACH'));
    await expect(api.get('/devices')).rejects.toBeInstanceOf(UnreachableError);
  });

  it('explains a TLS handshake failure in terms the user can act on', async () => {
    const tlsError = Object.assign(new Error('unsupported protocol'), { code: 'ERR_SSL_UNSUPPORTED_PROTOCOL' });
    const { api } = build(tlsError);

    const error = await api.get('/devices').catch((caught) => caught) as Error;
    expect(error.message).toContain('TLS handshake');
    expect(error.message).toContain('10.0.0.9:8888');
  });
});
