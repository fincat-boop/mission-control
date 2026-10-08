import './_env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { isInlineSafeMime } from '../src/media.js';
import { mediaFileFilter } from '../src/routes/_shared.js';

/**
 * מסלול ההעלאה הישן (multipart → המסד) והגשת הקבצים ממנו. קודם: כל סוג
 * שהדפדפן הצהיר נשמר והוגש inline מהדומיין שלנו — קובץ HTML/JS שהעלה מי
 * שיש לו הרשאת תוכן רץ בשם הבעלים שפתח אותו.
 *
 * החלק מול המסד רץ רק במפורש, ורק מול מסד מקומי:
 *   LINKS_TEST_DB=1 DATABASE_URL=postgres://postgres@localhost:5434/<עותק> node --test test/upload-xss.test.js
 */

const filter = (mimetype) => new Promise((resolve) => {
  mediaFileFilter({}, { originalname: 'x', mimetype }, (err, ok) => resolve(err ?? ok));
});

test('העלאה במסלול הישן: רק סוגי המדיה של R2', async () => {
  for (const ok of ['image/png', 'video/mp4', 'application/pdf', 'audio/mpeg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
    assert.equal(await filter(ok), true, ok);
  }
  for (const badType of ['text/html', 'application/javascript', 'text/javascript', 'image/svg+xml',
    'application/xhtml+xml', 'text/xml', 'application/octet-stream', '', undefined]) {
    const r = await filter(badType);
    assert.ok(r instanceof Error, String(badType));
    assert.equal(r.code, 'UNSUPPORTED_MEDIA_TYPE');
  }
});

test('הגשה inline רק לתמונה/וידאו/אודיו/PDF — לא HTML, SVG, JS או Office', () => {
  for (const m of ['image/png', 'image/JPEG', 'video/mp4', 'audio/mpeg', 'application/pdf']) {
    assert.equal(isInlineSafeMime(m), true, m);
  }
  for (const m of ['text/html', 'image/svg+xml', 'application/javascript', 'text/plain',
    'application/msword', 'image/png; charset=x', null, undefined]) {
    assert.equal(isInlineSafeMime(m), false, String(m));
  }
});

/* ========================= מול המסד ========================= */

const DB_URL = process.env.DATABASE_URL ?? '';
const RUN = process.env.LINKS_TEST_DB === '1' && /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL);
const skip = RUN ? false : 'מסד בדיקה מקומי לא הוגדר (LINKS_TEST_DB=1 + DATABASE_URL מקומי)';

let db, server, base, org, ids;

before(async () => {
  if (!RUN) return;
  db = await import('../src/db.js');
  const { default: express } = await import('express');
  const { default: content } = await import('../src/routes/content.js');

  await db.migrate();
  org = (await db.pool.query("insert into orgs (name) values ('upload-xss-test') returning id")).rows[0].id;
  ids = await db.withOrg(org, async () => {
    await db.query('insert into engine_settings default values');
    const ep = (await db.one("insert into endpoints (name, importance) values ('קורס', 9) returning id")).id;
    const item = (await db.one(
      "insert into content_items (endpoint_id, kind, title) values ($1,'value','פריט') returning id", [ep])).id;
    // כמו קובץ שנשמר לפני התיקון — הסוג שהדפדפן הצהיר
    const asset = async (filename, mime, data) => (await db.one(
      `insert into content_assets (content_id, filename, mime, size_bytes, data)
       values ($1,$2,$3,$4,$5) returning id`, [item, filename, mime, data.length, Buffer.from(data)])).id;
    return {
      item,
      html: await asset('x.html', 'text/html', '<script>alert(1)</script>'),
      svg: await asset('x.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      png: await asset('x.png', 'image/png', 'PNG'),
      pdf: await asset('x.pdf', 'application/pdf', '%PDF'),
    };
  });

  const app = express();
  app.use((req, res, next) => {
    req.user = { id: null, name: 'בדיקה', is_owner: true };
    db.withOrg(org, () => new Promise((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      next();
    })).catch(() => {});
  });
  app.use(content);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res
    .status(err?.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (!RUN) return;
  server?.close();
  await db.pool.end();
});

test('קובץ HTML/SVG ישן במסד יורד כקובץ — לא נפתח כדף', { skip }, async () => {
  for (const id of [ids.html, ids.svg]) {
    const r = await fetch(`${base}/assets/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    assert.match(r.headers.get('content-disposition'), /^attachment;/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('content-security-policy'), 'sandbox');
  }
});

test('תמונה ו-PDF עדיין נפתחים בתצוגה מקדימה', { skip }, async () => {
  const png = await fetch(`${base}/assets/${ids.png}`);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('content-disposition'), /^inline;/);
  assert.equal(png.headers.get('content-security-policy'), 'sandbox');

  const pdf = await fetch(`${base}/assets/${ids.pdf}`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /^inline;/);
  assert.equal(pdf.headers.get('content-security-policy'), null);
});

async function uploadAs(path, name, type) {
  const fd = new FormData();
  fd.append('files', new Blob(['data'], { type }), name);
  return fetch(`${base}${path}`, { method: 'POST', body: fd });
}

test('העלאה במסלול הישן: HTML נדחה ב-415 ולא נשמר; תמונה נשמרת', { skip }, async () => {
  const count = () => db.withOrg(org, () => db.one(
    'select count(*)::int as n from content_assets where content_id = $1', [ids.item]));
  const before = (await count()).n;

  const bad = await uploadAs(`/content/${ids.item}/assets`, 'evil.html', 'text/html');
  assert.equal(bad.status, 415);
  assert.match((await bad.json()).error, /סוג קובץ לא נתמך/);
  const badJs = await uploadAs(`/campaigns/1/bulk`, 'a.js', 'application/javascript');
  assert.equal(badJs.status, 415);
  assert.equal((await count()).n, before);

  const ok = await uploadAs(`/content/${ids.item}/assets`, 'ok.png', 'image/png');
  assert.equal(ok.status, 201);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await count()).n, before + 1);
});
