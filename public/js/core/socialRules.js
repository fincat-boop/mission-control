/**
 * מה שאפשר להוסיף לגרסה מעבר לטקסט ולקבצים, לפי הפלטפורמה של הערוץ —
 * החלק הטהור (בלי DOM): אילו שדות, מה נשמר ב-meta, ומונה הכיתוב.
 *
 * גם השרת מייבא מכאן (src/publish/readiness.js): שם המגבלות חוסמות "מוכן"
 * ופרסום, כאן הן מונה ואזהרה בזמן הכתיבה — מקור אחד לשניהם.
 */

export const IG_LIMITS = { caption: 2200, hashtags: 30, mentions: 20, carousel: 10, alt: 1000 };

/** יחס רוחב/גובה שאינסטגרם מקבל לתמונה בפיד: 4:5 עד 1.91:1 */
export const IG_FEED_RATIO = { min: 0.8, max: 1.91 };

/** מפתחות ה-meta שהעורך מנהל. כל השאר (נושא ניוזלטר וכו') לא נוגעים */
export const EXTRA_KEYS = ['format', 'cover_asset_id', 'cover_offset_sec',
                           'first_comment', 'alt_text', 'link'];

/** אילו אזורים מופיעים בערוץ. ערוץ בלי פלטפורמה (ידני, וואטסאפ) — אף אחד */
export function extrasFor(platform) {
  if (platform === 'instagram') return ['format', 'cover', 'first_comment', 'alt_text'];
  if (platform === 'facebook') return ['link', 'first_comment', 'alt_text'];
  return [];
}

export const countHashtags = (s) => (String(s ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
export const countMentions = (s) =>
  (String(s ?? '').match(/(?:^|[^\p{L}\p{N}_])@[\p{L}\p{N}_.]+/gu) ?? []).length;

/** רק השדות של העורך, בלי ערכים ריקים — להשוואה ("השתנה?") ולשמירה */
export function pickExtras(meta) {
  const out = {};
  for (const k of EXTRA_KEYS) {
    const v = meta?.[k];
    if (v == null || (typeof v === 'string' && !v.trim())) continue;
    if (k === 'format' && v !== 'story') continue;
    if (k === 'cover_offset_sec' && !(Number(v) > 0)) continue;
    out[k] = v;
  }
  return out;
}

export const extrasKey = (meta) => JSON.stringify(pickExtras(meta));

/** ה-meta לשמירה: מה שהיה (שדות של אחרים נשמרים) + השדות של העורך */
export function mergeExtras(meta, extras) {
  const out = { ...(meta ?? {}) };
  for (const k of EXTRA_KEYS) delete out[k];
  return { ...out, ...pickExtras(extras) };
}

/**
 * מונה הכיתוב באינסטגרם: [{text, over}] — תווים, האשטגים, ותיוגים רק
 * כשיש. over = חורג מהמגבלה (הפרסום יידחה).
 */
export function captionCounts(text) {
  const t = String(text ?? '').trim();
  // "מתוך" ולא "/" — בטקסט מימין לשמאל הלוכסן הופך את סדר המספרים
  const out = [{ text: `${t.length.toLocaleString('he-IL')} מתוך ${IG_LIMITS.caption.toLocaleString('he-IL')} תווים`,
                 over: t.length > IG_LIMITS.caption }];
  const tags = countHashtags(t);
  if (tags) out.push({ text: `${tags} מתוך ${IG_LIMITS.hashtags} האשטגים`, over: tags > IG_LIMITS.hashtags });
  const at = countMentions(t);
  if (at) out.push({ text: `${at} מתוך ${IG_LIMITS.mentions} תיוגים`, over: at > IG_LIMITS.mentions });
  return out;
}

/** תמונה ביחס שאינסטגרם לא מקבל בפיד? width/height בפיקסלים */
export const badFeedRatio = (w, h) =>
  !!(w && h) && (w / h < IG_FEED_RATIO.min - 0.005 || w / h > IG_FEED_RATIO.max + 0.005);

const short = (s, n = 40) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * שורת הסיכום של אזור מקופל: {text, set}. set=false — לא הוגדר (מוצג
 * באפור). files — הקבצים של הגרסה ({id, filename}), לשם של תמונת השער.
 */
export function extraSummary(key, meta, files = []) {
  const m = meta ?? {};
  if (key === 'format') {
    return m.format === 'story'
      ? { text: 'סטורי', set: true }
      : { text: 'פוסט רגיל — ריל או קרוסלה לפי הקבצים', set: false };
  }
  if (key === 'cover') {
    if (m.format === 'story') return { text: 'אין שער בסטורי', set: false };
    if (!files.some((a) => /^video\//.test(a.mime ?? ''))) return { text: 'רק לפוסט עם סרטון', set: false };
    const f = m.cover_asset_id && files.find((a) => a.id === Number(m.cover_asset_id));
    if (f) return { text: f.filename, set: true };
    if (Number(m.cover_offset_sec) > 0) return { text: `פריים משנייה ${m.cover_offset_sec}`, set: true };
    return { text: 'הפריים הראשון של הסרטון', set: false };
  }
  if (key === 'link') {
    try {
      return m.link ? { text: new URL(m.link).hostname, set: true } : { text: 'אין', set: false };
    } catch {
      return { text: 'קישור לא תקין', set: true };
    }
  }
  const v = key === 'first_comment' ? m.first_comment : m.alt_text;
  return v?.trim() ? { text: short(v), set: true } : { text: 'אין', set: false };
}
