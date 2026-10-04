import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as dotenv } from 'dotenv';

/** Loads ../../.env (repo root) in non-production only. Production uses real environment (DO-16). */
export function loadEnv(): void {
  if (process.env['NODE_ENV'] === 'production') return;
  for (const candidate of [
    join(process.cwd(), '.env'),
    join(process.cwd(), '..', '..', '.env'),
  ]) {
    if (existsSync(candidate)) {
      dotenv({ path: candidate });
      return;
    }
  }
}
