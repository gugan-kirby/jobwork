/**
 * Role combinations one person may not hold in JobWork (doc 03 §§1–2, 4; doc 19 §9 "same
 * person has conflicting roles"; F-11.3).
 *
 * Decision-level separation is already enforced where each decision is taken — a
 * reviewer cannot approve what they submitted, an author cannot release their own held
 * message. These rules are the standing version: combinations that would let one person
 * both make and check the same kind of decision every day. Granting one is refused at
 * invitation; a combination that predates a rule is surfaced on the controls panel.
 *
 * Considered and left out, pending the pilot's staffing (`A-04`): quality with sourcing.
 * A small team may need one person in both, and refusing it would push work around the
 * system rather than through it.
 */

export interface SodRule {
  key: string;
  /** Both roles, or one role and `*` for "with any other role". */
  roles: readonly [string, string];
  reason: string;
  source: string;
}

export const SOD_RULES: readonly SodRule[] = [
  {
    key: 'sales_with_finance',
    roles: ['jobwork_sales', 'jobwork_finance'],
    reason: 'Sales may not release its own credit or payment exceptions.',
    source: 'doc 03 §4, credit/payment release',
  },
  {
    key: 'finance_with_quality',
    roles: ['jobwork_finance', 'jobwork_quality'],
    reason: 'Finance may not dispose quality, and quality may not approve a supplier settlement.',
    source: 'doc 03 §2',
  },
  {
    key: 'auditor_with_any',
    roles: ['auditor', '*'],
    reason: 'An auditor reviews evidence and changes nothing.',
    source: 'doc 03 §2',
  },
];

/** The rules a set of roles breaks. `org_admin` is administration of one's own organization, not a duty. */
export function conflictsOf(roles: readonly string[]): SodRule[] {
  const held = new Set(roles.filter((r) => r !== 'org_admin'));
  return SOD_RULES.filter(({ roles: [a, b] }) => held.has(a) && (b === '*' ? held.size > 1 : held.has(b)));
}
