import { rows } from './db.js';

/**
 * "לא אושר שיצא" (סעיף 2 בשיפורי ההתנהגות): כמעט כל פוסט מתפרסם ביד, ומי
 * שמפרסם אמור ללחוץ "סמן שפורסם" — ובפועל לא תמיד. פוסט שהמועד שלו עבר ולא
 * סומן הוא "לא ידוע", לא "לא יצא": כמעט תמיד הוא יצא.
 *
 * החלטת המשתמש ה1: פוסט כזה לעולם לא מסומן "פורסם" אוטומטית — הוא נשאר
 * ברשימת האישור (התראה מרוכזת אחת ← רשימה מסומנת מראש) עד שמישהו מחליט.
 * בינתיים הוא נספר *כאילו פורסם* בשלושה מדדים, כדי שהלא-ידוע לא יפיל אותם:
 *   - "נקודה לא מפרסמת" (alerts.js endpointsWithoutAir)
 *   - קצב קמפיין (campaigns.js paceDone)
 *   - הוותק במנוע (engine.js computeDebts — שם התנאי משוכפל בשאילתה)
 *
 * ההגדרה:
 *   מתוכנן או מאושר, published_at ריק, המועד עבר לפני יותר מחצי שעה (חסד —
 *   פרסום אוטומטי עוד יכול להיות בדרך), ערוץ פעיל שאינו ניוזלטר (לו מסלול
 *   משלו מול ה-HUB), קמפיין לא מושהה. בלי ממלא מקום של המנוע (auto_hole) שאין
 *   לו תוכן — הוא לא יכול היה לצאת, ול"חסר תוכן והמועד עבר" יש התראה משלו.
 *   מבצע דחוף (כותרת בלבד) — כן.
 */
export const UNCONFIRMED_GRACE_MINUTES = 30;

/** כמה אחורה הרשימה מגיעה. אין חיתוך של שבוע — רק תקרה, שלא תציף. */
export const UNCONFIRMED_MAX_DAYS = 90;

/** תנאי SQL על פוסט בכינוי p — אותו כלל לרשימה ולמדדים */
export const UNCONFIRMED_SQL = `(
  p.status in ('scheduled', 'approved') and p.published_at is null
  and p.scheduled_at < now() - interval '${UNCONFIRMED_GRACE_MINUTES} minutes'
  and (p.content_id is not null or p.urgent or not p.auto_hole)
  and exists (select 1 from channels uc
               where uc.id = p.channel_id and uc.active and uc.platform <> 'newsletter')
  and not exists (select 1 from content_items uci
                    join campaigns uca on uca.id = uci.campaign_id
                   where uci.id = p.content_id and uca.paused_at is not null))`;

/**
 * הרשימה שההתראה סופרת וחלון האישור מציג — אותה שאילתה, כך שהמספר בהתראה
 * הוא מספר השורות בחלון. פוסט שיש לו משימת "לפרסם היום" פתוחה (שלא נדחתה)
 * לא נכנס: המשימה היא הסימן שלו עד שהיא פגה בסוף היום (סימן אחד לפוסט).
 */
export function unconfirmedPosts() {
  return rows(
    `select p.id, p.title, p.scheduled_at, p.urgent, p.content_id,
            c.name as channel_name, c.platform, e.name as endpoint_name
       from posts p
       join channels c       on c.id = p.channel_id
       left join endpoints e on e.id = p.endpoint_id
      where ${UNCONFIRMED_SQL}
        and p.scheduled_at >= now() - interval '${UNCONFIRMED_MAX_DAYS} days'
        and not exists (select 1 from tasks t
                         where t.post_id = p.id and t.kind = 'publish' and not t.done
                           and (t.snoozed_until is null or t.snoozed_until <= now()))
      order by p.scheduled_at, p.id`
  );
}

/**
 * ההתראה המרוכזת (טהורה): אחת לכל הרשימה במקום התראה לכל פוסט. הפעולה
 * (action: 'unconfirmed') פותחת את חלון האישור. רק למי שיכול לסמן.
 */
export function unconfirmedAlert(list) {
  const n = list.length;
  if (!n) return [];
  return [{
    id: 'unconfirmed',
    level: 'warn',
    title: n === 1 ? 'פוסט אחד לא סומן כפורסם' : `${n} פוסטים לא סומנו כפורסמו`,
    detail: 'המועד עבר ואף אחד לא סימן שפורסמו — מסמנים ברשימה מה יצא; ' +
            'מה שלא יצא משבצים מחדש או מוחקים',
    perm: 'content',
    action: 'unconfirmed',
    tab: null,
  }];
}
