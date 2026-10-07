import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * בטיחות הפרסום מול Postgres אמיתי: COMMIT שהתגלגל אחורה בשקט, פרסום
 * בשלבים (בלי טרנזקציה פתוחה בזמן הקריאה ל-Graph), "פרסם עכשיו" כשהדפדפן
 * מתנתק, ועריכה/מחיקה שמתנגשות בפרסום.
 *
 * רץ רק במפורש, ורק מול מסד מקומי זמני:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/mc_fix_b node --test test/publish-safety-db.test.js
 * (בלי המשתנים — מדולג.) כל הרצה בארגון חדש משלה.
 */
const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, org;

const inOrg = (fn) => db.withOrg(org, fn);
const q1 = (sql, params) => inOrg(() => db.one(sql, params));

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('publish-safety-test') returning id")).rows[0].id;
});

after(async () => {
  if (!RUN) return;
  await db.pool.end();
});

/* ---------- COMMIT שהתגלגל אחורה ---------- */

test('withOrg: שאילתה שנכשלה ונתפסה — ה-COMMIT מתגלגל אחורה, ו-withOrg זורק', { skip }, async () => {
  const name = `נקודה-${Date.now()}`;
  await assert.rejects(
    inOrg(async () => {
      await db.query('insert into endpoints (name, importance) values ($1, 5)', [name]);
      // שגיאה שנתפסה בקוד — הטרנזקציה כבר שבורה
      await db.query('select 1/0').catch(() => {});
    }),
    (e) => e instanceof db.CommitRolledBackError);
  // שום דבר לא נשמר — והקורא יודע את זה
  assert.equal(await q1('select id from endpoints where name = $1', [name]), null);
});

test('withOrg: טרנזקציה תקינה נשמרת ומחזירה את התוצאה', { skip }, async () => {
  const name = `נקודה-${Date.now()}`;
  const out = await inOrg(async () => {
    await db.query('insert into endpoints (name, importance) values ($1, 5)', [name]);
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.ok(await q1('select id from endpoints where name = $1', [name]));
});
