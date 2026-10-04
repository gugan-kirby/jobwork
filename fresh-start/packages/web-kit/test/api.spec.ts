import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api';

/** F-FE.1: every failure a screen can meet arrives as an ApiError it already renders. */

const fetchMock = vi.fn<typeof fetch>();

function respond(status: number, body: string, contentType = 'application/json'): void {
  fetchMock.mockResolvedValueOnce(
    new Response(body === '' ? null : body, { status, headers: { 'content-type': contentType } }),
  );
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('document', { cookie: 'theme=plain; jw_csrf=token-123' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('api()', () => {
  it('returns the parsed body of a successful answer', async () => {
    respond(200, JSON.stringify({ orders: [{ orderId: 'o-1' }] }));
    await expect(api('/orders')).resolves.toEqual({ orders: [{ orderId: 'o-1' }] });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/orders', expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
  });

  it('treats an empty successful body as an empty object', async () => {
    respond(204, '');
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toEqual({});
  });

  it('carries the API problem, code and correlation id intact', async () => {
    respond(409, JSON.stringify({ type: 'x', status: 409, code: 'VERSION_CONFLICT', title: 'Changed', detail: 'Someone else changed this.', correlationId: 'corr-9' }));
    const error = await failure(api('/enquiries/e-1/submit', { method: 'POST', body: {} }));
    expect(error.problem).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'corr-9' });
    expect(error.message).toBe('Someone else changed this.');
  });

  it('turns the proxy’s plain-text 500 (API down) into UNEXPECTED_RESPONSE', async () => {
    respond(500, 'Internal Server Error', 'text/plain');
    const error = await failure(api('/orders'));
    expect(error.problem).toMatchObject({ status: 500, code: 'UNEXPECTED_RESPONSE' });
  });

  it('turns an HTML gateway page into UNEXPECTED_RESPONSE', async () => {
    respond(502, '<html><body>Bad gateway</body></html>', 'text/html');
    const error = await failure(api('/orders'));
    expect(error.problem).toMatchObject({ status: 502, code: 'UNEXPECTED_RESPONSE' });
  });

  it('does not hand a screen a non-JSON success body', async () => {
    respond(200, '<!doctype html><title>login</title>', 'text/html');
    const error = await failure(api('/orders'));
    expect(error.problem.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('turns JSON without a problem shape on a failure into UNEXPECTED_RESPONSE', async () => {
    respond(503, JSON.stringify({ message: 'upstream busy' }));
    const error = await failure(api('/orders'));
    expect(error.problem).toMatchObject({ status: 503, code: 'UNEXPECTED_RESPONSE' });
  });

  it('turns a network failure into NETWORK_UNREACHABLE with status 0', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = await failure(api('/orders'));
    expect(error.problem).toMatchObject({ status: 0, code: 'NETWORK_UNREACHABLE' });
    expect(error.message).toMatch(/could not be reached/);
  });

  it('turns a body that fails mid-read into NETWORK_UNREACHABLE', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.reject(new TypeError('network error')) } as unknown as Response);
    const error = await failure(api('/orders'));
    expect(error.problem.code).toBe('NETWORK_UNREACHABLE');
  });

  it('sends the CSRF token, JSON content type only with a body, and the idempotency key', async () => {
    respond(200, '{}');
    await api('/quotations/q-1/accept', { method: 'POST', body: { optionId: 'a' }, idempotencyKey: 'key-1' });
    const [, withBody] = fetchMock.mock.calls[0]!;
    expect(withBody?.headers).toEqual({ 'content-type': 'application/json', 'x-csrf-token': 'token-123', 'idempotency-key': 'key-1' });
    expect(withBody?.body).toBe(JSON.stringify({ optionId: 'a' }));

    respond(200, '{}');
    await api('/auth/logout-all', { method: 'POST' });
    const [, withoutBody] = fetchMock.mock.calls[1]!;
    expect(withoutBody?.headers).toEqual({ 'x-csrf-token': 'token-123' });
    expect(withoutBody).not.toHaveProperty('body');
  });
});
