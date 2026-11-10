import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createLogger } from '@jobwork/observability';
import { createApplication } from '../../src/app';
import type { Token } from '../../src/runtime/container';

/** What a test holds: the running application's providers, and a way to stop it. */
export interface TestApp {
  get<T>(token: abstract new (...args: never[]) => T): T;
  get<T = unknown>(token: Token): T;
  close(): Promise<void>;
}

/** Boots the real application wiring (mirrors main.ts) against whatever env is set. */
export async function createTestApp(): Promise<{ app: TestApp; baseUrl: string }> {
  const application = await createApplication({ logger: createLogger({ service: 'api-test', level: 'silent' }) });
  const server = serve({
    fetch: (request, env) => application.handle(request, { remoteAddress: env.incoming.socket.remoteAddress }),
    port: 0,
    hostname: '127.0.0.1',
  });
  if (!server.listening) await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    app: {
      get: application.get.bind(application),
      close: async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          if ('closeAllConnections' in server) server.closeAllConnections();
        });
        await application.close();
      },
    },
    baseUrl: `http://127.0.0.1:${port}`,
  };
}
