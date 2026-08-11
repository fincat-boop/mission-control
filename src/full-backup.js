import 'dotenv/config';
import { one } from './db.js';
import { buildDump } from './backup.js';
import { deleteObject, getObject, listObjects, putObject, r2Ready } from './r2.js';

/**
 * גיבוי *מלא* ל-Cloudflare R2 — כולל הבייטים של הקבצים המצורפים, מה שלא
 * קיים בגיבוי הפנימי ולא בגיבוי ל-Drive. זו השכבה שמאפשרת שחזור מלא של
 * המערכת (טבלאות + קבצים) ממקום אחד, מחוץ ל-Railway.
 *
 * פריסה ב-bucket, שלוש רמות רוטציה:
 *   <tier>/<stamp>/dump.json      הטבלאות (בלי בייטים)
 *   <tier>/<stamp>/assets/<id>    בייט לכל קובץ מצורף
 *
 *   daily   — כל הרצה, 7 אחרונים
 *   weekly  — בימי שני בלבד, 5 אחרונים
 *   monthly — ב-1 לחודש בלבד, נשמר לנצח (אף פעם לא נמחק)
 *
 * הרוטציה מוחקת prefix שלם (dump + כל הקבצים תחתיו).
 */
const TIERS = {
  daily:   { keep: 7,        take: () => true },
  weekly:  { keep: 5,        take: (d) => d.getDay() === 1 },
  monthly: { keep: Infinity, take: (d) => d.getDate() === 1 },
};

const stampOf = (dump) => dump.created_at.replace(/[:.]/g, '-').slice(0, 19);

/** מעלה dump.json + כל הבייטים תחת prefix מסוים */
async function uploadFull(prefix, dump) {
  const meta = { ...dump, assets_dir: 'assets' };
  await putObject(`${prefix}dump.json`, JSON.stringify(meta), 'application/json');

  let bytes = 0;
  for (const a of dump.tables.content_assets ?? []) {
    // בייט לכל קובץ בנפרד — לא טוענים את כל הקבצים לזיכרון בבת אחת
    const row = await one('select data from content_assets where id = $1', [a.id]);
    if (!row?.data) continue;
    await putObject(`${prefix}assets/${a.id}`, row.data);
    bytes += row.data.length;
  }
  return bytes;
}

/** מוחק את כל האובייקטים תחת prefix */
async function deletePrefix(prefix) {
  const { keys } = await listObjects(prefix);
  for (const k of keys) await deleteObject(k);
}

export async function fullBackup(dump) {
  if (!r2Ready()) {
    console.log('R2 לא מוגדר — מדלג על גיבוי מלא');
    return;
  }

  const now = new Date(dump.created_at);
  const stamp = stampOf(dump);
  const assetCount = dump.tables.content_assets?.length ?? 0;

  for (const [tier, cfg] of Object.entries(TIERS)) {
    if (!cfg.take(now)) continue;

    const prefix = `${tier}/${stamp}/`;
    const bytes = await uploadFull(prefix, dump);
    console.log(`גיבוי מלא (${tier}) הועלה ל-R2 — ${assetCount} קבצים, ` +
      `${(bytes / 1024 / 1024).toFixed(1)}MB`);

    if (cfg.keep === Infinity) continue;
    const { prefixes } = await listObjects(`${tier}/`, '/');
    const stale = prefixes.sort().reverse().slice(cfg.keep); // stamp ISO — מיון לקסיקוגרפי = כרונולוגי
    for (const p of stale) await deletePrefix(p);
    if (stale.length) console.log(`  ${stale.length} גיבויי ${tier} ישנים נמחקו מ-R2`);
  }
}

/**
 * הורדת גיבוי מ-R2 לזיכרון, בפורמט שה-restore יודע לצרוך:
 * מחזיר { dump, assets: Map<id, Buffer> }.
 */
export async function downloadFull(prefix) {
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const dump = JSON.parse((await getObject(`${p}dump.json`)).toString('utf8'));
  const assets = new Map();
  for (const a of dump.tables.content_assets ?? []) {
    assets.set(a.id, await getObject(`${p}assets/${a.id}`));
  }
  return { dump, assets };
}

/** רשימת הגיבויים הזמינים לכל רמה (prefixes ממוינים מהחדש לישן) */
export async function listBackups() {
  const out = {};
  for (const tier of Object.keys(TIERS)) {
    const { prefixes } = await listObjects(`${tier}/`, '/');
    out[tier] = prefixes.sort().reverse();
  }
  return out;
}

/**
 *   npm run backup:full
 * הרצה ידנית לבדיקה — בונה dump טרי (כולל שליפת בייטים) ומעלה לפי הרוטציה.
 */
async function runCli() {
  const dump = await buildDump();
  await fullBackup(dump);
  process.exit(0);
}

if (process.argv[1]?.endsWith('full-backup.js')) {
  await runCli();
}
