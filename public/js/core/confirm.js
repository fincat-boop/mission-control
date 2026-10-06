import { $ } from './dom.js';

/**
 * אישור/ביטול בתוך האפליקציה — לא confirm() של הדפדפן. מחזיר Promise
 * שנפתר ל-true/false, כדי שאפשר יהיה לכתוב `if (!await confirmDialog(...))`
 * בדיוק כמו שהיה עם confirm() הרגיל.
 *
 * יושב ב-core ולא ב-ui/ יחד עם openGeneric: זו פרימיטיבה קטנה מעל אלמנט
 * סטטי, ו-core/api.js נשען עליה לאזהרת המרווח. openGeneric, לעומת זאת,
 * הוא בונה טפסים שלם ומקומו בשכבה שמעל.
 *
 * html — חלק נוסף מתחת להודעה (למשל בחירה בין אפשרויות), ו-read(container)
 * מחזיר את מה שנבחר בו כשלוחצים על האישור. כך החלון נפתח מעל טופס פתוח
 * (genDlg) בלי לסגור אותו.
 */
export function confirmDialog(message, { okLabel = 'אישור', danger = false, html = '', read = null } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#confirmDlg');
    const okBtn = $('#confirmOk');
    $('#confirmMsg').textContent = message;
    $('#confirmMsg').hidden = !message;
    // חלק נוסף (רשימה, בחירה) מתחת להודעה — html כבר מוסלש בידי הקורא
    const extra = $('#confirmExtra');
    extra.innerHTML = html;
    extra.hidden = !html;
    dlg.classList.toggle('wide', !!html);
    okBtn.textContent = okLabel;
    okBtn.classList.toggle('primary', !danger);
    okBtn.classList.toggle('danger', danger);

    let decided = false;
    const finish = (result) => {
      if (decided) return;
      decided = true;
      dlg.removeEventListener('close', onClose);
      resolve(result);
    };
    // read: מה שנבחר בחלק הנוסף, במקום true (ביטול נשאר false)
    const onOk = () => { finish(read ? read(extra) : true); dlg.close(); };
    const onCancel = () => { finish(false); dlg.close(); };
    const onClose = () => finish(false);

    okBtn.addEventListener('click', onOk, { once: true });
    $('#confirmCancel').addEventListener('click', onCancel, { once: true });
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}
