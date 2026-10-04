import type { Mailer } from '../../mailer';
import type { OutboxEventRow, HandlerResult } from '../types';

/**
 * iam.invitation.issued.v1 → invitation email. The mail carries organization and link only
 * (AUTH-09); the raw token is stripped from the stored event after successful delivery.
 */
export function invitationIssuedHandler(mailer: Mailer, portalUrl: string) {
  return async (event: OutboxEventRow): Promise<HandlerResult> => {
    const email = String(event.data['email'] ?? '');
    const organizationName = String(event.data['organizationName'] ?? 'JobWork');
    const rawToken = event.data['rawToken'];
    if (!email || typeof rawToken !== 'string') {
      throw new Error('invitation event missing email or token');
    }
    const acceptUrl = `${portalUrl}/accept-invitation?token=${encodeURIComponent(rawToken)}`;
    await mailer.send({
      to: email,
      subject: `Invitation to join ${organizationName} on JobWork`,
      text:
        `You have been invited to join ${organizationName} on JobWork.\n\n` +
        `Accept the invitation: ${acceptUrl}\n\n` +
        `The link expires and can be used once. If you did not expect this, ignore this email.`,
      deliveryId: event.id,
    });
    return { stripDataKeys: ['rawToken'] };
  };
}
