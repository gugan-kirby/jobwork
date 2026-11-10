import argon2 from 'argon2';
import { ARGON2ID_PARAMS_VERSION } from '../domain/password';
import type { PasswordHasher } from './password-hasher';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

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

/** Argon2id in this process, the default (doc 20 §4). Needs the native module, so never on Workers. */
export class Argon2Hasher implements PasswordHasher {
  readonly paramsVersion = ARGON2ID_PARAMS_VERSION;
  // Made on first use rather than at import, so loading the module costs nothing.
  private timingHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return hashPassword(password);
  }

  verify(hash: string, password: string): Promise<boolean> {
    return verifyPassword(hash, password);
  }

  async burn(): Promise<void> {
    this.timingHash ??= hashPassword('jobwork-timing-equalizer');
    await verifyPassword(await this.timingHash, 'definitely-not-the-password');
  }
}
