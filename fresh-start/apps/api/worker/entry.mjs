// The API Worker's entry (F-CW.3). The API is compiled by tsc first (`dist/`), because
// the runtime reads the constructor types tsc emits and esbuild does not; wrangler then
// bundles the compiled files. Building the application here, at startup, keeps that work
// out of the first request's CPU budget. No binding is touched here: Hyperdrive's
// connection string may only be read inside a request (see src/worker.ts).
import compiled from '../dist/worker.js';

const worker = compiled.default ?? compiled;
worker.start();

export default { fetch: (request, bindings, ctx) => worker.fetch(request, bindings, ctx) };
