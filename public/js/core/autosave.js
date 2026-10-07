/**
 * שמירה אוטומטית של טופס — המנגנון של חלון המשבצת, משותף עם עורך הגרסאות
 * (סעיף 24: עורך אחד, התנהגות אחת). שכבה 0: בלי DOM — נבדק ב-test/autosave.test.js.
 *
 * הקלדה מתזמנת שמירה אחרי הפסקה קצרה (schedule(800)), בחירה — מיד
 * (schedule(0)). שמירה אחת בכל רגע: שינוי שהגיע באמצע שמירה נשמר מיד אחריה
 * (סבב נוסף), וגם saveOnce יכול לבקש סבב נוסף (ctl.again() — למשל "מוכן"
 * שנדחה: הטקסט נשמר שוב כטיוטה). unsaved — יש שינוי שלא נשמר (או ששמירתו
 * נכשלה): הטופס שואל לפני סגירה, ו-flush() שומר לפני סגירה רגילה.
 *
 * @param {(ctl:object) => Promise<void>} saveOnce שמירה אחת. אחראית לעדכן
 *        ctl.unsaved ולהציג את התוצאה; שגיאה שלא נתפסה בה עוברת ל-onError
 * @param {{onError?: (e:Error) => void}} [opts]
 */
export function createAutosave(saveOnce, { onError = () => {} } = {}) {
  let timer = null;
  let saving = null;
  let again = false;

  const ctl = {
    /** יש שינוי שלא נשמר — הקורא מעדכן אחרי כל שמירה */
    unsaved: false,

    /** saveOnce מבקש סבב נוסף מיד אחרי הנוכחי */
    again() { again = true; },

    /** שמירה ממתינה או רצה */
    get busy() { return timer !== null || saving !== null; },

    /** שינוי בטופס: שמירה בעוד ms (תזמון חדש מבטל את הקודם) */
    schedule(ms) {
      ctl.unsaved = true;
      clearTimeout(timer);
      timer = setTimeout(() => { ctl.saveNow(); }, ms);
    },

    /** ביטול שמירה מתוזמנת (סגירה, מחיקה) */
    cancel() {
      clearTimeout(timer);
      timer = null;
    },

    /** שומר עכשיו (ומה שהשתנה בינתיים — מיד אחרי). מחזיר הבטחה לסיום */
    saveNow() {
      ctl.cancel();
      if (saving) {
        again = true;
        return saving;
      }
      saving = (async () => {
        try {
          do {
            again = false;
            await saveOnce(ctl);
          } while (again);
        } catch (e) {
          ctl.unsaved = true;
          onError(e);
        } finally {
          saving = null;
        }
      })();
      return saving;
    },

    /** מחכה לשמירה שרצה עכשיו (בלי להתחיל חדשה) */
    idle: () => saving ?? Promise.resolve(),

    /** לפני סגירה: מה שממתין או לא נשמר — נשמר עכשיו */
    async flush() {
      if (ctl.busy || ctl.unsaved) await ctl.saveNow();
    },
  };
  return ctl;
}
