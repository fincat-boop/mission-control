import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  throw new Error(
    'חסר DATABASE_URL. מקומית — קובץ .env; ב-Railway — מחברים את שירות Postgres למשתנה ${{Postgres.DATABASE_URL}}'
  );
}

// Railway מגיש Postgres עם תעודה עצמית, לכן rejectUnauthorized:false.
// מקומית (localhost) אין SSL בכלל.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

// עמודות date נשארות מחרוזת 'YYYY-MM-DD'. ברירת המחדל של node-postgres היא Date
// בחצות מקומית, ואז JSON.stringify מסובב אותה ל-UTC ומזיז את היום אחורה.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 8,
});

export function query(text, params) {
  return pool.query(text, params);
}

/** מחזיר את כל השורות */
export async function rows(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

/** מחזיר שורה אחת או null */
export async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] ?? null;
}

/** מריץ את schema.sql. בטוח להרצה חוזרת. */
export async function migrate() {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

/** טרנזקציה */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
