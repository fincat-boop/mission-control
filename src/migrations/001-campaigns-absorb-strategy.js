import 'dotenv/config';
import { migrate, one, pool, rows, tx } from '../db.js';

/**
 * מיגרציה חד-פעמית: הקמפיין בולע את strategy_allocations.
 *
 * לפני: שתי טבלאות אמרו כמעט אותו דבר — "נקודה X מקבלת Y% מהשטח בטווח Z".
 * אחרי: קמפיין אחד נושא תאריכים, חשיבות, קצב ונתח.
 *
 * הרצה חוזרת בטוחה: אם הטבלה כבר לא קיימת, הסקריפט יוצא בשקט.
 *
 *   node src/migrations/001-campaigns-absorb-strategy.js
 */

await migrate();

const exists = await one(
  `select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'strategy_allocations'`
);
if (!exists) {
  console.log('strategy_allocations כבר לא קיימת — אין מה למגר.');
  await pool.end();
  process.exit(0);
}

// רבעון קודם לחצי-שנה ולשנה: התקופה הצרה היא הקמפיין האמיתי,
// והרחבות ממנה הן רק זום אחר על אותו דבר.
const SPECIFICITY = { quarter: 0, half: 1, year: 2 };
const allocations = (await rows('select * from strategy_allocations'))
  .sort((a, b) =>
    (SPECIFICITY[a.period_kind] ?? 9) - (SPECIFICITY[b.period_kind] ?? 9) ||
    a.starts_on.localeCompare(b.starts_on));

const campaigns = await rows('select * from campaigns');

console.log(`נמצאו ${allocations.length} הקצאות ו-${campaigns.length} קמפיינים.`);

let merged = 0;
let created = 0;
let skipped = 0;

/** האם שני טווחים חופפים. טווח בלי תאריכים נחשב "תמיד". */
const overlaps = (aStart, aEnd, bStart, bEnd) => {
  if (!bStart || !bEnd) return true;
  return aStart <= bEnd && aEnd >= bStart;
};

await tx(async (client) => {
  for (const a of allocations) {
    const sameEndpoint = campaigns.filter((c) => c.endpoint_id === a.endpoint_id);

    // טווח זהה בדיוק — ההקצאה רק משלימה את הנתח שחסר לקמפיין
    const exact = sameEndpoint.find(
      (c) => c.starts_on === a.starts_on && c.ends_on === a.ends_on
    );
    if (exact) {
      await client.query(
        'update campaigns set share_pct = coalesce(share_pct, $1) where id = $2',
        [a.target_pct, exact.id]
      );
      merged += 1;
      continue;
    }

    // טווח חופף — אותה תקופה בזום אחר. לא יוצרים קמפיין נוסף,
    // רק משלימים נתח לקמפיין הקיים אם אין לו.
    const overlapping = sameEndpoint.find(
      (c) => overlaps(a.starts_on, a.ends_on, c.starts_on, c.ends_on)
    );
    if (overlapping) {
      await client.query(
        'update campaigns set share_pct = coalesce(share_pct, $1) where id = $2',
        [a.target_pct, overlapping.id]
      );
      skipped += 1;
      continue;
    }

    const importance = await endpointImportance(client, a.endpoint_id);
    const inserted = await client.query(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, share_pct,
                              importance, cadence_days, active)
       values ($1,$2,$3,$4,$5,$6,7,true) returning *`,
      [a.endpoint_id, a.label || a.period_label || 'קמפיין', a.starts_on, a.ends_on,
       a.target_pct, importance]
    );
    campaigns.push(inserted.rows[0]); // כדי שהקצאה הבאה תראה גם אותו
    created += 1;
  }

  // חשיבות הקמפיין יורשת מנקודת הקצה, אלא אם נקבעה במפורש
  await client.query(
    `update campaigns c set importance = e.importance
       from endpoints e
      where e.id = c.endpoint_id and c.importance = 5`
  );

  await client.query('drop table strategy_allocations');
});

console.log(`מוזגו ${merged} · דולגו כחופפים ${skipped} · נוצרו ${created} חדשים`);
console.log('strategy_allocations נמחקה.');

const after = await rows(
  `select c.name, e.name as endpoint, c.starts_on, c.ends_on,
          c.share_pct, c.importance, c.cadence_days
     from campaigns c join endpoints e on e.id = c.endpoint_id
    order by c.starts_on nulls last, c.id`
);
console.log('\nקמפיינים אחרי המיגרציה:');
for (const c of after) {
  console.log(`  ${c.name} · ${c.endpoint} · ${c.starts_on ?? '—'}→${c.ends_on ?? '—'} · ` +
              `נתח ${c.share_pct ?? '—'}% · חשיבות ${c.importance} · כל ${c.cadence_days} ימים`);
}

async function endpointImportance(client, endpointId) {
  const r = await client.query('select importance from endpoints where id = $1', [endpointId]);
  return r.rows[0]?.importance ?? 5;
}

await pool.end();
