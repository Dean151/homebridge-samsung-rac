#!/usr/bin/env node
/**
 * Command-line driver over the plugin's own transport modules.
 *
 * It answered the question this plugin was built around — does the hardware
 * apply writes, or accept and discard them the way the SmartThings cloud does? —
 * and stays as the tool to reach for when the plugin meets real hardware:
 *
 * - `dump` tells a parsing bug apart from a hardware difference when someone
 *   reports a model that behaves unlike the reference unit;
 * - `writes` establishes what a different model accepts, which matters because
 *   the accepted values ARE model-specific (this unit rejects `Vertical`
 *   outright while accepting `Up_And_Low`);
 * - `pair` is the way through when Homebridge runs in a container that the air
 *   conditioner's callback cannot reach.
 *
 * Shipped as a bin, so it is reachable from an ordinary install rather than only
 * from a checkout:
 *
 *   npx homebridge-samsung-rac-probe dump --host 172.24.0.125
 *
 * From a checkout, `npm run probe -- dump --host ...` runs it through ts-node.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CertificateStore } from '../transport/certificate';
import { LocalApi } from '../transport/localApi';
import { pairDevice } from '../transport/pairing';
import { TokenStore } from '../transport/tokenStore';
import { devicesFrom, RacDeviceDocument, RacDevicesResponse, toRacStatus } from '../racStatus';

interface Args {
  command: string;
  host?: string;
  storage: string;
  token?: string;
  powerOn: boolean;
  settleMs: number;
  out?: string;
}

/**
 * Flags may appear anywhere, before or after the command word, so a wrapper
 * script can pin an option without having to sit behind the user's arguments.
 */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'help',
    storage: process.env.HOMEBRIDGE_STORAGE_PATH ?? path.join(os.homedir(), '.homebridge'),
    powerOn: false,
    settleMs: 3000,
  };

  let sawCommand = false;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (!flag.startsWith('--')) {
      if (!sawCommand) {
        args.command = flag;
        sawCommand = true;
        continue;
      }
      throw new Error(`Unexpected argument ${flag}`);
    }

    switch (flag) {
    case '--host': args.host = value; index++; break;
    case '--storage': args.storage = value; index++; break;
    case '--token': args.token = value; index++; break;
    case '--out': args.out = value; index++; break;
    case '--settle': args.settleMs = Number(value); index++; break;
    case '--power-on': args.powerOn = true; break;
    default: throw new Error(`Unknown option ${flag}`);
    }
  }

  return args;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Progress and status, on stderr. stdout carries the payload alone — the device
 * document for `dump`, the report for `writes` — so either can be redirected
 * into a file or a bug report without the running commentary landing in it.
 */
function note(message = ''): void {
  process.stderr.write(`${message}\n`);
}

function requireHost(args: Args): string {
  if (!args.host) {
    throw new Error('--host <ip> is required.');
  }
  return args.host;
}

async function openApi(args: Args): Promise<LocalApi> {
  const host = requireHost(args);
  const pem = await new CertificateStore({ storagePath: args.storage }).load();
  const token = args.token ?? (await new TokenStore(args.storage).get(host))?.token;
  if (!token) {
    throw new Error(`No device token stored for ${host}. Run "npm run probe -- pair --host ${host}" first.`);
  }
  return new LocalApi({ host, pem, token, timeoutMs: 10000 });
}

async function readDevice(api: LocalApi): Promise<RacDeviceDocument> {
  const device = devicesFrom(await api.get<RacDevicesResponse>('/devices'))[0];
  if (!device) {
    throw new Error('The air conditioner reported no devices.');
  }
  return device;
}

// --- commands --------------------------------------------------------------

async function commandCert(args: Args): Promise<void> {
  const store = new CertificateStore({ storagePath: args.storage });
  await store.fetch();
  note(`Client certificate stored at ${store.path}`);
}

async function commandPair(args: Args): Promise<void> {
  const host = requireHost(args);
  const pem = await new CertificateStore({ storagePath: args.storage }).load();

  note('');
  note('  1. Power the air conditioner OFF now.');
  note('  2. Leave this running. When prompted, power it back ON.');
  note('');

  const result = await pairDevice({
    host,
    pem,
    onProgress: (progress) => note(`  [${progress.stage}] ${progress.message}`),
  });

  const store = new TokenStore(args.storage);
  await store.set(host, {
    token: result.token,
    deviceUuid: result.deviceUuid,
    model: result.model,
    name: result.name,
  });

  note('');
  note(`Paired with ${result.model ?? 'the air conditioner'} (${result.name ?? 'unnamed'}).`);
  note(`Token stored in ${store.path} — it is not printed here on purpose.`);
}

async function commandDump(args: Args): Promise<void> {
  const api = await openApi(args);
  try {
    const raw = await api.get<RacDevicesResponse>('/devices');
    // The device document is the payload: `dump > unit.json` should produce
    // valid JSON, which is exactly what a bug report about an unfamiliar model
    // needs. The parsed view is a convenience, so it goes to stderr.
    console.log(JSON.stringify(raw, null, 2));
    note('');
    note('Parsed:');
    note(JSON.stringify(toRacStatus(devicesFrom(raw)[0]), null, 2));
  } finally {
    api.close();
  }
}

// --- the write matrix ------------------------------------------------------

interface Attempt {
  label: string;
  resource: string;
  method: string;
  body: unknown;
  requested: unknown;
  read: (device: RacDeviceDocument) => unknown;
}

interface AttemptResult extends Attempt {
  before: unknown;
  after: unknown;
  status: 'APPLIED' | 'IGNORED' | 'ERROR';
  detail?: string;
}

/**
 * HTTP 200 proves nothing on this hardware — the SmartThings cloud returns
 * COMPLETED for commands the unit silently discards, and the local API may well
 * do the same. Only a CHANGED READ-BACK counts as success.
 */
async function attempt(api: LocalApi, candidate: Attempt, settleMs: number): Promise<AttemptResult> {
  const before = candidate.read(await readDevice(api));

  let detail: string | undefined;
  try {
    await api.send(candidate.method, candidate.resource, candidate.body);
  } catch (error) {
    detail = (error as Error).message;
  }

  await sleep(settleMs);
  const after = candidate.read(await readDevice(api));

  const applied = JSON.stringify(after) === JSON.stringify(candidate.requested)
    && JSON.stringify(after) !== JSON.stringify(before);

  return {
    ...candidate,
    before,
    after,
    status: applied ? 'APPLIED' : detail ? 'ERROR' : 'IGNORED',
    detail,
  };
}

function buildMatrix(device: RacDeviceDocument): Attempt[] {
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

  const otherMode = (device.Mode?.supportedModes ?? []).find((mode) => mode !== device.Mode?.modes?.[0]);
  if (otherMode) {
    attempts.push({
      label: `Mode.modes = [${otherMode}]`,
      resource: `/devices/${id}/mode`,
      method: 'PUT',
      body: { Mode: { modes: [otherMode] } },
      requested: otherMode,
      read: (d) => d.Mode?.modes?.[0],
    });
  }

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

async function restore(api: LocalApi, original: RacDeviceDocument, settleMs: number): Promise<void> {
  const id = original.id ?? '0';
  const restores: { label: string; resource: string; body: unknown; read: (d: RacDeviceDocument) => unknown; want: unknown }[] = [];

  if (original.Wind?.direction) {
    restores.push({
      label: 'Wind.direction',
      resource: `/devices/${id}/wind`,
      body: { Wind: { direction: original.Wind.direction } },
      read: (d) => d.Wind?.direction,
      want: original.Wind.direction,
    });
  }
  if (Number.isFinite(original.Wind?.speedLevel)) {
    restores.push({
      label: 'Wind.speedLevel',
      resource: `/devices/${id}/wind`,
      body: { Wind: { speedLevel: original.Wind!.speedLevel } },
      read: (d) => d.Wind?.speedLevel,
      want: original.Wind!.speedLevel,
    });
  }
  if (Number.isFinite(original.Temperatures?.[0]?.desired)) {
    const temperature = original.Temperatures![0];
    restores.push({
      label: 'Temperatures[0].desired',
      resource: `/devices/${id}/temperatures/${temperature.id ?? '0'}`,
      body: { Temperatures: [{ id: temperature.id ?? '0', desired: temperature.desired }] },
      read: (d) => d.Temperatures?.[0]?.desired,
      want: temperature.desired,
    });
  }
  if (original.Mode?.modes?.[0]) {
    restores.push({
      label: 'Mode.modes',
      resource: `/devices/${id}/mode`,
      body: { Mode: { modes: original.Mode.modes } },
      read: (d) => d.Mode?.modes?.[0],
      want: original.Mode.modes[0],
    });
  }

  note('');
  note('Restoring original values...');

  // The unit silently discards every write except power while it is off, so a
  // restore that runs after the power-probe turned it off achieves nothing.
  // Power it on, restore, and put the power back last.
  const wasOff = original.Operation?.power !== 'On';
  if (restores.length && wasOff) {
    note('  powering on so the restores are not discarded');
    await api.send('PUT', `/devices/${id}/operation`, { Operation: { power: 'On' } });
    await sleep(5000);
  }

  for (const item of restores) {
    try {
      await api.send('PUT', item.resource, item.body);
      await sleep(settleMs);
      const actual = item.read(await readDevice(api));
      note(
        JSON.stringify(actual) === JSON.stringify(item.want)
          ? `  restored ${item.label}`
          : `  COULD NOT restore ${item.label}: wanted ${JSON.stringify(item.want)}, reads ${JSON.stringify(actual)}`,
      );
    } catch (error) {
      note(`  could not restore ${item.label}: ${(error as Error).message}`);
    }
  }

  if (original.Operation?.power) {
    await api.send('PUT', `/devices/${id}/operation`, { Operation: { power: original.Operation.power } });
    await sleep(settleMs);
    const actual = (await readDevice(api)).Operation?.power;
    note(
      actual === original.Operation.power
        ? `  restored Operation.power to ${actual}`
        : `  COULD NOT restore Operation.power: wanted ${original.Operation.power}, reads ${actual}`,
    );
  }
}

async function commandWrites(args: Args): Promise<void> {
  const api = await openApi(args);
  try {
    const original = await readDevice(api);

    if (args.powerOn && original.Operation?.power !== 'On') {
      note('Powering the unit on first (--power-on)...');
      await api.send('PUT', `/devices/${original.id ?? '0'}/operation`, { Operation: { power: 'On' } });
      await sleep(5000);
    }

    const matrix = buildMatrix(await readDevice(api));
    const results: AttemptResult[] = [];
    const settled = new Set<string>();

    for (const candidate of matrix) {
      // Once one body shape works for a field, the remaining shapes for the
      // same target value tell us nothing new.
      if (settled.has(candidate.label.split(' (')[0])) {
        continue;
      }
      const result = await attempt(api, candidate, args.settleMs);
      results.push(result);
      note(
        `  ${result.status.padEnd(8)} ${result.label}  (${JSON.stringify(result.before)} -> ${JSON.stringify(result.after)})`
        + (result.detail ? `  ${result.detail}` : ''),
      );
      if (result.status === 'APPLIED') {
        settled.add(candidate.label.split(' (')[0]);
      }
    }

    await restore(api, original, args.settleMs);

    const applied = results.filter((result) => result.status === 'APPLIED');
    const report = [
      '# Local API write support',
      '',
      `Probed ${new Date().toISOString()} against ${original.description ?? 'unknown model'} at ${args.host}.`,
      `Unit was powered ${original.Operation?.power ?? 'unknown'} at the start`        + (args.powerOn ? ', and powered on for the probe (--power-on).' : ' and left that way.'),
      '',
      'This unit silently discards every write except power while it is off, so a run',
      'without --power-on says nothing about whether a field is writable.',
      '',
      'Only a **changed read-back** counts as APPLIED — this hardware returns success for',
      'commands it discards, so a 200 response is not evidence of anything.',
      '',
      '| Result | Field | Method | Body | Before | After |',
      '|---|---|---|---|---|---|',
      ...results.map((result) =>
        `| ${result.status} | ${result.label} | ${result.method} | \`${JSON.stringify(result.body)}\` `
        + `| ${JSON.stringify(result.before)} | ${JSON.stringify(result.after)} |`),
      '',
      applied.length
        ? `${applied.length} of ${results.length} attempts were applied.`
        : 'No write was applied.',
    ].join('\n');

    if (args.out) {
      await fs.writeFile(args.out, `${report}\n`, 'utf8');
      note('');
      note(`Report written to ${args.out}`);
    } else {
      // stdout, so `writes ... > report.md` works and nothing is written to the
      // user's working directory uninvited.
      note('');
      console.log(report);
    }
    if (!applied.length && !args.powerOn) {
      note('');
      note('Nothing applied, but every write except power is discarded while the unit is off.');
      note('Retry with it running before concluding anything:');
      note(`  homebridge-samsung-rac-probe writes --host ${args.host} --power-on`);
    }
  } finally {
    api.close();
  }
}

// --- entry point -----------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
  case 'cert': return commandCert(args);
  case 'pair': return commandPair(args);
  case 'dump': return commandDump(args);
  case 'writes': return commandWrites(args);
  default:
    note('Usage: homebridge-samsung-rac-probe <cert|pair|dump|writes> [options]');
    note('');
    note('  cert                    download the Samsung client certificate');
    note('  pair    --host <ip>     run the token pairing ritual');
    note('  dump    --host <ip>     print the raw and parsed device state');
    note('  writes  --host <ip>     check which writes the unit honours');
    note('');
    note('  --storage <path>        Homebridge storage path (default ~/.homebridge)');
    note('  --token <token>         use this token instead of the stored one');
    note('  --power-on              power the unit on first; writes are');
    note('                          discarded while it is off, so `writes`');
    note('                          says nothing without this');
    note('  --out <path>            save the report here instead of printing it');
    note('');
    note('Progress goes to stderr and the payload to stdout, so `dump > unit.json`');
    note('and `writes --host <ip> --power-on > report.md` both give clean files.');
    process.exitCode = args.command === 'help' ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
