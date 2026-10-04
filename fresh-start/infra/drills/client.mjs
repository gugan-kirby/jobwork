// Minimal API client for the drills (IN-12 F-12.2): cookie session, CSRF header, TOTP.
// Dependency-free so a drill needs nothing but Node, like infra/perf/smoke.mjs.
import { createHash, createHmac } from 'node:crypto';

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as the API's authenticator enrolment issues. */
export function totp(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class Session {
  constructor(base) {
    this.base = base.replace(/\/$/, '');
    this.jar = new Map();
  }

  async call(method, path, body, headers = {}) {
    const h = { ...headers };
    if (this.jar.size > 0) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = this.jar.get('jw_csrf');
    if (csrf && method !== 'GET') h['x-csrf-token'] = csrf;
    if (body !== undefined) h['content-type'] = 'application/json';
    const started = performance.now();
    const res = await fetch(`${this.base}/api/v1${path}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed, ms: Math.round(performance.now() - started) };
  }

  get(path) {
    return this.call('GET', path);
  }

  post(path, body, headers) {
    return this.call('POST', path, body, headers);
  }

  /** Signs in; completes MFA when the account asks for it and a secret is given. */
  async signIn(email, password, totpSecret) {
    const login = await this.post('/auth/login', { email, password });
    if (login.status !== 201) throw new Error(`sign-in failed for ${email}: ${login.status} ${login.body.code ?? ''}`);
    if (login.body.mfaRequired) {
      if (!totpSecret) throw new Error(`${email} needs MFA and no TOTP secret was given`);
      const mfa = await this.post('/auth/mfa', { code: totp(totpSecret) });
      if (mfa.status !== 201) throw new Error(`MFA failed for ${email}: ${mfa.status} ${mfa.body.code ?? ''}`);
    }
    return this;
  }
}

/** Prints one result line and remembers failures; `exit()` sets the process status. */
export function reporter(name) {
  const failures = [];
  return {
    check(label, ok, detail = '') {
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${label}${detail ? ` (${detail})` : ''}`);
      if (!ok) failures.push(label);
    },
    exit() {
      if (failures.length > 0) {
        console.log(`${name}: ${failures.length} check(s) failed`);
        process.exit(1);
      }
    },
  };
}
