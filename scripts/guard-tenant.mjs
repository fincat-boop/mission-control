import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * שומר את הבידוד הטננטי: קובצי נתיבים ומודולי דומיין שרצים בהקשר בקשה
 * חייבים לגשת ל-DB דרך one/rows/query/tx (שמנותבים ל-client הממודר),
 * ולא ישירות ל-pool — שגישה אליו עוקפת RLS (החיבור הוא superuser).
 *
 * הרשימה הלבנה: קבצים שבמכוון רצים גלובלית (bootstrap, גיבוי, מיגרציות,
 * עבודות רקע שכבר עוטפות ב-withOrg בעצמן).
 *
 *   node scripts/guard-tenant.mjs   →   נכשל (exit 1) אם נמצאה גישה אסורה
 */
const SRC = new URL('../src/', import.meta.url).pathname;

// מותר להם pool ישירות
const ALLOW = new Set([
  'db.js', 'server.js', 'backup.js', 'restore.js', 'restore-r2.js',
  'full-backup.js', 'offsite-backup.js', 'seed.js', 'demo.js',
  'set-password.js', 'fix-clashes.js', 'migrate.js', 'maintenance.js',
]);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'migrations') continue; // מיגרציות רצות גלובלית במכוון
      out.push(...walk(p));
    } else if (e.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

const violations = [];
for (const file of walk(SRC)) {
  const base = file.slice(SRC.length);
  if (ALLOW.has(base)) continue;
  const src = readFileSync(file, 'utf8');
  // ייבוא pool מ-db, או שימוש ב-pool.connect/pool.query
  if (/\bimport\b[^;]*\bpool\b[^;]*from\s+['"][^'"]*db\.js['"]/.test(src) ||
      /\bpool\.(connect|query)\b/.test(src)) {
    violations.push(base);
  }
}

if (violations.length) {
  console.error('guard:tenant נכשל — גישה ישירה ל-pool (עוקף RLS) בקבצים:');
  for (const v of violations) console.error(`  ${v}`);
  console.error('\nיש לגשת דרך one/rows/query/tx, או להוסיף לרשימה הלבנה אם הקובץ רץ גלובלית במכוון.');
  process.exit(1);
}
console.log('guard:tenant עבר — אין גישה ישירה ל-pool בקובצי נתיבים/דומיין.');
