/**
 * What `probe writes` tries, and the rules for deciding what is worth trying.
 *
 * Separate from the CLI driver because the rules are the interesting part —
 * which values a given unit is even asked about depends on what it published,
 * and getting that wrong means a probe run that proves nothing. Exported and
 * unit-tested against the reference capture in tests/fixtures/devices.json.
 */

import { parseOptions, type RacDeviceDocument } from '../racStatus';

export interface Attempt {
  label: string;
  resource: string;
  method: string;
  body: unknown;
  requested: unknown;
  read: (device: RacDeviceDocument) => unknown;
  /**
   * Set on `Mode.options` attempts only. The body shape for these is a guess —
   * see `optionShapes` — so the ones that share a shape are grouped by it: once
   * one shape is known to work, the others stop being tried.
   */
  optionKey?: string;
  shape?: string;
  /** How to put this key back, using the shape this attempt used. */
  restoreWith?: (value: string) => unknown;
}

/**
 * `Mode.options` is published as a flat array of `Key_Value` strings and no
 * documentation says how to write one back, so all three plausible shapes are
 * tried. The first is the document's own shape, narrowed to the one entry
 * being changed; the last echoes the whole array with a single entry replaced,
 * which is the safest of the three to send — every other value in it is one the
 * unit itself just reported — but the slowest to be sure of.
 */
export interface OptionShape {
  name: string;
  body: (device: RacDeviceDocument, key: string, value: string) => unknown;
}

export const optionShapes: OptionShape[] = [
  {
    name: 'single',
    body: (_device, key, value) => ({ Mode: { options: [`${key}_${value}`] } }),
  },
  {
    name: 'flat',
    body: (_device, key, value) => ({ options: [`${key}_${value}`] }),
  },
  {
    name: 'whole',
    body: (device, key, value) => ({
      Mode: {
        options: (device.Mode?.options ?? []).map((option) =>
          option.startsWith(`${key}_`) ? `${key}_${value}` : option),
      },
    }),
  },
];

/**
 * Names to try for `Comode` — the convenience mode, which on this generation is
 * where WindFree lives. The firmware publishes no vocabulary for it and the
 * reference unit only ever reports `Off`, so these are the names Samsung's own
 * apps use for the feature, tried one at a time.
 *
 * A rejection is a real answer here, not a failed attempt: `Vertical` and
 * `SwingUD` were ruled out for the vane exactly this way. A `400` means the
 * firmware does not know the name; a `200` with an unchanged read-back means it
 * took the write and discarded it, which is this hardware's habit.
 */
export const COMODE_CANDIDATES = [
  'WindFree',
  'Comfort',
  'Quiet',
  'Speed',
  'Smart',
  'SoftCool',
  '2Step',
  'Sleep',
];

/** The `Mode.options` keys worth writing to, and what to try for each. */
function optionCandidates(options: Record<string, string>): { key: string; values: string[] }[] {
  const candidates: { key: string; values: string[] }[] = [];

  if (options.Comode !== undefined) {
    candidates.push({ key: 'Comode', values: COMODE_CANDIDATES });
  }
  if (options.Autoclean !== undefined) {
    candidates.push({ key: 'Autoclean', values: ['On', 'Off'] });
  }
  // Read as a sleep timer in minutes, on the strength of `Sleep_0` meaning off.
  // Whether it is minutes at all is precisely what the probe is for; a unit that
  // applies 30 and then powers itself off half an hour later has answered.
  if (options.Sleep !== undefined) {
    candidates.push({ key: 'Sleep', values: [options.Sleep === '0' ? '30' : '0'] });
  }

  return candidates;
}

function optionAttempts(device: RacDeviceDocument, id: string): Attempt[] {
  const options = parseOptions(device.Mode?.options);
  const attempts: Attempt[] = [];

  for (const { key, values } of optionCandidates(options)) {
    for (const value of values) {
      // Writing the value it already holds cannot produce a changed read-back,
      // so it could only ever be recorded as IGNORED — a false negative.
      if (options[key] === value) {
        continue;
      }
      for (const shape of optionShapes) {
        attempts.push({
          label: `Mode.options ${key} = ${value} (${shape.name}, PUT)`,
          resource: `/devices/${id}/mode`,
          method: 'PUT',
          body: shape.body(device, key, value),
          requested: value,
          read: (d) => parseOptions(d.Mode?.options)[key],
          optionKey: key,
          shape: shape.name,
          restoreWith: (original) => shape.body(device, key, original),
        });
      }
    }
  }

  return attempts;
}

export function buildMatrix(device: RacDeviceDocument): Attempt[] {
  const id = device.id ?? '0';
  const attempts: Attempt[] = [];

  const windDirection = (value: string) => {
    for (const [shape, body] of [
      ['nested', { Wind: { direction: value } }],
      ['flat', { direction: value }],
    ] as const) {
      for (const method of ['PUT', 'POST']) {
        attempts.push({
          label: `Wind.direction = ${value} (${shape}, ${method})`,
          resource: `/devices/${id}/wind`,
          method,
          body,
          requested: value,
          read: (d) => d.Wind?.direction,
        });
      }
    }
  };

  // The headline feature. The Samsung app offers only Vertical/Fixe on this
  // unit, but the OCF vendor extension documents four values, so try them all.
  for (const value of ['Up_And_Low', 'Vertical', 'SwingUD', 'All']) {
    windDirection(value);
  }

  const maxSpeed = device.Wind?.maxSpeedLevel ?? 0;
  if (maxSpeed > 0) {
    const current = device.Wind?.speedLevel ?? 0;
    const next = current === maxSpeed ? Math.max(0, maxSpeed - 1) : current + 1;
    attempts.push({
      label: `Wind.speedLevel = ${next}`,
      resource: `/devices/${id}/wind`,
      method: 'PUT',
      body: { Wind: { speedLevel: next } },
      requested: next,
      read: (d) => d.Wind?.speedLevel,
    });
  }

  const temperature = device.Temperatures?.[0];
  if (Number.isFinite(temperature?.desired)) {
    const desired = temperature!.desired!;
    const next = desired >= (temperature!.maximum ?? 30) ? desired - 1 : desired + 1;
    for (const [shape, body] of [
      ['nested', { Temperatures: [{ id: temperature!.id ?? '0', desired: next }] }],
      ['flat', { desired: next }],
    ] as const) {
      attempts.push({
        label: `Temperatures[0].desired = ${next} (${shape})`,
        resource: `/devices/${id}/temperatures/${temperature!.id ?? '0'}`,
        method: 'PUT',
        body,
        requested: next,
        read: (d) => d.Temperatures?.[0]?.desired,
      });
    }
  }

  const current = device.Mode?.modes?.[0];
  const advertised = device.Mode?.supportedModes ?? [];
  const otherMode = advertised.find((mode) => mode !== current);

  // 'Heat' is tried even when the unit does not advertise it. The reference
  // unit omits Heat from supportedModes while sitting in Heat and accepting a
  // write of it, so the advertised list is a floor — the only way to find an
  // unadvertised mode is to ask for it. See notes/HANDOFF.md.
  const unadvertised = advertised.some((mode) => mode.toLowerCase() === 'heat') ? [] : ['Heat'];

  for (const mode of [otherMode, ...unadvertised]) {
    if (!mode || mode === current) {
      continue;
    }
    attempts.push({
      label: `Mode.modes = [${mode}]${unadvertised.includes(mode) ? ' (not advertised)' : ''}`,
      resource: `/devices/${id}/mode`,
      method: 'PUT',
      body: { Mode: { modes: [mode] } },
      requested: mode,
      read: (d) => d.Mode?.modes?.[0],
    });
  }

  attempts.push(...optionAttempts(device, id));

  // Power last: it is the one field this unit honours while off, and flipping it
  // earlier would have every attempt after it written to a unit that is off and
  // discarding everything.
  const power = device.Operation?.power === 'On' ? 'Off' : 'On';
  attempts.push({
    label: `Operation.power = ${power}`,
    resource: `/devices/${id}/operation`,
    method: 'PUT',
    body: { Operation: { power } },
    requested: power,
    read: (d) => d.Operation?.power,
  });

  return attempts;
}
