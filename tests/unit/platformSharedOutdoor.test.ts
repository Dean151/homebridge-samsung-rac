import { SamsungRacPlatform } from '../../src/platform';
import { SamsungRacAccessory } from '../../src/platformAccessory';
import { CertificateStore } from '../../src/transport/certificate';
import { LocalApi } from '../../src/transport/localApi';
import type { RacStatus } from '../../src/racStatus';
import { Characteristic, FakeAccessory, FakeHapStatusError, HAPStatus, Service } from '../mocks/hap.mock';

const status = (outdoorTemperature: number) => ({ outdoorTemperature, active: false, connected: true }) as RacStatus;
function build(hide = false, devices: { host: string; token: string }[] = []) {
  const events: Record<string, () => void> = {};
  const api = {
    hap: { Service, Characteristic, HapStatusError: FakeHapStatusError, HAPStatus, uuid: { generate: (value: string) => value } },
    user: { storagePath: () => '/unused' },
    on: (event: string, callback: () => void) => { events[event] = callback; },
    platformAccessory: FakeAccessory,
    registerPlatformAccessories: jest.fn(), updatePlatformAccessories: jest.fn(), unregisterPlatformAccessories: jest.fn(),
  };
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const platform = new SamsungRacPlatform(log as never, { platform: 'SamsungRacLocal',
    outdoorTemperature: 'shared', hideOutdoorTemperatureWhenOff: hide, devices }, api as never);
  return { platform, api, events };
}

describe('shared outdoor accessory lifecycle', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.restoreAllMocks(); jest.useRealTimers(); });

  it('keeps the shared sensor during startup pruning while removing obsolete per-AC sensors', async () => {
    jest.spyOn(CertificateStore.prototype, 'load').mockResolvedValue(Buffer.from('test'));
    jest.spyOn(LocalApi.prototype, 'get').mockResolvedValue({ Devices: [{ id: '0', uuid: 'test-ac' }] });
    jest.spyOn(SamsungRacAccessory, 'create').mockImplementation(async platform => {
      platform.reportOutdoorTemperature('test-ac', status(18), Date.now());
      return { stop: jest.fn() } as unknown as SamsungRacAccessory;
    });
    const h = build(false, [{ host: '192.0.2.1', token: 'test' }]);
    const shared = new FakeAccessory('Outside', 'samsung-rac:shared-outdoor');
    const obsolete = new FakeAccessory('Old per-AC sensor', 'old-outdoor-sensor');
    h.platform.configureAccessory(shared as never);
    h.platform.configureAccessory(obsolete as never);
    h.events.didFinishLaunching();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.api.updatePlatformAccessories).toHaveBeenCalledWith([shared]);
    expect(h.api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(h.api.unregisterPlatformAccessories.mock.calls[0][2]).toEqual([obsolete]);
    h.events.shutdown();
  });

  it('registers one sensor for all sources, expires it, then recovers without adding another', () => {
    const h = build();
    for (const source of ['office', 'living', 'bedroom']) {
      h.platform.reportOutdoorTemperature(source, status(18.3), Date.now());
    }
    expect(h.api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    const accessory = h.api.registerPlatformAccessories.mock.calls[0][2][0] as FakeAccessory;
    expect(accessory.UUID).toBe('samsung-rac:shared-outdoor');
    const temperature = accessory.getService(Service.TemperatureSensor)!.getCharacteristic(Characteristic.CurrentTemperature);
    expect(temperature.getHandler?.()).toBe(18.3);
    jest.advanceTimersByTime(60000);
    expect(() => temperature.getHandler?.()).toThrow(FakeHapStatusError);
    expect(temperature.value).toBeInstanceOf(FakeHapStatusError);
    h.platform.reportOutdoorTemperature('bedroom', status(-2.2), Date.now());
    expect(temperature.value).toBe(-2.2);
    expect(temperature.props.minValue).toBe(-100);
    expect(h.api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    h.events.shutdown();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('restores the same cached identity and Home app name, even with no source available', () => {
    const h = build();
    const cached = new FakeAccessory('AC Outdoor Temperature', 'samsung-rac:shared-outdoor');
    cached.context = { configuredName: 'Balcony', room: 'Outside' };
    h.platform.configureAccessory(cached as never);
    h.platform.reportOutdoorTemperature('office');
    expect(h.api.updatePlatformAccessories).toHaveBeenCalledWith([cached]);
    expect(h.api.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(cached.context.room).toBe('Outside');
    expect(cached.getService(Service.TemperatureSensor)!.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Balcony');
    h.events.shutdown();
  });

  it('publishes an unavailable sensor when configured to suppress off readings, then uses a running sibling', () => {
    const h = build(true);
    h.platform.reportOutdoorTemperature('office', status(18), Date.now());
    const accessory = h.api.registerPlatformAccessories.mock.calls[0][2][0] as FakeAccessory;
    const temperature = accessory.getService(Service.TemperatureSensor)!.getCharacteristic(Characteristic.CurrentTemperature);
    expect(() => temperature.getHandler?.()).toThrow(FakeHapStatusError);
    h.platform.reportOutdoorTemperature('bedroom', { ...status(18), active: true }, Date.now());
    expect(temperature.getHandler?.()).toBe(18);
    expect(h.api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    h.events.shutdown();
  });
});
