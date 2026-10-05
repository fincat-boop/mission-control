import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { one, pool, rows } from './db.js';
import { TABLES } from './tables.js';

/**
 * גיבוי מלא — לוגיקת השליפה משותפת לסקריפט ה-CLI (קובץ) ולגיבוי
 * האוטומטי התקופתי (שורה בטבלת backups, ראו src/maintenance.js).
 *
 * לא משתמש ב-pg_dump בכוונה — הוא דורש לקוח Postgres מותקן, ובמכונה הזו אין.
 * הפורמט פשוט: טבלה -> מערך שורות, בסדר שמכבד מפתחות זרים בשחזור.
 */

/** שולף את כל הטבלאות (בלי בייטים של קבצים מצורפים — ראו למטה) */
export async function buildDump() {
  const dump = { created_at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    // הבייטים של הקבצים נשמרים בנפרד, אחרת ה-JSON מתנפח פי כמה. קובץ עם
    // storage_key יושב ב-bucket המדיה ב-R2 ואין לו בייטים כאן בכלל.
    // (variant_id ו-org_id חסרו כאן עד אוקטובר 2026 — שחזור איבד אותם.)
    const cols = t === 'content_assets'
      ? 'id, content_id, variant_id, org_id, filename, mime, size_bytes, storage_key, created_at'
      : '*';
    // order by 1 ולא by id: יש טבלאות עם מפתח מורכב ובלי עמודת id
    dump.tables[t] = await rows(`select ${cols} from ${t} order by 1`);
  }
  return dump;
}

/**
 *   npm run backup
 */
async function runCli() {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = process.env.BACKUP_DIR || join(here, '..', 'backups');

  const dump = await buildDump();

  await mkdir(outDir, { recursive: true });
  const stamp = dump.created_at.replace(/[:.]/g, '-').slice(0, 19);
  const file = join(outDir, `backup-${stamp}.json`);

  // קובץ לכל asset, בשם שנגזר מהמזהה כדי שהשחזור ימצא אותו
  let assetBytes = 0;
  let assetFiles = 0;
  if (dump.tables.content_assets.length) {
    const assetDir = join(outDir, `assets-${stamp}`);
    await mkdir(assetDir, { recursive: true });
    for (const a of dump.tables.content_assets) {
      if (a.storage_key) continue;               // ב-R2 — אין בייטים לגבות כאן
      const row = await one('select data, storage_key from content_assets where id = $1', [a.id]);
      if (row?.storage_key) { a.storage_key = row.storage_key; continue; } // הועבר ל-R2 בינתיים
      if (!row?.data) continue;                  // נמחק בינתיים
      await writeFile(join(assetDir, String(a.id)), row.data);
      assetBytes += row.data.length;
      assetFiles += 1;
    }
    dump.assets_dir = `assets-${stamp}`;
  }

  await writeFile(file, JSON.stringify(dump, null, 2), 'utf8');

  const total = Object.values(dump.tables).reduce((s, r) => s + r.length, 0);
  console.log(`גובו ${total} שורות מ-${TABLES.length} טבלאות`);
  for (const [t, r] of Object.entries(dump.tables)) {
    if (r.length) console.log(`  ${t}: ${r.length}`);
  }
  console.log(`\nנשמר: ${file}`);
  if (assetFiles) {
    console.log(`קבצים מצורפים מהמסד: ${assetFiles} · ` +
                `${(assetBytes / 1024 / 1024).toFixed(1)}MB בתיקייה ${dump.assets_dir}`);
  }
  const inR2 = dump.tables.content_assets.filter((a) => a.storage_key).length;
  if (inR2) console.log(`קבצים ב-bucket המדיה (רק השורה בגיבוי): ${inR2}`);
  console.log('הקובץ מכיל hash-ים של סיסמאות. לא לשתף.');

  await pool.end();
}

// רץ רק כשמריצים את הקובץ ישירות (npm run backup), לא כשמייבאים ממנו buildDump
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
