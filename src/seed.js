import 'dotenv/config';
import { migrate, one, pool, query, rows } from './db.js';
import { hashPassword } from './auth.js';
import { weekStart, ymd } from './board.js';

/**
 * ממלא את המסד בנתוני הפתיחה של האבטיפוס — נקודות קצה, ערוצים, קמפיינים,
 * שבוע לדוגמה על הלוח ומשימות. בטוח להרצה חוזרת: מדלג אם כבר יש נתונים.
 *
 * משתמשים: נוצר רק הבעלים. את דב ועדי מוסיפים מתוך המסך "ניהול → משתמשים",
 * כדי שלכל אחד תהיה סיסמה משלו ולא סיסמת ברירת מחדל משותפת.
 */
await migrate();

const OWNER_EMAIL = (process.env.OWNER_EMAIL ?? '').trim().toLowerCase();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD ?? '';
const OWNER_NAME = process.env.OWNER_NAME || 'בעלים';

if (!OWNER_EMAIL || OWNER_PASSWORD.length < 8) {
  console.error('צריך להגדיר OWNER_EMAIL ו-OWNER_PASSWORD (8 תווים לפחות) לפני הרצת seed.');
  process.exit(1);
}

let owner = await one('select * from users where lower(email) = $1', [OWNER_EMAIL]);
if (!owner) {
  owner = await one(
    `insert into users (name, email, password_hash, is_owner,
                        perm_content, perm_settings, perm_approve, perm_users)
     values ($1,$2,$3,true,true,true,true,true) returning *`,
    [OWNER_NAME, OWNER_EMAIL, await hashPassword(OWNER_PASSWORD)]
  );
  console.log(`נוצר משתמש בעלים: ${OWNER_EMAIL}`);
} else {
  console.log(`משתמש הבעלים כבר קיים: ${OWNER_EMAIL}`);
}

const existing = await one('select count(*)::int as n from endpoints');
if (existing.n > 0) {
  console.log('כבר יש נתונים — מדלג על מילוי נתוני הפתיחה.');
  await pool.end();
  process.exit(0);
}

/* ---------- נקודות קצה ---------- */
const endpointRows = [
  { name: 'קורס תקציב משפחתי', importance: 9, gap: 7 },
  { name: 'מדריך השקעות חינם', importance: 8, gap: 10 },
  { name: 'ליווי פיננסי אישי', importance: 7, gap: 10 },
];
const ep = {};
for (const e of endpointRows) {
  const row = await one(
    'insert into endpoints (name, importance, min_days_between) values ($1,$2,$3) returning *',
    [e.name, e.importance, e.gap]
  );
  ep[e.name] = row.id;
}

/* ---------- ערוצים ---------- */
const channelRows = [
  { name: 'קבוצת פייסבוק ראשית', max: 5, promo: 1, hybrid: 2, value: null, reserve: 20 },
  { name: 'טלגרם', max: 7, promo: 2, hybrid: null, value: null, reserve: 20 },
  { name: 'אינסטגרם', max: 4, promo: 1, hybrid: null, value: null, reserve: 20 },
  { name: 'ניוזלטר', max: 1, promo: null, hybrid: null, value: null, reserve: 0 },
  { name: 'קבוצת וואטסאפ', max: 3, promo: 1, hybrid: null, value: null, reserve: 20 },
];
const ch = {};
for (const [i, c] of channelRows.entries()) {
  const row = await one(
    `insert into channels (name, max_per_week, max_promo_per_week, max_hybrid_per_week,
                           max_value_per_week, urgent_reserve_pct, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [c.name, c.max, c.promo, c.hybrid, c.value, c.reserve, i]
  );
  ch[c.name] = row.id;
}

/* ---------- קמפיינים ---------- */
const year = new Date().getFullYear();
await query(
  `insert into campaigns (endpoint_id, name, starts_on, ends_on, share_pct, urgent) values
     ($1,'קמפיין רבעון 3',$2,$3,40,false),
     ($1,'⚡ פלאש סייל 48 שעות',$4,$5,null,true),
     ($6,'בניית באזז — וובינר ספטמבר',$7,$3,35,false)`,
  [ep['קורס תקציב משפחתי'], `${year}-07-01`, `${year}-09-30`,
   ymd(new Date()), ymd(new Date(Date.now() + 9 * 86400000)),
   ep['מדריך השקעות חינם'], `${year}-08-01`]
);

/* ---------- תוכן מוכן ---------- */
const fb = ch['קבוצת פייסבוק ראשית'], tg = ch['טלגרם'], nl = ch['ניוזלטר'], wa = ch['קבוצת וואטסאפ'];
await query(
  `insert into content_items (endpoint_id, kind, title, ready_channel_ids) values
     ($1,'promo','פלאש סייל',$2),
     ($1,'value','5 טעויות בתקציב',$3),
     ($1,'hybrid','ניוזלטר אוגוסט',$4),
     ($5,'value','מדריך — פרק 2',$3)`,
  [ep['קורס תקציב משפחתי'], [fb, tg, wa], [fb, tg], [nl], ep['מדריך השקעות חינם']]
);

/* ---------- אסטרטגיה ---------- */
await query(
  `insert into strategy_allocations
     (period_kind, period_label, starts_on, ends_on, endpoint_id, target_pct, label) values
     ('quarter','רבעון 3',$1,$2,$3,40,'קמפיין רבעון 3'),
     ('quarter','רבעון 3',$1,$2,$4,35,'באזז וובינר'),
     ('quarter','רבעון 3',$1,$2,$5,25,'חשיפה שוטפת'),
     ('half','חצי שנה שני',$1,$6,$3,40,'קמפיין רבעון 3'),
     ('half','חצי שנה שני',$7,$6,$5,30,'קמפיין רבעון 4')`,
  [`${year}-07-01`, `${year}-09-30`,
   ep['קורס תקציב משפחתי'], ep['מדריך השקעות חינם'], ep['ליווי פיננסי אישי'],
   `${year}-12-31`, `${year}-10-01`]
);
await query(
  `insert into strategy_milestones (endpoint_id, label, on_date)
   values ($1,'וובינר השקה',$2)`,
  [ep['מדריך השקעות חינם'], `${year}-09-15`]
);

/* ---------- שבוע לדוגמה על הלוח ---------- */
const sun = weekStart(new Date());
const at = (dayOffset, hh, mm = 0) => {
  const d = new Date(sun);
  d.setDate(sun.getDate() + dayOffset);
  d.setHours(hh, mm, 0, 0);
  return d;
};

// null באחראי = טרם הוקצה (דב ועדי עוד לא קיימים כמשתמשים)
const seedPosts = [
  [fb, 'קורס תקציב משפחתי', 'קורס תקציב',        'value',  at(0, 9, 0),  'published', owner.id, false],
  [fb, 'מדריך השקעות חינם', 'מדריך השקעות',      'hybrid', at(2, 19, 0), 'scheduled', null,     false],
  [fb, 'קורס תקציב משפחתי', '⚡ פלאש סייל — קורס', 'promo',  at(3, 10, 0), 'scheduled', owner.id, true],
  [fb, 'ליווי פיננסי אישי', 'ליווי אישי',        'value',  at(4, 9, 30), 'scheduled', null,     false],

  [tg, 'מדריך השקעות חינם', 'מדריך השקעות',      'value',  at(0, 12, 0), 'published', owner.id, false],
  [tg, 'קורס תקציב משפחתי', 'קורס תקציב',        'hybrid', at(1, 18, 0), 'scheduled', owner.id, false],
  [tg, 'ליווי פיננסי אישי', 'מחכה לתוכן',        'value',  at(3, 12, 0), 'hole',      null,     false],
  [tg, 'קורס תקציב משפחתי', '⚡ פלאש סייל — קורס', 'promo',  at(4, 11, 0), 'scheduled', null,     true],
  [tg, 'מדריך השקעות חינם', 'מדריך השקעות',      'value',  at(5, 10, 0), 'scheduled', null,     false],

  [ch['אינסטגרם'], 'קורס תקציב משפחתי', 'ריל · קורס תקציב', 'value',  at(1, 17, 0), 'published', owner.id, false],
  [ch['אינסטגרם'], 'מדריך השקעות חינם', 'סטורי · מדריך',    'hybrid', at(3, 20, 0), 'scheduled', null,     false],
  [ch['אינסטגרם'], 'קורס תקציב משפחתי', 'פלאש סייל · ריל',  'promo',  at(5, 12, 0), 'pending_approval', null, true],

  [nl, 'מדריך השקעות חינם', 'ניוזלטר שבועי', 'hybrid', at(2, 8, 0), 'scheduled', owner.id, false],

  [wa, 'קורס תקציב משפחתי', 'טיפ · קורס תקציב',   'value', at(1, 8, 30), 'published', owner.id, false],
  [wa, 'קורס תקציב משפחתי', '⚡ פלאש סייל — קורס', 'promo', at(4, 12, 0), 'scheduled', null,     true],
];

for (const [channelId, endpointName, title, kind, when, status, assignee, urgent] of seedPosts) {
  await query(
    `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at,
                        status, assignee_id, urgent, published_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [channelId, ep[endpointName], title, kind, when, status, assignee, urgent,
     status === 'published' ? when : null]
  );
}

/* ---------- משימות ---------- */
const today = ymd(new Date());
const scheduledToday = await rows(
  `select p.id, p.title, p.kind, p.scheduled_at, c.name as channel_name
     from posts p join channels c on c.id = p.channel_id
    where p.status = 'scheduled' and p.scheduled_at::date = $1::date`,
  [today]
);
for (const p of scheduledToday) {
  await query(
    `insert into tasks (title, subtitle, kind, post_id, due_on)
     values ($1,$2,'publish',$3,$4)`,
    [`לפרסם: ${p.title} — ${p.channel_name}, ${new Date(p.scheduled_at).toTimeString().slice(0, 5)}`,
     'הטקסט מוכן', p.id, today]
  );
}

const hole = await one(`select id from posts where status = 'hole' limit 1`);
await query(
  `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on)
   values ($1,$2,'write',$3,$4,true,$5)`,
  ['לכתוב: פוסט ערך על "ליווי אישי" לטלגרם',
   'הלוח מחכה לזה — הנקודה הכי רחוקה מפרסום',
   hole?.id ?? null, ep['ליווי פיננסי אישי'], ymd(at(3, 0))]
);

const pending = await one(`select id, title from posts where status = 'pending_approval' limit 1`);
if (pending) {
  await query(
    `insert into tasks (title, subtitle, kind, post_id, due_on)
     values ($1,$2,'approve',$3,$4)`,
    [`לאשר: ${pending.title}`, 'דורש הרשאת אישור דחוף־דורס', pending.id, ymd(at(5, 0))]
  );
}

console.log('נתוני הפתיחה נטענו.');
await pool.end();
