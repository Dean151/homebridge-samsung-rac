import * as dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { normaliseDeviceUuid, parseSsdpResponse, scanSsdp, SsdpDiscovery } from '../../src/discovery/ssdp';

jest.mock('node:dgram', () => ({ createSocket: jest.fn() }));
const uuid = 'c097276c-06fb-0000-0000-000000000000';
const otherUuid = 'c097276c-0c0f-0000-0000-000000000000';
const response = (host = '192.168.1.227', id = uuid) => Buffer.from('HTTP/1.1 200 OK\r\n'
  + `USN: uuid:${id}::urn:SmartHomeAlliance-org:device:Air_Conditioner:1.0 deviceSubType/Room_Air_Conditioner\r\n`
  + `LOCATION: https://${host}:8888/capability\r\nST: 239.255.255.250:1900\r\n\r\n`);

describe('Samsung SSDP replies', () => {
  it('accepts the observed firmware response despite its nonstandard ST header', () => {
    expect(parseSsdpResponse(response(), '192.168.1.227')).toEqual({ uuid, host: '192.168.1.227' });
    expect(normaliseDeviceUuid(' UUID:' + uuid.toUpperCase() + ' ')).toBe(uuid);
  });

  it.each([
    'http://192.168.1.227:8888/capability',
    'https://192.168.1.62:8888/capability',
    'https://example.com:8888/capability',
    'https://192.168.1.227:443/capability',
    'https://user:password@192.168.1.227:8888/capability',
    'https://192.168.1.227:8888/other',
    'https://192.168.1.227:8888/capability?redirect=1',
    'https://192.168.1.227:8888/capability#fragment',
  ])('rejects an unsafe or unrelated location: %s', location => {
    const packet = Buffer.from(response().toString().replace('https://192.168.1.227:8888/capability', location));
    expect(parseSsdpResponse(packet, '192.168.1.227')).toBeUndefined();
  });

  it('rejects public addresses, malformed UUIDs, duplicate identity headers and oversized datagrams', () => {
    expect(parseSsdpResponse(response('8.8.8.8'), '8.8.8.8')).toBeUndefined();
    expect(parseSsdpResponse(response('192.168.1.227', 'garbage'), '192.168.1.227')).toBeUndefined();
    expect(parseSsdpResponse(Buffer.concat([response(), Buffer.from('Location: https://evil.invalid')]), '192.168.1.227'))
      .toBeUndefined();
    expect(parseSsdpResponse(Buffer.alloc(9000), '192.168.1.227')).toBeUndefined();
  });
});

class FakeSocket extends EventEmitter {
  send = jest.fn((_packet, _port, _host, callback) => callback());
  close = jest.fn();
  setMulticastInterface = jest.fn();
  setMulticastTTL = jest.fn();
  bind = jest.fn((_port, _host, callback) => callback());
}

describe('bounded UDP discovery', () => {
  let socket: FakeSocket;
  beforeEach(() => {
    jest.useFakeTimers();
    socket = new FakeSocket();
    (dgram.createSocket as jest.Mock).mockReturnValue(socket);
  });
  afterEach(() => { jest.useRealTimers(); });
  const options = () => ({
    targets: [{ uuid, host: '192.168.1.227' }],
    interfaces: [{ address: '192.168.1.10', netmask: '255.255.255.0' }],
  });

  it('matches only configured UUIDs on the local subnet and closes all timers/sockets', async () => {
    const pending = scanSsdp(options());
    socket.emit('message', response('192.168.1.62', otherUuid), { address: '192.168.1.62' });
    socket.emit('message', response('10.0.0.5'), { address: '10.0.0.5' });
    socket.emit('message', response(), { address: '192.168.1.227' });
    await jest.advanceTimersByTimeAsync(3500);
    expect(await pending).toEqual(new Map([[uuid, '192.168.1.227']]));
    expect(socket.send).toHaveBeenCalledTimes(12);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ignores conflicting advertisements instead of choosing a random AC', async () => {
    const pending = scanSsdp(options());
    socket.emit('message', response(), { address: '192.168.1.227' });
    socket.emit('message', response('192.168.1.62'), { address: '192.168.1.62' });
    socket.emit('message', response(), { address: '192.168.1.227' });
    await jest.advanceTimersByTimeAsync(3500);
    expect((await pending).size).toBe(0);
  });

  it('cancels immediately on shutdown', async () => {
    const controller = new AbortController();
    const pending = scanSsdp({ ...options(), signal: controller.signal });
    controller.abort();
    expect((await pending).size).toBe(0);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('shared discovery', () => {
  it('coalesces scans, caches results, and scans again after a failed address', async () => {
    let time = 0;
    const scanner = jest.fn().mockResolvedValue(new Map([[uuid, '192.168.1.227'], [otherUuid, '192.168.1.170']]));
    const discovery = new SsdpDiscovery([{ uuid }, { uuid: otherUuid }], scanner, () => time);
    expect(await Promise.all([discovery.resolve(uuid), discovery.resolve(otherUuid)]))
      .toEqual(['192.168.1.227', '192.168.1.170']);
    expect(scanner).toHaveBeenCalledTimes(1);
    await discovery.resolve(uuid);
    expect(scanner).toHaveBeenCalledTimes(1);
    discovery.invalidate(uuid, '192.168.1.227');
    scanner.mockResolvedValue(new Map([[uuid, '192.168.1.228']]));
    expect(await discovery.resolve(uuid)).toBe('192.168.1.228');
    time += 30000;
    await discovery.resolve(uuid);
    expect(scanner).toHaveBeenCalledTimes(3);
    discovery.close();
    expect(await discovery.resolve(uuid)).toBeUndefined();
    expect(scanner).toHaveBeenCalledTimes(3);
  });
});
