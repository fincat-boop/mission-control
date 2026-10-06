// נטען גם כאן ולא רק ב-server.js, כי הקובץ רץ גם כ-CLI עצמאי
import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, rows, one, query } from './db.js';
import { weekMeta, ymd } from './board.js';
import {
  addGroupDay, buildSlots, buildUsage, COMPLETE_SPREAD_COLUMNS, contentGap, LINK_LIVE_STATUSES,
  linkDayTaken, nearestDays, nextSlot, outsideCampaignWindow, withEngineLock,
} from './engine.js';
import { effectiveGap } from './capacity.js';

/**
 * מרווח מחדש שבוע שכבר משובץ.
 *
 * המנוע לא נוגע במה שכבר על הלוח — הוא רק ממלא שטח פנוי. לכן שבוע שנבנה
 * לפני תיקון הפיזור נשאר דחוס, ופוסט שיושב על יום שנחסם *אחרי* ששובץ נשאר
 * שם לנצח. שתי הבעיות נפתרות כאן: הזזה של פוסטים קיימים לימים שהמנוע החדש
 * היה בוחר להם, דרך אותו nextSlot בדיוק. שום פוסט לא נמחק ולא נוצר.
 *
 * שני מצבי עבודה:
 *   מלא (onlyIllegal=false)  — כל השבוע נפרש מחדש. ידני, דרך ה-CLI.
 *   ממוקד (onlyIllegal=true) — רק פוסטים שיושבים על יום חסום זזים, וכל השאר
 *                              קפוא במקומו. זה מה שרץ אוטומטית כשחוסמים יום,
 *                              כדי ששינוי הגדרה לא יזיז לוח שסודר ביד.
 *
 * מה לא זז לעולם: פוסט שפורסם, פוסט שממתין לאישור, ויום שכבר עבר.
 *
 * כללים שנאכפים על היעד: יום חסום בערוץ · אותה נקודת קצה לא מקבלת שני
 * פוסטים באותה מדיה באותו יום · max_promo_per_day · המרווח מול פוסטים
 * בשבועות הסמוכים ומול הקבועים באותו שבוע — המרווח של הקמפיין של הפוסט
 * שזז (contentGap), לשני הכיוונים · פוסט מקושר לא ליום שבו כבר יוצא פוסט
 * אחר מהקבוצה שלו, בכל ערוץ (links_apart של הקמפיין). פוסט שאין לו יום חוקי
 * נשאר במקום ומדווח.
 */

const ON_BOARD = ['scheduled', 'approved', 'publishing', 'failed', 'published', 'pending_approval'];
const MOVABLE = ['scheduled', 'approved', 'failed'];
// כמה קדימה סורקים פוסטים על ימים חסומים. הלוח מתוכנן חודשים מראש,
// ופוסט על יום חסום בעוד רבעון הוא בדיוק אותה תקלה.
const HORIZON_WEEKS = 26;

/** האם הפוסט יושב על יום שהערוץ שלו חסם */
export function onBlockedDay(post, channel) {
  return (channel?.blocked_days ?? []).includes(new Date(post.scheduled_at).getDay());
}

/**
 * מתכנן הזזות. לא כותב כלום.
 * @param {string|Date} [anchor] תאריך כלשהו בשבוע המבוקש
 * @param {{onlyIllegal?: boolean}} [opts]
 */
export async function planRespace(anchor, { onlyIllegal = false } = {}) {
  const week = weekMeta(anchor);
  const from = week.startDate;
  const to = new Date(week.endDate);
  to.setHours(23, 59, 59, 999);

  const settings = await one('select * from engine_settings limit 1');
  const channels = await rows('select * from channels where active = true order by sort_order, id');
  const posts = await rows(
    `select p.id, p.title, p.kind, p.status, p.scheduled_at,
            p.channel_id, p.endpoint_id, p.content_id,
            c.name as channel_name, e.name as endpoint_name,
            ci.campaign_id, ca.starts_on as campaign_starts_on, ca.ends_on as campaign_ends_on,
            ca.min_gap_days as campaign_min_gap_days,
            -- פוסטים מקושרים לא באותו יום (groupDays ב-respaceMoves)
            ci.linked_to_id, ca.links_apart as campaign_links_apart,
            -- קמפיין מוכן: פוסט לא זז לפני התאריך המתוכנן שלו (outsideCampaignWindow)
            ${COMPLETE_SPREAD_COLUMNS}
       from posts p
       join channels c       on c.id = p.channel_id
       left join endpoints e on e.id = p.endpoint_id
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.scheduled_at >= $1 and p.scheduled_at <= $2
        and p.status = any($3)
      order by p.scheduled_at, p.id`,
    [from, to, ON_BOARD]
  );

  // פוסטים של אותה נקודה+ערוץ מחוץ לשבוע — מולם נמדד המרווח. הטווח לפי
  // המרווח הגדול ביותר שאפשר (30 = התקרה של מרווח קמפיין, או הכללי)
  const neighbours = await neighbourDays(from, to, Math.max(30, effectiveGap(null, settings)));

  return respaceMoves({ week, channels, posts, settings, neighbours, onlyIllegal,
                        today: ymd(new Date()) });
}

/**
 * החלק הטהור של planRespace: מה זז ולאן, מתוך הלוח של השבוע (posts),
 * הערוצים, ההגדרות והימים התפוסים מחוץ לשבוע (neighbours — מפה
 * `${endpoint}:${channel}` → YYYY-MM-DD). לא כותב כלום.
 *
 * קבוע (anchored): פורסם / ממתין לאישור / בפרסום, ערוץ לא פעיל, ופוסט על
 * יום שכבר עבר. הפוסטים הקבועים בתוך השבוע נכנסים גם ל-neighbours ולא רק
 * ל-sameDay — אחרת פוסט שזז יכול לנחות בתוך המרווח של פוסט קבוע באותו שבוע
 * (קודם נבדקו מולו רק פוסטים מחוץ לשבוע).
 */
export function respaceMoves({ week, channels, posts, settings, neighbours = new Map(),
                               onlyIllegal = false, today = ymd(new Date()) }) {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const illegal = (p) => onBlockedDay(p, byId.get(p.channel_id));
  const dayOf = (p) => ymd(new Date(p.scheduled_at));

  const canMove = (p) => MOVABLE.includes(p.status) && byId.has(p.channel_id) &&
                         dayOf(p) >= today;
  const movable = posts.filter((p) => canMove(p) && (!onlyIllegal || illegal(p)));
  const anchored = posts.filter((p) => !movable.includes(p));

  const result = { week, moves: [], stuck: [], posts: posts.length };
  if (movable.length === 0) return result;

  const maxPromoPerDay = settings?.max_promo_per_day ?? 1;

  // מצב הלוח שנשאר קבוע — ממנו נמדד המרווח, ואליו נבדקות ההתנגשויות
  const usage = buildUsage(channels, anchored, settings);
  // הימים של כל קבוצת קישור — מהקבועים, ומכל פוסט שזז (בתוך השבוע בלבד:
  // הכלל הוא אותו יום, ויום מחוץ לשבוע הוא לא יום בתוכו)
  const groupDays = new Map();
  const groupRoot = (p) => p.linked_to_id ?? p.content_id;
  for (const p of anchored.filter((x) => x.content_id && LINK_LIVE_STATUSES.includes(x.status))) {
    addGroupDay(groupDays, groupRoot(p), p.content_id, dayOf(p));
  }
  const sameDay = new Set(
    anchored.filter((p) => p.endpoint_id)
      .map((p) => `${p.endpoint_id}:${p.channel_id}:${ymd(new Date(p.scheduled_at))}`)
  );
  const promoPerDay = new Map();
  for (const p of anchored.filter((x) => x.kind === 'promo')) {
    const d = ymd(new Date(p.scheduled_at));
    promoPerDay.set(d, (promoPerDay.get(d) ?? 0) + 1);
  }

  // המרווח נמדד מול השכנים מחוץ לשבוע וגם מול הקבועים שבתוכו
  const near = new Map([...neighbours].map(([k, v]) => [k, [...v]]));
  for (const p of anchored.filter((x) => x.endpoint_id)) {
    const key = `${p.endpoint_id}:${p.channel_id}`;
    near.set(key, [...(near.get(key) ?? []), dayOf(p)]);
  }

  // תור לכל ערוץ, לפי הסדר הנוכחי על הלוח: מי שהיה ראשון יישאר ראשון
  const queues = new Map();
  for (const p of movable) {
    if (!queues.has(p.channel_id)) queues.set(p.channel_id, []);
    queues.get(p.channel_id).push(p);
  }

  // buildSlots כבר מסנן ימים חסומים בערוץ; כאן מסננים גם ימים שעברו
  const pending = new Set(
    buildSlots(week, channels, null).filter((s) => s.dateKey >= today)
  );

  while (pending.size && [...queues.values()].some((q) => q.length)) {
    const slot = nextSlot(pending, usage, week);
    pending.delete(slot);

    const queue = queues.get(slot.channel_id);
    if (!queue?.length) continue;

    // הפוסט הראשון בתור שהיום הזה חוקי בשבילו
    const i = queue.findIndex((p) => fits(p, slot.dateKey));
    if (i === -1) continue;
    const post = queue.splice(i, 1)[0];

    let hour = new Date(post.scheduled_at).getHours();
    while (usage.hourTaken(slot.channel_id, slot.dateKey, hour) && hour < 22) hour += 1;

    usage.take(slot.channel_id, slot.dateKey, post.kind, hour);
    if (post.endpoint_id) {
      sameDay.add(`${post.endpoint_id}:${slot.channel_id}:${slot.dateKey}`);
      const key = `${post.endpoint_id}:${post.channel_id}`;
      near.set(key, [...(near.get(key) ?? []), slot.dateKey]);
    }
    if (post.kind === 'promo') {
      promoPerDay.set(slot.dateKey, (promoPerDay.get(slot.dateKey) ?? 0) + 1);
    }
    if (post.content_id) addGroupDay(groupDays, groupRoot(post), post.content_id, slot.dateKey);

    result.moves.push({
      post,
      dateKey: slot.dateKey,
      hour,
      to: new Date(`${slot.dateKey}T${String(hour).padStart(2, '0')}:00:00`),
      from: ymd(new Date(post.scheduled_at)),
      wasIllegal: illegal(post),
    });
  }

  // מי שלא מצא יום. ההבחנה חשובה: פוסט שנשאר על יום חסום הוא תקלה פתוחה,
  // ופוסט שפשוט לא היה טעם להזיז אותו הוא לא.
  result.stuck = [...queues.values()].flat().map((post) => ({
    post,
    illegal: illegal(post),
  }));

  return result;

  /** האם מותר להעביר את הפוסט ליום הזה */
  function fits(post, dateKey) {
    if (post.endpoint_id) {
      if (sameDay.has(`${post.endpoint_id}:${post.channel_id}:${dateKey}`)) return false;

      // המרווח של הקמפיין של הפוסט שזז; השכן הקרוב לפני או אחרי
      const others = near.get(`${post.endpoint_id}:${post.channel_id}`);
      if (nearestDays(others, dateKey) < contentGap(post, settings)) return false;
    }
    if (post.kind === 'promo' && (promoPerDay.get(dateKey) ?? 0) >= maxPromoPerDay) return false;
    if (post.content_id && post.campaign_links_apart !== false &&
        linkDayTaken(groupDays, groupRoot(post), post.content_id, dateKey)) return false;
    return windowAllows(post, dateKey);
  }
}

/**
 * האם מותר להזיז את הפוסט ליום הזה מבחינת הקמפיין שלו. לא מוציאים פוסט
 * מהחלון של הקמפיין — ובקמפיין מוכן גם לא לפני התאריך המתוכנן שלו (שניהם
 * ב-outsideCampaignWindow). פוסט שכבר יושב מחוץ לחלון (הקמפיין זז אחרי
 * השיבוץ) לא ננעל — מותר להזיז אותו כרגיל.
 */
export function windowAllows(post, dateKey) {
  return !(outsideCampaignWindow(post, dateKey) &&
           !outsideCampaignWindow(post, ymd(new Date(post.scheduled_at))));
}

/** כותב את ההזזות. מחזיר כמה פוסטים באמת זזו. */
export async function applyRespace(moves) {
  let changed = 0;
  for (const m of moves) {
    const was = new Date(m.post.scheduled_at);
    if (m.from === m.dateKey && was.getHours() === m.hour) continue;
    await query('update posts set scheduled_at = $1 where id = $2', [m.to, m.post.id]);
    changed += 1;
  }
  return changed;
}

/**
 * מפנה פוסטים שיושבים על ימים שנחסמו לערוץ שלהם. רץ אחרי כל שינוי הגדרות
 * ערוץ — חסימת יום היא הצהרה על הלוח כולו, לא רק על שיבוצים עתידיים.
 *
 * ממוקד בכוונה: רק הפוסטים הלא-חוקיים זזים, השאר לא מרגישים כלום.
 * פוסט שלא נמצא לו יום חוקי נשאר במקום ומדווח — וגם מקבל התראת crit
 * (postsOnBlockedDays נקראת מ-alerts.js), כדי שלא ייעלם בשקט.
 *
 * @param {{weeks?: number}} [opts] כמה שבועות קדימה לסרוק
 * @returns {Promise<{moved: number, stuck: object[]}>}
 */
export function relocateBlocked({ weeks = HORIZON_WEEKS } = {}) {
  // דרך אותה שרשרת של המנוע, כדי שפינוי והמילוי האוטומטי לא ירוצו זה על זה
  return withEngineLock(async () => {
    const stranded = await postsOnBlockedDays(weeks);
    if (stranded.length === 0) return { moved: 0, stuck: [] };

    const anchors = [...new Set(stranded.map((p) => weekMeta(p.scheduled_at).start))];

    let moved = 0;
    const stuck = [];
    for (const anchor of anchors) {
      const plan = await planRespace(anchor, { onlyIllegal: true });
      moved += await applyRespace(plan.moves);
      stuck.push(...plan.stuck.filter((s) => s.illegal).map((s) => s.post));
    }
    return { moved, stuck };
  });
}

/** פוסטים עתידיים שיושבים על יום חסום לערוץ שלהם */
export async function postsOnBlockedDays(weeks = HORIZON_WEEKS) {
  const until = new Date();
  until.setDate(until.getDate() + weeks * 7);

  const r = await rows(
    `select p.id, p.title, p.status, p.scheduled_at, p.channel_id,
            c.name as channel_name, c.blocked_days
       from posts p
       join channels c on c.id = p.channel_id
      where p.status in ('scheduled','pending_approval')
        and p.scheduled_at >= date_trunc('day', now())
        and p.scheduled_at <= $1
      order by p.scheduled_at`,
    [until]
  );
  return r.filter((p) => onBlockedDay(p, p));
}

/** ימים תפוסים לכל נקודה+ערוץ מחוץ לשבוע, עד horizon ימים לפני ואחרי */
async function neighbourDays(from, to, horizon) {
  const before = new Date(from); before.setDate(before.getDate() - horizon);
  const after = new Date(to);    after.setDate(after.getDate() + horizon);

  const r = await rows(
    `select endpoint_id, channel_id, scheduled_at
       from posts
      where endpoint_id is not null
        and status = any($1)
        and scheduled_at >= $2 and scheduled_at <= $3
        and (scheduled_at < $4 or scheduled_at > $5)`,
    [ON_BOARD, before, after, from, to]
  );

  const map = new Map();
  for (const p of r) {
    const key = `${p.endpoint_id}:${p.channel_id}`;
    map.set(key, [...(map.get(key) ?? []), ymd(new Date(p.scheduled_at))]);
  }
  return map;
}

/* ========================= CLI ========================= */

/**
 *   node src/respace.js                     הרצה יבשה על השבוע הנוכחי
 *   node src/respace.js 2026-08-16          הרצה יבשה על השבוע של התאריך
 *   node src/respace.js 2026-08-16 --yes    הזזה בפועל
 *   node src/respace.js --blocked           רק פוסטים על ימים חסומים, כל השבועות
 *   node src/respace.js --org 2             ארגון אחר (ברירת מחדל 1)
 */
const runAsCli = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (runAsCli) {
  const { withOrg } = await import('./db.js');

  const argv = process.argv.slice(2);
  const apply = argv.includes('--yes');
  const blockedOnly = argv.includes('--blocked');
  const orgIdx = argv.indexOf('--org');
  const orgId = orgIdx >= 0 ? Number(argv[orgIdx + 1]) : 1;
  const anchor = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? new Date();

  await withOrg(orgId, () => (blockedOnly ? cliBlocked(apply) : cliWeek(anchor, apply, orgId)))
    .finally(() => pool.end());
}

async function cliWeek(anchor, apply, orgId) {
  const plan = await planRespace(anchor);
  console.log(`שבוע ${plan.week.label} · ארגון ${orgId} · ${plan.posts} פוסטים על הלוח`);
  if (plan.posts === 0) return;

  report(plan);
  if (!apply) return console.log('\nהרצה יבשה. להזזה בפועל: הוסיפו --yes');

  console.log(`\nהוזזו ${await applyRespace(plan.moves)} פוסטים.`);
}

async function cliBlocked(apply) {
  const stranded = await postsOnBlockedDays();
  if (stranded.length === 0) return console.log('אין פוסטים על ימים חסומים.');

  console.log(`${stranded.length} פוסטים יושבים על ימים חסומים:`);
  for (const p of stranded) console.log(`  ${line(p)}`);

  if (!apply) return console.log('\nהרצה יבשה. לפינוי בפועל: הוסיפו --yes');

  const { moved, stuck } = await relocateBlocked();
  console.log(`\nפונו ${moved} פוסטים.`);
  if (stuck.length) {
    console.log(`⚠ ${stuck.length} לא נמצא להם יום חוקי — צריך טיפול ידני:`);
    for (const p of stuck) console.log(`  ${line(p)}`);
  }
}

function line(p) {
  return `${p.channel_name} · ${p.title} · ${ymd(new Date(p.scheduled_at))}`;
}

function report(plan) {
  const moves = plan.moves.filter((m) => m.from !== m.dateKey);
  if (moves.length === 0) console.log('\nהשבוע כבר מפוזר לפי המנוע — אין מה להזיז.');
  else {
    console.log(`\n${moves.length} פוסטים יזוזו:\n`);
    for (const m of moves) {
      const flag = m.wasIllegal ? '  (היה על יום חסום)' : '';
      console.log(`  ${m.post.channel_name} · ${m.post.title}`);
      console.log(`     ${m.from}  ⟵ במקום ⟶  ${m.dateKey} ` +
                  `${String(m.hour).padStart(2, '0')}:00${flag}`);
    }
  }

  const blocked = plan.stuck.filter((s) => s.illegal);
  const fine = plan.stuck.filter((s) => !s.illegal);

  if (blocked.length) {
    console.log(`\n⚠ ${blocked.length} פוסטים נשארים על יום חסום — אין להם יום חוקי בשבוע.`);
    console.log('   צריך להזיז אותם ידנית לשבוע אחר, או לפנות להם מקום:');
    for (const s of blocked) console.log(`     ${line(s.post)}`);
  }
  if (fine.length) {
    console.log(`\n${fine.length} פוסטים נשארים במקום (לא נמצא להם יום טוב יותר):`);
    for (const s of fine) console.log(`     ${line(s.post)}`);
  }
}
