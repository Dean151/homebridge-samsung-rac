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
  it('accepts sibling documents but rejects replacement of the bound device', async () => {
    const h = build();
    const sibling = { id: '1', uuid: 'C097276C-0C0F-0000-0000-000000000000' };
    h.reply.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify({ Devices: [sibling, ...document().Devices] }) });
    await expect(h.api.get('/devices')).resolves.toHaveProperty('Devices');
    await h.api.put('/devices/1/operation', { Operation: { power: 'Off' } });
    h.reply.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify({ Devices: [
      { ...sibling, id: '0' }, { ...document().Devices[0], id: '1' },
    ] }) });
    await expect(h.api.get('/devices')).rejects.toThrow(DeviceIdentityError);
  });

  it('discovers a changed address, verifies identity, and reuses the pairing token', async () => {
    const { api, sent, discovery, reply } = build();
    reply.mockImplementation(async request => {
      if (request.host === oldHost) { throw new Error('EHOSTUNREACH'); }
      return { status: 200, headers: {}, body: JSON.stringify(document()) };
    });
    await api.put('/devices/0/operation', { Operation: { power: 'Off' } });
    expect(sent.map(request => [request.method, request.host])).toEqual([['GET', oldHost], ['GET', newHost], ['PUT', newHost]]);
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
    await expect(h.api.put('/devices/0/operation', {})).rejects.toThrow(DeviceIdentityError);
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

  it('retries the known address immediately while backing off multicast searches', async () => {
    const h = build();
    h.setAddress(undefined);
    h.reply.mockRejectedValue(new Error('offline'));
    await expect(h.api.get('/devices')).rejects.toThrow(UnreachableError);
    await expect(h.api.get('/devices')).rejects.toThrow(UnreachableError);
    expect(h.sent.map(request => request.host)).toEqual([oldHost, oldHost]);
    expect(h.discovery.resolve).toHaveBeenCalledTimes(1);
    h.reply.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify(document()) });
    await expect(h.api.get('/devices')).resolves.toEqual(document());
    expect(h.discovery.resolve).toHaveBeenCalledTimes(1);
  });

  it('searches again after the multicast cooldown if the address moved', async () => {
    const h = build();
    h.setAddress(undefined);
    h.reply.mockRejectedValue(new Error('offline'));
    await expect(h.api.get('/devices')).rejects.toThrow(UnreachableError);
    h.advance();
    h.setAddress(newHost);
    h.reply.mockImplementation(async request => {
      if (request.host === oldHost) { throw new Error('EHOSTUNREACH'); }
      return { status: 200, headers: {}, body: JSON.stringify(document()) };
    });
    await expect(h.api.get('/devices')).resolves.toEqual(document());
    expect(h.discovery.resolve).toHaveBeenCalledTimes(2);
    expect(h.sent.at(-1)?.host).toBe(newHost);
  });

  it('uses a working known address without waiting for multicast to finish', async () => {
    const h = build();
    let finish!: (host?: string) => void;
    h.discovery.resolve.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await expect(h.api.get('/devices')).resolves.toEqual(document());
    expect(h.sent.every(request => request.host === oldHost)).toBe(true);
    finish(newHost);
    await h.api.put('/devices/0/operation', {});
    expect(h.sent.at(-1)?.host).toBe(oldHost);
  });

  it('keeps a working known address when the parallel search fails', async () => {
    const h = build();
    h.discovery.resolve.mockRejectedValue(new Error('multicast unavailable'));
    await expect(h.api.get('/devices')).resolves.toEqual(document());
    expect(h.sent.every(request => request.host === oldHost)).toBe(true);
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
    const pending = h.api.put('/devices/0/operation', {});
    h.api.close();
    release(newHost);
    await expect(pending).rejects.toThrow('Discovery stopped');
    expect(h.sent.every(request => request.method === 'GET')).toBe(true);
    const requests = h.sent.length;
    await expect(h.api.get('/devices')).rejects.toThrow('Discovery stopped');
    expect(h.sent).toHaveLength(requests);
  });
});
