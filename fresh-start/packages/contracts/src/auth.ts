import { z } from 'zod';

export const loginRequestSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(128),
});

export const mfaVerifyRequestSchema = z
  .object({
    code: z.string().trim().min(6).max(11).optional(),
    recoveryCode: z.string().trim().min(8).max(16).optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'Provide exactly one of code or recoveryCode',
    path: ['code'],
  });

export const mfaActivateRequestSchema = z.object({
  code: z.string().trim().min(6).max(8),
});

export const inviteMemberRequestSchema = z.object({
  email: z.email().max(320),
  roleKeys: z.array(z.string().min(1).max(64)).min(1).max(8),
});

export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(16).max(256),
  displayName: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(1).max(128).optional(),
});

export const switchOrganizationRequestSchema = z.object({
  organizationId: z.uuid(),
});

// ------------------------------------------------------- self-registration (F-MX.4)

/**
 * A customer registers itself (doc 20 §2, policy: allowed; email verified before the
 * first sign-in). The account is the organization's first administrator, requester and
 * approver — one person, every customer role, until they invite colleagues.
 */
export const registerCustomerRequestSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  mobile: z
    .string()
    .trim()
    .max(20)
    .regex(/^[+\d][\d\s-]{5,19}$/, 'Enter a mobile number with digits only')
    .optional()
    .or(z.literal('')),
  email: z.email().max(320),
  password: z.string().min(1).max(128),
  /** The organization the account belongs to; defaults to the person's name. */
  organizationName: z.string().trim().min(2).max(200).optional().or(z.literal('')),
  acceptTerms: z.literal(true),
});

export const verifyEmailRequestSchema = z.object({
  token: z.string().min(16).max(256),
});

export const updateProfileRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30).default(''),
});

export type RegisterCustomerRequest = z.infer<typeof registerCustomerRequestSchema>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

export const membershipSummarySchema = z.object({
  membershipId: z.uuid(),
  organizationId: z.uuid(),
  organizationName: z.string(),
  organizationType: z.enum(['customer', 'supplier', 'internal']),
  status: z.string(),
  roles: z.array(z.string()),
});

export const meResponseSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  phone: z.string(),
  mfaEnrolled: z.boolean(),
  authStrength: z.enum(['password', 'password+totp']),
  organizationId: z.uuid().nullable(),
  organizationType: z.enum(['customer', 'supplier', 'internal']).nullable(),
  roles: z.array(z.string()),
  memberships: z.array(membershipSummarySchema),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

// ------------------------------------------------------- administration (F-OPS)

export const organizationTypeSchema = z.enum(['customer', 'supplier', 'internal']);
export const organizationStatusSchema = z.enum(['active', 'suspended', 'deactivated']);

/**
 * Creating an organization through the console means creating a **customer**: a supplier
 * is admitted by `POST /suppliers`, which also creates its profile (a supplier
 * organization without one is a broken record), and JobWork's own internal organization
 * is created once by the environment seed — a second one would be a second set of eyes
 * over everything.
 */
export const createOrganizationRequestSchema = z.object({
  type: z.literal('customer'),
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(120),
  /** Optional first user: an organization nobody can sign into is not much of one. */
  firstUserEmail: z.email().max(320).optional(),
  firstUserRoleKeys: z.array(z.string().min(1).max(64)).min(1).max(8).optional(),
});

export const organizationSummarySchema = z.object({
  organizationId: z.uuid(),
  type: organizationTypeSchema,
  legalName: z.string(),
  displayName: z.string(),
  status: organizationStatusSchema,
  memberCount: z.number().int().nonnegative(),
  activeMemberCount: z.number().int().nonnegative(),
  pendingInvitationCount: z.number().int().nonnegative(),
  /** Present for supplier organizations, so the console can link to the 360. */
  supplierProfileId: z.uuid().nullable(),
  createdAt: z.string(),
});

export const organizationMemberSchema = z.object({
  membershipId: z.uuid(),
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  roles: z.array(z.string()),
  membershipStatus: z.string(),
  userStatus: z.string(),
  mfaEnrolled: z.boolean(),
  lastSignInAt: z.string().nullable(),
});

export const organizationInvitationSchema = z.object({
  invitationId: z.uuid(),
  email: z.string(),
  proposedRoleKeys: z.array(z.string()),
  expiresAt: z.string(),
  expired: z.boolean(),
  createdAt: z.string(),
});

export const organizationDetailSchema = z.object({
  organization: organizationSummarySchema,
  members: z.array(organizationMemberSchema),
  invitations: z.array(organizationInvitationSchema),
});

/** Every suspension states its reason: the person suspended is owed one. */
export const suspensionRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const reinstateRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * The operator's own workload (F-OPS.2). Counts are role-filtered upstream: a queue the
 * actor cannot act on is absent, not zero, so the console never renders a number that
 * would be a leak or a dead end.
 */
export const workQueueSchema = z.object({
  key: z.enum([
    'enquiries_awaiting_triage',
    'clarifications_awaiting_customer',
    'supplier_files_awaiting_decision',
    'supplier_evidence_awaiting_review',
    'suppliers_unmatchable',
    'invitations_pending',
    'supplier_applications_received',
    'approvals_pending',
    'rfqs_in_evaluation',
    'orders_awaiting_release',
    'purchase_orders_to_issue',
    'payments_unmatched',
    'baselines_to_release',
    'work_packages_to_release',
    'milestones_to_verify',
    'inspections_awaiting_review',
    'ncrs_open',
    'shipments_to_release',
    'shipments_awaiting_receiving',
    'receiving_discrepancies_open',
    'customer_dispatches_to_release',
    'deliveries_awaiting_pod',
    'delivery_exceptions_open',
    'supplier_bills_to_match',
    'settlements_held',
    'cases_open',
    'leakage_reviews_open',
  ]),
  label: z.string(),
  detail: z.string(),
  count: z.number().int().nonnegative(),
  /** Oldest item still waiting, so an operator can see a queue going stale. */
  oldestWaitingSince: z.string().nullable(),
  href: z.string(),
});

export const operationsSummarySchema = z.object({
  queues: z.array(workQueueSchema),
  generatedAt: z.string(),
});

export type OrganizationType = z.infer<typeof organizationTypeSchema>;
export type OrganizationStatus = z.infer<typeof organizationStatusSchema>;
export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>;
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;
export type OrganizationMember = z.infer<typeof organizationMemberSchema>;
export type OrganizationInvitation = z.infer<typeof organizationInvitationSchema>;
export type OrganizationDetail = z.infer<typeof organizationDetailSchema>;
export type SuspensionRequest = z.infer<typeof suspensionRequestSchema>;
export type WorkQueue = z.infer<typeof workQueueSchema>;
export type OperationsSummary = z.infer<typeof operationsSummarySchema>;

// ------------------------------------------------- organization sites (F-CX.3)

/**
 * An address an organization ships to or works from. Customers keep an address book and
 * name one on an enquiry (`FR-301`); a supplier keeps the one works address F-SO
 * declares. Archiving hides a site from new work without rewriting the enquiries that
 * already named it — an old order still shipped where it shipped.
 */
export const organizationSiteKindSchema = z.enum(['registered', 'delivery', 'pickup', 'works']);

export const organizationSiteSchema = z.object({
  siteId: z.uuid(),
  label: z.string(),
  kind: organizationSiteKindSchema,
  addressLine1: z.string(),
  addressLine2: z.string(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  countryCode: z.string(),
  gstin: z.string().nullable(),
  contactName: z.string(),
  contactPhone: z.string(),
  status: z.enum(['active', 'archived']),
});

export const saveOrganizationSiteRequestSchema = z.object({
  /** Omitted creates; present edits that site in place. */
  siteId: z.uuid().optional(),
  label: z.string().trim().min(2).max(80),
  kind: organizationSiteKindSchema.default('delivery'),
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).default(''),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  postalCode: z.string().trim().regex(/^[0-9]{6}$/, 'A six-digit PIN code'),
  gstin: z.string().trim().max(20).optional(),
  contactName: z.string().trim().max(120).default(''),
  contactPhone: z.string().trim().max(30).default(''),
});

/** The customer's own workload, the counterpart of the operations summary (F-CX.4). */
export const portalQueueSchema = z.object({
  key: z.enum([
    'questions_awaiting_answer',
    'drafts_unfinished',
    'enquiries_in_progress',
    // Fixed now so the home never changes shape; counted from IN-07/08 onward.
    'quotations_awaiting_decision',
    'orders_in_progress',
    'invoices_unpaid',
    // IN-17: an address to confirm before a delivery leaves, or a delivery to accept or report.
    'deliveries_awaiting_you',
  ]),
  label: z.string(),
  detail: z.string(),
  count: z.number().int().nonnegative(),
  oldestWaitingSince: z.string().nullable(),
  href: z.string(),
});

export const portalSummarySchema = z.object({
  queues: z.array(portalQueueSchema),
  generatedAt: z.string(),
});

export type OrganizationSite = z.infer<typeof organizationSiteSchema>;
export type SaveOrganizationSiteRequest = z.infer<typeof saveOrganizationSiteRequestSchema>;
export type PortalQueue = z.infer<typeof portalQueueSchema>;
export type PortalSummary = z.infer<typeof portalSummarySchema>;
