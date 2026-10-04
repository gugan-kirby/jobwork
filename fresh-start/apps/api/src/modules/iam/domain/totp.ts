import * as OTPAuth from 'otpauth';

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

function totpFor(secret: string, email: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'JobWork',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

export function totpUri(secret: string, email: string): string {
  return totpFor(secret, email).toString();
}

/** Accepts one period of clock drift either side. */
export function verifyTotp(secret: string, email: string, code: string): boolean {
  const delta = totpFor(secret, email).validate({ token: code.trim(), window: 1 });
  return delta !== null;
}
