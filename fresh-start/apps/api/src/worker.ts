import 'reflect-metadata';
import { createApplication, type Application } from './app';
import { ConfigService } from './platform/config/config.service';
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
/**
 * Stands in for the database address while the graph is built: the real one is Hyperdrive's
 * connection string, which the runtime mints with random values and therefore forbids
 * outside a request ("Disallowed operation called within global scope"). It is read per
 * request, when a pool is made. Any non-default value passes the production config check.
 */
const DATABASE_URL_PLACEHOLDER = 'postgres://hyperdrive.internal/jobwork';

let ready: Promise<{ app: Application; pools: RequestPoolSource }> | undefined;
/** The bindings of the request being served; the same object for every request of an isolate. */
const current: { env?: WorkerEnv } = {};

async function build(): Promise<{ app: Application; pools: RequestPoolSource }> {
  process.env['DATABASE_URL'] = DATABASE_URL_PLACEHOLDER;
  // Pools are made per request, after the graph (and its config) exists, on Hyperdrive's
  // address for this isolate; the pool behind it is Hyperdrive's, not ours.
  const settings: { config?: ConfigService } = {};
  const pools = new RequestPoolSource(() =>
    createPool({ env: { ...settings.config!.env, DATABASE_URL: current.env!.HYPERDRIVE.connectionString } }),
  );
  const app = await createApplication({ poolSource: pools });
  settings.config = app.get(ConfigService);
  return { app, pools };
}

export default {
  /** Called at startup (`worker/entry.mjs`), so building the graph is not charged to a request. */
  start(): void {
    ready ??= build();
  },

  async fetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
    current.env = env;
    const { app, pools } = await (ready ??= build());
    return pools.run(
      () => app.handle(request, { remoteAddress: SERVICE_BINDING_PEER }),
      (ended) => ctx.waitUntil(ended),
    );
  },
};
