import { one, query, rows } from './db.js';
import { buildDump } from './backup.js';
import { weekMeta } from './board.js';

/**
 * משימות תחזוקה שרצות ברקע, לא בתגובה לבקשת משתמש. נרשמות ליומן
 * הפעולות עם via='system' כדי שיהיה ברור מאיפה השינוי הגיע.
 */

const SYSTEM_USER_NAME = 'תחזוקה אוטומטית';
const BACKUP_RETENTION = 14;           // כמה גיבויים תקופתיים לשמור
const URGENT_GRACE_HOURS = 24;         // כמה זמן אחרי המועד לתת לפני שזורקים
const SWAP_WINDOW_HOURS = 4;           // כמה זמן לפני הפרסום מציעים חלופה

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

/**
 * שיבוץ בלי תוכן שמתקרב למועד הפרסום (SWAP_WINDOW_HOURS) מקבל הצעה
 * למלא את המקום שלו בתוכן אחר שכן מוכן — מדורג לפי חשיבות נקודת הקצה
 * שלו, לא לפי מי שהיה אמור לשבת שם. זו רק הצעה: נוצרת משימה, המשתמש
 * מאשר בעצמו דרך הכפתור בטאב "משימות" (ראו taskRow ב-app.js).
 */
export async function suggestContentSwaps() {
  const candidates = await rows(
    `select p.id, p.channel_id, p.endpoint_id, p.scheduled_at, e.name as endpoint_name
       from posts p
       left join endpoints e on e.id = p.endpoint_id
      where p.status = 'scheduled' and p.content_id is null
        and p.scheduled_at between now() and now() + ($1 || ' hours')::interval
        and not exists (
          select 1 from tasks t
           where t.post_id = p.id and t.kind = 'swap' and t.done = false
        )`,
    [SWAP_WINDOW_HOURS]
  );

  for (const post of candidates) {
    const week = weekMeta(post.scheduled_at);
    const suggestion = await one(
      `select ci.id as content_id, ci.title, ci.kind, ci.endpoint_id, e.name as endpoint_name
         from content_items ci
         join content_variants v on v.content_id = ci.id and v.channel_id = $1 and v.status = 'ready'
         join endpoints e on e.id = ci.endpoint_id and e.active = true
         left join campaigns ca on ca.id = ci.campaign_id
        where (ca.id is null or ca.paused_at is null)
          and not exists (
            select 1 from posts p2
             where p2.content_id = ci.id and p2.channel_id = $1
               and p2.status in ('scheduled','published','pending_approval')
               and p2.scheduled_at >= $2 and p2.scheduled_at <= $3
          )
        order by e.importance desc, ci.created_at asc
        limit 1`,
      [post.channel_id, week.startDate, week.endDate]
    );
    if (!suggestion) continue; // אין כרגע שום תוכן מוכן להציע במקומו

    await query(
      `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on, meta)
       values ($1,$2,'swap',$3,$4,true,$5,$6)`,
      [
        `הצעה: להחליף תוכן בשיבוץ שמתפרסם בקרוב`,
        `${post.endpoint_name ?? 'ללא נקודת קצה'} עדיין בלי תוכן · הצעה: "${suggestion.title}" ` +
        `(${suggestion.endpoint_name}) · מתפרסם ${new Date(post.scheduled_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}`,
        post.id, post.endpoint_id, new Date(post.scheduled_at).toISOString().slice(0, 10),
        JSON.stringify({
          suggested_content_id: suggestion.content_id,
          suggested_title: suggestion.title,
          suggested_kind: suggestion.kind,
          suggested_endpoint_id: suggestion.endpoint_id,
        }),
      ]
    );
    console.log(`הצעת החלפה נוצרה לפוסט #${post.id} (${post.endpoint_name ?? 'ללא נקודת קצה'}) — מוצע: "${suggestion.title}"`);
  }
}
