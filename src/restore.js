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
  // מפתחות זרים שמצביעים על אותה טבלה (משבצת מקושרת → המקור שלה,
  // content_items.linked_to_id) נבדקים בסוף הטרנזקציה: עוקבת יכולה להופיע
  // בקובץ לפני המקור שלה
  await client.query('set constraints all deferred');
  // מחיקה בסדר הפוך, כדי לא לשבור מפתחות זרים
  for (const t of [...TABLES].reverse()) {
    await client.query(`delete from ${t}`);
  }

  for (const t of TABLES) {
    const list = dump.tables[t] ?? [];
    for (const row of list) {
      const values = { ...row };
      // הבייטים של הקבצים יושבים בתיקייה שלצד ה-JSON. קובץ עם storage_key
      // יושב ב-bucket המדיה ב-R2 — רק השורה משוחזרת.
      if (t === 'content_assets' && !row.storage_key) {
        values.data = await readFile(join(dirname(file), dump.assets_dir, String(row.id)));
      }
      const cols = Object.keys(values);
      const params = cols.map((_, i) => `$${i + 1}`).join(', ');
      await client.query(
        `insert into ${t} (${cols.join(', ')}) values (${params})`,
        cols.map((c) => values[c])
      );
    }

    // יישור הרצף כדי שהמזהה הבא לא יתנגש בשורות ששוחזרו.
    // pg_get_serial_sequence זורק שגיאה על עמודה שלא קיימת, ולכן בודקים קודם
    // שיש בכלל עמודת id — יש טבלאות עם מפתח מורכב בלבד.
    const col = await client.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = $1 and column_name = 'id'`,
      [t]
    );
    if (col.rowCount) {
      const seq = await client.query(`select pg_get_serial_sequence($1, 'id') as seq`, [t]);
      if (seq.rows[0]?.seq) {
        await client.query(
          `select setval($1, coalesce((select max(id) from ${t}), 1))`,
          [seq.rows[0].seq]
        );
      }
    }
  }
});

// קובץ ששוחזר וחי עדיין בסל המחזור של המדיה — חוזר לשימוש, לא יימחק
await tx((client) => client.query(
  `delete from media_trash where storage_key in
     (select storage_key from content_assets where storage_key is not null)`));

console.log('\nהשחזור הושלם.');
await pool.end();
