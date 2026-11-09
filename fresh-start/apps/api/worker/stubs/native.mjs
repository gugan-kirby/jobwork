// Node-only modules the API imports but a Worker never calls (ADR-0009): argon2 (the
// Worker hashes with pgcrypto), ioredis (it counts rate limits in Postgres) and
// pg-native. Reaching one is a configuration error, so it says so.
function unavailable(name) {
  return new Proxy(function () {}, {
    get: (_target, prop) => (prop === '__esModule' ? false : unavailable(`${name}.${String(prop)}`)),
    apply: () => {
      throw new Error(`${name} is not available on Workers (ADR-0009)`);
    },
    construct: () => {
      throw new Error(`${name} is not available on Workers (ADR-0009)`);
    },
  });
}
export default unavailable('native module');
