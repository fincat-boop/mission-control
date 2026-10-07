/**
 * שורה בטבלת קמפיין כללי — פוסט מספר N בכל הערוצים (סעיף 18). שכבה 0:
 * פונקציות טהורות בלבד (בלי DOM ובלי state), נבדקות ב-test/slot-row.test.js.
 *
 * content — הפריטים של הקמפיין (campaign.content): slot_channel_id + sort_order
 * הם המקום בטבלה. slots — campaign.slots מהשרת: עמודה לכל ערוץ, לפי הסדר
 * שבטבלה, וכל אחת עם רשימת משבצות {index, extra, content}.
 */

/** הגוף של פריט במשבצת שלו — הגרסה לערוץ של המשבצת, אחרת הגוף של הפריט */
export const slotBody = (item) =>
  item?.variants?.find((v) => v.channel_id === item.slot_channel_id)?.body ?? item?.body ?? '';

/** כמה קבצים יש לפריט (משותפים + של הגרסה) */
export const slotFiles = (item) => (item?.assets?.length ?? 0) + (item?.variant_assets?.length ?? 0);

/**
 * משבצת חדשה מקבלת כותרת וסוג מפוסט אחר באותה שורה (אותו מספר פוסט, ערוץ
 * אחר) — הראשון לפי סדר העמודות. null = אין מאיפה.
 * @param {object[]} content
 * @param {{index:number, channelId:number, order?:number[]}} at order — מזהי
 *        הערוצים לפי סדר העמודות (בלי — לפי הסדר ב-content)
 * @returns {{title:string, kind:string}|null}
 */
export function rowPrefill(content, { index, channelId, order = [] }) {
  const rank = (x) => {
    const i = order.indexOf(x.slot_channel_id);
    return i < 0 ? order.length : i;
  };
  const same = content
    .filter((x) => x.sort_order === index && x.slot_channel_id !== channelId && x.title?.trim())
    .sort((a, b) => rank(a) - rank(b));
  return same.length ? { title: same[0].title, kind: same[0].kind } : null;
}

/**
 * מאיפה אפשר להעתיק ("העתק מ־"): כל פוסט אחר בקמפיין שיש לו טקסט או קבצים.
 * קודם אלה שבאותה שורה (לפי סדר העמודות), אחר כך השאר לפי מספר פוסט וערוץ.
 * @returns {{id:number, channel_id:number, index:number, title:string, body:string,
 *            files:number, sameRow:boolean}[]}
 */
export function copySources(content, { index, channelId, selfId = null, order = [] }) {
  const rank = (ch) => {
    const i = order.indexOf(ch);
    return i < 0 ? order.length : i;
  };
  return content
    .filter((x) => x.id !== selfId && x.slot_channel_id != null &&
                   !(x.sort_order === index && x.slot_channel_id === channelId))
    .map((x) => ({ id: x.id, channel_id: x.slot_channel_id, index: x.sort_order,
                   title: x.title ?? '', body: slotBody(x), files: slotFiles(x),
                   sameRow: x.sort_order === index }))
    .filter((x) => x.body.trim() || x.files > 0)
    .sort((a, b) => (Number(b.sameRow) - Number(a.sameRow)) || (a.index - b.index) ||
                    (rank(a.channel_id) - rank(b.channel_id)));
}

/**
 * "הבא ›": המשבצת הריקה הבאה — קודם בהמשך אותה שורה (העמודות שאחרי הנוכחית),
 * ואחר כך בשורות הבאות מתחילתן. רק משבצות שמוצגות בטבלה (משבצת "מעבר לצורך"
 * מוצגת רק כשיש בה פוסט — ולכן ריקה כזו לא נספרת). null = אין עוד.
 * @param {{channel_id:number, slots:{index:number, extra?:boolean, content?:object}[]}[]} slots
 * @returns {{channelId:number, index:number}|null}
 */
export function nextEmptySlot(slots, { channelId, index }) {
  const empty = new Map(); // index → [channel ids, לפי סדר העמודות]
  for (const col of slots) {
    for (const s of col.slots) {
      if (s.content || s.extra) continue;
      if (!empty.has(s.index)) empty.set(s.index, []);
      empty.get(s.index).push(col.channel_id);
    }
  }
  const col = slots.findIndex((c) => c.channel_id === channelId);
  const after = (ch) => slots.findIndex((c) => c.channel_id === ch) > col;
  const rowRest = (empty.get(index) ?? []).find(after);
  if (rowRest != null) return { channelId: rowRest, index };
  const later = [...empty.keys()].filter((i) => i > index).sort((a, b) => a - b);
  return later.length ? { channelId: empty.get(later[0])[0], index: later[0] } : null;
}
