import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * הצפנת סודות במנוחה (טוקנים של Meta). AES-256-GCM עם מפתח שנגזר
 * מ-SESSION_SECRET — כך הטוקן שמור גם בגיבויים (שמכילים את כל הטבלאות)
 * וגם מול גישת קריאה ישירה ל-DB, בלי משתנה סביבה חדש.
 *
 * פורמט השמירה: iv.tag.ciphertext (base64url, מופרד בנקודות).
 */

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('חסר SESSION_SECRET — נדרש להצפנת טוקנים');
  return createHash('sha256').update(`${secret}:publish-tokens`).digest();
}

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(stored) {
  const [iv, tag, ct] = String(stored).split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
