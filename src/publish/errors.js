/**
 * הודעות כשל פרסום שבן אדם מבין: מה קרה + מה עושים. מה שנשמר על הפוסט
 * ועל משימת הכשל (ומגיע במייל דרך ה-HUB) הוא ההודעה הזו; השגיאה הגולמית
 * — שם משתנה סביבה, "Graph API 400", הודעה באנגלית ממטא — נשארת ב-
 * publish_log, למפתח.
 *
 * who: מי צריך לפעול — 'owner' (מי שמנהל את הלוח) או 'developer'
 * (הגדרה בשרת, מפתח חיבור — שום כפתור במסך לא יפתור את זה).
 *
 * טהורה — בלי DB ובלי רשת, ולכן נבדקת בטסטים (test/publish-errors.test.js).
 */

const PLATFORM_HE = { facebook: 'פייסבוק', instagram: 'אינסטגרם', newsletter: 'ה-HUB' };

const META_TOKEN = [190, 102, 2500];
const META_PERMISSION = [3, 10, 200, 210, 220, 230, 270, 299];
const META_RATE = [4, 17, 32, 341, 613, 80001, 80002, 80004, 80005, 80006, 80008];
const META_POLICY = [368, 1346003];
const META_MEDIA = [9004, 324, 352];
const META_MEDIA_SUB = [2207003, 2207004, 2207005, 2207026, 2207052, 2207053];
const META_TEMPORARY = [1, 2];

const RECONNECT = 'מחברים מחדש בניהול → ערוצי פרסום, ואז מפרסמים שוב';
const RAW_MAX = 200;

const rawOf = (err) => String(typeof err === 'string' ? err : err?.message ?? err ?? '').trim();
const hasHebrew = (s) => /[\u0590-\u05FF]/.test(s);
// "מילה" לטינית של 4 אותיות ומעלה — סימן לטקסט טכני/אנגלי ולא להודעה שלנו
const hasLatinWords = (s) => /[A-Za-z]{4,}/.test(s);
// שם משתנה סביבה: HUB_API_URL, R2_PUBLIC_BASE_URL, R2_PUBLIC_* ...
const ENV_VAR = /\b[A-Z][A-Z0-9]*_[A-Z0-9_*]+\b/;

function configTopic(raw) {
  if (/HUB_/.test(raw)) return 'החיבור ל-HUB';
  if (/R2_/.test(raw)) return 'אחסון המדיה';
  return 'הגדרות השרת';
}

/**
 * @param {Error|string} err — שגיאה (עם code/subcode של Graph, או status של
 *        HubMailError) או טקסט שגיאה
 * @param {{platform?: string}} ctx — הפלטפורמה, לניסוח ("פייסבוק"/"אינסטגרם")
 * @returns {{message: string, who: 'owner'|'developer'}}
 */
export function friendlyPublishError(err, { platform } = {}) {
  const raw = rawOf(err);
  const code = Number(err?.code);
  const sub = Number(err?.subcode ?? err?.error_subcode);
  const status = Number(err?.status);
  const where = PLATFORM_HE[platform] ?? 'הרשת';
  const meta = platform === 'facebook' || platform === 'instagram' ? where : 'מטא';

  // הגדרה חסרה בשרת — רק המפתח יכול לתקן
  if (ENV_VAR.test(raw)) {
    return {
      who: 'developer',
      message: `חסרה הגדרה בשרת (${configTopic(raw)}), ולכן הפרסום לא יצא. ` +
        'זה בטיפול המפתח — מעבירים לו את ההודעה הזו, ואחרי התיקון מפרסמים שוב.',
    };
  }

  // ה-HUB (ניוזלטר)
  const hubStatus = err?.name === 'HubMailError' ? status
    : Number(raw.match(/שגיאת HUB \((\d{3})\)/)?.[1] ?? NaN);
  if (hubStatus === 401 || hubStatus === 403) {
    return {
      who: 'developer',
      message: 'ה-HUB דחה את מפתח החיבור של המערכת. זה בטיפול המפתח — מעבירים לו את ההודעה הזו.',
    };
  }
  // סירוב מנומק של ה-HUB (חוק הספאם, מכסה, preflight) — ההודעה שלו בעברית, כמו שהיא
  if (err?.name === 'HubMailError' && hubStatus >= 400 && hubStatus < 500) {
    return { who: 'owner', message: `ה-HUB סירב לשלוח: ${raw}` };
  }
  if (hubStatus >= 500 || /ה-HUB לא זמין/.test(raw)) {
    return {
      who: 'owner',
      message: 'ה-HUB לא זמין כרגע (תקלה זמנית אצלו). מנסים שוב מאוחר יותר — "פרסם עכשיו" בחלון הפוסט.',
    };
  }

  // מטא (פייסבוק / אינסטגרם) — לפי קוד השגיאה, ואם אין קוד — לפי הטקסט
  if (META_TOKEN.includes(code) || /access token|session has expired|OAuthException/i.test(raw)) {
    return { who: 'owner', message: `החיבור ל${meta} פג או בוטל. ${RECONNECT}.` };
  }
  if (META_PERMISSION.includes(code) || (code >= 200 && code <= 299) || /permission/i.test(raw)) {
    return {
      who: 'owner',
      message: `לחשבון המחובר ל${meta} חסרה הרשאה לפרסם. ${RECONNECT} ומאשרים את כל ההרשאות שמטא מבקשת.`,
    };
  }
  if (META_RATE.includes(code) || /rate limit|too many|request limit/i.test(raw)) {
    return {
      who: 'owner',
      message: `${meta} הגבילה זמנית את מספר הפעולות. מחכים כשעה ומפרסמים שוב.`,
    };
  }
  if (META_POLICY.includes(code) || /policy|abusive|spam|community standards/i.test(raw)) {
    return {
      who: 'owner',
      message: `${meta} חסמה את הפוסט בגלל מדיניות התוכן שלה (או חשד לספאם). ` +
        'בודקים את הטקסט והקישורים, מתקנים, ומפרסמים שוב. אם זה חוזר — מחכים יום.',
    };
  }
  // אינסטגרם לא סיים לעבד בזמן — לא בעיית פורמט; לרוב עומס אצלם או סרטון כבד
  if (err?.kind === 'processing_timeout' || /לא סיים לעבד את המדיה/.test(raw)) {
    return {
      who: 'owner',
      message: `${meta} לא סיים לעבד את התמונה או הסרטון בזמן — לפעמים זה רק עומס אצלם. ` +
        'בודקים בחשבון אם הפוסט עלה; אם לא — מפרסמים שוב, ואם זה חוזר עם סרטון — מקצרים או מקטינים אותו.',
    };
  }
  if (META_MEDIA.includes(code) || META_MEDIA_SUB.includes(sub) ||
      /media download|download.*fail|fetch.*(image|video|media)|image_url|video_url|aspect ratio|unsupported (format|file|media)|דחה את המדיה/i.test(raw)) {
    return {
      who: 'owner',
      message: `${meta} לא הצליחה לקבל את התמונה או הסרטון. בודקים שהקובץ נפתח ושהוא בפורמט ` +
        'נתמך (JPG/PNG לתמונה, MP4 לסרטון, ביחס גובה-רוחב סביר), ומפרסמים שוב.',
    };
  }
  if (META_TEMPORARY.includes(code) || /unexpected error|temporarily unavailable|service unavailable/i.test(raw)) {
    return { who: 'owner', message: `תקלה זמנית אצל ${meta}. מפרסמים שוב בעוד כמה דקות.` };
  }

  // רשת — ייתכן שהבקשה דווקא הגיעה. פרסום לרשתות לא idempotent: בודקים לפני שמנסים שוב
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(raw)) {
    return {
      who: 'owner',
      message: `לא הצלחנו להגיע ל${where} (תקלת רשת). לפני שמפרסמים שוב — בודקים שהפוסט לא עלה בכל זאת.`,
    };
  }

  // הודעה שלנו, כבר בעברית פשוטה (חוסם פרסום, "המועד עבר" וכו') — כמו שהיא
  if (raw && hasHebrew(raw) && !hasLatinWords(raw)) return { who: 'owner', message: raw };

  return {
    who: 'owner',
    message: 'הפרסום נכשל מסיבה שלא זיהינו. מנסים שוב, ואם זה חוזר — מעבירים למפתח את הפרטים' +
      (raw ? ` (${raw.slice(0, RAW_MAX)})` : '') + '.',
  };
}
