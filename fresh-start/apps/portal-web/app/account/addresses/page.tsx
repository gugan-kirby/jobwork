'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { OrganizationSite } from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  DataTable,
  ErrorState,
  Inline,
  LiveRegion,
  Page,
  Stack,
  StatusChip,
  TextInput,
  type Column,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * The customer's address book (F-CX.3). Deliveries go somewhere real, and until now the
 * portal never asked where — the enquiry carried a delivery-site column nobody could
 * fill in.
 *
 * Addresses are archived rather than deleted: an enquiry that shipped to an address must
 * still be able to say so, long after the plant closed.
 */

const EMPTY = {
  siteId: '',
  label: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  contactName: '',
  contactPhone: '',
};

export default function AddressesPage(): React.JSX.Element {
  const [sites, setSites] = useState<OrganizationSite[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ sites: OrganizationSite[] }>('/organizations/me/sites');
      setSites(res.sites);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      setSites([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(site: OrganizationSite): void {
    setForm({
      siteId: site.siteId,
      label: site.label,
      addressLine1: site.addressLine1,
      addressLine2: site.addressLine2,
      city: site.city,
      state: site.state,
      postalCode: site.postalCode,
      contactName: site.contactName,
      contactPhone: site.contactPhone,
    });
    setEditing(true);
  }

  const columns: Array<Column<OrganizationSite>> = [
    { key: 'label', header: 'Name', render: (site) => site.label },
    {
      key: 'address',
      header: 'Address',
      render: (site) =>
        `${site.addressLine1}${site.addressLine2 ? `, ${site.addressLine2}` : ''}, ${site.city}, ${site.state} ${site.postalCode}`,
    },
    {
      key: 'contact',
      header: 'Receives it',
      render: (site) => (site.contactName ? `${site.contactName} · ${site.contactPhone}` : '—'),
    },
    {
      key: 'status',
      header: 'Status',
      render: (site) => (
        <StatusChip tone={site.status === 'active' ? 'positive' : 'neutral'} silent>
          {site.status}
        </StatusChip>
      ),
    },
    {
      key: 'actions',
      header: 'Action',
      render: (site) => (
        <Inline gap={2}>
          <Button size="sm" variant="secondary" onClick={() => edit(site)}>
            Edit
          </Button>
          <CommandButton
            size="sm"
            variant="danger"
            receiptLabel="Archived"
            onCommand={async () => {
              await api(`/organizations/me/sites/${site.siteId}/archive`, {
                method: 'POST',
                body: {},
                idempotencyKey: crypto.randomUUID(),
              });
              setNotice(`${site.label} archived. Enquiries that used it are unchanged.`);
              await load();
            }}
          >
            Archive
          </CommandButton>
        </Inline>
      ),
    },
  ];

  return (
    <Page
      title="Delivery addresses"
      breadcrumb={<Link href="/">← Portal</Link>}
      description="Where your finished parts go. You choose one of these when you raise an enquiry."
    >
      <Stack gap={4}>
        {notice ? <LiveRegion message={notice} /> : null}
        {error ? (
          <ErrorState
            message={error.problem.detail ?? error.problem.title}
            code={error.problem.code}
          />
        ) : null}

        <Card flush>
          <DataTable
            caption="Your saved delivery addresses"
            columns={columns}
            rows={sites}
            rowKey={(site) => site.siteId}
            stackTitle={(site) => site.label}
            loadingLabel="Loading your addresses"
            empty={{
              title: 'No addresses yet',
              detail: 'Add the address your parts should be delivered to.',
            }}
          />
        </Card>

        <Card title={editing ? 'Edit address' : 'Add an address'}>
          {editing ? (
            <Callout tone="neutral">
              Editing {form.label}. Enquiries already sent keep the address as it was when they
              were submitted.
            </Callout>
          ) : null}
          <TextInput
            label="Name for this address"
            hint="What you call it — “Ambattur plant”, “Head office”."
            required
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
          <TextInput
            label="Address"
            required
            value={form.addressLine1}
            onChange={(e) => setForm({ ...form, addressLine1: e.target.value })}
          />
          <TextInput
            label="Address line 2"
            value={form.addressLine2}
            onChange={(e) => setForm({ ...form, addressLine2: e.target.value })}
          />
          <TextInput
            label="City"
            required
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
          />
          <TextInput
            label="State"
            required
            value={form.state}
            onChange={(e) => setForm({ ...form, state: e.target.value })}
          />
          <TextInput
            label="PIN code"
            required
            value={form.postalCode}
            onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
          />
          <TextInput
            label="Who receives it"
            value={form.contactName}
            onChange={(e) => setForm({ ...form, contactName: e.target.value })}
          />
          <TextInput
            label="Their phone"
            value={form.contactPhone}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
          />
          <Inline gap={2}>
            <CommandButton
              receiptLabel="Saved"
              onCommand={async () => {
                setError(null);
                try {
                  await api('/organizations/me/sites', {
                    method: 'POST',
                    body: {
                      ...(form.siteId ? { siteId: form.siteId } : {}),
                      label: form.label,
                      kind: 'delivery',
                      addressLine1: form.addressLine1,
                      addressLine2: form.addressLine2,
                      city: form.city,
                      state: form.state,
                      postalCode: form.postalCode,
                      contactName: form.contactName,
                      contactPhone: form.contactPhone,
                    },
                    idempotencyKey: crypto.randomUUID(),
                  });
                  setNotice(`${form.label} saved.`);
                  setForm(EMPTY);
                  setEditing(false);
                  await load();
                } catch (err) {
                  if (err instanceof ApiError) setError(err);
                  throw err;
                }
              }}
            >
              {editing ? 'Save changes' : 'Add address'}
            </CommandButton>
            {editing ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setForm(EMPTY);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </Inline>
        </Card>
      </Stack>
    </Page>
  );
}
