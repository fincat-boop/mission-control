import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * התראת "כמה פוסטים לאותה נקודה באותו יום" (alerts.js) מול Postgres אמיתי:
 * היום נספר בשעון ישראל גם כשהסשן של המסד ב-UTC (כמו בפרוד) — פוסט של
 * 01:00 שייך ליום שלו, לא לקודם; ופוסט של קמפיין מושהה או לא פעיל לא נספר
 * (כמו בלוח ובמנוע).
 *
 * רץ רק במפורש, מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/mc_x node --test test/clash-alert-db.test.js
 * כל הרצה בארגון חדש משלה.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, alerts, org, ch, day, nextDay;
const inOrg = (fn) => db.withOrg(org, fn);

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  alerts = await import('../src/alerts.js');
  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('clash-alert-test') returning id")).rows[0].id;
  await inOrg(async () => {
    await db.query('insert into engine_settings (min_gap_days) values (7)');
    ch = (await db.one(
      "insert into channels (name, platform, max_per_week) values ('פייסבוק', 'facebook', 7) returning id")).id;
    // יום בעוד שלושה ימים (תאריך ישראלי), והיום שאחריו
    const d = await db.one(
      `select ((now() at time zone 'Asia/Jerusalem')::date + 3)::text as day,
              ((now() at time zone 'Asia/Jerusalem')::date + 4)::text as next_day`);
    ({ day, next_day: nextDay } = d);
  });
});

after(async () => {
  if (!RUN) return;
  await db.pool.end();
});

/** נקודת קצה חדשה, ופוסטים שלה: [תאריך, 'HH:MM' שעון ישראל, קמפיין?] */
async function endpointWith(name, posts) {
  await inOrg(async () => {
    const ep = (await db.one('insert into endpoints (name, importance) values ($1, 5) returning id', [name])).id;
    for (const [date, time, campaign] of posts) {
      let campaignId = null;
      if (campaign) {
        campaignId = (await db.one(
          `insert into campaigns (endpoint_id, name, paused_at, active)
           values ($1, $2, case when $3 then now() end, $4) returning id`,
          [ep, `${name} — קמפיין`, campaign === 'paused', campaign !== 'inactive'])).id;
      }
      const ci = (await db.one(
        `insert into content_items (title, kind, endpoint_id, campaign_id)
         values ($1, 'value', $2, $3) returning id`, [`${name} ${time}`, ep, campaignId])).id;
      await db.query(
        `insert into posts (channel_id, endpoint_id, content_id, title, kind, scheduled_at, status)
         values ($1, $2, $3, $4, 'value', ($5::date + $6::time) at time zone 'Asia/Jerusalem', 'scheduled')`,
        [ch, ep, ci, `${name} ${time}`, date, time]);
    }
  });
}

/** ההתראות כשהסשן של המסד ב-UTC (כמו בפרוד) */
const clashAlertsUtc = () => inOrg(async () => {
  await db.query("set local timezone = 'UTC'");
  const { alerts: list } = await alerts.buildAlerts();
  return list.filter((a) => a.id.startsWith('clash-'));
});

test('יום בשעון ישראל: 23:00 ו-01:00 שאחריו — לא התנגשות; 01:00 ו-10:00 באותו יום — כן', { skip }, async () => {
  await endpointWith('חצות', [[day, '23:00'], [nextDay, '01:00']]);
  await endpointWith('בוקר', [[nextDay, '01:00'], [nextDay, '10:00']]);
  const list = await clashAlertsUtc();
  assert.equal(list.filter((a) => a.title.includes('חצות')).length, 0,
    '23:00 ו-01:00 הם שני ימים בישראל (ב-UTC — אותו יום)');
  const morning = list.filter((a) => a.title.includes('בוקר'));
  assert.equal(morning.length, 1);
  assert.equal(morning[0].id, `clash-בוקר-פייסבוק-${nextDay}`);
});

test('קמפיין מושהה או לא פעיל — הפוסט שלו לא נספר בהתנגשות', { skip }, async () => {
  await endpointWith('מושהה', [[day, '09:00'], [day, '18:00', 'paused']]);
  await endpointWith('לא פעיל', [[day, '09:00'], [day, '18:00', 'inactive']]);
  await endpointWith('פעיל', [[day, '09:00'], [day, '18:00', 'active']]);
  const list = await clashAlertsUtc();
  assert.equal(list.filter((a) => a.title.includes('מושהה')).length, 0);
  assert.equal(list.filter((a) => a.title.includes('לא פעיל')).length, 0);
  assert.equal(list.filter((a) => a.title.endsWith('— פעיל')).length, 1, 'קמפיין פעיל — נספר');
});
