import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { migrate, pool, tx } from './db.js';
import { TABLES } from './tables.js';

/**
 * שחזור מקובץ גיבוי. פעולה הרסנית: מוחקת את כל התוכן הקיים ומחליפה אותו.
 *
 *   node src/restore.js backups/backup-....json --yes
 *
 * בלי --yes הסקריפט רק מדווח מה היה עושה.
 */
const file = process.argv[2];
const confirmed = process.argv.includes('--yes');

if (!file) {
  console.error('שימוש: node src/restore.js <קובץ-גיבוי.json> [--yes]');
  process.exit(1);
}

const dump = JSON.parse(await readFile(file, 'utf8'));
const counts = Object.entries(dump.tables ?? {}).map(([t, r]) => `${t}=${r.length}`);

console.log(`גיבוי מ-${dump.created_at}`);
console.log(counts.join(', '));

if (!confirmed) {
  console.log('\nהרצה יבשה. שום דבר לא שוחזר.');
  console.log('להרצה אמיתית — להוסיף --yes. שים לב: כל הנתונים הקיימים יימחקו.');
  await pool.end();
  process.exit(0);
}

await migrate();

await tx(async (client) => {
  // מחיקה בסדר הפוך, כדי לא לשבור מפתחות זרים
  for (const t of [...TABLES].reverse()) {
    await client.query(`delete from ${t}`);
  }

  for (const t of TABLES) {
    const list = dump.tables[t] ?? [];
    for (const row of list) {
      const values = { ...row };
      // הבייטים של הקבצים יושבים בתיקייה שלצד ה-JSON
      if (t === 'content_assets') {
        values.data = await readFile(join(dirname(file), dump.assets_dir, String(row.id)));
      }
      const cols = Object.keys(values);
      const params = cols.map((_, i) => `$${i + 1}`).join(', ');
      await client.query(
        `insert into ${t} (${cols.join(', ')}) values (${params})`,
        cols.map((c) => values[c])
      );
    }

    // יישור הרצף כדי שהמזהה הבא לא יתנגש בשורות ששוחזרו
    if (t !== 'engine_settings') {
      await client.query(
        `select setval(pg_get_serial_sequence('${t}', 'id'),
                       coalesce((select max(id) from ${t}), 1))`
      );
    }
  }
});

console.log('\nהשחזור הושלם.');
await pool.end();
