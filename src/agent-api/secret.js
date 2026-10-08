/**
 * מפתחות API לסוכנים: יצירה, גיבוב ואימות. מודול טהור — בלי DB — כדי
 * שהטסטים ייבאו אותו ישירות. הועתק מ-Backbone (lib/auth/api-key-secret.ts).
 *
 * צורת מפתח: mc_live_ / mc_test_ ואחריו 60 תווים אקראיים (68 בסך הכול).
 *   key_prefix = 12 התווים הראשונים — ציבורי, מפתח החיפוש באינדקס, ומזהה
 *   את המפתח בלוגים ובממשק. נשמר רק sha256 של המפתח המלא: המפתח אקראי
 *   (כ-297 ביט) ואינו סיסמה, ולכן אין צורך ב-salt או ב-bcrypt (שרק מאט).
 *
 * mc_test_ = מפתח שהונפק מחוץ לפרודקשן. בפרודקשן הוא נדחה (authenticate.js),
 * כך שמפתח שדלף מסביבת פיתוח לא פותח את המערכת האמיתית.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// בלי i, l, o, 0, 1 — תווים שמתבלבלים כשמעתיקים ידנית
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const SECRET_LENGTH = 60;
export const PREFIXES = { live: 'mc_live_', test: 'mc_test_' };
const PREFIX_CHARS = 8;
export const PREFIX_LENGTH = 12;

/** תווים אקראיים מהאלפבית, בדגימה דחויה (בלי הטיה של modulo) */
function randomString(length) {
  const out = [];
  const cap = ALPHABET.length * Math.floor(256 / ALPHABET.length); // 248
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= cap) continue;
      out.push(ALPHABET[byte % ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

export function hashApiKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** @param {'live'|'test'} env */
export function generateApiKey(env) {
  const secret = PREFIXES[env] + randomString(SECRET_LENGTH);
  return { secret, prefix: secret.slice(0, PREFIX_LENGTH), hash: hashApiKey(secret), env };
}

/** הקידומת והסביבה של מפתח שהגיע בבקשה, או null כשהצורה לא תקינה */
export function prefixOf(secret) {
  if (typeof secret !== 'string' || secret.length !== PREFIX_CHARS + SECRET_LENGTH) return null;
  for (const [env, prefix] of Object.entries(PREFIXES)) {
    if (secret.startsWith(prefix)) return { prefix: secret.slice(0, PREFIX_LENGTH), env };
  }
  return null;
}

export const envOfPrefix = (prefix) => (String(prefix).startsWith(PREFIXES.test) ? 'test' : 'live');

/** השוואה בזמן קבוע של הגיבוב */
export function verifyApiKey(provided, storedHash) {
  const providedHash = hashApiKey(provided);
  if (providedHash.length !== String(storedHash).length) return false;
  try {
    return timingSafeEqual(Buffer.from(providedHash, 'hex'), Buffer.from(String(storedHash), 'hex'));
  } catch {
    return false;
  }
}

/** סביבת המפתח שמונפק עכשיו — לפי השרת, לא לבחירת המשתמש */
export const currentKeyEnv = () => (process.env.NODE_ENV === 'production' ? 'live' : 'test');
