import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARGON2ID_PARAMS_VERSION, BCRYPT_PARAMS_VERSION } from '../src/modules/iam/domain/password';
import { Argon2Hasher } from '../src/modules/iam/infrastructure/argon2-hasher';
import { PgcryptoHasher } from '../src/modules/iam/infrastructure/pgcrypto-hasher';
import type { ConfigService } from '../src/platform/config/config.service';
import { DatabaseService } from '../src/platform/database/database.service';
import { PostgresRateLimitStore } from '../src/platform/http/rate-limit/postgres-store';

const PASSWORD = 'correct horse battery staple';

describe('password hashers (doc 20 §4, ADR-0009)', () => {
  let db: TestDatabase;
  let dbService: DatabaseService;

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_hasher');
    dbService = new DatabaseService({ env: { DATABASE_URL: db.url } } as unknown as ConfigService);
  }, 60_000);

  afterAll(async () => {
    await dbService.onModuleDestroy();
    await db.drop();
  });

  it('bcrypt through Postgres: cost 10, checks the right password, refuses a wrong one', async () => {
    const hasher = new PgcryptoHasher(dbService);
    const hash = await hasher.hash(PASSWORD);

    expect(hasher.paramsVersion).toBe(BCRYPT_PARAMS_VERSION);
    expect(hash.startsWith('$2a$10$')).toBe(true);
    expect(await hasher.verify(hash, PASSWORD)).toBe(true);
    expect(await hasher.verify(hash, `${PASSWORD}!`)).toBe(false);
    await expect(hasher.burn()).resolves.toBeUndefined();
  });

  it('bcrypt does not take an argon2 hash for a match, and argon2 does not take bcrypt', async () => {
    const bcrypt = new PgcryptoHasher(dbService);
    const argon2 = new Argon2Hasher();

    expect(await bcrypt.verify(await argon2.hash(PASSWORD), PASSWORD)).toBe(false);
    expect(await argon2.verify(await bcrypt.hash(PASSWORD), PASSWORD)).toBe(false);
  });

  it('argon2id is unchanged: version 1, checks and burns', async () => {
    const hasher = new Argon2Hasher();
    const hash = await hasher.hash(PASSWORD);

    expect(hasher.paramsVersion).toBe(ARGON2ID_PARAMS_VERSION);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(hash, PASSWORD)).toBe(true);
    expect(await hasher.verify(hash, 'wrong password')).toBe(false);
    await expect(hasher.burn()).resolves.toBeUndefined();
  });
});

describe('rate-limit counters in Postgres (F-CW.1)', () => {
  let db: TestDatabase;
  let dbService: DatabaseService;

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_rlpg');
    dbService = new DatabaseService({ env: { DATABASE_URL: db.url } } as unknown as ConfigService);
  }, 60_000);

  afterAll(async () => {
    await dbService.onModuleDestroy();
    await db.drop();
  });

  it('counts hits in the current window and reports the previous one', async () => {
    const store = new PostgresRateLimitStore(dbService);
    const windowMs = 60_000;
    const start = 1_800_000_000_000; // a window boundary

    expect(await store.hit('login:ip:a', windowMs, start)).toEqual({ current: 1, previous: 0 });
    expect(await store.hit('login:ip:a', windowMs, start + 1_000)).toEqual({ current: 2, previous: 0 });
    expect(await store.hit('login:ip:b', windowMs, start + 2_000)).toEqual({ current: 1, previous: 0 });
    expect(await store.hit('login:ip:a', windowMs, start + windowMs)).toEqual({ current: 1, previous: 2 });
  });

  it('counts every one of many simultaneous hits', async () => {
    const store = new PostgresRateLimitStore(dbService);
    const now = 1_900_000_000_000;
    await Promise.all(Array.from({ length: 20 }, () => store.hit('burst', 60_000, now)));
    expect(await store.hit('burst', 60_000, now)).toEqual({ current: 21, previous: 0 });
  });

  it('stamps each row to expire two windows after its own starts', async () => {
    const store = new PostgresRateLimitStore(dbService);
    const windowMs = 60_000;
    const now = 2_000_000_030_000;
    await store.hit('expiry', windowMs, now);
    const row = await dbService.pool.query<{ expires_at: Date }>(
      `SELECT expires_at FROM platform.rate_limit_counter WHERE key = 'expiry'`,
    );
    expect(row.rows[0]!.expires_at.getTime()).toBe((Math.floor(now / windowMs) + 2) * windowMs);
  });
});
