'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { SupplierSelfView } from '@jobwork/contracts';
import {
  Callout,
  Card,
  CommandButton,
  ErrorState,
  LiveRegion,
  LoadingState,
  Page,
  Select,
  Stack,
  TextArea,
  TextInput,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * What the supplier says about itself (F-SO.3). None of it is evidence and none of it
 * moves the network state — a supplier can describe itself freely, and JobWork decides
 * separately on what it can prove.
 *
 * Saving carries the version the form was loaded at, so two people in the same account
 * end in a conversation rather than a silent overwrite.
 */

const REGIONS = [
  { value: 'chennai_metro', label: 'Chennai metro' },
  { value: 'tamil_nadu', label: 'Rest of Tamil Nadu' },
  { value: 'south_india', label: 'South India' },
  { value: 'india', label: 'Elsewhere in India' },
];

const EMPLOYEE_BANDS = ['1-10', '11-50', '51-200', '201-500', '500+'];

export default function SupplierCompanyPage(): React.JSX.Element {
  const [view, setView] = useState<SupplierSelfView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [form, setForm] = useState({
    tradeName: '',
    website: '',
    summary: '',
    regionClass: 'chennai_metro',
    yearEstablished: '',
    employeeBand: '',
    primaryContactName: '',
    primaryContactEmail: '',
    primaryContactPhone: '',
  });

  const [site, setSite] = useState({
    label: 'Works',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    gstin: '',
    contactName: '',
    contactPhone: '',
  });

  const apply = useCallback((next: SupplierSelfView) => {
    setView(next);
    setForm({
      tradeName: next.profile.tradeName,
      website: next.profile.website,
      summary: next.profile.summary,
      regionClass: next.profile.regionClass || 'chennai_metro',
      yearEstablished: next.profile.yearEstablished ? String(next.profile.yearEstablished) : '',
      employeeBand: next.profile.employeeBand ?? '',
      primaryContactName: next.profile.primaryContactName,
      primaryContactEmail: next.profile.primaryContactEmail,
      primaryContactPhone: next.profile.primaryContactPhone,
    });
    if (next.profile.worksSite) {
      const w = next.profile.worksSite;
      setSite({
        label: w.label,
        addressLine1: w.addressLine1,
        addressLine2: w.addressLine2,
        city: w.city,
        state: w.state,
        postalCode: w.postalCode,
        gstin: w.gstin ?? '',
        contactName: w.contactName,
        contactPhone: w.contactPhone,
      });
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      apply(await api<SupplierSelfView>('/suppliers/me'));
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !view) {
    return (
      <Page title="Company details">
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
      </Page>
    );
  }

  if (!view) {
    return (
      <Page title="Company details">
        <Card>
          <LoadingState label="Loading your company details" />
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title="Company details"
      breadcrumb={<Link href="/supplier">← Your account</Link>}
      description="Who you are and where you make. Your address and contact details are internal to JobWork — a customer never sees them."
    >
      <Stack gap={4}>
        {notice ? <LiveRegion message={notice} /> : null}
        {error ? (
          <Callout tone="blocked" assertive title={error.problem.title}>
            {error.problem.detail ?? 'The change was not saved.'} ({error.problem.code})
          </Callout>
        ) : null}

        <Card title="About the company">
          <TextInput
            label="Trade name"
            hint="What people call you, if it differs from the registered name."
            value={form.tradeName}
            onChange={(e) => setForm({ ...form, tradeName: e.target.value })}
          />
          <TextInput
            label="Website"
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
          />
          <TextArea
            label="What you make"
            hint="A sentence or two. Sourcing reads this when shortlisting."
            value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
          />
          <Select
            label="Where you serve"
            value={form.regionClass}
            options={REGIONS}
            onChange={(e) => setForm({ ...form, regionClass: e.target.value })}
          />
          <TextInput
            label="Year established"
            value={form.yearEstablished}
            onChange={(e) => setForm({ ...form, yearEstablished: e.target.value })}
          />
          <Select
            label="People on the shop floor"
            value={form.employeeBand}
            placeholder="Choose a size"
            options={EMPLOYEE_BANDS.map((band) => ({ value: band, label: band }))}
            onChange={(e) => setForm({ ...form, employeeBand: e.target.value })}
          />
          <TextInput
            label="Primary contact name"
            required
            value={form.primaryContactName}
            onChange={(e) => setForm({ ...form, primaryContactName: e.target.value })}
          />
          <TextInput
            label="Primary contact email"
            required
            value={form.primaryContactEmail}
            onChange={(e) => setForm({ ...form, primaryContactEmail: e.target.value })}
          />
          <TextInput
            label="Primary contact phone"
            required
            value={form.primaryContactPhone}
            onChange={(e) => setForm({ ...form, primaryContactPhone: e.target.value })}
          />
          <CommandButton
            receiptLabel="Saved"
            onCommand={async () => {
              setError(null);
              setNotice(null);
              try {
                const saved = await api<SupplierSelfView>('/suppliers/me/profile', {
                  method: 'POST',
                  body: {
                    expectedVersion: view.profile.aggregateVersion,
                    tradeName: form.tradeName,
                    website: form.website,
                    summary: form.summary,
                    regionClass: form.regionClass,
                    yearEstablished: form.yearEstablished ? Number(form.yearEstablished) : null,
                    employeeBand: form.employeeBand === '' ? null : form.employeeBand,
                    primaryContactName: form.primaryContactName,
                    primaryContactEmail: form.primaryContactEmail,
                    primaryContactPhone: form.primaryContactPhone,
                  },
                  idempotencyKey: crypto.randomUUID(),
                });
                apply(saved);
                setNotice('Company details saved.');
              } catch (err) {
                if (err instanceof ApiError) setError(err);
                throw err;
              }
            }}
          >
            Save company details
          </CommandButton>
        </Card>

        <Card
          title="Works address"
          description="Where the work actually happens. Used for logistics and for the region a customer sees — never the address itself."
        >
          <TextInput
            label="Unit name"
            required
            value={site.label}
            onChange={(e) => setSite({ ...site, label: e.target.value })}
          />
          <TextInput
            label="Address"
            required
            value={site.addressLine1}
            onChange={(e) => setSite({ ...site, addressLine1: e.target.value })}
          />
          <TextInput
            label="Address line 2"
            value={site.addressLine2}
            onChange={(e) => setSite({ ...site, addressLine2: e.target.value })}
          />
          <TextInput
            label="City"
            required
            value={site.city}
            onChange={(e) => setSite({ ...site, city: e.target.value })}
          />
          <TextInput
            label="State"
            required
            value={site.state}
            onChange={(e) => setSite({ ...site, state: e.target.value })}
          />
          <TextInput
            label="PIN code"
            required
            value={site.postalCode}
            onChange={(e) => setSite({ ...site, postalCode: e.target.value })}
          />
          <TextInput
            label="GSTIN at this address"
            hint="Optional here — GST evidence is submitted under Compliance."
            value={site.gstin}
            onChange={(e) => setSite({ ...site, gstin: e.target.value })}
          />
          <CommandButton
            receiptLabel="Saved"
            onCommand={async () => {
              setError(null);
              setNotice(null);
              try {
                const saved = await api<SupplierSelfView>('/suppliers/me/site', {
                  method: 'POST',
                  body: {
                    label: site.label,
                    addressLine1: site.addressLine1,
                    addressLine2: site.addressLine2,
                    city: site.city,
                    state: site.state,
                    postalCode: site.postalCode,
                    ...(site.gstin ? { gstin: site.gstin } : {}),
                    contactName: site.contactName,
                    contactPhone: site.contactPhone,
                  },
                  idempotencyKey: crypto.randomUUID(),
                });
                apply(saved);
                setNotice('Works address saved.');
              } catch (err) {
                if (err instanceof ApiError) setError(err);
                throw err;
              }
            }}
          >
            Save works address
          </CommandButton>
        </Card>
      </Stack>
    </Page>
  );
}
