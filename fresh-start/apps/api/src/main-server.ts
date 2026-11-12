import type { ServerType } from '@hono/node-server';

/**
 * Fastify's keep-alive, not Node's: Node closes an idle connection after 5 s, and the web
 * apps' `/api` proxy reuses idle connections, so a request sent just as the API closed
 * one died with ECONNRESET (the walk, 2026-11-12). Fastify's 72 s outlasts any proxy's reuse.
 */
export function keepConnectionsAlive(server: ServerType): void {
  // HTTP/2 servers have no keep-alive timeout; the API is served over HTTP/1.1.
  if (!('keepAliveTimeout' in server)) return;
  server.keepAliveTimeout = 72_000;
  // Node requires the headers timeout to exceed the keep-alive timeout.
  server.headersTimeout = 73_000;
}
