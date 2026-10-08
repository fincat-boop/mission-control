/**
 * הגבלת קצב בזיכרון, חלון קבוע. מספיקה כל עוד יש instance אחד (כמו עבודות
 * הרקע ב-server.js). כמו ב-Backbone: לכל סוג מפתח (הטקסט שלפני ה-":")
 * דלי משלו עם תקרה, כך שהצפה של סוג אחד לא מוחקת את המונים של סוג אחר.
 */

const MAX_ENTRIES_PER_KIND = 10_000;
const buckets = new Map();   // kind -> Map(key -> {count, resetAt})

export function isRateLimited(key, max, windowMs, now = Date.now()) {
  const kind = key.split(':')[0];
  let bucket = buckets.get(kind);
  if (!bucket) buckets.set(kind, (bucket = new Map()));

  let entry = bucket.get(key);
  if (!entry || entry.resetAt <= now) {
    if (!entry && bucket.size >= MAX_ENTRIES_PER_KIND) {
      for (const [k, e] of bucket) if (e.resetAt <= now) bucket.delete(k);
      // עדיין מלא — מפנים את הוותיק ביותר (סדר ההכנסה של Map)
      if (bucket.size >= MAX_ENTRIES_PER_KIND) bucket.delete(bucket.keys().next().value);
    }
    entry = { count: 0, resetAt: now + windowMs };
    bucket.set(key, entry);
  }
  entry.count += 1;
  return entry.count > max;
}

/** לטסטים */
export function resetRateLimits() {
  buckets.clear();
}
