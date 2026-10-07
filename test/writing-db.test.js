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

/* ========================= סעיף 19 — ייבוא לקמפיין כללי ========================= */

/** הפריטים של הקמפיין לפי "ערוץ:מספר" */
async function slotMap(campaignId) {
  const list = await q(
    `select ci.id, ci.slot_channel_id, ci.sort_order, ci.title, ci.kind, ci.import_batch,
            v.body, v.status
       from content_items ci
       left join content_variants v on v.content_id = ci.id and v.channel_id = ci.slot_channel_id
      where ci.campaign_id = $1`, [campaignId]);
  return new Map(list.map((x) => [`${x.slot_channel_id}:${x.sort_order}`, x]));
}

test('סעיף 19 — ייבוא לקמפיין כללי: שורה N ← פוסט N בכל ערוץ, תא ריק = אין פוסט', { skip }, async () => {
  const g = await generalCampaign('ייבוא כללי', ['פייסבוק', 'אינסטגרם', 'טוויטר']);
  const [fb, ig, x] = g.chans;
  const text = [
    ['כותרת', 'סוג', fb.name, ig.name, x.name].join('\t'),
    ['פתיחה', 'מכירתי', 'fb אחת', 'ig אחת', 'x אחת'].join('\t'),
    // תא עם כמה שורות מגיע מאקסל במרכאות
    ['', '', '"fb שתיים\nהמשך"', '', 'x שתיים'].join('\t'),
  ].join('\n');

  const pv = await call('POST', `/campaigns/${g.campaign}/import/preview`, { text });
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  assert.equal(pv.json.structure, 'general');
  assert.equal(pv.json.totals.to_create, 5);
  assert.equal(pv.json.totals.errors, 0);
  // התצוגה המקדימה לא כותבת
  assert.equal((await slotMap(g.campaign)).size, 0);

  const imp = await call('POST', `/campaigns/${g.campaign}/import`,
    { text, mark_ready: true, week: inDays(1) });
  assert.equal(imp.status, 201, JSON.stringify(imp.json));
  assert.equal(imp.json.created, 5);
  assert.ok(imp.json.engine, 'מילוי אחד אחרי הייבוא');
  assert.ok(imp.json.engine.placed > 0, JSON.stringify(imp.json.engine.summary));

  const m = await slotMap(g.campaign);
  assert.equal(m.size, 5);
  for (const ch of [fb, ig, x]) assert.equal(m.get(`${ch.id}:1`)?.title, 'פתיחה');
  assert.equal(m.get(`${fb.id}:1`).kind, 'promo');
  assert.equal(m.get(`${fb.id}:1`).body, 'fb אחת');
  assert.equal(m.get(`${fb.id}:1`).status, 'ready');
  assert.equal(m.get(`${fb.id}:2`).body, 'fb שתיים\nהמשך');
  // בלי כותרת — נגזרת מהשורה הראשונה של התא
  assert.equal(m.get(`${fb.id}:2`).title, 'fb שתיים');
  assert.equal(m.get(`${x.id}:2`).title, 'x שתיים');
  assert.equal(m.get(`${fb.id}:2`).kind, 'value');
  assert.ok(!m.has(`${ig.id}:2`), 'תא ריק — אין פוסט');
  assert.ok([...m.values()].every((it) => it.import_batch === imp.json.batch));

  // כל פוסט שובץ לכל היותר פעם אחת (מילוי אחד לקמפיין, לא לכל פריט)
  const dup = await q(
    `select content_id, count(*)::int as n from posts
      where content_id = any($1::int[]) group by content_id having count(*) > 1`,
    [[...m.values()].map((it) => it.id)]);
  assert.deepEqual(dup, []);
});

test('סעיף 19 — ייבוא חוזר: ברירת מחדל מדלגת; "עדכן" מעדכן רק טיוטות שלא נגעו בהן', { skip }, async () => {
  const g = await generalCampaign('ייבוא חוזר', ['פייסבוק', 'אינסטגרם']);
  const [fb, ig] = g.chans;
  const table = (suffix, extra = []) => [
    ['כותרת', fb.name, ig.name].join('\t'),
    ['א', `fb א${suffix}`, `ig א${suffix}`].join('\t'),
    ['ב', `fb ב${suffix}`, `ig ב${suffix}`].join('\t'),
    ...extra,
  ].join('\n');

  const first = await call('POST', `/campaigns/${g.campaign}/import`, { text: table('') });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.created, 4);

  // מישהו ערך את fb · פוסט 1 — כבר לא "לא נגעו בו"
  const fb1 = (await slotMap(g.campaign)).get(`${fb.id}:1`);
  const edit = await call('PATCH', `/content/${fb1.id}`, { body: 'נערך ביד' });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));

  // ברירת המחדל: מדלגים, והתצוגה אומרת כמה אפשר לעדכן
  const skipPv = await call('POST', `/campaigns/${g.campaign}/import/preview`,
    { text: table(' (תוקן)', [['ג', 'fb ג', ''].join('\t')]) });
  assert.equal(skipPv.json.totals.to_create, 1);
  assert.equal(skipPv.json.totals.to_update, 0);
  assert.equal(skipPv.json.totals.updatable, 3);
  assert.equal(skipPv.json.totals.skipped, 4);

  const updPv = await call('POST', `/campaigns/${g.campaign}/import/preview`,
    { text: table(' (תוקן)'), existing: 'update' });
  assert.equal(updPv.json.totals.to_update, 3);
  assert.equal(updPv.json.totals.to_create, 0);

  const second = await call('POST', `/campaigns/${g.campaign}/import`,
    { text: table(' (תוקן)', [['ג', 'fb ג', ''].join('\t')]), existing: 'update' });
  assert.equal(second.status, 201, JSON.stringify(second.json));
  assert.equal(second.json.updated, 3);
  assert.equal(second.json.created, 1);
  let m = await slotMap(g.campaign);
  assert.equal(m.get(`${fb.id}:1`).body, 'נערך ביד', 'מה שנערך ביד לא נדרס');
  assert.equal(m.get(`${ig.id}:1`).body, 'ig א (תוקן)');
  assert.equal(m.get(`${fb.id}:2`).body, 'fb ב (תוקן)');
  assert.equal(m.get(`${fb.id}:3`).body, 'fb ג');
  // עודכן — שומר את המנה המקורית; "בטל ייבוא" של המנה השנייה מוחק רק את מה שהיא יצרה
  assert.equal(m.get(`${ig.id}:1`).import_batch, first.json.batch);

  // ייבוא שלישי: מה שהייבוא עדכן עדיין "לא נגעו בו"
  const third = await call('POST', `/campaigns/${g.campaign}/import/preview`,
    { text: table(' (שוב)'), existing: 'update' });
  assert.equal(third.json.totals.to_update, 3);

  const undo = await call('DELETE', `/campaigns/${g.campaign}/import/${second.json.batch}`);
  assert.equal(undo.status, 200, JSON.stringify(undo.json));
  assert.deepEqual(undo.json, { removed: 1, kept: 0 });
  m = await slotMap(g.campaign);
  assert.ok(!m.has(`${fb.id}:3`));
  assert.equal(m.get(`${ig.id}:1`).body, 'ig א (תוקן)');
  assert.equal(m.size, 4);
});

test('סעיף 19 — ייבוא לכללי: סוג לא מוכר = שגיאה; עמודת ערוץ שלא בקמפיין לא נכנסת', { skip }, async () => {
  const g = await generalCampaign('שגיאות', ['פייסבוק']);
  const other = await q1(
    `insert into channels (name, platform, max_per_week) values ('ערוץ זר שגיאות', 'manual', 7)
     returning id, name`);
  const bad = await call('POST', `/campaigns/${g.campaign}/import/preview`, {
    text: `סוג\t${g.chans[0].name}\nמשהו\tטקסט`,
  });
  assert.equal(bad.json.totals.errors, 1);
  const out = await call('POST', `/campaigns/${g.campaign}/import`, {
    text: `${g.chans[0].name}\t${other.name}\nטקסט\tזר`,
  });
  assert.equal(out.status, 201, JSON.stringify(out.json));
  assert.equal(out.json.created, 1);
  const m = await slotMap(g.campaign);
  assert.equal(m.size, 1);
  assert.ok(m.has(`${g.chans[0].id}:1`));
});

test('סעיף 19 — קישור עמודות: פוסט מיובא מועתק לעמודת היעד, אלא אם הטבלה ממלאת אותה', { skip }, async () => {
  const g = await generalCampaign('קישור ייבוא', ['פייסבוק', 'אינסטגרם']);
  const [fb, ig] = g.chans;
  await q('update campaigns set link_rules = $2::jsonb where id = $1',
    [g.campaign, JSON.stringify([{ from: fb.id, to: ig.id }])]);

  const only = await call('POST', `/campaigns/${g.campaign}/import`,
    { text: `${fb.name}\nאחת\nשתיים` });
  assert.equal(only.status, 201, JSON.stringify(only.json));
  assert.equal(only.json.created, 2);
  assert.equal(only.json.copied, 2);
  const followers = await q(
    `select count(*)::int as n from content_items
      where campaign_id = $1 and slot_channel_id = $2 and linked_to_id is not null`, [g.campaign, ig.id]);
  assert.equal(followers[0].n, 2);

  // "בטל ייבוא" — גם העותקים שקישור העמודות יצר יורדים עם המקור
  const undo = await call('DELETE', `/campaigns/${g.campaign}/import/${only.json.batch}`);
  assert.deepEqual(undo.json, { removed: 4, kept: 0 });
  assert.equal((await slotMap(g.campaign)).size, 0);
  const again = await call('POST', `/campaigns/${g.campaign}/import`,
    { text: `${fb.name}\nאחת\nשתיים` });
  assert.equal(again.json.copied, 2);

  // הטבלה ממלאת גם את היעד — בלי העתקה (אחרת כפילות), ואזהרה בתצוגה
  const both = `${fb.name}\t${ig.name}\nא\tב\nג\tד\nה\tו`;
  const pv = await call('POST', `/campaigns/${g.campaign}/import/preview`, { text: both });
  assert.ok(pv.json.warnings.some((w) => /קישור העמודות/.test(w)), JSON.stringify(pv.json.warnings));
  const imp = await call('POST', `/campaigns/${g.campaign}/import`, { text: both });
  assert.equal(imp.json.copied, 0);
  assert.equal(imp.json.created, 2, 'שורות 1–2 תפוסות; שורה 3 נוצרת בשני הערוצים');
});
