import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';

/**
 * F-FE.2: the portal shell asks who is signed in once, believes only a 401, and never
 * shows one audience's navigation to another (doc 14 §§4–5, D-17).
 */

const navigation = vi.hoisted(() => ({ pathname: '/' }));
const apiMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: apiMock,
}));

const { PortalShell } = await import('../app/shell');

type Answer = { organizationType: string | null } | ApiError;

function problem(status: number, code: string): ApiError {
  return new ApiError({ status, code, title: code });
}

/** Routes `/auth/me` through a queue of answers; counts always succeed. */
function serve(...identity: Answer[]): void {
  apiMock.mockImplementation((path: string) => {
    if (path === '/auth/me') {
      const next = identity.length > 1 ? identity.shift()! : identity[0]!;
      return next instanceof ApiError ? Promise.reject(next) : Promise.resolve(next);
    }
    if (path === '/portal/summary') return Promise.resolve({ queues: [] });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function calls(path: string): number {
  return apiMock.mock.calls.filter(([called]) => called === path).length;
}

function shell(): React.JSX.Element {
  return (
    <PortalShell environmentLabel={null}>
      <p>page</p>
    </PortalShell>
  );
}

function link(name: string): HTMLElement | null {
  return screen.queryAllByRole('link', { name, hidden: true })[0] ?? null;
}

// Reset before each test, not after: `cleanup()` (test/setup.ts) unmounts after this
// file's own afterEach hooks, and unmounting flushes pending effects — against an
// already-reset mock they would call an `api` that returns nothing.
beforeEach(() => {
  navigation.pathname = '/';
  apiMock.mockReset();
});

describe('PortalShell identity', () => {
  it('shows the public navigation only when the API says there is no session', async () => {
    serve(problem(401, 'NOT_AUTHENTICATED'));
    render(shell());
    await waitFor(() => expect(link('Sign in')).not.toBeNull());
    expect(link('Enquiries')).toBeNull();
  });

  it.each([
    ['the API is down', problem(500, 'UNEXPECTED_RESPONSE')],
    ['the network is gone', problem(0, 'NETWORK_UNREACHABLE')],
  ])('offers neither Sign in nor a customer link when %s', async (_case, failure) => {
    serve(failure);
    render(shell());
    await waitFor(() => expect(calls('/auth/me')).toBe(1));
    await act(async () => undefined);
    expect(link('Sign in')).toBeNull();
    expect(link('Enquiries')).toBeNull();
    expect(screen.getByText('page')).toBeInTheDocument();
  });

  it('asks who the customer is once across navigations, and counts on every page', async () => {
    serve({ organizationType: 'customer' });
    const view = render(shell());
    await waitFor(() => expect(link('Enquiries')).not.toBeNull());

    for (const pathname of ['/orders', '/quotations']) {
      navigation.pathname = pathname;
      view.rerender(shell());
      await act(async () => undefined);
    }

    expect(calls('/auth/me')).toBe(1);
    await waitFor(() => expect(calls('/portal/summary')).toBe(3));
  });

  it('retries a failed identity check on the next navigation, not in a loop', async () => {
    serve(problem(500, 'UNEXPECTED_RESPONSE'), { organizationType: 'customer' });
    const view = render(shell());
    await waitFor(() => expect(calls('/auth/me')).toBe(1));
    await act(async () => undefined);
    expect(calls('/auth/me')).toBe(1);

    navigation.pathname = '/orders';
    view.rerender(shell());
    await waitFor(() => expect(link('Enquiries')).not.toBeNull());
    expect(calls('/auth/me')).toBe(2);
  });

  it('asks again after passing through sign-in', async () => {
    serve(problem(401, 'NOT_AUTHENTICATED'), { organizationType: 'customer' });
    const view = render(shell());
    await waitFor(() => expect(link('Sign in')).not.toBeNull());

    navigation.pathname = '/login';
    view.rerender(shell());
    expect(link('Sign in')).toBeNull();

    navigation.pathname = '/';
    view.rerender(shell());
    await waitFor(() => expect(link('Enquiries')).not.toBeNull());
    expect(calls('/auth/me')).toBe(2);
  });

  it('never shows a supplier the customer navigation, including while asking', async () => {
    let answer: (value: { organizationType: string }) => void = () => undefined;
    apiMock.mockImplementation((path: string) =>
      path === '/auth/me'
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : Promise.resolve({ queues: [] }),
    );
    render(shell());
    expect(link('Enquiries')).toBeNull();

    await act(async () => answer({ organizationType: 'supplier' }));
    expect(link('RFQs')).not.toBeNull();
    expect(link('Enquiries')).toBeNull();
    expect(calls('/portal/summary')).toBe(0);
  });
});
