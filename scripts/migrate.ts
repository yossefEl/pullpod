import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from '../src/db/pool.js';
import { logger } from '../src/logger.js';

/**
 * Minimal forward-only migration runner. Applies every .sql file in
 * supabase/migrations in lexical order, tracking applied files in a table.
 * Idempotent: files already recorded are skipped.
 */
async function main(): Promise<void> {
  const dir = path.resolve(fileURLToPath(new URL('../supabase/migrations', import.meta.url)));
  await pool.query(
    `create table if not exists _migrations (name text primary key, applied_at timestamptz default now())`,
  );
  const applied = new Set(
    (await pool.query<{ name: string }>(`select name from _migrations`)).rows.map((r) => r.name),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      logger.info({ file }, 'already applied, skipping');
      continue;
    }
    const sql = readFileSync(path.join(dir, file), 'utf8');
    logger.info({ file }, 'applying migration');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(`insert into _migrations (name) values ($1)`, [file]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }
  logger.info('migrations complete');
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, 'migration failed');
  process.exit(1);
});
