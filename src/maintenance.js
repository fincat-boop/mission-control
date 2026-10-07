import { one, query, rows, withOrg } from './db.js';
import { buildDump } from './backup.js';
import { offsiteBackup } from './offsite-backup.js';
import { fullBackup } from './full-backup.js';
import { weekMeta, ymd } from './board.js';
import { closeResolvedTasks } from './task-lifecycle.js';
import { recordBackupLayer } from './backup-status.js';
import {
  TRASH_DAYS, legacyMediaKey, legacyUploadMime, mediaReady, mediaStore, mediaSweepEnabled,
  orgMediaPrefix, pickOrphans,
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
const SWAP_REOFFER_DAYS = 7;           // הצעה שנדחתה לא חוזרת לאותו פוסט+תוכן בתקופה הזו

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
  // כל שכבה רושמת את תוצאתה (backup_status) — כשל כבר לא נשאר רק בלוג
  let dump;
  try {
    dump = await buildDump();
  } catch (e) {
    // בלי dump אף שכבה לא יכולה לרוץ
    const why = `שליפת הנתונים לגיבוי נכשלה: ${e.message}`;
    for (const layer of ['db', 'drive', 'r2']) await recordBackupLayer(layer, 'failed', why);
    throw e;
  }
  const rowCount = Object.values(dump.tables).reduce((s, r) => s + r.length, 0);

  try {
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
    await recordBackupLayer('db', 'ok');
  } catch (e) {
    // הגיבוי הפנימי נכשל, אבל ה-dump קיים — השכבות החיצוניות עדיין רצות
    console.error('גיבוי פנימי נכשל:', e.message);
    await recordBackupLayer('db', 'failed', e.message);
  }

  // כשל כאן לא אמור למנוע את הגיבוי הפנימי שכבר הצליח ונשמר למעלה
  await offsiteBackup(dump)
    .then((r) => recordBackupLayer('drive', r === 'skipped' ? 'skipped' : 'ok'))
    .catch(async (e) => {
      console.error('גיבוי חיצוני ל-Drive נכשל:', e.message);
      await recordBackupLayer('drive', 'failed', e.message);
    });
  // גיבוי מלא (כולל בייטים) ל-R2 — אותה חוסן: כשל לא מפיל את מה שכבר נשמר
  await fullBackup(dump)
    .then((r) => recordBackupLayer('r2', r === 'skipped' ? 'skipped' : 'ok'))
    .catch(async (e) => {
      console.error('גיבוי מלא ל-R2 נכשל:', e.message);
      await recordBackupLayer('r2', 'failed', e.message);
    });
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
    `select p.id, p.channel_id, p.endpoint_id, p.scheduled_at, p.assignee_id, e.name as endpoint_name,
            -- היום המקומי של המועד, לא UTC — "היום" במשימות הוא ישראלי
            (p.scheduled_at at time zone 'Asia/Jerusalem')::date as due_on
       from posts p
       left join endpoints e on e.id = p.endpoint_id
      where p.status = 'scheduled' and p.content_id is null
        -- מבצע דחוף — כותרת בלבד בכוונה; אין מה "להחליף" בו
        and not p.urgent
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
          and (ci.slot_channel_id is null or exists (
                select 1 from campaign_channels cc
                 where cc.campaign_id = ci.campaign_id and cc.channel_id = ci.slot_channel_id))
          -- תוכן של קמפיין לא מוצע מחוץ לחלון התאריכים שלו
          and (ca.id is null or ((ca.starts_on is null or ca.starts_on <= $4::date)
                             and (ca.ends_on is null or ca.ends_on >= $4::date)))
          -- הצעה שכבר הוצעה לאותו פוסט (פתוחה, בוצעה או נדחתה) לא חוזרת:
          -- מי שסימן/מחק את ההצעה לא יקבל אותה שוב בעוד שעה
          and not exists (
            select 1 from tasks ts
             where ts.post_id = $5 and ts.kind = 'swap'
               and ts.meta->>'suggested_content_id' = ci.id::text
               and ts.created_at >= now() - make_interval(days => $6)
          )
          -- אותו כלל כמו reusable במנוע: חד-פעמי יוצא פעם אחת בכל ערוץ (אי פעם,
          -- לא רק השבוע); evergreen — רק לא פעמיים באותו שבוע באותו ערוץ
          and not exists (
            select 1 from posts p2
             where p2.content_id = ci.id and p2.channel_id = $1
               and p2.status in ('scheduled','approved','publishing','failed','published','pending_approval')
               and (not ci.evergreen or (p2.scheduled_at >= $2 and p2.scheduled_at <= $3))
          )
        order by e.importance desc, ci.created_at asc
        limit 1`,
      [post.channel_id, week.startDate, week.endDate, ymd(new Date(post.scheduled_at)),
       post.id, SWAP_REOFFER_DAYS]
    );
    if (!suggestion) continue; // אין כרגע שום תוכן מוכן להציע במקומו

    await query(
      `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on, meta, assignee_id)
       values ($1,$2,'swap',$3,$4,true,$5,$6,$7)`,
      [
        `הצעה: להחליף תוכן בפוסט שמתפרסם בקרוב`,
        `${post.endpoint_name ?? 'ללא נקודת קצה'} עדיין בלי תוכן · הצעה: "${suggestion.title}" ` +
        `(${suggestion.endpoint_name}) · מתפרסם ${new Date(post.scheduled_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}`,
        post.id, post.endpoint_id, post.due_on,
        JSON.stringify({
          suggested_content_id: suggestion.content_id,
          suggested_title: suggestion.title,
          suggested_kind: suggestion.kind,
          suggested_endpoint_id: suggestion.endpoint_id,
          ...(post.assignee_id ? { assignee_auto: true } : {}),
        }),
        post.assignee_id ?? null,
      ]
    );
    console.log(`הצעת החלפה נוצרה לפוסט #${post.id} (${post.endpoint_name ?? 'ללא נקודת קצה'}) — מוצע: "${suggestion.title}"`);
  }
  });
}

/**
 * משימות שנסגרות לבד (src/task-lifecycle.js) — שעתי, לכל ארגון. אותה
 * סגירה רצה גם בפתיחת טאב המשימות; כאן היא תופסת את מי שלא פתח אותו.
 */
export async function sweepTasks() {
  await forEachOrg(async (orgId) => {
    const { closed, assigned } = await closeResolvedTasks();
    if (closed || assigned) {
      console.log(`משימות (ארגון ${orgId}): ${closed} נסגרו לבד כי התנאי שלהן נפתר` +
        (assigned ? `, ${assigned} שויכו לאחראי של הפוסט` : ''));
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
 * (media/<org>/legacy-<hmac>/<שם>, ראו legacyMediaKey) ולכן הרצה חוזרת אחרי כשל באמצע פשוט
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
  // מחיקות (סל + יתומים) רק בפרודקשן — ראו mediaSweepEnabled. ההעברה מהמסד
  // רצה בכל סביבה: היא רק מוסיפה אובייקטים, ובמפתח שתלוי בסוד של הסביבה.
  const destructive = mediaSweepEnabled();
  await forEachOrg(async (orgId) => {
    const trash = destructive ? await purgeMediaTrash(store) : { purged: 0, kept: 0 };
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

    if (destructive && now.getTime() - (lastSweep.get(orgId) ?? 0) >= SWEEP_EVERY_MS) {
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
