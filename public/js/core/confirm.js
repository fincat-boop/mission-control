import { $ } from './dom.js';

/**
 * אישור/ביטול בתוך האפליקציה — לא confirm() של הדפדפן. מחזיר Promise
 * שנפתר ל-true/false, כדי שאפשר יהיה לכתוב `if (!await confirmDialog(...))`
 * בדיוק כמו שהיה עם confirm() הרגיל.
 *
 * יושב ב-core ולא ב-ui/ יחד עם openGeneric: זו פרימיטיבה קטנה מעל אלמנט
 * סטטי, ו-core/api.js נשען עליה לאזהרת המרווח. openGeneric, לעומת זאת,
 * הוא בונה טפסים שלם ומקומו בשכבה שמעל.
 */
export function confirmDialog(message, { okLabel = 'אישור', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#confirmDlg');
    const okBtn = $('#confirmOk');
    $('#confirmMsg').textContent = message;
    okBtn.textContent = okLabel;
    okBtn.classList.toggle('primary', !danger);
    okBtn.classList.toggle('crit', danger);

    let decided = false;
    const finish = (result) => {
      if (decided) return;
      decided = true;
      dlg.removeEventListener('close', onClose);
      resolve(result);
    };
    const onOk = () => { finish(true); dlg.close(); };
    const onCancel = () => { finish(false); dlg.close(); };
    const onClose = () => finish(false);

    okBtn.addEventListener('click', onOk, { once: true });
    $('#confirmCancel').addEventListener('click', onCancel, { once: true });
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}
