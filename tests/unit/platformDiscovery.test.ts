import { SamsungRacPlatform } from '../../src/platform';
import { SamsungRacAccessory } from '../../src/platformAccessory';
import { CertificateStore } from '../../src/transport/certificate';
import { TokenStore } from '../../src/transport/tokenStore';
import { LocalApi, UnreachableError } from '../../src/transport/localApi';
import { SsdpDiscovery } from '../../src/discovery/ssdp';

const first = 'C097276C-06FB-0000-0000-000000000000';
const second = 'C097276C-0C0F-0000-0000-000000000000';
const seed = (uuid: string) => `samsung-rac:${uuid}`;
const documents = (uuid: string) => ({ Devices: [{ id: '0', uuid }] });

describe('platform discovery lifecycle', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  function build() {
    const events: Record<string, () => void> = {};
    const log = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const api = {
      hap: { Service: {}, Characteristic: {}, uuid: { generate: (value: string) => value } },
      user: { storagePath: () => '/unused' },
      on: jest.fn((event, callback) => { events[event] = callback; }),
      updatePlatformAccessories: jest.fn(), registerPlatformAccessories: jest.fn(), unregisterPlatformAccessories: jest.fn(),
      platformAccessory: class { constructor(public displayName: string, public UUID: string) {} context = {}; },
    };
    jest.spyOn(CertificateStore.prototype, 'load').mockResolvedValue(Buffer.from('test'));
    jest.spyOn(TokenStore.prototype, 'getForDevice').mockResolvedValue({ token: 'test' });
    const create = jest.spyOn(SamsungRacAccessory, 'create').mockImplementation(async () => ({ stop: jest.fn() }) as any);
    const resolve = jest.spyOn(SsdpDiscovery.prototype, 'resolve').mockImplementation(async uuid =>
      uuid === first.toLowerCase() ? '192.168.1.227' : '192.168.1.170');
    const get = jest.spyOn(LocalApi.prototype, 'get').mockImplementation(async function (this: LocalApi) {
      if (this.host === '192.168.1.227') {
        return documents(first);
      }
      throw new UnreachableError('offline');
    });
    const platform = new SamsungRacPlatform(log as never, {
      platform: 'SamsungRacLocal', outdoorTemperature: 'off',
      devices: [{ host: '192.168.1.227', deviceUuid: first }, { host: '192.168.1.170', deviceUuid: second }],
    }, api as never);
    const cached = [first, second].map(uuid => ({ UUID: seed(uuid), displayName: uuid, context: { room: 'preserved' } }));
    cached.forEach(accessory => platform.configureAccessory(accessory as never));
    return { events, api, create, resolve, get, cached };
  }

  it('keeps cached accessories while offline, then restores them once without replacing their identities', async () => {
    const h = build();
    h.events.didFinishLaunching();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.api.updatePlatformAccessories).toHaveBeenCalledWith([h.cached[0]]);
    expect(h.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledTimes(1);

    h.resolve.mockImplementation(async uuid => uuid === first.toLowerCase() ? '192.168.1.227' : '192.168.1.171');
    h.get.mockImplementation(async function (this: LocalApi) {
      return documents(this.host === '192.168.1.227' ? first : second);
    });
    await jest.advanceTimersByTimeAsync(30000);
    expect(h.api.updatePlatformAccessories).toHaveBeenCalledWith([h.cached[1]]);
    expect(h.api.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(h.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.cached.every(accessory => accessory.context.room === 'preserved')).toBe(true);
    await jest.advanceTimersByTimeAsync(60000);
    expect(h.create).toHaveBeenCalledTimes(2);
    h.events.shutdown();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels startup retries during shutdown', async () => {
    const h = build();
    h.events.didFinishLaunching();
    await jest.advanceTimersByTimeAsync(0);
    h.events.shutdown();
    await jest.advanceTimersByTimeAsync(60000);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not publish an accessory if shutdown happens during initial authentication', async () => {
    const h = build();
    let release!: (value: unknown) => void;
    h.get.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    h.events.didFinishLaunching();
    await jest.advanceTimersByTimeAsync(0);
    h.events.shutdown();
    release(documents(first));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.create).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
