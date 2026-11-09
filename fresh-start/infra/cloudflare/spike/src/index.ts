import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { Client } from 'pg';
import { ObjectStoreClient } from '@jobwork/object-store';

/**
 * F-CW.0: answers whether a Worker on the free plan can reach Supabase Postgres through
 * Hyperdrive, hash a password inside Postgres, and drive Supabase Storage with the same
 * SigV4 client the API uses. CPU per invocation is read from Workers Logs (`cpuTimeMs`).
 */
interface Env {
  DB: { connectionString: string };
  SPIKE_TOKEN: string;
  OBJECT_STORE_ENDPOINT: string;
  OBJECT_STORE_REGION: string;
  OBJECT_STORE_ACCESS_KEY: string;
  OBJECT_STORE_SECRET_KEY: string;
  OBJECT_STORE_BUCKET_QUARANTINE: string;
  OBJECT_STORE_BUCKET_CLEAN: string;
}

type AppContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

// The URL is public; only the owner may spend the account's daily quota.
app.use('*', async (c, next) => {
  if (c.req.header('authorization') !== `Bearer ${c.env.SPIKE_TOKEN}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

/** One connection per request: Workers cannot share sockets across requests; Hyperdrive pools. */
async function withClient<T>(c: AppContext, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: c.env.DB.connectionString });
  await client.connect();
  try {
    return await run(client);
  } finally {
    c.executionCtx.waitUntil(client.end());
  }
}

app.get('/db', async (c) => {
  const started = Date.now();
  const row = await withClient(c, async (client) => {
    const result = await client.query<{ now: string; version: string }>(
      'select now()::text as now, version() as version',
    );
    return result.rows[0];
  });
  return c.json({ ok: true, wallMs: Date.now() - started, ...row });
});

app.post('/hash', async (c) => {
  const { password } = await c.req.json<{ password: string }>();
  const started = Date.now();
  const result = await withClient(c, async (client) => {
    const hashed = await client.query<{ hash: string }>(
      "select extensions.crypt($1, extensions.gen_salt('bf', 10)) as hash",
      [password],
    );
    const hash = hashed.rows[0]!.hash;
    const verified = await client.query<{ ok: boolean }>(
      'select extensions.crypt($1, $2) = $2 as ok',
      [password, hash],
    );
    const refused = await client.query<{ ok: boolean }>(
      'select extensions.crypt($1, $2) = $2 as ok',
      [`${password}x`, hash],
    );
    return { hashPrefix: hash.slice(0, 7), verified: verified.rows[0]!.ok, wrongRefused: !refused.rows[0]!.ok };
  });
  return c.json({ ok: result.verified && result.wrongRefused, wallMs: Date.now() - started, ...result });
});

app.get('/storage', async (c) => {
  const store = new ObjectStoreClient({
    endpoint: c.env.OBJECT_STORE_ENDPOINT,
    region: c.env.OBJECT_STORE_REGION,
    accessKeyId: c.env.OBJECT_STORE_ACCESS_KEY,
    secretAccessKey: c.env.OBJECT_STORE_SECRET_KEY,
    quarantineBucket: c.env.OBJECT_STORE_BUCKET_QUARANTINE,
    cleanBucket: c.env.OBJECT_STORE_BUCKET_CLEAN,
    uploadTtlSeconds: 300,
    downloadTtlSeconds: 120,
  });
  const key = `spike/${crypto.randomUUID()}.txt`;
  const body = new TextEncoder().encode('JobWork F-CW.0 storage probe');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const steps: Record<string, unknown> = {};

  try {
    // The browser path: a presigned PUT bound to length and checksum.
    const grant = store.signUpload({ key, byteSize: body.byteLength, sha256, contentType: 'text/plain' });
    const put = await fetch(grant.url, { method: 'PUT', headers: grant.headers, body });
    steps['presignedPut'] = put.status;

    // A tampered body must be refused by the store, not by us.
    const tampered = store.signUpload({ key: `${key}.bad`, byteSize: body.byteLength, sha256, contentType: 'text/plain' });
    const bad = new Uint8Array(body);
    bad[0] = 0x21;
    const badPut = await fetch(tampered.url, { method: 'PUT', headers: tampered.headers, body: bad });
    steps['tamperedPutRefused'] = !badPut.ok;

    const head = await store.head('quarantine', key);
    steps['head'] = head;
    steps['checksumReturned'] = head?.sha256 === sha256;

    await store.copy({ bucket: 'quarantine', key }, { bucket: 'clean', key });
    steps['copy'] = 'ok';

    const download = await fetch(store.signDownload({ bucket: 'clean', key, filename: 'probe.txt' }));
    steps['presignedGet'] = download.status;
    steps['bytesMatch'] = (await download.text()) === new TextDecoder().decode(body);
  } catch (err) {
    steps['error'] = err instanceof Error ? err.message : String(err);
  } finally {
    await Promise.allSettled([
      store.remove('quarantine', key),
      store.remove('quarantine', `${key}.bad`),
      store.remove('clean', key),
    ]);
  }
  return c.json(steps);
});

export default app;
