/**
 * "מוכן" של גרסה — כללי התוכן בלבד, בלי DB ובלי חיבורים.
 *
 * מקור אחד לשני מקומות שחייבים להסכים: publishBlocker (runner.js) — מה
 * חוסם פרסום אוטומטי בפועל — וסימון "מוכן" בעריכת הגרסה (נתיבי התוכן,
 * הייבוא, והתא "מוכן ⚠" ברשת הקמפיין). אם הסימון מאשר מה שהפרסום ידחה,
 * הפוסט נכשל רק ביום הפרסום, כשכבר מאוחר.
 *
 * מה לא כאן (נשאר ב-publishBlocker): חיבור לערוץ, טוקן, מזהי עמוד, הגדרות
 * R2 בשרת — אלה מצב של המערכת, לא של התוכן שהמשתמש כתב.
 */

import { newsletterContentBlocker } from './newsletter.js';
import { IG_LIMITS, countHashtags, countMentions } from '../../public/js/core/socialRules.js';

const isMedia = (m) => /^(image|video)\//.test(m ?? '');
const isVideo = (m) => /^video\//.test(m ?? '');

/*
 * מה שאפשר להוסיף לגרסה מעבר לטקסט ולקבצים — יושב ב-content_variants.meta
 * (אותו jsonb של נושא הניוזלטר), ומשוכפל עם שאר ה-meta למשבצות מקושרות:
 *   format          'story' = סטורי (אינסטגרם). אחרת פוסט/ריל/קרוסלה לפי הקבצים
 *   cover_asset_id  תמונה מהקבצים שמשמשת שער לריל — ולא יוצאת כפריט בפוסט
 *   cover_offset_sec שער לריל מתוך הסרטון: השנייה שממנה לוקחים את הפריים
 *   first_comment   תגובה ראשונה שנכתבת מיד אחרי הפרסום (פייסבוק/אינסטגרם)
 *   alt_text        תיאור תמונה לקוראי מסך — לפוסט עם תמונה בודדת
 *   link            פייסבוק: קישור עם כרטיס תצוגה מקדימה
 * המגבלות של אינסטגרם (מהתיעוד של Graph API, IG User Media) והמונים —
 * משותפים עם העורך בדפדפן (public/js/core/socialRules.js): שם מונה, כאן חסימה.
 */
/** קישור תקין לפרסום: כתובת מלאה ב-http/https */
export function validLink(s) {
  try {
    const u = new URL(String(s ?? '').trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.');
  } catch {
    return false;
  }
}

export const isStory = (variant) => variant?.meta?.format === 'story';

/**
 * בדיקת השדות הנוספים בשמירה (לא רק ב"מוכן"): הקישור מוצג אחר כך כקישור
 * לחיץ בתצוגת הפוסט — רק http/https נכנס. null = תקין.
 */
export function metaExtrasError(meta) {
  if (meta == null) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) return 'meta לא תקין';
  const { format, cover_asset_id: cover, cover_offset_sec: sec, first_comment: c,
          alt_text: alt, link } = meta;
  if (format != null && format !== 'story') return 'סוג פרסום לא מוכר';
  if (cover != null && !Number.isInteger(cover)) return 'תמונת השער לא תקינה';
  if (sec != null && !(Number.isFinite(sec) && sec >= 0 && sec <= 900)) {
    return 'השנייה של השער צריכה להיות מספר בין 0 ל-900';
  }
  for (const [v, name, max] of [[c, 'התגובה הראשונה', IG_LIMITS.caption], [alt, 'תיאור התמונה', IG_LIMITS.alt]]) {
    if (v != null && typeof v !== 'string') return `${name} לא תקין`;
    if (v != null && v.length > max) return `${name} ארוך מדי — עד ${max.toLocaleString('he-IL')} תווים`;
  }
  if (link != null && (typeof link !== 'string' || (link.trim() && !validLink(link)))) {
    return 'הקישור לא תקין — צריך כתובת מלאה שמתחילה ב-https://';
  }
  return null;
}

/**
 * הקבצים שיוצאים בפוסט עצמו: תמונה ווידאו, בלי תמונת השער של הריל. השער
 * מוצא רק כשיש וידאו — בלי וידאו אין ריל, והתמונה היא תוכן רגיל.
 */
export function postMedia({ variant, assets = [] }) {
  const media = assets.filter((a) => isMedia(a.mime));
  const coverId = Number(variant?.meta?.cover_asset_id) || null;
  if (!coverId || !media.some((a) => isVideo(a.mime))) return media;
  return media.filter((a) => a.id !== coverId);
}

/** תמונת השער של הריל מתוך הקבצים, אם נבחרה ויש וידאו. אחרת null. */
export function coverAsset({ variant, assets = [] }) {
  const coverId = Number(variant?.meta?.cover_asset_id) || null;
  if (!coverId || !assets.some((a) => isVideo(a.mime))) return null;
  return assets.find((a) => a.id === coverId && /^image\//.test(a.mime)) ?? null;
}

/** מה חוסם באינסטגרם — מגבלות שה-API דוחה עליהן */
function instagramBlocker(v, text, media) {
  if (!media.length) return 'אינסטגרם דורש תמונה או וידאו — אין מדיה לפוסט';
  if (isStory(v)) {
    if (media.length > 1) return `סטורי יוצא עם תמונה או סרטון אחד — יש ${media.length} קבצים`;
  } else {
    if (media.length > IG_LIMITS.carousel) {
      return `קרוסלה באינסטגרם עד ${IG_LIMITS.carousel} קבצים — יש ${media.length}`;
    }
    if (text.length > IG_LIMITS.caption) {
      return `הכיתוב ארוך מדי לאינסטגרם — ${text.length} תווים מתוך ${IG_LIMITS.caption}`;
    }
    const tags = countHashtags(text);
    if (tags > IG_LIMITS.hashtags) return `יותר מדי האשטגים לאינסטגרם — ${tags} מתוך ${IG_LIMITS.hashtags}`;
    const at = countMentions(text);
    if (at > IG_LIMITS.mentions) return `יותר מדי תיוגים (@) לאינסטגרם — ${at} מתוך ${IG_LIMITS.mentions}`;
  }
  return null;
}

/**
 * מה חסר בתוכן של גרסה כדי שתצא בערוץ הזה? null = שום דבר.
 * @param {{platform:string, variant:{body?:string, meta?:object}|null,
 *          assets?:{id?:number, mime:string}[]}} p assets — הקבצים שהגרסה תצא איתם
 *          (משותפים לזווית + של הגרסה, ובמשבצת מקושרת — של המקור)
 */
export function contentBlocker({ platform, variant, assets = [] }) {
  const v = variant ?? {};
  const text = String(v.body ?? '').trim();

  // ניוזלטר: כלל אחד עם ההעברה ל-HUB — נושא + (גוף או ערך שמולא בעורך ה-HUB)
  if (platform === 'newsletter') return newsletterContentBlocker(v);

  const m = v.meta ?? {};
  if (String(m.alt_text ?? '').length > IG_LIMITS.alt) {
    return `תיאור התמונה ארוך מדי — עד ${IG_LIMITS.alt} תווים`;
  }

  const media = postMedia({ variant: v, assets });
  if (platform === 'instagram') return instagramBlocker(v, text, media);

  // קישור נפרד יוצא רק בפייסבוק — בוואטסאפ/ידני הוא לא חלק מהטקסט
  const link = platform === 'facebook' ? String(m.link ?? '').trim() : '';
  if (link && !validLink(link)) return 'הקישור לא תקין — צריך כתובת מלאה שמתחילה ב-https://';
  if (!media.length && !text && !link) return 'אין טקסט ואין מדיה — אין מה לפרסם';
  return null;
}

/** ההודעה למשתמש כשהסימון "מוכן" נדחה */
export const readyRejection = (reason) => `אי אפשר לסמן "מוכן": ${reason}`;
