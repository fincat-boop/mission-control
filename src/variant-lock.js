/**
 * נעילה אופטימית של גרסה (content_variants.updated_at — ראו schema.sql).
 *
 * טופס העריכה שולח את ה-updated_at שהגרסה נפתחה איתו (base_updated_at),
 * והשרת דוחה (409) שמירה על גרסה שמישהו אחר שמר בינתיים — במקום לדרוס את
 * העבודה שלו בשקט. פונקציות טהורות; הנתיבים ב-routes/content.js.
 * אותו דפוס לטופס הקמפיין (campaigns.updated_at) — בסוף הקובץ.
 */

export const STALE_VARIANT = 'מישהו אחר שמר את הגרסה הזו בינתיים — טוענים מחדש';

/** גרסה שנוצרה ריקה (למשל כשקובץ נתלה עליה לפני השמירה) — כמו "אין גרסה" */
const blankVariant = (v) => !v.body && v.status === 'draft' && v.meta == null;

/**
 * האם השמירה מבוססת על גרסה ישנה.
 * @param row  הגרסה כפי שהיא עכשיו במסד, או null
 * @param base ה-updated_at שהטופס נפתח איתו (null = לא הייתה גרסה).
 *             ההשוואה במילישניות — כך הערך עובר ב-JSON.
 */
export function staleVariant(row, base) {
  if (!row) return base != null;
  if (base == null) return !blankVariant(row);
  return new Date(row.updated_at).getTime() !== new Date(base).getTime();
}

/* ---------- קמפיין (campaigns.updated_at, טריגר campaigns_touch) ---------- */

export const STALE_CAMPAIGN =
  'הקמפיין שונה בינתיים (בלשונית אחרת או אצל משתמש אחר). מרעננים ומנסים שוב.';

/**
 * האם שמירה של טופס הקמפיין מבוססת על קמפיין ישן. base חסר — אין בדיקה
 * (קוראים שלא שולחים אותו: תפריטים של שדה אחד, העוזר).
 */
export function staleCampaign(row, base) {
  if (base == null || base === '') return false;
  return new Date(row.updated_at).getTime() !== new Date(base).getTime();
}
