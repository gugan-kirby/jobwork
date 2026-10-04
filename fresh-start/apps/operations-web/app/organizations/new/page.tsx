'use client';

import { useState } from 'react';
import Link from 'next/link';
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
 * Adding a customer (F-OPS.4). The same shape as admitting a supplier: the organization
 * and its first invitation are created together, because an organization nobody can sign
 * into is a row somebody will have to clean up later.
 *
 * Suppliers are deliberately not creatable here — `/suppliers/new` admits them, and that
 * command also builds the supplier profile the network depends on.
 */

const CUSTOMER_ROLES = [
  { value: 'org_admin', label: 'Administrator — can invite the rest of their team' },
  { value: 'customer_requester', label: 'Requester — raises enquiries' },
  { value: 'customer_approver', label: 'Approver — approves quotes and deliveries' },
];

export default function NewOrganizationPage(): React.JSX.Element {
  const [error, setError] = useState<ApiError | null>(null);
  const [created, setCreated] = useState<{
    organizationId: string;
    invitationId?: string;
    acceptUrl?: string;
  } | null>(null);
  const [form, setForm] = useState({
    legalName: '',
    displayName: '',
    firstUserEmail: '',
    firstUserRole: 'org_admin',
  });

  const set = (patch: Partial<typeof form>): void => setForm({ ...form, ...patch });

  if (created) {
    return (
      <Page title="Customer added" breadcrumb={<Link href="/organizations">← Organizations</Link>}>
        <Stack gap={4}>
          <Callout tone="positive" title={`${form.displayName} can now be worked with`}>
            {created.invitationId
              ? 'Their first user has been invited and will set their own password.'
              : 'Nobody has been invited yet — add their first user from the organization page.'}
          </Callout>
          <Card title="What was created">
            <Stack gap={2}>
              <CopyableId label="Organization" value={created.organizationId} />
              {created.acceptUrl ? (
                <p style={{ font: 'var(--text-caption)' }}>
                  Development only — the invitation link:{' '}
                  <a href={created.acceptUrl}>{created.acceptUrl}</a>
                </p>
              ) : null}
            </Stack>
          </Card>
          <Card>
            <Link href={`/organizations/${created.organizationId}`}>
              Open {form.displayName} →
            </Link>
          </Card>
        </Stack>
      </Page>
    );
  }

  return (
    <Page
      title="Add a customer"
      breadcrumb={<Link href="/organizations">← Organizations</Link>}
      description="Creates the customer's organization and invites their first user."
      width="narrow"
    >
      <Stack gap={4}>
        {error ? (
          <Callout tone="blocked" assertive title={error.problem.title}>
            {error.problem.detail ?? 'The organization was not created.'} ({error.problem.code})
          </Callout>
        ) : null}

        <Card title="The company">
          <TextInput
            label="Registered legal name"
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
        </Card>

        <Card
          title="Their first user"
          description="They set their own password from the invitation. Leave blank to invite somebody later."
        >
          <TextInput
            label="Email"
            value={form.firstUserEmail}
            onChange={(e) => set({ firstUserEmail: e.target.value })}
          />
          <Select
            label="Their role"
            value={form.firstUserRole}
            options={CUSTOMER_ROLES}
            onChange={(e) => set({ firstUserRole: e.target.value })}
          />
          <CommandButton
            receiptLabel="Added"
            onCommand={async () => {
              setError(null);
              try {
                const result = await api<{
                  organizationId: string;
                  invitationId?: string;
                  acceptUrl?: string;
                }>('/admin/organizations', {
                  method: 'POST',
                  body: {
                    type: 'customer',
                    legalName: form.legalName.trim(),
                    displayName: form.displayName.trim(),
                    ...(form.firstUserEmail.trim()
                      ? {
                          firstUserEmail: form.firstUserEmail.trim(),
                          firstUserRoleKeys: [form.firstUserRole],
                        }
                      : {}),
                  },
                  idempotencyKey: crypto.randomUUID(),
                });
                setCreated(result);
              } catch (err) {
                if (err instanceof ApiError) setError(err);
                throw err;
              }
            }}
          >
            Add customer
          </CommandButton>
        </Card>
      </Stack>
    </Page>
  );
}
