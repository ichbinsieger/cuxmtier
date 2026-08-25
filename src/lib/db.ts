import { Pool } from "pg";

// Reuse a single pool across hot reloads / serverless warm instances
const globalForDb = globalThis as unknown as { __pgPool?: Pool };

export function getPool(): Pool {
  if (!globalForDb.__pgPool) {
    globalForDb.__pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      ssl: { rejectUnauthorized: false }, // Neon requires SSL; pooled endpoint
    });
  }
  return globalForDb.__pgPool;
}

export interface QueryResult<T = any> {
  rows: T[];
}

export async function query<T = any>(text: string, params: any[] = []): Promise<QueryResult<T>> {
  const pool = getPool();
  const res = await pool.query(text, params);
  return res as unknown as QueryResult<T>;
}

export async function ensureSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS recommendations (
      code        TEXT PRIMARY KEY,
      batch_id    TEXT NOT NULL,
      target_odds NUMERIC NOT NULL,
      actual_odds NUMERIC NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'safe',
      picks       JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checked_at  TIMESTAMPTZ,
      result      JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_recommendations_created ON recommendations (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_recommendations_batch ON recommendations (batch_id);
    ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'safe';

    -- Persistent cache for API-Football enrichment (team ids, form, H2H).
    -- Lets the 4-hourly tracker stay under the free plan's 100 req/day.
    CREATE TABLE IF NOT EXISTS football_cache (
      cache_key  TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_football_cache_updated ON football_cache (updated_at);

    -- Raw completed matches from Football-Data.co.uk CSVs (last ~2 seasons).
    -- Stored raw so the draw model can compute team form/goals/home-away split
    -- /odds-drift over a rolling recent window regardless of season start.
    -- Populated by /api/refreshfootball.
    CREATE TABLE IF NOT EXISTS football_matches (
      league     TEXT NOT NULL,
      season     TEXT NOT NULL,
      match_date DATE NOT NULL,
      home       TEXT NOT NULL,
      away       TEXT NOT NULL,
      fthg       INT,
      ftag       INT,
      ftr        TEXT,
      open_draw  REAL,
      close_draw REAL,
      PRIMARY KEY (league, season, home, away, match_date)
    );
    CREATE INDEX IF NOT EXISTS idx_fm_league_home ON football_matches (league, home);
    CREATE INDEX IF NOT EXISTS idx_fm_league_away ON football_matches (league, away);
  `);
}
