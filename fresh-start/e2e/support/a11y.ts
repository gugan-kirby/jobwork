import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Doc 21 §9: no serious or critical axe violation on a launch journey's screens. The
 * report names the rule, the impact and the first offending selector, so a failure says
 * what to fix.
 */
export async function expectAccessible(page: Page, screen: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes[0]?.target.join(' ') ?? ''})`);
  expect(blocking, `${screen} has serious or critical accessibility violations`).toEqual([]);
}
