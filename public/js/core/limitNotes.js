/**
 * מה לא נכנס ולמה (סעיף 6) — הסדר בין הסיבות, איחוד של כמה מילויים, וההודעה
 * לכל קבוצה. משותף לשרת (src/engine.js — notPlacedLimits, applyWeek,
 * mergeFillResults) וללקוח (מאחד תשובות של כמה בקשות לטוסט אחד), כדי שיהיה
 * חשבון אחד.
 *
 * קבוצה: {reason, channel_id, channel_name, count, kinds, items:[{id, kind}],
 *         ...המספרים של המגבלה}.
 */

/**
 * הסדר שבו נבחרת הסיבה של תוכן שלא נכנס, כשנחסם בכמה משבצות מסיבות שונות:
 * קודם המגבלות לפי סוג של הערוץ, אחר כך הנתח (שבוע מרוסן) והמרווח, ובסוף
 * מכירתי ליום — תוכן שגם המרווח עצר אותו פשוט מחכה לתורו (gap), וזה המצב
 * הרגיל ולא תקלה (planWeek לא מציג אותו).
 */
export const LIMIT_ORDER = ['ratio_cap', 'ratio', 'promo_week', 'hybrid_week', 'value_week',
                            'share', 'gap', 'promo_day'];
/** המגבלות לפי סוג — מה שההודעה אחרי שמירה (engineToast) אומרת */
export const KIND_LIMITS = new Set(['ratio_cap', 'ratio', 'promo_week', 'hybrid_week',
                                    'value_week', 'promo_day']);
/** רק המגבלות לפי סוג */
export const kindLimits = (limits) => (limits ?? []).filter((x) => KIND_LIMITS.has(x.reason));

/**
 * איחוד של כמה רשימות (מילוי של כמה שבועות, או כמה בקשות): לכל תוכן×ערוץ
 * סיבה אחת — הראשונה לפי LIMIT_ORDER; תוכן שנכנס לערוץ באחת מהריצות
 * (placed — `${channel}:${content}`) יורד; הספירה לפי התוכן, לא לפי שבוע.
 * המספרים של כל קבוצה — מהקבוצה הראשונה שבה הופיעה.
 */
export function mergeLimits(lists, placed = []) {
  const done = new Set(placed);
  const best = new Map();    // `${channel}:${content}` → {group, kind}
  const rank = (r) => LIMIT_ORDER.indexOf(r);
  for (const list of lists) {
    for (const g of list ?? []) {
      for (const it of g.items ?? []) {
        const k = `${g.channel_id}:${it.id}`;
        if (done.has(k)) continue;
        const cur = best.get(k);
        if (!cur || rank(g.reason) < rank(cur.group.reason)) best.set(k, { group: g, item: it });
      }
    }
  }
  const out = new Map();
  for (const { group, item } of best.values()) {
    const key = `${group.reason}:${group.channel_id}`;
    if (!out.has(key)) {
      out.set(key, { ...group, count: 0, kinds: { promo: 0, hybrid: 0, value: 0 }, items: [] });
    }
    const e = out.get(key);
    e.count += 1;
    e.kinds[item.kind] = (e.kinds[item.kind] ?? 0) + 1;
    e.items.push(item);
  }
  return [...out.values()];
}

const KIND_PLURAL = { promo: 'מכירתיים', hybrid: 'משולבים', value: 'פוסטי ערך' };

/** "פוסט מכירתי אחד" / "3 פוסטים מכירתיים" / "2 פוסטים" — לפי הסוגים בקבוצה */
function postsOf(n, kinds = {}) {
  const only = ['promo', 'hybrid', 'value'].find((k) => (kinds[k] ?? 0) === n);
  const one = { promo: 'פוסט מכירתי אחד', hybrid: 'פוסט משולב אחד', value: 'פוסט ערך אחד' };
  const many = { promo: 'פוסטים מכירתיים', hybrid: 'פוסטים משולבים', value: 'פוסטי ערך' };
  if (n === 1) return only ? one[only] : 'פוסט אחד';
  return `${n} ${only ? many[only] : 'פוסטים'}`;
}

/**
 * המשפט לכל קבוצה של notPlacedLimits — המגבלה שעצרה בפועל, עם המספרים.
 * בלי "צריך עוד תוכן ערך" כשזה לא יעזור: רק בשער היחס הרגיל (ratio), שבו
 * עוד ערך בערוץ באמת מפנה מקום. גם ל-mergeFillResults (כמה שבועות).
 */
export function notPlacedNotes(limits) {
  return (limits ?? []).map((x) => {
    const head = `${postsOf(x.count, x.kinds)} ${x.count === 1 ? 'לא נכנס' : 'לא נכנסו'} ל${x.channel_name}`;
    const days = (n) => (n === 1 ? 'יום אחד' : `${n} ימים`);
    switch (x.reason) {
      case 'ratio':
        return `${head}: נדרשים ${x.ratio} פוסטי ערך לכל מכירתי, וכשהמנוע בדק היו בערוץ ` +
          `ב-28 הימים ${x.value} ערך מול ${x.promo} מכירתיים. עוד תוכן ערך לערוץ הזה יפנה להם מקום.`;
      case 'ratio_cap':
        return `${head}: ביחס של ${x.ratio} ערך לכל מכירתי, ערוץ של ${x.max_per_week ?? x.budget} פוסטים בשבוע ` +
          `מכניס עד ${x.ratio_cap} מכירתיים ב-28 ימים, ולא יותר מרבע מהם בשבוע אחד.`;
      case 'promo_week':
      case 'hybrid_week':
      case 'value_week': {
        const kind = x.reason.replace('_week', '');
        return `${head}: הערוץ מקבל עד ${x.cap} ${KIND_PLURAL[kind]} בשבוע ` +
          '(בהגדרות הערוץ, תחת "מתקדם").';
      }
      case 'promo_day':
        return `${head}: מותר עד ${x.per_day === 1 ? 'מכירתי אחד' : `${x.per_day} מכירתיים`} ` +
          'ביום בכל הערוצים יחד (כללי המנוע), והימים הפנויים כבר תפוסים.';
      case 'share':
        return `${head} השבוע: הנתח של הקמפיין בערוץ הוא ${x.share_pct}% — ` +
          `עד ${x.cap} פוסטים בשבוע.`;
      case 'gap':
        return `${head}: המרווח בין פוסטים של אותה נקודת קצה בערוץ הוא ${days(x.gap)}.`;
      default:
        return `${head}.`;
    }
  });
}
