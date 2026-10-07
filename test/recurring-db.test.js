import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * קמפיין מחזורי מול Postgres אמיתי: סימון, "שבץ מחדש" (העתקה מלאה של התוכן
 * עם המצבים, ה-meta של ניוזלטר, הקישורים והקבצים), "מוכן" שעובר להרצה אבל
 * לא לשכפול רגיל, הרשימה בלוח האסטרטגיה, ובידוד בין ארגונים/הרשאות.
 * הנתיבים רצים באפליקציית express קטנה, כל בקשה בתוך withOrg — כמו בשרת.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני:
 *   RECURRING_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5515/mc_recur node --test test/recurring-db.test.js
 * (בלי המשתנים — מדולג, כדי ש-npm test לא ייגע במסד.)
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.RECURRING_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (RECURRING_TEST_DB=1 + DATABASE_URL מקומי)';

// R2 מדומה: הכתובת הציבורית נגזרת מהמשתנים, וההעתקה נרשמת במקום לצאת לרשת
process.env.R2_ACCOUNT_ID ??= 'acc';
process.env.R2_ACCESS_KEY_ID ??= 'key';
process.env.R2_SECRET_ACCESS_KEY ??= 'secret';
process.env.R2_BUCKET ??= 'backup';
process.env.R2_PUBLIC_BUCKET ??= 'media-test';
process.env.R2_PUBLIC_BASE_URL ??= 'https://media.example.test';

let db, server, base, org, otherOrg, ids, copies;
const pending = new Set();

/** בקשה לנתיב. as: 'other' = ארגון אחר, 'viewer' = משתמש בלי הרשאות */
async function call(method, path, body, { as } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (as) headers['x-test-as'] = as;
  const res = await fetch(`${base}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  await Promise.all([...pending]);   // ה-commit קורה אחרי שהתשובה נשלחה (כמו בשרת)
  return { status: res.status, json };
}

const q = (sql, params) => db.withOrg(org, () => db.rows(sql, params));
const q1 = async (sql, params) => (await q(sql, params))[0] ?? null;
const campaign = (id) => q1('select * from campaigns where id = $1', [id]);

/** כל התוכן של קמפיין בצורה שאפשר להשוות בין מקור לעותק (בלי מזהים) */
async function contentShape(campaignId) {
  const items = await q(
    'select * from content_items where campaign_id = $1 order by slot_channel_id, sort_order, id',
    [campaignId]);
  const pos = new Map(items.map((x, i) => [x.id, i]));
  const out = [];
  for (const it of items) {
    const vs = await q(
      'select channel_id, body, status, meta from content_variants where content_id = $1 order by channel_id',
      [it.id]);
    const as = await q(
      `select filename, mime, size_bytes, (data is not null) as bytes, (storage_key is not null) as r2,
              (variant_id is not null) as own
         from content_assets where content_id = $1 order by id`, [it.id]);
    out.push({
      title: it.title, kind: it.kind, body: it.body, sort_order: it.sort_order,
      slot_channel_id: it.slot_channel_id, evergreen: it.evergreen,
      // הקישור לפי מיקום בתוך הקמפיין — עותק מקושר לעותק, לא למקור
      linked_to: it.linked_to_id == null ? null : pos.get(it.linked_to_id) ?? 'outside',
      variants: vs, assets: as,
    });
  }
  return out;
}

/** משבצת בקמפיין כללי, דרך הנתיב — כמו הטופס */
async function slot(campaignId, channelId, sortOrder, over = {}) {
  const r = await call('POST', '/content', {
    title: `פוסט ${channelId}/${sortOrder}`, kind: 'value', campaign_id: campaignId,
    slot_channel_id: channelId, sort_order: sortOrder, body: 'טקסט', status: 'draft', ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.content.id;
}

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: content } = await import('../src/routes/content.js');
  const { default: campaigns } = await import('../src/routes/campaigns.js');
  const { default: strategy } = await import('../src/routes/strategy.js');
  const { mediaStore } = await import('../src/media.js');

  await db.migrate();
  copies = [];
  mediaStore.copy = async (src, dst) => { copies.push([src, dst]); };

  const mkOrg = async (name) =>
    (await db.pool.query('insert into orgs (name) values ($1) returning id', [name])).rows[0].id;
  org = await mkOrg('recurring-test');
  otherOrg = await mkOrg('recurring-other');
  await db.withOrg(otherOrg, () => db.query('insert into engine_settings default values'));

  ids = await db.withOrg(org, async () => {
    await db.query('insert into engine_settings default values');
    const ep = await db.one("insert into endpoints (name, importance) values ('קורס', 8) returning id");
    const ch = async (name, platform) => (await db.one(
      'insert into channels (name, platform, max_per_week) values ($1,$2,3) returning id',
      [name, platform])).id;
    return {
      endpoint: ep.id,
      ig: await ch('אינסטגרם ריל', 'instagram'),
      yt: await ch('יוטיוב שורטס', 'manual'),
      nl: await ch('ניוזלטר', 'newsletter'),
    };
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const as = req.get('x-test-as');
    req.user = as === 'viewer'
      ? { id: null, name: 'צופה', is_owner: false }
      : { id: null, name: 'בדיקה', is_owner: true };
    const p = db.withOrg(as === 'other' ? otherOrg : org, () => new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    })).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  });
  app.use(content);
  app.use(campaigns);
  app.use(strategy);
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

/** קמפיין כללי חודשי עם כל סוגי התוכן: מוכן/טיוטה, ניוזלטר עם נושא, קישור, קבצים */
async function template(name, { start = '2027-01-31' } = {}) {
  const r = await call('POST', '/campaigns', {
    name, endpoint_id: ids.endpoint, starts_on: start, period: '1m', structure: 'general',
    goal: 'הרשמות', share_pct: 40, channel_ids: [ids.ig, ids.yt, ids.nl],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const id = r.json.campaign.id;

  // טיוטה קודם: "מוכן" באינסטגרם דורש מדיה (גל 4, readiness.js) — מסמנים אחרי הקבצים
  const reel = await slot(id, ids.ig, 1, { title: 'ריל פתיחה', body: 'הטקסט המשותף' });
  await slot(id, ids.ig, 2, { title: 'ריל שני', body: 'עוד לא גמור' });
  // קובץ ב-R2 + קובץ ישן (bytea) על המקור
  await q(`insert into content_assets (content_id, filename, mime, size_bytes, storage_key)
           values ($1,'reel.mp4','video/mp4',100,$2)`,
          [reel, `media/${org}/${crypto.randomUUID()}/reel.mp4`]);
  await q(`insert into content_assets (content_id, filename, mime, size_bytes, data)
           values ($1,'cover.png','image/png',7,'\\x504e4744415441')`, [reel]);
  const ready = await call('PATCH', `/content/${reel}`, { status: 'ready' });
  assert.equal(ready.status, 200, JSON.stringify(ready.json));
  // עוקבת ביוטיוב: אותו תוכן, הקבצים נקראים מהמקור
  const link = await call('POST', `/content/${reel}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 1 },
  });
  assert.equal(link.status, 200, JSON.stringify(link.json));

  const mail = await slot(id, ids.nl, 1, { title: 'ניוזלטר', body: '<p>שלום</p>' });
  const v = await call('PUT', `/content/${mail}/variants/${ids.nl}`, {
    body: '<p>שלום</p>', status: 'ready',
    meta: { subject: 'נפתחה ההרשמה', list_ids: ['L1'], segment_ids: [] },
  });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return id;
}

test('סימון קמפיין מחזורי: PATCH recurring, ערך לא בוליאני נדחה, צופה בלי הרשאה נחסם', { skip }, async () => {
  const id = await template('סימון');
  assert.equal((await campaign(id)).recurring, false);

  const bad = await call('PATCH', `/campaigns/${id}`, { recurring: 'yes' });
  assert.equal(bad.status, 400);
  const denied = await call('PATCH', `/campaigns/${id}`, { recurring: true }, { as: 'viewer' });
  assert.equal(denied.status, 403);

  const before = await campaign(id);
  const on = await call('PATCH', `/campaigns/${id}`, { recurring: true, week: '2027-02-01' });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  // דגל בלבד: בלי מילוי אוטומטי (תשובת מילוי ריקה, אותה צורה)
  assert.equal(on.json.campaign.recurring, true);
  assert.equal(on.json.engine.placed, 0);
  assert.deepEqual(on.json.engine.created_ids, []);
  const after = await campaign(id);
  assert.equal(after.recurring, true);
  // שום דבר אחר לא זז
  for (const k of ['name', 'starts_on', 'ends_on', 'period', 'content_complete_at']) {
    assert.deepEqual(after[k], before[k], k);
  }

  const off = await call('PATCH', `/campaigns/${id}`, { recurring: false });
  assert.equal(off.status, 200);
  assert.equal((await campaign(id)).recurring, false);
});

test('שבץ מחדש: עותק מלא — הגדרות, תוכן עם המצבים, meta של ניוזלטר, קישורים וקבצים; התבנית לא משתנה', { skip }, async () => {
  const id = await template('השקה');

  // לא מחזורי עדיין — אי אפשר לשבץ מחדש
  const not = await call('POST', `/campaigns/${id}/replace`, { starts_on: '2027-03-31' });
  assert.equal(not.status, 409);
  await call('PATCH', `/campaigns/${id}`, { recurring: true });

  const tplBefore = await campaign(id);
  const shapeBefore = await contentShape(id);
  const copiesBefore = copies.length;

  const missing = await call('POST', `/campaigns/${id}/replace`, {});
  assert.equal(missing.status, 400);
  // תאריך לא אמיתי / בעבר — 400 לפני שום העתקה ב-R2
  for (const starts_on of ['2027-02-30', '31.3.2027', '2020-01-05']) {
    const r = await call('POST', `/campaigns/${id}/replace`, { starts_on });
    assert.equal(r.status, 400, starts_on);
  }
  const past = await call('POST', `/campaigns/${id}/replace`, { starts_on: '2020-01-05' });
  assert.match(past.json.error, /כבר עבר/);
  const badEnd = await call('POST', `/campaigns/${id}/replace`,
    { starts_on: '2027-03-31', period: 'custom', ends_on: '2027-04-31' });
  assert.equal(badEnd.status, 400);
  assert.equal(copies.length, copiesBefore, 'שום קובץ לא הועתק');
  const newBad = await call('POST', '/campaigns', {
    name: 'שבור', endpoint_id: ids.endpoint, starts_on: '2027-02-30', period: '1m', structure: 'general',
  });
  assert.equal(newBad.status, 400);
  assert.match(newBad.json.error, /לא תקין/);

  const r = await call('POST', `/campaigns/${id}/replace`, { starts_on: '2027-03-31' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const c = await campaign(r.json.campaign.id);

  // שם ברירת המחדל, אותה תקופה והסיום מחושב מחדש (חודש מ-31.3 → 30.4)
  assert.equal(c.name, 'השקה · מרץ 2027');
  assert.equal(c.period, '1m');
  assert.equal(tplBefore.ends_on, '2027-02-28');
  assert.equal(c.starts_on, '2027-03-31');
  assert.equal(c.ends_on, '2027-04-30');
  for (const k of ['endpoint_id', 'structure', 'goal', 'share_pct', 'target_posts']) {
    assert.deepEqual(c[k], tplBefore[k], k);
  }
  assert.equal(c.recurring, false, 'עותק אינו מחזורי');
  assert.equal(c.template_id, id);
  assert.equal(c.content_complete_at, null, 'התבנית לא מוכנה — גם ההרצה לא');
  const chans = await q('select channel_id from campaign_channels where campaign_id = $1 order by 1', [c.id]);
  assert.deepEqual(chans.map((x) => x.channel_id), [ids.ig, ids.yt, ids.nl].sort((a, b) => a - b));

  // אותו תוכן בדיוק: מצבים (מוכן נשאר מוכן), meta, קישור (לעותק), קבצים
  const shape = await contentShape(c.id);
  assert.deepEqual(shape, shapeBefore);
  const mail = shape.find((x) => x.slot_channel_id === ids.nl);
  assert.equal(mail.variants[0].meta.subject, 'נפתחה ההרשמה');
  assert.equal(mail.variants[0].status, 'ready');
  assert.ok(shape.some((x) => x.linked_to != null && x.linked_to !== 'outside'));
  assert.equal(r.json.copied.links, 1);
  // קובץ ה-R2 הועתק לאובייקט חדש
  assert.equal(copies.length, copiesBefore + 1);
  const [src, dst] = copies.at(-1);
  assert.notEqual(src, dst);
  assert.ok((await q('select 1 from content_assets where storage_key = $1', [dst])).length);

  // התבנית עצמה לא השתנתה
  assert.deepEqual(await campaign(id), tplBefore);
  assert.deepEqual(await contentShape(id), shapeBefore);

  // שם מהטופס ותקופה אחרת
  const r2 = await call('POST', `/campaigns/${id}/replace`,
    { starts_on: '2027-06-01', name: '  השקה — קיץ  ', period: '2w' });
  assert.equal(r2.status, 201, JSON.stringify(r2.json));
  const c2 = await campaign(r2.json.campaign.id);
  assert.equal(c2.name, 'השקה — קיץ');
  assert.equal(c2.period, '2w');
  assert.equal(c2.ends_on, '2027-06-14');
});

test('"מוכן" עובר להרצה של קמפיין מחזורי, אבל לא לשכפול רגיל; שכפול שומר גם meta', { skip }, async () => {
  const id = await template('מוכן');
  const done = await call('POST', `/campaigns/${id}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.json));
  await call('PATCH', `/campaigns/${id}`, { recurring: true });

  const r = await call('POST', `/campaigns/${id}/replace`, { starts_on: '2027-05-01' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const run = await campaign(r.json.campaign.id);
  assert.ok(run.content_complete_at, 'ההרצה מוכנה כמו התבנית');

  // שכפול רגיל של אותו קמפיין מוכן — מתחיל לא מוכן, לא מחזורי ובלי template_id.
  // אחרי ההרצה (1.5–31.5), כדי לא לחפוף לה
  const tpl = await campaign(id);
  const d = await call('POST', `/campaigns/${id}/duplicate`, {
    name: 'מוכן (עותק)', endpoint_id: ids.endpoint, starts_on: '2027-07-01', period: '1m',
    channel_ids: [ids.ig, ids.yt, ids.nl],
  });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  const dup = await campaign(d.json.campaign.id);
  assert.equal(dup.content_complete_at, null);
  assert.equal(dup.recurring, false);
  assert.equal(dup.template_id, null);
  assert.ok(tpl.recurring);
  // ה-meta של ניוזלטר נשמר גם בשכפול (קודם ירד)
  const meta = await q1(
    `select v.meta from content_variants v join content_items ci on ci.id = v.content_id
      where ci.campaign_id = $1 and v.channel_id = $2`, [dup.id, ids.nl]);
  assert.equal(meta.meta.subject, 'נפתחה ההרשמה');
});

test('הרצה חופפת לתבנית או להרצה קודמת — 409 עם השם והתאריכים; יום אחרי הסוף — עובר', { skip }, async () => {
  const id = await template('חפיפה', { start: '2027-08-01' });   // 1.8–31.8
  await call('PATCH', `/campaigns/${id}`, { recurring: true });
  const before = (await q('select count(*)::int as n from campaigns')).at(0).n;

  // חופף לתבנית עצמה
  const onTpl = await call('POST', `/campaigns/${id}/replace`, { starts_on: '2027-08-20' });
  assert.equal(onTpl.status, 409, JSON.stringify(onTpl.json));
  assert.equal(onTpl.json.error,
    "הסבב החדש חופף לסבב 'חפיפה' (1.8–31.8). בוחרים תאריך התחלה אחרי 31.8.");
  assert.equal((await q('select count(*)::int as n from campaigns')).at(0).n, before, 'לא נוצר כלום');

  // יום אחרי הסוף — עובר; ואז הרצה שחופפת להרצה הזו (לא לתבנית) נדחית
  const next = await call('POST', `/campaigns/${id}/replace`, { starts_on: '2027-09-01', period: '2w' });
  assert.equal(next.status, 201, JSON.stringify(next.json));
  const onRun = await call('POST', `/campaigns/${id}/replace`, { starts_on: '2027-09-10' });
  assert.equal(onRun.status, 409);
  assert.match(onRun.json.error, /חופף לסבב 'חפיפה · ספטמבר 2027' \(1\.9–14\.9\)/);
  // מסתיים לפני הרצה מאוחרת יותר שכבר קיימת — ההצעה היא לסיים לפניה
  const late = await call('POST', `/campaigns/${id}/replace`,
    { starts_on: '2027-07-20', period: 'custom', ends_on: '2027-08-05' });
  assert.equal(late.status, 409);
  assert.match(late.json.error, /בוחרים תקופה שמסתיימת לפני 1\.8/);

  // שכפול של התבנית או של הרצה — אותה בדיקה; בנקודת קצה אחרת — אין חפיפה
  const dupRun = await call('POST', `/campaigns/${next.json.campaign.id}/duplicate`, {
    name: 'עותק', endpoint_id: ids.endpoint, starts_on: '2027-08-31', period: '1w',
    channel_ids: [ids.ig],
  });
  assert.equal(dupRun.status, 409);
  assert.match(dupRun.json.error, /חופף לסבב/);
  const other = await q1("insert into endpoints (name, importance) values ('אחרת', 5) returning id");
  const dupOther = await call('POST', `/campaigns/${id}/duplicate`, {
    name: 'עותק אחר', endpoint_id: other.id, starts_on: '2027-08-10', period: '1w',
    channel_ids: [ids.ig],
  });
  assert.equal(dupOther.status, 201, JSON.stringify(dupOther.json));
  const after = await call('POST', `/campaigns/${id}/replace`, { starts_on: '2027-09-15' });
  assert.equal(after.status, 201, JSON.stringify(after.json));
});

test('תקופה ידנית / בלי סוף: אותו מספר ימים, ובלי תאריך סיום צריך לבחור', { skip }, async () => {
  const c = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, period, recurring)
     values ($1,'ידני','2027-01-01','2027-01-10','general','custom',true) returning id`, [ids.endpoint]);
  const r = await call('POST', `/campaigns/${c.id}/replace`, { starts_on: '2027-02-25' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const run = await campaign(r.json.campaign.id);
  assert.equal(run.period, 'custom');
  assert.equal(run.ends_on, '2027-03-06');   // 10 ימים כולל, דרך סוף פברואר

  const open = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, period, recurring)
     values ($1,'פתוח','2027-01-01','open',true) returning id`, [ids.endpoint]);
  const no = await call('POST', `/campaigns/${open.id}/replace`, { starts_on: '2027-02-01' });
  assert.equal(no.status, 400);
  assert.match(no.json.error, /צריך לבחור תקופה/);
  const yes = await call('POST', `/campaigns/${open.id}/replace`, { starts_on: '2027-02-01', period: '3w' });
  assert.equal(yes.status, 201, JSON.stringify(yes.json));
  assert.equal((await campaign(yes.json.campaign.id)).ends_on, '2027-02-21');
});

test('לוח האסטרטגיה: רשימת המחזוריים עם ההרצה האחרונה', { skip }, async () => {
  const id = await template('רשימה', { start: '2027-01-01' });
  await call('PATCH', `/campaigns/${id}`, { recurring: true });

  let s = await call('GET', '/strategy');
  assert.equal(s.status, 200, JSON.stringify(s.json));
  let row = s.json.recurring.find((x) => x.id === id);
  // בלי הרצות — התבנית עצמה היא ההרצה האחרונה
  assert.equal(row.runs, 0);
  assert.equal(row.last_run_on, '2027-01-01');
  assert.equal(row.last_run_ends_on, '2027-01-31');
  assert.equal(row.content_count, 4);
  assert.equal(row.endpoint_name, 'קורס');
  assert.equal(row.period, '1m');

  await call('POST', `/campaigns/${id}/replace`, { starts_on: '2027-04-01' });
  await call('POST', `/campaigns/${id}/replace`, { starts_on: '2027-02-01' });
  s = await call('GET', '/strategy');
  row = s.json.recurring.find((x) => x.id === id);
  assert.equal(row.runs, 2);
  assert.equal(row.last_run_on, '2027-04-01', 'ההרצה המאוחרת, לא האחרונה שנוצרה');
  assert.equal(row.last_run_ends_on, '2027-04-30');
  // עותקים לא מופיעים ברשימה
  assert.ok(!s.json.recurring.some((x) => x.name.startsWith('רשימה ·')));

  // מחיקת התבנית לא מוחקת את ההרצות — רק מנתקת אותן
  const del = await call('DELETE', `/campaigns/${id}`, {});
  assert.equal(del.status, 200, JSON.stringify(del.json));
  const left = await q('select template_id from campaigns where name like $1', ['רשימה ·%']);
  assert.equal(left.length, 2);
  assert.ok(left.every((x) => x.template_id === null));
});

test('בידוד: ארגון אחר לא רואה, לא מסמן ולא משבץ מחדש; צופה בלי הרשאה נחסם', { skip }, async () => {
  const id = await template('בידוד');
  await call('PATCH', `/campaigns/${id}`, { recurring: true });

  const other = await call('POST', `/campaigns/${id}/replace`, { starts_on: '2027-03-01' }, { as: 'other' });
  assert.equal(other.status, 404);
  const patch = await call('PATCH', `/campaigns/${id}`, { recurring: false }, { as: 'other' });
  assert.equal(patch.status, 404);
  assert.equal((await campaign(id)).recurring, true);
  const list = await call('GET', '/strategy', null, { as: 'other' });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.deepEqual(list.json.recurring, []);

  const viewer = await call('POST', `/campaigns/${id}/replace`, { starts_on: '2027-03-01' }, { as: 'viewer' });
  assert.equal(viewer.status, 403);
  const runs = await q('select count(*)::int as n from campaigns where template_id = $1', [id]);
  assert.equal(runs[0].n, 0);
});
