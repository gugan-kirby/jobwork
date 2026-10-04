// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

const ORIGIN = 'https://portal.jobwork.test';
const SOURCE = readFileSync(join(__dirname, '..', 'public', 'sw.js'), 'utf8');

type Handler = (event: Record<string, unknown>) => void;

/** CacheStorage, in memory, keyed by URL — enough to read back everything the worker kept. */
class FakeCache {
  readonly entries = new Map<string, string>();
  async match(request: Request | string): Promise<Response | undefined> {
    const body = this.entries.get(typeof request === 'string' ? request : request.url);
    return body === undefined ? undefined : new Response(body);
  }
  async put(request: Request | string, response: Response): Promise<void> {
    this.entries.set(typeof request === 'string' ? request : request.url, await response.text());
  }
  async add(request: Request): Promise<void> {
    await this.put(request, await network(request));
  }
  async keys(): Promise<Array<{ url: string }>> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(request: { url: string } | string): Promise<boolean> {
    return this.entries.delete(typeof request === 'string' ? request : request.url);
  }
}

let stores: Map<string, FakeCache>;
let online: boolean;
let networkCalls: Array<{ url: string; credentials: string | undefined }>;

/** The API and the pages say exactly what a leak would carry: a supplier's name and a price. */
async function network(request: Request | { url: string; credentials?: string }): Promise<Response> {
  networkCalls.push({ url: request.url, credentials: (request as { credentials?: string }).credentials });
  if (!online) throw new TypeError('Failed to fetch');
  const path = new URL(request.url).pathname;
  if (path === '/offline') return new Response('<html>You are offline</html>');
  if (path.startsWith('/_next/static/')) return new Response(`/* bundle ${path} */`);
  return new Response(`<html>Anand Engineering · unit price 9000 · ${path}</html>`);
}

function boot(): { handlers: Map<string, Handler> } {
  stores = new Map();
  const handlers = new Map<string, Handler>();
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name)!;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (request: Request | string) => {
      for (const store of stores.values()) {
        const hit = await store.match(request);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  runInNewContext(SOURCE, { self, caches, fetch: network, Request, Response, URL, Math, Promise, console });
  return { handlers };
}

/** Dispatches an event and waits for whatever the worker asked to wait for or answered with. */
async function dispatch(handlers: Map<string, Handler>, type: string, init: Record<string, unknown> = {}): Promise<Response | undefined> {
  let waited: Promise<unknown> = Promise.resolve();
  let answered: Promise<Response> | undefined;
  handlers.get(type)!({
    ...init,
    waitUntil: (p: Promise<unknown>) => {
      waited = p;
    },
    respondWith: (p: Promise<Response>) => {
      answered = p;
    },
  });
  await waited;
  return answered ? await answered : undefined;
}

const get = (path: string, mode = 'cors') => ({ request: { url: `${ORIGIN}${path}`, method: 'GET', mode } });

async function everythingCached(): Promise<string> {
  const all: string[] = [];
  for (const store of stores.values()) all.push(...store.entries.keys(), ...store.entries.values());
  return all.join('\n');
}

/**
 * F-11.6 (doc 21 §8, `DS-14`, `BR-AUTH-05`): the installed portal keeps nothing a
 * session produced. The worker under test is the shipped `public/sw.js`, unmodified.
 */
describe('portal service worker (F-11.6)', () => {
  let handlers: Map<string, Handler>;

  beforeEach(async () => {
    online = true;
    networkCalls = [];
    ({ handlers } = boot());
    await dispatch(handlers, 'install');
    await dispatch(handlers, 'activate');
  });

  it('keeps the offline page, fetched as nobody', async () => {
    expect([...stores.get('jobwork-shell-v1')!.entries.keys()]).toEqual([`${ORIGIN}/offline`]);
    expect(networkCalls).toEqual([{ url: `${ORIGIN}/offline`, credentials: 'omit' }]);
  });

  it('caches no API response and no page after a customer’s and a supplier’s sessions', async () => {
    for (const path of ['/api/v1/quotations', '/api/v1/quotations/q-1', '/api/v1/orders/o-1', '/api/v1/supplier/purchase-orders/p-1', '/api/v1/auth/me']) {
      expect(await dispatch(handlers, 'fetch', get(path))).toBeUndefined();
    }
    for (const path of ['/quotations/q-1', '/orders/o-1', '/supplier/purchase-orders/p-1', '/']) {
      const page = await dispatch(handlers, 'fetch', get(path, 'navigate'));
      expect(await page!.text()).toContain('Anand Engineering');
    }
    await dispatch(handlers, 'fetch', get('/_next/static/chunks/app-1a2b3c.js'));

    const kept = await everythingCached();
    expect(kept).not.toMatch(/Anand|price|quotations|orders|purchase-orders|auth/);
    expect([...stores.get('jobwork-assets-v1')!.entries.keys()]).toEqual([`${ORIGIN}/_next/static/chunks/app-1a2b3c.js`]);
  });

  it('answers a navigation with the offline page only when the network is unreachable', async () => {
    online = false;
    const page = await dispatch(handlers, 'fetch', get('/orders/o-1', 'navigate'));
    expect(await page!.text()).toBe('<html>You are offline</html>');
  });

  it('never intercepts a command, so nothing can be queued to send later', async () => {
    online = false;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(await dispatch(handlers, 'fetch', { request: { url: `${ORIGIN}/api/v1/invoices/i-1/pay`, method, mode: 'cors' } })).toBeUndefined();
    }
    expect(handlers.has('sync')).toBe(false);
    expect(handlers.has('periodicsync')).toBe(false);
  });

  it('leaves other origins alone', async () => {
    expect(await dispatch(handlers, 'fetch', { request: { url: 'http://localhost:9000/jobwork-clean/drawing.pdf', method: 'GET', mode: 'cors' } })).toBeUndefined();
  });

  it('empties every cache on purge, keeping only the offline page (sign-out, 401)', async () => {
    await dispatch(handlers, 'fetch', get('/_next/static/chunks/app-1a2b3c.js'));
    await dispatch(handlers, 'message', { data: { type: 'purge' } });
    expect([...stores.keys()]).toEqual(['jobwork-shell-v1']);
    expect([...stores.get('jobwork-shell-v1')!.entries.keys()]).toEqual([`${ORIGIN}/offline`]);
  });
});
