/**
 * Stored beside each hash (`iam.user_account.password_params_version`) so a login can
 * tell which algorithm and parameters made it (doc 20 §4). Bump on any tuning.
 */
export const ARGON2ID_PARAMS_VERSION = 1;
/** bcrypt cost 10 through pgcrypto: Workers deployments (ADR-0009). */
export const BCRYPT_PARAMS_VERSION = 2;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function passwordPolicyIssue(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  // Postgres text cannot hold NUL, so a hash computed there would fail on it.
  if (password.includes('\u0000')) {
    return 'Password must not contain a null character';
  }
  return null;
}
