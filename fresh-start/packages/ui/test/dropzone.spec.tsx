import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileUpload, type FileUploadApi } from '../src/upload/FileUpload';

/** VF-06: the reference drop zone keeps one real, named file input behind it. */
describe('FileUpload drop zone', () => {
  const api = {} as FileUploadApi;

  it('names the hidden input by the visible action and the purpose', () => {
    render(<FileUpload purpose="drawing_2d" api={api} resumeKey="test.dropzone" />);
    const input = screen.getByLabelText(/Upload File.*2D drawing/);
    expect(input.getAttribute('type')).toBe('file');
    expect(input.className).toContain('jw-visually-hidden');
    expect(screen.getByText(/\(Max /).textContent).toMatch(/PDF/);
  });
});
