/** Minimal cookie-jar client for API tests: tracks cookies, sends CSRF header automatically. */
export class TestClient {
  private cookies = new Map<string, string>();

  constructor(private readonly baseUrl: string) {}

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  clone(): TestClient {
    const c = new TestClient(this.baseUrl);
    for (const [k, v] of this.cookies) c.setCookie(k, v);
    return c;
  }

  private absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    opts: { csrf?: boolean; origin?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookies.size > 0) {
      headers['cookie'] = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const csrf = this.cookies.get('jw_csrf');
    if (csrf && opts.csrf !== false) headers['x-csrf-token'] = csrf;
    if (opts.origin) headers['origin'] = opts.origin;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    this.absorb(response);
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  }

  get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.request('GET', path);
  }

  post(
    path: string,
    body?: unknown,
    opts?: { csrf?: boolean; origin?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.request('POST', path, body, opts ?? {});
  }
}
