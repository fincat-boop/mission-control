import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * משבצות מקושרות מול Postgres אמיתי: הנתיבים עצמם (content + campaigns)
 * רצים באפליקציית express קטנה, כל בקשה בתוך withOrg — כמו בשרת.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5512/mc_link node --test test/links-db.test.js
 * (בלי המשתנים — מדולג, כדי ש-npm test לא ייגע במסד.)
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

// R2 מדומה: הכתובת הציבורית נגזרת מהמשתנים, וההעתקה נרשמת במקום לצאת לרשת
process.env.R2_ACCOUNT_ID ??= 'acc';
process.env.R2_ACCESS_KEY_ID ??= 'key';
process.env.R2_SECRET_ACCESS_KEY ??= 'secret';
process.env.R2_BUCKET ??= 'backup';
process.env.R2_PUBLIC_BUCKET ??= 'media-test';
process.env.R2_PUBLIC_BASE_URL ??= 'https://media.example.test';

let db, server, base, org, ids, copies;
// בקשות שה-commit שלהן עוד לא הסתיים (גם כשכמה רצות במקביל)
const pending = new Set();

async function call(method, path, body, { form } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: form ? {} : { 'content-type': 'application/json' },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const json = await res.json().catch(() => null);
  await Promise.all([...pending]);   // ה-commit קורה אחרי שהתשובה נשלחה (כמו בשרת)
  return { status: res.status, json };
}

/** שאילתה בהקשר של הארגון (RLS), מחוץ לבקשה */
const q = (sql, params) => db.withOrg(org, () => db.rows(sql, params));
const q1 = async (sql, params) => (await q(sql, params))[0] ?? null;

const item = (id) => q1('select * from content_items where id = $1', [id]);
const variant = (id, ch) =>
  q1('select body, status, meta from content_variants where content_id = $1 and channel_id = $2', [id, ch]);
const assetsOf = (id) => q('select * from content_assets where content_id = $1 order by id', [id]);

/** משבצת חדשה בקמפיין הכללי, דרך הנתיב — כמו הטופס */
async function slot(channelId, sortOrder, over = {}) {
  const r = await call('POST', '/content', {
    title: `פוסט ${channelId}/${sortOrder}`, kind: 'value', campaign_id: ids.campaign,
    slot_channel_id: channelId, sort_order: sortOrder, body: 'טקסט', status: 'draft', ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.content.id;
}

/** קובץ ישן (bytea) דרך נתיב ההעלאה הרגיל */
async function uploadBytes(contentId, name = 'cover.png') {
  const form = new FormData();
  form.append('files', new Blob([Buffer.from('PNGDATA')], { type: 'image/png' }), name);
  const r = await call('POST', `/content/${contentId}/assets`, null, { form });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.assets[0];
}

/** קובץ ב-R2 (שורה עם storage_key), כמו אחרי uploads/complete */
async function r2Asset(contentId, name = 'reel.mp4', mime = 'video/mp4') {
  const key = `media/${org}/${crypto.randomUUID()}/${name}`;
  return q1(
    `insert into content_assets (content_id, filename, mime, size_bytes, storage_key)
     values ($1,$2,$3,100,$4) returning *`, [contentId, name, mime, key]);
}

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: content } = await import('../src/routes/content.js');
  const { default: campaigns } = await import('../src/routes/campaigns.js');
  const { default: channels } = await import('../src/routes/channels.js');
  const { default: board } = await import('../src/routes/board.js');
  const { mediaStore } = await import('../src/media.js');

  await db.migrate();
  copies = [];
  mediaStore.copy = async (src, dst) => { copies.push([src, dst]); };

  org = (await db.pool.query("insert into orgs (name) values ('links-test') returning id")).rows[0].id;
  ids = await db.withOrg(org, async () => {
    await db.query('insert into engine_settings default values');
    const ep = await db.one("insert into endpoints (name, importance) values ('קורס', 8) returning id");
    const ch = async (name, platform) => (await db.one(
      'insert into channels (name, platform, max_per_week) values ($1,$2,7) returning id',
      [name, platform])).id;
    const ig = await ch('אינסטגרם ריל', 'instagram');
    const yt = await ch('יוטיוב שורטס', 'manual');
    const fb = await ch('פייסבוק', 'facebook');
    const nl = await ch('ניוזלטר', 'newsletter');
    const out = await ch('מחוץ לקמפיין', 'manual');
    const start = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const camp = await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, period)
       values ($1,'השקה',$2,$3,'general','custom') returning id`, [ep.id, start, end]);
    for (const c of [ig, yt, fb, nl]) {
      await db.query('insert into campaign_channels (campaign_id, channel_id) values ($1,$2)', [camp.id, c]);
    }
    const angles = await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on) values ($1,'זוויות',$2,$3) returning id`,
      [ep.id, start, end]);
    return { endpoint: ep.id, ig, yt, fb, nl, out, campaign: camp.id, angles: angles.id, start, end };
  });

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
  app.use(content);
  app.use(campaigns);
  app.use(channels);
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

test('קישור למשבצת ריקה: נוצרת עוקבת עם אותו תוכן, והקבצים נקראים מהמקור', { skip }, async () => {
  const a = await slot(ids.ig, 1, { title: 'ריל השקה', body: 'הטקסט המשותף', status: 'ready' });
  const file = await uploadBytes(a);

  const r = await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 1 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const b = r.json.follower.id;
  const fb = await item(b);
  assert.equal(fb.linked_to_id, a);
  assert.equal(fb.slot_channel_id, ids.yt);
  assert.equal(fb.title, 'ריל השקה');
  assert.deepEqual(await variant(b, ids.yt), { body: 'הטקסט המשותף', status: 'ready', meta: null });
  assert.equal((await assetsOf(b)).length, 0, 'לעוקבת אין שורות קבצים משלה');

  // מסך הקמפיין וספריית התוכן מציגים לעוקבת את הקובץ של המקור
  const camp = (await call('GET', '/campaigns')).json.campaigns.find((c) => c.id === ids.campaign);
  const shaped = camp.content.find((x) => x.id === b);
  assert.equal(shaped.linked_to_id, a);
  assert.deepEqual(shaped.assets.map((x) => x.id), [file.id]);
  const lib = (await call('GET', '/content')).json.content.find((x) => x.id === b);
  assert.deepEqual(lib.assets.map((x) => x.id), [file.id]);
});

test('עריכה מכל משבצת מעדכנת את שתיהן; העלאה לעוקבת נרשמת על המקור', { skip }, async () => {
  const a = await slot(ids.ig, 2);
  const b = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 2 } })).json.follower.id;

  // מהעוקבת (טופס המשבצת)
  let r = await call('PATCH', `/content/${b}`, { title: 'כותרת חדשה', kind: 'promo', body: 'נערך ביוטיוב', status: 'ready' });
  assert.equal(r.status, 200);
  assert.equal((await item(a)).title, 'כותרת חדשה');
  assert.equal((await item(a)).kind, 'promo');
  assert.deepEqual(await variant(a, ids.ig), { body: 'נערך ביוטיוב', status: 'ready', meta: null });

  // מהמקור, דרך נתיב הגרסה (העוזר)
  r = await call('PUT', `/content/${a}/variants/${ids.ig}`, { body: 'שוב מהמקור', status: 'draft' });
  assert.equal(r.status, 200);
  assert.deepEqual(await variant(b, ids.yt), { body: 'שוב מהמקור', status: 'draft', meta: null });

  // מיקום (מספר משבצת) נשאר של כל אחת
  r = await call('PATCH', `/content/${b}`, { sort_order: 9 });
  assert.equal(r.status, 200);
  assert.equal((await item(a)).sort_order, 2);

  const up = await uploadBytes(b, 'from-follower.png');
  assert.equal(up.content_id, a, 'הקובץ נרשם על המקור');
  assert.equal((await assetsOf(b)).length, 0);
});

test('כללי הקישור מול המסד: 400/409 בעברית, אישור החלפה, בלי שרשרת', { skip }, async () => {
  const a = await slot(ids.ig, 3);
  // אותה מדיה
  let r = await call('POST', `/content/${a}/link`, { target_campaign_slot: { channel_id: ids.ig, sort_order: 4 } });
  assert.equal(r.status, 400);
  // ניוזלטר
  r = await call('POST', `/content/${a}/link`, { target_campaign_slot: { channel_id: ids.nl, sort_order: 1 } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /ניוזלטר/);
  // מדיה שלא בקמפיין
  r = await call('POST', `/content/${a}/link`, { target_campaign_slot: { channel_id: ids.out, sort_order: 1 } });
  assert.equal(r.status, 400);
  // בלי יעד
  r = await call('POST', `/content/${a}/link`, {});
  assert.equal(r.status, 400);

  // יעד עם תוכן: קודם 409 + needs_confirm, ושום דבר לא השתנה
  const t = await slot(ids.yt, 3, { body: 'תוכן ישן' });
  const old = await r2Asset(t, 'old.jpg', 'image/jpeg');
  const post = await q1(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at)
     values ($1,$2,$3,'ישן','value', now() + interval '5 days') returning id`, [ids.yt, ids.endpoint, t]);
  r = await call('POST', `/content/${a}/link`, { target_content_id: t });
  assert.equal(r.status, 409);
  assert.equal(r.json.needs_confirm, true);
  assert.equal((await item(t)).linked_to_id, null);

  // עם אישור: אותו פריט (הפוסט בלוח ממשיך להצביע עליו), התוכן הוחלף, הקובץ לסל
  r = await call('POST', `/content/${a}/link`, { target_content_id: t, replace: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.follower.id, t);
  assert.equal((await item(t)).linked_to_id, a);
  assert.equal((await variant(t, ids.yt)).body, 'טקסט');
  assert.equal((await assetsOf(t)).length, 0);
  assert.ok(await q1('select 1 from media_trash where storage_key = $1', [old.storage_key]));
  assert.equal((await q1('select content_id from posts where id = $1', [post.id])).content_id, t);

  // שוב לאותה משבצת — כבר מקושרות
  r = await call('POST', `/content/${a}/link`, { target_content_id: t, replace: true });
  assert.equal(r.status, 409);
  // עוקבת שנייה באותה מדיה למקור — נחסם
  r = await call('POST', `/content/${a}/link`, { target_campaign_slot: { channel_id: ids.yt, sort_order: 8 } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /אחת בכל ערוץ/);

  // לחיצה על עוקבת מקשרת את המקור שלה (רמה אחת)
  r = await call('POST', `/content/${t}/link`, { target_campaign_slot: { channel_id: ids.fb, sort_order: 3 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.follower.linked_to_id, a);
  assert.equal(r.json.content.id, a);

  // יעד שעוקב אחרי מקור אחר / מקור של אחרים
  const other = await slot(ids.fb, 4);
  r = await call('POST', `/content/${other}/link`, { target_content_id: t, replace: true });
  assert.equal(r.status, 409);
  r = await call('POST', `/content/${other}/link`, { target_content_id: a, replace: true });
  assert.equal(r.status, 409);

  // קמפיין לפי זוויות
  const angle = (await call('POST', '/content', { title: 'זווית', kind: 'value', campaign_id: ids.angles })).json.content.id;
  r = await call('POST', `/content/${angle}/link`, { target_campaign_slot: { channel_id: ids.yt, sort_order: 1 } });
  assert.equal(r.status, 400);
  // יעד בקמפיין אחר
  r = await call('POST', `/content/${a}/link`, { target_content_id: angle, replace: true });
  assert.equal(r.status, 400);
});

test('נתק קישור: לעוקבת עותק עצמאי של הקבצים (R2 לאובייקט חדש, bytea בתוך המסד)', { skip }, async () => {
  const a = await slot(ids.ig, 5, { body: 'משותף' });
  const bytes = await uploadBytes(a);
  const r2 = await r2Asset(a);
  const b = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 5 } })).json.follower.id;

  copies.length = 0;
  const r = await call('POST', `/content/${b}/unlink`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.copied, 2);
  assert.equal((await item(b)).linked_to_id, null);

  const mine = await assetsOf(b);
  assert.equal(mine.length, 2);
  const copiedBytes = mine.find((x) => !x.storage_key);
  assert.equal(Buffer.from(copiedBytes.data).toString(), 'PNGDATA');
  assert.notEqual(copiedBytes.id, bytes.id);
  const copiedR2 = mine.find((x) => x.storage_key);
  assert.notEqual(copiedR2.storage_key, r2.storage_key, 'אובייקט חדש ב-R2');
  assert.deepEqual(copies, [[r2.storage_key, copiedR2.storage_key]]);
  assert.equal((await assetsOf(a)).length, 2, 'למקור נשארו הקבצים שלו');

  // עצמאיות: עריכת המקור לא נוגעת יותר בעוקבת
  await call('PATCH', `/content/${a}`, { body: 'רק במקור' });
  assert.equal((await variant(b, ids.yt)).body, 'משותף');
  // ניתוק חוזר — לא מקושרת
  assert.equal((await call('POST', `/content/${b}/unlink`, {})).status, 400);
});

test('מחיקת מקור: העוקבות נשארות עם תוכן — הראשונה יורשת את הקבצים, השנייה מקבלת עותק', { skip }, async () => {
  const a = await slot(ids.ig, 6, { body: 'מקור שנמחק', status: 'ready' });
  const file = await r2Asset(a);
  const b = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 6 } })).json.follower.id;
  const c = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.fb, sort_order: 6 } })).json.follower.id;

  const r = await call('DELETE', `/content/${a}`, {});
  assert.equal(r.status, 200);
  assert.equal(await item(a), null);
  for (const [id, ch] of [[b, ids.yt], [c, ids.fb]]) {
    const x = await item(id);
    assert.equal(x.linked_to_id, null);
    assert.deepEqual(await variant(id, ch), { body: 'מקור שנמחק', status: 'ready', meta: null });
  }
  const [inherited] = await assetsOf(b);
  assert.equal(inherited.id, file.id, 'הראשונה מקבלת את השורה עצמה');
  assert.equal(inherited.storage_key, file.storage_key);
  const [copy] = await assetsOf(c);
  assert.notEqual(copy.storage_key, file.storage_key);
});

test('מחיקת עוקבת לא נוגעת במקור; יציאה מהקמפיין מנתקת עם עותק', { skip }, async () => {
  const a = await slot(ids.ig, 7, { body: 'נשאר' });
  await uploadBytes(a);
  const b = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 7 } })).json.follower.id;
  assert.equal((await call('DELETE', `/content/${b}`, {})).status, 200);
  assert.equal((await variant(a, ids.ig)).body, 'נשאר');
  assert.equal((await assetsOf(a)).length, 1);

  const c = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 7 } })).json.follower.id;
  const r = await call('PATCH', `/content/${c}`, { campaign_id: null });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const x = await item(c);
  assert.equal(x.linked_to_id, null);
  assert.equal(x.slot_channel_id, null);
  assert.equal((await assetsOf(c)).length, 1);
});

test('שכפול קמפיין שומר את הקישור בין העותקים; "קמפיין מוכן" דוחס בלי לשבור אותו', { skip }, async () => {
  // קמפיין נפרד, כדי שהשכפול והדחיסה יראו רק את הזוג הזה
  const camp = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, period)
     values ($1,'שכפול',$2,$3,'general','custom') returning id`, [ids.endpoint, ids.start, ids.end]);
  for (const c of [ids.ig, ids.yt]) {
    await q('insert into campaign_channels (campaign_id, channel_id) values ($1,$2)', [camp.id, c]);
  }
  const mk = async (ch, n, over = {}) => (await call('POST', '/content', {
    title: `ש ${n}`, kind: 'value', campaign_id: camp.id, slot_channel_id: ch, sort_order: n,
    body: 'x', ...over })).json.content.id;
  // העוקבת נוצרה לפני המקור (מזהה נמוך) — גם השכפול צריך להסתדר עם זה
  const follower = await mk(ids.yt, 5, { body: 'ישן' });
  const source = await mk(ids.ig, 4, { body: 'מקור' });
  await r2Asset(source);
  const r0 = await call('POST', `/content/${source}/link`, { target_content_id: follower, replace: true });
  assert.equal(r0.status, 200, JSON.stringify(r0.json));

  const d = await call('POST', `/campaigns/${camp.id}/duplicate`, {
    name: 'שכפול (עותק)', endpoint_id: ids.endpoint, starts_on: ids.start, ends_on: ids.end,
    period: 'custom', channel_ids: [ids.ig, ids.yt],
  });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  assert.equal(d.json.copied.links, 1);
  const copiesIn = await q('select * from content_items where campaign_id = $1', [d.json.campaign.id]);
  const cs = copiesIn.find((x) => x.slot_channel_id === ids.ig);
  const cf = copiesIn.find((x) => x.slot_channel_id === ids.yt);
  assert.equal(cf.linked_to_id, cs.id, 'העותק מקושר לעותק, לא למקור המקורי');
  assert.equal((await assetsOf(cs.id)).length, 1);
  assert.equal((await assetsOf(cf.id)).length, 0);

  // "קמפיין מוכן" דוחס את הסדר ל-1..n בכל מדיה — הקישור לפי מזהה, שורד
  const done = await call('POST', `/campaigns/${camp.id}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal((await item(source)).sort_order, 1);
  assert.equal((await item(follower)).sort_order, 1);
  assert.equal((await item(follower)).linked_to_id, source);
});

test('מחיקת קמפיין מפרקת את הקישורים — כל משבצת עם תוכן משלה', { skip }, async () => {
  const camp = await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, structure, period)
     values ($1,'למחיקה',$2,$3,'general','custom') returning id`, [ids.endpoint, ids.start, ids.end]);
  for (const c of [ids.ig, ids.yt]) {
    await q('insert into campaign_channels (campaign_id, channel_id) values ($1,$2)', [camp.id, c]);
  }
  const a = (await call('POST', '/content', { title: 'מ', kind: 'value', campaign_id: camp.id,
    slot_channel_id: ids.ig, sort_order: 1, body: 'x' })).json.content.id;
  await uploadBytes(a);
  const b = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 1 } })).json.follower.id;
  assert.equal((await call('DELETE', `/campaigns/${camp.id}`, {})).status, 200);
  assert.equal((await item(b)).linked_to_id, null);
  assert.equal((await assetsOf(b)).length, 1);
});

test('פרסום: הפוסט של העוקבת (אינסטגרם) נשלח עם המדיה של המקור', { skip }, async () => {
  const { loadPayload, publishBlocker, facebookAssets } = await import('../src/publish/runner.js');
  const { mediaUrl } = await import('../src/media.js');
  const a = await slot(ids.yt, 10, { title: 'שורט', body: 'כיתוב', status: 'ready' });
  const file = await r2Asset(a, 'short.mp4', 'video/mp4');
  const ig = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.ig, sort_order: 10 } })).json.follower.id;
  const fbItem = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.fb, sort_order: 10 } })).json.follower.id;

  const post = await q1(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at)
     values ($1,$2,$3,'שורט','value', now() + interval '3 days') returning id`, [ids.ig, ids.endpoint, ig]);
  const payload = await db.withOrg(org, () => loadPayload(post.id));
  assert.equal(payload.variant.body, 'כיתוב');
  assert.deepEqual(payload.assets.map((x) => x.id), [file.id]);
  // החיבור לאינסטגרם מדומה — רק כדי שהחוסם יגיע לבדיקת המדיה
  const blocker = publishBlocker({
    ...payload, post: { ...payload.post, access_token_enc: 'x', ig_user_id: '1' } });
  assert.equal(blocker, null);
  assert.equal(mediaUrl(payload.assets[0].storage_key),
    `https://media.example.test/${file.storage_key.split('/').map(encodeURIComponent).join('/')}`);

  const fbPost = await q1(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at)
     values ($1,$2,$3,'שורט','value', now() + interval '4 days') returning id`, [ids.fb, ids.endpoint, fbItem]);
  const fbPayload = await db.withOrg(org, () => loadPayload(fbPost.id));
  assert.equal(facebookAssets(fbPayload.assets)[0].url, mediaUrl(file.storage_key));

  // התצוגה המקדימה בלוח (GET /posts/:id/preview משתמש באותה שאילתה)
  const { itemAssetsSql } = await import('../src/links.js');
  const preview = await db.withOrg(org, () => db.rows(itemAssetsSql('a.id'), [ig, ids.ig]));
  assert.deepEqual(preview.map((x) => x.id), [file.id]);
});

test('המנוע: שתי המשבצות המקושרות משובצות, כל אחת במדיה שלה', { skip }, async () => {
  const { applyWeek } = await import('../src/engine.js');
  const a = await slot(ids.ig, 11, { title: 'למנוע', body: 'מוכן', status: 'ready' });
  const b = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 11 } })).json.follower.id;
  // כמה שבועות קדימה בתוך חלון הקמפיין, עד שהמנוע מגיע אליהם
  for (let w = 0; w < 5; w += 1) {
    await db.withOrg(org, () => applyWeek(new Date(Date.now() + w * 7 * 86400000).toISOString().slice(0, 10)));
  }
  const placed = await q(
    'select content_id, channel_id, scheduled_at from posts where content_id = any($1::int[])', [[a, b]]);
  const onIg = placed.filter((p) => p.content_id === a);
  const onYt = placed.filter((p) => p.content_id === b);
  assert.ok(onIg.length >= 1, 'המקור שובץ');
  assert.ok(onYt.length >= 1, 'העוקבת שובצה');
  assert.ok(onIg.every((p) => p.channel_id === ids.ig));
  assert.ok(onYt.every((p) => p.channel_id === ids.yt));
});

/* ---------- סבב תיקונים: מרוצים, נעילות, FK, מחיקת מדיה ---------- */

/** אין שרשרת: אף פריט לא מצביע על פריט שמצביע בעצמו על מישהו */
async function assertNoChains() {
  const chains = await q(
    `select f.id from content_items f join content_items s on s.id = f.linked_to_id
      where s.linked_to_id is not null`);
  assert.deepEqual(chains, []);
}

test('מרוץ: קישור מקביל לא יוצר שרשרת (מקור שהפך לעוקבת נבדק אחרי הנעילה)', { skip }, async () => {
  for (let i = 0; i < 6; i += 1) {
    const n = 40 + i;
    const x = await slot(ids.ig, n);
    const y = await slot(ids.yt, n);
    // X→Y הופך את Y לעוקבת; Y→FB במקביל מנסה להפוך את Y למקור
    const [r1, r2] = await Promise.all([
      call('POST', `/content/${x}/link`, { target_content_id: y, replace: true }),
      call('POST', `/content/${y}/link`, { target_campaign_slot: { channel_id: ids.fb, sort_order: n } }),
    ]);
    assert.ok([r1.status, r2.status].every((st) => [200, 409].includes(st)),
      `${r1.status} ${r2.status} ${JSON.stringify([r1.json, r2.json])}`);
    await assertNoChains();
  }
});

test('מקביל: עריכת המקור ועריכת העוקבת באותו רגע — בלי דדלוק, והקבוצה זהה', { skip }, async () => {
  const a = await slot(ids.ig, 50);
  const b = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 50 } })).json.follower.id;
  for (let i = 0; i < 8; i += 1) {
    const [r1, r2] = await Promise.all([
      call('PATCH', `/content/${a}`, { body: `מקור ${i}`, status: 'ready' }),
      call('PATCH', `/content/${b}`, { body: `עוקבת ${i}`, status: 'draft' }),
    ]);
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    assert.deepEqual(await variant(a, ids.ig), await variant(b, ids.yt));
    assert.equal((await item(a)).title, (await item(b)).title);
  }
});

test('מקביל: מחיקת מקור מול קישור עוקבת חדשה — אף עוקבת לא נשארת בלי מדיה', { skip }, async () => {
  for (let i = 0; i < 4; i += 1) {
    const n = 60 + i;
    const a = await slot(ids.ig, n);
    await uploadBytes(a);
    await call('POST', `/content/${a}/link`, { target_campaign_slot: { channel_id: ids.yt, sort_order: n } });
    await Promise.all([
      call('DELETE', `/content/${a}`, {}),
      call('POST', `/content/${a}/link`, { target_campaign_slot: { channel_id: ids.fb, sort_order: n } }),
    ]);
    const left = await q(
      `select ci.id, (select count(*)::int from content_assets a where a.content_id = ci.id) as files
         from content_items ci where ci.campaign_id = $1 and ci.sort_order = $2`, [ids.campaign, n]);
    for (const x of left) assert.equal(x.files, 1, `פריט ${x.id} בלי הקובץ`);
    await assertNoChains();
  }
});

test('FK: initially immediate באפליקציה; השחזור דוחה בתוך הטרנזקציה שלו', { skip }, async () => {
  const fk = (await db.pool.query(
    `select condeferrable, condeferred from pg_constraint
      where conname = 'content_items_linked_to_id_fkey'`)).rows[0];
  assert.deepEqual(fk, { condeferrable: true, condeferred: false });

  const ins = (client, id, linkTo) => client.query(
    `insert into content_items (id, org_id, endpoint_id, kind, title, linked_to_id)
     values ($1,$2,$3,'value','שחזור',$4)`, [id, org, ids.endpoint, linkTo]);
  const client = await db.pool.connect();
  try {
    // בלי דחייה: עוקבת לפני המקור נכשלת מיד (לא ב-commit, אחרי שהתשובה כבר יצאה)
    await client.query('begin');
    await assert.rejects(ins(client, 990001, 990002), (e) => e.code === '23503');
    await client.query('rollback');
    // כמו restore.js: set constraints all deferred — הסדר בקובץ לא משנה
    await client.query('begin');
    await client.query('set constraints all deferred');
    await ins(client, 990001, 990002);
    await ins(client, 990002, null);
    await client.query('rollback');
  } finally {
    client.release();
  }
});

test('קישור כשלמקור אין גרסה: גם הגרסה הישנה של היעד יורדת — הקבוצה עקבית', { skip }, async () => {
  const a = await slot(ids.ig, 70);
  assert.equal((await call('DELETE', `/content/${a}/variants/${ids.ig}`, {})).status, 200);
  const t = await slot(ids.yt, 70, { body: 'טקסט ישן ביעד' });
  const r = await call('POST', `/content/${a}/link`, { target_content_id: t, replace: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(await variant(t, ids.yt), null);
});

test('מחיקת מדיה (force) של מקור: העוקבות מתנתקות עם עותק של הקבצים והטקסט', { skip }, async () => {
  const tiktok = await q1(
    "insert into channels (name, platform, max_per_week) values ('טיקטוק','manual',7) returning id");
  await q('insert into campaign_channels (campaign_id, channel_id) values ($1,$2)', [ids.campaign, tiktok.id]);
  const a = (await call('POST', '/content', {
    title: 'בטיקטוק', kind: 'value', campaign_id: ids.campaign, slot_channel_id: tiktok.id,
    sort_order: 1, body: 'שורד את המחיקה', status: 'ready' })).json.content.id;
  await uploadBytes(a);
  const b = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 71 } })).json.follower.id;

  const r = await call('DELETE', `/channels/${tiktok.id}?force=1`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await item(b)).linked_to_id, null);
  assert.equal((await assetsOf(b)).length, 1);
  assert.deepEqual(await variant(b, ids.yt), { body: 'שורד את המחיקה', status: 'ready', meta: null });
});

test('שיוך תוכן לפוסט חסר תוכן: עוקבת מופיעה כמועמדת ונשלחת עם הטקסט והמדיה של המקור', { skip }, async () => {
  const a = await slot(ids.ig, 80, { title: 'לשיוך', body: 'טקסט משותף', status: 'ready' });
  const file = await uploadBytes(a);
  const b = (await call('POST', `/content/${a}/link`, {
    target_campaign_slot: { channel_id: ids.yt, sort_order: 80 } })).json.follower.id;
  // פוסט חסר תוכן ביוטיוב, בתוך חלון הקמפיין
  const when = new Date(`${ids.start}T09:00:00+03:00`);
  when.setDate(when.getDate() + 3);
  const post = await q1(
    `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at)
     values ($1,$2,'ממתין לתוכן','value',$3) returning id`, [ids.yt, ids.endpoint, when]);
  const date = when.toISOString().slice(0, 10);
  const cand = await call('GET',
    `/posts/candidates?channel_id=${ids.yt}&endpoint_id=${ids.endpoint}&date=${date}`);
  assert.equal(cand.status, 200, JSON.stringify(cand.json));
  assert.ok(cand.json.candidates.some((c) => c.id === b), 'העוקבת מועמדת בערוץ שלה');
  assert.ok(!cand.json.candidates.some((c) => c.id === a), 'המקור לא מועמד בערוץ אחר');

  const r = await call('POST', `/posts/${post.id}/attach-content`, { content_id: b });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const preview = await call('GET', `/posts/${post.id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.variant.body, 'טקסט משותף');
  assert.deepEqual(preview.json.assets.map((x) => x.id), [file.id]);
  const { loadPayload } = await import('../src/publish/runner.js');
  const payload = await db.withOrg(org, () => loadPayload(post.id));
  assert.deepEqual(payload.assets.map((x) => x.id), [file.id]);
});
