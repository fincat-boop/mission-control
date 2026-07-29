import 'dotenv/config';
import { migrate, one, pool, query, rows, tx } from './db.js';
import { weekStart, ymd } from './board.js';

/**
 * נתוני דמה לחמש נקודות הקצה האמיתיות, על ארבע המדיות.
 *
 * פעולה הרסנית: מוחקת נקודות קצה, קמפיינים, תוכן, שיבוצים ומשימות קיימים.
 * משתמשים, הרשאות וכללי המנוע נשארים.
 *
 *   node src/demo.js --yes
 */
await migrate();

if (!process.argv.includes('--yes')) {
  console.log('הסקריפט מוחק את כל נקודות הקצה, הקמפיינים, התוכן והשיבוצים הקיימים.');
  console.log('להרצה: node src/demo.js --yes');
  await pool.end();
  process.exit(0);
}

const year = new Date().getFullYear();
const D = (m, d) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/* ---------- מדיות ---------- */
// max = תקרה שבועית, target = הקצב הרצוי שממנו נגזרת ההקצאה לקמפיינים
const CHANNELS = [
  { name: 'פייסבוק',  max: 5, target: 4, promo: 1, hybrid: 2, reserve: 20 },
  { name: 'אינסטגרם', max: 5, target: 4, promo: 1, hybrid: 2, reserve: 20 },
  { name: 'ניוזלטר',  max: 1, target: 1, promo: null, hybrid: null, reserve: 0 },
  { name: 'וואטסאפ',  max: 3, target: 2, promo: 1, hybrid: null, reserve: 20 },
];

/* ---------- נקודות קצה ---------- */
const ENDPOINTS = [
  { name: 'כרטיס אשראי חתול פיננסי', importance: 9, gap: 7 },
  { name: 'אתר פינקט', importance: 8, gap: 5 },
  { name: 'וובינר הכה את המומחה', importance: 8, gap: 7 },
  { name: 'סוכנות פנסיונית', importance: 7, gap: 10 },
  { name: 'אפיליאייט ברוקרים', importance: 6, gap: 14 },
];

/* ---------- קמפיינים ---------- */
const CAMPAIGNS = [
  { ep: 'כרטיס אשראי חתול פיננסי', name: 'השקת הכרטיס', goal: 'להביא הנפקות ראשונות',
    from: D(8, 1), to: D(9, 30), share: 30, importance: 9,
    on: ['פייסבוק', 'אינסטגרם', 'ניוזלטר', 'וואטסאפ'] },
  { ep: 'כרטיס אשראי חתול פיננסי', name: '⚡ בלאק פריידי', goal: 'שיא הנפקות בשבוע אחד',
    from: D(11, 20), to: D(12, 5), share: 40, importance: 10, urgent: true,
    on: ['פייסבוק', 'אינסטגרם', 'וואטסאפ'] },
  { ep: 'וובינר הכה את המומחה', name: 'מחזור ספטמבר', goal: 'למלא 300 נרשמים',
    from: D(8, 15), to: D(9, 15), share: 25, importance: 8,
    on: ['פייסבוק', 'ניוזלטר', 'וואטסאפ'] },
  { ep: 'סוכנות פנסיונית', name: 'בדיקת פנסיה שנתית', goal: 'פגישות ייעוץ לסוף השנה',
    from: D(9, 1), to: D(11, 30), share: 20, importance: 7,
    on: ['פייסבוק', 'ניוזלטר'] },
  { ep: 'אתר פינקט', name: 'מחשבוני פינקט', goal: 'תנועה אורגנית לאתר',
    from: D(7, 1), to: D(12, 31), share: 15, importance: 8,
    on: ['פייסבוק', 'אינסטגרם'] },
  { ep: 'אפיליאייט ברוקרים', name: 'השוואת ברוקרים', goal: 'קליקים דרך הקישורים',
    from: D(10, 1), to: D(12, 31), share: 15, importance: 6,
    on: ['פייסבוק', 'ניוזלטר'] },
];

/* ---------- זוויות בתוך קמפיינים ---------- */
const ANGLES = [
  { campaign: 'השקת הכרטיס', kind: 'value',  title: 'כמה באמת עולה לך כרטיס האשראי הנוכחי' },
  { campaign: 'השקת הכרטיס', kind: 'hybrid', title: 'שלושה דברים שבדקנו לפני שהוצאנו כרטיס' },
  { campaign: 'השקת הכרטיס', kind: 'promo',  title: 'הכרטיס פתוח להנפקה' },
  { campaign: '⚡ בלאק פריידי', kind: 'promo', title: 'בלאק פריידי — ההטבה הכי גדולה של השנה' },
  { campaign: 'מחזור ספטמבר', kind: 'value',  title: 'השאלה שכולם שואלים את המומחה' },
  { campaign: 'מחזור ספטמבר', kind: 'hybrid', title: 'מי המומחה של הפעם' },
  { campaign: 'מחזור ספטמבר', kind: 'promo',  title: 'ההרשמה לוובינר נסגרת' },
  { campaign: 'בדיקת פנסיה שנתית', kind: 'value', title: 'ארבעה סעיפים שאף אחד לא בודק בדוח הפנסיה' },
  { campaign: 'בדיקת פנסיה שנתית', kind: 'promo', title: 'בדיקת פנסיה — פגישה ללא עלות' },
  { campaign: 'מחשבוני פינקט', kind: 'value', title: 'מחשבון: כמה ריבית דריבית עובדת בשבילך' },
  { campaign: 'מחשבוני פינקט', kind: 'value', title: 'מחשבון: מסלול משכנתא מול מסלול' },
  { campaign: 'השוואת ברוקרים', kind: 'hybrid', title: 'איך בוחרים ברוקר בלי ליפול על עמלות' },
];

/* ---------- תוכן ערך שוטף ---------- */
// בלי קמפיין ובלי תאריכים. רץ ברקע, והמנוע שולף ממנו כשנשאר שטח.
const BACKGROUND = [
  { ep: 'אתר פינקט', kind: 'value', every: 21, title: 'טיפ השבוע מהמחשבונים' },
  { ep: 'אתר פינקט', kind: 'value', every: 30, title: 'מונח פיננסי בשתי שורות' },
  { ep: 'אתר פינקט', kind: 'value', every: 45, title: 'שאלה מהקהילה — ותשובה' },
  { ep: 'כרטיס אשראי חתול פיננסי', kind: 'value', every: 30, title: 'הרגל אחד שחוסך בכרטיס' },
  { ep: 'כרטיס אשראי חתול פיננסי', kind: 'value', every: 45, title: 'איך קוראים דוח אשראי' },
  { ep: 'סוכנות פנסיונית', kind: 'value', every: 30, title: 'מיתוס פנסיוני שכדאי לשכוח' },
  { ep: 'סוכנות פנסיונית', kind: 'value', every: 60, title: 'מה זה דמי ניהול, בעברית' },
  { ep: 'וובינר הכה את המומחה', kind: 'value', every: 30, title: 'רגע מהוובינר הקודם' },
  { ep: 'אפיליאייט ברוקרים', kind: 'value', every: 45, title: 'עמלה נסתרת שכדאי להכיר' },
];

/* ---------- ניקוי ---------- */
await tx(async (c) => {
  await c.query('delete from tasks');
  await c.query('delete from posts');
  await c.query('delete from content_items');   // גורר גרסאות וקבצים
  await c.query('delete from campaigns');       // גורר campaign_channels
  await c.query('delete from strategy_milestones');
  await c.query('delete from endpoints');
  await c.query('delete from channels');
});
console.log('הנתונים הישנים נוקו.');

/* ---------- בנייה ---------- */
const ch = {};
for (const [i, c] of CHANNELS.entries()) {
  const row = await one(
    `insert into channels (name, max_per_week, target_per_week, max_promo_per_week,
                           max_hybrid_per_week, urgent_reserve_pct, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [c.name, c.max, c.target, c.promo, c.hybrid, c.reserve, i]
  );
  ch[c.name] = row.id;
}

const ep = {};
for (const e of ENDPOINTS) {
  const row = await one(
    'insert into endpoints (name, importance, min_days_between) values ($1,$2,$3) returning *',
    [e.name, e.importance, e.gap]
  );
  ep[e.name] = row.id;
}

const camp = {};
for (const c of CAMPAIGNS) {
  const row = await one(
    `insert into campaigns (endpoint_id, name, goal, starts_on, ends_on,
                            share_pct, importance, urgent)
     values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,false)) returning *`,
    [ep[c.ep], c.name, c.goal, c.from, c.to, c.share, c.importance, c.urgent ?? null]
  );
  camp[c.name] = row.id;
  for (const name of c.on) {
    await query('insert into campaign_channels (campaign_id, channel_id) values ($1,$2)',
      [row.id, ch[name]]);
  }
}

/** פותח גרסה לכל מדיה, ומסמן חלק מהן כמוכנות כדי שהרשת לא תהיה ריקה לגמרי */
async function addVariants(contentId, channelNames, readyCount) {
  for (const [i, name] of channelNames.entries()) {
    const ready = i < readyCount;
    await query(
      `insert into content_variants (content_id, channel_id, body, status)
       values ($1,$2,$3,$4)`,
      [contentId, ch[name],
       ready ? 'טיוטת הטקסט למדיה הזו — לעריכה לפני פרסום.' : '',
       ready ? 'ready' : 'draft']
    );
  }
}

const campaignOf = (name) => CAMPAIGNS.find((c) => c.name === name);
const order = {};

for (const a of ANGLES) {
  const c = campaignOf(a.campaign);
  order[a.campaign] = (order[a.campaign] ?? 0) + 1;
  const item = await one(
    `insert into content_items (endpoint_id, campaign_id, kind, title,
                                ready_channel_ids, sort_order)
     values ($1,$2,$3,$4,$5::int[],$6) returning *`,
    [ep[c.ep], camp[a.campaign], a.kind, a.title, c.on.map((n) => ch[n]), order[a.campaign]]
  );
  // הזווית הראשונה בכל קמפיין מוכנה בכל המדיות, השאר חלקית
  await addVariants(item.id, c.on, order[a.campaign] === 1 ? c.on.length : 1);
}

const allChannels = CHANNELS.map((c) => c.name);
for (const b of BACKGROUND) {
  const item = await one(
    `insert into content_items (endpoint_id, kind, title, ready_channel_ids,
                                evergreen, reuse_after_days)
     values ($1,$2,$3,$4::int[],true,$5) returning *`,
    [ep[b.ep], b.kind, b.title, allChannels.map((n) => ch[n]), b.every]
  );
  await addVariants(item.id, allChannels, 2);
}

/* ---------- אבני דרך ---------- */
await query(
  `insert into strategy_milestones (endpoint_id, label, on_date) values
     ($1,'וובינר בשידור חי',$2), ($3,'עליית הכרטיס לאוויר',$4)`,
  [ep['וובינר הכה את המומחה'], D(9, 15), ep['כרטיס אשראי חתול פיננסי'], D(8, 1)]
);

/* ---------- שבוע לדוגמה על הלוח ---------- */
const sun = weekStart(new Date());
const at = (day, hh, mm = 0) => {
  const d = new Date(sun);
  d.setDate(sun.getDate() + day);
  d.setHours(hh, mm, 0, 0);
  return d;
};
const owner = await one('select id from users where is_owner = true');

const readyContent = await rows(
  `select ci.id, ci.title, ci.kind, ci.endpoint_id, v.channel_id
     from content_items ci
     join content_variants v on v.content_id = ci.id and v.status = 'ready'
    order by ci.id limit 9`
);

const now = new Date();
for (const [i, c] of readyContent.entries()) {
  const when = at(i % 6, 9 + (i % 4) * 3);
  // רק מה שכבר עבר מסומן כפורסם — אחרת "ימים בלי פרסום" יוצא שלילי
  const published = i < 4 && when < now;
  await query(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind,
                        scheduled_at, status, assignee_id, published_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [c.channel_id, c.endpoint_id, c.id, c.title, c.kind, when,
     published ? 'published' : 'scheduled', owner?.id ?? null, published ? when : null]
  );
}

/* ---------- משימות ---------- */
const today = ymd(new Date());
const todays = await rows(
  `select p.id, p.title, c.name as channel_name, p.scheduled_at
     from posts p join channels c on c.id = p.channel_id
    where p.status = 'scheduled' and p.scheduled_at::date = $1::date`,
  [today]
);
for (const p of todays) {
  await query(
    `insert into tasks (title, subtitle, kind, post_id, due_on)
     values ($1,'הטקסט מוכן','publish',$2,$3)`,
    [`לפרסם: ${p.title} — ${p.channel_name}`, p.id, today]
  );
}

/* ---------- סיכום ---------- */
const counts = await one(`select
  (select count(*) from endpoints)::int as endpoints,
  (select count(*) from channels)::int as channels,
  (select count(*) from campaigns)::int as campaigns,
  (select count(*) from content_items)::int as content,
  (select count(*) from content_items where campaign_id is null)::int as background,
  (select count(*) from content_variants)::int as variants,
  (select count(*) from posts)::int as posts,
  (select count(*) from tasks)::int as tasks`);

console.log('\nנוצר:');
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

await pool.end();
