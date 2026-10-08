import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * השלמה אחרי השבתה (runner.js — CATCHUP_SQL): פוסטים שהמועד שלהם עבר
 * ביותר מ-OVERDUE_MINUTES יוצאים אחד לערוץ בכל טיק, ורק כשאף פוסט אחר
 * באותו ערוץ לא פורסם או נתפס ב-CATCHUP_SPACING_MINUTES האחרונות. פוסט בזמן
 * לא מושפע. הטיק עובד לפי now() של המסד — "הזמן עובר" = הזזת published_at
 * ו-publishing_started_at אחורה. Graph מדומה (fetch), בלי רשת.
 *
 * רץ רק במפורש, מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/mc_x node --test test/publish-catchup-db.test.js
 * כל הרצה בארגון חדש משלה.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, runner, org, ids;

const inOrg = (fn) => db.withOrg(org, fn);
const q1 = (sql, params) => inOrg(() => db.one(sql, params));
const status = async (id) => (await q1('select status from posts where id = $1', [id]))?.status ?? null;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  runner = await import('../src/publish/runner.js');
  const { encryptSecret } = await import('../src/publish/crypto.js');
  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('publish-catchup-test') returning id")).rows[0].id;
  ids = await inOrg(async () => {
    await db.query('insert into engine_settings (autopublish_enabled) values (true)');
    const ep = await db.one("insert into endpoints (name, importance) values ('קורס', 5) returning id");
    const channel = async (name, pageId) => {
      const c = await db.one(
        "insert into channels (name, platform, max_per_week) values ($1, 'facebook', 7) returning id", [name]);
      await db.query(
        `insert into channel_connections (channel_id, page_id, access_token_enc, auto_enabled)
         values ($1, $2, $3, true)`, [c.id, pageId, encryptSecret('tok')]);
      return c.id;
    };
    return { endpoint: ep.id, fb: await channel('פייסבוק', '9'), fb2: await channel('פייסבוק 2', '8') };
  });
});

after(async () => {
  if (!RUN) return;
  await db.pool.end();
});

/** פוסט מאושר עם תוכן מוכן. at — דקות מעכשיו (שלילי = עבר) */
async function duePost(title, { at, channel = ids.fb, status: st = 'approved' } = {}) {
  return inOrg(async () => {
    const ci = await db.one(
      `insert into content_items (title, kind, endpoint_id) values ($1, 'value', $2) returning id`,
      [title, ids.endpoint]);
    await db.query(
      `insert into content_variants (content_id, channel_id, body, status) values ($1,$2,'טקסט מוכן','ready')`,
      [ci.id, channel]);
    const p = await db.one(
      `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
       values ($1,$2,$3,$4,'value', now() + ($5 || ' minutes')::interval, $6) returning id`,
      [channel, ids.endpoint, ci.id, title, String(at), st]);
    return p.id;
  });
}

/** Graph מדומה: כל פרסום מצליח. מחזיר את הנתיבים שנקראו */
async function tick() {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(new URL(url).pathname.replace(/^\/v[\d.]+\//, ''));
    return new Response(JSON.stringify({ id: `x_${Date.now()}_${calls.length}` }), { status: 200 });
  };
  try {
    await runner.publishTickForOrg(org);
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

/** "עברו minutes דקות" מאז שהפוסטים פורסמו/נתפסו */
const age = (postIds, minutes) => inOrg(() => db.query(
  `update posts set published_at = published_at - ($2 || ' minutes')::interval,
                    publishing_started_at = publishing_started_at - ($2 || ' minutes')::interval
    where id = any($1)`, [postIds, String(minutes)]));

/** כל מה שפורסם/נתפס בארגון עד עכשיו — "לפני minutes דקות" */
const ageAll = (minutes) => inOrg(() => db.query(
  `update posts set published_at = published_at - ($1 || ' minutes')::interval,
                    publishing_started_at = publishing_started_at - ($1 || ' minutes')::interval`,
  [String(minutes)]));

/** רק הפוסטים של הבדיקה הזו מאושרים */
const onlyThese = (...keep) => inOrg(() => db.query(
  `update posts set status = 'scheduled' where status = 'approved' and not (id = any($1))`, [keep]));

test('שלושה פוסטים מאחרים באותו ערוץ — אחד לכל טיק, והבא רק אחרי 30 דקות', { skip }, async () => {
  const a = await duePost('מאחר 1', { at: -480 });
  const b = await duePost('מאחר 2', { at: -300 });
  const c = await duePost('מאחר 3', { at: -120 });
  await onlyThese(a, b, c);

  assert.deepEqual(await tick(), ['9/feed']);
  assert.equal(await status(a), 'published', 'הוותיק ביותר יוצא ראשון');
  assert.equal(await status(b), 'approved');
  assert.equal(await status(c), 'approved');

  // דקה אחרי — עדיין בתוך המרווח
  assert.deepEqual(await tick(), []);
  await age([a], runner.CATCHUP_SPACING_MINUTES - 2);
  assert.deepEqual(await tick(), [], 'פחות מ-30 דקות — מחכים');

  await age([a], 3);
  assert.deepEqual(await tick(), ['9/feed']);
  assert.equal(await status(b), 'published');
  assert.equal(await status(c), 'approved');

  await age([a, b], runner.CATCHUP_SPACING_MINUTES + 1);
  assert.deepEqual(await tick(), ['9/feed']);
  assert.equal(await status(c), 'published');
  assert.deepEqual(await tick(), []);
});

test('פוסט בזמן לא מושפע; ערוץ אחר משלים במקביל; ניסיון שנכשל לאחרונה גם נספר', { skip }, async () => {
  await ageAll(24 * 60);
  const recent = await duePost('פורסם לפני רגע', { at: -10 });
  await inOrg(() => db.query(
    `update posts set status = 'published', published_at = now(), publishing_started_at = now()
      where id = $1`, [recent]));
  const late = await duePost('מאחר בערוץ שפרסם הרגע', { at: -60 });
  const onTime = await duePost('בזמן', { at: -1 });
  const other = await duePost('מאחר בערוץ אחר', { at: -60, channel: ids.fb2 });
  await onlyThese(late, onTime, other);

  const calls = await tick();
  assert.deepEqual(calls.sort(), ['8/feed', '9/feed']);
  assert.equal(await status(onTime), 'published', 'בזמן — יוצא גם כשהערוץ פרסם הרגע');
  assert.equal(await status(other), 'published', 'מאחר בערוץ שקט — יוצא');
  assert.equal(await status(late), 'approved', 'מאחר בערוץ שפרסם הרגע — מחכה');

  // ניסיון שנתפס ונכשל (אולי עלה) לפני 10 דקות — גם הוא שומר מרווח
  await ageAll(60);
  const failed = await duePost('נכשל לפני רגע', { at: -20, channel: ids.fb2 });
  await inOrg(() => db.query(
    `update posts set status = 'failed', publishing_started_at = now() - interval '10 minutes'
      where id = $1`, [failed]));
  const late2 = await duePost('מאחר אחרי כשל', { at: -60, channel: ids.fb2 });
  await onlyThese(late, late2);
  assert.deepEqual(await tick(), ['9/feed'], 'בערוץ 1 עבר המרווח; בערוץ 2 — ניסיון לפני 10 דקות');
  assert.equal(await status(late), 'published');
  assert.equal(await status(late2), 'approved');
});

test('איחור של יותר מ-12 שעות — עדיין נכשל, גם כשהערוץ פרסם הרגע', { skip }, async () => {
  const old = await duePost('ישן מדי', { at: -13 * 60 });
  await onlyThese(old);
  assert.deepEqual(await tick(), []);
  const p = await q1('select status, publish_error from posts where id = $1', [old]);
  assert.equal(p.status, 'failed');
  assert.equal(p.publish_error, runner.TOO_LATE_ERROR);
});
