/**
 * חלון ההתאמה — "לא כל הפוסטים נכנסים בזמן". לוגיקה טהורה מעל התשובה של
 * POST /campaigns/capacity-preview (src/campaigns.js, capacityPreview), בלי DOM:
 * אילו ערוצים חסרים, לאיזה מרווח לדחוס, עד מתי להאריך ומה יוצא מכל בחירה.
 * ה-HTML והקריאות לשרת — ב-features/plan.js.
 */

/** "פוסט אחד" / "3 פוסטים" */
export const postsLabel = (n) => (n === 1 ? 'פוסט אחד' : `${n} פוסטים`);

/** "יום אחד" / "5 ימים" */
export const daysLabel = (n) => (n === 1 ? 'יום אחד' : `${n} ימים`);

/**
 * הערוצים שהמרווח מקצץ בהם: הקצב מבקש יותר ממה שנכנס, והמגביל הוא המרווח.
 * אותו תנאי כמו short בשרת.
 */
export function shortChannels(preview) {
  return (preview?.channels ?? [])
    .filter((c) => c.limited_by === 'gap' && c.capacity < c.rate_cap);
}

/** המרווח לדחיסה: הקטן מבין gap_to_fit שאינם null (כדי שכל הערוצים ייכנסו); null = אין */
export function compressGap(rows) {
  const gaps = rows.map((r) => r.gap_to_fit).filter((g) => g != null);
  return gaps.length ? Math.min(...gaps) : null;
}

/** "פייסבוק 4, אינסטגרם 4" — כמה נכנס בכל ערוץ; ids מגביל לערוצים מסוימים */
export function fitsText(preview, ids = null) {
  return (preview?.channels ?? [])
    .filter((c) => !ids || ids.includes(c.channel_id))
    .map((c) => `${c.name} ${c.capacity}`).join(', ');
}

/** כמה הקמפיין ידרוש בסך הכול אם משאירים — מה שנכנס בכל הערוצים */
export const totalCapacity = (preview) =>
  (preview?.channels ?? []).reduce((s, c) => s + (c.capacity ?? 0), 0);

/**
 * המשפט שמסביר למה: המרווח, ואם המרווח מתחלק עם קמפיינים אחרים של אותה
 * נקודה — עם כמה (הגדול מבין הערוצים החסרים).
 */
export function gapReason(preview, rows) {
  const sib = Math.max(1, ...rows.map((r) => r.siblings ?? 1));
  const others = sib - 1;
  return `המרווח בין פוסטים של אותה נקודת קצה באותו ערוץ הוא ${daysLabel(preview.gap_days)}` +
    (others > 0
      ? ` (מתחלק עם ${others === 1 ? 'עוד קמפיין אחד' : `עוד ${others} קמפיינים`} של אותה נקודה)`
      : '') + '.';
}

/**
 * אותו מחסור בדיוק — אותם ערוצים חסרים, עם אותה קיבולת ואותה דרישה.
 * בעריכה: אם הטיוטה חסרה בדיוק כמו הקמפיין השמור, כבר הוחלט להשאיר אותו
 * כך (או שלא שונה שום דבר שמשפיע) — לא שואלים שוב בכל שמירה.
 */
export function sameShortage(a, b) {
  const key = (p) => shortChannels(p)
    .map((c) => `${c.channel_id}:${c.capacity}:${c.rate_cap}`).sort().join('|');
  return key(a) === key(b);
}

/**
 * סימון "מוכן" כשהתוכן שנכתב לא נכנס: preview.fixed (מ-assume_complete).
 * @param names {channel_id: שם} — ל-fixed אין שמות
 * @returns {null | {rows, gap, rateNotes, extendTo, lost}}
 *   rows — הערוצים שנכתב בהם יותר ממה שנכנס: {channel_id, name, written, capacity, ...}
 *   gap — המרווח לדחיסה (הקטן מבין gap_to_fit), או null — גם כשאינו קצר מהנוכחי
 *   rateNotes — ערוצים שגם בדחיסה הקצב לבדו לא מספיק (rate_short)
 *   extendTo — תאריך הסיום שבו הכול נכנס (המאוחר מבין end_to_fit), או null
 *   lost — כמה פוסטים לא ייכנסו אם משאירים
 */
export function completeFit(preview, names = {}) {
  const rows = (preview?.fixed?.channels ?? [])
    .filter((c) => c.written > c.capacity)
    .map((c) => ({ ...c, name: names[c.channel_id] ?? '' }));
  if (!rows.length) return null;
  const ends = rows.map((r) => r.end_to_fit).filter(Boolean).sort();
  // מרווח שאינו קצר מהנוכחי לא דוחס כלום (הקצב הוא שחוסם — rate_short)
  const gap = compressGap(rows);
  return {
    rows,
    gap: gap != null && !(gap >= preview.gap_days) ? gap : null,
    rateNotes: rows.filter((r) => r.rate_short),
    extendTo: ends.length ? ends[ends.length - 1] : null,
    lost: rows.reduce((s, r) => s + (r.written - r.capacity), 0),
  };
}

/** "א", "א וב", "א, ב וג" */
export function joinHe(list) {
  if (list.length < 2) return list.join('');
  return `${list.slice(0, -1).join(', ')} ו${list[list.length - 1]}`;
}

/**
 * ההערה לאפשרות "לדחוס" בסימון "מוכן": ערוצים שגם בדחיסה הקצב שלהם לבדו
 * לא מכיל את מה שנכתב — משפט אחד לכל תקרה, לא חזרה לכל ערוץ.
 */
export function rateNoteText(rateNotes) {
  const byCap = new Map();
  for (const r of rateNotes) byCap.set(r.rate_cap, [...(byCap.get(r.rate_cap) ?? []), r.name]);
  return [...byCap].map(([cap, names]) => (names.length === 1
    ? `גם בדחיסה, ${names[0]} יכניס עד ${cap} — הקצב של הערוץ.`
    : `גם בדחיסה, ${joinHe(names)} יכניסו עד ${cap} כל אחד — הקצב של הערוץ.`)).join(' ');
}

/** ערך תקין למרווח של קמפיין: שלם 1–30 (אותו טווח כמו בשרת) */
export const validGap = (n) => Number.isInteger(n) && n >= 1 && n <= 30;
