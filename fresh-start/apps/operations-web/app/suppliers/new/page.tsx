'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AdmitSupplierResponse, SupplierApplication } from '@jobwork/contracts';
import {
  Callout,
  Card,
  CommandButton,
  CopyableId,
  Page,
  Select,
  Stack,
  TextInput,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * Admission (F-SO.2). JobWork types the little it knows — the legal entity and one
 * person to talk to — and the supplier fills in the rest itself. Asking an admin to key
 * in machines and certificates on a supplier's behalf produces a record nobody owns and
 * nobody maintains.
 *
 * The identity fields are optional here on purpose: if sourcing has the GSTIN, entering
 * it catches a duplicate before an account exists; if not, the supplier submits it with
 * evidence later and the same check runs then.
 */

const REGIONS = [
  { value: 'chennai_metro', label: 'Chennai metro' },
  { value: 'tamil_nadu', label: 'Rest of Tamil Nadu' },
  { value: 'south_india', label: 'South India' },
  { value: 'india', label: 'Elsewhere in India' },
];

const FIRST_USER_ROLES = [
  { value: 'org_admin', label: 'Administrator — can invite the rest of their team' },
  { value: 'supplier_estimator', label: 'Estimator' },
  { value: 'supplier_production', label: 'Production' },
  { value: 'supplier_quality', label: 'Quality' },
];

export default function AdmitSupplierPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <AdmitSupplierForm />
    </Suspense>
  );
}

/**
 * F-MX.4: arriving with `?application=` prefills the form from a network application
 * and closes that application in the same transaction as the admission.
 */
function AdmitSupplierForm(): React.JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const applicationId = params.get('application');
  const [application, setApplication] = useState<SupplierApplication | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [admitted, setAdmitted] = useState<AdmitSupplierResponse | null>(null);
  const [form, setForm] = useState({
    legalName: '',
    displayName: '',
    tradeName: '',
    regionClass: 'chennai_metro',
    primaryContactName: '',
    primaryContactEmail: '',
    primaryContactPhone: '',
    gstin: '',
    pan: '',
    firstUserEmail: '',
    firstUserRole: 'org_admin',
  });

  const set = (patch: Partial<typeof form>): void => setForm({ ...form, ...patch });

  useEffect(() => {
    if (!applicationId) return;
    api<SupplierApplication>(`/supplier-applications/${applicationId}`)
      .then((app) => {
        setApplication(app);
        setForm((current) => ({
          ...current,
          legalName: current.legalName || app.companyName,
          displayName: current.displayName || app.companyName,
          primaryContactName: current.primaryContactName || app.contactName,
          primaryContactEmail: current.primaryContactEmail || app.email,
          primaryContactPhone: current.primaryContactPhone || app.phone,
          firstUserEmail: current.firstUserEmail || app.email,
        }));
      })
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, [applicationId]);

  if (admitted) {
    return (
      <Page title="Supplier admitted" breadcrumb={<Link href="/suppliers">← Suppliers</Link>}>
        <Stack gap={4}>
          <Callout tone="positive" title="The account exists and the invitation is on its way">
            They now complete their own profile, capabilities and evidence. You will see the
            file here when they send it for a decision.
          </Callout>
          <Card title="What was created">
            <Stack gap={2}>
              <CopyableId label="Supplier profile" value={admitted.supplierProfileId} />
              <CopyableId label="Organization" value={admitted.organizationId} />
              {admitted.acceptUrl ? (
                <p style={{ font: 'var(--text-caption)' }}>
                  Development only — the invitation link:{' '}
                  <a href={admitted.acceptUrl}>{admitted.acceptUrl}</a>
                </p>
              ) : null}
            </Stack>
          </Card>
          <Card>
            <Link href={`/suppliers/${admitted.supplierProfileId}`}>Open the supplier →</Link>
          </Card>
        </Stack>
      </Page>
    );
  }

  return (
    <Page
      title="Add a supplier"
      breadcrumb={<Link href="/suppliers">← Suppliers</Link>}
      description="Creates the supplier's account and invites their first user. They describe themselves; you decide afterwards."
      width="narrow"
    >
      <Stack gap={4}>
        {error ? (
          <Callout tone="blocked" assertive title={error.problem.title}>
            {error.problem.detail ?? 'The supplier was not created.'} ({error.problem.code})
          </Callout>
        ) : null}

        {application ? (
          <Callout
            tone={application.status === 'received' ? 'progress' : 'attention'}
            title={`From application by ${application.companyName}`}
          >
            {application.status === 'received'
              ? `Received ${application.createdAt.slice(0, 10)}${application.city ? ` · ${application.city}` : ''}${
                  application.processCodes.length
                    ? ` · claims ${application.processCodes.map((c) => c.replace(/_/g, ' ')).join(', ')}`
                    : ''
                }. ${application.note ? `They wrote: “${application.note}”` : ''} Admitting closes the application.`
              : `This application is already ${application.status}; admitting again would create a second supplier.`}
          </Callout>
        ) : null}

        <Card title="The company">
          <TextInput
            label="Registered legal name"
            hint="Exactly as it appears on the GST certificate."
            required
            value={form.legalName}
            onChange={(e) => set({ legalName: e.target.value })}
          />
          <TextInput
            label="Name we call them"
            required
            value={form.displayName}
            onChange={(e) => set({ displayName: e.target.value })}
          />
          <TextInput
            label="Trade name"
            value={form.tradeName}
            onChange={(e) => set({ tradeName: e.target.value })}
          />
          <Select
            label="Region"
            value={form.regionClass}
            options={REGIONS}
            onChange={(e) => set({ regionClass: e.target.value })}
          />
          <TextInput
            label="GSTIN"
            hint="Optional. Entering it now catches a company already on the network."
            value={form.gstin}
            onChange={(e) => set({ gstin: e.target.value.toUpperCase() })}
          />
          <TextInput
            label="PAN"
            value={form.pan}
            onChange={(e) => set({ pan: e.target.value.toUpperCase() })}
          />
        </Card>

        <Card title="Who to talk to">
          <TextInput
            label="Contact name"
            required
            value={form.primaryContactName}
            onChange={(e) => set({ primaryContactName: e.target.value })}
          />
          <TextInput
            label="Contact email"
            required
            value={form.primaryContactEmail}
            onChange={(e) =>
              set({
                primaryContactEmail: e.target.value,
                // The first login is almost always the contact; still editable below.
                firstUserEmail: form.firstUserEmail || e.target.value,
              })
            }
          />
          <TextInput
            label="Contact phone"
            value={form.primaryContactPhone}
            onChange={(e) => set({ primaryContactPhone: e.target.value })}
          />
        </Card>

        <Card
          title="Their first login"
          description="They set their own password from the invitation. JobWork never knows it."
        >
          <TextInput
            label="Invite this email"
            required
            value={form.firstUserEmail}
            onChange={(e) => set({ firstUserEmail: e.target.value })}
          />
          <Select
            label="Their role"
            value={form.firstUserRole}
            options={FIRST_USER_ROLES}
            onChange={(e) => set({ firstUserRole: e.target.value })}
          />
          <CommandButton
            receiptLabel="Admitted"
            onCommand={async () => {
              setError(null);
              try {
                const result = await api<AdmitSupplierResponse>('/suppliers', {
                  method: 'POST',
                  body: {
                    legalName: form.legalName.trim(),
                    displayName: form.displayName.trim(),
                    tradeName: form.tradeName.trim(),
                    regionClass: form.regionClass,
                    primaryContactName: form.primaryContactName.trim(),
                    primaryContactEmail: form.primaryContactEmail.trim(),
                    primaryContactPhone: form.primaryContactPhone.trim(),
                    ...(form.gstin.trim() ? { gstin: form.gstin.trim() } : {}),
                    ...(form.pan.trim() ? { pan: form.pan.trim() } : {}),
                    firstUserEmail: form.firstUserEmail.trim(),
                    firstUserRoleKeys: [form.firstUserRole],
                    ...(applicationId ? { applicationId } : {}),
                  },
                  idempotencyKey: crypto.randomUUID(),
                });
                setAdmitted(result);
                router.refresh();
              } catch (err) {
                if (err instanceof ApiError) setError(err);
                throw err;
              }
            }}
          >
            Admit supplier and invite
          </CommandButton>
        </Card>
      </Stack>
    </Page>
  );
}
