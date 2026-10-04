import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { describeLimits, type GridCharacteristic, type GridResult, MeasurementGrid } from '../src/quality/MeasurementGrid';

/** IN-14 F-14.4 measurement grid (doc 21 §6): original and normalized side by side; cannot-evaluate is not a fail. */
describe('MeasurementGrid', () => {
  const bore: GridCharacteristic = { id: 'c1', seq: 3, name: 'Bore diameter', drawingReference: '7', kind: 'variable', criticality: 'critical', mandatory: true, unit: 'mm', lower: { value: '11.98', inclusive: true }, upper: { value: '12.02', inclusive: true }, acceptedValues: [] };
  const ra: GridCharacteristic = { id: 'c2', seq: 2, name: 'Surface roughness Ra', drawingReference: '', kind: 'variable', criticality: 'minor', mandatory: true, unit: 'um', lower: null, upper: { value: '3.2', inclusive: false }, acceptedValues: [] };
  const base = { calibrationStatus: 'valid', disposition: null, supersededByResultId: null, supersedesResultId: null, correctionReason: null } as const;
  const results: GridResult[] = [
    { ...base, resultId: 'r1', characteristicId: 'c1', sampleNo: 1, original: { value: '0.4724', unit: 'inch' }, normalized: { value: '11.99896', unit: 'mm' }, outcome: 'pass', outcomeReason: 'Within limits' },
    { ...base, resultId: 'r2', characteristicId: 'c1', sampleNo: 2, original: { value: '12.03', unit: 'mm' }, normalized: { value: '12.03', unit: 'mm' }, outcome: 'fail', outcomeReason: 'Above the upper limit 12.02 mm (inclusive)', calibrationStatus: 'expired' },
    { ...base, resultId: 'r3', characteristicId: 'c2', sampleNo: 1, original: { value: '32', unit: 'um' }, normalized: { value: '0.032', unit: 'mm' }, outcome: 'fail', outcomeReason: 'Above', supersededByResultId: 'r4' },
    { ...base, resultId: 'r4', characteristicId: 'c2', sampleNo: 1, original: { value: '3.2', unit: 'um' }, normalized: { value: '0.0032', unit: 'mm' }, outcome: 'fail', outcomeReason: 'Above the upper limit 3.2 um (exclusive)', supersedesResultId: 'r3', correctionReason: 'Decimal point dropped' },
    { ...base, resultId: 'r5', characteristicId: 'c2', sampleNo: 2, original: { value: '125', unit: 'microinch' }, normalized: null, outcome: 'cannot_evaluate', outcomeReason: 'Unknown unit "microinch"' },
  ];

  it('describes limits with their inclusivity', () => {
    expect(describeLimits(bore)).toBe('≥ 11.98 and ≤ 12.02 mm');
    expect(describeLimits(ra)).toBe('< 3.2 um');
    expect(describeLimits({ ...bore, kind: 'attribute', unit: null, lower: null, upper: null, acceptedValues: ['conforming'] })).toBe('one of: conforming');
  });

  it('shows original and normalized values, the standing result only, and cannot-evaluate as its own state', () => {
    render(<MeasurementGrid caption="FAI results" characteristics={[ra, bore]} sampleNos={[1, 2]} results={results} />);
    const table = screen.getByRole('table', { name: 'FAI results' });
    const boreRow = within(table).getByRole('row', { name: /Bore diameter/ });
    expect(within(boreRow).getByText('0.4724 inch')).toBeInTheDocument();
    expect(within(boreRow).getByText('= 11.99896 mm')).toBeInTheDocument();
    expect(within(boreRow).getByText('calibration expired')).toBeInTheDocument();
    const raRow = within(table).getByRole('row', { name: /Surface roughness/ });
    // The superseded 32 µm stays in the record, not in the grid; the correction is named.
    expect(within(raRow).queryByText('32 um')).toBeNull();
    expect(within(raRow).getByText('corrected')).toBeInTheDocument();
    expect(within(raRow).getByText('Correction: Decimal point dropped')).toBeInTheDocument();
    expect(within(raRow).getByText('cannot evaluate')).toBeInTheDocument();
    expect(within(raRow).getAllByText('fail')).toHaveLength(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<MeasurementGrid caption="FAI results" characteristics={[ra, bore]} sampleNos={[1, 2]} results={results} />);
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});
