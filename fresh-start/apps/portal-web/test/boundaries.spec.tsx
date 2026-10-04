import { fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PageError from '../app/error';
import GlobalError from '../app/global-error';
import NotFound from '../app/not-found';

/** F-FE.5: a crash or a dead link ends in a way forward, never a blank screen. */

function crash(): Error & { digest?: string } {
  return Object.assign(new Error('relation "commercial.quote" does not exist'), { digest: '2846135799' });
}

describe('route boundaries', () => {
  it('a page that throws shows the reference and a working Try again, never the error text', () => {
    const retry = vi.fn();
    render(<PageError error={crash()} retry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('PAGE_ERROR · 2846135799');
    expect(document.body).not.toHaveTextContent('commercial.quote');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a failure in the root layout renders a whole document with the same way forward', () => {
    const html = renderToStaticMarkup(<GlobalError error={crash()} retry={() => undefined} />);
    expect(html).toMatch(/^<html lang="en">/);
    // React 19 hoists the <title> into a <head> of its own.
    expect(html).toContain('<title>Something went wrong — JobWork</title>');
    expect(html).toContain('<body>');
    expect(html).toContain('2846135799');
    expect(html).toContain('Try again');
    expect(html).not.toContain('commercial.quote');
  });

  it('an unknown address says so and links home', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { name: 'That page does not exist' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
  });
});
