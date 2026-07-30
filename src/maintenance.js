import { query, rows } from './db.js';
import { buildDump } from './backup.js';

/**
 * משימות תחזוקה שרצות ברקע, לא בתגובה לבקשת משתמש. נרשמות ליומן
 * הפעולות עם via='system' כדי שיהיה ברור מאיפה השינוי הגיע.
 */

const SYSTEM_USER_NAME = 'תחזוקה אוטומטית';
const BACKUP_RETENTION = 14;           // כמה גיבויים תקופתיים לשמור
const URGENT_GRACE_HOURS = 24;         // כמה זמן אחרי המועד לתת לפני שזורקים

async function logSystem(action, entity, entity_id, summary, meta = null) {
  await query(
    `insert into activity_log (user_id, user_name, via, action, entity, entity_id, summary, meta)
     values (null, $1, 'system', $2, $3, $4, $5, $6)`,
    [SYSTEM_USER_NAME, action, entity, entity_id, summary, meta]
  ).catch((e) => console.error('כתיבה ליומן הפעולות (תחזוקה) נכשלה:', e.message));
}

/**
 * תמונת מצב יחסית לתוך טבלת backups (לא לדיסק — הדיסק של הקונטיינר
 * לא שורד דיפלוי חדש ב-Railway). בלי בייטים של קבצים מצורפים, ראו
 * ההערה ב-schema.sql. שומר את ה-N האחרונים בלבד.
 */
export async function backupNow() {
  const dump = await buildDump();
  const rowCount = Object.values(dump.tables).reduce((s, r) => s + r.length, 0);

  await query(
    `insert into backups (row_count, payload) values ($1, $2)`,
    [rowCount, JSON.stringify(dump)]
  );
  const pruned = await rows(
    `delete from backups
      where id not in (select id from backups order by created_at desc limit $1)
      returning id`,
    [BACKUP_RETENTION]
  );

  console.log(`גיבוי אוטומטי נשמר: ${rowCount} שורות` +
    (pruned.length ? `, ${pruned.length} גיבויים ישנים נמחקו` : ''));
  await logSystem('create', 'backup', null, `גיבוי אוטומטי — ${rowCount} שורות`);
}

/**
 * מבצע דחוף נושא רק כותרת קצרה, לא תוכן מלא (ראו openUrgent ב-app.js).
 * אם המועד עבר ואף אחד לא סימן שהוא יצא בפועל — השיבוץ תפס משבצת
 * פנויה לשווא, ועדיף לשחרר אותה מאשר להשאיר "רפאים" על הלוח.
 */
export async function cleanupStaleUrgent() {
  const stale = await rows(
    `delete from posts
      where urgent = true
        and status in ('scheduled','pending_approval')
        and scheduled_at < now() - ($1 || ' hours')::interval
      returning id, title, channel_id`,
    [URGENT_GRACE_HOURS]
  );

  if (!stale.length) return;
  console.log(`${stale.length} שיבוצי מבצע דחוף בלי תוכן נמחקו אוטומטית (עברו ${URGENT_GRACE_HOURS} שעות בלי סימון פרסום)`);
  for (const p of stale) {
    await logSystem('delete', 'posts', String(p.id),
      `נמחק אוטומטית — מבצע דחוף "${p.title}" עבר ${URGENT_GRACE_HOURS} שעות בלי סימון כפורסם`);
  }
}
