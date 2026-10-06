import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * מרווח לכל קמפיין מול Postgres אמיתי: העמודה והאילוץ, השמירה בנתיבים
 * (יצירה, עדכון, שכפול), התצוגה המקדימה של הקיבולת, אזהרת המרווח בלוח
 * והמנוע — שלא משבץ בתוך המרווח של הקמפיין מול שכן משני הכיוונים.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני (אותו דגל כמו שאר בדיקות המסד):
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/mc_sched_test npm test
 * (בלי המשתנים — מדולג.) כל הרצה בארגון חדש משלה, ולכן אפשר להריץ שוב ושוב.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, server, base, org, ids, foreignChannel;
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
const q1 = (sql, params) => inOrg(() => db.one(sql, params));

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: campaigns } = await import('../src/routes/campaigns.js');
  const { default: board } = await import('../src/routes/board.js');

  // migrate רק כשהעמודה עוד לא קיימת: קובצי מסד אחרים רצים במקביל, ו-alter
  // table באמצע הבדיקות שלהם נתקע איתן ב-deadlock
  const has = await db.pool.query(
    `select 1 from information_schema.columns
      where table_name = 'campaigns' and column_name = 'min_gap_days'`);
  if (!has.rowCount) await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('sched-gap-test') returning id")).rows[0].id;
  ids = await inOrg(async () => {
    await db.query('insert into engine_settings default values');
    const ep = await db.one("insert into endpoints (name, importance) values ('קורס', 5) returning id");
    const fb = await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
       values ('פייסבוק', 'facebook', 5, 20) returning id`);
    return { endpoint: ep.id, fb: fb.id };
  });

  // ערוץ של ארגון אחר — אסור לקשר אליו קמפיין
  const other = (await db.pool.query("insert into orgs (name) values ('sched-gap-other') returning id"))
    .rows[0].id;
  foreignChannel = await db.withOrg(other, async () => (await db.one(
    "insert into channels (name, platform, max_per_week) values ('זר', 'manual', 3) returning id")).id);

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

/** נקודת קצה חדשה לכל בדיקה — קמפיינים של בדיקה אחת לא נספרים כאחים בשנייה */
const freshEndpoint = (name) => q1(
  'insert into endpoints (name, importance) values ($1, 5) returning id', [name]).then((e) => e.id);

/** קמפיין בלאק פריידי: 16 יום, 40% קבוע, על פייסבוק (5 בשבוע, 20% שמורים) */
const BF_BODY = (endpointId = ids.endpoint) => ({
  endpoint_id: endpointId, name: 'בלאק פריידי', starts_on: '2030-11-20', ends_on: '2030-12-05',
  period: 'custom', share_pct: 40, channel_ids: [ids.fb],
});

test('סכימה: min_gap_days קיים, null מותר, 1–30 מותר, 0 ו-31 נדחים באילוץ', { skip }, async () => {
  const col = await db.one(
    `select data_type, is_nullable from information_schema.columns
      where table_name = 'campaigns' and column_name = 'min_gap_days'`);
  assert.deepEqual(col, { data_type: 'integer', is_nullable: 'YES' });

  const tryGap = (v) => inOrg(async () => {
    await db.query('savepoint s');
    try {
      await db.query(
        `insert into campaigns (endpoint_id, name, min_gap_days) values ($1, 'בדיקה', $2)`,
        [ids.endpoint, v]);
      return 'ok';
    } catch (err) {
      return err.code;
    } finally {
      await db.query('rollback to savepoint s');   // שום שורה לא נשארת
    }
  });
  assert.equal(await tryGap(null), 'ok');
  assert.equal(await tryGap(1), 'ok');
  assert.equal(await tryGap(30), 'ok');
  assert.equal(await tryGap(0), '23514');
  assert.equal(await tryGap(31), '23514');
});

test('נתיבים: יצירה, עדכון ושכפול שומרים את המרווח; ערך לא תקין — 400 בעברית', { skip }, async () => {
  const ep = await freshEndpoint('נתיבים');
  const created = await call('POST', '/campaigns', { ...BF_BODY(ep), name: 'מרווח 3', min_gap_days: '3' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.campaign.min_gap_days, 3);
  const id = created.json.campaign.id;

  const bad = await call('PATCH', `/campaigns/${id}`, { min_gap_days: 31 });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /בין 1 ל-30/);
  const zero = await call('POST', '/campaigns', { ...BF_BODY(ep), min_gap_days: 0 });
  assert.equal(zero.status, 400);

  const dup = await call('POST', `/campaigns/${id}/duplicate`,
    { endpoint_id: ep, name: 'עותק', starts_on: '2030-11-20', ends_on: '2030-12-05', period: 'custom',
      channel_ids: [ids.fb] });
  assert.equal(dup.status, 201, JSON.stringify(dup.json));
  assert.equal(dup.json.campaign.min_gap_days, 3, 'השכפול מעתיק את המרווח');

  const cleared = await call('PATCH', `/campaigns/${id}`, { min_gap_days: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal(cleared.json.campaign.min_gap_days, null);

  // הרשימה ללקוח כוללת את המרווח
  const list = (await call('GET', '/campaigns')).json.campaigns;
  assert.equal(list.find((c) => c.id === dup.json.campaign.id).min_gap_days, 3);

  await inOrg(() => db.query('delete from campaigns where id = any($1::int[])',
    [[id, dup.json.campaign.id]]));
});

test('תצוגה מקדימה: עריכה (id) ויצירה (בלי id) — אותם מספרים כמו הרשת', { skip }, async () => {
  const ep = await freshEndpoint('תצוגה מקדימה');
  const c = (await call('POST', '/campaigns', BF_BODY(ep))).json.campaign;

  const edit = await call('POST', '/campaigns/capacity-preview', { id: c.id });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  assert.equal(edit.json.gap_days, 7);
  assert.deepEqual(edit.json.channels, [{
    channel_id: ids.fb, name: 'פייסבוק', wanted: 5, rate_cap: 4, capacity: 3, gap_cap: 3,
    siblings: 1, limited_by: 'gap', gap_to_fit: 5,
  }]);
  assert.equal(edit.json.short, true);
  assert.equal(edit.json.fixed, null);

  // הטיוטה מחליפה את השורה השמורה: מרווח 5 — לא נספר כאח של עצמו, ונכנס הכול
  const tight = await call('POST', '/campaigns/capacity-preview', { id: c.id, min_gap_days: 5 });
  assert.equal(tight.json.gap_days, 5);
  assert.equal(tight.json.channels[0].capacity, 4);
  assert.equal(tight.json.channels[0].siblings, 1);
  assert.equal(tight.json.short, false);

  // יצירה: אותו טופס בלי id — ועכשיו הקמפיין השמור הוא אח באותה נקודה וערוץ
  const fresh = await call('POST', '/campaigns/capacity-preview',
    { ...BF_BODY(ep), share_pct: 20, min_gap_days: 3 });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.json));
  assert.equal(fresh.json.channels[0].siblings, 2);
  assert.equal(fresh.json.channels[0].gap_cap, 3);   // 6 ימים במרווח 3, חלקי 2

  // מזהים כמחרוזות (כמו מטופס) — אותם מספרים בדיוק; קלט שבור — 400 ולא 500
  const asStrings = await call('POST', '/campaigns/capacity-preview',
    { ...BF_BODY(ep), endpoint_id: String(ep), channel_ids: [String(ids.fb)], share_pct: '20',
      min_gap_days: 3 });
  assert.deepEqual(asStrings.json, fresh.json);
  for (const body of [{ id: 'abc' }, { id: 1.5 }, { ...BF_BODY(ep), endpoint_id: 'x' },
                      { ...BF_BODY(ep), channel_ids: ['x'] }, { ...BF_BODY(ep), channel_ids: 6 },
                      { ...BF_BODY(ep), share_pct: 0 }, { ...BF_BODY(ep), share_pct: 101 }]) {
    const r = await call('POST', '/campaigns/capacity-preview', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // השמירה בודקת את הנתח גם בשרת
  assert.equal((await call('POST', '/campaigns', { ...BF_BODY(ep), share_pct: 150 })).status, 400);
  assert.equal((await call('PATCH', `/campaigns/${c.id}`, { share_pct: 0 })).status, 400);

  // אותן בדיקות כמו בשמירה
  const noEp = await call('POST', '/campaigns/capacity-preview', { starts_on: '2030-11-20' });
  assert.equal(noEp.status, 400);
  const badGap = await call('POST', '/campaigns/capacity-preview', { id: c.id, min_gap_days: 40 });
  assert.equal(badGap.status, 400);
  const backwards = await call('POST', '/campaigns/capacity-preview',
    { id: c.id, ends_on: '2030-11-01' });
  assert.equal(backwards.status, 400);
  assert.equal((await call('POST', '/campaigns/capacity-preview', { id: 999999 })).status, 404);

  // שום דבר לא נכתב
  assert.equal((await q1('select min_gap_days from campaigns where id = $1', [c.id])).min_gap_days,
    null);

  // קמפיין מוכן: כמה נכתב לכל ערוץ
  await inOrg(async () => {
    for (let i = 1; i <= 5; i += 1) {
      const it = await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title, sort_order, slot_channel_id)
         values ($1,$2,'value',$3,$4,$5) returning id`,
        [ep, c.id, `פוסט ${i}`, i, ids.fb]);
      await db.query(
        `insert into content_variants (content_id, channel_id, body, status) values ($1,$2,'x','draft')`,
        [it.id, ids.fb]);
    }
    await db.query('update campaigns set content_complete_at = now() where id = $1', [c.id]);
  });
  const fixed = await call('POST', '/campaigns/capacity-preview', { id: c.id });
  assert.deepEqual(fixed.json.fixed, { channels: [{
    channel_id: ids.fb, written: 5, capacity: 3, gap_to_fit: null, end_to_fit: '2030-12-18',
  }] });

  await inOrg(async () => {
    await db.query('delete from content_items where campaign_id = $1', [c.id]);
    await db.query('delete from campaigns where id = $1', [c.id]);
  });
});

test('gapWarning — המרווח של הקמפיין של התוכן, ובלי קמפיין — הכללי', { skip }, async () => {
  const { gapWarning } = await import('../src/gap.js');
  await inOrg(async () => {
    const camp = await db.one(
      `insert into campaigns (endpoint_id, name, starts_on, ends_on, min_gap_days)
       values ($1, 'צפוף', '2030-11-01', '2030-11-30', 3) returning id`, [ids.endpoint]);
    const it = await db.one(
      `insert into content_items (endpoint_id, campaign_id, kind, title)
       values ($1,$2,'value','פריט') returning id`, [ids.endpoint, camp.id]);
    const post = await db.one(
      `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at)
       values ($1,$2,'קיים','value','2030-11-10T10:00:00+02:00') returning id`,
      [ids.fb, ids.endpoint]);
    const at = (d) => `2030-11-${d}T10:00:00+02:00`;
    const base = { endpointId: ids.endpoint, channelId: ids.fb };

    // 4 ימים אחרי: מרווח 3 של הקמפיין — בסדר; הכללי (7) — אזהרה
    assert.equal(await gapWarning({ ...base, when: at(14), contentId: it.id }), null);
    assert.equal(await gapWarning({ ...base, when: at(14), campaignId: camp.id }), null);
    const general = await gapWarning({ ...base, when: at(14) });
    assert.equal(general.min, 7);
    assert.equal(general.days, 4);
    // יומיים לפני (שכן עתידי) — גם במרווח 3 זו אזהרה, עם שם הקמפיין
    const near = await gapWarning({ ...base, when: at('08'), contentId: it.id });
    assert.equal(near.min, 3);
    assert.equal(near.days, 2);
    assert.match(near.message, /לקמפיין "צפוף" הוא 3 ימים/);

    await db.query('delete from posts where id = $1', [post.id]);
    await db.query('delete from content_items where id = $1', [it.id]);
    await db.query('delete from campaigns where id = $1', [camp.id]);
  });
});

test('המנוע: לא משבץ בתוך המרווח של הקמפיין מול שכן לפני או אחרי', { skip }, async () => {
  const { planWeek } = await import('../src/engine.js');
  const { nearestDays } = await import('../src/engine.js');
  await inOrg(async () => {
    const ch = await db.one(
      `insert into channels (name, platform, max_per_week, urgent_reserve_pct)
       values ('ערוץ מנוע', 'manual', 7, 0) returning id`);
    const mk = async (name, gap) => {
      const camp = await db.one(
        `insert into campaigns (endpoint_id, name, starts_on, ends_on, min_gap_days)
         values ($1,$2,'2030-11-01','2030-11-30',$3) returning id`, [ids.endpoint, name, gap]);
      await db.query('insert into campaign_channels values ($1,$2)', [camp.id, ch.id]);
      const items = [];
      for (let i = 1; i <= 4; i += 1) {
        const it = await db.one(
          `insert into content_items (endpoint_id, campaign_id, kind, title, sort_order)
           values ($1,$2,'value',$3,$4) returning id`, [ids.endpoint, camp.id, `${name} ${i}`, i]);
        await db.query(
          `insert into content_variants (content_id, channel_id, body, status)
           values ($1,$2,'x','ready')`, [it.id, ch.id]);
        items.push(it.id);
      }
      return { camp: camp.id, items };
    };
    const tight = await mk('מרווח 3', 3);
    const loose = await mk('ברירת מחדל', null);
    // שכנים: 15.11 (לפני השבוע) ו-25.11 (אחריו). שבוע 17–23.11.
    for (const d of ['2030-11-15', '2030-11-25']) {
      await db.query(
        `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at)
         values ($1,$2,'שכן','value',$3)`, [ch.id, ids.endpoint, `${d}T10:00:00+02:00`]);
    }

    const plan = await planWeek('2030-11-19', { holes: false });
    const mine = plan.placements.filter((p) => p.channel_id === ch.id);
    assert.ok(mine.length >= 1, 'משהו נכנס');
    const days = ['2030-11-15', '2030-11-25'];
    for (const p of mine) {
      assert.ok(tight.items.includes(p.content_id),
        `תוכן במרווח 7 לא נכנס בין 15 ל-25 (${p.title} ${p.date})`);
      // 17.11 עבר קודם (נבדק רק 25.11 — max), למרות שהוא יומיים אחרי 15.11
      assert.ok(nearestDays(days, p.date) >= 3, `${p.date} קרוב מדי לשכן`);
      days.push(p.date);
    }
    // גם בין השיבוצים עצמם — לפחות 3 ימים
    const placed = mine.map((p) => p.date).sort();
    for (let i = 1; i < placed.length; i += 1) {
      assert.ok(nearestDays([placed[i - 1]], placed[i]) >= 3, placed.join(','));
    }
    assert.ok(!placed.includes('2030-11-17'));

    await db.query('delete from posts where channel_id = $1', [ch.id]);
    await db.query('delete from content_items where campaign_id = any($1::int[])',
      [[tight.camp, loose.camp]]);
    await db.query('delete from campaigns where id = any($1::int[])', [[tight.camp, loose.camp]]);
    await db.query('delete from channels where id = $1', [ch.id]);
  });
});

test('ערוצים: מזהה של ארגון אחר או לא קיים — 400, ושום קישור לא נוצר', { skip }, async () => {
  const ep = await freshEndpoint('ערוצים');
  const foreign = await call('POST', '/campaigns', { ...BF_BODY(ep), channel_ids: [ids.fb, foreignChannel] });
  assert.equal(foreign.status, 400);
  assert.match(foreign.json.error, /לא קיים/);
  assert.equal((await call('POST', '/campaigns', { ...BF_BODY(ep), channel_ids: [987654] })).status, 400);

  const c = (await call('POST', '/campaigns', { ...BF_BODY(ep), channel_ids: [String(ids.fb)] })).json.campaign;
  const patch = await call('PATCH', `/campaigns/${c.id}`, { channel_ids: [foreignChannel] });
  assert.equal(patch.status, 400);
  const dup = await call('POST', `/campaigns/${c.id}/duplicate`,
    { endpoint_id: ep, name: 'עותק', starts_on: '2030-11-20', ends_on: '2030-12-05', period: 'custom',
      channel_ids: [foreignChannel] });
  assert.equal(dup.status, 400);
  const prev = await call('POST', '/campaigns/capacity-preview', { id: c.id, channel_ids: [foreignChannel] });
  assert.equal(prev.status, 400);

  // הקישור לא השתנה; ובדיקה ישירה בלי RLS שאין קישור לערוץ הזר בכלל
  const links = await inOrg(() => db.rows(
    'select channel_id from campaign_channels where campaign_id = $1', [c.id]));
  assert.deepEqual(links.map((x) => x.channel_id), [ids.fb]);
  const leaked = await db.pool.query(
    'select 1 from campaign_channels where channel_id = $1', [foreignChannel]);
  assert.equal(leaked.rowCount, 0);

  await inOrg(() => db.query('delete from campaigns where id = $1', [c.id]));
});

test('שיוך תוכן והחלפת תוכן בפוסט: אזהרת מרווח לפי הקמפיין של התוכן החדש', { skip }, async () => {
  const ep = await freshEndpoint('שיוך');
  const made = await inOrg(async () => {
    const mk = async (name, gap) => {
      const camp = await db.one(
        `insert into campaigns (endpoint_id, name, starts_on, ends_on, min_gap_days)
         values ($1,$2,'2030-11-01','2030-11-30',$3) returning id`, [ep, name, gap]);
      const it = await db.one(
        `insert into content_items (endpoint_id, campaign_id, kind, title)
         values ($1,$2,'value',$3) returning id`, [ep, camp.id, name]);
      await db.query(
        `insert into content_variants (content_id, channel_id, body, status) values ($1,$2,'x','ready')`,
        [it.id, ids.fb]);
      return { camp: camp.id, item: it.id };
    };
    const tight = await mk('צפוף', 3);
    const loose = await mk('מרווח שבוע', 7);
    // שכן ב-10.11; פוסט חסר תוכן ב-14.11 (4 ימים אחרי)
    await db.query(
      `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at)
       values ($1,$2,'שכן','value','2030-11-10T10:00:00+02:00')`, [ids.fb, ep]);
    const hole = await db.one(
      `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at)
       values ($1,$2,'חסר תוכן','value','2030-11-14T10:00:00+02:00') returning id`, [ids.fb, ep]);
    return { tight, loose, hole: hole.id };
  });

  // מרווח 7: צמוד מדי — 409 עם אישור; מרווח 3 — עובר
  const warn = await call('POST', `/posts/${made.hole}/attach-content`, { content_id: made.loose.item });
  assert.equal(warn.status, 409, JSON.stringify(warn.json));
  assert.equal(warn.json.needs_confirm, true);
  assert.match(warn.json.error, /מרווח שבוע/);
  const ok = await call('POST', `/posts/${made.hole}/attach-content`, { content_id: made.tight.item });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));

  // החלפת התוכן בלבד (PATCH בלי הזזה) לתוכן של קמפיין במרווח 7 — אזהרה, ואז אישור
  const swap = await call('PATCH', `/posts/${made.hole}`, { content_id: made.loose.item });
  assert.equal(swap.status, 409, JSON.stringify(swap.json));
  assert.equal(swap.json.needs_confirm, true);
  const same = await call('PATCH', `/posts/${made.hole}`, { content_id: made.tight.item, note: 'x' });
  assert.equal(same.status, 200, 'אותו תוכן — אין אזהרה');
  const confirmed = await call('PATCH', `/posts/${made.hole}`,
    { content_id: made.loose.item, confirm_gap: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(confirmed.json.post.content_id, made.loose.item);

  await inOrg(async () => {
    await db.query('delete from posts where endpoint_id = $1', [ep]);
    await db.query('delete from content_items where endpoint_id = $1', [ep]);
    await db.query('delete from campaigns where endpoint_id = $1', [ep]);
  });
});
