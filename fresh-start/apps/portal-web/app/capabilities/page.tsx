'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type {
  CapabilityRef,
  CapacityWindow,
  Machine,
  SupplierCapability,
  VerificationItem,
} from '@jobwork/contracts';
import {
  Button,
  Card,
  CommandButton,
  DescriptionList,
  ErrorState,
  Inline,
  LiveRegion,
  Page,
  Select,
  Stack,
  StatusChip,
  TextInput,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * The supplier's own record (UC-11, `FR-201`): what it can do, what it runs, when it
 * has room, and where its verification stands.
 *
 * Editing publishes a new version rather than changing the old one — the page says so
 * plainly, because a supplier who believes an edit rewrites history will be surprised
 * when an old RFQ still quotes the previous declaration.
 */
export default function CapabilitiesPage() {
  const [taxonomy, setTaxonomy] = useState<CapabilityRef[]>([]);
  const [capabilities, setCapabilities] = useState<SupplierCapability[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [windows, setWindows] = useState<CapacityWindow[]>([]);
  const [verification, setVerification] = useState<VerificationItem[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [code, setCode] = useState('');
  const [tolerance, setTolerance] = useState('');
  const [machineKey, setMachineKey] = useState('');
  const [machineLabel, setMachineLabel] = useState('');
  const [envelope, setEnvelope] = useState({ xMm: '', yMm: '', zMm: '' });
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [hours, setHours] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [tax, caps, mach, cap, ver] = await Promise.all([
        api<{ capabilities: CapabilityRef[] }>('/suppliers/me/taxonomy'),
        api<{ capabilities: SupplierCapability[] }>('/suppliers/me/capabilities'),
        api<{ machines: Machine[] }>('/suppliers/me/machines'),
        api<{ windows: CapacityWindow[] }>('/suppliers/me/capacity'),
        api<{ items: VerificationItem[] }>('/suppliers/me/verification'),
      ]);
      setTaxonomy(tax.capabilities);
      setCapabilities(caps.capabilities);
      setMachines(mach.machines);
      setWindows(cap.windows);
      setVerification(ver.items);
      if (!code && tax.capabilities[0]) setCode(tax.capabilities[0].code);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [code]);

  useEffect(() => {
    void load();
    // Loaded once; each publish refreshes explicitly.
  }, []);

  /**
   * Withdrawing changes what JobWork matches tomorrow and nothing about yesterday: the
   * version stays readable, because RFQs were run against it (UC-11).
   */
  async function withdraw(
    kind: 'capability' | 'machine' | 'capacity',
    declarationId: string,
    label: string,
  ): Promise<void> {
    setError(null);
    try {
      await api(`/suppliers/me/declarations/${kind}/${declarationId}/withdraw`, {
        method: 'POST',
        body: {},
        idempotencyKey: crypto.randomUUID(),
      });
      setNotice(`${label} withdrawn. JobWork stops matching you for it; past versions stay.`);
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      throw err;
    }
  }

  async function send(path: string, body: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body, idempotencyKey: crypto.randomUUID() });
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    } finally {
      setBusy(false);
    }
  }

  const latestByKind = new Map<string, VerificationItem>();
  for (const item of verification) if (!latestByKind.has(item.kind)) latestByKind.set(item.kind, item);

  const verificationTone = (status: VerificationItem['status']): Tone => {
    if (status === 'verified') return 'positive';
    if (status === 'expiring') return 'attention';
    if (['expired', 'revoked', 'returned_for_evidence'].includes(status)) return 'blocked';
    return 'progress';
  };

  return (
    <Page
      title="Capabilities"
      breadcrumb={<Link href="/">← Portal</Link>}
      description="Publishing an edit adds a new version. Earlier versions stay exactly as they were, because enquiries already matched against them."
    >
      <Stack gap={4}>
        {notice ? <LiveRegion message={notice} /> : null}
        {error ? (
          <ErrorState
            message={error.problem.detail ?? error.problem.title}
            code={error.problem.code}
          />
        ) : null}

        <Card
          title="Verification"
          description="JobWork needs GST, PAN and bank evidence before you can be matched to work."
        >
          {latestByKind.size === 0 ? (
            <p style={{ color: 'var(--color-text-muted)' }}>No evidence submitted yet.</p>
          ) : (
            <ul style={{ listStyle: 'none' }}>
              {[...latestByKind.values()].map((item) => (
                <li
                  key={item.verificationItemId}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-3)',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    padding: 'var(--space-2) 0',
                  }}
                >
                  <span style={{ minWidth: 140, font: 'var(--text-body-strong)' }}>
                    {item.kind.replace(/_/g, ' ')}
                  </span>
                  <StatusChip tone={verificationTone(item.status)}>
                    {item.status.replace(/_/g, ' ')}
                  </StatusChip>
                  <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                    v{item.versionNo}
                    {item.expiresAt
                      ? ` · expires ${new Date(item.expiresAt).toLocaleDateString('en-IN')}`
                      : ''}
                    {item.reviewReason ? ` · ${item.reviewReason}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Processes and materials">
          <Inline gap={3} align="flex-end">
            <div style={{ minWidth: 260 }}>
              <Select
                label="Capability"
                value={code}
                options={taxonomy.map((entry) => ({
                  value: entry.code,
                  label: `${entry.label} (${entry.kind})`,
                }))}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <div style={{ width: 160 }}>
              <TextInput
                label="Tolerance class"
                placeholder="IT7"
                value={tolerance}
                onChange={(event) => setTolerance(event.target.value)}
              />
            </div>
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <Button
                busy={busy}
                disabled={!code}
                disabledReason="Choose a capability first"
                onClick={() =>
                  void send('/suppliers/me/capabilities', {
                    capabilityCode: code,
                    attributes: tolerance ? { toleranceClass: tolerance } : {},
                  })
                }
              >
                Publish version
              </Button>
            </div>
          </Inline>

          {capabilities.length > 0 ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {capabilities.map((entry) => (
                <li
                  key={entry.supplierCapabilityId}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-3)',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    padding: 'var(--space-2) 0',
                    borderBottom: 'var(--hairline) solid var(--color-border)',
                  }}
                >
                  <span style={{ font: 'var(--text-body-strong)' }}>{entry.capability.label}</span>
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    v{entry.versionNo}
                    {Object.keys(entry.attributes).length > 0
                      ? ` · ${Object.entries(entry.attributes)
                          .map(([key, value]) => `${key}: ${String(value)}`)
                          .join(', ')}`
                      : ''}
                  </span>
                  <span style={{ marginLeft: 'auto' }}>
                    <CommandButton
                      size="sm"
                      variant="secondary"
                      receiptLabel="Withdrawn"
                      onCommand={() =>
                        withdraw('capability', entry.supplierCapabilityId, entry.capability.label)
                      }
                    >
                      Stop offering
                    </CommandButton>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: 'var(--color-text-muted)' }}>
              Nothing published yet — you will not appear in matching until at least one
              capability is live.
            </p>
          )}
        </Card>

        <Card title="Machines">
          <Inline gap={3} align="flex-end">
            <div style={{ width: 140 }}>
              <TextInput
                label="Key"
                placeholder="vmc-01"
                value={machineKey}
                onChange={(event) => setMachineKey(event.target.value)}
              />
            </div>
            <div style={{ width: 200 }}>
              <TextInput
                label="Label"
                placeholder="VMC 850"
                value={machineLabel}
                onChange={(event) => setMachineLabel(event.target.value)}
              />
            </div>
            {(['xMm', 'yMm', 'zMm'] as const).map((axis) => (
              <div key={axis} style={{ width: 100 }}>
                <TextInput
                  label={`${axis.replace('Mm', '').toUpperCase()} (mm)`}
                  inputMode="numeric"
                  numeric
                  value={envelope[axis]}
                  onChange={(event) =>
                    setEnvelope((prev) => ({ ...prev, [axis]: event.target.value }))
                  }
                />
              </div>
            ))}
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <Button
                busy={busy}
                disabled={!machineKey || !machineLabel}
                disabledReason="A machine needs a key and a label"
                onClick={() =>
                  void send('/suppliers/me/machines', {
                    machineKey,
                    label: machineLabel,
                    quantity: 1,
                    envelope: {
                      xMm: Number(envelope.xMm),
                      yMm: Number(envelope.yMm),
                      zMm: Number(envelope.zMm),
                    },
                  })
                }
              >
                Publish machine
              </Button>
            </div>
          </Inline>

          {machines.length > 0 ? (
            <DescriptionList
              columns={2}
              items={machines.map((machine) => ({
                label: machine.label,
                value: `v${machine.versionNo} · ${machine.envelope.xMm}×${machine.envelope.yMm}×${machine.envelope.zMm} mm · ×${machine.quantity}`,
                numeric: true,
              }))}
            />
          ) : null}
        </Card>

        <Card title="Capacity">
          <Inline gap={3} align="flex-end">
            <div style={{ width: 190 }}>
              <TextInput
                label="From"
                type="date"
                value={windowStart}
                onChange={(event) => setWindowStart(event.target.value)}
              />
            </div>
            <div style={{ width: 190 }}>
              <TextInput
                label="To"
                type="date"
                value={windowEnd}
                onChange={(event) => setWindowEnd(event.target.value)}
              />
            </div>
            <div style={{ width: 150 }}>
              <TextInput
                label="Hours available"
                inputMode="numeric"
                numeric
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              />
            </div>
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <Button
                busy={busy}
                disabled={!windowStart || !windowEnd}
                disabledReason="A window needs both dates"
                onClick={() =>
                  void send('/suppliers/me/capacity', {
                    windowStart,
                    windowEnd,
                    ...(hours ? { availableHours: Number(hours) } : {}),
                  })
                }
              >
                Declare window
              </Button>
            </div>
          </Inline>

          {windows.length > 0 ? (
            <DescriptionList
              columns={2}
              items={windows.map((window) => ({
                label: `${window.windowStart} → ${window.windowEnd}`,
                value: `v${window.versionNo}${window.availableHours !== null ? ` · ${window.availableHours} h` : ''}`,
                numeric: true,
              }))}
            />
          ) : null}
        </Card>
      </Stack>
    </Page>
  );
}
