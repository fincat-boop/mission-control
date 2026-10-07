import { postsLabel } from './fitChoice.js';

/**
 * עריכת קמפיין בטופס — פונקציות טהורות (נבדקות ב-test/campaign-edit.test.js).
 */

/**
 * מה קרה לפוסטים כשהקמפיין זז בזמן (shift מ-PATCH /campaigns/:id). ריק כשלא
 * זז כלום. מה שלא התאים לתאריך החדש ירד מהלוח ושובץ מחדש לפי הכללים — ומאושר
 * שירד צריך אישור מחדש.
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
    parts.push(`${postsLabel(shift.rescheduled)} ${shift.rescheduled === 1 ? 'שובץ' : 'שובצו'} ` +
      `מחדש כי התאריך החדש לא התאים${approved}`);
  }
  return `${parts.join(', ')}.`;
}
