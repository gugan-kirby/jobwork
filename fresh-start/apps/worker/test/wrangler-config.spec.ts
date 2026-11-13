import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseWorkerConfig } from '../src/config';
import { due } from '../src/cron';

const MINUTE = 60_000;
const MINUTES_PER_DAY = 24 * 60;

/** The vars `jobwork-worker` is deployed with, as `process.env` carries them inside the Worker. */
function deployedVars(): Record<string, string> {
  const file = join(__dirname, '..', 'wrangler.jsonc');
  const { config, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  if (error) throw new Error(`wrangler.jsonc: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  return (config as { vars: Record<string, string> }).vars;
}

describe('jobwork-worker settings (F-CW.4, ADR-0009)', () => {
  it('asks for the SLA sweep at most once a quarter hour, inside Hyperdrive’s free 100,000 statements a day', () => {
    // One sweep is ~145 statements (27 queue syncs, each its own transaction): every
    // minute that is ~211,000 a day, which ran the free limit out by 17:00 IST (2026-11-13).
    const config = parseWorkerConfig({ ...deployedVars(), NODE_ENV: 'test' });
    let runs = 0;
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
      if (due(config.SLA_SWEEP_MS, minute * MINUTE)) runs += 1;
    }
    expect(runs).toBeLessThanOrEqual(96);
  });
});
