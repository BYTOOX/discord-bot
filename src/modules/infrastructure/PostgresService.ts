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
      CREATE TABLE IF NOT EXISTS custom_playlists (
        id UUID PRIMARY KEY,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);

    await this.query(
      "CREATE INDEX IF NOT EXISTS idx_custom_playlists_guild_id ON custom_playlists (guild_id)"
    );

    await this.query(`
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        id BIGSERIAL PRIMARY KEY,
        playlist_id UUID NOT NULL REFERENCES custom_playlists(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        query TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        added_by TEXT NOT NULL,
        added_at TIMESTAMPTZ NOT NULL
      )
    `);

    await this.query(
      "CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_id ON playlist_tracks (playlist_id)"
    );

    await this.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_position ON playlist_tracks (playlist_id, position)"
    );

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

