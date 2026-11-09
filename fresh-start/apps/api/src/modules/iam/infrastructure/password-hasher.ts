/**
 * Hashes and checks passwords (doc 20 §4). Which algorithm runs is a deployment setting
 * (`PASSWORD_HASHER`, ADR-0009): argon2id where native modules run, bcrypt computed by
 * Postgres where they cannot.
 */
export interface PasswordHasher {
  /** Stored beside each hash so a later login can tell what made it (`domain/password.ts`). */
  readonly paramsVersion: number;
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  /** One verification's cost spent on nothing: an unknown account answers as slowly as a known one (AUTH-11). */
  burn(): Promise<void>;
}

export const PASSWORD_HASHER = Symbol('PasswordHasher');
