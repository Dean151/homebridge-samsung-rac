import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { devicesFrom, parseOptions, RacDeviceDocument, RacDevicesResponse } from '../../src/racStatus';
import { buildMatrix, COMODE_CANDIDATES, optionShapes, type Attempt } from '../../src/cli/writeMatrix';

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'devices.json'), 'utf8'),
) as RacDevicesResponse;

const reference = devicesFrom(fixture)[0];

const optionAttempts = (device: RacDeviceDocument): Attempt[] =>
  buildMatrix(device).filter((candidate) => candidate.optionKey !== undefined);

describe('buildMatrix, Mode.options', () => {
  const attempts = optionAttempts(reference);

  it('probes every Comode name the firmware might know', () => {
    const requested = attempts
      .filter((candidate) => candidate.optionKey === 'Comode')
      .map((candidate) => candidate.requested);
    for (const value of COMODE_CANDIDATES) {
      expect(requested).toContain(value);
    }
  });

  it('tries every body shape, since none of them is documented', () => {
    const shapes = attempts
      .filter((candidate) => candidate.requested === 'WindFree')
      .map((candidate) => candidate.shape);
    expect(shapes).toEqual(optionShapes.map((shape) => shape.name));
  });

  it('writes to the mode resource with PUT, the only method this unit accepts', () => {
    for (const candidate of attempts) {
      expect(candidate.method).toBe('PUT');
      expect(candidate.resource).toBe('/devices/0/mode');
    }
  });

  it('skips a value the unit already holds, which could only read back unchanged', () => {
    // The reference unit publishes Autoclean_Off, so only On is worth asking for.
    const autoclean = attempts
      .filter((candidate) => candidate.optionKey === 'Autoclean')
      .map((candidate) => candidate.requested);
    expect(autoclean).toContain('On');
    expect(autoclean).not.toContain('Off');
  });

  it('asks a unit with the sleep timer off for a timer, and one with a timer for off', () => {
    const sleepValues = (device: RacDeviceDocument) =>
      optionAttempts(device)
        .filter((candidate) => candidate.optionKey === 'Sleep')
        .map((candidate) => candidate.requested);

    expect(sleepValues(reference)).toEqual(['30', '30', '30']);
    expect(sleepValues(withOptions(reference, ['Sleep_30']))).toEqual(['0', '0', '0']);
  });

  it('leaves out keys the unit does not publish', () => {
    const attempts = optionAttempts(withOptions(reference, ['Comode_Off']));
    expect(new Set(attempts.map((candidate) => candidate.optionKey))).toEqual(new Set(['Comode']));
  });

  it('reads its own answer back out of the options array', () => {
    const candidate = attempts.find((one) => one.optionKey === 'Comode')!;
    expect(candidate.read(withOptions(reference, ['Comode_WindFree']))).toBe('WindFree');
    expect(candidate.read(withOptions(reference, []))).toBeUndefined();
  });

  it('restores through the same shape that worked, not a fourth guess', () => {
    for (const candidate of attempts.filter((one) => one.optionKey === 'Autoclean')) {
      expect(candidate.restoreWith!('Off')).toEqual(
        optionShapes.find((shape) => shape.name === candidate.shape)!.body(reference, 'Autoclean', 'Off'),
      );
    }
  });

  it('keeps every other option intact in the whole-array shape', () => {
    const whole = optionShapes.find((shape) => shape.name === 'whole')!;
    const body = whole.body(reference, 'Comode', 'WindFree') as { Mode: { options: string[] } };
    const written = parseOptions(body.Mode.options);
    const before = parseOptions(reference.Mode?.options);

    expect(written.Comode).toBe('WindFree');
    expect({ ...written, Comode: 'Off' }).toEqual(before);
  });
});

describe('buildMatrix, ordering', () => {
  it('leaves power until last, since every other write is discarded while off', () => {
    const matrix = buildMatrix(reference);
    expect(matrix[matrix.length - 1].label).toBe('Operation.power = On');
  });

  it('probes the options while the unit is still in the state the rest left it', () => {
    const matrix = buildMatrix(reference);
    const firstOption = matrix.findIndex((candidate) => candidate.optionKey !== undefined);
    const power = matrix.findIndex((candidate) => candidate.label.startsWith('Operation.power'));
    expect(firstOption).toBeGreaterThan(0);
    expect(firstOption).toBeLessThan(power);
  });
});

function withOptions(device: RacDeviceDocument, options: string[]): RacDeviceDocument {
  return { ...device, Mode: { ...device.Mode, options } };
}
