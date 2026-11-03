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

import { DescriptionList } from '../src/data/DescriptionList';

/** VF-07: the split list is still a description list, one term per value. */
describe('DescriptionList split layout', () => {
  it('keeps dt/dd pairs and marks numeric values', () => {
    const { container } = render(
      <DescriptionList
        layout="split"
        items={[
          { label: 'Part Name', value: 'Bracket Support' },
          { label: 'Quantity', value: '100 Nos', numeric: true },
        ]}
      />,
    );
    expect(container.querySelector('dl.jw-dl-split')).toBeTruthy();
    expect([...container.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Part Name', 'Quantity']);
    expect(container.querySelectorAll('dd')[1]?.className).toBe('numeric');
  });
});

import { RecordCard } from '../src/data/RecordCard';

/** VF-08: the rich record card is still one named link and drops an empty reference. */
describe('RecordCard rich layout', () => {
  it('shows the tile, date and caption, and no separator without a reference', () => {
    const { container } = render(
      <RecordCard href="/enquiries/1" reference="" title="Bracket Support" caption="Job work • 1 part" date="12 Mar 2026" icon={{ name: 'settings', tint: 'blue' }} />,
    );
    const link = screen.getByRole('link');
    expect(link.textContent).toContain('Bracket Support');
    expect(container.querySelector('.jw-record-tile-blue')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.jw-record-caption')?.textContent).toBe('Job work • 1 part');
    expect(container.querySelector('.jw-record-date')?.textContent).toBe('12 Mar 2026');
  });
});
