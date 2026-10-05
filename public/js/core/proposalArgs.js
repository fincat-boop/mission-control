import { HE_DAYS, KIND_HE } from './format.js';

/**
 * הפרמטרים של הצעה מהעוזר, בעברית — במקום JSON גולמי בכרטיס.
 * שכבה 0: פונקציה טהורה. השמות (ערוץ, נקודה…) מגיעים ב-lookup מהמצב
 * של הלקוח; מזהה שלא נמצא מוצג כ-"#מזהה" ולא נעלם.
 */

const LABELS = {
  post_id: 'פוסט',
  content_id: 'תוכן',
  campaign_id: 'קמפיין',
  endpoint_id: 'נקודת קצה',
  channel_id: 'ערוץ',
  channel_ids: 'ערוצים',
  user_id: 'משתמש',
  assignee_id: 'אחראי',
  scheduled_at: 'מועד',
  starts_on: 'מתחיל',
  ends_on: 'מסתיים',
  due_on: 'עד',
  on_date: 'תאריך',
  from: 'מתאריך',
  to: 'עד תאריך',
  kind: 'סוג',
  status: 'מצב',
  title: 'כותרת',
  subtitle: 'פירוט',
  name: 'שם',
  goal: 'מטרה',
  label: 'תווית',
  body: 'ניסוח',
  importance: 'חשיבות',
  share_pct: 'נתח',
  target_posts: 'יעד פוסטים',
  min_days_between: 'תדירות',
  target_per_week: 'פוסטים בשבוע (יעד)',
  max_per_week: 'פוסטים בשבוע (תקרה)',
  max_promo_per_week: 'מכירתי בשבוע (תקרה)',
  max_value_per_week: 'ערך בשבוע (תקרה)',
  max_hybrid_per_week: 'משולב בשבוע (תקרה)',
  blocked_days: 'ימים חסומים',
  evergreen: 'רץ ברקע',
  reuse_after_days: 'שימוש חוזר אחרי',
  urgent: 'דחוף',
  active: 'פעיל',
  sort_order: 'מיקום',
};

const STATUS_HE = { draft: 'טיוטה', ready: 'מוכן', not_relevant: 'לא רלוונטי' };

const pad = (n) => String(n).padStart(2, '0');

/** "2026-10-07" → 7.10.2026 ; ISO עם שעה → יום ג׳ 7.10 · 10:00 (שעון מקומי) */
export function fmtWhen(v) {
  if (typeof v !== 'string') return String(v);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(dateOnly ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return v;
  const day = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
  if (dateOnly) return day;
  return `יום ${HE_DAYS[d.getDay()]} ${day} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const nameOf = (list, id) => list?.find((x) => Number(x.id) === Number(id))?.name;
const ref = (list, id) => nameOf(list, id) ?? `#${id}`;
const yesNo = (v) => (v ? 'כן' : 'לא');

function valueText(key, v, lookup) {
  if (v == null || v === '') return '—';
  switch (key) {
    case 'channel_id': return ref(lookup.channels, v);
    case 'channel_ids': return Array.isArray(v) && v.length
      ? v.map((id) => ref(lookup.channels, id)).join(', ') : 'אין';
    case 'endpoint_id': return ref(lookup.endpoints, v);
    case 'campaign_id': return ref(lookup.campaigns, v);
    case 'user_id':
    case 'assignee_id': return ref(lookup.users, v);
    case 'post_id': return lookup.postTitle ? `${lookup.postTitle} (#${v})` : `#${v}`;
    case 'content_id': return `#${v}`;
    case 'scheduled_at':
    case 'starts_on':
    case 'ends_on':
    case 'due_on':
    case 'on_date':
    case 'from':
    case 'to': return fmtWhen(v);
    case 'kind': return KIND_HE[v] ?? String(v);
    case 'status': return STATUS_HE[v] ?? String(v);
    case 'share_pct': return `${v}%`;
    case 'min_days_between': return `פעם ב-${v} ימים`;
    case 'reuse_after_days': return `${v} ימים`;
    case 'blocked_days': return Array.isArray(v) && v.length
      ? v.map((d) => HE_DAYS[d] ?? d).join(', ') : 'אין';
    case 'body': {
      const s = String(v);
      return s.length > 160 ? `${s.slice(0, 160)}…` : s;
    }
    default:
      if (typeof v === 'boolean') return yesNo(v);
      if (Array.isArray(v)) return v.join(', ');
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
  }
}

/**
 * @param {object} args הפרמטרים כמו שהגיעו מהשרת
 * @param {{channels?, endpoints?, campaigns?, users?, postTitle?}} lookup
 * @returns {Array<[string, string]>} [תווית, ערך] לפי סדר הפרמטרים
 */
export function describeArgs(args, lookup = {}) {
  return Object.entries(args ?? {}).map(([k, v]) => [LABELS[k] ?? k, valueText(k, v, lookup)]);
}
