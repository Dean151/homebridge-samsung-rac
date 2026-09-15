import { parseOptions, type RacDeviceDocument } from '../../src/racStatus';
import { LocalApi } from '../../src/transport/localApi';
import { restore, type Restore } from '../../src/cli/probe';

/**
 * A stand-in for the reference unit, with the one behaviour that makes putting
 * it back the hard part: **every write except power is accepted and discarded
 * while it is off** — 200, no error, no effect. Measured, not invented; see
 * notes/WRITE-SUPPORT.md.
 */
function fakeUnit(power: 'On' | 'Off') {
  const device: RacDeviceDocument = {
    id: '0',
    Operation: { power },
    Wind: { direction: 'Fix', speedLevel: 0, maxSpeedLevel: 4 },
    Mode: { modes: ['Cool'], supportedModes: ['Cool'], options: ['Comode_Off', 'Autoclean_Off'] },
    Temperatures: [{ id: '0', current: 23, desired: 24, minimum: 16, maximum: 30, unit: 'Celsius' }],
  };

  const discarded: unknown[] = [];

  const api = new LocalApi({
    host: '10.0.0.9',
    pem: Buffer.from('not-a-real-certificate'),
    token: 'test-token',
    transport: async (request) => {
      if (request.method === 'GET') {
        return { status: 200, headers: {}, body: JSON.stringify({ Devices: [device] }) };
      }

      const body = JSON.parse(request.body ?? '{}');

      if (body.Operation?.power) {
        device.Operation = { power: body.Operation.power };
      } else if (device.Operation?.power !== 'On') {
        discarded.push(body);
      } else if (body.Mode?.options) {
        const written = parseOptions(body.Mode.options as string[]);
        device.Mode!.options = (device.Mode!.options ?? []).map((option) => {
          const key = option.slice(0, option.lastIndexOf('_'));
          return written[key] === undefined ? option : `${key}_${written[key]}`;
        });
      } else if (body.Mode?.modes) {
        device.Mode!.modes = body.Mode.modes;
      } else if (body.Wind) {
        device.Wind = { ...device.Wind, ...body.Wind };
      } else if (body.Temperatures) {
        device.Temperatures = [{ ...device.Temperatures![0], desired: body.Temperatures[0].desired }];
      }

      return { status: 200, headers: {}, body: '' };
    },
  });

  return { api, device, discarded, snapshot: (): RacDeviceDocument => JSON.parse(JSON.stringify(device)) };
}

const comodeRestore = (value: string): Restore => ({
  label: 'Mode.options Comode',
  resource: '/devices/0/mode',
  body: { Mode: { options: [`Comode_${value}`] } },
  read: (device) => parseOptions(device.Mode?.options).Comode,
  want: value,
});

const comodeOf = (device: RacDeviceDocument) => parseOptions(device.Mode?.options).Comode;

describe('probe writes, restoring the unit', () => {
  beforeEach(() => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('powers the unit back on first, since the matrix ends by turning it off', async () => {
    // A unit that was ON when the run began is OFF by the time restore runs —
    // the last thing the matrix does is flip power. Reading the power state off
    // the original document said "it was on, no need", and every restore after
    // that was written to an off unit and silently discarded. Found against
    // real hardware: it left the reference unit sitting in Comode_Sleep.
    const unit = fakeUnit('On');
    const original = unit.snapshot();

    unit.device.Mode!.options = ['Comode_Sleep', 'Autoclean_On'];
    unit.device.Wind!.direction = 'Up_And_Low';
    unit.device.Operation = { power: 'Off' };

    await restore(unit.api, original, {
      settleMs: 0,
      powerOnMs: 0,
      extra: [comodeRestore('Off')],
    });

    expect(unit.discarded).toEqual([]);
    expect(comodeOf(unit.device)).toBe('Off');
    expect(unit.device.Wind?.direction).toBe('Fix');
    expect(unit.device.Operation?.power).toBe('On');
  });

  it('leaves a unit that was off when the run began switched off again', async () => {
    const unit = fakeUnit('Off');
    const original = unit.snapshot();

    // What --power-on and then the matrix's power attempt do between them.
    unit.device.Operation = { power: 'Off' };
    unit.device.Mode!.options = ['Comode_Quiet', 'Autoclean_Off'];

    await restore(unit.api, original, {
      settleMs: 0,
      powerOnMs: 0,
      extra: [comodeRestore('Off')],
    });

    expect(comodeOf(unit.device)).toBe('Off');
    expect(unit.device.Operation?.power).toBe('Off');
  });

  it('says so out loud when the unit will not take a value back', async () => {
    const unit = fakeUnit('On');
    const original = unit.snapshot();
    unit.device.Mode!.options = ['Comode_Sleep', 'Autoclean_Off'];

    await restore(unit.api, original, {
      settleMs: 0,
      powerOnMs: 0,
      // A value this fake unit has no entry for, so the write cannot land.
      extra: [{ ...comodeRestore('Off'), body: { Mode: { options: ['Nonsense_Off'] } } }],
    });

    const said = (process.stderr.write as jest.Mock).mock.calls.map((call) => String(call[0])).join('');
    expect(said).toContain('COULD NOT restore Mode.options Comode');
    expect(comodeOf(unit.device)).toBe('Sleep');
  });
});
