'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  ErrorState,
  ErrorSummary,
  Stack,
  TextArea,
  TextInput,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { PublicFrame } from '../public-frame';

/**
 * Register (prototype tile 3). Two tabs, two different outcomes, and the page says so:
 *
 *  - **Customer** creates an account that works once the email is confirmed (doc 20 §2).
 *  - **Supplier** sends an *application*. Admission to the network is JobWork's decision
 *    (F-SO); the form promises a review, not a login.
 *
 * The prototype's "Vendor" wording is corrected to "Supplier" throughout (doc 14 §2).
 */

type Audience = 'customer' | 'supplier';

interface PublicCategory {
  code: string;
  label: string;
  processes: Array<{ code: string; label: string }>;
}

export default function RegisterPage() {
  const [audience, setAudience] = useState<Audience>('customer');

  return (
    <PublicFrame
      title="Register"
      lede="Tell us who you are. A customer account is ready as soon as you confirm your email; a workshop's application is reviewed by JobWork."
      footer={
        <p>
          Already have an account? <Link href="/login">Login</Link>
        </p>
      }
    >
      <div
        role="group"
        aria-label="I am a"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-2)',
          padding: 'var(--space-1)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface-tint)',
        }}
      >
        {(['customer', 'supplier'] as const).map((option) => (
          <Button
            key={option}
            variant={audience === option ? 'primary' : 'ghost'}
            aria-pressed={audience === option}
            onClick={() => setAudience(option)}
          >
            {option === 'customer' ? 'Customer' : 'Supplier'}
          </Button>
        ))}
      </div>

      {audience === 'customer' ? <CustomerForm /> : <SupplierForm />}
    </PublicFrame>
  );
}

function CustomerForm(): React.JSX.Element {
  const [form, setForm] = useState({
    fullName: '',
    mobile: '',
    email: '',
    password: '',
    confirm: '',
    organizationName: '',
    acceptTerms: false,
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ verifyUrl?: string } | null>(null);
  const set = (patch: Partial<typeof form>): void => setForm({ ...form, ...patch });

  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ verifyUrl?: string }>('/auth/register', {
        method: 'POST',
        body: {
          fullName: form.fullName,
          mobile: form.mobile,
          email: form.email,
          password: form.password,
          organizationName: form.organizationName,
          acceptTerms: form.acceptTerms,
        },
      });
      setDone(res);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Callout tone="positive" title="Check your email">
        <p>
          We sent a confirmation link to <strong>{form.email}</strong>. Open it to activate your
          account, then sign in. The link works once and expires in a day.
        </p>
        {done.verifyUrl ? (
          <p style={{ marginTop: 'var(--space-2)', font: 'var(--text-caption)' }}>
            Development only — <a href={done.verifyUrl}>confirm now</a>
          </p>
        ) : null}
      </Callout>
    );
  }

  return (
    <Card>
      <form onSubmit={submit}>
        <Stack gap={3}>
          {error ? (
            error.problem.errors?.length ? (
              <ErrorSummary issues={error.problem.errors} />
            ) : (
              <ErrorState
                title={error.problem.title}
                message={error.problem.detail ?? ''}
                code={error.problem.code}
              />
            )
          ) : null}
          <TextInput
            label="Full name"
            autoComplete="name"
            required
            value={form.fullName}
            onChange={(e) => set({ fullName: e.target.value })}
          />
          <TextInput
            label="Mobile number"
            type="tel"
            autoComplete="tel"
            value={form.mobile}
            onChange={(e) => set({ mobile: e.target.value })}
          />
          <TextInput
            label="Email address"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
          />
          <TextInput
            label="Company (optional)"
            hint="The organization your enquiries belong to. You can invite colleagues later."
            autoComplete="organization"
            value={form.organizationName}
            onChange={(e) => set({ organizationName: e.target.value })}
          />
          <TextInput
            label="Password"
            type="password"
            autoComplete="new-password"
            hint="At least 12 characters."
            required
            value={form.password}
            onChange={(e) => set({ password: e.target.value })}
          />
          <TextInput
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            required
            value={form.confirm}
            {...(mismatch ? { error: 'The two passwords do not match' } : {})}
            onChange={(e) => set({ confirm: e.target.value })}
          />
          <Checkbox
            label="I agree to the Terms & Conditions"
            checked={form.acceptTerms}
            onChange={(e) => set({ acceptTerms: e.target.checked })}
          />
          <p style={{ font: 'var(--text-caption)' }}>
            <Link href="/terms">Read the terms</Link>
          </p>
          <Button
            type="submit"
            busy={busy}
            fullWidth
            disabled={!form.acceptTerms || mismatch}
            disabledReason={!form.acceptTerms ? 'Accept the terms to continue' : 'Fix the password mismatch'}
          >
            Register
          </Button>
        </Stack>
      </form>
    </Card>
  );
}

function SupplierForm(): React.JSX.Element {
  const [families, setFamilies] = useState<PublicCategory[]>([]);
  const [form, setForm] = useState({
    companyName: '',
    contactName: '',
    mobile: '',
    email: '',
    city: '',
    processCodes: [] as string[],
    note: '',
    acceptTerms: false,
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (patch: Partial<typeof form>): void => setForm({ ...form, ...patch });

  useEffect(() => {
    api<{ families: PublicCategory[] }>('/public/categories')
      .then((res) => setFamilies(res.families))
      .catch(() => setFamilies([]));
  }, []);

  function toggle(code: string): void {
    set({
      processCodes: form.processCodes.includes(code)
        ? form.processCodes.filter((c) => c !== code)
        : [...form.processCodes, code],
    });
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/public/supplier-applications', {
        method: 'POST',
        body: {
          companyName: form.companyName,
          contactName: form.contactName,
          phone: form.mobile,
          email: form.email,
          city: form.city,
          processCodes: form.processCodes,
          note: form.note,
          acceptTerms: form.acceptTerms,
        },
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Callout tone="positive" title="Application received">
        Thank you. A JobWork sourcing reviewer looks at every application. If your workshop fits
        what we source, we will email <strong>{form.email}</strong> an invitation to set up your
        account and complete your file. Nothing is published to customers at any stage.
      </Callout>
    );
  }

  return (
    <Card>
      <form onSubmit={submit}>
        <Stack gap={3}>
          <Callout tone="neutral" title="This is an application, not an account">
            JobWork admits workshops after review. Tell us what you do and we will come back
            to you.
          </Callout>
          {error ? (
            error.problem.errors?.length ? (
              <ErrorSummary issues={error.problem.errors} />
            ) : (
              <ErrorState
                title={error.problem.title}
                message={error.problem.detail ?? ''}
                code={error.problem.code}
              />
            )
          ) : null}
          <TextInput
            label="Company name"
            autoComplete="organization"
            required
            value={form.companyName}
            onChange={(e) => set({ companyName: e.target.value })}
          />
          <TextInput
            label="Contact name"
            autoComplete="name"
            required
            value={form.contactName}
            onChange={(e) => set({ contactName: e.target.value })}
          />
          <TextInput
            label="Mobile number"
            type="tel"
            autoComplete="tel"
            value={form.mobile}
            onChange={(e) => set({ mobile: e.target.value })}
          />
          <TextInput
            label="Email address"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
          />
          <TextInput
            label="City"
            autoComplete="address-level2"
            value={form.city}
            onChange={(e) => set({ city: e.target.value })}
          />

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ font: 'var(--text-body-strong)', marginBottom: 'var(--space-2)' }}>
              What you do
            </legend>
            <Stack gap={2}>
              {families.map((family) => (
                <div key={family.code}>
                  <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                    {family.label}
                  </p>
                  {family.processes.map((process) => (
                    <Checkbox
                      key={process.code}
                      label={process.label}
                      checked={form.processCodes.includes(process.code)}
                      onChange={() => toggle(process.code)}
                    />
                  ))}
                </div>
              ))}
            </Stack>
          </fieldset>

          <TextArea
            label="Anything else"
            hint="Machines, shifts, certifications, the kind of work you do best."
            value={form.note}
            onChange={(e) => set({ note: e.target.value })}
          />
          <Checkbox
            label="I agree to the Terms & Conditions"
            checked={form.acceptTerms}
            onChange={(e) => set({ acceptTerms: e.target.checked })}
          />
          <p style={{ font: 'var(--text-caption)' }}>
            <Link href="/terms">Read the terms</Link>
          </p>
          <Button
            type="submit"
            busy={busy}
            fullWidth
            disabled={!form.acceptTerms}
            disabledReason="Accept the terms to continue"
          >
            Send application
          </Button>
        </Stack>
      </form>
    </Card>
  );
}
