// Stands in for nodemailer on Workers (ADR-0009): MAIL_TRANSPORT=api never builds an SMTP
// transport, so reaching this is a configuration error and says so.
export function createTransport() {
  throw new Error('SMTP is not available on Workers; set MAIL_TRANSPORT=api (ADR-0009)');
}
export default { createTransport };
