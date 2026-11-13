import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBuiltin } from 'node:module';
import { decodeUsageHistory, normaliseUsageRows, readUsageHistory } from '../../src/usageHistory';

describe('usage history', () => {
  const hasSqlite = isBuiltin('node:sqlite');
  (hasSqlite ? it : it.skip)('decodes an actual SQLite payload and keeps cumulative counters unscaled', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const directory = await mkdtemp(join(tmpdir(), 'rac-test-'));
    try {
      const path = join(directory, 'sample.db');
      const database = new DatabaseSync(path);
      database.exec('CREATE TABLE power_usage_table (date NUMERIC PRIMARY KEY, power_usage NUMERIC, running_time NUMERIC);'
        + 'INSERT INTO power_usage_table VALUES (2026110318, 0, 10065), (2026090819, 0, 10055), (2026110409, 0, 5);');
      database.close();
      const getText = jest.fn(async () => (await readFile(path)).toString('base64'));
      const history = await readUsageHistory({ getText });
      expect(getText).toHaveBeenCalledWith('/files/usage.db');
      expect(history.runtimeUnit).toBe('unknown');
      expect(history.energyAllZero).toBe(true);
      expect(history.records.map(row => row.counterIncrease)).toEqual([null, 10, null]);
      expect(history.records[1]).toMatchObject({ deviceTime: '2026-11-03 18:00', runningCounter: 10065 });
      expect(history.records[2].counterReset).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  (hasSqlite ? it.skip : it)('reports the optional SQLite requirement on unsupported Node versions', async () => {
    const header = Buffer.from('SQLite format 3\0').toString('base64');
    await expect(decodeUsageHistory(header)).rejects.toThrow('Usage history needs Node.js 22.13 or later');
  });

  it.each(['not base64', 'e30=', 'A'.repeat(6 * 1024 * 1024)])('rejects non-database or excessive data', async body => {
    await expect(decodeUsageHistory(body)).rejects.toThrow();
  });

  it.each([2026023012, 2026110424, 2026000100, 123])('rejects unsupported device dates: %s', date => {
    expect(() => normaliseUsageRows([{ date, power_usage: 0, running_time: 1 }])).toThrow();
  });

  it.each([-1, Number.MAX_SAFE_INTEGER + 1, '123', null])('rejects invalid counters: %s', running_time => {
    expect(() => normaliseUsageRows([{ date: 2026110409, power_usage: 0, running_time }])).toThrow();
  });
});
