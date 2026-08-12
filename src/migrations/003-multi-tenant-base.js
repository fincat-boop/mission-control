import 'dotenv/config';
import { migrate, one, pool, query, rows } from '../db.js';

/**
 * שלב 1 של מולטי-טננט: בסיס + backfill.
 *
 * הסכימה (schema.sql) כבר מוסיפה טבלת orgs ועמודת org_id (nullable) לכל
 * טבלת-דומיין. המיגרציה הזו:
 *   1. יוצרת ארגון ברירת-מחדל (אם אין), שכל הנתונים הקיימים שייכים לו.
 *   2. ממלאת org_id לכל השורות הקיימות.
 *
 * אדיטיבי בלבד — org_id נשאר nullable, האפליקציה עם ה-queries הגלובליים
 * ממשיכה לעבוד. המעבר ל-NOT NULL + RLS + סינון per-org בא בשלבים הבאים.
 * ראו docs/multi-tenant-plan.md.
 *
 * הרצה חוזרת בטוחה.
 *
 *   node src/migrations/003-multi-tenant-base.js
 */

await migrate();

// כל הטבלאות שקיבלו org_id (שורש + בנות + engine_settings + activity_log)
const TENANT_TABLES = [
  'users', 'endpoints', 'channels', 'campaigns', 'campaign_channels',
  'content_items', 'content_variants', 'content_assets', 'posts',
  'post_results', 'strategy_milestones', 'tasks', 'engine_settings',
  'activity_log',
];

/* ---------- ארגון ברירת-מחדל ---------- */
// אם כבר יש ארגון (הרצה חוזרת) — הישן ביותר הוא ברירת המחדל. אחרת יוצרים.
let org = await one('select id from orgs order by id asc limit 1');
if (!org) {
  org = await one("insert into orgs (name) values ('ארגון ראשי') returning id");
  console.log(`נוצר ארגון ברירת-מחדל id=${org.id}`);
} else {
  console.log(`ארגון ברירת-מחדל קיים id=${org.id}`);
}

/* ---------- backfill ---------- */
let total = 0;
for (const t of TENANT_TABLES) {
  const updated = await rows(
    `update ${t} set org_id = $1 where org_id is null returning 1`, [org.id]
  );
  if (updated.length) {
    console.log(`  ${t}: ${updated.length} שורות שויכו לארגון`);
    total += updated.length;
  }
}

console.log(total ? `\nסה"כ ${total} שורות שויכו לארגון ${org.id}` : '\nהכול כבר משויך — אין מה לעדכן');

// שפיות: כמה שורות עדיין בלי org_id (אמור להיות 0)
for (const t of TENANT_TABLES) {
  const { n } = await one(`select count(*)::int n from ${t} where org_id is null`);
  if (n) console.log(`  אזהרה: ${t} עדיין עם ${n} שורות בלי org_id`);
}

await pool.end();
