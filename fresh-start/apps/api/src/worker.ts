import 'reflect-metadata';
import { createApplication, type Application } from './app';
import type { ConfigService } from './platform/config/config.service';
import { ConfigService as ConfigToken } from './platform/config/config.service';
import { createPool } from './platform/database/database.service';
import { RequestPoolSource } from './platform/database/pool-source';

/** The bindings `wrangler.jsonc` declares; vars and secrets arrive in `process.env`. */
export interface WorkerEnv {
  HYPERDRIVE: { connectionString: string };
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The API as a Cloudflare Worker (F-CW.3, ADR-0009). It has no public address
 * (`workers_dev: false`): the web Workers and the cron Worker reach it through service
 * bindings, the way the web apps' rewrite proxy reached it on loopback before. Each
 * caller names the browser in `X-Forwarded-For`, so the peer is a trusted loopback hop.
 */
const SERVICE_BINDING_PEER = '127.0.0.1';

let ready: Promise<{ app: Application; pools: RequestPoolSource }> | undefined;

async function build(env: WorkerEnv): Promise<{ app: Application; pools: RequestPoolSource }> {
  // Hyperdrive's address for this isolate; the pool behind it is Hyperdrive's, not ours.
  process.env['DATABASE_URL'] = env.HYPERDRIVE.connectionString;
  let config: ConfigService | undefined;
  const pools = new RequestPoolSource(() => createPool(config!));
  const app = await createApplication({ poolSource: pools });
  config = app.get(ConfigToken);
  return { app, pools };
}

export default {
  /** Called at startup (`worker/entry.mjs`), so building the graph is not charged to a request. */
  start(env: WorkerEnv): void {
    ready ??= build(env);
  },

  async fetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
    const { app, pools } = await (ready ??= build(env));
    return pools.run(
      () => app.handle(request, { remoteAddress: SERVICE_BINDING_PEER }),
      (ended) => ctx.waitUntil(ended),
    );
  },
};
