import 'dotenv/config';
import { pool, rows, one, query, withOrg } from './db.js';
import { weekMeta, ymd } from './board.js';
import { buildSlots, buildUsage, nextSlot } from './engine.js';

/**
 * מרווח מחדש שבוע שכבר משובץ.
 *
 * המנוע לא נוגע במה שכבר על הלוח — ולכן שבוע שנבנה לפני תיקון הפיזור נשאר
 * דחוס גם אחרי שהמנוע השתנה. הסקריפט הזה מזיז את הפוסטים הקיימים לימים
 * שהמנוע החדש היה בוחר להם, באותו סדר בחירה בדיוק (nextSlot): הכי רחוק
 * ממה שכבר תפוס באותו ערוץ, ואז היום הכי פחות עמוס בכל הערוצים.
 *
 * מה לא זז לעולם: פוסט שכבר פורסם, פוסט שממתין לאישור, יום שהערוץ חסם,
 * ויום שכבר עבר. שום פוסט לא נמחק ולא נוצר — רק scheduled_at משתנה.
 *
 * כללים שנאכפים על היעד: אותה נקודת קצה לא מקבלת שני פוסטים באותה מדיה
 * באותו יום · max_promo_per_day · min_gap_days מול פוסטים בשבועות סמוכים.
 * פוסט שאין לו יום חוקי נשאר בדיוק איפה שהוא, ומדווח.
 *
 *   node src/respace.js                    הרצה יבשה על השבוע הנוכחי
 *   node src/respace.js 2026-08-16         הרצה יבשה על השבוע של התאריך
 *   node src/respace.js 2026-08-16 --yes   הזזה בפועל
 *   node src/respace.js --org 2            ארגון אחר (ברירת מחדל 1)
 */

const argv = process.argv.slice(2);
const apply = argv.includes('--yes');
const orgIdx = argv.indexOf('--org');
const orgId = orgIdx >= 0 ? Number(argv[orgIdx + 1]) : 1;
const anchor = argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? new Date();

const MOVABLE = 'scheduled';
const ON_BOARD = ['scheduled', 'published', 'pending_approval'];

await withOrg(orgId, run).finally(() => pool.end());

async function run() {
  const week = weekMeta(anchor);
  const from = week.startDate;
  const to = new Date(week.endDate);
  to.setHours(23, 59, 59, 999);

  const [settings, channels, posts] = await Promise.all([
    one('select * from engine_settings limit 1'),
    rows('select * from channels where active = true order by sort_order, id'),
    rows(
      `select p.id, p.title, p.kind, p.status, p.scheduled_at,
              p.channel_id, p.endpoint_id,
              c.name as channel_name, e.name as endpoint_name
         from posts p
         join channels c   on c.id = p.channel_id
         left join endpoints e on e.id = p.endpoint_id
        where p.scheduled_at >= $1 and p.scheduled_at <= $2
          and p.status = any($3)
        order by p.scheduled_at, p.id`,
      [from, to, ON_BOARD]
    ),
  ]);

  console.log(`שבוע ${week.label} · ארגון ${orgId} · ${posts.length} פוסטים על הלוח`);
  if (posts.length === 0) return;

  const active = new Set(channels.map((c) => c.id));
  const movable = posts.filter((p) => p.status === MOVABLE && active.has(p.channel_id));
  const anchored = posts.filter((p) => !movable.includes(p));

  if (movable.length === 0) {
    console.log('אין פוסטים שאפשר להזיז (הכול פורסם / ממתין לאישור).');
    return;
  }

  const minGap = settings?.min_gap_days ?? 7;
  const maxPromoPerDay = settings?.max_promo_per_day ?? 1;
  const today = ymd(new Date());

  // מצב הלוח שנשאר קבוע — ממנו נמדד המרווח, ואליו נבדקות ההתנגשויות
  const usage = buildUsage(channels, anchored, settings);
  const sameDay = new Set(
    anchored.filter((p) => p.endpoint_id)
      .map((p) => `${p.endpoint_id}:${p.channel_id}:${ymd(new Date(p.scheduled_at))}`)
  );
  const promoPerDay = new Map();
  for (const p of anchored.filter((p) => p.kind === 'promo')) {
    const d = ymd(new Date(p.scheduled_at));
    promoPerDay.set(d, (promoPerDay.get(d) ?? 0) + 1);
  }

  // פוסטים של אותה נקודה+ערוץ מחוץ לשבוע — הם קובעים את min_gap_days
  const neighbours = await neighbourDays(from, to, minGap);

  // תור לכל ערוץ, לפי הסדר הנוכחי על הלוח: מי שהיה ראשון יישאר ראשון
  const queues = new Map();
  for (const p of movable) {
    if (!queues.has(p.channel_id)) queues.set(p.channel_id, []);
    queues.get(p.channel_id).push(p);
  }

  const pending = new Set(
    buildSlots(week, channels, null).filter((s) => s.dateKey >= today)
  );
  const moves = [];

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

    const at = new Date(`${slot.dateKey}T${String(hour).padStart(2, '0')}:00:00`);
    usage.take(slot.channel_id, slot.dateKey, post.kind, hour);
    if (post.endpoint_id) sameDay.add(`${post.endpoint_id}:${slot.channel_id}:${slot.dateKey}`);
    if (post.kind === 'promo') {
      promoPerDay.set(slot.dateKey, (promoPerDay.get(slot.dateKey) ?? 0) + 1);
    }
    if (post.endpoint_id) {
      const key = `${post.endpoint_id}:${post.channel_id}`;
      neighbours.set(key, [...(neighbours.get(key) ?? []), slot.dateKey]);
    }

    moves.push({ post, to: at, dateKey: slot.dateKey });
  }

  const stuck = [...queues.values()].flat();
  report(moves, stuck);

  if (!apply) {
    console.log('\nהרצה יבשה. להזזה בפועל: הוסיפו --yes');
    return;
  }

  let changed = 0;
  for (const m of moves) {
    if (ymd(m.to) === ymd(new Date(m.post.scheduled_at))
        && m.to.getHours() === new Date(m.post.scheduled_at).getHours()) continue;
    await query('update posts set scheduled_at = $1 where id = $2', [m.to, m.post.id]);
    changed += 1;
  }
  console.log(`\nהוזזו ${changed} פוסטים.`);

  /** האם מותר להעביר את הפוסט ליום הזה */
  function fits(post, dateKey) {
    if (post.endpoint_id) {
      if (sameDay.has(`${post.endpoint_id}:${post.channel_id}:${dateKey}`)) return false;

      const others = neighbours.get(`${post.endpoint_id}:${post.channel_id}`) ?? [];
      const tooClose = others.some(
        (d) => Math.abs((new Date(dateKey) - new Date(d)) / 86400000) < minGap
      );
      if (tooClose) return false;
    }
    if (post.kind === 'promo' && (promoPerDay.get(dateKey) ?? 0) >= maxPromoPerDay) return false;
    return true;
  }
}

/** ימים תפוסים לכל נקודה+ערוץ מחוץ לשבוע, בטווח שרלוונטי ל-min_gap_days */
async function neighbourDays(from, to, minGap) {
  const before = new Date(from); before.setDate(before.getDate() - minGap);
  const after = new Date(to);    after.setDate(after.getDate() + minGap);

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

function report(moves, stuck) {
  const actual = moves.filter(
    (m) => m.dateKey !== ymd(new Date(m.post.scheduled_at))
  );

  if (actual.length === 0) console.log('\nהשבוע כבר מפוזר לפי המנוע — אין מה להזיז.');
  else {
    console.log(`\n${actual.length} פוסטים יזוזו:\n`);
    for (const m of actual) {
      const wasDay = ymd(new Date(m.post.scheduled_at));
      const hour = String(m.to.getHours()).padStart(2, '0');
      console.log(`  ${m.post.channel_name} · ${m.post.title}`);
      console.log(`     ${wasDay}  ⟵ במקום ⟶  ${m.dateKey} ${hour}:00`);
    }
  }

  if (stuck.length) {
    console.log(`\n${stuck.length} פוסטים נשארים במקום (אין להם יום חוקי בשבוע):`);
    for (const p of stuck) {
      console.log(`  ${p.channel_name} · ${p.title} · ${ymd(new Date(p.scheduled_at))}`);
    }
  }
}
