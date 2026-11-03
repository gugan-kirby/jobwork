'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import {
  Callout,
  Checkbox,
  ErrorState,
  ErrorSummary,
  IconTextInput,
  Stack,
  TextArea,
  TopBar,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * Register (prototype tile 3). Two tabs, two different outcomes, and the page says so:
 *
 *  - **Customer** creates an account that works once the email is confirmed (doc 20 §2).
 *  - **Supplier** sends an *application*. Admission to the network is JobWork's decision
 *    (F-SO); the form promises a review, not a login.
 *
 * The prototype's "Vendor" wording is corrected to "Supplier" throughout (doc 14 §2).
 *
 * VF-03 layout (reference screen 03): back header, two-way switch, glyph fields with
 * the label as placeholder (still a real label), inline terms link, a 54 px action.
 * Fields are checked in the browser before the request — the API still decides (422s
 * land in the error summary) — and a field's message shows once it has been left or the
 * form has been tried.
 */

const MOBILE = /^(\+91[\s-]?)?[6-9]\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 12;

function mobileError(value: string): string | undefined {
  const v = value.replace(/[\s-]/g, '');
  return v && !MOBILE.test(v) ? 'Enter a 10-digit mobile number' : undefined;
}

function emailError(value: string): string | undefined {
  if (!value.trim()) return 'Enter your email address';
  return EMAIL.test(value.trim()) ? undefined : 'Enter an email address like name@company.com';
}

function required(value: string, message: string): string | undefined {
  return value.trim().length >= 2 ? undefined : message;
}

/** Shows a field's message after it was left once, or after the form was tried. */
function useTouched(): {
  shown: (name: string) => boolean;
  touch: (name: string) => () => void;
  tryAll: () => void;
} {
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [tried, setTried] = useState(false);
  return {
    shown: (name) => tried || touched.has(name),
    touch: (name) => () => setTouched((t) => new Set(t).add(name)),
    tryAll: () => setTried(true),
  };
}

function TermsAgreement({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className="jw-agree">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>
        I agree to{' '}
        <Link href="/terms" target="_blank" rel="noopener">
          Terms &amp; Conditions
        </Link>
      </label>
    </div>
  );
}

function ProblemBlock({ error }: { error: ApiError | null }): React.JSX.Element | null {
  if (!error) return null;
  return error.problem.errors?.length ? (
    <ErrorSummary issues={error.problem.errors} />
  ) : (
    <ErrorState title={error.problem.title} message={error.problem.detail ?? ''} code={error.problem.code} />
  );
}

function SubmitButton({
  busy,
  disabled,
  reason,
  children,
}: {
  busy: boolean;
  disabled: boolean;
  reason: string;
  children: string;
}): React.JSX.Element {
  const reasonId = useId();
  return (
    <>
      <button
        type="submit"
        className="jw-cta"
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        aria-describedby={disabled ? reasonId : undefined}
      >
        {busy ? 'Sending…' : children}
      </button>
      {disabled ? (
        <p id={reasonId} className="jw-visually-hidden">
          {reason}
        </p>
      ) : null}
    </>
  );
}

type Audience = 'customer' | 'supplier';

interface PublicCategory {
  code: string;
  label: string;
  processes: Array<{ code: string; label: string }>;
}

export default function RegisterPage() {
  const [audience, setAudience] = useState<Audience>('customer');

  return (
    <div className="jw-form-page">
      <TopBar title="Register" back="/start" />

      <div role="group" aria-label="I am a" className="jw-segment">
        {(['customer', 'supplier'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={audience === option}
            onClick={() => setAudience(option)}
          >
            {option === 'customer' ? 'Customer' : 'Supplier'}
          </button>
        ))}
      </div>

      {audience === 'customer' ? <CustomerForm /> : <SupplierForm />}

      <p className="jw-form-foot">
        Already have an account?{' '}
        <Link href="/login" className="jw-inline-link">
          Login
        </Link>
      </p>
    </div>
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
  const { shown, touch, tryAll } = useTouched();
  const set = (patch: Partial<typeof form>): void => setForm({ ...form, ...patch });

  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;
  const issues = {
    fullName: required(form.fullName, 'Enter your full name'),
    mobile: mobileError(form.mobile),
    email: emailError(form.email),
    organizationName:
      form.organizationName && form.organizationName.trim().length < 2 ? 'Enter at least 2 characters' : undefined,
    password:
      form.password.length >= MIN_PASSWORD ? undefined : `Use at least ${MIN_PASSWORD} characters`,
    confirm: mismatch ? 'The two passwords do not match' : form.confirm ? undefined : 'Enter the password again',
  };
  const show = (name: keyof typeof issues): string | undefined =>
    name === 'confirm' && mismatch ? issues.confirm : shown(name) ? issues[name] : undefined;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    tryAll();
    if (Object.values(issues).some(Boolean)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ verifyUrl?: string }>('/auth/register', {
        method: 'POST',
        body: {
          fullName: form.fullName.trim(),
          mobile: form.mobile.trim(),
          email: form.email.trim(),
          password: form.password,
          organizationName: form.organizationName.trim(),
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
    <form onSubmit={submit} noValidate className="jw-form-stack">
      <ProblemBlock error={error} />
      <IconTextInput
        icon="profile"
        label="Full Name"
        autoComplete="name"
        required
        value={form.fullName}
        error={show('fullName')}
        onBlur={touch('fullName')}
        onChange={(e) => set({ fullName: e.target.value })}
      />
      <IconTextInput
        icon="phone"
        label="Mobile Number"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={form.mobile}
        error={show('mobile')}
        onBlur={touch('mobile')}
        onChange={(e) => set({ mobile: e.target.value })}
      />
      <IconTextInput
        icon="mail"
        label="Email Address"
        type="email"
        autoComplete="email"
        required
        value={form.email}
        error={show('email')}
        onBlur={touch('email')}
        onChange={(e) => set({ email: e.target.value })}
      />
      <IconTextInput
        icon="factory"
        label="Company (optional)"
        autoComplete="organization"
        value={form.organizationName}
        error={show('organizationName')}
        onBlur={touch('organizationName')}
        onChange={(e) => set({ organizationName: e.target.value })}
      />
      <IconTextInput
        icon="lock"
        label="Password"
        type="password"
        autoComplete="new-password"
        required
        hint={`At least ${MIN_PASSWORD} characters.`}
        value={form.password}
        error={show('password')}
        onBlur={touch('password')}
        onChange={(e) => set({ password: e.target.value })}
      />
      <IconTextInput
        icon="lock"
        label="Confirm Password"
        type="password"
        autoComplete="new-password"
        required
        value={form.confirm}
        error={show('confirm')}
        onBlur={touch('confirm')}
        onChange={(e) => set({ confirm: e.target.value })}
      />
      <TermsAgreement checked={form.acceptTerms} onChange={(acceptTerms) => set({ acceptTerms })} />
      <SubmitButton
        busy={busy}
        disabled={!form.acceptTerms || mismatch}
        reason={!form.acceptTerms ? 'Accept the terms to continue' : 'Fix the password mismatch'}
      >
        Register
      </SubmitButton>
    </form>
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
  const { shown, touch, tryAll } = useTouched();
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

  const issues = {
    companyName: required(form.companyName, 'Enter the company name'),
    contactName: required(form.contactName, 'Enter a contact name'),
    mobile: mobileError(form.mobile),
    email: emailError(form.email),
  };
  const show = (name: keyof typeof issues): string | undefined => (shown(name) ? issues[name] : undefined);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    tryAll();
    if (Object.values(issues).some(Boolean)) return;
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
    <form onSubmit={submit} noValidate className="jw-form-stack">
      <Callout tone="neutral" title="This is an application, not an account">
        JobWork admits workshops after review. Tell us what you do and we will come back to you.
      </Callout>
      <ProblemBlock error={error} />
      <IconTextInput
        icon="factory"
        label="Company Name"
        autoComplete="organization"
        required
        value={form.companyName}
        error={show('companyName')}
        onBlur={touch('companyName')}
        onChange={(e) => set({ companyName: e.target.value })}
      />
      <IconTextInput
        icon="profile"
        label="Contact Name"
        autoComplete="name"
        required
        value={form.contactName}
        error={show('contactName')}
        onBlur={touch('contactName')}
        onChange={(e) => set({ contactName: e.target.value })}
      />
      <IconTextInput
        icon="phone"
        label="Mobile Number"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={form.mobile}
        error={show('mobile')}
        onBlur={touch('mobile')}
        onChange={(e) => set({ mobile: e.target.value })}
      />
      <IconTextInput
        icon="mail"
        label="Email Address"
        type="email"
        autoComplete="email"
        required
        value={form.email}
        error={show('email')}
        onBlur={touch('email')}
        onChange={(e) => set({ email: e.target.value })}
      />
      <IconTextInput
        icon="location"
        label="City"
        autoComplete="address-level2"
        value={form.city}
        onChange={(e) => set({ city: e.target.value })}
      />

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ font: 'var(--text-body-strong)', marginBottom: 'var(--space-2)' }}>What you do</legend>
        <Stack gap={2}>
          {families.map((family) => (
            <div key={family.code}>
              <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{family.label}</p>
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
      <TermsAgreement checked={form.acceptTerms} onChange={(acceptTerms) => set({ acceptTerms })} />
      <SubmitButton busy={busy} disabled={!form.acceptTerms} reason="Accept the terms to continue">
        Send application
      </SubmitButton>
    </form>
  );
}
