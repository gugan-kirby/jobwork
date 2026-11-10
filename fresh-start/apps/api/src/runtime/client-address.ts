import proxyaddr from 'proxy-addr';

type Trust = (address: string, hop: number) => boolean;

/**
 * The client address as Fastify's `trustProxy` computed it (F-11.2): walk
 * `X-Forwarded-For` from the connecting peer back, stopping at the first hop that is not
 * a trusted proxy. Per-address rate limits are only as true as this.
 */
export function clientAddress(remoteAddress: string | undefined, forwardedFor: string | undefined, trust: Trust): string | undefined {
  if (!remoteAddress) return undefined;
  return proxyaddr(
    { connection: { remoteAddress }, headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} } as unknown as Parameters<typeof proxyaddr>[0],
    trust,
  );
}

/** `TRUST_PROXY`: `false`, `loopback`, or a comma-separated address/CIDR list (`main.ts` refuses hop counts). */
clientAddress.compile = (value: string): Trust => {
  if (value === 'false') return () => false;
  return proxyaddr.compile(value.split(',').map((part) => part.trim()).filter(Boolean));
};
