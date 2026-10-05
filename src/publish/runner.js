import { currentOrg, one, query, rows } from '../db.js';
import { isPlatformOrg } from '../platform.js';
import { decryptSecret } from './crypto.js';
import { publishFacebook, publishInstagram } from './meta.js';
import { deletePublicAssets, publicAssetsReady, uploadPublicAsset } from './public-assets.js';
import { mediaUrl } from '../media.js';
import { HubMailError, createNewsletter, hubCampaignUrl, hubMailReady, newsletterStatus } from '../hub-mail.js';
import { emitHubEventSafe, postEventInput } from '../hub-events.js';
import { friendlyPublishError } from './errors.js';
import { itemAssetsSql } from '../links.js';
import {
  HUB_MISSING_ERROR, NOT_APPROVED_ERROR, NOT_TRANSFERRED_ERROR, alreadyTransferred,
  cleanFieldValues, hubWaitState, newsletterBlocker, newsletterClockStart, newsletterDigest,
  nextHubRef, reusableHubStatus, transferBlocker,
} from './newsletter.js';

/**
 * מסלול הפרסום האוטומטי.
 *
 * publishTick רץ כל דקה (server.js), לכל ארגון בנפרד:
 *   פוסט בסטטוס approved שהגיע זמנו → publishing → קריאת API → published.
 *   כשל → failed + משימה דחופה. שום דבר לא נעלם בשקט — הכול נרשם
 *   ב-publish_log וביומן הפעולות.
 *
 * וואטסאפ (קבוצה) — אין API רשמי, ולכן חצי-אוטומטי: כשמגיע הזמן נוצרת
 * משימה דחופה עם הטקסט המוכן, והמשתמש שולח ומסמן "פורסם" בעצמו.
 *
 * ניוזלטר — לא נשלח מכאן ולא נוצר מכאן ב-HUB. המשתמש לוחץ "העבר ל-HUB"
 * (transferNewsletter), בעל העסק מאשר שם, והטיק רק שואל על הסטטוס. הגיע
 * המועד ולא הועבר — משימה (newsletterNotTransferred), לא שליחה.
 */

const MAX_LATE_HOURS = 12;   // approved שפוספס ביותר מזה — נכשל, לא מתפרסם באיחור
const WA_AHEAD_MINUTES = 15; // כמה דקות לפני הזמן נוצרת משימת הוואטסאפ

export const STUCK_SOCIAL_MINUTES = 30;   // פייסבוק/אינסטגרם ב-publishing יותר מזה — נקטע
export const STUCK_NEWSLETTER_HOURS = 24; // ניוזלטר שה-HUB לא ענה עליו / לא קיבל תוך יממה
export const STUCK_NEWSLETTER_CAP_HOURS = 72; // ניוזלטר שה-HUB עוד "שולח" אחרי 3 ימים

export const TOO_LATE_ERROR =
  'המועד עבר מזמן — הפרסום לא בוצע כדי לא להפתיע. משבצים מחדש או מפרסמים ידנית.';
export const STUCK_SOCIAL_ERROR =
  'הפרסום נקטע באמצע — בודקים בעמוד אם הפוסט עלה, ואז מסמנים פורסם או מפרסמים שוב';
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
 * כתיבה "על הדרך" בתוך טרנזקציית הטיק. catch רגיל לא מספיק: שגיאת SQL
 * מבטלת את כל הטרנזקציה, ואז גם הפרסום שאחריה נכשל, וה-commit מגלגל
 * אחורה פוסטים שכבר יצאו (והם יוצאים שוב בטיק הבא). savepoint תוחם את
 * הכישלון לכתיבה הזו בלבד.
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
export async function failPost(post, err, { title, from = null, notify = true, internal = false } = {}) {
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
  if (notify) {
    await emitPostEvent('post_publish_failed', post, { error: message, who },
      { attempt: attempt ?? Date.now(), email: await ownerEmail() });
  }
  await recordFailedTask(post, title, message, who);
  return { ok: false, error: message };
}

/** הפוסט + הערוץ + החיבור + הגרסה + הקבצים — כל מה שצריך לפרסום אחד */
export async function loadPayload(postId) {
  const post = await one(
    `select p.*, c.name as channel_name, c.platform,
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
  // ניוזלטר: השליחה בפועל דרך ה-HUB — נדרשים חיבור, תוכן ונושא (newsletter.js)
  if (post.platform === 'newsletter') return newsletterBlocker({ post, variant }, hubMailReady());

  if (!['facebook', 'instagram'].includes(post.platform)) {
    return `הערוץ "${post.channel_name}" לא מחובר לפרסום אוטומטי (${post.platform === 'whatsapp' ? 'וואטסאפ נשלח ידנית' : 'אין אינטגרציה'})`;
  }
  if (!post.access_token_enc) return 'אין חיבור פעיל לערוץ — מגדירים בניהול → ערוצי פרסום';
  if (post.platform === 'facebook' && !post.page_id) return 'חסר מזהה עמוד פייסבוק בחיבור';
  if (post.platform === 'instagram' && !post.ig_user_id) return 'חסר מזהה חשבון אינסטגרם בחיבור';
  if (!post.content_id) return 'אין תוכן משויך לפוסט';
  if (!variant || variant.status !== 'ready') return 'הגרסה לערוץ הזה עוד לא מסומנת "מוכן"';

  const media = assets.filter((a) => isImage(a.mime) || isVideo(a.mime));
  if (post.platform === 'instagram') {
    if (!media.length) return 'אינסטגרם דורש תמונה או וידאו — אין מדיה לפוסט';
    if (!publicAssetsReady()) return 'הגשת מדיה ציבורית לא מוגדרת (R2_PUBLIC_*) — נדרשת לאינסטגרם';
  }
  if (post.platform === 'facebook' && !media.length && !variant.body?.trim()) {
    return 'אין טקסט ואין מדיה — אין מה לפרסם';
  }
  if (media.some((a) => a.storage_key && !mediaUrl(a.storage_key))) {
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
export async function publishInstagramPost({ post, token, text, media }, deps = {}) {
  const {
    upload = uploadPublicAsset, remove = deletePublicAssets, publish = publishInstagram,
  } = deps;
  const tempKeys = [];
  try {
    const items = [];
    for (const a of media) {
      if (a.storage_key) {
        items.push({ url: mediaUrl(a.storage_key), video: isVideo(a.mime) });
        continue;
      }
      const { url, key } = await upload({ buffer: a.data, mime: a.mime, filename: a.filename });
      tempKeys.push(key);
      items.push({ url, video: isVideo(a.mime) });
    }
    return await publish({ igUserId: post.ig_user_id, token, caption: text, media: items });
  } finally {
    if (tempKeys.length) await remove(tempKeys);
  }
}

/**
 * פרסום פוסט אחד, מקצה לקצה. allowedFrom קובע מאילו סטטוסים מותר
 * לתפוס אותו (הטיק תופס רק approved; "פרסם עכשיו" גם scheduled/failed).
 * @returns {{ok: boolean, post?: object, error?: string}}
 */
export async function publishOne(postId, { allowedFrom = ['approved'] } = {}) {
  // תפיסה אטומית: רק מי שהצליח להעביר ל-publishing ממשיך — בלי פרסום כפול
  // publishing_started_at — לזיהוי פרסום שנתקע באמצע (failStuckPublishing)
  const claimed = await one(
    `update posts set status = 'publishing', publishing_started_at = now()
      where id = $1 and status = any($2) returning id`,
    [postId, allowedFrom]
  );
  if (!claimed) return { ok: false, error: 'הפוסט לא במצב שמאפשר פרסום' };

  const fail = async (post, error) => {
    if (post) {
      return (await failPost(post, error, { title: `פרסום אוטומטי נכשל — ${post.channel_name}` })) ??
        { ok: false, error: friendlyPublishError(error, { platform: post.platform }).message };
    }
    // בלי פרטי הפוסט (השליפה עצמה נכשלה) — רק הסטטוס, אין למי לשייך משימה
    const { message } = friendlyPublishError(error);
    await query(`update posts set status = 'failed', publish_error = $2 where id = $1`, [postId, message]);
    return { ok: false, error: message };
  };

  let payload;
  try {
    payload = await loadPayload(postId);
  } catch (e) {
    return fail(null, `שליפת נתוני הפוסט נכשלה: ${e.message}`);
  }
  if (!payload) return fail(null, 'הפוסט נעלם');

  const { post, variant, assets } = payload;
  const blocker = publishBlocker(payload);
  if (blocker) return fail(post, blocker);

  const media = assets.filter((a) => isImage(a.mime) || isVideo(a.mime));
  const text = variant.body?.trim() ?? '';

  try {
    let result;
    if (post.platform === 'newsletter') {
      // ניוזלטר לא נוצר ב-HUB מכאן לעולם — רק "העבר ל-HUB" (transferNewsletter)
      // יוצר, ושם בעל העסק מאשר. פוסט שהגיע לכאן לא הועבר: כשל עם הסבר.
      return (await failPost(post, NOT_TRANSFERRED_ERROR, {
        title: `ניוזלטר לא הועבר ל-HUB — ${post.channel_name}`, internal: true,
      })) ?? { ok: false, error: NOT_TRANSFERRED_ERROR };
    } else if (post.platform === 'facebook') {
      const token = decryptToken(post);
      if (!token) return fail(post, 'פענוח הטוקן נכשל — מזינים אותו מחדש בהגדרות הערוץ');
      result = await publishFacebook({
        pageId: post.page_id, token, message: text, assets: facebookAssets(media),
      });
    } else {
      // אינסטגרם מושך מ-URL ציבורי — ראו publishInstagramPost
      const token = decryptToken(post);
      if (!token) return fail(post, 'פענוח הטוקן נכשל — מזינים אותו מחדש בהגדרות הערוץ');
      result = await publishInstagramPost({ post, token, text, media });
    }

    const updated = await one(
      `update posts set status = 'published', published_at = now(),
              external_id = $2, external_url = $3, publish_error = null
        where id = $1 returning *`,
      [post.id, result.id, result.url]
    );
    await query(
      `update tasks set done = true, done_at = now() where post_id = $1 and done = false`,
      [post.id]);
    await logPublish(post, true, { externalId: result.id });
    await logActivity('publish', post, `פורסם אוטומטית — "${post.title}" ל${post.channel_name}`);
    await emitPostEvent('post_published', post,
      { external_id: result.id, ...(result.url ? { external_url: result.url } : {}) });
    console.log(`פורסם אוטומטית: פוסט #${post.id} ("${post.title}") ל${post.channel_name}`);
    return { ok: true, post: updated };
  } catch (e) {
    // השגיאה עצמה (עם code/status) — friendlyPublishError מתרגם לפיה
    return fail(post, e);
  }
}

/** הטיק לארגון אחד: מפרסם את מה שאושר והגיע זמנו, ומכין משימות וואטסאפ */
export async function publishTickForOrg() {
  // סגירת ניוזלטרים שכבר נשלחו ל-HUB רצה גם כשמתג-העל כבוי — היא משלימה
  // פעולה שכבר אושרה ויצאה, לא מתחילה חדשה.
  const hubState = (await bestEffort('בדיקת סטטוס ניוזלטרים נכשלה:', pollNewsletterOutcomes)) ??
    new Map();

  // פרסום שנתקע ב-publishing (תהליך שנפל באמצע, ניוזלטר שה-HUB לא סגר) —
  // גם כשהמתג כבוי: זה פוסט שכבר יצא לדרך, לא פרסום חדש. לניוזלטר — לפי
  // מה שה-HUB ענה בבדיקה של הטיק הזה (hubState)
  await bestEffort('סגירת פרסומים תקועים נכשלה:', () => failStuckPublishing(new Date(), hubState));

  // וואטסאפ נשלח ידנית — המשימה שלו לא תלויה במתג הפרסום האוטומטי
  await bestEffort('הכנת משימות וואטסאפ נכשלה:', whatsappPrep);

  // ניוזלטר שהגיע מועדו ולא הועבר ל-HUB — משימה, לא שליחה (וגם לא תלוי
  // במתג: שום דבר לא יוצא מכאן)
  await bestEffort('בדיקת ניוזלטרים שלא הועברו נכשלה:', newsletterNotTransferred);

  const settings = await one('select autopublish_enabled from engine_settings limit 1');
  if (!settings?.autopublish_enabled) return;

  // פוסטים שאושרו והגיע זמנם. איחור גדול מדי לא מתפרסם — נכשל עם הסבר.
  // קמפיין מושהה לא יוצא — גם פוסט שאושר לפני ההשהיה (הלוח כבר מסתיר אותו).
  // ניוזלטר לא כאן: הוא לא נשלח מהטיק (newsletterNotTransferred / transferNewsletter).
  const due = await rows(
    `select p.id, p.scheduled_at < now() - ($1 || ' hours')::interval as too_late
       from posts p
       join channels c on c.id = p.channel_id and c.active
       left join channel_connections cc on cc.channel_id = c.id
      where p.status = 'approved' and p.scheduled_at <= now()
        and cc.auto_enabled = true and c.platform <> 'newsletter'
        and not exists (select 1 from content_items ci
                          join campaigns ca on ca.id = ci.campaign_id
                         where ci.id = p.content_id and ca.paused_at is not null)
      order by p.scheduled_at`,
    [MAX_LATE_HOURS]
  );

  for (const { id, too_late } of due) {
    if (too_late) {
      // אותו מסלול כשל כמו כל השאר: משימה, publish_log, יומן ואירוע ל-HUB
      await bestEffort(`סימון פוסט #${id} שאיחר כנכשל נכשל:`, async () => {
        const post = await loadPostBrief(id);
        if (post) {
          await failPost(post, TOO_LATE_ERROR, {
            title: `פרסום אוטומטי לא בוצע — ${post.channel_name}`, from: ['approved'], internal: true,
          });
        }
      });
      continue;
    }
    await publishOne(id).catch((e) => console.error(`פרסום פוסט #${id} נכשל:`, e.message));
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
 */
export function stuckPublishingError({ platform, started, scheduled = null, hub = null }, now = new Date()) {
  if (!started) return null;
  if (platform === 'newsletter') {
    const from = newsletterClockStart({ started, scheduled });
    const age = now.getTime() - from.getTime();
    if (age > STUCK_NEWSLETTER_CAP_HOURS * 3600000) return STUCK_NEWSLETTER_CAP_ERROR;
    if (hub === 'active') return null;
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
            p.publishing_started_at as started, p.scheduled_at
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
      scheduled: h?.scheduled ?? s.scheduled_at, hub: h?.hub ?? null,
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

/** מחזיר { post } או { error } (פרסום שהתחיל לפני פחות מ-RESET_MIN_MS) או null */
export async function resetPublishing(postId, user) {
  const post = await loadPostBrief(postId);
  if (!post || post.status !== 'publishing') return null;
  const started = await one('select publishing_started_at from posts where id = $1', [postId]);
  if (resetTooSoon(started?.publishing_started_at)) return { error: RESET_TOO_SOON };
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

/**
 * מה לעשות עם משימת הוואטסאפ של פוסט אחד: 'insert' — אין עדיין משימה;
 * 'update' — יש משימה פתוחה, אבל מצב המוכנות של הטקסט השתנה מאז שנוצרה
 * (הכותרת המשנית שלה כבר לא נכונה); null — אין מה לעשות. משימה שנסגרה
 * לא נפתחת מחדש: פעם אחת לכל פוסט.
 */
export function waTaskAction({ ready, task_id, task_done, task_ready }) {
  if (task_id == null) return 'insert';
  if (task_done) return null;
  return task_ready === ready ? null : 'update';
}

/**
 * וואטסאפ חצי-אוטומטי: קצת לפני הזמן נוצרת משימת "לשלוח בוואטסאפ"
 * דחופה. גם כשהטקסט עוד לא מוכן — אחרת הפוסט פשוט עובר בשקט; אז המשימה
 * אומרת להשלים אותו קודם. הטקסט להעתקה נשלף חי ב-GET /tasks (copy_text),
 * כך שתיקון בגרסה אחרי יצירת המשימה מגיע גם לכפתור.
 * due_on — התאריך המקומי של המועד, לא UTC (פוסט ב-01:00 שייך ליום שלו).
 */
async function whatsappPrep() {
  const due = await rows(
    `select p.id, p.title, p.endpoint_id, p.assignee_id,
            (p.scheduled_at at time zone 'Asia/Jerusalem')::date as due_on,
            coalesce(v.status = 'ready', false) as ready, v.body,
            t.id as task_id, t.done as task_done,
            (t.meta->>'wa_ready')::boolean as task_ready
       from posts p
       join channels c on c.id = p.channel_id and c.platform = 'whatsapp' and c.active
       left join content_variants v on v.content_id = p.content_id
            and v.channel_id = p.channel_id
       left join lateral (
         select t.id, t.done, t.meta from tasks t
          where t.post_id = p.id and t.kind = 'publish' and (t.meta->>'wa_send') = 'true'
          order by t.done, t.id desc limit 1
       ) t on true
      where p.status = 'scheduled'
        and not exists (select 1 from content_items ci
                          join campaigns ca on ca.id = ci.campaign_id
                         where ci.id = p.content_id and ca.paused_at is not null)
        and p.scheduled_at between now() - interval '24 hours'
                               and now() + ($1 || ' minutes')::interval`,
    [WA_AHEAD_MINUTES]
  );

  for (const p of due) {
    const action = waTaskAction(p);
    const subtitle = p.ready ? WA_SUB_READY : WA_SUB_NOT_READY;
    if (action === 'insert') {
      await query(
        `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on, meta, assignee_id)
         values ($1,$2,'publish',$3,$4,true,$5,$6,$7)`,
        [`לשלוח בוואטסאפ: ${p.title}`, subtitle, p.id, p.endpoint_id, p.due_on,
         JSON.stringify({
           wa_send: true, wa_ready: p.ready, body: p.ready ? p.body : null,
           // האחראי של הפוסט שולח — פעם אחת (task-lifecycle.js autoAssignee)
           ...(p.assignee_id ? { assignee_auto: true } : {}),
         }),
         p.assignee_id ?? null]
      );
      console.log(`נוצרה משימת וואטסאפ לפוסט #${p.id} ("${p.title}")${p.ready ? '' : ' — הטקסט עוד לא מוכן'}`);
    } else if (action === 'update') {
      await query(
        `update tasks set subtitle = $2,
                meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('wa_ready', $3::boolean)
          where id = $1 and done = false`,
        [p.task_id, subtitle, p.ready]
      );
    }
  }
}

/* ========================= ניוזלטר: העברה ל-HUB ========================= */

/** כמה אחורה מחפשים ניוזלטר שהמועד שלו הגיע ולא הועבר — לא מציפים פוסטים ישנים */
export const NOT_TRANSFERRED_WINDOW_HOURS = 24;

/**
 * ניוזלטר (מתוכנן או מאושר) שהמועד שלו הגיע ולא הועבר ל-HUB: עובר ל"נכשל"
 * עם משימה דחופה — "ניוזלטר לא הועבר ל-HUB". לא שולחים ולא יוצרים כלום ב-HUB.
 * רק מהיממה האחרונה, כדי שפוסטים ישנים שנשארו "מתוכנן" לא יציפו משימות.
 */
async function newsletterNotTransferred() {
  const due = await rows(
    `select p.id from posts p
       join channels c on c.id = p.channel_id and c.active and c.platform = 'newsletter'
      where p.status in ('scheduled', 'approved')
        and p.scheduled_at <= now()
        and p.scheduled_at > now() - ($1 || ' hours')::interval
        and not exists (select 1 from content_items ci
                          join campaigns ca on ca.id = ci.campaign_id
                         where ci.id = p.content_id and ca.paused_at is not null)
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
    [post.id, r.campaign_id, hubCampaignUrl(r.campaign_id), r.status ?? 'draft', ref,
     reuse ? null : newsletterDigest(payload), user?.id ?? null]
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
  return { post: updated, reused: !!reuse };
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

/** הסטטוס האחרון שה-HUB דיווח — לתצוגה בלוח ("ממתין לאישור ב-HUB") */
async function saveHubStatus(post, status) {
  if (status === post.hub_status) return;
  await bestEffort(`שמירת סטטוס ה-HUB לפוסט #${post.id} נכשלה:`, () =>
    query('update posts set hub_status = $2 where id = $1', [post.id, status]));
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
    `select p.id, p.title, p.channel_id, p.endpoint_id, p.kind, p.status,
            p.external_id, p.hub_status, c.name as channel_name, c.platform
       from posts p
       join channels c on c.id = p.channel_id and c.platform = 'newsletter'
      where p.external_id is not null
        and (p.status = 'publishing'
             or (p.status = 'failed' and p.publishing_started_at >= now() - interval '7 days'))`
  );

  for (const post of pending) {
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
