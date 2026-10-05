import 'dotenv/config';
import { one } from './db.js';
import { buildDump } from './backup.js';
import { deleteObject, getObject, headObject, listObjects, putObject, r2Ready } from './r2.js';

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
 *
 * גיבוי "שלם" = prefix שיש בו dump.json. הקובץ נכתב אחרון, ולכן גיבוי שנקטע
 * באמצע (קבצים בלי dump.json) לא נספר ברוטציה, לא מוצג ב-listBackups,
 * ונמחק בהרצה הבאה כזבל.
 */
const TIERS = {
  daily:   { keep: 7,        take: () => true },
  weekly:  { keep: 5,        take: (d) => d.getDay() === 1 },
  monthly: { keep: Infinity, take: (d) => d.getDate() === 1 },
};

const stampOf = (dump) => dump.created_at.replace(/[:.]/g, '-').slice(0, 19);

/**
 * מעלה את הבייטים ואז dump.json תחת prefix מסוים. קובץ עם storage_key
 * יושב ב-bucket המדיה (לא משוכפל לגיבוי) — רק השורה שלו נשמרת. הבייטים
 * קודם, כדי שקובץ שהועבר ל-R2 בין בניית ה-dump לקריאה יירשם ב-dump.json
 * עם ה-storage_key שלו ולא כ"חסר בייטים".
 */
async function uploadFull(prefix, dump) {
  let bytes = 0;
  for (const a of dump.tables.content_assets ?? []) {
    if (a.storage_key) continue;
    // בייט לכל קובץ בנפרד — לא טוענים את כל הקבצים לזיכרון בבת אחת
    const row = await one('select data, storage_key from content_assets where id = $1', [a.id]);
    if (row?.storage_key) { a.storage_key = row.storage_key; continue; }
    if (!row?.data) continue;
    await putObject(`${prefix}assets/${a.id}`, row.data);
    bytes += row.data.length;
  }

  const meta = { ...dump, assets_dir: 'assets' };
  await putObject(`${prefix}dump.json`, JSON.stringify(meta), 'application/json');
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
  const assetCount = (dump.tables.content_assets ?? []).filter((a) => !a.storage_key).length;

  for (const [tier, cfg] of Object.entries(TIERS)) {
    if (!cfg.take(now)) continue;

    const prefix = `${tier}/${stamp}/`;
    const bytes = await uploadFull(prefix, dump);
    console.log(`גיבוי מלא (${tier}) הועלה ל-R2 — ${assetCount} קבצים, ` +
      `${(bytes / 1024 / 1024).toFixed(1)}MB`);

    const { prefixes } = await listObjects(`${tier}/`, '/');
    const complete = await completeSet(prefixes);
    const stale = prunePlan(prefixes, complete, cfg.keep, prefix);
    for (const p of stale) await deletePrefix(p);
    if (stale.length) console.log(`  ${stale.length} גיבויי ${tier} ישנים/חלקיים נמחקו מ-R2`);
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
    if (a.storage_key) continue;   // ב-bucket המדיה, לא בגיבוי
    assets.set(a.id, await getObject(`${p}assets/${a.id}`));
  }
  return { dump, assets };
}

/** ה-prefixes מתוך הרשימה שיש בהם dump.json (גיבוי שהושלם) */
async function completeSet(prefixes) {
  const out = new Set();
  for (const p of prefixes) {
    if (await headObject(`${p}dump.json`)) out.add(p);
  }
  return out;
}

/**
 * מה למחוק ברוטציה — טהורה. stamp ISO ⇒ מיון לקסיקוגרפי = כרונולוגי.
 * שלמים: שומרים את keep החדשים. חלקיים (בלי dump.json): נמחקים אם הם
 * ישנים מהגיבוי שנכתב עכשיו (current) — הרצה שנקטעה; חדש יותר לא נוגעים
 * (אולי הרצה מקבילה באמצע).
 */
export function prunePlan(prefixes, complete, keep, current) {
  const done = prefixes.filter((p) => complete.has(p)).sort().reverse();
  const stale = keep === Infinity ? [] : done.slice(keep);
  const broken = prefixes.filter((p) => !complete.has(p) && p < current);
  return [...stale, ...broken];
}

/** רשימת הגיבויים השלמים לכל רמה (prefixes ממוינים מהחדש לישן) */
export async function listBackups() {
  const out = {};
  for (const tier of Object.keys(TIERS)) {
    const { prefixes } = await listObjects(`${tier}/`, '/');
    const complete = await completeSet(prefixes);
    out[tier] = prefixes.filter((p) => complete.has(p)).sort().reverse();
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
