/**
 * פורמטים וקבועי תצוגה. שכבה 0 — פונקציות טהורות בלבד, בלי DOM ובלי מצב.
 *
 * הקבועים שמשמשים יותר ממודול אחד יושבים כאן ולא בתוך מודול פיצ'ר,
 * כדי ששכתוב של פיצ'ר שלם לא ימחק אותם ממי שעדיין צריך אותם.
 */

export const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

// זיהוי סוג קובץ ותצוגת גודל — בשימוש גם בלוח וגם במסך התוכן
export const isImage = (mime) => typeof mime === 'string' && mime.startsWith('image/');
export const isVideo = (mime) => typeof mime === 'string' && mime.startsWith('video/');
export const kb = (n) =>
  (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);

export const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
export const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);

export const fmtDate = (d) => {
  const x = new Date(typeof d === 'string' && d.length === 10 ? `${d}T00:00:00` : d);
  return `${x.getDate()}.${x.getMonth() + 1}`;
};

export const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export const KIND_HE = { promo: 'מכירתי', value: 'ערך', hybrid: 'משולב' };
export const KIND_VAR = {
  promo: 'var(--leg-promo)', value: 'var(--leg-value)', hybrid: 'var(--leg-hybrid)',
};

/** מצב הקמפיין → מחלקת הצבע של השבב */
export const TONE_CLASS = { good: 'on', warn: '', bad: 'bad', muted: '' };

/** מצב תא ברשת התוכן */
export const CELL = {
  ready:        { label: 'מוכן',       cls: 'ok'    },
  draft:        { label: 'טיוטה',      cls: 'draft' },
  empty:        { label: 'חסר',        cls: 'gap'   },
  not_relevant: { label: 'לא רלוונטי', cls: 'na'    },
  not_needed:   { label: '',           cls: 'na'    },
};

/** טקסט כהה או בהיר, לפי בהירות הרקע — צהוב ולבן לא נקראים יחד */
export function inkOn(bg) {
  const m = /^#([0-9a-f]{6})$/i.exec(bg);
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#14161a' : '#fff';
}
