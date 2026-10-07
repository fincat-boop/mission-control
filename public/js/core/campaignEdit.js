import { postsLabel } from './fitChoice.js';

/**
 * עריכת קמפיין בטופס — פונקציות טהורות (נבדקות ב-test/campaign-edit.test.js).
 */

/**
 * התאריכים כפי שהשמירה שולחת אותם: בלי תאריך לפוסט הראשון אין ממה לחשב
 * סיום (התקופה לא נשלחת), ותאריך סיום נשלח רק בתקופה ידנית. משנה במקום.
 */
export function tidyCampaignDates(v) {
  if (!v.starts_on && v.period !== 'custom') delete v.period;
  if (v.period !== 'custom') delete v.ends_on;
  return v;
}

const TEXT_FIELDS = ['name', 'endpoint_id', 'goal'];
const DATE_FIELDS = ['starts_on', 'period', 'ends_on'];
/** ריק / חסר / null — אותו דבר */
const norm = (x) => (x === undefined || x === '' ? null : x);
const sameIds = (a, b) => {
  const s = (x) => [...new Set((x ?? []).map(Number))].sort((m, n) => m - n).join();
  return s(a) === s(b);
};

/**
 * רק מה שהמשתמש שינה מול הטופס כפי שנפתח (initial). לשונית שנפתחה לפני
 * שמישהו אחר הזיז את הקמפיין לא מחזירה איתה את התאריכים, הערוצים או נקודת
 * הקצה הישנים — שינוי שם שולח רק שם.
 *
 * התאריכים הולכים יחד: שינוי באחד מהם (תאריך יעד, תקופה, סיום) שולח את
 * כולם כמו בטופס, כדי שהשרת יחשב את הסיום בדיוק כמו קודם (גם בקמפיין ישן
 * שהתקופה שלו מוסקת בטופס ולא שמורה).
 * @param initial הערכים שהטופס נפתח איתם (אותה צורה כמו values)
 * @param values  הערכים מהטופס, אחרי tidyCampaignDates
 */
export function changedCampaignFields(initial, values) {
  const was = tidyCampaignDates({ ...initial });
  const out = {};
  for (const k of TEXT_FIELDS) {
    if (k in values && norm(values[k]) !== norm(was[k])) out[k] = values[k];
  }
  if (DATE_FIELDS.some((k) => norm(values[k]) !== norm(was[k]))) {
    for (const k of DATE_FIELDS) if (k in values) out[k] = values[k];
  }
  if ('channel_ids' in values && !sameIds(values.channel_ids, was.channel_ids)) {
    out.channel_ids = values.channel_ids;
  }
  return out;
}

/**
 * מה קרה לפוסטים כשהקמפיין זז בזמן (shift מ-PATCH /campaigns/:id). ריק כשלא
 * זז כלום. מה שלא התאים לתאריך החדש ירד מהלוח ושובץ מחדש לפי הכללים — ומאושר
 * שירד צריך אישור מחדש.
 * בדיקה בלי הזזה (revalidateCampaignPosts — סיום מוקדם, מרווח גדול, "לא
 * באותו יום", קישור) מחזירה kept במקום moved: מה שירד — "כדי לעמוד בכללים".
 */
export function shiftNote(shift) {
  if (!shift || !(shift.moved || shift.rescheduled)) return '';
  const parts = [];
  if (shift.moved) {
    parts.push(`${postsLabel(shift.moved)} ${shift.moved === 1 ? 'זז' : 'זזו'} עם הקמפיין`);
  }
  if (shift.rescheduled) {
    const approved = !shift.approved ? ''
      : shift.approved === 1 ? ' (אחד מהם היה מאושר ויצטרך אישור מחדש)'
        : ` (${shift.approved} מהם היו מאושרים ויצטרכו אישור מחדש)`;
    const why = 'kept' in shift ? 'כדי לעמוד בהגדרות החדשות של הקמפיין'
      : 'כי התאריך החדש לא התאים';
    parts.push(`${postsLabel(shift.rescheduled)} ${shift.rescheduled === 1 ? 'שובץ' : 'שובצו'} ` +
      `מחדש ${why}${approved}`);
  }
  return `${parts.join(', ')}.`;
}
