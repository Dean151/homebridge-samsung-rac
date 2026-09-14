import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Write a file without ever leaving a half-written one behind.
 *
 * Both callers here hold credentials that another process reads concurrently:
 * the plugin polls the token store while the custom UI may be rewriting it, and
 * a torn read would look exactly like "the token is gone". Write to a temp file
 * and rename, which is atomic within a filesystem.
 */
export async function writeFileAtomic(filePath: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(tmpPath, data, { mode });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/** Read a file, treating "not there" as a value rather than an error. */
export async function readFileOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
