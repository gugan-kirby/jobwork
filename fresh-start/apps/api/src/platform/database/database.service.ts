import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { registerPgTypeParsers } from '@jobwork/database';
import { createLogger } from '@jobwork/observability';
import { ConfigService } from '../config/config.service';

// Registered before the first pool so every `date` column arrives as the calendar
// string Postgres sent, never as an instant to be re-zoned.
registerPgTypeParsers();

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    // An idle connection the server ends (restart, failover, an operator's terminate)
    // surfaces as an error on the pool. Without a listener Node treats it as uncaught and
    // the process dies; with one, the dead client is discarded and the next query opens
    // a fresh connection (doc 12 §3: a database blip degrades, it does not crash).
    const log = createLogger({ service: 'api' });
    this.pool.on('error', (err) => {
      log.warn({ code: (err as { code?: string }).code }, 'db.idle_client_error');
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
