import argon2 from 'argon2';

/** Bump when tuning parameters; verify() reports needsRehash for older versions (doc 20 §4). */
export const PASSWORD_PARAMS_VERSION = 1;

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function passwordPolicyIssue(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/** Constant-cost work for unknown accounts so login timing does not reveal existence (AUTH-11). */
const DUMMY_HASH_PROMISE = hashPassword('jobwork-timing-equalizer');
export async function burnVerification(): Promise<void> {
  const dummy = await DUMMY_HASH_PROMISE;
  await verifyPassword(dummy, 'definitely-not-the-password');
}
