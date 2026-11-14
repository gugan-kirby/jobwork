"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { OperationsSummary, WorkQueue } from "@jobwork/contracts";
import {
  ActionNeededCard,
  ButtonLink,
  Card,
  DescriptionList,
  Donut,
  ErrorState,
  Icon,
  LoadingState,
  Page,
  QuickAction,
  QuickActionGrid,
  Stack,
  StatusChip,
  WorkshopIllustration,
  type IconName,
  type QuickAccent,
} from "@jobwork/ui";
import { api, ApiError } from "../lib/api";

interface Me {
  displayName: string;
  email: string;
  organizationType: string | null;
  roles: string[];
  mfaEnrolled: boolean;
}

/**
 * The operations home (doc 14 §6, F-OPS.3, VF-19), built from the vendor dashboard
 * (reference screen 15): welcome banner, four tiles, a list with one action per row and
 * an overview ring, then the customer home's quick actions. Every number comes from the
 * server's role-filtered queues, so nothing here counts work the operator cannot act on.
 */

type QueueKey = WorkQueue["key"];

const INTAKE: readonly QueueKey[] = [
  "enquiries_awaiting_triage",
  "clarifications_awaiting_customer",
];
const SOURCING: readonly QueueKey[] = [
  "rfqs_in_evaluation",
  "approvals_pending",
];
const NETWORK: readonly QueueKey[] = [
  "supplier_applications_received",
  "invitations_pending",
  "supplier_files_awaiting_decision",
  "supplier_evidence_awaiting_review",
  "suppliers_unmatchable",
];
const FINANCE: readonly QueueKey[] = [
  "payments_unmatched",
  "supplier_bills_to_match",
  "settlements_held",
  "cases_open",
  "leakage_reviews_open",
];

const TILES: ReadonlyArray<{
  tint: string;
  icon: IconName;
  label: string;
  queues: readonly QueueKey[] | null;
}> = [
  { tint: "blue", icon: "mail", label: "New Enquiries", queues: INTAKE },
  {
    tint: "violet",
    icon: "document",
    label: "Quotes to Review",
    queues: SOURCING,
  },
  { tint: "green", icon: "orders", label: "Orders to Action", queues: null },
  {
    tint: "orange",
    icon: "team",
    label: "Suppliers to Review",
    queues: NETWORK,
  },
];

const QUICK: ReadonlyArray<{
  href: string;
  icon: IconName;
  label: string;
  accent: QuickAccent;
  adminOnly?: boolean;
}> = [
  { href: "/queues", icon: "enquiries", label: "Queues", accent: "blue" },
  { href: "/approvals", icon: "quote", label: "Approvals", accent: "orange" },
  { href: "/suppliers", icon: "factory", label: "Suppliers", accent: "green" },
  { href: "/finance", icon: "payment", label: "Finance", accent: "ink" },
  {
    href: "/organizations",
    icon: "team",
    label: "Organizations",
    accent: "sky",
    adminOnly: true,
  },
  { href: "/audit", icon: "search", label: "Audit", accent: "ink" },
];

const ROW_TILES = [
  ["jw-record-tile-blue", "factory"],
  ["jw-record-tile-violet", "layers"],
  ["jw-record-tile-orange", "hexagon"],
] as const;

const DAY = 24 * 60 * 60 * 1000;

function waitedDays(queue: WorkQueue, now: number): number {
  return queue.oldestWaitingSince
    ? Math.floor((now - Date.parse(queue.oldestWaitingSince)) / DAY)
    : 0;
}

function waitedText(days: number): string {
  if (days <= 0) return "Today";
  return days === 1 ? "1 day" : `${days} days`;
}

export default function HomePage(): React.JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      const account = await api<Me>("/auth/me");
      setMe(account);
      // A summary the actor may not read is not an error worth showing them; the page
      // still works as the account view it always was.
      setSummary(
        await api<OperationsSummary>("/operations/summary").catch(() => null),
      );
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.problem.status === 401) setAnonymous(true);
      else setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (anonymous) {
    return (
      <Page title="Operations home" width="narrow">
        <Card>
          <p>
            <Link href="/login">Sign in</Link> to continue.
          </p>
        </Card>
      </Page>
    );
  }

  if (!me) {
    return (
      <Page title="Operations home" width="narrow">
        {error ? (
          <ErrorState
            message={error.problem.detail ?? error.problem.title}
            code={error.problem.code}
            correlationId={error.problem.correlationId}
          />
        ) : (
          <Card>
            <LoadingState label="Loading your account" />
          </Card>
        )}
      </Page>
    );
  }

  return <Dashboard me={me} summary={summary} />;
}

function Dashboard({
  me,
  summary,
}: {
  me: Me;
  summary: OperationsSummary | null;
}): React.JSX.Element {
  const now = useMemo(() => Date.now(), []);
  const queues = summary?.queues ?? [];
  const isAdministrator =
    me.roles.includes("platform_admin") || me.roles.includes("security_admin");

  const inGroup = (group: readonly QueueKey[] | null): WorkQueue[] =>
    queues.filter((queue) =>
      group
        ? group.includes(queue.key)
        : ![...INTAKE, ...SOURCING, ...NETWORK, ...FINANCE].includes(queue.key),
    );
  const countOf = (group: readonly QueueKey[] | null): number =>
    inGroup(group).reduce((sum, queue) => sum + queue.count, 0);
  const waiting = queues
    .filter((queue) => queue.count > 0)
    .sort((a, b) => waitedDays(b, now) - waitedDays(a, now));

  return (
    <Page title="Operations home" titleHidden width="wide">
      <div className="jw-ops-home">
        <Stack gap={4}>
          <section className="jw-welcome" aria-label="Welcome">
            <div>
              <p className="jw-welcome-eyebrow">Operations Dashboard</p>
              <p className="jw-welcome-title">
                Welcome, {me.displayName.split(" ")[0]} 👋
              </p>
              <p className="jw-welcome-sub">
                Manage enquiries, suppliers and orders
              </p>
            </div>
            <div className="jw-ops-art">
              <WorkshopIllustration />
            </div>
          </section>

          {!me.mfaEnrolled ? (
            <ActionNeededCard
              title="Set up two-factor authentication"
              detail="You need it before you can approve, release or send anything."
              owner="You"
              action={
                <ButtonLink href="/account/security">Enrol now</ButtonLink>
              }
            />
          ) : null}

          <section aria-labelledby="home-overview" className="jw-ops-overview">
            <h2 id="home-overview" className="jw-visually-hidden">
              Overview
            </h2>
            <div className="jw-tiles">
              {TILES.map((tile) => {
                const group = inGroup(tile.queues);
                const href =
                  group.find((queue) => queue.count > 0)?.href ??
                  group[0]?.href ??
                  "/queues";
                const count = summary ? countOf(tile.queues) : null;
                return (
                  <Link
                    key={tile.label}
                    href={href}
                    className={`jw-tile jw-tile-${tile.tint}`}
                    data-empty={count === 0 ? "" : undefined}
                  >
                    <span className="jw-tile-glyph" aria-hidden="true">
                      <Icon name={tile.icon} size={1.4} />
                    </span>
                    <span className="jw-tile-value numeric">
                      {count ?? "—"}
                    </span>
                    <span className="jw-tile-label">{tile.label}</span>
                    <span className="jw-tile-go" aria-hidden="true">
                      <Icon name="chevron" size={1.1} />
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>

          <div className="jw-ops-columns">
            <section className="jw-panel" aria-labelledby="home-waiting">
              <div className="jw-panel-head">
                <h2 id="home-waiting" className="jw-panel-title">
                  <Icon name="mail" size={1.3} />
                  Work Waiting
                </h2>
                <Link href="/queues" className="jw-panel-link">
                  View All <Icon name="chevron" size={1} />
                </Link>
              </div>
              {summary === null ? (
                <div className="jw-panel-body">
                  <LoadingState label="Counting what is waiting" />
                </div>
              ) : waiting.length === 0 ? (
                <p className="jw-panel-body jw-record-caption">
                  Nothing is waiting on you right now.
                </p>
              ) : (
                waiting.map((queue, index) => {
                  const [tint, icon] = ROW_TILES[index % ROW_TILES.length]!;
                  return (
                    <div key={queue.key} className="jw-panel-row">
                      <span
                        className={`jw-record-tile ${tint}`}
                        aria-hidden="true"
                      >
                        <Icon name={icon} size={1.6} />
                      </span>
                      <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                        <span className="jw-offer-title">{queue.label}</span>
                        <span className="jw-record-caption">
                          {queue.count} waiting • oldest{" "}
                          {waitedText(waitedDays(queue, now))}
                        </span>
                      </span>
                      <Link
                        href={queue.href}
                        className={
                          index === 0
                            ? "jw-cta jw-cta-xs"
                            : "jw-cta-outline jw-cta-xs"
                        }
                      >
                        Open
                        <span className="jw-visually-hidden">
                          , {queue.label}
                        </span>
                      </Link>
                    </div>
                  );
                })
              )}
            </section>

            <section className="jw-panel" aria-labelledby="home-work">
              <div className="jw-panel-head">
                <h2 id="home-work" className="jw-panel-title">
                  <Icon name="orders" size={1.3} />
                  Work Overview
                </h2>
                <Link href="/queues" className="jw-panel-link">
                  View All <Icon name="chevron" size={1} />
                </Link>
              </div>
              <div className="jw-panel-body">
                <Donut
                  totalLabel="Items"
                  slices={[
                    {
                      label: "Enquiries & Quotes",
                      value: countOf([...INTAKE, ...SOURCING]),
                    },
                    { label: "Suppliers", value: countOf(NETWORK) },
                    {
                      label: "Orders & Finance",
                      value: countOf(null) + countOf(FINANCE),
                    },
                  ]}
                />
              </div>
            </section>
          </div>

          <section aria-labelledby="home-quick" className="jw-home-section">
            <h2 id="home-quick" className="jw-home-title">
              Quick Actions
            </h2>
            <QuickActionGrid>
              {QUICK.filter(
                (action) => !action.adminOnly || isAdministrator,
              ).map((action) => (
                <QuickAction
                  key={action.href}
                  href={action.href}
                  icon={action.icon}
                  label={action.label}
                  accent={action.accent}
                />
              ))}
            </QuickActionGrid>
          </section>

          <details className="jw-more">
            <summary>Account</summary>
            <Card>
              <DescriptionList
                columns={2}
                items={[
                  {
                    label: "Signed in as",
                    value: `${me.displayName} (${me.email})`,
                  },
                  {
                    label: "Roles",
                    value: me.roles.join(", ") || "None in this context",
                  },
                  {
                    label: "Two-factor",
                    value: me.mfaEnrolled ? (
                      <StatusChip tone="positive">Enrolled</StatusChip>
                    ) : (
                      <StatusChip tone="attention">Not enrolled</StatusChip>
                    ),
                  },
                ]}
              />
            </Card>
          </details>
        </Stack>
      </div>
    </Page>
  );
}
