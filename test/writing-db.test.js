import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * שלב 5ב (docs/behavior-improvements.md, סעיפים 19 ו-23) מול Postgres אמיתי:
 * ייבוא טבלה לקמפיין כללי (שורה N ← פוסט N בכל עמודת ערוץ, ייבוא חוזר
 * שמעדכן טיוטות שלא נגעו בהן), כותרת שנגזרת מהטקסט ב-POST/PATCH /content,
 * והלוח שמציג את כותרת התוכן העדכנית.
 *
 * רץ רק במפורש, מול מסד מקומי:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/writing-db.test.js
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, server, base, org;
const pending = new Set();

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  await Promise.all([...pending]);   // ה-commit קורה אחרי שהתשובה נשלחה (כמו בשרת)
  return { status: res.status, json };
}

const inOrg = (fn) => db.withOrg(org, fn);
const q = (sql, params) => inOrg(() => db.rows(sql, params));
const q1 = async (sql, params) => (await q(sql, params))[0] ?? null;
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: campaigns } = await import('../src/routes/campaigns.js');
  const { default: content } = await import('../src/routes/content.js');
  const { default: board } = await import('../src/routes/board.js');

  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('writing-db-test') returning id")).rows[0].id;
  await inOrg(() => db.query('insert into engine_settings (min_gap_days) values (1)'));

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: null, name: 'בדיקה', is_owner: true };
    const p = db.withOrg(org, () => new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    })).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  });
  app.use(campaigns);
  app.use(content);
  app.use(board);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (!RUN) return;
  server?.close();
  await db.pool.end();
});

/** נקודה + קמפיין כללי עם הערוצים הנתונים (שמות) */
async function generalCampaign(name, channelNames, { weeks = 4 } = {}) {
  return inOrg(async () => {
    const ep = (await db.one('insert into endpoints (name, importance) values ($1, 5) returning id',
      [name])).id;
    const chans = [];
    for (const [i, n] of channelNames.entries()) {
      chans.push(await db.one(
        `insert into channels (name, platform, max_per_week, urgent_reserve_pct, sort_order)
         values ($1, 'manual', 7, 0, $2) returning id, name`, [`${n} ${name}`, i]));
    }
    const c = await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, period, min_gap_days)
       values ($1, $2, $3, $4, 'general', 'custom', 1) returning id`,
      [ep, name, inDays(1), inDays(weeks * 7)]);
    for (const ch of chans) {
      await db.query('insert into campaign_channels values ($1, $2)', [c.id, ch.id]);
    }
    return { ep, campaign: c.id, chans };
  });
}

/* ========================= סעיף 23 — כותרת אוטומטית ========================= */

test('סעיף 23 — POST /content בלי כותרת ועם טקסט: הכותרת נגזרת מהשורה הראשונה', { skip }, async () => {
  const g = await generalCampaign('כותרת', ['פייסבוק']);
  const ch = g.chans[0].id;
  const made = await call('POST', '/content', {
    title: '', kind: 'value', campaign_id: g.campaign, slot_channel_id: ch, sort_order: 1,
    body: '\n  הפתיחה של הפוסט  \nוהמשך', fill: false,
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.content.title, 'הפתיחה של הפוסט');

  // בלי כותרת ובלי טקסט — אין ממה לגזור
  const empty = await call('POST', '/content', {
    title: '', kind: 'value', campaign_id: g.campaign, slot_channel_id: ch, sort_order: 2, body: '  ',
  });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /כותרת/);

  // PATCH שמוחק את הכותרת — נגזרת מהטקסט השמור; עם טקסט חדש — ממנו
  const id = made.json.content.id;
  await call('PATCH', `/content/${id}`, { title: 'כותרת ידנית', fill: false });
  const cleared = await call('PATCH', `/content/${id}`, { title: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal(cleared.json.content.title, 'הפתיחה של הפוסט');
  const withBody = await call('PATCH', `/content/${id}`, { title: '', body: 'שורה חדשה' });
  assert.equal(withBody.json.content.title, 'שורה חדשה');
});

test('סעיף 23 — הלוח מציג את כותרת התוכן העדכנית, לא את ההעתק מרגע השיבוץ', { skip }, async () => {
  const g = await generalCampaign('לוח', ['פייסבוק']);
  const ch = g.chans[0].id;
  const item = await q1(
    `insert into content_items (endpoint_id, campaign_id, kind, title, slot_channel_id, sort_order)
     values ($1, $2, 'value', 'הכותרת הישנה', $3, 1) returning id`, [g.ep, g.campaign, ch]);
  await q(`insert into content_variants (content_id, channel_id, body, status)
           values ($1, $2, 'טקסט', 'ready')`, [item.id, ch]);
  const when = new Date(`${inDays(2)}T10:00:00`);
  const withContent = await q1(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
     values ($1, $2, $3, 'הכותרת הישנה', 'value', $4, 'scheduled') returning id`,
    [ch, g.ep, item.id, when]);
  const bare = await q1(
    `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, status)
     values ($1, $2, 'פוסט בלי תוכן', 'value', $3, 'hole') returning id`,
    [ch, g.ep, new Date(when.getTime() + 3600000)]);

  // שינוי שם בתוכן — הכרטיס מתעדכן
  const ren = await call('PATCH', `/content/${item.id}`, { title: 'השם החדש' });
  assert.equal(ren.status, 200, JSON.stringify(ren.json));

  const { buildBoard } = await import('../src/board.js');
  const board = await inOrg(() => buildBoard(inDays(2)));
  const cards = board.channels.find((c) => c.id === ch).days.flatMap((d) => d.posts);
  assert.equal(cards.find((p) => p.id === withContent.id)?.title, 'השם החדש');
  assert.equal(cards.find((p) => p.id === bare.id)?.title, 'פוסט בלי תוכן');

  // חלון הפוסט — אותה כותרת; ההעתק נשאר ב-post_title
  const pv = await call('GET', `/posts/${withContent.id}/preview`);
  assert.equal(pv.json.post.title, 'השם החדש');
  assert.equal(pv.json.post.post_title, 'הכותרת הישנה');
});
