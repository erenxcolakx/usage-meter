// Claude's limits as the status line command saved them (statusLineSetup.ts).

import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseUsageLimits, type UsageLimits } from './core/index.ts';
import { METER_DIR, STATUS_FILE } from './statusLineSetup.ts';

export const meterDir = (home = os.homedir()): string => path.join(home, METER_DIR);
export const statusFile = (home = os.homedir()): string => path.join(meterDir(home), STATUS_FILE);

/** The saved report, dated by when the file was written; null when there is none or it is not readable. */
export async function readClaudeLimits(file = statusFile()): Promise<UsageLimits | null> {
  try {
    const [text, s] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return parseUsageLimits(JSON.parse(text), s.mtimeMs);
  } catch {
    return null;
  }
}
