import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, rows } from './db.js';
import { TABLES } from './tables.js';

/**
 * גיבוי מלא לקובץ JSON.
 *
 * לא משתמש ב-pg_dump בכוונה — הוא דורש לקוח Postgres מותקן, ובמכונה הזו אין.
 * הפורמט פשוט: טבלה -> מערך שורות, בסדר שמכבד מפתחות זרים בשחזור.
 *
 *   npm run backup
 */

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.BACKUP_DIR || join(here, '..', 'backups');

const dump = { created_at: new Date().toISOString(), tables: {} };

for (const t of TABLES) {
  dump.tables[t] = await rows(`select * from ${t} order by id`);
}

await mkdir(outDir, { recursive: true });
const stamp = dump.created_at.replace(/[:.]/g, '-').slice(0, 19);
const file = join(outDir, `backup-${stamp}.json`);
await writeFile(file, JSON.stringify(dump, null, 2), 'utf8');

const total = Object.values(dump.tables).reduce((s, r) => s + r.length, 0);
console.log(`גובו ${total} שורות מ-${TABLES.length} טבלאות`);
for (const [t, r] of Object.entries(dump.tables)) {
  if (r.length) console.log(`  ${t}: ${r.length}`);
}
console.log(`\nנשמר: ${file}`);
console.log('הקובץ מכיל hash-ים של סיסמאות. לא לשתף.');

await pool.end();
