import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { GateMatrix } from '../src/gates/GateMatrix';

/** F-09.3 gate matrix: every gate named with its state; reasons shown only for blocked gates. */
describe('GateMatrix', () => {
  const gates = [
    { key: 'commercial', label: 'Commercial', pass: true, reasons: [] },
    { key: 'technical', label: 'Technical', pass: false, reasons: ['Transmittal TR-2026-0001 not acknowledged.'] },
  ];

  it('names each gate with its state and lists the reasons it is blocked', () => {
    render(<GateMatrix gates={gates} label="Release gates for WP-2026-0001" />);
    const list = screen.getByRole('list', { name: 'Release gates for WP-2026-0001' });
    expect(list).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Commercial: passes' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Technical: blocked' })).toBeInTheDocument();
    expect(screen.getByText('Transmittal TR-2026-0001 not acknowledged.')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 gates blocked')).toBeInTheDocument();
  });

  it('says plainly when everything passes, and has no accessibility violations', async () => {
    const { container } = render(<GateMatrix gates={gates.map((g) => ({ ...g, pass: true, reasons: [] }))} label="Gates" />);
    expect(screen.getByText('All gates pass — ready to release')).toBeInTheDocument();
    const result = await axe.run(container);
    expect(result.violations).toEqual([]);
  });
});
