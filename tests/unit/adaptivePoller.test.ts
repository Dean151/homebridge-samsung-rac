import { AdaptivePoller, controlFingerprint } from '../../src/adaptivePoller';
import type { RacStatus } from '../../src/racStatus';

describe('adaptive polling', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1000000); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('uses the normal interval, then two seconds for thirty seconds after activity', async () => {
    const poll = jest.fn(async () => true);
    const scheduler = new AdaptivePoller(5000, true, poll);
    scheduler.start();
    await jest.advanceTimersByTimeAsync(4999);
    expect(poll).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(1);
    scheduler.activity();
    await jest.advanceTimersByTimeAsync(30000);
    expect(poll).toHaveBeenCalledTimes(16);
    await jest.advanceTimersByTimeAsync(4999);
    expect(poll).toHaveBeenCalledTimes(16);
    await jest.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(17);
    scheduler.stop();
  });

  it('does not overlap a slow poll or queue catch-up polls, and stops during an in-flight read', async () => {
    let resolve!: (healthy: boolean) => void;
    const poll = jest.fn(() => new Promise<boolean>(r => { resolve = r; }));
    const scheduler = new AdaptivePoller(5000, true, poll);
    scheduler.start();
    await jest.advanceTimersByTimeAsync(5000);
    scheduler.activity();
    await jest.advanceTimersByTimeAsync(60000);
    expect(poll).toHaveBeenCalledTimes(1);
    scheduler.stop();
    resolve(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('backs off failed reads through 10, 20, 40 and 60 seconds, then recovers', async () => {
    const times: number[] = [];
    const poll = jest.fn(async () => { times.push(Date.now() - 1000000); return times.length >= 5; });
    const scheduler = new AdaptivePoller(5000, true, poll);
    scheduler.start();
    await jest.advanceTimersByTimeAsync(140000);
    expect(times).toEqual([5000, 15000, 35000, 75000, 135000, 140000]);
    scheduler.stop();
  });

  it('handles a rejected poll without leaving an unhandled rejection or fast retry loop', async () => {
    const poll = jest.fn(async () => { throw Error('offline'); });
    const scheduler = new AdaptivePoller(5000, true, poll);
    scheduler.start();
    await jest.advanceTimersByTimeAsync(15000);
    expect(poll).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('starts with backoff after a failed initial read; successful commands can resume fast polling', async () => {
    const poll = jest.fn(async () => true);
    const scheduler = new AdaptivePoller(5000, true, poll);
    scheduler.start(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(poll).not.toHaveBeenCalled();
    scheduler.activity();
    await jest.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('keeps fixed scheduling when the adaptive option is disabled', async () => {
    const poll = jest.fn(async () => false);
    const scheduler = new AdaptivePoller(10000, false, poll);
    scheduler.start();
    scheduler.activity();
    await jest.advanceTimersByTimeAsync(30000);
    expect(poll).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it('tracks remote control changes but ignores temperatures and counters', () => {
    const state = { active: false, mode: 'Cool', targetTemperature: 24, speedLevel: 0,
      windDirection: 'Fix', comode: 'Off', options: { Spi: 'Off', Autoclean: 'Off', FilterTime: '20' },
      currentTemperature: 20 } as unknown as RacStatus;
    const key = controlFingerprint(state);
    expect(controlFingerprint({ ...state, currentTemperature: 21, options: { ...state.options, FilterTime: '21' } })).toBe(key);
    for (const update of [{ active: true }, { targetTemperature: 25 }, { mode: 'Wind' }, { speedLevel: 2 },
      { windDirection: 'All' }, { comode: 'Quiet' }, { options: { ...state.options, Spi: 'On' } },
      { options: { ...state.options, Autoclean: 'On' } }, { options: { ...state.options, Sleep: '4' } }]) {
      expect(controlFingerprint({ ...state, ...update })).not.toBe(key);
    }
  });
});
