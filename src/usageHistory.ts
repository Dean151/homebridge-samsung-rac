import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalApi } from './transport/localApi';

const maxDatabaseBytes = 4 * 1024 * 1024;
const maxRows = 50000;

export interface UsageRecord {
  deviceDate: number;
  /** Device clock, deliberately without an inferred timezone. */
  deviceTime: string;
  runningCounter: number;
  counterIncrease: number | null;
  counterReset: boolean;
  powerCounter: number;
}

export interface UsageHistory {
  fetchedAt: string;
  runtimeUnit: 'unknown';
  energyAllZero: boolean;
  records: UsageRecord[];
}

/** Observed YYYYMMDDHH keys. Reject impossible dates instead of normalising them. */
function deviceTime(value: number): string {
  const text = String(value);
  if (!/^\d{10}$/.test(text)) {
    throw new Error('Usage history contains an unsupported date format.');
  }
  const [year, month, day, hour] = [text.slice(0, 4), text.slice(4, 6), text.slice(6, 8), text.slice(8, 10)];
  const date = new Date(Date.UTC(+year, +month - 1, +day, +hour));
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1
    || date.getUTCDate() !== +day || date.getUTCHours() !== +hour) {
    throw new Error('Usage history contains an invalid device date.');
  }
  return `${year}-${month}-${day} ${hour}:00`;
}

function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Usage history contains an unsupported counter.');
  }
  return value;
}

/** These counters are cumulative. Never add them up or invent hours/kWh. */
export function normaliseUsageRows(rows: Record<string, unknown>[]): UsageRecord[] {
  let previous: number | undefined;
  return rows.map(row => {
    const date = counter(row.date);
    const running = counter(row.running_time);
    const reset = previous !== undefined && running < previous;
    const result: UsageRecord = {
      deviceDate: date,
      deviceTime: deviceTime(date),
      runningCounter: running,
      counterIncrease: previous === undefined || reset ? null : running - previous,
      counterReset: reset,
      powerCounter: counter(row.power_usage),
    };
    previous = running;
    return result;
  });
}

export async function decodeUsageHistory(body: string): Promise<UsageHistory> {
  const encoded = body.trim();
  if (encoded.length > Math.ceil(maxDatabaseBytes / 3) * 4 || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('The AC returned invalid or oversized usage history.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
    throw new Error('The AC did not return a SQLite usage database.');
  }

  // Loaded only for the optional UI action: Node 20 can still run AC controls.
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error('Usage history needs Node.js 22.13 or later with node:sqlite enabled.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'samsung-rac-history-'));
  let database: InstanceType<typeof sqlite.DatabaseSync> | undefined;
  try {
    const path = join(directory, 'usage.db');
    await writeFile(path, bytes, { mode: 0o600 });
    database = new sqlite.DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    const table = database.prepare('SELECT type FROM sqlite_master WHERE name = ?').get('power_usage_table');
    if (table?.type !== 'table') {
      throw new Error('The AC returned an unsupported usage database schema.');
    }
    const rows = database.prepare(
      `SELECT date, power_usage, running_time FROM power_usage_table ORDER BY date LIMIT ${maxRows + 1}`,
    ).all();
    if (rows.length > maxRows) {
      throw new Error('The AC returned too many usage records.');
    }
    const records = normaliseUsageRows(rows);
    return {
      fetchedAt: new Date().toISOString(),
      runtimeUnit: 'unknown',
      energyAllZero: records.length > 0 && records.every(record => record.powerCounter === 0),
      records,
    };
  } finally {
    try {
      database?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/** On demand only. This resource is never added to the status polling loop. */
export async function readUsageHistory(api: Pick<LocalApi, 'getText'>): Promise<UsageHistory> {
  return decodeUsageHistory(await api.getText('/files/usage.db'));
}
