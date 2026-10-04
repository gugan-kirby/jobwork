import * as OTPAuth from 'otpauth';

export type Body = Record<string, unknown>;
export type Res = { status: number; body: Body };

export const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
export const PORTAL = process.env.E2E_PORTAL_URL ?? 'http://localhost:3002';
export const OPERATIONS = process.env.E2E_OPERATIONS_URL ?? 'http://localhost:3001';
export const PASSWORD = 'e2e-journey-password-1';

export function totp(secret: string, email: string): string {
  return new OTPAuth.TOTP({ issuer: 'JobWork', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}

/** Fails with the response body, so a broken setup step names itself. */
export function ok(res: Res, status: number, step: string): Body {
  if (res.status !== status) throw new Error(`${step}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A cookie-jar session against the API, sending the CSRF header the API expects. */
export class ApiSession {
  private jar = new Map<string, string>();

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { ...headers };
    if (this.jar.size > 0) h['cookie'] = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = this.jar.get('jw_csrf');
    if (csrf && method !== 'GET') h['x-csrf-token'] = csrf;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(`${API}/api/v1${path}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair!.indexOf('=');
      const value = pair!.slice(eq + 1).trim();
      if (value === '') this.jar.delete(pair!.slice(0, eq).trim());
      else this.jar.set(pair!.slice(0, eq).trim(), value);
    }
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Body) : {} };
  }

  get(path: string): Promise<Res> {
    return this.call('GET', path);
  }

  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Res> {
    return this.call('POST', path, body, headers);
  }

  static async signIn(email: string): Promise<ApiSession> {
    const s = new ApiSession();
    ok(await s.post('/auth/login', { email, password: PASSWORD }), 201, `sign in ${email}`);
    return s;
  }

  /** Signs in and enrols MFA; the activated session is strong enough for commands. */
  static async signInEnrolled(email: string): Promise<{ session: ApiSession; secret: string }> {
    const s = await ApiSession.signIn(email);
    const enroll = ok(await s.post('/account/mfa/enroll'), 201, `enroll ${email}`);
    const secret = enroll['secret'] as string;
    ok(await s.post('/account/mfa/activate', { code: totp(secret, email) }), 201, `activate ${email}`);
    return { session: s, secret };
  }
}
