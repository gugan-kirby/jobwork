import { BCRYPT_PARAMS_VERSION } from '../domain/password';
import { DatabaseService } from '../../../platform/database/database.service';
import type { PasswordHasher } from './password-hasher';

/**
 * bcrypt (cost 10) computed by Postgres through pgcrypto (ADR-0009). A Worker on the free
 * plan has 10 ms of CPU per request, too little for any adaptive hash, but time spent
 * waiting on the database is not counted. Names are unqualified: pgcrypto lives in
 * `public` locally (migration 0001) and in `extensions` on Supabase, which is on the
 * search path there.
 */
export class PgcryptoHasher implements PasswordHasher {
  readonly paramsVersion = BCRYPT_PARAMS_VERSION;

  constructor(private readonly db: DatabaseService) {}

  async hash(password: string): Promise<string> {
    const result = await this.db.pool.query<{ hash: string }>(
      `SELECT crypt($1, gen_salt('bf', 10)) AS hash`,
      [password],
    );
    return result.rows[0]!.hash;
  }

  async verify(hash: string, password: string): Promise<boolean> {
    // crypt() raises on a salt it cannot parse; an argon2 hash is simply not a match here.
    if (!hash.startsWith('$2')) return false;
    const result = await this.db.pool.query<{ ok: boolean }>(`SELECT crypt($1, $2) = $2 AS ok`, [password, hash]);
    return result.rows[0]!.ok;
  }

  async burn(): Promise<void> {
    // Hashing and checking run the same cost-10 key schedule, so one hash costs one check.
    await this.db.pool.query(`SELECT crypt($1, gen_salt('bf', 10))`, ['jobwork-timing-equalizer']);
  }
}
