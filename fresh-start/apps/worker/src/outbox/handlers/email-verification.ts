import type { Mailer } from '../../mailer';
import type { OutboxEventRow, HandlerResult } from '../types';

/**
 * iam.email_verification.issued.v1 → verification email (F-MX.4). The mail carries the
 * link only; the raw token is stripped from the stored event after delivery, exactly as
 * invitations do (AUTH-09).
 */
export function emailVerificationHandler(mailer: Mailer, portalUrl: string) {
  return async (event: OutboxEventRow): Promise<HandlerResult> => {
    const email = String(event.data['email'] ?? '');
    const rawToken = event.data['rawToken'];
    if (!email || typeof rawToken !== 'string') {
      throw new Error('email verification event missing email or token');
    }
    const verifyUrl = `${portalUrl}/verify-email?token=${encodeURIComponent(rawToken)}`;
    await mailer.send({
      to: email,
      subject: 'Confirm your email for JobWork',
      text:
        `Welcome to JobWork.\n\n` +
        `Confirm your email to sign in: ${verifyUrl}\n\n` +
        `The link expires and can be used once. If you did not register, ignore this email.`,
      deliveryId: event.id,
    });
    return { stripDataKeys: ['rawToken'] };
  };
}
