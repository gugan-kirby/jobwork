import { Injectable } from '@nestjs/common';
import type { RegisterCustomerRequest } from '@jobwork/contracts';
import { createLogger, getCorrelationId, type Logger } from '@jobwork/observability';
import { EmailAlreadyRegistered, VerificationInvalid } from '../domain/errors';
import { PASSWORD_PARAMS_VERSION, hashPassword, passwordPolicyIssue } from '../domain/password';
import { generateToken, hashToken } from '../domain/tokens';
import { IamRepository } from '../infrastructure/iam.repository';
import { AuditWriter } from '../../../platform/commands/audit.writer';
import type { CommandContext } from '../../../platform/commands/command';
import { OutboxWriter } from '../../../platform/commands/outbox.writer';
import { ConfigService } from '../../../platform/config/config.service';
import { DatabaseService } from '../../../platform/database/database.service';
import { ValidationFailed } from '../../../platform/http/domain-error';

/** A verification link lives a day; a registration nobody confirms in that time starts over. */
export const EMAIL_VERIFICATION_TTL_HOURS = 24;

/** The first person in a customer organization holds every customer role until they delegate. */
const CUSTOMER_OWNER_ROLES = ['org_admin', 'customer_requester', 'customer_approver'];

/**
 * Self-registration for customers (F-MX.4, doc 20 §2). One transaction writes the
 * account, its organization, the owner membership and the verification token, with
 * audit and outbox beside them — a registration that half-exists (an account with no
 * organization, an organization nobody can enter) is worse than none.
 *
 * The account starts `pending_verification`: `AuthService.login` refuses anything but
 * `active`, so the email must be proven before the first sign-in. Suppliers do not come
 * through here at all — they apply, and JobWork admits (F-SO).
 */
@Injectable()
export class RegistrationService {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'iam.registration' });

  constructor(
    private readonly repo: IamRepository,
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async registerCustomer(
    input: RegisterCustomerRequest,
  ): Promise<{ userId: string; organizationId: string; verifyUrl?: string }> {
    const issue = passwordPolicyIssue(input.password);
    if (issue) throw new ValidationFailed([{ path: 'password', message: issue }]);

    // Hash first, then look: the cost is paid whether or not the email is taken, so the
    // response time does not say which (AUTH-11).
    const passwordHash = await hashPassword(input.password);
    const existing = await this.repo.findUserByEmail(input.email);
    if (existing) throw new EmailAlreadyRegistered();

    const organizationName = input.organizationName?.trim() || input.fullName.trim();
    const token = generateToken();

    let created: { userId: string; organizationId: string };
    try {
      created = await this.db.withTransaction(async (tx) => {
        const user = await this.repo.createPendingUser(
          {
            email: input.email,
            passwordHash,
            passwordParamsVersion: PASSWORD_PARAMS_VERSION,
            displayName: input.fullName.trim(),
            phone: input.mobile?.trim() ?? '',
          },
          tx,
        );
        const organization = await this.repo.createOrganization(
          {
            type: 'customer',
            legalName: organizationName,
            displayName: organizationName,
            createdBy: user.id,
          },
          tx,
        );
        await this.repo.createMembership(
          {
            userId: user.id,
            organizationId: organization.id,
            roleKeys: CUSTOMER_OWNER_ROLES,
            createdBy: user.id,
          },
          tx,
        );
        await this.repo.createEmailVerification(
          {
            userId: user.id,
            tokenHash: hashToken(token),
            expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000),
          },
          tx,
        );

        const ctx: CommandContext = {
          actor: { type: 'user', id: user.id, organizationId: organization.id },
          correlationId: getCorrelationId() ?? 'uncorrelated',
        };
        await this.audit.write(tx, ctx, {
          action: 'iam.customer_registered',
          subjectType: 'organization',
          subjectId: organization.id,
          data: { userId: user.id, roleKeys: CUSTOMER_OWNER_ROLES, selfService: true },
        });
        await this.outbox.write(tx, ctx, {
          eventType: 'iam.email_verification.issued.v1',
          aggregateType: 'user',
          aggregateId: user.id,
          data: {
            userId: user.id,
            email: input.email,
            // Raw token must not outlive delivery: the worker strips it after send.
            rawToken: token,
          },
        });
        return { userId: user.id, organizationId: organization.id };
      });
    } catch (err) {
      // Two registrations racing on one email: the unique index decides, and the loser
      // gets the same answer it would have had a moment later.
      if ((err as { code?: string }).code === '23505') throw new EmailAlreadyRegistered();
      throw err;
    }

    this.log.info({ organizationId: created.organizationId }, 'auth.customer_registered');
    const result: { userId: string; organizationId: string; verifyUrl?: string } = created;
    if (this.config.env.NODE_ENV !== 'production') {
      result.verifyUrl = `http://localhost:3000/verify-email?token=${token}`;
    }
    return result;
  }

  /** Proves the email and opens the account. Single use, guarded in SQL, audited as the user. */
  async verifyEmail(token: string): Promise<{ userId: string }> {
    const row = await this.repo.findEmailVerificationByHash(hashToken(token));
    if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
      throw new VerificationInvalid();
    }
    await this.db.withTransaction(async (tx) => {
      const consumed = await this.repo.consumeEmailVerification(row.id, tx);
      if (!consumed) throw new VerificationInvalid();
      await this.repo.activateUser(row.userId, tx);
      await this.audit.write(
        tx,
        {
          actor: { type: 'user', id: row.userId, organizationId: null },
          correlationId: getCorrelationId() ?? 'uncorrelated',
        },
        { action: 'iam.email_verified', subjectType: 'user', subjectId: row.userId },
      );
    });
    this.log.info({ userId: row.userId }, 'auth.email_verified');
    return { userId: row.userId };
  }
}
