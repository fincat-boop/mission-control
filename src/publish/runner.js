import { currentOrg, one, query, rows, withOrg } from '../db.js';
import { isPlatformOrg } from '../platform.js';
import { decryptSecret } from './crypto.js';
import { postFirstComment, publishFacebook, publishInstagram } from './meta.js';
import { deletePublicAssets, publicAssetsReady, uploadPublicAsset } from './public-assets.js';
import { mediaUrl } from '../media.js';
import { HubMailError, createNewsletter, hubCampaignUrl, hubMailReady, newsletterStatus } from '../hub-mail.js';
import { emitHubEventSafe, postEventInput } from '../hub-events.js';
import { friendlyPublishError } from './errors.js';
import { itemAssetsSql } from '../links.js';
import {
  DIGEST_UNVERIFIED, HUB_MISSING_ERROR, NOT_APPROVED_ERROR, NOT_TRANSFERRED_ERROR, alreadyTransferred,
  cleanFieldValues, hubWaitState, newsletterBlocker, newsletterClockStart, newsletterDigest,
  nextHubRef, reusableHubStatus, transferBlocker,
} from './newsletter.js';
import { contentBlocker, coverAsset, isStory, postMedia } from './readiness.js';
import { LOCAL_TZ, localYmd } from '../task-lifecycle.js';
import { endpointLiveSql } from '../live.js';
import { CHANGED_AFTER_APPROVAL, approvalDigest, recordReapproveTask } from './approval.js';

/**
 * מסלול הפרסום האוטומטי.
 *
 * publishTick רץ כל דקה (server.js), לכל ארגון בנפרד:
 *   פוסט בסטטוס approved שהגיע זמנו → publishing → קריאת API → published.
 *   כשל → failed + משימה דחופה. שום דבר לא נעלם בשקט — הכול נרשם
 *   ב-publish_log וביומן הפעולות. כל שלב בטרנזקציה קצרה משלו, ואף אחת
 *   לא פתוחה בזמן הקריאה לפלטפורמה (publishOne).
 *
 * וואטסאפ (קבוצה) וכל ערוץ שלא מתפרסם לבד — חצי-אוטומטי: בבוקר של היום
 * נוצרת משימת "לפרסם היום" עם הטקסט המוכן (manualPublishPrep), והמשתמש
 * מפרסם ומסמן "פורסם" בעצמו.
 *
 * ניוזלטר — לא נשלח מכאן ולא נוצר מכאן ב-HUB. המשתמש לוחץ "העבר ל-HUB"
 * (transferNewsletter), בעל העסק מאשר שם, והטיק רק שואל על הסטטוס. הגיע
 * המועד ולא הועבר — משימה (newsletterNotTransferred), לא שליחה.
 */

/**
 * מתג-העל כבוי = אין פרסום אוטומטי בכלל (החלטת המשתמש 8.10.26: "כרגע ועד
 * הודעה חדשה אין דבר כזה שליחה אוטומטית"). לא רק הטיק של פייסבוק ואינסטגרם
 * עוצר: אישור לפרסום, "אשר את השבוע", "פרסם עכשיו" ו"העבר ל-HUB" נדחים
 * (409), ניוזלטר שהגיע מועדו לא מוכשל אלא מקבל משימת "לפרסם היום" כמו כל
 * ערוץ ידני, והממשק מסתיר את כל אלה (state.autopublish).
 */
export const AUTOPUBLISH_OFF_ERROR =
  'הפרסום האוטומטי כבוי — מפרסמים ידנית ומסמנים פורסם (ניהול ← ערוצי פרסום)';

/** האם מתג-העל של הארגון הפעיל דלוק */
export async function autopublishOn() {
  const s = await one('select autopublish_enabled from engine_settings limit 1');
  return !!s?.autopublish_enabled;
}

/**
 * נכשל שאולי כבר יצא — לא חוזר למתוכנן במעבר לפרסום ידני (resetToManual,
 * manual_only_v1, הזזה של נכשל כשהמתג כבוי), כי מי שיפרסם אותו שוב ביד
 * עלול לפרסם פעמיים. נשאר "נכשל" עם ההסבר שלו, וממנו מסמנים "פורסם".
 * הזיהוי לפי ההודעה שנשמרה ב-publish_error (מדויק: כל מסלול כשל כותב הודעה
 * קבועה), ולא לפי publishing_started_at — הוא נכתב גם כשהפלטפורמה דחתה את
 * הפוסט בוודאות (טוקן פג וכו'), ואז הפוסט בטוח לא יצא:
 *   - ניוזלטר שהועבר ל-HUB (external_id / hub_transferred_at): ה-HUB עוד
 *     נשאל עליו (pollNewsletterOutcomes), ושליחה ידנית הייתה כפולה;
 *   - הודעות קבועות של "אולי עלה": STUCK_SOCIAL_ERROR, STUCK_NEWSLETTER_ERROR,
 *     STUCK_NEWSLETTER_CAP_ERROR, PUBLISHED_UNSAVED_ERROR;
 *   - הודעות של friendlyPublishError (errors.js) שאומרות שאולי עלה: מטא לא
 *     ענתה בזמן אחרי השליחה ("וייתכן שהוא עלה"), תקלת רשת, וסיבה שלא זיהינו;
 *   - שחרור ידני של פרסום תקוע (resetPublishing — "הפרסום סומן כתקוע ידנית").
 * כל השאר — לא הועבר, מאוחר מדי, שגיאת API ידועה — בוודאות לא יצא, וחוזר.
 * אותו תנאי, מילה במילה, בצעד manual_only_v1 ב-schema.sql (הבדיקה
 * ב-manual-only-db מריצה את שניהם מול הקבועים האלה).
 */
export const MAYBE_OUT_PATTERNS = [
  'הפרסום סומן כתקוע ידנית%', '%וייתכן שהוא עלה%', '%(תקלת רשת)%', 'הפרסום נכשל מסיבה שלא זיהינו%',
];
const sqlLit = (v) => `'${String(v).replace(/'/g, "''")}'`;
export const maybeOutErrors = () => [STUCK_SOCIAL_ERROR, STUCK_NEWSLETTER_ERROR,
  STUCK_NEWSLETTER_CAP_ERROR, PUBLISHED_UNSAVED_ERROR];
/** תנאי SQL: הפוסט בכינוי p אולי כבר יצא (רלוונטי לנכשל) */
export const maybeOutSql = (p = 'p') => `(${p}.external_id is not null
    or ${p}.hub_transferred_at is not null
    or coalesce(${p}.publish_error, '') in (${maybeOutErrors().map(sqlLit).join(', ')})
    or coalesce(${p}.publish_error, '') like any (array[${MAYBE_OUT_PATTERNS.map(sqlLit).join(', ')}]))`;

/**
 * מעבר לפרסום ידני בלבד (כיבוי המתג — PATCH /settings, וצעד manual_only_v1
 * ב-schema.sql עושה אותו דבר פעם אחת): מאושר לפרסום אוטומטי, ונכשל שבוודאות
 * לא יצא (maybeOutSql), חוזרים למתוכנן — בלי אישור ובלי הודעת הכשל — ומשימות
 * הכשל הפתוחות שלהם נסגרות. נכשל שהמועד שלו עבר מופיע אז כ"עבר המועד"
 * וברשימת "לא סומנו כפורסמו". נכשל שאולי יצא נשאר נכשל, עם המשימה שלו.
 * publishing — לא נוגעים: הוא כבר יצא לדרך (failStuckPublishing / ה-HUB סוגרים).
 * @returns {Promise<{approved:number, failed:number}>}
 */
export async function resetToManual() {
  const moved = await rows(
    `with t as (select id, status from posts p
                 where status = 'approved' or (status = 'failed' and not ${maybeOutSql('p')})
                 for update)
     update posts p set status = 'scheduled', approved_by = null, approved_at = null,
                        publish_error = null
       from t where p.id = t.id
     returning p.id, t.status as was`);
  if (moved.length) {
    await query(
      `update tasks set done = true, done_at = now()
        where kind = 'failed' and done = false and post_id = any($1::int[])`,
      [moved.map((x) => x.id)]);
  }
  return {
    approved: moved.filter((x) => x.was === 'approved').length,
    failed: moved.filter((x) => x.was === 'failed').length,
  };
}

const MAX_LATE_HOURS = 12;   // approved שפוספס ביותר מזה — נכשל, לא מתפרסם באיחור

// השלמה אחרי השבתה (שרת שנפל, טיק ארוך): פוסט שהמועד שלו עבר ביותר מ-
// OVERDUE_MINUTES לא יוצא אם פוסט אחר באותו ערוץ פורסם או נתפס בתוך
// CATCHUP_SPACING_MINUTES — מחכה לטיק מאוחר יותר, ולכל היותר מאחר אחד לערוץ
// בכל טיק. בלי זה כל מה שהצטבר יצא באותה דקה (3 פוסטים של 10/13/16 ב-18:00).
// פוסט בזמן — לא מושפע. כלל ה-12 שעות נמדד מהמועד, כמו קודם: ערוץ משלים
// עד ~24 פוסטים (12 שעות / 30 דקות) פחות משך ההשבתה — מה שלא הספיק נכשל
// עם TOO_LATE_ERROR.
export const OVERDUE_MINUTES = 5;
export const CATCHUP_SPACING_MINUTES = 30;

export const STUCK_SOCIAL_MINUTES = 30;   // פייסבוק/אינסטגרם ב-publishing יותר מזה — נקטע
export const STUCK_NEWSLETTER_HOURS = 24; // ניוזלטר שה-HUB לא ענה עליו / לא קיבל תוך יממה
export const STUCK_NEWSLETTER_CAP_HOURS = 72; // ניוזלטר שה-HUB עוד "שולח" אחרי 3 ימים

export const TOO_LATE_ERROR =
  'המועד עבר מזמן — הפרסום לא בוצע כדי לא להפתיע. משבצים מחדש או מפרסמים ידנית.';
// גם פוסט שעלה ושמירת התוצאה שלו נכשלה (publishOne) נגמר כאן — ולכן
// "ייתכן שכבר עלה" ובדיקה בעמוד לפני כל פרסום חוזר
export const STUCK_SOCIAL_ERROR =
  'הפרסום נקטע באמצע וייתכן שהפוסט כבר עלה — בודקים בעמוד לפני שמפרסמים שוב: ' +
  'אם הוא שם מסמנים "פורסם", ורק אם לא — מפרסמים שוב';
export const STUCK_NEWSLETTER_ERROR =
  'ה-HUB לא ענה על הניוזלטר יממה אחרי המועד — בודקים ב-HUB מה קרה לקמפיין, ואז מסמנים פורסם או מעבירים שוב';
export const STUCK_NEWSLETTER_CAP_ERROR =
  'ה-HUB עדיין לא סיים לשלוח 3 ימים אחרי המועד — בודקים ב-HUB מה קרה לקמפיין, ואז מסמנים פורסם או מעבירים שוב';

const isImage = (m) => /^image\//.test(m);
const isVideo = (m) => /^video\//.test(m);

const decryptToken = (post) => {
  try { return decryptSecret(post.access_token_enc); } catch { return null; }
};

/**
 * אירוע יוצא ל-HUB על גורל פוסט. fire-and-forget: כשל = לוג, הפרסום עצמו
 * לא תלוי בזה. ה-id והמייל — ראו postEventInput ב-hub-events.js.
 */
export const emitPostEvent = (type, post, extra = {}, opts = {}) =>
  emitHubEventSafe(postEventInput(type, post, { ...opts, extra }));

/**
 * כתיבה "על הדרך" בתוך טרנזקציה (שלב בטיק, בקשה). catch רגיל לא מספיק:
 * שגיאת SQL מבטלת את כל הטרנזקציה, ואז גם הכתיבות שאחריה נכשלות וה-commit
 * מתגלגל אחורה (db.js זורק על זה). savepoint תוחם את הכישלון לכתיבה הזו בלבד.
 */
export async function bestEffort(label, fn) {
  await query('savepoint best_effort');
  try {
    const out = await fn();
    await query('release savepoint best_effort');
    return out;
  } catch (e) {
    await query('rollback to savepoint best_effort');
    console.error(label, e.message);
    return undefined;
  }
}

/** שורת publish_log — עם השגיאה הגולמית (למפתח). מחזיר את מזהה השורה. */
async function logPublish(post, ok, { externalId = null, error = null } = {}) {
  const row = await bestEffort('כתיבה ל-publish_log נכשלה:', () => one(
    `insert into publish_log (post_id, channel_id, platform, ok, external_id, error)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [post.id, post.channel_id, post.platform, ok, externalId, error]
  ));
  return row?.id ?? null;
}

/**
 * משימת כשל לפוסט: אחת פתוחה לכל היותר. כשל חוזר מעדכן את הכותרת ואת
 * השגיאה במשימה הקיימת (אינדקס ייחודי חלקי ב-schema.sql), לא מוסיף עוד.
 */
async function recordFailedTask(post, title, error, who = 'owner') {
  await bestEffort('יצירת משימת כשל נכשלה:', () => query(
    `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on, meta)
     values ($1,$2,'failed',$3,$4,true,(now() at time zone 'Asia/Jerusalem')::date,$5)
     on conflict (post_id) where kind = 'failed' and done = false
     do update set title = excluded.title, subtitle = excluded.subtitle,
                   urgent = true, due_on = excluded.due_on,
                   meta = coalesce(tasks.meta, '{}'::jsonb) || excluded.meta`,
    [title, `"${post.title}": ${error}`, post.id, post.endpoint_id, JSON.stringify({ who })]
  ));
}

async function logActivity(action, post, summary) {
  await bestEffort('כתיבה ליומן הפעולות (פרסום) נכשלה:', () => query(
    `insert into activity_log (user_id, user_name, via, action, entity, entity_id, summary)
     values (null, 'פרסום אוטומטי', 'system', $1, 'posts', $2, $3)`,
    [action, String(post.id), summary]
  ));
}

/**
 * המייל של בעלי הארגון (RLS מסנן לארגון הפעיל) — לאירוע הכשל ב-HUB. רק
 * לארגון הפלטפורמה: החיבור ל-HUB (HUB_API_*) אחד לכל השרת, ואנשי הקשר שם
 * הם של הפלטפורמה — מייל של ארגון אחר היה מפעיל אוטומציה על איש קשר זר.
 */
async function ownerEmail() {
  if (!isPlatformOrg(currentOrg())) return null;
  const u = await bestEffort('שליפת המייל של הבעלים נכשלה:', () =>
    one('select email from users where is_owner order by id limit 1'));
  return u?.email ?? null;
}

/** מה שמסלול הכשל צריך לדעת על פוסט (בלי הגרסה והקבצים של loadPayload) */
async function loadPostBrief(postId) {
  return one(
    `select p.id, p.title, p.kind, p.status, p.channel_id, p.endpoint_id,
            c.name as channel_name, c.platform
       from posts p join channels c on c.id = p.channel_id
      where p.id = $1`,
    [postId]
  );
}

/**
 * מסלול הכשל האחד — כל פוסט שנכשל עובר כאן: כשל בפרסום, דיווח כשל מה-HUB,
 * איחור גדול מדי, פרסום שנתקע, ואיפוס ידני. post → failed עם ההודעה
 * הידידותית (friendlyPublishError), השגיאה הגולמית ל-publish_log, שורה
 * ביומן, אירוע ל-HUB (id ייחודי לניסיון + המייל של הבעלים) ומשימת כשל.
 *
 * from: מאילו סטטוסים מותר להעביר (null = מכל סטטוס — publishOne כבר תפס
 * את הפוסט). notify=false — בלי אירוע ל-HUB (מי שאיפס ידנית כבר יודע).
 * internal=true — הודעה שלנו, כבר בעברית ובניסוח הסופי (איחור, תקיעה, איפוס
 * ידני, דיווח ה-HUB): עוברת כמו שהיא, בלי מיפוי — שם משתמש באנגלית בהערת
 * האיפוס לא יהפוך אותה ל"סיבה שלא זיהינו".
 * @returns {Promise<{ok:false, error:string}|null>} null = הפוסט כבר לא היה בסטטוס המותר
 */
export async function failPost(post, err, {
  title, from = null, notify = true, internal = false, deferNotify = false,
} = {}) {
  const raw = typeof err === 'string' ? err : err?.message ?? String(err);
  const { message, who } = internal
    ? { message: raw, who: 'owner' }
    : friendlyPublishError(err, { platform: post.platform });
  const moved = await one(
    `update posts set status = 'failed', publish_error = $2
      where id = $1 and ($3::text[] is null or status = any($3::text[])) returning id`,
    [post.id, message, from]);
  if (!moved) return null;

  const attempt = await logPublish(post, false, { error: raw });
  await logActivity('publish_failed', post, `${title}: "${post.title}" — ${message}`);
  // deferNotify — האירוע חוזר לקורא (notify) והוא שולח אותו אחרי ה-commit:
  // שלא יצא אירוע על כשל שהתגלגל אחורה, ושה-HUB לא יחזיק טרנזקציה פתוחה
  let event = null;
  if (notify) {
    const args = ['post_publish_failed', post, { error: message, who },
      { attempt: attempt ?? Date.now(), email: await ownerEmail() }];
    if (deferNotify) event = () => emitPostEvent(...args);
    else await emitPostEvent(...args);
  }
  await recordFailedTask(post, title, message, who);
  return { ok: false, error: message, ...(event ? { notify: event } : {}) };
}

/** הפוסט + הערוץ + החיבור + הגרסה + הקבצים — כל מה שצריך לפרסום אחד */
export async function loadPayload(postId) {
  const post = await one(
    `select p.*, c.name as channel_name, c.platform, c.active as channel_active,
            cc.page_id, cc.ig_user_id, cc.access_token_enc, cc.auto_enabled
       from posts p
       join channels c on c.id = p.channel_id
       left join channel_connections cc on cc.channel_id = c.id
      where p.id = $1`,
    [postId]
  );
  if (!post) return null;

  const variant = post.content_id
    ? await one('select * from content_variants where content_id = $1 and channel_id = $2',
                [post.content_id, post.channel_id])
    : null;

  // קובץ ב-R2 נשלף בלי bytes (הפלטפורמה מושכת אותו מהקישור הציבורי);
  // רק קובץ ישן שעוד במסד מביא את הבייטים שלו
  // משבצת מקושרת: הקבצים של המקור (itemAssetsSql עוקב אחרי הקישור)
  const assets = post.content_id
    ? await rows(
        itemAssetsSql(`a.id, a.filename, a.mime, a.size_bytes, a.storage_key,
                       case when a.storage_key is null then a.data end as data`),
        [post.content_id, post.channel_id])
    : [];

  return { post, variant, assets };
}

/** מה חוסם את הפוסט מפרסום אוטומטי? null = כלום, אפשר לפרסם. */
export function publishBlocker({ post, variant, assets }) {
  // ניוזלטר: השליחה בפועל דרך ה-HUB — נדרשים חיבור, תוכן ונושא. כלל התוכן
  // אחד עם סימון "מוכן" (readiness.js → newsletterContentBlocker)
  if (post.platform === 'newsletter') return newsletterBlocker({ post, variant }, hubMailReady());

  if (!['facebook', 'instagram'].includes(post.platform)) {
    return `הערוץ "${post.channel_name}" לא מחובר לפרסום אוטומטי (${post.platform === 'whatsapp' ? 'וואטסאפ נשלח ידנית' : 'אין אינטגרציה'})`;
  }
  if (!post.access_token_enc) return 'אין חיבור פעיל לערוץ — מגדירים בניהול → ערוצי פרסום';
  if (post.platform === 'facebook' && !post.page_id) return 'חסר מזהה עמוד פייסבוק בחיבור';
  if (post.platform === 'instagram' && !post.ig_user_id) return 'חסר מזהה חשבון אינסטגרם בחיבור';
  if (!post.content_id) return 'אין תוכן משויך לפוסט';
  if (!variant || variant.status !== 'ready') return 'הגרסה לערוץ הזה עוד לא מסומנת "מוכן"';

  // מה שחסר בתוכן עצמו (מדיה לאינסטגרם, טקסט או מדיה לפייסבוק) — אותו כלל
  // כמו בסימון "מוכן" (readiness.js)
  const missing = contentBlocker({ platform: post.platform, variant, assets });
  if (missing) return missing;
  // סטורי בפייסבוק — אין לו מסלול אוטומטי; לא יוצא כפוסט רגיל בטעות
  if (post.platform === 'facebook' && isStory(variant)) {
    return 'סטורי בפייסבוק לא מתפרסם אוטומטית — מפרסמים ידנית ומסמנים "פורסם"';
  }
  const media = postMedia({ variant, assets });
  const cover = post.platform === 'instagram' ? coverAsset({ variant, assets }) : null;
  if (post.platform === 'instagram' && !publicAssetsReady()) {
    return 'הגשת מדיה ציבורית לא מוגדרת (R2_PUBLIC_*) — נדרשת לאינסטגרם';
  }
  if ([...media, ...(cover ? [cover] : [])].some((a) => a.storage_key && !mediaUrl(a.storage_key))) {
    return 'הכתובת הציבורית של המדיה לא מוגדרת (R2_PUBLIC_BASE_URL) — אי אפשר לשלוח את הקבצים';
  }
  return null;
}

/**
 * הקבצים לפייסבוק: קובץ ב-R2 נשלח כקישור (Graph מושך אותו בעצמו),
 * קובץ ישן מהמסד — כבייטים ב-multipart כמו קודם.
 */
export const facebookAssets = (media) => media.map((a) => (a.storage_key
  ? { url: mediaUrl(a.storage_key), mime: a.mime, filename: a.filename }
  : { buffer: a.data, mime: a.mime, filename: a.filename }));

/**
 * פרסום לאינסטגרם, שמושך מדיה רק מ-URL ציבורי. קובץ ב-R2 — הקישור הקבוע
 * שלו כמו שהוא. קובץ ישן (bytea) — עותק זמני ב-bucket הציבורי, שנמחק
 * ב-finally. רק העותקים הזמניים נמחקים: הקבצים הקבועים לעולם לא.
 */
export async function publishInstagramPost({ post, token, text, media, cover = null, options = {} },
  deps = {}) {
  const {
    upload = uploadPublicAsset, remove = deletePublicAssets, publish = publishInstagram,
  } = deps;
  const tempKeys = [];
  const publicUrl = async (a) => {
    if (a.storage_key) return mediaUrl(a.storage_key);
    const { url, key } = await upload({ buffer: a.data, mime: a.mime, filename: a.filename });
    tempKeys.push(key);
    return url;
  };
  try {
    const items = [];
    for (const a of media) items.push({ url: await publicUrl(a), video: isVideo(a.mime) });
    const coverUrl = cover ? await publicUrl(cover) : null;
    const { story, altText, thumbOffsetMs } = options;
    return await publish({ igUserId: post.ig_user_id, token, caption: text, media: items,
                           story, altText, thumbOffsetMs, coverUrl });
  } finally {
    if (tempKeys.length) await remove(tempKeys);
  }
}

/**
 * מה שנוסף לגרסה מעבר לטקסט ולקבצים (meta — ראו readiness.js), בצורה
 * שהפרסום ב-meta.js מקבל. רק לתמונה בודדת יש תיאור תמונה.
 */
export function publishOptions({ platform, variant, media }) {
  const m = variant?.meta ?? {};
  const str = (x) => String(x ?? '').trim() || null;
  const singleImage = media.length === 1 && isImage(media[0].mime);
  const opts = { comment: str(m.first_comment), altText: singleImage ? str(m.alt_text) : null };
  if (platform === 'facebook') return { ...opts, link: str(m.link) };
  const sec = Number(m.cover_offset_sec);
  return { ...opts, story: isStory(variant),
           thumbOffsetMs: Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null };
}

/**
 * התגובה הראשונה לא נכתבה, אבל הפוסט כבר באוויר — לא כשל של הפוסט: משימה
 * להוסיף אותה ידנית (עם הטקסט להעתקה) ושורה ביומן.
 */
async function recordCommentFailed(post, comment, err) {
  const { message } = friendlyPublishError(err, { platform: post.platform });
  console.error(`תגובה ראשונה לפוסט #${post.id} נכשלה:`, err?.message ?? err);
  await logActivity('publish_comment_failed', post,
    `התגובה הראשונה לא נכתבה — "${post.title}" ב${post.channel_name}: ${message}`);
  await bestEffort('יצירת משימת תגובה ראשונה נכשלה:', () => query(
    `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on)
     values ($1,$2,'general',$3,$4,true,(now() at time zone 'Asia/Jerusalem')::date)`,
    [`להוסיף תגובה ראשונה ידנית — ${post.channel_name}`,
     `"${post.title}" פורסם, אבל התגובה הראשונה לא נכתבה (${message}). הטקסט: ${comment}`,
     post.id, post.endpoint_id]));
}

/**
 * תפיסת פוסט לפרסום — UPDATE מותנה, אטומי: רק מי שהעביר ל-publishing
 * ממשיך, בלי פרסום כפול. publishing_started_at — לזיהוי פרסום שנתקע
 * באמצע (failStuckPublishing).
 * $3 (dueOnly, הטיק) — בודקים שוב, ברגע התפיסה, את כל מה שהכניס את הפוסט
 * לרשימת הטיק: הזמן הגיע, המתג של הארגון דולק, הערוץ פעיל ובפרסום
 * אוטומטי, הקמפיין לא מושהה, הנקודה לא מושבתת. פוסט שהוזז קדימה, הושהה או
 * שהערוץ / הנקודה שלו כובו בזמן שהטיק עבר על הרשימה — לא יוצא.
 */
const CLAIM_SQL =
  `update posts p set status = 'publishing', publishing_started_at = now()
    where p.id = $1 and p.status = any($2)
      and (not $3::boolean or (
            p.scheduled_at <= now()
        and exists (select 1 from engine_settings s where s.autopublish_enabled)
        and exists (select 1 from channels c
                      join channel_connections cc on cc.channel_id = c.id
                     where c.id = p.channel_id and c.active and cc.auto_enabled)
        and not exists (select 1 from content_items ci
                          join campaigns ca on ca.id = ci.campaign_id
                         where ci.id = p.content_id and ca.paused_at is not null)
        and ${endpointLiveSql('p')}))
    returning p.id`;

/** הפוסט עלה, אבל שמירת התוצאה נכשלה פעמיים — לעולם לא מפרסמים שוב לבד */
export const PUBLISHED_UNSAVED_ERROR =
  'הפוסט נשלח לפלטפורמה, אבל שמירת התוצאה במערכת נכשלה — לא מפרסמים שוב. ' +
  'בודקים בעמוד, ואם הוא שם מסמנים "פורסם"';

/**
 * כתיבת התוצאה של פוסט שכבר נתפס (published / failed) — טרנזקציה קצרה
 * משלה, וניסיון חוזר אחד. נכשל פעמיים — זורק: הפוסט נשאר publishing,
 * ו-failStuckPublishing סוגר אותו אחרי STUCK_SOCIAL_MINUTES עם "ייתכן
 * שכבר עלה". fn כותב למסד בלבד (אירועים — אחרי ה-commit), ולכן בטוח לחזור.
 */
async function recordOutcome(orgId, fn) {
  try {
    return await withOrg(orgId, fn);
  } catch (e) {
    console.error('שמירת תוצאת הפרסום נכשלה — מנסים שוב:', e.message);
    return withOrg(orgId, fn);
  }
}

/**
 * כשל של פוסט שכבר נתפס (publishing) → failed, בטרנזקציה משלו; האירוע ל-HUB
 * אחרי ה-commit. post=null — השליפה עצמה נכשלה: רק הסטטוס, אין למי לשייך
 * משימה. גם השמירה הזו נכשלה — הפוסט נשאר publishing עד שיזוהה כתקוע
 * (לא חוזר ל-approved ולא מתפרסם שוב לבד).
 */
async function failClaimed(orgId, postId, post, error, opts = {}) {
  const fallback = () => (opts.internal ? String(error)
    : friendlyPublishError(error, { platform: post?.platform }).message);
  let out;
  try {
    out = await recordOutcome(orgId, async () => {
      if (!post) {
        const { message } = friendlyPublishError(error);
        await query(`update posts set status = 'failed', publish_error = $2
                      where id = $1 and status = 'publishing'`, [postId, message]);
        return { ok: false, error: message };
      }
      return (await failPost(post, error, {
        title: `פרסום אוטומטי נכשל — ${post.channel_name}`, from: ['publishing'],
        deferNotify: true, ...opts,
      })) ?? { ok: false, error: fallback() };
    });
  } catch (e) {
    console.error(`סימון פוסט #${postId} כנכשל לא נשמר — נשאר publishing עד שיזוהה כתקוע:`, e.message);
    return { ok: false, error: fallback() };
  }
  await out.notify?.();
  return { ok: false, error: out.error };
}

/**
 * שלב ההכנה, בטרנזקציה קצרה: הפוסט, הגרסה והקבצים, מה חוסם, והטוקן.
 * מחזיר את כל מה שהקריאה ל-Graph צריכה — או { post, error, failOpts }.
 */
async function preparePublish(postId, { checkDigest = false } = {}) {
  const payload = await loadPayload(postId);
  if (!payload) return { post: null, error: 'הפוסט נעלם' };

  const { post, variant, assets } = payload;
  // סעיף 31: הטיק מפרסם רק את מה שאושר. התוכן השתנה מאז (נתיב שלא החזיר
  // לאישור) — לא מפרסמים; חוזר למתוכנן עם "לאשר מחדש". טביעה ריקה = אושר
  // לפני שהיו טביעות. "פרסם עכשיו" (checkDigest=false) — אדם לוחץ על מה שהוא רואה
  if (checkDigest && post.approved_digest && approvalDigest(payload) !== post.approved_digest) {
    return { post, changed: true };
  }
  const blocker = publishBlocker(payload);
  if (blocker) return { post, error: blocker };
  if (post.platform === 'newsletter') {
    // ניוזלטר לא נוצר ב-HUB מכאן לעולם — רק "העבר ל-HUB" (transferNewsletter)
    // יוצר, ושם בעל העסק מאשר. פוסט שהגיע לכאן לא הועבר: כשל עם הסבר.
    return { post, error: NOT_TRANSFERRED_ERROR,
             failOpts: { title: `ניוזלטר לא הועבר ל-HUB — ${post.channel_name}`, internal: true } };
  }
  const token = decryptToken(post);
  if (!token) return { post, error: 'פענוח הטוקן נכשל — מזינים אותו מחדש בהגדרות הערוץ' };

  const media = postMedia({ variant, assets });
  return {
    post, token, media,
    text: variant.body?.trim() ?? '',
    options: publishOptions({ platform: post.platform, variant, media }),
    cover: post.platform === 'instagram' ? coverAsset({ variant, assets }) : null,
  };
}

/**
 * הטיק סירב לפרסם פוסט שהתוכן שלו השתנה אחרי האישור (סעיף 31): publishing
 * (שעוד לא נשלח לשום מקום) → מתוכנן בלי אישור, משימת "לאשר מחדש" ושורה
 * ביומן. לא "נכשל": שום דבר לא יצא ולא נדחה, אדם צריך להחליט. נכשלה
 * השמירה — נשאר publishing ויסומן כתקוע (כמו כל שמירה שנכשלה).
 */
async function refuseChanged(orgId, post) {
  try {
    await recordOutcome(orgId, async () => {
      const back = await one(
        `update posts set status = 'scheduled', approved_by = null, approved_at = null,
                          approved_digest = null, publishing_started_at = null
          where id = $1 and status = 'publishing' returning id`, [post.id]);
      if (!back) return;
      await bestEffort('יצירת משימת "לאשר מחדש" נכשלה:', () => recordReapproveTask(post));
      await logActivity('publish_refused', post,
        `לא פורסם — "${post.title}" ב${post.channel_name}: ${CHANGED_AFTER_APPROVAL}`);
    });
  } catch (e) {
    console.error(`החזרת פוסט #${post.id} לאישור נכשלה — נשאר publishing עד שיזוהה כתקוע:`, e.message);
  }
  console.log(`פוסט #${post.id} ("${post.title}") לא פורסם — התוכן השתנה אחרי האישור`);
  return { ok: false, error: CHANGED_AFTER_APPROVAL };
}

/** הקריאה לפלטפורמה — בלי טרנזקציה פתוחה (יכולה לקחת דקות בוידאו לאינסטגרם) */
function sendToPlatform({ post, token, text, media, options, cover }) {
  if (post.platform === 'facebook') {
    return publishFacebook({
      pageId: post.page_id, token, message: text, assets: facebookAssets(media),
      link: options.link, altText: options.altText,
    });
  }
  // אינסטגרם מושך מ-URL ציבורי — ראו publishInstagramPost
  return publishInstagramPost({ post, token, text, media, options, cover });
}

/** שמירת ההצלחה: published + סגירת משימות + publish_log + יומן — טרנזקציה אחת */
async function markPublished(post, result) {
  const updated = await one(
    `update posts set status = 'published', published_at = now(),
            external_id = $2, external_url = $3, publish_error = null
      where id = $1 returning *`,
    [post.id, result.id, result.url]
  );
  if (!updated) return null; // השורה נעלמה — אין מה לשמור עליה
  await query(
    `update tasks set done = true, done_at = now() where post_id = $1 and done = false`,
    [post.id]);
  await logPublish(post, true, { externalId: result.id });
  await logActivity('publish', post, `פורסם אוטומטית — "${post.title}" ל${post.channel_name}`);
  return updated;
}

/**
 * פרסום פוסט אחד, מקצה לקצה, בשלבים — אף טרנזקציה לא פתוחה בזמן הקריאה
 * לפלטפורמה:
 *   1. תפיסה (approved → publishing), טרנזקציה קצרה שנשמרת מיד.
 *   2. הכנה — שליפה, חוסמים, טוקן — טרנזקציה קצרה.
 *   3. הקריאה ל-Graph, בלי טרנזקציה.
 *   4. התוצאה (published / failed + משימות + publish_log + יומן) —
 *      טרנזקציה קצרה, עם ניסיון חוזר אחד (recordOutcome).
 *   5. אחרי ה-commit: התגובה הראשונה (צריכה את המזהה החיצוני; כשל שלה
 *      נרשם בטרנזקציה משלו) והאירוע ל-HUB (עם הגבלת זמן, hub-events.js).
 * קודם הכול רץ בטרנזקציה אחת של הטיק: שגיאת SQL אחרי קריאה ל-Graph ביטלה
 * אותה, ה-commit התגלגל אחורה, וכל מה שיצא באותו טיק חזר ל-approved ויצא
 * שוב בדקה הבאה. פוסט שהתפיסה שלו נשמרה לא חוזר לפרסום לבד לעולם: כשל
 * בכל שלב = failed, ושמירה שנכשלה = נשאר publishing עד failStuckPublishing.
 *
 * כל שלב ב-withOrg משלו (RLS של הארגון) — גם כשנקרא מתוך בקשה ("פרסם
 * עכשיו"): לא תלוי בטרנזקציית הבקשה ולא בחיבור שלה. ולכן אסור לקרוא לה
 * כשהטרנזקציה של הקורא מחזיקה נעילה על שורת הפוסט (ראו withOrg).
 *
 * allowedFrom קובע מאילו סטטוסים מותר לתפוס (הטיק — רק approved; "פרסם
 * עכשיו" גם scheduled/failed). dueOnly — הטיק: התפיסה בודקת שוב שהפוסט
 * עדיין אמור לצאת עכשיו (CLAIM_SQL). orgId — ברירת מחדל: הארגון של ההקשר.
 * @returns {{ok: boolean, post?: object, error?: string}}
 */
export async function publishOne(postId,
  { allowedFrom = ['approved'], dueOnly = false, orgId = currentOrg() } = {}) {
  if (orgId == null) throw new Error('publishOne רץ רק בהקשר של ארגון');

  const claimed = await withOrg(orgId, () => one(CLAIM_SQL, [postId, allowedFrom, dueOnly]));
  if (!claimed) return { ok: false, error: 'הפוסט לא במצב שמאפשר פרסום' };

  let prep;
  try {
    prep = await withOrg(orgId, () => preparePublish(postId, { checkDigest: dueOnly }));
  } catch (e) {
    prep = { post: null, error: `שליפת נתוני הפוסט נכשלה: ${e.message}` };
  }
  if (prep.changed) return refuseChanged(orgId, prep.post);
  if (prep.error) return failClaimed(orgId, postId, prep.post, prep.error, prep.failOpts);

  const { post, token, options } = prep;
  let result;
  try {
    result = await sendToPlatform(prep);
  } catch (e) {
    // השגיאה עצמה (עם code/status) — friendlyPublishError מתרגם לפיה
    return failClaimed(orgId, postId, post, e);
  }

  let updated;
  try {
    updated = await recordOutcome(orgId, () => markPublished(post, result));
  } catch (e) {
    console.error(`חמור: פוסט #${post.id} ("${post.title}") עלה ל${post.channel_name} ` +
      `(מזהה ${result.id}${result.url ? `, ${result.url}` : ''}) — אבל שמירת התוצאה נכשלה פעמיים. ` +
      'הוא נשאר publishing ויסומן כתקוע; לא לפרסם שוב:', e);
    return { ok: false, error: PUBLISHED_UNSAVED_ERROR };
  }
  if (!updated) {
    console.error(`חמור: פוסט #${post.id} עלה (מזהה ${result.id}) אבל השורה שלו כבר לא במסד`);
  }

  // תגובה ראשונה — רק עכשיו, כשהפוסט כבר רשום "פורסם"
  if (options.comment && result.commentTarget) {
    const err = await postFirstComment(result.commentTarget, token, options.comment);
    if (err) {
      await withOrg(orgId, () => recordCommentFailed(post, options.comment, err))
        .catch((e) => console.error(`רישום כשל התגובה לפוסט #${post.id} נכשל:`, e.message));
    }
  }
  await emitPostEvent('post_published', post,
    { external_id: result.id, ...(result.url ? { external_url: result.url } : {}) });
  console.log(`פורסם אוטומטית: פוסט #${post.id} ("${post.title}") ל${post.channel_name}`);
  return { ok: true, post: updated };
}

/**
 * שלב בטיק — טרנזקציה קצרה משלו. כשל נרשם בלוג ולא עוצר את שאר הטיק
 * (ובפרט לא מגלגל אחורה פוסטים שכבר יצאו). מחזיר undefined בכשל.
 */
async function tickStep(orgId, label, fn) {
  try {
    return await withOrg(orgId, fn);
  } catch (e) {
    console.error(label, e.message);
    return undefined;
  }
}

/**
 * האם פוסט מאחר (OVERDUE_MINUTES), ואם כן — האם פוסט אחר באותו ערוץ פורסם
 * (published_at) או נתפס (publishing_started_at — כולל ניסיון שנכשל, שאולי
 * עלה) בתוך CATCHUP_SPACING_MINUTES. לפי now() של המסד, ממש לפני התפיסה —
 * פוסט שיצא קודם באותו טיק כבר נספר.
 */
const CATCHUP_SQL =
  `select p.channel_id,
          p.scheduled_at < now() - ($2 || ' minutes')::interval as overdue,
          exists (select 1 from posts o
                   where o.channel_id = p.channel_id and o.id <> p.id
                     and (o.published_at > now() - ($3 || ' minutes')::interval
                          or o.publishing_started_at > now() - ($3 || ' minutes')::interval)
                 ) as recent
     from posts p where p.id = $1`;

/** פוסט שאושר ופוספס ביותר מ-MAX_LATE_HOURS — נכשל, בטרנזקציה משלו */
async function failTooLate(orgId, id) {
  // אותו מסלול כשל כמו כל השאר: משימה, publish_log, יומן ואירוע ל-HUB
  const out = await tickStep(orgId, `סימון פוסט #${id} שאיחר כנכשל נכשל:`, async () => {
    const post = await loadPostBrief(id);
    return post ? failPost(post, TOO_LATE_ERROR, {
      title: `פרסום אוטומטי לא בוצע — ${post.channel_name}`, from: ['approved'], internal: true,
      deferNotify: true,
    }) : null;
  });
  await out?.notify?.();
}

/**
 * הטיק לארגון אחד: מפרסם את מה שאושר והגיע זמנו, ומכין משימות וואטסאפ.
 * בלי טרנזקציה אחת לכל הטיק — כל שלב (ובפרסום: כל שלב של כל פוסט) רץ
 * ב-withOrg קצר משלו, כך שכשל באחד לא מבטל את מה שכבר נשמר באחרים.
 */
export async function publishTickForOrg(orgId = currentOrg()) {
  if (orgId == null) throw new Error('publishTickForOrg רץ רק בהקשר של ארגון');

  // סגירת ניוזלטרים שכבר נשלחו ל-HUB רצה גם כשמתג-העל כבוי — היא משלימה
  // פעולה שכבר אושרה ויצאה, לא מתחילה חדשה.
  const hubState = (await tickStep(orgId, 'בדיקת סטטוס ניוזלטרים נכשלה:',
    () => pollNewsletterOutcomes())) ?? new Map();

  // פרסום שנתקע ב-publishing (תהליך שנפל באמצע, ניוזלטר שה-HUB לא סגר) —
  // גם כשהמתג כבוי: זה פוסט שכבר יצא לדרך, לא פרסום חדש. לניוזלטר — לפי
  // מה שה-HUB ענה בבדיקה של הטיק הזה (hubState)
  await tickStep(orgId, 'סגירת פרסומים תקועים נכשלה:',
    () => failStuckPublishing(new Date(), hubState));

  // וואטסאפ נשלח ידנית — המשימה שלו לא תלויה במתג הפרסום האוטומטי
  await whatsappPrep(orgId);

  // ניוזלטר שהגיע מועדו ולא הועבר ל-HUB — נכשל עם משימה, לא שליחה. רק
  // כשהמתג דלוק: כבוי, אין "העבר ל-HUB" בכלל, והניוזלטר מקבל משימת "לפרסם
  // היום" כמו כל ערוץ ידני (manualPublishPrep)
  await tickStep(orgId, 'בדיקת ניוזלטרים שלא הועברו נכשלה:', async () => {
    if (await autopublishOn()) await newsletterNotTransferred();
  });

  // פוסטים שאושרו והגיע זמנם. איחור גדול מדי לא מתפרסם — נכשל עם הסבר.
  // קמפיין מושהה / נקודה מושבתת — לא יוצא, גם פוסט שאושר לפני (הלוח מסתיר אותו).
  // ניוזלטר לא כאן: הוא לא נשלח מהטיק (newsletterNotTransferred / transferNewsletter).
  // התפיסה של כל פוסט בודקת את כל זה שוב (CLAIM_SQL) — הרשימה יכולה להתיישן.
  const due = (await tickStep(orgId, 'שליפת הפוסטים שהגיע זמנם נכשלה:', async () => {
    const settings = await one('select autopublish_enabled from engine_settings limit 1');
    if (!settings?.autopublish_enabled) return [];
    return rows(
      `select p.id, p.scheduled_at < now() - ($1 || ' hours')::interval as too_late
         from posts p
         join channels c on c.id = p.channel_id and c.active
         left join channel_connections cc on cc.channel_id = c.id
        where p.status = 'approved' and p.scheduled_at <= now()
          and cc.auto_enabled = true and c.platform <> 'newsletter'
          and not exists (select 1 from content_items ci
                            join campaigns ca on ca.id = ci.campaign_id
                           where ci.id = p.content_id and ca.paused_at is not null)
          and ${endpointLiveSql('p')}
        order by p.scheduled_at`,
      [MAX_LATE_HOURS]
    );
  })) ?? [];

  // השלמה אחרי השבתה — מאחר אחד לערוץ בטיק, ורק אחרי מרווח (CATCHUP_SQL)
  const caughtUp = new Set();
  for (const { id, too_late } of due) {
    if (too_late) {
      await failTooLate(orgId, id);
      continue;
    }
    const pace = await tickStep(orgId, `בדיקת מרווח לפוסט #${id} נכשלה:`,
      () => one(CATCHUP_SQL, [id, OVERDUE_MINUTES, CATCHUP_SPACING_MINUTES]));
    if (!pace) continue; // נעלם, או שהבדיקה נכשלה — הטיק הבא
    if (pace.overdue) {
      if (pace.recent || caughtUp.has(pace.channel_id)) continue;
      caughtUp.add(pace.channel_id);
    }
    await publishOne(id, { orgId, dueOnly: true })
      .catch((e) => console.error(`פרסום פוסט #${id} נכשל:`, e.message));
  }
}

/**
 * למה פוסט שתקוע ב-publishing צריך לעבור ל-failed, או null אם עוד מוקדם
 * (טהורה). started — מתי נתפס (publishing_started_at; schema.sql ממלא
 * אותו לפוסטים שהיו ב-publishing לפני העמודה).
 * hub — לניוזלטר: מה ה-HUB ענה בבדיקת הסטטוס של הטיק הזה. 'active'
 * (scheduled/sending) = עוד שולח: נשארים publishing עד 72 שעות. 'draft' =
 * ממתין לאישור בעל העסק ב-HUB: אחרי יממה — "לא אושר". כל השאר (לא ענה,
 * לא נבדק, לא מוגדר) — כשל אחרי יממה. סטטוס סופי (failed/cancelled/נמחק)
 * כבר נסגר ב-pollNewsletterOutcomes.
 * scheduled — לניוזלטר: המועד (של ה-HUB אם ידוע, אחרת שלנו). השעון מתחיל
 * מהמאוחר מבין ההעברה למועד — ניוזלטר שהועבר ימים מראש לא "תקוע".
 * legacy — ניוזלטר שהרַנֶר הישן יצר ב-HUB בעצמו (לפני "העבר ל-HUB";
 * hub_transferred_at ריק): נשאר על הכלל הישן — טיוטה ב-HUB נחשבת "עוד
 * באוויר" עד 72 שעות, בלי "לא אושר" אחרי יממה.
 */
export function stuckPublishingError(
  { platform, started, scheduled = null, hub = null, legacy = false }, now = new Date()) {
  if (!started) return null;
  if (platform === 'newsletter') {
    const from = newsletterClockStart({ started, scheduled });
    const age = now.getTime() - from.getTime();
    if (age > STUCK_NEWSLETTER_CAP_HOURS * 3600000) return STUCK_NEWSLETTER_CAP_ERROR;
    if (hub === 'active' || (legacy && hub === 'draft')) return null;
    if (age <= STUCK_NEWSLETTER_HOURS * 3600000) return null;
    return hub === 'draft' ? NOT_APPROVED_ERROR : STUCK_NEWSLETTER_ERROR;
  }
  const age = now.getTime() - new Date(started).getTime();
  return age > STUCK_SOCIAL_MINUTES * 60000 ? STUCK_SOCIAL_ERROR : null;
}

/**
 * פוסטים שנתקעו ב-publishing → failed דרך מסלול הכשל הרגיל. פייסבוק/
 * אינסטגרם אחרי 30 דקות (הפרסום נקטע — אולי עלה ואולי לא, ולכן לא מנסים
 * שוב לבד), ניוזלטר לפי stuckPublishingError. קמפיין מושהה וערוץ מושבת לא נוגעים.
 * hubState: Map<post id, {hub, scheduled}> מ-pollNewsletterOutcomes.
 */
async function failStuckPublishing(now = new Date(), hubState = new Map()) {
  const stuck = await rows(
    `select p.id, c.platform,
            p.publishing_started_at as started, p.scheduled_at,
            p.hub_transferred_at is null as legacy
       from posts p
       join channels c on c.id = p.channel_id and c.active
      where p.status = 'publishing'
        and not exists (select 1 from content_items ci
                          join campaigns ca on ca.id = ci.campaign_id
                         where ci.id = p.content_id and ca.paused_at is not null)`
  );
  for (const s of stuck) {
    const h = hubState.get(s.id);
    const error = stuckPublishingError({
      platform: s.platform, started: s.started,
      scheduled: h?.scheduled ?? s.scheduled_at, hub: h?.hub ?? null, legacy: s.legacy,
    }, now);
    if (!error) continue;
    await bestEffort(`סגירת פוסט #${s.id} שנתקע נכשלה:`, async () => {
      const post = await loadPostBrief(s.id);
      if (!post) return;
      const title = post.platform === 'newsletter'
        ? (error === NOT_APPROVED_ERROR
          ? `ניוזלטר לא אושר ב-HUB — ${post.channel_name}`
          : `שליחת ניוזלטר לא הושלמה — ${post.channel_name}`)
        : `פרסום נקטע באמצע — ${post.channel_name}`;
      if (await failPost(post, error, { title, from: ['publishing'], internal: true })) {
        console.log(`פוסט #${post.id} ("${post.title}") נתקע ב-publishing — סומן כנכשל`);
      }
    });
  }
}

/**
 * איפוס ידני של פוסט שתקוע ב-publishing (POST /posts/:id/reset-publishing):
 * עובר ל-failed עם הערה מי איפס, ומקבל משימת כשל — בלי אירוע ל-HUB.
 * @returns {Promise<object|null>} הפוסט המעודכן, או null אם הוא לא ב-publishing
 */
/** "שחרר פרסום תקוע" — רק אחרי 10 דקות בפרסום; לפני זה הוא כנראה עוד רץ */
export const RESET_MIN_MS = 10 * 60000;
export const RESET_TOO_SOON = 'הפרסום התחיל לפני פחות מ-10 דקות — מחכים עוד קצת';
export const resetTooSoon = (startedAt, now = new Date()) =>
  startedAt != null && now.getTime() - new Date(startedAt).getTime() < RESET_MIN_MS;

export const RESET_TOO_SOON_HUB =
  'הניוזלטר בידי ה-HUB ומחכה למועד — אפשר לשחרר אותו רק 10 דקות אחרי המועד';

/**
 * מאיזה רגע סופרים את 10 הדקות של "שחרר פרסום תקוע": ניוזלטר שהועבר
 * ל-HUB (שיכול לחכות ימים לאישור ולמועד) — מהמאוחר מבין ההעברה למועד;
 * כל השאר — מתי שנתפס ל-publishing.
 */
export function resetClockStart({ publishing_started_at: started, scheduled_at: scheduled,
                                  hub_transferred_at: transferred }) {
  if (!transferred) return started ?? null;
  return newsletterClockStart({ started, scheduled });
}

/** מחזיר { post } או { error } (פרסום שהתחיל לפני פחות מ-RESET_MIN_MS) או null */
export async function resetPublishing(postId, user) {
  const post = await loadPostBrief(postId);
  if (!post || post.status !== 'publishing') return null;
  const clock = await one(
    'select publishing_started_at, scheduled_at, hub_transferred_at from posts where id = $1', [postId]);
  if (resetTooSoon(clock ? resetClockStart(clock) : null)) {
    return { error: clock?.hub_transferred_at ? RESET_TOO_SOON_HUB : RESET_TOO_SOON };
  }
  const note = `הפרסום סומן כתקוע ידנית${user?.name ? ` על ידי ${user.name}` : ''} — ` +
    'בודקים בעמוד אם הפוסט עלה, ואז מסמנים פורסם או מפרסמים שוב';
  const r = await failPost(post, note,
    { title: `פרסום אופס ידנית — ${post.channel_name}`, from: ['publishing'], notify: false,
      internal: true });
  return r ? { post: await one('select * from posts where id = $1', [postId]) } : null;
}

export const WA_SUB_READY = 'מעתיקים את הטקסט, שולחים לקבוצה ומסמנים פורסם';
export const WA_SUB_NOT_READY =
  'הטקסט לוואטסאפ עוד לא מוכן — משלימים אותו בתוכן, ואז שולחים ומסמנים פורסם';
export const MANUAL_SUB_READY = 'מעתיקים את הטקסט, מפרסמים ומסמנים פורסם';
export const MANUAL_SUB_NOT_READY =
  'הטקסט לערוץ הזה עוד לא מוכן — משלימים אותו בתוכן, ואז מפרסמים ומסמנים פורסם';
export const MANUAL_SUB_TITLE_ONLY = 'מבצע דחוף, כותרת בלבד — מפרסמים ומסמנים פורסם';
// ניוזלטר כשהפרסום האוטומטי כבוי: אין "העבר ל-HUB" — שולחים אותו ב-HUB ביד
export const NEWSLETTER_SUB_READY = 'שולחים את הניוזלטר ב-HUB ומסמנים פורסם';
export const NEWSLETTER_SUB_NOT_READY =
  'הניוזלטר עוד לא מוכן — משלימים אותו בתוכן, ואז שולחים ב-HUB ומסמנים פורסם';

/** מאיזו שעה (שעון ישראל) נוצרות משימות "לפרסם היום" של היום */
export const PUBLISH_DAY_FROM_HOUR = 6;

/** השעה המקומית (0–23) בשעון ישראל — בלי תלות ב-TZ של התהליך */
export function localHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: LOCAL_TZ, hour: '2-digit', hourCycle: 'h23',
  }).format(d));
}

/**
 * מה לעשות עם משימת "לפרסם היום" של פוסט אחד: 'insert' — אין עדיין משימה
 * להיום; 'update' — יש משימה פתוחה, אבל מצב המוכנות של הטקסט השתנה מאז
 * שנוצרה (הכותרת המשנית שלה כבר לא נכונה); null — אין מה לעשות. משימה
 * שנסגרה לא נפתחת מחדש באותו יום.
 */
export function waTaskAction({ ready, task_id, task_done, task_ready }) {
  if (task_id == null) return 'insert';
  if (task_done) return null;
  return task_ready === ready ? null : 'update';
}

/** כותרת המשימה: וואטסאפ — "לשלוח", כל ערוץ ידני אחר — "לפרסם היום ב…" */
export function publishTaskTitle(p) {
  return p.platform === 'whatsapp'
    ? `לשלוח בוואטסאפ: ${p.title}`
    : `לפרסם היום ב${p.channel_name}: ${p.title}`;
}

/** הכותרת המשנית — אומרת מה עושים, לפי מצב הטקסט */
export function publishTaskSubtitle(p) {
  if (p.urgent && p.content_id == null) return MANUAL_SUB_TITLE_ONLY;
  if (p.platform === 'whatsapp') return p.ready ? WA_SUB_READY : WA_SUB_NOT_READY;
  if (p.platform === 'newsletter') return p.ready ? NEWSLETTER_SUB_READY : NEWSLETTER_SUB_NOT_READY;
  return p.ready ? MANUAL_SUB_READY : MANUAL_SUB_NOT_READY;
}

/**
 * משימת "לפרסם היום" (סעיף 1): כמעט הכול מתפרסם ביד — אדם מעלה לפייסבוק /
 * אינסטגרם / וואטסאפ ואמור לסמן "פורסם". לכל פוסט של היום בערוץ שלא מתפרסם
 * לבד נוצרת בבוקר (מ-PUBLISH_DAY_FROM_HOUR בשעון ישראל) משימה אחת, עם
 * "העתק טקסט" ו"סמן שפורסם", שנסגרת לבד (task-lifecycle.js): פורסם, נמחק,
 * הוזז ליום אחר, או שהיום נגמר — ואז הפוסט עובר לרשימת "לא אושר שיצא".
 * פוסט שנוסף מאוחר יותר באותו יום מקבל משימה בטיק הבא.
 *
 * "לא מתפרסם לבד": אין חיבור עם פרסום אוטומטי לערוץ (channel_connections
 * .auto_enabled) או שהמתג הכללי (autopublish_enabled) כבוי. ניוזלטר — רק
 * כשהמתג כבוי (דלוק — יש לו מסלול משלו דרך ה-HUB; כבוי — שולחים אותו ידנית
 * ב-HUB ומסמנים פורסם). בלי קמפיין מושהה או ערוץ מושבת, ובלי פוסט בלי
 * כותרת. מבצע דחוף (כותרת בלבד) — כן. לא דחופה: הדחיפות מחושבת בקריאה
 * (routes/tasks.js — היום/באיחור).
 *
 * קודם: רק וואטסאפ, רבע שעה לפני המועד (מאז הפרסום האוטומטי, d72c27b).
 * וואטסאפ נכנס לאותו כלל — משימה בבוקר.
 *
 * הטקסט להעתקה נשלף חי ב-GET /tasks (copy_text), כך שתיקון בגרסה אחרי
 * יצירת המשימה מגיע גם לכפתור. due_on — התאריך המקומי.
 */
export async function manualPublishPrep(orgId, now = new Date()) {
  if (localHour(now) < PUBLISH_DAY_FROM_HOUR) return;
  const today = localYmd(now);
  // הרשימה בטרנזקציה קצרה, וכל משימה בטרנזקציה משלה — כשל באחת לא מבטל את האחרות
  const due = (await tickStep(orgId, 'הכנת משימות "לפרסם היום" נכשלה:', () => rows(
    `select p.id, p.title, p.endpoint_id, p.assignee_id, p.urgent, p.content_id,
            c.platform, c.name as channel_name, $1::date::text as due_on,
            coalesce(v.status = 'ready', false) as ready, v.body,
            t.id as task_id, t.done as task_done,
            coalesce(t.meta->>'text_ready', t.meta->>'wa_ready')::boolean as task_ready
       from posts p
       join channels c on c.id = p.channel_id and c.active
       left join channel_connections cc on cc.channel_id = c.id
       left join content_variants v on v.content_id = p.content_id
            and v.channel_id = p.channel_id
       left join lateral (
         select t.id, t.done, t.meta from tasks t
          where t.post_id = p.id and t.kind = 'publish' and t.due_on = $1::date
          order by t.done, t.id desc limit 1
       ) t on true
      where p.status in ('scheduled', 'approved') and p.published_at is null
        and nullif(btrim(p.title), '') is not null
        and (p.scheduled_at at time zone 'Asia/Jerusalem')::date = $1::date
        -- ערוץ שמתפרסם לבד (חיבור עם פרסום אוטומטי + המתג הכללי דלוק) — לא כאן
        and not (coalesce(cc.auto_enabled, false)
                 and exists (select 1 from engine_settings s where s.autopublish_enabled))
        -- ניוזלטר: כשהמתג דלוק יש לו מסלול משלו (העבר ל-HUB); כבוי — ידני כמו כולם
        and (c.platform <> 'newsletter'
             or not exists (select 1 from engine_settings s where s.autopublish_enabled))
        and not exists (select 1 from content_items ci
                          join campaigns ca on ca.id = ci.campaign_id
                         where ci.id = p.content_id and ca.paused_at is not null)
        and ${endpointLiveSql('p')}`,
    [today]
  ))) ?? [];

  for (const p of due) {
    const action = waTaskAction(p);
    if (!action) continue;
    await tickStep(orgId, `משימת "לפרסם היום" לפוסט #${p.id} נכשלה:`,
      () => writePublishTask(p, action));
  }
}

/** הנקודה שהטיק קורא לה (publishTickForOrg) — היום כל ערוץ ידני, לא רק וואטסאפ */
const whatsappPrep = (orgId) => manualPublishPrep(orgId);

/** כתיבת משימת "לפרסם היום" של פוסט אחד לפי waTaskAction (insert / update) */
async function writePublishTask(p, action) {
  const subtitle = publishTaskSubtitle(p);
  if (action === 'insert') {
    // אחת לכל פוסט ליום (tasks_publish_day_uidx) — טיק מקביל לא יוצר כפולה
    await query(
      `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on, meta, assignee_id)
       values ($1,$2,'publish',$3,$4,false,$5,$6,$7)
       on conflict (post_id, due_on) where kind = 'publish' and (meta->>'publish_day') = 'true'
       do nothing`,
      [publishTaskTitle(p), subtitle, p.id, p.endpoint_id, p.due_on,
       JSON.stringify({
         publish_day: true,
         ...(p.platform === 'whatsapp' ? { wa_send: true } : {}),
         // ניוזלטר: הגוף הוא HTML / שדות תבנית, לא טקסט להעתקה — "העתק טקסט"
         // מעתיק את הנושא (routes/tasks.js copy_text)
         text_ready: p.ready, body: p.ready && p.platform !== 'newsletter' ? p.body : null,
         // האחראי של הפוסט מפרסם — פעם אחת (task-lifecycle.js autoAssignee)
         ...(p.assignee_id ? { assignee_auto: true } : {}),
       }),
       p.assignee_id ?? null]
    );
  } else if (action === 'update') {
    await query(
      `update tasks set subtitle = $2,
              meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('text_ready', $3::boolean)
        where id = $1 and done = false`,
      [p.task_id, subtitle, p.ready]
    );
  }
}

/* ========================= ניוזלטר: העברה ל-HUB ========================= */

/** כמה אחורה מחפשים ניוזלטר שהמועד שלו הגיע ולא הועבר — לא מציפים פוסטים ישנים */
export const NOT_TRANSFERRED_WINDOW_HOURS = 24;

/**
 * ניוזלטר (מתוכנן או מאושר) שהמועד שלו הגיע ולא הועבר ל-HUB: עובר ל"נכשל"
 * עם משימה דחופה — "ניוזלטר לא הועבר ל-HUB". לא שולחים ולא יוצרים כלום ב-HUB.
 * רק מהיממה האחרונה, כדי שפוסטים ישנים שנשארו "מתוכנן" לא יציפו משימות,
 * ורק פוסט עם תוכן: משבצת ניוזלטר ריקה נשארת "עבר המועד" כמו כל משבצת ריקה.
 */
async function newsletterNotTransferred() {
  const due = await rows(
    `select p.id from posts p
       join channels c on c.id = p.channel_id and c.active and c.platform = 'newsletter'
      where p.status in ('scheduled', 'approved')
        and p.content_id is not null
        and p.scheduled_at <= now()
        and p.scheduled_at > now() - ($1 || ' hours')::interval
        and not exists (select 1 from content_items ci
                          join campaigns ca on ca.id = ci.campaign_id
                         where ci.id = p.content_id and ca.paused_at is not null)
        and ${endpointLiveSql('p')}
      order by p.scheduled_at`,
    [NOT_TRANSFERRED_WINDOW_HOURS]
  );
  for (const { id } of due) {
    await bestEffort(`סימון ניוזלטר #${id} שלא הועבר נכשל:`, async () => {
      const post = await loadPostBrief(id);
      if (!post) return;
      const r = await failPost(post, NOT_TRANSFERRED_ERROR, {
        title: `ניוזלטר לא הועבר ל-HUB — ${post.channel_name}`,
        from: ['scheduled', 'approved'], internal: true,
      });
      if (r) console.log(`ניוזלטר #${id} ("${post.title}") — המועד הגיע והוא לא הועבר ל-HUB`);
    });
  }
}

/** HUB ענה "לא נמצא" בעצמו (JSON) — לא 404 של פרוקסי/נתיב שגוי */
const hubNotFound = (e) => e instanceof HubMailError && e.status === 404 && e.answered === true;

/**
 * "העבר ל-HUB" — הרגע היחיד שבו נוצר ניוזלטר ב-HUB. רץ בתוך טרנזקציית
 * הבקשה: השורה ננעלת (for update), כך שלחיצה כפולה מחכה ורואה שכבר הועבר.
 *
 *   כבר בידי ה-HUB (publishing/published) — מוחזר כמו שהוא (idempotent).
 *   הועבר פעם וחזר אלינו (שוחרר/נכשל) — שואלים את ה-HUB על הקמפיין הקודם:
 *     עדיין קיים ופעיל → מחברים אליו מחדש, בלי ליצור שני;
 *     נמחק → יוצרים באותו מפתח; נכשל סופית → מפתח חדש (nextHubRef).
 *   אחרת — יוצרים טיוטה ב-HUB עם מועד הפוסט, ומסמנים "בידי ה-HUB".
 *
 * @returns {Promise<{post:object, idempotent?:boolean, reused?:boolean} |
 *                   {error:string, status:number}>}
 *          שגיאת HUB (HubMailError) עולה למעלה — הנתיב מתרגם אותה.
 */
export async function transferNewsletter(postId, user, { now = new Date(), fetchImpl = fetch } = {}) {
  const locked = await one('select id from posts where id = $1 for update', [postId]);
  if (!locked) return { error: 'לא נמצא פוסט כזה', status: 404 };
  const payload = await loadPayload(postId);
  const { post, variant } = payload;
  if (post.platform === 'newsletter' && alreadyTransferred(post)) {
    return { post: await one('select * from posts where id = $1', [postId]), idempotent: true };
  }
  const blocked = transferBlocker(payload, { now, hubReady: hubMailReady() });
  if (blocked) return { error: blocked, status: 400 };

  // קמפיין קודם של הפוסט — עדיין חי ב-HUB?
  let prior = null;
  let reuse = null;
  if (post.external_id) {
    try {
      const s = await newsletterStatus(post.external_id, fetchImpl, { delays: [] });
      if (reusableHubStatus(s.status)) reuse = s;
      else prior = s.status === 'failed' ? 'failed' : null;
    } catch (e) {
      if (!hubNotFound(e)) throw e;
      prior = 'missing';
    }
  }

  const m = variant.meta ?? {};
  const create = (ref) => createNewsletter({
    externalRef: ref,
    subject: m.subject,
    htmlBody: variant.body ?? '',
    listIds: m.list_ids ?? [],
    segmentIds: m.segment_ids ?? [],
    name: post.title,
    scheduledAt: post.scheduled_at,
    templateId: m.template_id ?? null,
    fieldValues: cleanFieldValues(m.field_values),
  }, fetchImpl);

  let ref = post.hub_ref ?? null;
  let r;
  if (reuse) {
    r = { campaign_id: reuse.campaign_id ?? post.external_id, status: reuse.status };
  } else {
    ref = nextHubRef(post.id, post.hub_ref, prior);
    r = await create(ref);
    // אותו מפתח החזיר קמפיין שנכשל סופית (נוצר פעם בלי שנשמר אצלנו) — מפתח חדש
    if (r.idempotent && r.status === 'failed') {
      ref = nextHubRef(post.id, ref, 'failed');
      r = await create(ref);
    }
  }

  const updated = await one(
    `update posts set status = 'publishing', publishing_started_at = now(),
            external_id = $2, external_url = $3, hub_status = $4, hub_ref = $5,
            hub_digest = case when $6::text is null then hub_digest else $6 end,
            hub_transferred_at = now(), publish_error = null,
            approved_by = $7, approved_at = now()
      where id = $1 returning *`,
    // הטביעה: קמפיין חדש — מה שנשלח עכשיו; קמפיין קיים שחיברנו אליו מחדש —
    // נשארת זו מההעברה הקודמת; קמפיין קיים שלא ידענו עליו (ה-HUB החזיר
    // idempotent) — "לא ידוע", והלוח מזהיר לבדוק ב-HUB
    [post.id, r.campaign_id, hubCampaignUrl(r.campaign_id), r.status ?? 'draft', ref,
     reuse ? null : r.idempotent ? DIGEST_UNVERIFIED : newsletterDigest(payload), user?.id ?? null]
  );
  // משימת "לא הועבר" / כשל קודם — נסגרת: הניוזלטר בידי ה-HUB עכשיו
  await query(
    `update tasks set done = true, done_at = now()
      where post_id = $1 and kind = 'failed' and done = false`, [post.id]);
  await logPublish(post, true, { externalId: r.campaign_id });
  await logActivity('publish', post,
    `ניוזלטר "${post.title}" ${reuse ? 'חובר מחדש לקמפיין הקיים' : 'הועבר'} ב-HUB` +
    (r.recipient_count != null ? ` (${r.recipient_count} נמענים)` : '') +
    (user?.name ? ` על ידי ${user.name}` : '') + ' — ממתין לאישור שם');
  console.log(`ניוזלטר #${post.id} ("${post.title}") הועבר ל-HUB — קמפיין ${r.campaign_id}`);
  return { post: updated, reused: !!reuse, unverified: !reuse && !!r.idempotent };
}

/* ========================= ניוזלטר: סגירת מעגל מול ה-HUB ========================= */

/** מדדי שליחה מה-HUB אל post_results. לא נוגע ב-note/leads שהוזנו ידנית. */
async function saveNewsletterMetrics(postId, counts) {
  if (!counts) return;
  await bestEffort(`שמירת מדדי ניוזלטר לפוסט #${postId} נכשלה:`, () => query(
    `insert into post_results (post_id, reach, engagement, clicks)
     values ($1,$2,$3,$4)
     on conflict (post_id) do update set
       reach = excluded.reach, engagement = excluded.engagement,
       clicks = excluded.clicks, updated_at = now()`,
    [postId, counts.delivered ?? null, counts.opened ?? null, counts.clicked ?? null]
  ));
}

/** כשל שה-HUB דיווח אחרי שהפוסט כבר התקבל שם (השליחה אסינכרונית אצלו) */
async function failFromHub(post, error) {
  await failPost(post, error,
    { title: `שליחת ניוזלטר נכשלה — ${post.channel_name}`, from: ['publishing'], internal: true });
}

/**
 * הסטטוס האחרון שה-HUB דיווח — לתצוגה בלוח ("ממתין לאישור ב-HUB") — ומתי
 * נשאל (hub_polled_at), כדי לא לשאול שוב מוקדם מדי (pollDue).
 */
async function saveHubStatus(post, status) {
  await bestEffort(`שמירת סטטוס ה-HUB לפוסט #${post.id} נכשלה:`, () =>
    // external_url נמלא גם בדיעבד: פוסט שהרַנֶר הישן יצר, או שהועבר לפני
    // שהוגדר HUB_APP_URL — מקבל "פתח ב-HUB" ברגע שהכתובת ידועה
    query(`update posts set hub_status = $2, hub_polled_at = now(),
                  external_url = coalesce(external_url, $3) where id = $1`,
          [post.id, status, hubCampaignUrl(post.external_id)]));
}

/**
 * ה-HUB מגביל 30 בקשות לדקה לכל IP. טיוטה שממתינה לאישור (יכולה לחכות
 * ימים) ופוסט שכבר נכשל (מחכים רק להצלחה מאוחרת) נשאלים פעם ב-10 דקות;
 * מתוזמן/נשלח ב-HUB — בכל טיק, כמו קודם (טהורה).
 */
export const SLOW_POLL_MINUTES = 10;
export function pollDue({ status, hub_status: hub, hub_polled_at: polled }, now = new Date()) {
  const slow = status === 'failed' || hub === 'draft';
  if (!slow || !polled) return true;
  return now.getTime() - new Date(polled).getTime() >= SLOW_POLL_MINUTES * 60000;
}

/**
 * פוסטים של ערוץ המייל שכבר בידי ה-HUB (external_id = מזהה הקמפיין) — שואל
 * את ה-HUB מה קרה איתם. publishing → published / failed לפי הסטטוס שם. גם
 * failed מהשבוע האחרון נבדק: ניוזלטר שסומן כנכשל כי ה-HUB לא ענה, ונשלח
 * בסוף — עובר ל-published, שהצלחה מאוחרת לא תלך לאיבוד. קמפיין שה-HUB
 * אומר שלא קיים (נמחק שם) — נכשל עם הסבר, לא נשאל לנצח. רץ בכל טיק; זול,
 * כי בדרך כלל אין אף פוסט במצב הזה.
 * @returns {Promise<Map<number, {hub:'active'|'draft'|'unreachable'|null, scheduled?:string|null}>>}
 *          מה ה-HUB ענה על כל פוסט ב-publishing — failStuckPublishing מחליט לפיו
 */
export async function pollNewsletterOutcomes(fetchImpl = fetch) {
  const state = new Map();
  if (!hubMailReady()) return state;
  const pending = await rows(
    `select p.id, p.title, p.channel_id, p.endpoint_id, p.kind, p.status, p.scheduled_at,
            p.external_id, p.hub_status, p.hub_polled_at, c.name as channel_name, c.platform
       from posts p
       join channels c on c.id = p.channel_id and c.platform = 'newsletter'
      where p.external_id is not null
        and (p.status = 'publishing'
             or (p.status = 'failed' and p.publishing_started_at >= now() - interval '7 days'))`
  );

  for (const post of pending) {
    if (!pollDue(post)) {
      // לא שואלים עכשיו — מה שה-HUB אמר בפעם האחרונה עדיין קובע לתקיעה
      if (post.status === 'publishing') {
        state.set(post.id, { hub: hubWaitState(post.hub_status), scheduled: null });
      }
      continue;
    }
    let s;
    try {
      // פוסט שכבר failed — בדיקה אחת בלי ניסיונות חוזרים, שלא יאט כל טיק כשה-HUB למטה
      s = await newsletterStatus(post.external_id, fetchImpl,
        post.status === 'failed' ? { delays: [] } : {});
    } catch (e) {
      if (hubNotFound(e)) {
        // הקמפיין לא קיים ב-HUB (נמחק שם) — אין למה לחכות
        if (post.status === 'publishing') {
          await saveHubStatus(post, 'missing');
          await failFromHub(post, HUB_MISSING_ERROR);
        }
        continue;
      }
      console.error(`בדיקת סטטוס ניוזלטר #${post.id} נכשלה:`, e.message);
      if (post.status === 'publishing') state.set(post.id, { hub: 'unreachable' });
      continue; // תקלה זמנית מול ה-HUB — ננסה שוב בטיק הבא
    }
    await saveHubStatus(post, s.status);

    if (s.status === 'sent') {
      const moved = await one(
        `update posts set status = 'published', published_at = now(), publish_error = null
          where id = $1 and status in ('publishing','failed') returning id`, [post.id]);
      if (!moved) continue;
      await query(
        `update tasks set done = true, done_at = now() where post_id = $1 and done = false`,
        [post.id]);
      await saveNewsletterMetrics(post.id, s.counts);
      await logActivity('publish', post, `הניוזלטר "${post.title}" נשלח דרך ה-HUB` +
        (post.status === 'failed' ? ' (אחרי שסומן כנכשל)' : ''));
      await emitPostEvent('post_published', post, { external_id: s.campaign_id ?? null });
      console.log(`ניוזלטר #${post.id} ("${post.title}") נשלח — עודכן ל-published`);
    } else if (post.status !== 'publishing') {
      continue; // כבר failed — רק הצלחה מאוחרת משנה משהו
    } else if (['failed', 'cancelled'].includes(s.status)) {
      await failFromHub(post,
        s.status === 'cancelled' ? 'הקמפיין בוטל בצד ה-HUB' : 'ה-HUB דיווח על כשל בשליחה');
    } else {
      // draft (ממתין לאישור) / scheduled / sending — עוד באוויר, בודקים שוב בטיק הבא
      state.set(post.id, { hub: hubWaitState(s.status), scheduled: s.scheduled_at ?? null });
    }
  }
  return state;
}

/**
 * רענון מדדים (delivered/opened/clicked) לניוזלטרים שכבר נשלחו — פתיחות
 * וקליקים ממשיכים להצטבר ימים אחרי השליחה. רץ פעם בשעה, שבוע אחורה.
 */
export async function refreshNewsletterMetrics() {
  if (!hubMailReady()) return;
  const recent = await rows(
    `select p.id, p.external_id from posts p
       join channels c on c.id = p.channel_id and c.platform = 'newsletter'
      where p.status = 'published' and p.external_id is not null
        and p.published_at >= now() - interval '7 days'`
  );

  for (const { id, external_id: ext } of recent) {
    try {
      const s = await newsletterStatus(ext);
      await saveNewsletterMetrics(id, s.counts);
    } catch (e) {
      console.error(`רענון מדדי ניוזלטר #${id} נכשל:`, e.message);
    }
  }
}
