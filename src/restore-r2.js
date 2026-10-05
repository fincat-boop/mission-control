import 'dotenv/config';
import { migrate, pool, tx } from './db.js';
import { TABLES } from './tables.js';
import { downloadFull, listBackups } from './full-backup.js';

/**
 * שחזור גיבוי מלא מ-R2. פעולה הרסנית: מוחקת את כל התוכן הקיים ומחליפה.
 *
 *   node src/restore-r2.js                      רשימת הגיבויים הזמינים
 *   node src/restore-r2.js daily/2026-08-11...  הרצה יבשה
 *   node src/restore-r2.js daily/2026-08-11... --yes   שחזור אמיתי
 */
const prefix = process.argv[2];
const confirmed = process.argv.includes('--yes');

if (!prefix || prefix.startsWith('--')) {
  const all = await listBackups();
  console.log('גיבויים זמינים ב-R2:\n');
  for (const [tier, list] of Object.entries(all)) {
    console.log(`${tier}:`);
    if (!list.length) console.log('  (אין)');
    for (const p of list) console.log(`  ${p}`);
  }
  console.log('\nלשחזור: node src/restore-r2.js <prefix> --yes');
  await pool.end();
  process.exit(0);
}

console.log(`מוריד ${prefix} מ-R2...`);
const { dump, assets } = await downloadFull(prefix);
const counts = Object.entries(dump.tables ?? {}).map(([t, r]) => `${t}=${r.length}`);
console.log(`גיבוי מ-${dump.created_at}`);
console.log(counts.join(', '));
console.log(`קבצים מצורפים: ${assets.size}`);

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
      // קובץ עם storage_key יושב ב-bucket המדיה — רק השורה משוחזרת
      if (t === 'content_assets' && !row.storage_key) {
        const data = assets.get(row.id);
        if (!data) throw new Error(`חסר בייטים לקובץ מצורף id=${row.id} בגיבוי`);
        values.data = data;
      }
      const cols = Object.keys(values);
      const params = cols.map((_, i) => `$${i + 1}`).join(', ');
      await client.query(
        `insert into ${t} (${cols.join(', ')}) values (${params})`,
        cols.map((c) => values[c])
      );
    }

    // יישור הרצף כדי שהמזהה הבא לא יתנגש בשורות ששוחזרו
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
