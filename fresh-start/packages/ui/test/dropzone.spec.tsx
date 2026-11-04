import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FileUpload, type FileUploadApi } from '../src/upload/FileUpload';

/** VF-06: the reference drop zone keeps one real, named file input behind it. */
describe('FileUpload formats (VF-17)', () => {
  it('states the formats and limit, and refuses a file outside them before it moves', async () => {
    const formats = { purposeByExtension: { pdf: 'drawing_2d', step: 'cad_3d' }, caption: 'PDF, STEP', maxBytes: 10 * 1024 * 1024 } as const;
    render(<FileUpload purpose="drawing_2d" formats={formats} api={{} as FileUploadApi} resumeKey="test.formats" />);
    expect(screen.getByText(/\(Max /).textContent).toBe('PDF, STEP (Max 10MB)');
    const input = screen.getByLabelText(/Upload File/) as HTMLInputElement;
    expect(input.accept).toBe('.pdf,.step');
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.txt')] } });
    expect(await screen.findByText(/Upload a PDF, STEP file/)).toBeTruthy();
  });
});

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

describe('RecordCard progress (VF-11)', () => {
  it('exposes progress as a named progressbar with its value', () => {
    render(<RecordCard href="/orders/1" reference="Order #SO-1" title="Bracket" icon={{ name: 'factory', tint: 'blue' }} progress={45} />);
    const bar = screen.getByRole('progressbar', { name: 'Progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('45');
  });
});

import { Donut } from '../src/data/Donut';

describe('Donut (VF-15)', () => {
  it('names the whole in one image label and lists every count in the legend', () => {
    render(<Donut totalLabel="Orders" slices={[{ label: 'To acknowledge', value: 4 }, { label: 'In production', value: 0 }, { label: 'Awaiting baseline', value: 3 }]} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('7 Orders: 4 To acknowledge, 0 In production, 3 Awaiting baseline');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['To acknowledge4', 'In production0', 'Awaiting baseline3']);
  });
});
