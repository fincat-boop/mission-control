import 'dotenv/config';
import { pool, query, rows } from './db.js';
import { ymd } from './board.js';

/**
 * מאתר ומתקן מצבים שבהם אותה נקודת קצה מקבלת שני פוסטים באותה מדיה באותו יום.
 *
 * הכלל נאכף במנוע ובמבצע הדחוף, אבל נתונים שנוצרו לפניו — או שיבוץ ידני —
 * יכולים עדיין להכיל התנגשויות. הסקריפט מזיז את המאוחר יותר ליום הפנוי הבא.
 * פוסט שכבר פורסם לא זז לעולם.
 *
 *   node src/fix-clashes.js          הרצה יבשה
 *   node src/fix-clashes.js --yes    תיקון בפועל
 */
const apply = process.argv.includes('--yes');

const posts = await rows(
  `select p.id, p.endpoint_id, p.channel_id, p.scheduled_at, p.status, p.kind, p.title,
          e.name as endpoint_name, c.name as channel_name
     from posts p
     join endpoints e on e.id = p.endpoint_id
     join channels c  on c.id = p.channel_id
    order by p.scheduled_at, p.id`
);

// מפתח: נקודה + מדיה + יום
const byKey = new Map();
for (const p of posts) {
  const key = `${p.endpoint_id}:${p.channel_id}:${ymd(new Date(p.scheduled_at))}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(p);
}

const occupied = new Set(byKey.keys());
const clashes = [...byKey.values()].filter((g) => g.length > 1);

if (clashes.length === 0) {
  console.log('אין התנגשויות.');
  await pool.end();
  process.exit(0);
}

console.log(`נמצאו ${clashes.length} התנגשויות:\n`);
const moves = [];

for (const group of clashes) {
  // מה שפורסם נשאר. מבין השאר, המוקדם ביותר נשאר והשאר זזים.
  const anchored = group.filter((p) => p.status === 'published');
  const movable = group.filter((p) => p.status !== 'published');
  const keep = anchored.length ? movable : movable.slice(1);
  const stay = anchored.length ? [] : movable.slice(0, 1);

  const day = ymd(new Date(group[0].scheduled_at));
  const kinds = [...new Set(group.map((p) => p.kind))];
  console.log(`  ${group[0].endpoint_name} · ${group[0].channel_name} · ${day}` +
              `  (${kinds.join(' + ')})`);
  for (const p of [...anchored, ...stay]) {
    console.log(`     נשאר: ${p.title} [${p.status}]`);
  }

  for (const p of keep) {
    // היום הפנוי הבא לאותה נקודה באותה מדיה
    let moved = null;
    for (let d = 1; d <= 14; d += 1) {
      const at = new Date(p.scheduled_at);
      at.setDate(at.getDate() + d);
      const key = `${p.endpoint_id}:${p.channel_id}:${ymd(at)}`;
      if (!occupied.has(key)) { occupied.add(key); moved = at; break; }
    }
    if (!moved) {
      console.log(`     ✗ ${p.title} — לא נמצא יום פנוי בשבועיים הקרובים`);
      continue;
    }
    console.log(`     זז:   ${p.title} → ${ymd(moved)}`);
    moves.push({ id: p.id, at: moved });
  }
}

if (!apply) {
  console.log(`\nהרצה יבשה. ${moves.length} פוסטים יזוזו. להרצה אמיתית: --yes`);
  await pool.end();
  process.exit(0);
}

for (const m of moves) {
  await query('update posts set scheduled_at = $1 where id = $2', [m.at, m.id]);
}
console.log(`\n${moves.length} פוסטים הוזזו.`);
await pool.end();
