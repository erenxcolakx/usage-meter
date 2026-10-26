import os from 'node:os';
import path from 'node:path';

export * from './usageLimits.ts';
export * from './codexUsage.ts';

/** Claude Code honours CLAUDE_CONFIG_DIR; otherwise it uses ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
}
