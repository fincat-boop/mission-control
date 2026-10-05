import { one, query, rows, withOrg } from './db.js';
import { buildDump } from './backup.js';
import { offsiteBackup } from './offsite-backup.js';
import { fullBackup } from './full-backup.js';
import { weekMeta } from './board.js';
import {
  TRASH_DAYS, legacyMediaKey, legacyUploadMime, mediaReady, mediaStore, orgMediaPrefix, pickOrphans,
} from './media.js';

/**
 * מריץ fn פעם אחת לכל ארגון, בתוך הקשר הטננט שלו. עבודות רקע לא נובעות
 * מבקשה, ולכן אין להן org מובלע — בלי זה הן היו רצות על ה-pool (superuser,
 * עוקף RLS) ומערבבות ארגונים. רשימת הארגונים נשלפת על ה-pool בכוונה.
 */
export async function forEachOrg(fn) {
  const orgs = await rows('select id from orgs order by id');
  for (const { id } of orgs) {
    await withOrg(id, () => fn(id)).catch((e) =>
      console.error(`עבודת רקע נכשלה לארגון ${id}:`, e.message));
  }
}

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

  // כשל כאן לא אמור למנוע את הגיבוי הפנימי שכבר הצליח ונשמר למעלה
  await offsiteBackup(dump).catch((e) => console.error('גיבוי חיצוני ל-Drive נכשל:', e.message));
  // גיבוי מלא (כולל בייטים) ל-R2 — אותה חוסן: כשל לא מפיל את מה שכבר נשמר
  await fullBackup(dump).catch((e) => console.error('גיבוי מלא ל-R2 נכשל:', e.message));
}

/**
 * מבצע דחוף נושא רק כותרת קצרה, לא תוכן מלא (ראו openUrgent ב-app.js).
 * אם המועד עבר ואף אחד לא סימן שהוא יצא בפועל — השיבוץ תפס משבצת
 * פנויה לשווא, ועדיף לשחרר אותה מאשר להשאיר "רפאים" על הלוח.
 */
export async function cleanupStaleUrgent() {
  await forEachOrg(async () => {
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
  });
}

/**
 * שיבוץ בלי תוכן שמתקרב למועד הפרסום (SWAP_WINDOW_HOURS) מקבל הצעה
 * למלא את המקום שלו בתוכן אחר שכן מוכן — מדורג לפי חשיבות נקודת הקצה
 * שלו, לא לפי מי שהיה אמור לשבת שם. זו רק הצעה: נוצרת משימה, המשתמש
 * מאשר בעצמו דרך הכפתור בטאב "משימות" (ראו taskRow ב-app.js).
 */
export async function suggestContentSwaps() {
  await forEachOrg(async () => {
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
               and p2.status in ('scheduled','approved','publishing','failed','published','pending_approval')
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
  });
}

/* ========================= מדיה ב-R2: סל מחזור ויתומים ========================= */

const TRASH_BATCH = 200;                 // כמה מחיקות סופיות לארגון בהרצה
const SWEEP_EVERY_MS = 24 * 3600000;     // סריקת יתומים — לכל היותר פעם ביום
const lastSweep = new Map();             // org → זמן הסריקה האחרונה (בזיכרון התהליך)

/**
 * מוחק סופית מ-R2 את מה שהגיע זמנו בסל המחזור. fail-soft: כשל במחיקה
 * משאיר את השורה בסל, וננסה שוב בהרצה הבאה. מפתח שחזר להיות בשימוש
 * (שחזור מגיבוי, העברת legacy שהצליחה בניסיון חוזר) יוצא מהסל בלי מחיקה.
 */
export async function purgeMediaTrash(store = mediaStore) {
  const due = await rows(
    `select id, bucket, storage_key from media_trash
      where delete_after <= now() order by delete_after limit $1`,
    [TRASH_BATCH]
  );
  let purged = 0;
  let kept = 0;
  for (const t of due) {
    if (await one('select 1 from content_assets where storage_key = $1', [t.storage_key])) {
      await query('delete from media_trash where id = $1', [t.id]);
      kept += 1;
      continue;
    }
    try {
      await store.del(t.storage_key, t.bucket || process.env.R2_PUBLIC_BUCKET);
      await query('delete from media_trash where id = $1', [t.id]);
      purged += 1;
    } catch (e) {
      console.error(`מחיקה סופית של מדיה ${t.storage_key} נכשלה (ננסה שוב):`, e.message);
    }
  }
  return { purged, kept };
}

/**
 * יתומים: אובייקטים תחת media/<org>/ שאף שורה לא מצביעה עליהם — העלאה
 * שלא הושלמה, או קובץ שנמחק בשרשור (מחיקת זווית/גרסה מוחקת שורות בלי
 * לעבור דרך הסל). עוברים לסל לשלושים יום, לא נמחקים מיד.
 */
export async function sweepMediaOrphans(orgId, store = mediaStore, now = new Date()) {
  const { objects } = await store.list(orgMediaPrefix(orgId));
  if (!objects.length) return { orphans: 0 };
  const keys = objects.map((o) => o.key);
  const known = new Set((await rows(
    `select storage_key from content_assets where storage_key = any($1::text[])
     union
     select storage_key from media_trash where storage_key = any($1::text[])`,
    [keys]
  )).map((r) => r.storage_key));

  const orphans = pickOrphans(objects, known, now);
  if (orphans.length) {
    await query(
      `insert into media_trash (bucket, storage_key, delete_after)
       select $1, k, now() + make_interval(days => $3) from unnest($2::text[]) as k
       on conflict (bucket, storage_key) do nothing`,
      [process.env.R2_PUBLIC_BUCKET, orphans, TRASH_DAYS]
    );
  }
  return { orphans: orphans.length };
}

const LEGACY_BATCH = 10;                 // כמה קבצים ישנים לארגון בהרצה

/**
 * העברת קבצים ישנים (bytea במסד) ל-R2, במנות קטנות. המפתח דטרמיניסטי
 * (media/<org>/legacy-<id>/<שם>) ולכן הרצה חוזרת אחרי כשל באמצע פשוט
 * דורסת את אותו אובייקט. אחרי ההעלאה — HEAD לאימות הגודל, ורק אז, בפקודה
 * אחת, storage_key נקבע ו-data מתאפס. כשל בקובץ אחד לא עוצר את השאר.
 */
export async function migrateLegacyAssets(orgId, store = mediaStore) {
  const batch = await rows(
    `select id, filename, mime from content_assets
      where data is not null and storage_key is null
      order by id limit $1`,
    [LEGACY_BATCH]
  );
  let moved = 0;
  let failed = 0;
  for (const a of batch) {
    const key = legacyMediaKey(orgId, a.id, a.filename);
    try {
      // קובץ אחד בזיכרון בכל רגע — לא את כל המנה
      const { data } = await one('select data from content_assets where id = $1', [a.id]);
      await store.put(key, data, legacyUploadMime(a.mime));
      const head = await store.head(key);
      if (!head || head.size !== data.length) {
        throw new Error(`אימות נכשל — ב-R2 ${head?.size ?? 'אין'} בייטים, במסד ${data.length}`);
      }
      await query(
        `update content_assets set storage_key = $2, data = null
          where id = $1 and storage_key is null`,
        [a.id, key]
      );
      // אם סריקת יתומים הספיקה לשים את המפתח בסל (ניסיון קודם שנכשל) — הוא בשימוש עכשיו
      await query('delete from media_trash where storage_key = $1', [key]);
      moved += 1;
    } catch (e) {
      failed += 1;
      console.error(`העברת קובץ #${a.id} ("${a.filename}") ל-R2 נכשלה (ננסה שוב):`, e.message);
    }
  }
  return { moved, failed };
}

/**
 * תחזוקת המדיה, שעתית, לכל ארגון: מחיקה סופית ממה שבסל, העברת קבצים ישנים
 * מהמסד ל-R2 (LEGACY_BATCH בכל הרצה), ופעם ביום סריקת יתומים. רץ רק כשאחסון המדיה מוגדר. כשל
 * בארגון אחד לא עוצר את האחרים (forEachOrg).
 */
export async function mediaMaintenance({ store = mediaStore, now = new Date() } = {}) {
  if (!mediaReady()) return;
  await forEachOrg(async (orgId) => {
    const trash = await purgeMediaTrash(store);
    if (trash.purged || trash.kept) {
      console.log(`מדיה (ארגון ${orgId}): ${trash.purged} נמחקו סופית מהסל` +
        (trash.kept ? `, ${trash.kept} חזרו לשימוש ויצאו מהסל` : ''));
    }

    const legacy = await migrateLegacyAssets(orgId, store);
    if (legacy.moved || legacy.failed) {
      const left = await one(
        'select count(*)::int as n from content_assets where data is not null and storage_key is null');
      console.log(`מדיה (ארגון ${orgId}): ${legacy.moved} קבצים ישנים הועברו מהמסד ל-R2` +
        (legacy.failed ? `, ${legacy.failed} נכשלו` : '') + ` · נשארו ${left.n}`);
    }

    if (now.getTime() - (lastSweep.get(orgId) ?? 0) >= SWEEP_EVERY_MS) {
      try {
        const { orphans } = await sweepMediaOrphans(orgId, store, now);
        lastSweep.set(orgId, now.getTime());
        if (orphans) console.log(`מדיה (ארגון ${orgId}): ${orphans} קבצים יתומים עברו לסל המחזור`);
      } catch (e) {
        console.error(`סריקת יתומים במדיה נכשלה לארגון ${orgId}:`, e.message);
      }
    }
  });
}
