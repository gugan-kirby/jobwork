import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { OrganizationSite } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

type Queryable = Pool | PoolClient;

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string | null;
  status: 'pending_verification' | 'active' | 'suspended' | 'deactivated';
  displayName: string;
  phone: string;
  failedLoginCount: number;
  lockoutUntil: Date | null;
  mfaTotpSecret: string | null;
  mfaEnrolledAt: Date | null;
  aggregateVersion: number;
}

export interface SessionRow {
  id: string;
  userId: string;
  organizationId: string | null;
  authStrength: 'password' | 'password+totp';
  mfaPending: boolean;
  authenticatedAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface SessionContext {
  session: SessionRow;
  user: {
    id: string;
    email: string;
    displayName: string;
    status: UserRow['status'];
    mfaEnrolled: boolean;
  };
  organization: { id: string; type: string; status: string; displayName: string } | null;
  membershipStatus: string | null;
  roles: string[];
}

export interface MembershipSummary {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  organizationType: string;
  organizationStatus: string;
  status: string;
  roles: string[];
}

export interface InvitationRow {
  id: string;
  organizationId: string;
  email: string;
  proposedRoleKeys: string[];
  invitedBy: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

const USER_COLUMNS = `
  id, email, password_hash AS "passwordHash", status, display_name AS "displayName", phone,
  failed_login_count AS "failedLoginCount", lockout_until AS "lockoutUntil",
  mfa_totp_secret AS "mfaTotpSecret", mfa_enrolled_at AS "mfaEnrolledAt",
  aggregate_version AS "aggregateVersion"`;

const SESSION_COLUMNS = `
  id, user_id AS "userId", organization_id AS "organizationId", auth_strength AS "authStrength",
  mfa_pending AS "mfaPending", authenticated_at AS "authenticatedAt", last_seen_at AS "lastSeenAt",
  idle_expires_at AS "idleExpiresAt", absolute_expires_at AS "absoluteExpiresAt",
  revoked_at AS "revokedAt", ip, user_agent AS "userAgent", created_at AS "createdAt"`;

@Injectable()
export class IamRepository {
  constructor(private readonly db: DatabaseService) {}

  private q(client?: Queryable): Queryable {
    return client ?? this.db.pool;
  }

  // ---- users ----

  async findUserByEmail(email: string, client?: Queryable): Promise<UserRow | null> {
    const res = await this.q(client).query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM iam.user_account WHERE email = $1`,
      [email],
    );
    return res.rows[0] ?? null;
  }

  async findUserById(id: string, client?: Queryable): Promise<UserRow | null> {
    const res = await this.q(client).query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM iam.user_account WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async createUser(
    input: { email: string; passwordHash: string; passwordParamsVersion: number; displayName: string },
    client?: Queryable,
  ): Promise<UserRow> {
    const res = await this.q(client).query<UserRow>(
      `INSERT INTO iam.user_account
         (email, password_hash, password_params_version, display_name, status, email_verified_at)
       VALUES ($1, $2, $3, $4, 'active', now())
       RETURNING ${USER_COLUMNS}`,
      [input.email, input.passwordHash, input.passwordParamsVersion, input.displayName],
    );
    const row = res.rows[0];
    if (!row) throw new Error('user insert returned no row');
    return row;
  }

  /**
   * Self-registration (F-MX.4): the account exists but cannot sign in until the email
   * is proven — `pending_verification`, no `email_verified_at`.
   */
  async createPendingUser(
    input: {
      email: string;
      passwordHash: string;
      passwordParamsVersion: number;
      displayName: string;
      phone: string;
    },
    client?: Queryable,
  ): Promise<UserRow> {
    const res = await this.q(client).query<UserRow>(
      `INSERT INTO iam.user_account
         (email, password_hash, password_params_version, display_name, phone, status)
       VALUES ($1, $2, $3, $4, $5, 'pending_verification')
       RETURNING ${USER_COLUMNS}`,
      [input.email, input.passwordHash, input.passwordParamsVersion, input.displayName, input.phone],
    );
    const row = res.rows[0];
    if (!row) throw new Error('user insert returned no row');
    return row;
  }

  async createEmailVerification(
    input: { userId: string; tokenHash: string; expiresAt: Date },
    client?: Queryable,
  ): Promise<{ id: string }> {
    const res = await this.q(client).query<{ id: string }>(
      `INSERT INTO iam.email_verification (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3) RETURNING id`,
      [input.userId, input.tokenHash, input.expiresAt],
    );
    return res.rows[0]!;
  }

  async findEmailVerificationByHash(
    tokenHash: string,
    client?: Queryable,
  ): Promise<{ id: string; userId: string; expiresAt: Date; usedAt: Date | null } | null> {
    const res = await this.q(client).query<{
      id: string;
      userId: string;
      expiresAt: Date;
      usedAt: Date | null;
    }>(
      `SELECT id, user_id AS "userId", expires_at AS "expiresAt", used_at AS "usedAt"
         FROM iam.email_verification WHERE token_hash = $1`,
      [tokenHash],
    );
    return res.rows[0] ?? null;
  }

  /** Guarded consumption: the second of two concurrent clicks finds nothing to update. */
  async consumeEmailVerification(id: string, client: Queryable): Promise<boolean> {
    const res = await client.query(
      `UPDATE iam.email_verification SET used_at = now()
        WHERE id = $1 AND used_at IS NULL AND expires_at > now()`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async activateUser(userId: string, client: Queryable): Promise<boolean> {
    const res = await client.query(
      `UPDATE iam.user_account
          SET status = 'active', email_verified_at = COALESCE(email_verified_at, now()),
              aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 AND status = 'pending_verification'`,
      [userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async updateProfile(
    userId: string,
    input: { displayName: string; phone: string },
    client?: Queryable,
  ): Promise<void> {
    await this.q(client).query(
      `UPDATE iam.user_account
          SET display_name = $2, phone = $3, aggregate_version = aggregate_version + 1,
              updated_at = now()
        WHERE id = $1`,
      [userId, input.displayName, input.phone],
    );
  }

  async recordLoginFailure(userId: string, lockoutUntil: Date | null): Promise<void> {
    await this.db.pool.query(
      `UPDATE iam.user_account
         SET failed_login_count = failed_login_count + 1,
             lockout_until = COALESCE($2, lockout_until),
             updated_at = now()
       WHERE id = $1`,
      [userId, lockoutUntil],
    );
  }

  async recordLoginSuccess(userId: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE iam.user_account
         SET failed_login_count = 0, lockout_until = NULL, updated_at = now()
       WHERE id = $1`,
      [userId],
    );
  }

  async updatePassword(
    userId: string,
    passwordHash: string,
    paramsVersion: number,
    client?: Queryable,
  ): Promise<void> {
    await this.q(client).query(
      `UPDATE iam.user_account
         SET password_hash = $2, password_params_version = $3, updated_at = now()
       WHERE id = $1`,
      [userId, passwordHash, paramsVersion],
    );
  }

  async suspendUser(userId: string, client?: Queryable): Promise<void> {
    await this.q(client).query(
      `UPDATE iam.user_account SET status = 'suspended', updated_at = now() WHERE id = $1`,
      [userId],
    );
  }

  async reinstateUser(userId: string, client?: Queryable): Promise<boolean> {
    const res = await this.q(client).query(
      `UPDATE iam.user_account SET status = 'active', updated_at = now()
        WHERE id = $1 AND status = 'suspended'`,
      [userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ---- MFA ----

  async setPendingTotpSecret(userId: string, secret: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE iam.user_account
         SET mfa_totp_secret = $2, mfa_enrolled_at = NULL, updated_at = now()
       WHERE id = $1`,
      [userId, secret],
    );
  }

  async activateTotp(userId: string, client?: Queryable): Promise<void> {
    await this.q(client).query(
      `UPDATE iam.user_account SET mfa_enrolled_at = now(), updated_at = now() WHERE id = $1`,
      [userId],
    );
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[], client?: Queryable): Promise<void> {
    const q = this.q(client);
    await q.query(`DELETE FROM iam.mfa_recovery_code WHERE user_id = $1`, [userId]);
    for (const hash of codeHashes) {
      await q.query(
        `INSERT INTO iam.mfa_recovery_code (user_id, code_hash) VALUES ($1, $2)`,
        [userId, hash],
      );
    }
  }

  /** Atomically consumes an unused recovery code; returns whether one matched. */
  async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const res = await this.db.pool.query(
      `UPDATE iam.mfa_recovery_code SET used_at = now()
       WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [userId, codeHash],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ---- organizations & memberships ----

  async createOrganization(
    input: { type: string; legalName: string; displayName: string; createdBy?: string },
    client?: Queryable,
  ): Promise<{ id: string }> {
    const res = await this.q(client).query<{ id: string }>(
      `INSERT INTO iam.organization (type, legal_name, display_name, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.type, input.legalName, input.displayName, input.createdBy ?? null],
    );
    const row = res.rows[0];
    if (!row) throw new Error('organization insert returned no row');
    return row;
  }

  /** Roles the person with this e-mail already holds in the organization, if a member. */
  async roleKeysOfEmailInOrganization(organizationId: string, email: string): Promise<string[]> {
    const res = await this.q().query<{ key: string }>(
      `SELECT DISTINCT r.key
         FROM iam.user_account u
         JOIN iam.membership m ON m.user_id = u.id AND m.organization_id = $1 AND m.status = 'active'
         JOIN iam.membership_role mr ON mr.membership_id = m.id
         JOIN iam.role r ON r.id = mr.role_id
        WHERE lower(u.email) = lower($2)`,
      [organizationId, email],
    );
    return res.rows.map((r) => r.key);
  }

  /** Every active JobWork person and the roles they hold, for the separation-of-duties check. */
  async internalRoleHolders(): Promise<Array<{ userId: string; displayName: string; email: string; roles: string[] }>> {
    const res = await this.q().query<{ userId: string; displayName: string; email: string; roles: string[] }>(
      `SELECT u.id AS "userId", coalesce(nullif(u.display_name, ''), u.email) AS "displayName", u.email,
              array_agg(DISTINCT r.key ORDER BY r.key) AS roles
         FROM iam.user_account u
         JOIN iam.membership m ON m.user_id = u.id AND m.status = 'active'
         JOIN iam.organization o ON o.id = m.organization_id AND o.type = 'internal'
         JOIN iam.membership_role mr ON mr.membership_id = m.id
         JOIN iam.role r ON r.id = mr.role_id
        WHERE u.status = 'active'
        GROUP BY u.id
        ORDER BY 2`,
    );
    return res.rows;
  }

  async findOrganization(
    id: string,
    client?: Queryable,
  ): Promise<{ id: string; type: string; status: string; displayName: string } | null> {
    const res = await this.q(client).query(
      `SELECT id, type, status, display_name AS "displayName" FROM iam.organization WHERE id = $1`,
      [id],
    );
    return (res.rows[0] as { id: string; type: string; status: string; displayName: string }) ?? null;
  }

  async createMembership(
    input: { userId: string; organizationId: string; roleKeys: string[]; createdBy: string | null },
    client?: Queryable,
  ): Promise<{ id: string }> {
    const q = this.q(client);
    const res = await q.query<{ id: string }>(
      `INSERT INTO iam.membership (user_id, organization_id, created_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [input.userId, input.organizationId, input.createdBy],
    );
    const membership = res.rows[0];
    if (!membership) throw new Error('membership insert returned no row');
    for (const key of input.roleKeys) {
      await q.query(
        `INSERT INTO iam.membership_role (membership_id, role_id, granted_by)
         SELECT $1, r.id, $3 FROM iam.role r WHERE r.key = $2`,
        [membership.id, key, input.createdBy],
      );
    }
    return membership;
  }

  /**
   * Who is inside one organization, and who has been asked in. Lives here because
   * membership is an IAM fact: the supplier module reads it, it does not own it.
   */
  async listOrganizationMembers(
    organizationId: string,
  ): Promise<
    Array<{ userId: string; email: string; displayName: string; roles: string[]; status: string }>
  > {
    const res = await this.q().query(
      `SELECT u.id AS user_id, u.email, u.display_name, m.status,
              COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
         FROM iam.membership m
         JOIN iam.user_account u ON u.id = m.user_id
         LEFT JOIN iam.membership_role mr ON mr.membership_id = m.id
         LEFT JOIN iam.role r ON r.id = mr.role_id
        WHERE m.organization_id = $1
        GROUP BY u.id, u.email, u.display_name, m.status
        ORDER BY u.email`,
      [organizationId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      userId: row['user_id'] as string,
      email: row['email'] as string,
      displayName: row['display_name'] as string,
      roles: (row['roles'] as string[]) ?? [],
      status: row['status'] as string,
    }));
  }

  async listPendingInvitations(
    organizationId: string,
  ): Promise<Array<{ invitationId: string; email: string; expiresAt: Date }>> {
    const res = await this.q().query(
      `SELECT id, email, expires_at
         FROM iam.invitation
        WHERE organization_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()
        ORDER BY created_at DESC`,
      [organizationId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      invitationId: row['id'] as string,
      email: row['email'] as string,
      expiresAt: row['expires_at'] as Date,
    }));
  }

  async listMemberships(userId: string): Promise<MembershipSummary[]> {
    const res = await this.db.pool.query(
      `SELECT m.id AS "membershipId", m.organization_id AS "organizationId", m.status,
              o.display_name AS "organizationName", o.type AS "organizationType",
              o.status AS "organizationStatus",
              COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
         FROM iam.membership m
         JOIN iam.organization o ON o.id = m.organization_id
         LEFT JOIN iam.membership_role mr ON mr.membership_id = m.id
         LEFT JOIN iam.role r ON r.id = mr.role_id
        WHERE m.user_id = $1 AND m.status <> 'ended'
        GROUP BY m.id, o.id`,
      [userId],
    );
    return res.rows as MembershipSummary[];
  }

  async findActiveMembership(
    userId: string,
    organizationId: string,
    client?: Queryable,
  ): Promise<{ membershipId: string; roles: string[]; aggregateVersion: number } | null> {
    const res = await this.q(client).query(
      `SELECT m.id AS "membershipId", m.aggregate_version AS "aggregateVersion",
              COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
         FROM iam.membership m
         LEFT JOIN iam.membership_role mr ON mr.membership_id = m.id
         LEFT JOIN iam.role r ON r.id = mr.role_id
        WHERE m.user_id = $1 AND m.organization_id = $2 AND m.status = 'active'
        GROUP BY m.id`,
      [userId, organizationId],
    );
    return (res.rows[0] as { membershipId: string; roles: string[]; aggregateVersion: number }) ?? null;
  }

  async findMembershipById(
    membershipId: string,
    client?: Queryable,
  ): Promise<{ userId: string; organizationId: string; status: string } | null> {
    const res = await this.q(client).query(
      `SELECT user_id AS "userId", organization_id AS "organizationId", status
         FROM iam.membership WHERE id = $1`,
      [membershipId],
    );
    return (res.rows[0] as { userId: string; organizationId: string; status: string }) ?? null;
  }

  async suspendMembership(membershipId: string, client?: Queryable): Promise<{ userId: string; organizationId: string } | null> {
    const res = await this.q(client).query(
      `UPDATE iam.membership SET status = 'suspended', aggregate_version = aggregate_version + 1, updated_at = now()
       WHERE id = $1 AND status = 'active'
       RETURNING user_id AS "userId", organization_id AS "organizationId"`,
      [membershipId],
    );
    return (res.rows[0] as { userId: string; organizationId: string }) ?? null;
  }

  async reinstateMembership(
    membershipId: string,
    client?: Queryable,
  ): Promise<{ userId: string; organizationId: string } | null> {
    const res = await this.q(client).query(
      `UPDATE iam.membership
          SET status = 'active', aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 AND status = 'suspended'
        RETURNING user_id AS "userId", organization_id AS "organizationId"`,
      [membershipId],
    );
    return (res.rows[0] as { userId: string; organizationId: string }) ?? null;
  }

  async setOrganizationStatus(
    organizationId: string,
    status: 'active' | 'suspended' | 'deactivated',
    client?: Queryable,
  ): Promise<boolean> {
    const res = await this.q(client).query(
      `UPDATE iam.organization
          SET status = $2, aggregate_version = aggregate_version + 1, updated_at = now()
        WHERE id = $1 AND status <> $2`,
      [organizationId, status],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * The console's organization list. The counts come from the same query rather than a
   * request per row: an administrator scanning fifty organizations should not cost
   * fifty round trips, and a count that arrives later than its row reads as a bug.
   */
  async listOrganizations(filter: {
    type?: string | undefined;
    status?: string | undefined;
    organizationId?: string | undefined;
  }): Promise<
    Array<{
      organizationId: string;
      type: string;
      legalName: string;
      displayName: string;
      status: string;
      memberCount: number;
      activeMemberCount: number;
      pendingInvitationCount: number;
      supplierProfileId: string | null;
      createdAt: Date;
    }>
  > {
    const res = await this.q().query(
      `SELECT o.id, o.type, o.legal_name, o.display_name, o.status, o.created_at,
              (SELECT count(*)::int FROM iam.membership m WHERE m.organization_id = o.id)
                AS member_count,
              (SELECT count(*)::int FROM iam.membership m
                WHERE m.organization_id = o.id AND m.status = 'active') AS active_member_count,
              (SELECT count(*)::int FROM iam.invitation i
                WHERE i.organization_id = o.id AND i.consumed_at IS NULL
                  AND i.revoked_at IS NULL AND i.expires_at > now()) AS pending_invitation_count,
              (SELECT p.id FROM supplier.supplier_profile p WHERE p.organization_id = o.id)
                AS supplier_profile_id
         FROM iam.organization o
        WHERE ($1::text IS NULL OR o.type = $1)
          AND ($2::text IS NULL OR o.status = $2)
          AND ($3::uuid IS NULL OR o.id = $3)
        ORDER BY o.type, o.display_name`,
      [filter.type ?? null, filter.status ?? null, filter.organizationId ?? null],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      organizationId: row['id'] as string,
      type: row['type'] as string,
      legalName: row['legal_name'] as string,
      displayName: row['display_name'] as string,
      status: row['status'] as string,
      memberCount: row['member_count'] as number,
      activeMemberCount: row['active_member_count'] as number,
      pendingInvitationCount: row['pending_invitation_count'] as number,
      supplierProfileId: (row['supplier_profile_id'] as string | null) ?? null,
      createdAt: row['created_at'] as Date,
    }));
  }

  /** Members with the two facts an administrator acts on: their state and their factor. */
  async listOrganizationMemberships(organizationId: string): Promise<
    Array<{
      membershipId: string;
      userId: string;
      email: string;
      displayName: string;
      roles: string[];
      membershipStatus: string;
      userStatus: string;
      mfaEnrolled: boolean;
      lastSignInAt: Date | null;
    }>
  > {
    const res = await this.q().query(
      `SELECT m.id AS membership_id, u.id AS user_id, u.email, u.display_name,
              m.status AS membership_status, u.status AS user_status,
              u.mfa_enrolled_at IS NOT NULL AS mfa_enrolled,
              (SELECT max(s.created_at) FROM iam.session s WHERE s.user_id = u.id)
                AS last_sign_in_at,
              COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
         FROM iam.membership m
         JOIN iam.user_account u ON u.id = m.user_id
         LEFT JOIN iam.membership_role mr ON mr.membership_id = m.id
         LEFT JOIN iam.role r ON r.id = mr.role_id
        WHERE m.organization_id = $1
        GROUP BY m.id, u.id, u.email, u.display_name, m.status, u.status, u.mfa_enrolled_at
        ORDER BY u.email`,
      [organizationId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      membershipId: row['membership_id'] as string,
      userId: row['user_id'] as string,
      email: row['email'] as string,
      displayName: row['display_name'] as string,
      roles: (row['roles'] as string[]) ?? [],
      membershipStatus: row['membership_status'] as string,
      userStatus: row['user_status'] as string,
      mfaEnrolled: row['mfa_enrolled'] as boolean,
      lastSignInAt: (row['last_sign_in_at'] as Date | null) ?? null,
    }));
  }

  /** Outstanding invitations, expired ones included: an expired link still needs acting on. */
  async listInvitations(
    organizationId: string,
  ): Promise<
    Array<{
      invitationId: string;
      email: string;
      proposedRoleKeys: string[];
      expiresAt: Date;
      createdAt: Date;
    }>
  > {
    const res = await this.q().query(
      `SELECT id, email, proposed_role_keys, expires_at, created_at
         FROM iam.invitation
        WHERE organization_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [organizationId],
    );
    return res.rows.map((row: Record<string, unknown>) => ({
      invitationId: row['id'] as string,
      email: row['email'] as string,
      proposedRoleKeys: (row['proposed_role_keys'] as string[]) ?? [],
      expiresAt: row['expires_at'] as Date,
      createdAt: row['created_at'] as Date,
    }));
  }

  async findInvitationById(
    invitationId: string,
    organizationId: string,
  ): Promise<{ email: string; proposedRoleKeys: string[] } | null> {
    const res = await this.q().query(
      `SELECT email, proposed_role_keys FROM iam.invitation
        WHERE id = $1 AND organization_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [invitationId, organizationId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row
      ? {
          email: row['email'] as string,
          proposedRoleKeys: (row['proposed_role_keys'] as string[]) ?? [],
        }
      : null;
  }

  // ---- organization sites (F-CX.3) ----

  async listSites(organizationId: string, includeArchived: boolean): Promise<OrganizationSite[]> {
    const res = await this.q().query(
      `SELECT id, label, kind, address_line1, address_line2, city, state, postal_code,
              country_code, gstin, contact_name, contact_phone, status
         FROM iam.organization_site
        WHERE organization_id = $1 AND ($2::boolean OR status = 'active')
        ORDER BY status, label`,
      [organizationId, includeArchived],
    );
    return res.rows.map(mapSite);
  }

  async findSite(siteId: string, organizationId: string, client?: Queryable): Promise<OrganizationSite | null> {
    const res = await this.q(client).query(
      `SELECT id, label, kind, address_line1, address_line2, city, state, postal_code,
              country_code, gstin, contact_name, contact_phone, status
         FROM iam.organization_site WHERE id = $1 AND organization_id = $2`,
      [siteId, organizationId],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? mapSite(row) : null;
  }

  async saveSite(input: {
    siteId: string | null;
    organizationId: string;
    label: string;
    kind: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    state: string;
    postalCode: string;
    gstin: string | null;
    contactName: string;
    contactPhone: string;
    createdBy: string;
  }, client?: Queryable): Promise<OrganizationSite> {
    const params = [
      input.organizationId,
      input.label,
      input.kind,
      input.addressLine1,
      input.addressLine2,
      input.city,
      input.state,
      input.postalCode,
      input.gstin,
      input.contactName,
      input.contactPhone,
      input.createdBy,
    ];
    const res = input.siteId
      ? await this.q(client).query<{ id: string }>(
          `UPDATE iam.organization_site
              SET label = $2, kind = $3, address_line1 = $4, address_line2 = $5, city = $6,
                  state = $7, postal_code = $8, gstin = $9, contact_name = $10,
                  contact_phone = $11, updated_at = now()
            WHERE id = $12 AND organization_id = $1
            RETURNING id`,
          // `created_by` is not part of an update: the row keeps whoever added it.
          [...params.slice(0, 11), input.siteId],
        )
      : await this.q(client).query<{ id: string }>(
          `INSERT INTO iam.organization_site
             (organization_id, label, kind, address_line1, address_line2, city, state,
              postal_code, gstin, contact_name, contact_phone, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (organization_id, label) DO UPDATE
             SET kind = EXCLUDED.kind, address_line1 = EXCLUDED.address_line1,
                 address_line2 = EXCLUDED.address_line2, city = EXCLUDED.city,
                 state = EXCLUDED.state, postal_code = EXCLUDED.postal_code,
                 gstin = EXCLUDED.gstin, contact_name = EXCLUDED.contact_name,
                 contact_phone = EXCLUDED.contact_phone, status = 'active', updated_at = now()
           RETURNING id`,
          params,
        );
    const id = res.rows[0]?.id;
    if (!id) throw new Error('organization site could not be written');
    const site = await this.findSite(id, input.organizationId, client);
    if (!site) throw new Error('organization site vanished after write');
    return site;
  }

  /** Archived, never deleted: an old enquiry still has to say where it was going. */
  async archiveSite(siteId: string, organizationId: string, client?: Queryable): Promise<boolean> {
    const res = await this.q(client).query(
      `UPDATE iam.organization_site SET status = 'archived', updated_at = now()
        WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
      [siteId, organizationId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** True when the user holds any active membership in an internal organization (FR-103 scope). */
  async hasInternalMembership(userId: string, client?: Queryable): Promise<boolean> {
    const res = await this.q(client).query(
      `SELECT 1 FROM iam.membership m
         JOIN iam.organization o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.status = 'active' AND o.type = 'internal' AND o.status = 'active'
        LIMIT 1`,
      [userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ---- sessions ----

  async createSession(
    input: {
      tokenHash: string;
      userId: string;
      organizationId: string | null;
      authStrength: 'password' | 'password+totp';
      mfaPending: boolean;
      idleExpiresAt: Date;
      absoluteExpiresAt: Date;
      ip: string | null;
      userAgent: string | null;
    },
    client?: Queryable,
  ): Promise<SessionRow> {
    const res = await this.q(client).query<SessionRow>(
      `INSERT INTO iam.session
         (token_hash, user_id, organization_id, auth_strength, mfa_pending,
          idle_expires_at, absolute_expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${SESSION_COLUMNS}`,
      [
        input.tokenHash,
        input.userId,
        input.organizationId,
        input.authStrength,
        input.mfaPending,
        input.idleExpiresAt,
        input.absoluteExpiresAt,
        input.ip,
        input.userAgent,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('session insert returned no row');
    return row;
  }

  async findSessionContextByHash(tokenHash: string): Promise<SessionContext | null> {
    const res = await this.db.pool.query(
      `SELECT ${SESSION_COLUMNS} FROM iam.session WHERE token_hash = $1`,
      [tokenHash],
    );
    const session = res.rows[0] as SessionRow | undefined;
    if (!session) return null;

    const userRes = await this.db.pool.query(
      `SELECT id, email, display_name AS "displayName", status,
              (mfa_enrolled_at IS NOT NULL) AS "mfaEnrolled"
         FROM iam.user_account WHERE id = $1`,
      [session.userId],
    );
    const user = userRes.rows[0] as SessionContext['user'] | undefined;
    if (!user) return null;

    let organization: SessionContext['organization'] = null;
    let membershipStatus: string | null = null;
    let roles: string[] = [];
    if (session.organizationId) {
      organization = await this.findOrganization(session.organizationId);
      const memRes = await this.db.pool.query(
        `SELECT m.status,
                COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
           FROM iam.membership m
           LEFT JOIN iam.membership_role mr ON mr.membership_id = m.id
           LEFT JOIN iam.role r ON r.id = mr.role_id
          WHERE m.user_id = $1 AND m.organization_id = $2 AND m.status <> 'ended'
          GROUP BY m.id`,
        [session.userId, session.organizationId],
      );
      const mem = memRes.rows[0] as { status: string; roles: string[] } | undefined;
      membershipStatus = mem?.status ?? null;
      roles = mem?.roles ?? [];
    }
    return { session, user, organization, membershipStatus, roles };
  }

  async touchSession(sessionId: string, idleExpiresAt: Date): Promise<void> {
    await this.db.pool.query(
      `UPDATE iam.session SET last_seen_at = now(), idle_expires_at = $2 WHERE id = $1`,
      [sessionId, idleExpiresAt],
    );
  }

  /** Rotation keeps the row (inventory continuity) but replaces the bearer secret (doc 20 §6). */
  async rotateSessionToken(sessionId: string, newTokenHash: string, client?: Queryable): Promise<void> {
    await this.q(client).query(`UPDATE iam.session SET token_hash = $2 WHERE id = $1`, [
      sessionId,
      newTokenHash,
    ]);
  }

  async setSessionOrganization(sessionId: string, organizationId: string, client?: Queryable): Promise<void> {
    await this.q(client).query(
      `UPDATE iam.session SET organization_id = $2 WHERE id = $1`,
      [sessionId, organizationId],
    );
  }

  async upgradeSessionStrength(sessionId: string, client?: Queryable): Promise<void> {
    await this.q(client).query(
      `UPDATE iam.session
         SET auth_strength = 'password+totp', mfa_pending = false, authenticated_at = now()
       WHERE id = $1`,
      [sessionId],
    );
  }

  async revokeSession(sessionId: string, reason: string, client?: Queryable): Promise<void> {
    await this.q(client).query(
      `UPDATE iam.session SET revoked_at = now(), revoked_reason = $2
       WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
  }

  async revokeUserSessions(
    userId: string,
    reason: string,
    opts: { exceptSessionId?: string; organizationId?: string } = {},
    client?: Queryable,
  ): Promise<number> {
    const conditions = ['user_id = $1', 'revoked_at IS NULL'];
    const params: unknown[] = [userId, reason];
    if (opts.exceptSessionId) {
      params.push(opts.exceptSessionId);
      conditions.push(`id <> $${params.length}`);
    }
    if (opts.organizationId) {
      params.push(opts.organizationId);
      conditions.push(`organization_id = $${params.length}`);
    }
    const res = await this.q(client).query(
      `UPDATE iam.session SET revoked_at = now(), revoked_reason = $2 WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return res.rowCount ?? 0;
  }

  async listUserSessions(userId: string): Promise<SessionRow[]> {
    const res = await this.db.pool.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM iam.session
        WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expires_at > now()
        ORDER BY last_seen_at DESC`,
      [userId],
    );
    return res.rows;
  }

  // ---- invitations ----

  async createInvitation(
    input: {
      organizationId: string;
      email: string;
      proposedRoleKeys: string[];
      tokenHash: string;
      invitedBy: string;
      expiresAt: Date;
    },
    client?: Queryable,
  ): Promise<{ id: string }> {
    const res = await this.q(client).query<{ id: string }>(
      `INSERT INTO iam.invitation
         (organization_id, email, proposed_role_keys, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        input.organizationId,
        input.email,
        input.proposedRoleKeys,
        input.tokenHash,
        input.invitedBy,
        input.expiresAt,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('invitation insert returned no row');
    return row;
  }

  async findInvitationByHash(tokenHash: string, client?: Queryable): Promise<InvitationRow | null> {
    const res = await this.q(client).query(
      `SELECT id, organization_id AS "organizationId", email,
              proposed_role_keys AS "proposedRoleKeys", invited_by AS "invitedBy",
              expires_at AS "expiresAt", consumed_at AS "consumedAt", revoked_at AS "revokedAt"
         FROM iam.invitation WHERE token_hash = $1`,
      [tokenHash],
    );
    return (res.rows[0] as InvitationRow) ?? null;
  }

  /** Single-use consumption guarded in SQL (AUTH-08); zero rows = already used/expired/revoked. */
  async consumeInvitation(id: string, consumedBy: string, client?: Queryable): Promise<boolean> {
    const res = await this.q(client).query(
      `UPDATE iam.invitation SET consumed_at = now(), consumed_by = $2
       WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [id, consumedBy],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async revokeInvitation(id: string, organizationId: string, client?: Queryable): Promise<boolean> {
    const res = await this.q(client).query(
      `UPDATE iam.invitation SET revoked_at = now()
       WHERE id = $1 AND organization_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [id, organizationId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

function mapSite(row: Record<string, unknown>): OrganizationSite {
  return {
    siteId: row['id'] as string,
    label: row['label'] as string,
    kind: row['kind'] as OrganizationSite['kind'],
    addressLine1: row['address_line1'] as string,
    addressLine2: row['address_line2'] as string,
    city: row['city'] as string,
    state: row['state'] as string,
    postalCode: row['postal_code'] as string,
    countryCode: row['country_code'] as string,
    gstin: (row['gstin'] as string | null) ?? null,
    contactName: row['contact_name'] as string,
    contactPhone: row['contact_phone'] as string,
    status: row['status'] as OrganizationSite['status'],
  };
}
