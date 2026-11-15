import { ShutdownTimer, shutdownGraceMs } from '../../src/shutdownTimer';

function build() {
  const changed = jest.fn();
  const turnOff = jest.fn(async (_stillCurrent: () => boolean) => true);
  const warn = jest.fn();
  const timer = new ShutdownTimer({ durations: [1, 30, 60, 120], changed, turnOff, warn });
  return { timer, changed, turnOff, warn };
}

describe('persisted shutoff countdown', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-11-04T10:00:00Z')); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('persists a deadline and confirms off exactly once at expiry', async () => {
    const h = build();
    h.timer.arm(30);
    expect(h.changed).toHaveBeenCalledWith({ minutes: 30, deadline: Date.now() + 1800000 });
    await jest.advanceTimersByTimeAsync(1799999);
    expect(h.turnOff).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.turnOff).toHaveBeenCalledTimes(1);
    expect(h.timer.state).toBeNull();
    expect(h.changed).toHaveBeenLastCalledWith(null);
  });

  it('replaces a countdown and cancellation never powers off', async () => {
    const h = build();
    h.timer.arm(30);
    await jest.advanceTimersByTimeAsync(60000);
    h.timer.arm(60);
    await jest.advanceTimersByTimeAsync(1800000);
    expect(h.turnOff).not.toHaveBeenCalled();
    expect(h.timer.state?.minutes).toBe(60);
    h.timer.cancel();
    await jest.advanceTimersByTimeAsync(7200000);
    expect(h.turnOff).not.toHaveBeenCalled();
  });

  it('resumes the original deadline after shutdown without restarting the countdown', async () => {
    const first = build();
    first.timer.arm(30);
    const saved = { ...first.timer.state };
    first.timer.stop();
    await jest.advanceTimersByTimeAsync(600000);
    const second = build();
    second.timer.restore(saved, true);
    await jest.advanceTimersByTimeAsync(1199999);
    expect(first.turnOff).not.toHaveBeenCalled();
    expect(second.turnOff).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(second.turnOff).toHaveBeenCalledTimes(1);
  });

  it('executes a recently overdue countdown but discards a stale one', async () => {
    const recent = build();
    recent.timer.restore({ minutes: 30, deadline: Date.now() - 10000 }, true);
    await jest.advanceTimersByTimeAsync(0);
    expect(recent.turnOff).toHaveBeenCalledTimes(1);
    const old = build();
    old.timer.restore({ minutes: 30, deadline: Date.now() - shutdownGraceMs }, true);
    await jest.advanceTimersByTimeAsync(0);
    expect(old.turnOff).not.toHaveBeenCalled();
    expect(old.changed).toHaveBeenCalledWith(null);
  });

  it.each([null, {}, { minutes: 0, deadline: 123 }, { minutes: 45, deadline: 123 },
    { minutes: 30, deadline: Number.NaN }, { minutes: 30, deadline: Number.MAX_SAFE_INTEGER }])(
    'does not execute malformed or no longer configured state: %j', async state => {
      const h = build();
      h.timer.restore(state, true);
      await jest.advanceTimersByTimeAsync(0);
      expect(h.timer.state).toBeNull();
      expect(h.turnOff).not.toHaveBeenCalled();
    });

  it('discards a countdown for an off AC, but retains one during an unknown/offline startup', () => {
    const state = { minutes: 30, deadline: Date.now() + 60000 };
    const off = build();
    off.timer.restore(state, false);
    expect(off.timer.state).toBeNull();
    const offline = build();
    offline.timer.restore(state, undefined);
    expect(offline.timer.state).toEqual(state);
  });

  it('bounds failed expiry retries and reports failure once before giving up', async () => {
    const h = build();
    h.turnOff.mockRejectedValue(new Error('AC offline'));
    h.timer.arm(1);
    await jest.advanceTimersByTimeAsync(60000 + shutdownGraceMs + 60000);
    expect(h.turnOff).toHaveBeenCalledTimes(10);
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(h.timer.state).toBeNull();
  });

  it('does not let an outstanding expiry cancel a replacement countdown', async () => {
    const h = build();
    let finish!: (value: boolean) => void;
    h.turnOff.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    h.timer.arm(1);
    await jest.advanceTimersByTimeAsync(60000);
    const stillCurrent = h.turnOff.mock.calls[0][0];
    h.timer.arm(30);
    expect(stillCurrent()).toBe(false);
    finish(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(h.timer.state?.minutes).toBe(30);
  });

  it('allows an expiry callback to detect cancellation while awaiting a fresh read', async () => {
    const h = build();
    let finish!: (value: boolean) => void;
    h.turnOff.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    h.timer.arm(1);
    await jest.advanceTimersByTimeAsync(60000);
    h.timer.cancel();
    expect(h.turnOff.mock.calls[0][0]()).toBe(false);
    finish(false);
    await jest.advanceTimersByTimeAsync(shutdownGraceMs);
    expect(h.turnOff).toHaveBeenCalledTimes(1);
  });
});
