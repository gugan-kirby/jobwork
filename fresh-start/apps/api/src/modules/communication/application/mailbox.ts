import { Injectable } from '@nestjs/common';
import type { Mailbox, RecordMailRequest } from '@jobwork/contracts';
import { type Actor, requireRole } from '../../iam';
import { MailRepository } from '../infrastructure/mail.repository';

/** How many messages the Mail page shows: the newest, enough for a demo's inbox. */
export const MAILBOX_LIMIT = 200;

/**
 * Mail an environment keeps instead of sending (F-CW.5, ADR-0009; `MAIL_TRANSPORT=api` on
 * the worker). The messages carry sign-up and invitation links, which are credentials,
 * so only a platform admin reads them.
 */
@Injectable()
export class MailboxService {
  constructor(private readonly repo: MailRepository) {}

  record(mail: RecordMailRequest): Promise<{ outcome: 'recorded' | 'already_recorded' }> {
    return this.repo.record(mail).then((outcome) => ({ outcome }));
  }

  async list(actor: Actor): Promise<Mailbox> {
    requireRole(actor, 'platform_admin');
    return { messages: await this.repo.latest(MAILBOX_LIMIT) };
  }
}
