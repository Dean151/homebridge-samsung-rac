import { DiscoveredApi, DeviceIdentityError } from '../../src/transport/discoveredApi';
import { UnreachableError } from '../../src/transport/localApi';
import type { HttpRequest } from '../../src/transport/httpOverTls';

const uuid = 'C097276C-06FB-0000-0000-000000000000';
const oldHost = '192.168.1.227';
const newHost = '192.168.1.228';
const document = (id = uuid) => ({ Devices: [{ id: '0', uuid: id, Operation: { power: 'Off' } }] });

function build() {
  let address: string | undefined = newHost;
  let now = 0;
  const discovery = { resolve: jest.fn(async () => address), invalidate: jest.fn() };
  const sent: HttpRequest[] = [];
  const reply = jest.fn(async (_request: HttpRequest) => ({ status: 200, headers: {}, body: JSON.stringify(document()) }));
  const api = new DiscoveredApi({ host: oldHost, token: 'paired-token', pem: Buffer.from('test'), transport: async request => {
    sent.push(request);
    return reply(request);
  } }, uuid, discovery, undefined, () => now);
  return { api, discovery, sent, reply, setAddress: (host?: string) => { address = host; }, advance: () => { now += 30000; } };
}

describe('UUID-bound API', () => {
  it('discovers a changed address, verifies identity, and reuses the pairing token', async () => {
    const { api, sent, discovery } = build();
    await api.put('/devices/0/operation', { Operation: { power: 'Off' } });
    expect(sent.map(request => [request.method, request.host])).toEqual([['GET', newHost], ['PUT', newHost]]);
    expect(sent.every(request => request.headers.Authorization === 'Bearer paired-token')).toBe(true);
    expect(discovery.resolve).toHaveBeenCalledTimes(1);
    api.close();
  });

  it('recovers after an address changes while running', async () => {
    const h = build();
    h.setAddress(oldHost);
    await h.api.get('/devices');
    h.reply.mockImplementation(async request => {
      if (request.host === oldHost) {
        throw new Error('EHOSTUNREACH');
      }
      return { status: 200, headers: {}, body: JSON.stringify(document()) };
    });
    h.setAddress(newHost);
    await expect(h.api.get('/devices')).rejects.toThrow(UnreachableError);
    await expect(h.api.get('/devices')).resolves.toEqual(document());
    expect(h.discovery.invalidate).toHaveBeenCalledWith(uuid.toLowerCase(), oldHost);
    expect(h.sent.at(-1)?.host).toBe(newHost);
  });

  it('never replays a write after losing its response', async () => {
    const h = build();
    h.reply.mockImplementation(async request => {
      if (request.method === 'PUT') {
        throw new Error('connection closed after write');
      }
      return { status: 200, headers: {}, body: JSON.stringify(document()) };
    });
    await expect(h.api.put('/devices/0/operation', { Operation: { power: 'On' } })).rejects.toThrow(UnreachableError);
    await h.api.get('/devices');
    expect(h.sent.filter(request => request.method === 'PUT')).toHaveLength(1);
  });

  it('blocks writes when the authenticated API reports a different unit', async () => {
    const h = build();
    h.reply.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify(document('C097276C-0C0F-0000-0000-000000000000')) });
    await expect(h.api.put('/devices/0/operation', {})).rejects.toThrow(DeviceIdentityError);
    expect(h.sent.every(request => request.method === 'GET')).toBe(true);
    await expect(h.api.put('/devices/0/operation', {})).rejects.toThrow('Waiting to rediscover');
    expect(h.discovery.resolve).toHaveBeenCalledTimes(1);
  });

  it('invalidates a live endpoint if its identity changes on a poll', async () => {
    const h = build();
    await h.api.get('/devices');
    h.reply.mockResolvedValue({ status: 200, headers: {}, body: '{"Devices":[]}' });
    await expect(h.api.get('/devices')).rejects.toThrow(DeviceIdentityError);
    await expect(h.api.put('/devices/0/operation', {})).rejects.toThrow(DeviceIdentityError);
    expect(h.sent.every(request => request.method === 'GET')).toBe(true);
  });

  it.each([null, {}, { Devices: {} }, { Devices: [null] }])('blocks malformed identity responses: %j', async response => {
    const h = build();
    h.reply.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify(response) });
    await expect(h.api.put('/devices/0/operation', {})).rejects.toThrow(DeviceIdentityError);
    expect(h.sent.every(request => request.method === 'GET')).toBe(true);
  });

  it('falls back to the last-known address when multicast is unavailable, still checking UUID', async () => {
    const h = build();
    h.setAddress(undefined);
    await h.api.get('/devices');
    expect(h.sent.every(request => request.host === oldHost)).toBe(true);
  });

  it('backs off offline devices and recovers on a later request', async () => {
    const h = build();
    h.reply.mockRejectedValue(new Error('offline'));
    await expect(h.api.get('/devices')).rejects.toThrow(UnreachableError);
    await expect(h.api.get('/devices')).rejects.toThrow('Waiting to rediscover');
    expect(h.discovery.resolve).toHaveBeenCalledTimes(1);
    h.advance();
    h.reply.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify(document()) });
    await expect(h.api.get('/devices')).resolves.toEqual(document());
  });

  it('shares the connection check between concurrent requests', async () => {
    const h = build();
    await Promise.all([h.api.get('/devices'), h.api.get('/devices')]);
    expect(h.discovery.resolve).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(3); // one identity check and two reads
  });

  it('cannot reconnect after shutdown', async () => {
    const h = build();
    let release!: (host: string) => void;
    h.discovery.resolve.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = h.api.get('/devices');
    h.api.close();
    release(newHost);
    await expect(pending).rejects.toThrow('Discovery stopped');
    expect(h.sent).toHaveLength(0);
  });
});
