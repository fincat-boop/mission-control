import 'dotenv/config';
import { migrate, one, pool, rows, tx } from '../db.js';

/**
 * מיגרציה חד-פעמית: התדירות עוברת לערוץ, והתוכן מתפצל לזווית + גרסאות.
 *
 * לפני: פריט תוכן אחד עם ready_channel_ids — כלומר אותו טקסט בדיוק לכל המדיות.
 * אחרי: הפריט הוא הזווית, ולכל מדיה יש גרסה משלה עם ניסוח נפרד.
 *
 * הרצה חוזרת בטוחה.
 *
 *   node src/migrations/002-channel-cadence-and-variants.js
 */

await migrate();

/* ---------- הקצב הרצוי של כל מדיה ---------- */
// בלי מידע אחר, הקצב הרצוי מתחיל שווה לתקרה הקיימת
const filled = await one(
  `update channels set target_per_week = max_per_week
    where target_per_week is null
    returning 1`
);
console.log(filled ? 'target_per_week אותחל מ-max_per_week' : 'target_per_week כבר מוגדר');

/* ---------- זווית → גרסאות ---------- */
const items = await rows(
  `select ci.id, ci.body, ci.ready_channel_ids, ci.campaign_id, ci.title
     from content_items ci
    where not exists (select 1 from content_variants v where v.content_id = ci.id)`
);

// ready_channel_ids הוא מערך בלי מפתח זר, ולכן הוא יכול להחזיק ערוץ שנמחק.
// כאן זה מתגלה: בלי הסינון הזה יצירת הגרסאות נופלת על הפרת מפתח זר.
const liveChannels = new Set((await rows('select id from channels')).map((c) => c.id));

let variants = 0;
let noChannel = 0;
let dangling = 0;

await tx(async (client) => {
  for (const item of items) {
    const all = item.ready_channel_ids ?? [];
    const channels = all.filter((id) => liveChannels.has(id));
    dangling += all.length - channels.length;

    if (channels.length === 0) {
      noChannel += 1;
      continue;
    }
    for (const channelId of channels) {
      // הטקסט הקיים הופך לנקודת הפתיחה של כל גרסה. מכאן מנסחים לכל מדיה בנפרד.
      await client.query(
        `insert into content_variants (content_id, channel_id, body, status)
         values ($1,$2,$3,$4)
         on conflict (content_id, channel_id) do nothing`,
        [item.id, channelId, item.body ?? '', item.body ? 'ready' : 'draft']
      );
      variants += 1;
    }
  }

  /* ---------- על אילו מדיות כל קמפיין יושב ---------- */
  // נגזר ממה שהתוכן שלו כבר מכוון אליו
  await client.query(
    `insert into campaign_channels (campaign_id, channel_id)
     select distinct ci.campaign_id, ch.id
       from content_items ci
       join channels ch on ch.id = any(ci.ready_channel_ids)
      where ci.campaign_id is not null
     on conflict do nothing`
  );

  // קמפיין שלא הצלחנו לגזור לו מדיות מתחיל על כל המדיות הפעילות.
  // עדיף להתחיל מרשת מלאה ולצמצם, מאשר ממסך ריק בלי שום אות.
  await client.query(
    `insert into campaign_channels (campaign_id, channel_id)
     select c.id, ch.id from campaigns c cross join channels ch
      where ch.active = true
        and not exists (select 1 from campaign_channels x where x.campaign_id = c.id)
     on conflict do nothing`
  );

  // ניקוי ההפניות המתות מהמערך, כדי שלא ימשיכו להיגרר
  await client.query(
    `update content_items ci
        set ready_channel_ids = coalesce((
              select array_agg(x)
                from unnest(ci.ready_channel_ids) as x
                join channels c on c.id = x
            ), '{}')
      where exists (
              select 1 from unnest(ci.ready_channel_ids) as x
               where not exists (select 1 from channels c where c.id = x)
            )`
  );
});

console.log(`נוצרו ${variants} גרסאות מתוך ${items.length} פריטי תוכן`);
if (dangling) {
  console.log(`${dangling} הפניות לערוצים שנמחקו — נוקו`);
}
if (noChannel) console.log(`${noChannel} פריטים בלי ערוץ מסומן — יקבלו גרסאות כשיוגדרו להם מדיות`);

const cc = await rows(
  `select c.name, count(*)::int n from campaign_channels cc
     join campaigns c on c.id = cc.campaign_id group by c.name order by c.name`
);
console.log('מדיות לפי קמפיין:');
if (cc.length === 0) console.log('  אין עדיין — נקבע מתוך מסך האסטרטגיה');
cc.forEach((x) => console.log(`  ${x.name}: ${x.n}`));

const ch = await rows('select name, max_per_week, target_per_week from channels order by sort_order, id');
console.log('קצב לפי מדיה:');
ch.forEach((x) => console.log(`  ${x.name}: רצוי ${x.target_per_week} · תקרה ${x.max_per_week}`));

await pool.end();
