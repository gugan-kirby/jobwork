import axe from 'axe-core';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { Button } from '../src/primitives/Button';
import { ButtonLink } from '../src/primitives/Link';
import { LeakWarning } from '../src/conversation/LeakWarning';
import { CommandButton } from '../src/primitives/CommandButton';
import { Checkbox, Select, TextArea, TextInput } from '../src/primitives/Field';
import { ReasonField } from '../src/primitives/ReasonField';
import { ErrorSummary } from '../src/primitives/ErrorSummary';
import { AppShell } from '../src/layout/AppShell';
import { Card, Page } from '../src/layout/Page';
import { DataTable, type Column } from '../src/data/DataTable';
import { DescriptionList } from '../src/data/DescriptionList';
import { Stepper } from '../src/data/Stepper';
import { CopyableId } from '../src/data/CopyableId';
import { EmptyState, ErrorState, LoadingState, RouteError } from '../src/data/States';
import { LiveRegion } from '../src/feedback/LiveRegion';
import { StatusChip } from '../src/status/StatusChip';
import { ActionNeededCard } from '../src/status/ActionNeededCard';
import { MeasurementInput } from '../src/forms/MeasurementInput';
import { MoneyInput } from '../src/forms/MoneyInput';
import { TabBar } from '../src/layout/TabBar';
import { Hero } from '../src/layout/Hero';
import { QuickAction, QuickActionGrid } from '../src/status/QuickAction';
import { FilterChips } from '../src/data/FilterChips';
import { RecordCard } from '../src/data/RecordCard';
import { ChoiceCards } from '../src/forms/ChoiceCards';

/**
 * `DS-12` requires every component to document keyboard and ARIA behaviour, and doc 13
 * §12/§14 puts accessibility in the merge gate. This is the automated half of that: axe
 * over each component in the states doc 21 §11 names — default, empty, loading, error,
 * disabled.
 *
 * Automated checks catch roughly a third of real barriers, so `ACCESSIBILITY.md` carries
 * the keyboard maps that a machine cannot verify. A clean run here is a floor, not a
 * pass mark.
 */

async function noViolations(ui: ReactElement): Promise<void> {
  const { container } = render(ui);
  const results = await axe.run(container, {
    // Colour contrast is asserted against the token source in `tokens.spec.ts`; jsdom
    // has no layout or computed backgrounds, so axe cannot judge it here.
    rules: { 'color-contrast': { enabled: false } },
  });
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.help}`);
  expect(summary).toEqual([]);
}

interface Row {
  id: string;
  reference: string;
  quantity: number;
}

const columns: ReadonlyArray<Column<Row>> = [
  { key: 'reference', header: 'Reference', render: (row) => row.reference },
  { key: 'quantity', header: 'Quantity', render: (row) => row.quantity, numeric: true },
];

const rows: Row[] = [{ id: 'a', reference: 'ENQ-2026-0001', quantity: 500 }];

const CASES: Array<[string, ReactElement]> = [
  [
    'TabBar — with current, badge and primary action',
    <TabBar
      items={[
        { href: '/', label: 'Home', icon: 'home' },
        { href: '/enquiries', label: 'Enquiries', icon: 'enquiries', badge: 2 },
        { href: '/orders', label: 'Orders', icon: 'orders' },
        { href: '/profile', label: 'Profile', icon: 'profile' },
      ]}
      currentPath="/enquiries"
      primary={{ href: '/enquiries/new', label: 'Create enquiry' }}
    />,
  ],
  [
    'Hero — banner with actions',
    <Hero
      headline="Precision work. On time."
      subline="Tell us what you need made."
      actions={<Button>Create enquiry</Button>}
      illustration={<span>art</span>}
    />,
  ],
  [
    'QuickAction grid',
    <QuickActionGrid>
      <QuickAction href="/enquiries/new" icon="plus" label="New enquiry" />
      <QuickAction href="/invoices" icon="invoice" label="Invoices" count={2} countLabel="unpaid" tone="attention" />
    </QuickActionGrid>,
  ],
  [
    'FilterChips',
    <FilterChips
      label="Filter enquiries by status"
      value="all"
      options={[
        { value: 'all', label: 'All', count: 3 },
        { value: 'review', label: 'In review' },
      ]}
      onChange={() => undefined}
    />,
  ],
  [
    'RecordCard',
    <RecordCard
      href="/enquiries/1"
      reference="ENQ-2026-0001"
      title="Bracket support"
      caption="CNC machining"
      status={<StatusChip tone="progress">Requirement review</StatusChip>}
      meta="10 Aug 2026"
    />,
  ],
  [
    'ChoiceCards — with hint, disabled option',
    <ChoiceCards
      legend="What kind of work is this?"
      hint="You can change it until you submit."
      name="jobType"
      value="job_work"
      options={[
        { value: 'job_work', label: 'Job work', description: 'Process on your material', icon: 'settings' },
        { value: 'new_model', label: 'New model' },
        { value: 'correction_ecn', label: 'Correction / ECN', disabled: true, disabledReason: 'Needs an enquiry on file' },
      ]}
      onChange={() => undefined}
    />,
  ],
  [
    'ChoiceCards — error',
    <ChoiceCards
      legend="Job type"
      name="jobType2"
      value={null}
      options={[{ value: 'job_work', label: 'Job work' }]}
      onChange={() => undefined}
      error="Choose one"
    />,
  ],
  ['Button — default', <Button>Approve for sourcing</Button>],
  ['Button — busy', <Button busy>Approve for sourcing</Button>],
  [
    'Button — disabled with a reason',
    <Button disabled disabledReason="Resolve the blocking checklist items first">
      Approve for sourcing
    </Button>,
  ],
  ['CommandButton — default', <CommandButton onCommand={async () => undefined}>Decline</CommandButton>],
  ['TextInput — default', <TextInput label="Part name" defaultValue="" />],
  ['TextInput — error', <TextInput label="Part name" error="Name the part" defaultValue="" />],
  ['TextInput — numeric', <TextInput label="Quantity" numeric defaultValue="500" />],
  ['TextArea', <TextArea label="Application notes" defaultValue="" />],
  [
    'Select',
    <Select
      label="Process"
      placeholder="Choose a process"
      options={[{ value: 'cnc_milling', label: 'CNC milling' }]}
      defaultValue=""
    />,
  ],
  ['Checkbox', <Checkbox label="I only have a photo" hint="Assisted intake" />],
  [
    'ReasonField',
    <ReasonField audience="customer" value="Outside every eligible envelope." onChange={() => undefined} />,
  ],
  [
    'ErrorSummary',
    <ErrorSummary issues={[{ path: 'title', message: 'Give the enquiry a short title' }]} />,
  ],
  [
    'AppShell',
    <AppShell productName="JobWork" navigation={[{ href: '/enquiries', label: 'Enquiries' }]} currentPath="/enquiries">
      <Page title="Enquiries">
        <Card title="List">Body</Card>
      </Page>
    </AppShell>,
  ],
  ['DataTable — rows', <DataTable caption="Enquiries" columns={columns} rows={rows} rowKey={(r) => r.id} />],
  ['DataTable — loading', <DataTable caption="Enquiries" columns={columns} rows={null} rowKey={(r) => r.id} />],
  [
    'DataTable — empty',
    <DataTable
      caption="Enquiries"
      columns={columns}
      rows={[]}
      rowKey={(r) => r.id}
      empty={{ title: 'Nothing waiting', detail: 'New submissions appear here.' }}
    />,
  ],
  [
    'DescriptionList',
    <DescriptionList items={[{ label: 'Reference', value: 'ENQ-2026-0001', mono: true }]} />,
  ],
  [
    'Stepper',
    <Stepper
      steps={[
        { label: 'Job', state: 'complete' },
        { label: 'Items', state: 'incomplete' },
        { label: 'Material', state: 'error' },
      ]}
      current={1}
      onSelect={() => undefined}
    />,
  ],
  ['CopyableId', <CopyableId value="a1b2c3d4e5f60718293a4b5c6d7e8f90" label="SHA-256" />],
  ['EmptyState', <EmptyState title="Nothing yet" detail="It appears here once there is something." />],
  ['LoadingState', <LoadingState label="Loading" />],
  [
    'ErrorState',
    <ErrorState message="That enquiry is not ready to be sourced." code="SOURCING_BLOCKED" correlationId="01a075a6" />,
  ],
  ['RouteError', <RouteError digest="2846135799" onRetry={() => undefined} />],
  [
    'LeakWarning',
    <LeakWarning
      action="quarantine"
      findings={[{ kind: 'phone', confidence: 'high', start: 5, end: 16, text: '98765 43210', label: 'Phone number' }]}
      body="Call 98765 43210 today"
      onEdit={() => undefined}
      onProceed={() => undefined}
    />,
  ],
  ['LiveRegion', <LiveRegion message="Draft saved" />],
  ['ButtonLink', <ButtonLink href="/enquiries/new">Create enquiry</ButtonLink>],
  ['ButtonLink (disabled)', <ButtonLink href="/quotations/q-1/accept" disabled disabledReason="This quotation has expired">Accept quote</ButtonLink>],
  ['StatusChip', <StatusChip tone="attention">Information needed</StatusChip>],
  [
    'ActionNeededCard',
    <ActionNeededCard title="Answer questions" detail="Two questions are open." action={<Button>Answer</Button>} />,
  ],
  [
    'MeasurementInput',
    <MeasurementInput label="Tightest tolerance" value={{ value: 0.05, unit: 'mm' }} onChange={() => undefined} />,
  ],
  ['MoneyInput', <MoneyInput label="Target price" value={{ amountMinor: 123450, currency: 'INR' }} onChange={() => undefined} />],
];

describe('accessibility state matrix (DS-12, DS-15, doc 13 §12)', () => {
  it.each(CASES)('%s has no axe violations', async (_name, ui) => {
    await noViolations(ui);
  });
});
