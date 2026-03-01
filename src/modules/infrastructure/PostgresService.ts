import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { Pool as PgPool } from "pg";
import type { Logger } from "pino";

export class PostgresService {
  private readonly pool: Pool;

  public constructor(
    postgresUrl: string,
    private readonly logger: Logger
  ) {
    this.pool = new PgPool({
      connectionString: postgresUrl,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });

    this.pool.on("error", (error) => {
      this.logger.error({ err: error }, "Erreur connexion PostgreSQL");
    });
  }

  public async initialize(): Promise<void> {
    await this.query("SELECT 1");
    await this.ensureSchema();
    this.logger.info("PostgreSQL initialise");
  }

  public async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params as unknown[]);
  }

  public async runInTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        this.logger.error({ err: rollbackError }, "Echec rollback PostgreSQL");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureSchema(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        autoplay BOOLEAN NOT NULL,
        stay_in_voice BOOLEAN NOT NULL,
        volume INTEGER NOT NULL CHECK (volume BETWEEN 1 AND 200),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS music_panels (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
}

