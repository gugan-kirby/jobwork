/**
 * The one way a browser screen talks to the API: same-origin through the Next rewrite
 * proxy, which keeps the session cookies first-party (doc 20 §6), with the CSRF header
 * added automatically.
 *
 * Every failure comes back as an `ApiError` — including the ones the API never answered.
 * Screens keep only `ApiError` in their `catch` and render it. Before F-FE.1 an outage
 * threw a `SyntaxError` (the Next proxy answers a plain-text 500 when the API is down) or
 * a `TypeError` (offline); the catch dropped it and the screen showed "Loading" forever
 * (`ES-14`).
 */

export interface Problem {
  status: number;
  code: string;
  title: string;
  detail?: string;
  correlationId?: string;
  errors?: Array<{ path: string; message: string }>;
  /** F-11.2: on a 429, how long until the budget allows the request again. */
  retryAfterSeconds?: number;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }
}

/**
 * Failures the API's problem mapper never saw, named in its vocabulary so a screen can
 * show and support can quote them like any other code. Status 0 means no HTTP answer.
 */
function networkUnreachable(): ApiError {
  return new ApiError({
    status: 0,
    code: 'NETWORK_UNREACHABLE',
    title: 'JobWork could not be reached',
    detail: 'JobWork could not be reached. Check your connection and try again.',
  });
}

function unexpectedResponse(status: number): ApiError {
  return new ApiError({
    status,
    code: 'UNEXPECTED_RESPONSE',
    title: 'JobWork is not answering properly',
    detail: 'JobWork is not answering properly right now. Try again in a moment.',
  });
}

function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === 'string' && typeof candidate.status === 'number';
}

const NOT_JSON = Symbol('not-json');

function parseBody(text: string): unknown {
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(/(?:^|;\s*)jw_csrf=([^;]+)/);
  return match?.[1];
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  // Fastify refuses a body-less request that claims to carry JSON.
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const csrf = csrfToken();
  if (csrf) headers['x-csrf-token'] = csrf;
  // Retrying a command must not repeat its effect (doc 08 §6).
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;

  let response: Response;
  let text: string;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      credentials: 'same-origin',
    });
    // A connection that drops mid-body is as unreachable as one that never opened.
    text = await response.text();
  } catch {
    throw networkUnreachable();
  }

  const data = parseBody(text);
  if (data === NOT_JSON) throw unexpectedResponse(response.status);
  if (!response.ok) throw isProblem(data) ? new ApiError(data) : unexpectedResponse(response.status);
  return data as T;
}
