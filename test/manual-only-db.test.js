import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * שתי החלטות המשתמש מ-8.10.26 מול Postgres אמיתי:
 *   א. אין פוסט בלי נקודת קצה — POST /posts, PATCH /posts ומבצע דחוף דוחים
 *      פוסט בלי נקודה, והצעד החד-פעמי orphan_posts_v1 מנקה את הקיים.
 *   ב. אין פרסום אוטומטי כשמתג-העל כבוי — אישור / אישור השבוע / פרסם עכשיו /
 *      העבר ל-HUB נדחים (409), כיבוי המתג מחזיר מאושר ונכשל למתוכנן, והצעד
 *      manual_only_v1 עושה את אותו ניקוי פעם אחת.
 * הנתיבים רצים באפליקציית express קטנה, כל בקשה בתוך withOrg — כמו בשרת.
 *
 * רץ רק במפורש, ורק מול מסד מקומי:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/manual-only-db.test.js
 * הצעדים החד-פעמיים רצים שוב (המפתח נמחק מ-app_migrations) — על כל הארגונים
 * במסד הבדיקה, ולכן רק על עותק.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, server, base, org, ids;
const pending = new Set();

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  await Promise.all([...pending]);
  return { status: res.status, json };
}

const inOrg = (fn) => db.withOrg(org, fn);
const q1 = (sql, params) => inOrg(() => db.one(sql, params));
const qa = (sql, params) => inOrg(() => db.rows(sql, params));
const minutes = (m) => new Date(Date.now() + m * 60000).toISOString();
const days = (d) => minutes(d * 24 * 60);
const setAuto = (on) => inOrg(() => db.query('update engine_settings set autopublish_enabled = $1', [on]));

/** פוסט ישירות במסד. at — דקות מעכשיו (שלילי = עבר) */
async function post({ channel = ids.fb, endpoint = ids.ep, content = ids.ready, title = 'פוסט',
                      at = 60 * 24 * 3, status = 'scheduled', error = null, urgent = false,
                      externalId = null, hubAt = null } = {}) {
  return (await q1(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status,
                        publish_error, approved_at, urgent, external_id, hub_transferred_at)
     values ($1,$2,$3,$4,'value',$5,$6,$7, case when $6 = 'approved' then now() end, $8, $9, $10)
     returning id`,
    [channel, endpoint, content, title, minutes(at), status, error, urgent, externalId, hubAt])).id;
}
const statusOf = async (id) => (await q1('select status from posts where id = $1', [id]))?.status ?? null;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: board } = await import('../src/routes/board.js');
  const { default: engine } = await import('../src/routes/engine.js');
  const { default: publish } = await import('../src/routes/publish.js');
  const { default: settings } = await import('../src/routes/settings.js');

  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('manual-only-test') returning id")).rows[0].id;
  ids = await inOrg(async () => {
    await db.query('insert into engine_settings default values');
    const ep = (await db.one("insert into endpoints (name, importance) values ('קורס', 9) returning id")).id;
    const ep2 = (await db.one("insert into endpoints (name, importance) values ('ייעוץ', 9) returning id")).id;
    const off = (await db.one(
      "insert into endpoints (name, importance, active) values ('מושבתת', 5, false) returning id")).id;
    const fb = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('פייסבוק', 'facebook', 7) returning id")).id;
    const nl = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('ניוזלטר', 'newsletter', 7) returning id")).id;
    const ready = (await db.one(
      "insert into content_items (endpoint_id, kind, title) values ($1, 'value', 'מוכן') returning id", [ep])).id;
    const other = (await db.one(
      "insert into content_items (endpoint_id, kind, title) values ($1, 'value', 'של ייעוץ') returning id",
      [ep2])).id;
    for (const [c, ch] of [[ready, fb], [ready, nl], [other, fb]]) {
      await db.query(
        `insert into content_variants (content_id, channel_id, status, body, meta)
         values ($1,$2,'ready','טקסט מוכן','{"subject":"נושא"}')`, [c, ch]);
    }
    return { ep, ep2, off, fb, nl, ready, other };
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
  app.use(board);
  app.use(engine);
  app.use(publish);
  app.use(settings);
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

/* ========================= א — אין פוסט בלי נקודת קצה ========================= */

test('א — POST /posts: בלי נקודה 400; נקודה מושבתת 409; תוכן של נקודה אחרת 400; תקין 201', { skip }, async () => {
  const base1 = { channel_id: ids.fb, title: 'ידני', kind: 'value', scheduled_at: days(10) };
  const none = await call('POST', '/posts', base1);
  assert.equal(none.status, 400);
  assert.match(none.json.error, /אין פוסט בלי נקודת קצה/);
  assert.equal((await call('POST', '/posts', { ...base1, endpoint_id: '' })).status, 400);
  assert.equal((await call('POST', '/posts', { ...base1, endpoint_id: ids.off })).status, 409);
  assert.equal((await call('POST', '/posts', { ...base1, endpoint_id: 999999 })).status, 404);

  const mismatch = await call('POST', '/posts', { ...base1, endpoint_id: ids.ep, content_id: ids.other });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.json.error, /נקודת קצה אחרת/);

  const ok = await call('POST', '/posts', { ...base1, endpoint_id: ids.ep2, content_id: ids.other });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.post.endpoint_id, ids.ep2);
});

test('א — PATCH /posts: אי אפשר לאפס נקודה או להחליף לתוכן של נקודה אחרת; כותרת לפוסט ישן בלי נקודה — כן', { skip }, async () => {
  const id = await post({ at: 60 * 24 * 12, title: 'לעריכה' });
  const cleared = await call('PATCH', `/posts/${id}`, { endpoint_id: null });
  assert.equal(cleared.status, 400);
  assert.match(cleared.json.error, /אין פוסט בלי נקודת קצה/);
  const swapped = await call('PATCH', `/posts/${id}`, { content_id: ids.other });
  assert.equal(swapped.status, 400);
  assert.match(swapped.json.error, /נקודת קצה אחרת/);
  // החלפה יחד עם הנקודה של התוכן (כמו "החלף בתוכן המוצע") — עוברת
  const both = await call('PATCH', `/posts/${id}`, { content_id: ids.other, endpoint_id: ids.ep2,
                                                         confirm_warnings: true });
  assert.equal(both.status, 200, JSON.stringify(both.json));
  assert.equal(both.json.post.endpoint_id, ids.ep2);

  // שארית פתוחה בלי נקודה: הזזה (מועד או ערוץ) נדחית, אלא אם נשלחת נקודה; כותרת וסימון — כן
  const rest = await post({ endpoint: null, content: null, title: 'שארית', at: -60 * 24 * 2 });
  const move = await call('PATCH', `/posts/${rest}`, { scheduled_at: days(14) });
  assert.equal(move.status, 400);
  assert.match(move.json.error, /אין פוסט בלי נקודת קצה/);
  assert.equal((await call('PATCH', `/posts/${rest}`, { channel_id: ids.nl })).status, 400);
  assert.equal((await call('PATCH', `/posts/${rest}`, { title: 'שארית — כותרת' })).status, 200);
  const withEp = await call('PATCH', `/posts/${rest}`,
    { scheduled_at: days(15), endpoint_id: ids.ep, confirm_warnings: true });
  assert.equal(withEp.status, 200, JSON.stringify(withEp.json));
  assert.equal(withEp.json.post.endpoint_id, ids.ep);
  const rest2 = await post({ endpoint: null, content: null, title: 'שארית לסימון', at: -60 * 24 * 2 });
  assert.equal((await call('POST', `/posts/${rest2}/publish`)).status, 200);

  // פוסט שפורסם לפני הכלל ונשאר בלי נקודה (הנקודה נמחקה) — עדיין נערך בכותרת
  const legacy = await post({ endpoint: null, content: null, status: 'published', at: -60 * 24 * 30 });
  const titled = await call('PATCH', `/posts/${legacy}`, { title: 'כותרת חדשה' });
  assert.equal(titled.status, 200, JSON.stringify(titled.json));
});

test('א — מבצע דחוף בלי נקודה: התצוגה המקדימה מסבירה, האישור נדחה ולא נכתב כלום', { skip }, async () => {
  const body = { title: 'מבצע בלי נקודה', channel_ids: [ids.fb] };
  const preview = await call('POST', '/urgent/preview', body);
  assert.equal(preview.json.ok, false);
  assert.ok(preview.json.errors.includes('צריך לבחור נקודת קצה'));
  const commit = await call('POST', '/urgent/commit', body);
  assert.equal(commit.status, 400);
  assert.match(commit.json.error, /צריך לבחור נקודת קצה/);
  const disabled = await call('POST', '/urgent/preview', { ...body, endpoint_id: ids.off });
  assert.deepEqual(disabled.json.errors, ['נקודת הקצה שנבחרה מושבתת']);
  const n = await q1("select count(*)::int as n from posts where title = 'מבצע בלי נקודה'");
  assert.equal(n.n, 0);

  const ok = await call('POST', '/urgent/commit', { ...body, endpoint_id: ids.ep, title: 'מבצע עם נקודה' });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.ok(ok.json.posts.every((p) => p.endpoint_id === ids.ep));
});

/* ========================= ב — אין פרסום אוטומטי כשהמתג כבוי ========================= */

test('ב — המתג כבוי: אישור, אישור השבוע, פרסם עכשיו והעבר ל-HUB — 409; ביטול אישור עובד', { skip }, async () => {
  await setAuto(false);
  const id = await post({ title: 'לאישור' });
  const nl = await post({ title: 'ניוזלטר', channel: ids.nl });
  for (const [path, target] of [
    ['/posts/:id/approve-publish', id], ['/publish/approve-week', id],
    ['/posts/:id/publish-now', id], ['/posts/:id/newsletter/transfer', nl],
  ]) {
    const r = await call('POST', path.replace(':id', target), {});
    assert.equal(r.status, 409, path);
    assert.match(r.json.error, /הפרסום האוטומטי כבוי/, path);
  }
  assert.equal(await statusOf(id), 'scheduled');

  // ביטול אישור — מחזיר מצב, לא מפרסם: לא חסום
  const approved = await post({ title: 'מאושר מלפני', status: 'approved' });
  const un = await call('POST', `/posts/${approved}/unapprove-publish`);
  assert.equal(un.status, 200, JSON.stringify(un.json));

  // המתג דלוק — אותם נתיבים לא נחסמים על המתג (נכשלים, אם בכלל, מסיבה אחרת:
  // כאן — לערוץ אין חיבור עם פרסום אוטומטי, סעיף 30)
  await setAuto(true);
  try {
    const r = await call('POST', `/posts/${id}/approve-publish`);
    assert.doesNotMatch(r.json.error ?? '', /הפרסום האוטומטי כבוי —/);
    assert.match(r.json.error ?? '', /הפרסום האוטומטי לא מופעל לערוץ הזה/);
  } finally {
    await setAuto(false);
  }
});

test('ב — כיבוי המתג: מאושר ונכשל חוזרים למתוכנן, משימות הכשל נסגרות; publishing לא זז', { skip }, async () => {
  await setAuto(true);
  const approved = await post({ title: 'מאושר', status: 'approved' });
  const failed = await post({ title: 'נכשל', status: 'failed', error: 'הטוקן פג', at: -60 * 5 });
  const publishing = await post({ title: 'בפרסום', status: 'publishing', at: -2 });
  const task = await q1(
    `insert into tasks (title, kind, post_id, urgent, done) values ('פרסום נכשל', 'failed', $1, true, false)
     returning id`, [failed]);

  const status = await call('GET', '/publish/status');
  assert.ok(status.json.manual_reset.approved >= 1);
  assert.ok(status.json.manual_reset.failed >= 1);

  const r = await call('PATCH', '/settings', { autopublish_enabled: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.settings.autopublish_enabled, false);
  assert.ok(r.json.manual_reset.approved >= 1 && r.json.manual_reset.failed >= 1);

  const rows = await qa(
    'select id, status, approved_at, publish_error from posts where id = any($1::int[]) order by id',
    [[approved, failed, publishing]]);
  const by = new Map(rows.map((x) => [x.id, x]));
  assert.equal(by.get(approved).status, 'scheduled');
  assert.equal(by.get(approved).approved_at, null);
  assert.equal(by.get(failed).status, 'scheduled');
  assert.equal(by.get(failed).publish_error, null);
  assert.equal(by.get(publishing).status, 'publishing');
  assert.equal((await q1('select done from tasks where id = $1', [task.id])).done, true);

  // הדלקה לא נוגעת בכלום
  const on = await call('PATCH', '/settings', { autopublish_enabled: true });
  assert.equal(on.json.manual_reset, undefined);
  await setAuto(false);
});

test('ב — טיק כשהמתג כבוי: ניוזלטר שהגיע מועדו לא מוכשל, ומקבל משימת "לפרסם היום" עם הנושא', { skip }, async () => {
  const runner = await import('../src/publish/runner.js');
  await setAuto(false);
  // המועד עבר לפני 10 דקות — כשהמתג דלוק זה "ניוזלטר לא הועבר ל-HUB" ונכשל
  const id = await post({ title: 'ניוזלטר היום', channel: ids.nl, at: -10 });
  await runner.publishTickForOrg(org);
  assert.equal(await statusOf(id), 'scheduled');
  assert.equal((await q1(
    "select count(*)::int as n from tasks where post_id = $1 and kind = 'failed'", [id])).n, 0);

  // משימת היום — בשעה קבועה, בלי תלות בשעון של ההרצה
  const noon = new Date(minutes(-10));
  noon.setHours(12, 0, 0, 0);
  await runner.manualPublishPrep(org, noon);
  const t = await q1(
    "select title, subtitle, meta from tasks where post_id = $1 and kind = 'publish'", [id]);
  assert.ok(t, 'נוצרה משימת "לפרסם היום"');
  assert.equal(t.title, 'לפרסם היום בניוזלטר: ניוזלטר היום');
  assert.equal(t.subtitle, runner.NEWSLETTER_SUB_READY);

  // המתג דלוק — אותו מצב: נכשל עם משימת כשל (ההתנהגות של היום)
  const id2 = await post({ title: 'ניוזלטר דלוק', channel: ids.nl, at: -10 });
  await setAuto(true);
  try {
    await runner.publishTickForOrg(org);
  } finally {
    await setAuto(false);
  }
  assert.equal(await statusOf(id2), 'failed');
});

test('ב — המתג כבוי: נכשל שמקבל מועד חדש חוזר למתוכנן ומשימת הכשל נסגרת; דלוק — נשאר נכשל', { skip }, async () => {
  await setAuto(false);
  const id = await post({ title: 'נכשל להזזה', status: 'failed', error: 'נתקע', at: -60 * 3 });
  const task = await q1(
    "insert into tasks (title, kind, post_id, urgent) values ('נכשל', 'failed', $1, true) returning id", [id]);
  const r = await call('PATCH', `/posts/${id}`, { scheduled_at: days(20), confirm_warnings: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.post.status, 'scheduled');
  assert.equal(r.json.post.publish_error, null);
  assert.equal((await q1('select done from tasks where id = $1', [task.id])).done, true);

  await setAuto(true);
  try {
    const id2 = await post({ title: 'נכשל דלוק', status: 'failed', error: 'נתקע', at: -60 * 3 });
    const r2 = await call('PATCH', `/posts/${id2}`, { scheduled_at: days(21), confirm_warnings: true });
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    assert.equal(r2.json.post.status, 'failed');
  } finally {
    await setAuto(false);
  }
});

/** נכשלים שאולי כבר יצאו (runner.js maybeOutSql) ונכשל אחד שבוודאות לא */
async function maybeOutPosts(tag) {
  const runner = await import('../src/publish/runner.js');
  const { friendlyPublishError } = await import('../src/publish/errors.js');
  const failed = (o) => post({ status: 'failed', at: -60 * 3, ...o });
  const timeout = friendlyPublishError(
    Object.assign(new Error('t'), { kind: 'graph_timeout', maybeLive: true }), { platform: 'facebook' }).message;
  return {
    sure: await failed({ title: `${tag} טוקן פג`, error: 'הטוקן של העמוד פג — מחברים מחדש' }),
    tooLate: await failed({ title: `${tag} מאוחר`, error: runner.TOO_LATE_ERROR }),
    maybe: [
      await failed({ title: `${tag} נקטע`, error: runner.STUCK_SOCIAL_ERROR }),
      await failed({ title: `${tag} HUB יממה`, error: runner.STUCK_NEWSLETTER_ERROR, channel: ids.nl }),
      await failed({ title: `${tag} HUB 3 ימים`, error: runner.STUCK_NEWSLETTER_CAP_ERROR, channel: ids.nl }),
      await failed({ title: `${tag} לא נשמר`, error: runner.PUBLISHED_UNSAVED_ERROR }),
      await failed({ title: `${tag} timeout`, error: timeout }),
      await failed({ title: `${tag} שוחרר`, error: 'הפרסום סומן כתקוע ידנית על ידי דנה — בודקים בעמוד' }),
      await failed({ title: `${tag} הועבר`, error: 'נדחה ב-HUB', channel: ids.nl, externalId: 'hub-1' }),
      await failed({ title: `${tag} בידי HUB`, error: 'x', channel: ids.nl, hubAt: minutes(-60 * 24) }),
    ],
  };
}

test('ב — כיבוי: נכשל שאולי כבר יצא נשאר נכשל (ולא נספר בחלון); שבוודאות לא יצא — חוזר', { skip }, async () => {
  await setAuto(true);
  const x = await maybeOutPosts('כיבוי');
  const before = (await call('GET', '/publish/status')).json.manual_reset.failed;
  const r = await call('PATCH', '/settings', { autopublish_enabled: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.manual_reset.failed, before, 'החלון סופר רק את מי שחוזר');
  assert.equal(await statusOf(x.sure), 'scheduled');
  assert.equal(await statusOf(x.tooLate), 'scheduled');
  for (const id of x.maybe) assert.equal(await statusOf(id), 'failed', String(id));

  // הזזה של נכשל שאולי יצא כשהמתג כבוי — המועד זז, הסטטוס נשאר נכשל
  const moved = await call('PATCH', `/posts/${x.maybe[0]}`, { scheduled_at: days(25), confirm_warnings: true });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.post.status, 'failed');
  const pv = await call('GET', `/posts/${x.maybe[0]}/preview`);
  assert.equal(pv.json.post.maybe_out, true);
});

test('manual_only_v1: נכשל שאולי כבר יצא נשאר נכשל — אותו תנאי כמו resetToManual', { skip }, async () => {
  await setAuto(false);
  const x = await maybeOutPosts('צעד');
  await db.pool.query("delete from app_migrations where key = 'manual_only_v1'");
  await db.migrate();
  assert.equal(await statusOf(x.sure), 'scheduled');
  assert.equal(await statusOf(x.tooLate), 'scheduled');
  for (const id of x.maybe) assert.equal(await statusOf(id), 'failed', String(id));
});

/* ========================= הצעדים החד-פעמיים ========================= */

test('orphan_posts_v1: יתום עם תוכן מקבל את הנקודה של התוכן; נמחק רק מה שבוודאות לא יצא', { skip }, async () => {
  const camp = (await q1(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on)
     values ($1, 'קמפיין', current_date - 5, current_date + 30) returning id`, [ids.ep2])).id;
  const inCamp = (await q1(
    `insert into content_items (endpoint_id, campaign_id, kind, title) values ($1,$2,'value','בקמפיין')
     returning id`, [ids.ep2, camp])).id;
  const orphan = (o) => post({ endpoint: null, content: null, ...o });
  const day = 60 * 24;

  const p = {
    // נשארים, עם הנקודה של התוכן
    withCamp: await post({ endpoint: null, content: inCamp, title: 'יתום עם קמפיין' }),
    loose: await post({ endpoint: null, content: ids.ready, at: -2 * day, title: 'יתום עם תוכן שוטף' }),
    // נמחקים
    futureBare: await orphan({ title: 'עתידי בלי תוכן', at: 3 * day }),
    futureUrgent: await orphan({ title: 'דחוף עתידי', at: 3 * day, urgent: true }),
    pastBare: await orphan({ title: 'עבר לא דחוף בלי תוכן', at: -3 * day }),
    // נשארים כהיסטוריה (בלי נקודה)
    pastUrgent: await orphan({ title: 'דחוף שעבר', at: -3 * day, urgent: true }),
    pastResults: await orphan({ title: 'עבר עם תוצאות', at: -4 * day }),
    pastLog: await orphan({ title: 'עבר עם יומן', at: -4 * day, status: 'failed', error: 'x' }),
    published: await orphan({ title: 'פורסם בלי נקודה', status: 'published', at: -day }),
    publishing: await orphan({ title: 'בדרך בלי נקודה', status: 'publishing', at: -5 }),
  };
  await q1('insert into post_results (post_id, reach) values ($1, 100) returning post_id', [p.pastResults]);
  await q1(
    `insert into publish_log (post_id, channel_id, platform, ok, error)
     values ($1, $2, 'facebook', false, 'x') returning id`, [p.pastLog, ids.fb]);
  const orphanTask = await q1(
    "insert into tasks (title, kind, post_id) values ('לכתוב', 'write', $1) returning id", [p.futureBare]);

  await db.pool.query("delete from app_migrations where key = 'orphan_posts_v1'");
  await db.migrate();

  const left = new Map((await qa(
    'select id, status, endpoint_id from posts where id = any($1::int[])',
    [Object.values(p)])).map((x) => [x.id, x]));
  assert.equal(left.get(p.withCamp).endpoint_id, ids.ep2, 'תוכן של קמפיין — הנקודה של התוכן/הקמפיין');
  assert.equal(left.get(p.loose).endpoint_id, ids.ep, 'תוכן שוטף בלי קמפיין — הנקודה של התוכן, לא נמחק');
  for (const k of ['futureBare', 'futureUrgent', 'pastBare']) assert.equal(left.has(p[k]), false, k);
  for (const k of ['pastUrgent', 'pastResults', 'pastLog', 'published', 'publishing']) {
    assert.ok(left.has(p[k]), k);
    assert.equal(left.get(p[k]).endpoint_id, null, k);
  }
  assert.equal(await q1('select id from tasks where id = $1', [orphanTask.id]), null,
    'המשימות של היתום שנמחק נמחקו איתו');

  // פעם אחת בלבד: עלייה נוספת לא מוחקת שוב
  const again = await orphan({ title: 'יתום אחרי הצעד' });
  await db.migrate();
  assert.equal(await statusOf(again), 'scheduled');
});

test('manual_only_v1: מאושר ונכשל שבוודאות לא יצא חוזרים למתוכנן; ארגון עם מתג דלוק — לא', { skip }, async () => {
  const p = {
    approved: await post({ status: 'approved', title: 'מאושר ישן' }),
    failed: await post({ status: 'failed', error: 'נכשל', at: -60, title: 'נכשל ישן' }),
    publishing: await post({ status: 'publishing', at: -3, title: 'בפרסום' }),
  };
  const failTask = await q1(
    "insert into tasks (title, kind, post_id, urgent) values ('נכשל', 'failed', $1, true) returning id",
    [p.failed]);

  // ארגון שני שהמתג שלו דלוק — manual_only_v1 לא נוגע בו
  const org2 = (await db.pool.query("insert into orgs (name) values ('manual-only-on') returning id")).rows[0].id;
  const kept = await db.withOrg(org2, async () => {
    await db.query('insert into engine_settings (autopublish_enabled) values (true)');
    const ep = (await db.one("insert into endpoints (name, importance) values ('א', 5) returning id")).id;
    const ch = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('פ', 'facebook', 7) returning id")).id;
    return (await db.one(
      `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, status)
       values ($1,$2,'מאושר דלוק','value', now() + interval '3 days', 'approved') returning id`,
      [ch, ep])).id;
  });

  await setAuto(false);
  await db.pool.query("delete from app_migrations where key = 'manual_only_v1'");
  await db.migrate();

  const left = new Map((await qa(
    'select id, status, publish_error, approved_at from posts where id = any($1::int[])',
    [Object.values(p)])).map((x) => [x.id, x]));
  assert.equal(left.get(p.approved).status, 'scheduled');
  assert.equal(left.get(p.approved).approved_at, null);
  assert.equal(left.get(p.failed).status, 'scheduled');
  assert.equal(left.get(p.failed).publish_error, null);
  assert.equal(left.get(p.publishing).status, 'publishing');
  assert.equal((await q1('select done from tasks where id = $1', [failTask.id])).done, true);

  const other = await db.withOrg(org2, () => db.one('select status from posts where id = $1', [kept]));
  assert.equal(other.status, 'approved', 'ארגון שהמתג שלו דלוק — לא נוגעים');
});
