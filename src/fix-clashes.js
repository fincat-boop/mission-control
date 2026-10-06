import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, rows, one } from './db.js';
import { ymd } from './board.js';
import {
  addGroupDay, COMPLETE_SPREAD_COLUMNS, contentGap, LINK_LIVE_STATUSES, linkDayTaken, nearestDays,
  removeGroupDay,
} from './engine.js';
import { windowAllows } from './respace.js';

/**
 * מאתר ומתקן מצבים שבהם אותה נקודת קצה מקבלת שני פוסטים באותה מדיה באותו יום.
 *
 * הכלל נאכף במנוע ובמבצע הדחוף, אבל נתונים שנוצרו לפניו — או שיבוץ ידני —
 * יכולים עדיין להכיל התנגשויות. הסקריפט מזיז את המאוחר יותר ליום החוקי הבא
 * (עד שבועיים קדימה): לא יום חסום בערוץ, לא יום שכבר יש בו פוסט של הנקודה
 * בערוץ, במרווח של הקמפיין של הפוסט (contentGap) מהשכן הקרוב לשני הכיוונים,
 * בתוך חלון הקמפיין ולא לפני התאריך המתוכנן בקמפיין מוכן (windowAllows, כמו
 * ב-respace), לא מעבר ל-max_promo_per_day, ולא ליום שבו כבר יוצא פוסט מקושר
 * מאותה קבוצה (links_apart של הקמפיין, בכל ערוץ). השעה נשמרת; תפוסה בערוץ —
 * השעה הפנויה הבאה עד 22:00, ובלעדיה היום לא מתאים.
 *
 * רק התנגשויות מהיום והלאה. זז רק מתוכנן / מאושר — מה שפורסם, בפרסום, נכשל
 * או ממתין לאישור נשאר במקום (כמו ב-respace) ונספר כתפוס. הכול בארגון אחד.
 *
 *   node src/fix-clashes.js                הרצה יבשה, ארגון 1
 *   node src/fix-clashes.js --org 2        ארגון אחר
 *   node src/fix-clashes.js --yes          תיקון בפועל
 */

const ON_BOARD = ['scheduled', 'approved', 'publishing', 'failed', 'published', 'pending_approval'];
const MOVABLE = ['scheduled', 'approved'];
const LOOKAHEAD_DAYS = 14;

/**
 * מתכנן את התיקון (טהורה). posts — הפוסטים החיים של הארגון סביב היום (עם
 * campaign_id / campaign_min_gap_days למרווח, עמודות החלון וקמפיין מוכן
 * ל-windowAllows, ו-content_id / linked_to_id / campaign_links_apart לפוסטים
 * מקושרים), channels — עם blocked_days, settings — engine_settings.
 * @returns {{groups: {endpoint_name, channel_name, day, kinds:string[], stay:object[],
 *            moves:{post:object, to:Date}[], stuck:object[]}[], moves:{id:number, at:Date}[]}}
 */
export function planClashFixes(posts, { channels = [], settings = null, today = ymd(new Date()) } = {}) {
  const blocked = new Map(channels.map((c) => [c.id, (c.blocked_days ?? []).map(Number)]));
  const dayOf = (p) => ymd(new Date(p.scheduled_at));
  const onBoard = posts.filter((p) => ON_BOARD.includes(p.status));
  const live = onBoard.filter((p) => p.endpoint_id);
  const maxPromoPerDay = settings?.max_promo_per_day ?? 1;
  const hourOf = (p) => new Date(p.scheduled_at).getHours();

  // שעות תפוסות לכל ערוץ×יום, ומכירתיים לכל יום (בכל הערוצים) — כמו במנוע
  const hours = new Set(onBoard.map((p) => `${p.channel_id}:${dayOf(p)}:${hourOf(p)}`));
  const promo = new Map();
  const addPromo = (day, n) => promo.set(day, (promo.get(day) ?? 0) + n);
  for (const p of onBoard.filter((x) => x.kind === 'promo')) addPromo(dayOf(p), 1);

  // הימים של כל קבוצת קישור (מקור + עוקבות) — פוסט מקושר לא ליום של אחר
  const groupDays = new Map();
  const groupRoot = (p) => p.linked_to_id ?? p.content_id;
  const linked = (p) => p.content_id && LINK_LIVE_STATUSES.includes(p.status);
  for (const p of posts.filter(linked)) addGroupDay(groupDays, groupRoot(p), p.content_id, dayOf(p));
  const linkClash = (p, key) => linked(p) && p.campaign_links_apart !== false &&
    linkDayTaken(groupDays, groupRoot(p), p.content_id, key);

  // כל הימים התפוסים לכל נקודה+ערוץ — מולם נבדקים אותו יום והמרווח
  const pairs = new Map();
  const byDay = new Map();
  for (const p of live) {
    const pair = `${p.endpoint_id}:${p.channel_id}`;
    pairs.set(pair, [...(pairs.get(pair) ?? []), dayOf(p)]);
    const key = `${pair}:${dayOf(p)}`;
    byDay.set(key, [...(byDay.get(key) ?? []), p]);
  }

  const groups = [];
  const moves = [];
  for (const group of byDay.values()) {
    if (group.length < 2 || dayOf(group[0]) < today) continue;
    // מה שלא זז נשאר. מבין השאר, המוקדם ביותר נשאר (אם אין קבוע) והשאר זזים.
    const anchored = group.filter((p) => !MOVABLE.includes(p.status));
    const movable = group.filter((p) => MOVABLE.includes(p.status));
    const stay = anchored.length ? anchored : movable.slice(0, 1);
    const go = anchored.length ? movable : movable.slice(1);
    const g = { endpoint_name: group[0].endpoint_name, channel_name: group[0].channel_name,
                day: dayOf(group[0]), kinds: [...new Set(group.map((p) => p.kind))],
                stay, moves: [], stuck: [] };

    for (const p of go) {
      const list = pairs.get(`${p.endpoint_id}:${p.channel_id}`);
      // הפוסט עצמו זז — הוא לא שכן של עצמו, לא תופס את השעה שלו ולא נספר ביום שלו
      list.splice(list.indexOf(dayOf(p)), 1);
      hours.delete(`${p.channel_id}:${dayOf(p)}:${hourOf(p)}`);
      if (p.kind === 'promo') addPromo(dayOf(p), -1);
      if (linked(p)) removeGroupDay(groupDays, groupRoot(p), p.content_id, dayOf(p));
      const gap = contentGap(p, settings);
      let to = null;
      for (let d = 1; d <= LOOKAHEAD_DAYS && !to; d += 1) {
        const at = new Date(p.scheduled_at);
        at.setDate(at.getDate() + d);
        const key = ymd(at);
        if ((blocked.get(p.channel_id) ?? []).includes(at.getDay())) continue;
        if (list.includes(key) || nearestDays(list, key) < gap) continue;
        if (!windowAllows(p, key)) continue;
        if (p.kind === 'promo' && (promo.get(key) ?? 0) >= maxPromoPerDay) continue;
        if (linkClash(p, key)) continue;
        let hour = at.getHours();
        while (hours.has(`${p.channel_id}:${key}:${hour}`) && hour < 22) hour += 1;
        if (hours.has(`${p.channel_id}:${key}:${hour}`)) continue;
        at.setHours(hour);
        to = at;
      }
      if (!to) {
        list.push(dayOf(p));
        hours.add(`${p.channel_id}:${dayOf(p)}:${hourOf(p)}`);
        if (p.kind === 'promo') addPromo(dayOf(p), 1);
        if (linked(p)) addGroupDay(groupDays, groupRoot(p), p.content_id, dayOf(p));
        g.stuck.push(p);
        continue;
      }
      list.push(ymd(to));
      hours.add(`${p.channel_id}:${ymd(to)}:${to.getHours()}`);
      if (p.kind === 'promo') addPromo(ymd(to), 1);
      if (linked(p)) addGroupDay(groupDays, groupRoot(p), p.content_id, ymd(to));
      g.moves.push({ post: p, to });
      moves.push({ id: p.id, at: to });
    }
    groups.push(g);
  }
  return { groups, moves };
}

/** הפוסטים, הערוצים וההגדרות של הארגון הפעיל (withOrg) */
async function loadClashData() {
  const settings = await one('select * from engine_settings limit 1');
  const channels = await rows('select id, blocked_days from channels');
  // חודש אחורה — שכנים למרווח של התנגשות של היום
  const posts = await rows(
    `select p.id, p.endpoint_id, p.channel_id, p.scheduled_at, p.status, p.kind, p.title,
            p.content_id, ci.linked_to_id, ca.links_apart as campaign_links_apart,
            e.name as endpoint_name, c.name as channel_name,
            ci.campaign_id, ca.min_gap_days as campaign_min_gap_days,
            ca.starts_on as campaign_starts_on, ca.ends_on as campaign_ends_on,
            ${COMPLETE_SPREAD_COLUMNS}
       from posts p
       left join endpoints e on e.id = p.endpoint_id
       join channels c  on c.id = p.channel_id
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.status = any($1) and p.scheduled_at >= now() - interval '31 days'
      order by p.scheduled_at, p.id`,
    [ON_BOARD]
  );
  return { settings, channels, posts };
}

const runAsCli = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (runAsCli) {
  const { withOrg } = await import('./db.js');
  const argv = process.argv.slice(2);
  const apply = argv.includes('--yes');
  const orgIdx = argv.indexOf('--org');
  const orgId = orgIdx >= 0 ? Number(argv[orgIdx + 1]) : 1;
  await withOrg(orgId, () => runFixClashes({ apply, orgId })).finally(() => pool.end());
}

/**
 * מאתר ומתקן בארגון הפעיל (בתוך withOrg). apply=false — רק מדפיס.
 * @returns {Promise<{groups:object[], moves:object[]}>}
 */
export async function runFixClashes({ apply = false, orgId = null, log = console.log } = {}) {
  const { settings, channels, posts } = await loadClashData();
  const plan = planClashFixes(posts, { channels, settings });
  const { groups, moves } = plan;
  if (groups.length === 0) { log(`ארגון ${orgId}: אין התנגשויות.`); return plan; }

  log(`ארגון ${orgId}: נמצאו ${groups.length} התנגשויות:\n`);
  for (const g of groups) {
    log(`  ${g.endpoint_name} · ${g.channel_name} · ${g.day}  (${g.kinds.join(' + ')})`);
    for (const p of g.stay) log(`     נשאר: ${p.title} [${p.status}]`);
    for (const m of g.moves) log(`     זז:   ${m.post.title} → ${ymd(m.to)} ${m.to.getHours()}:00`);
    for (const p of g.stuck) {
      log(`     ✗ ${p.title} — אין יום חוקי בשבועיים הקרובים (יום חסום / מרווח / קמפיין / פוסט מקושר / שעה)`);
    }
  }

  if (!apply) {
    log(`\nהרצה יבשה. ${moves.length} פוסטים יזוזו. להרצה אמיתית: --yes`);
    return plan;
  }
  for (const m of moves) {
    await query('update posts set scheduled_at = $1 where id = $2', [m.at, m.id]);
  }
  log(`\n${moves.length} פוסטים הוזזו.`);
  return plan;
}
