import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, rows, one } from './db.js';
import { ymd } from './board.js';
import { contentGap, nearestDays } from './engine.js';

/**
 * מאתר ומתקן מצבים שבהם אותה נקודת קצה מקבלת שני פוסטים באותה מדיה באותו יום.
 *
 * הכלל נאכף במנוע ובמבצע הדחוף, אבל נתונים שנוצרו לפניו — או שיבוץ ידני —
 * יכולים עדיין להכיל התנגשויות. הסקריפט מזיז את המאוחר יותר ליום החוקי הבא
 * (עד שבועיים קדימה): לא יום חסום בערוץ, לא יום שכבר יש בו פוסט של הנקודה
 * בערוץ, ובמרווח של הקמפיין של הפוסט (contentGap) מהשכן הקרוב לשני הכיוונים.
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
 * campaign_id / campaign_min_gap_days לחישוב המרווח), channels — עם
 * blocked_days, settings — engine_settings.
 * @returns {{groups: {endpoint_name, channel_name, day, kinds:string[], stay:object[],
 *            moves:{post:object, to:Date}[], stuck:object[]}[], moves:{id:number, at:Date}[]}}
 */
export function planClashFixes(posts, { channels = [], settings = null, today = ymd(new Date()) } = {}) {
  const blocked = new Map(channels.map((c) => [c.id, (c.blocked_days ?? []).map(Number)]));
  const dayOf = (p) => ymd(new Date(p.scheduled_at));
  const live = posts.filter((p) => p.endpoint_id && ON_BOARD.includes(p.status));

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
      list.splice(list.indexOf(dayOf(p)), 1);   // הפוסט עצמו זז — הוא לא שכן של עצמו
      const gap = contentGap(p, settings);
      let to = null;
      for (let d = 1; d <= LOOKAHEAD_DAYS && !to; d += 1) {
        const at = new Date(p.scheduled_at);
        at.setDate(at.getDate() + d);
        const key = ymd(at);
        if ((blocked.get(p.channel_id) ?? []).includes(at.getDay())) continue;
        if (list.includes(key) || nearestDays(list, key) < gap) continue;
        to = at;
      }
      if (!to) {
        list.push(dayOf(p));
        g.stuck.push(p);
        continue;
      }
      list.push(ymd(to));
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
            e.name as endpoint_name, c.name as channel_name,
            ci.campaign_id, ca.min_gap_days as campaign_min_gap_days
       from posts p
       join endpoints e on e.id = p.endpoint_id
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
  await withOrg(orgId, () => cli(apply, orgId)).finally(() => pool.end());
}

async function cli(apply, orgId) {
  const { settings, channels, posts } = await loadClashData();
  const { groups, moves } = planClashFixes(posts, { channels, settings });
  if (groups.length === 0) return console.log(`ארגון ${orgId}: אין התנגשויות.`);

  console.log(`ארגון ${orgId}: נמצאו ${groups.length} התנגשויות:\n`);
  for (const g of groups) {
    console.log(`  ${g.endpoint_name} · ${g.channel_name} · ${g.day}  (${g.kinds.join(' + ')})`);
    for (const p of g.stay) console.log(`     נשאר: ${p.title} [${p.status}]`);
    for (const m of g.moves) console.log(`     זז:   ${m.post.title} → ${ymd(m.to)}`);
    for (const p of g.stuck) {
      console.log(`     ✗ ${p.title} — אין יום חוקי בשבועיים הקרובים (יום חסום / מרווח)`);
    }
  }

  if (!apply) return console.log(`\nהרצה יבשה. ${moves.length} פוסטים יזוזו. להרצה אמיתית: --yes`);
  for (const m of moves) {
    await query('update posts set scheduled_at = $1 where id = $2', [m.at, m.id]);
  }
  console.log(`\n${moves.length} פוסטים הוזזו.`);
}
