import 'dotenv/config';
import { buildDump } from './backup.js';
import { deleteFile, ensureFolder, listByCreated, uploadJson } from './drive.js';

/**
 * גיבוי חיצוני ל-Google Drive, בנוסף לגיבוי התקופתי בתוך ה-DB (ראו maintenance.js)
 * ולגיבוי המובנה של Railway ל-Postgres עצמו. בלי בייטים של קבצים מצורפים —
 * אותה סיבה כמו בגיבוי הפנימי, ראו schema.sql.
 *
 * שלוש רמות תחת אותה תיקיית שורש (GOOGLE_DRIVE_FOLDER_ID):
 *   daily   — כל הרצה, 7 אחרונים
 *   weekly  — בימי שני בלבד, 5 אחרונים
 *   monthly — ב-1 לחודש בלבד, נשמר לנצח (אף פעם לא נמחק)
 */
const TIERS = {
  daily:   { keep: 7,        take: () => true },
  weekly:  { keep: 5,        take: (d) => d.getDay() === 1 },
  monthly: { keep: Infinity, take: (d) => d.getDate() === 1 },
};

export async function offsiteBackup(dump) {
  const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!rootId) {
    console.log('GOOGLE_DRIVE_FOLDER_ID לא מוגדר — מדלג על גיבוי חיצוני');
    return;
  }

  const now = new Date(dump.created_at);
  const stamp = dump.created_at.replace(/[:.]/g, '-').slice(0, 19);
  const content = JSON.stringify(dump);

  for (const [tier, cfg] of Object.entries(TIERS)) {
    if (!cfg.take(now)) continue;

    const folderId = await ensureFolder(tier, rootId);
    await uploadJson(`${tier}-${stamp}.json`, folderId, content);
    console.log(`גיבוי חיצוני (${tier}) הועלה ל-Drive`);

    if (cfg.keep === Infinity) continue;
    const files = await listByCreated(folderId);
    const stale = files.slice(cfg.keep);
    for (const f of stale) await deleteFile(f.id);
    if (stale.length) console.log(`  ${stale.length} גיבויי ${tier} ישנים נמחקו מ-Drive`);
  }
}

/**
 *   npm run backup:offsite
 * הרצה ידנית לבדיקה — בונה dump טרי ומעלה לפי אותה לוגיקת רוטציה.
 */
async function runCli() {
  const dump = await buildDump();
  await offsiteBackup(dump);
}

if (process.argv[1]?.endsWith('offsite-backup.js')) {
  await runCli();
  process.exit(0);
}
