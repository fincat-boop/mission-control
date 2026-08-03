import { confirmDialog } from './confirm.js';

/** כל הנתונים מגיעים מ-/api. שכבה 0. */
export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('נדרשת התחברות');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // גוף התשובה נשמר על השגיאה: יש נתיבים שמחזירים אזהרה שאפשר לאשר
    const err = new Error(data.error || 'הפעולה נכשלה');
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

/**
 * שיבוץ שהשרת מזהיר עליו כצמוד מדי. האזהרה אינה חסימה: מציגים מה
 * שהשרת יודע ושואלים, ומי שמאשר שולח שוב עם confirm_gap.
 */
export async function postWithGapCheck(path, body, method = 'PATCH') {
  try {
    return await api(path, { method, body });
  } catch (e) {
    if (e.status !== 409 || !e.payload?.needs_confirm) throw e;
    const w = e.payload.warning;
    if (!(await confirmDialog(`${w.message}\n\nלשבץ בכל זאת?`))) return null;
    return api(path, { method, body: { ...body, confirm_gap: true } });
  }
}
