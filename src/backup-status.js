import { query, rows } from './db.js';
import { r2Ready } from './r2.js';

/**
 * מצב שכבות הגיבוי — מה קרה בניסיון האחרון של כל אחת. עד עכשיו כשל של
 * הגיבוי היומי הגיע רק ללוג של השרת, ואף אחד לא ראה אותו. כאן הוא נשמר
 * (טבלת backup_status, גלובלית כמו backups), מוצג בניהול → גיבויים,
 * ומזין התראה למי שיש לו הרשאת הגדרות (backupAlerts).
 */

export const BACKUP_LAYERS = [
  { layer: 'db', label: 'גיבוי בתוך המסד', failTitle: 'הגיבוי בתוך המסד נכשל',
    configured: () => true },
  { layer: 'drive', label: 'גיבוי ל-Google Drive', failTitle: 'הגיבוי ל-Google Drive נכשל',
    configured: () => !!process.env.GOOGLE_DRIVE_FOLDER_ID },
  { layer: 'r2', label: 'גיבוי מלא ל-Cloudflare R2', failTitle: 'הגיבוי המלא ל-R2 נכשל',
    configured: () => r2Ready() },
];

const STALE_HOURS = 36; // הגיבוי רץ פעם ביממה — יותר מזה בלי הצלחה = משהו תקוע

/** רושם את תוצאת הניסיון של שכבה. לא זורק — רישום שנכשל לא מפיל גיבוי. */
export async function recordBackupLayer(layer, result, error = null) {
  await query(
    `insert into backup_status (layer, last_attempt_at, last_result, last_error, last_success_at)
     values ($1, now(), $2::text, $3, case when $2::text = 'ok' then now() end)
     on conflict (layer) do update set
       last_attempt_at = now(),
       last_result     = excluded.last_result,
       last_error      = excluded.last_error,
       last_success_at = coalesce(excluded.last_success_at, backup_status.last_success_at)`,
    [layer, result, error ? String(error).slice(0, 300) : null]
  ).catch((e) => console.error(`רישום מצב הגיבוי (${layer}) נכשל:`, e.message));
}

/** כל שלוש השכבות, כולל מי שעוד לא רץ אף פעם (בלי שורה) */
export async function readBackupLayers() {
  const saved = await rows(
    'select layer, last_attempt_at, last_result, last_error, last_success_at from backup_status');
  return BACKUP_LAYERS.map(({ layer, label, failTitle, configured }) => ({
    layer, label, failTitle, configured: configured(),
    ...(saved.find((s) => s.layer === layer) ?? {
      last_attempt_at: null, last_result: null, last_error: null, last_success_at: null,
    }),
  }));
}

const when = (d) =>
  new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Jerusalem' });

/**
 * התראות גיבוי (טהורה). רק למי שיש הרשאת הגדרות (perm: 'settings').
 *   - R2 מוגדר ואין גיבוי מלא מוצלח ב-36 שעות → חוסם. שכבה שעוד לא
 *     נוסתה אף פעם (אין שורה — למשל דקות אחרי עלייה ראשונה) לא מתריעה.
 *   - הניסיון האחרון של שכבה נכשל → דורש טיפול (אלא אם כבר יש עליה
 *     התראת 36 השעות, שכוללת את הסיבה).
 */
export function backupAlerts(layers, now = new Date()) {
  const out = [];
  const staleMs = STALE_HOURS * 3600000;
  for (const l of layers) {
    if (!l.configured || !l.last_attempt_at) continue;
    const stale = l.layer === 'r2' &&
      (!l.last_success_at || now - new Date(l.last_success_at) > staleMs);
    if (stale) {
      out.push({
        id: 'backup-stale-r2',
        level: 'crit',
        perm: 'settings',
        title: `אין גיבוי מלא מוצלח ב-${STALE_HOURS} השעות האחרונות`,
        detail: [
          l.last_success_at ? `הגיבוי המלא האחרון שהצליח: ${when(l.last_success_at)}`
                            : 'הגיבוי המלא עוד לא הצליח אף פעם',
          l.last_result === 'failed' && l.last_error ? `הסיבה בניסיון האחרון: ${l.last_error}` : null,
          'הגיבוי רץ לבד פעם ביממה. אם זה לא מסתדר עד מחר — מעבירים למפתח',
        ].filter(Boolean).join(' · '),
        tab: 'manage',
      });
    } else if (l.last_result === 'failed') {
      out.push({
        id: `backup-failed-${l.layer}`,
        level: 'warn',
        perm: 'settings',
        title: l.failTitle ?? `${l.label} נכשל`,
        detail: [`הניסיון האחרון: ${when(l.last_attempt_at)}`, l.last_error,
          'ננסה שוב לבד מחר. אם זה חוזר — מעבירים למפתח'].filter(Boolean).join(' · '),
        tab: 'manage',
      });
    }
  }
  return out;
}
