// The API Worker's entry (F-CW.3). The API is compiled by tsc first (`dist/`), because
// the runtime reads the constructor types tsc emits and esbuild does not; wrangler then
// bundles the compiled files. Building the application here, at startup, keeps that work
// out of the first request's CPU budget.
import { env } from 'cloudflare:workers';
import compiled from '../dist/worker.js';

const worker = compiled.default ?? compiled;
worker.start(env);

export default { fetch: (request, bindings, ctx) => worker.fetch(request, bindings, ctx) };
