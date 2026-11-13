import { SharedOutdoorTemperature } from '../../src/sharedOutdoorTemperature';
import type { RacStatus } from '../../src/racStatus';

const status = (outdoorTemperature: number | undefined, active = false) =>
  ({ outdoorTemperature, active, connected: true }) as RacStatus;

describe('one outdoor sensor for a multisplit', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(100000); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('uses one source without averaging, prefers a running unit and falls back on loss', () => {
    const sensor = new SharedOutdoorTemperature(60000, false, jest.fn());
    sensor.update('office', status(18), Date.now());
    sensor.update('bedroom', status(19), Date.now());
    expect(sensor.current()).toMatchObject({ source: 'office', temperature: 18 });
    sensor.update('bedroom', status(19, true), Date.now());
    expect(sensor.current()).toMatchObject({ source: 'bedroom', temperature: 19 });
    sensor.update('bedroom');
    expect(sensor.current()).toMatchObject({ source: 'office', temperature: 18 });
    sensor.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('expires stale copies even if the adapter keeps returning a cached status', () => {
    const changed = jest.fn();
    const sensor = new SharedOutdoorTemperature(60000, false, changed);
    const observed = Date.now();
    sensor.update('office', status(18), observed);
    jest.advanceTimersByTime(30000);
    sensor.update('bedroom', status(18), Date.now());
    sensor.update('office', status(18), observed);
    jest.advanceTimersByTime(30000);
    expect(sensor.current()?.source).toBe('bedroom');
    const calls = changed.mock.calls.length;
    jest.advanceTimersByTime(30000);
    expect(sensor.current()).toBeUndefined();
    expect(changed.mock.calls.length).toBeGreaterThan(calls);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('can suppress all-off readings without suppressing a running sibling', () => {
    const sensor = new SharedOutdoorTemperature(60000, true, jest.fn());
    sensor.update('office', status(18), Date.now());
    expect(sensor.current()).toBeUndefined();
    sensor.update('bedroom', status(18, true), Date.now());
    expect(sensor.current()?.temperature).toBe(18);
    sensor.update('bedroom', status(18), Date.now());
    expect(sensor.current()).toBeUndefined();
  });

  it('accepts subzero temperatures and rejects missing, disconnected or invalid readings', () => {
    const sensor = new SharedOutdoorTemperature(60000, false, jest.fn());
    sensor.update('office', status(-12.2), Date.now());
    expect(sensor.current()?.temperature).toBe(-12.2);
    sensor.update('office', { ...status(22), connected: false }, Date.now());
    expect(sensor.current()).toBeUndefined();
    for (const value of [NaN, Infinity, undefined, -101, 101]) {
      sensor.update('office', status(value), Date.now());
      expect(sensor.current()).toBeUndefined();
    }
  });
});
