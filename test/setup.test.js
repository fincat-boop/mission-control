import './_env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessPlatform, setupSteps } from '../src/setup.js';

const step = (r, id) => r.steps.find((s) => s.id === id);

/* ========================= ארגון חדש ========================= */

test('setupSteps — ארגון ריק: שלושה צעדי חובה חסרים, בסדר הנכון', () => {
  const r = setupSteps({});
  assert.deepEqual(r.steps.map((s) => s.id),
    ['channel', 'platform', 'endpoint', 'content', 'connection', 'autopublish']);
  assert.deepEqual(r.missing_required, ['channel', 'endpoint', 'content']);
  assert.equal(r.complete, false);
  assert.deepEqual(r.steps.filter((s) => s.required).map((s) => s.id),
    ['channel', 'endpoint', 'content']);
});

test('setupSteps — בלי ערוצים ונקודות: הכפתור פותח הוספה', () => {
  const r = setupSteps({});
  assert.deepEqual(step(r, 'channel').target, { tab: 'manage', section: 'channels', add: true });
  assert.equal(step(r, 'channel').action, 'הוסף ערוץ');
  assert.deepEqual(step(r, 'endpoint').target, { tab: 'manage', section: 'endpoints', add: true });
  // תוכן שייך לנקודת קצה — בלעדיה הצעד חסום
  assert.equal(step(r, 'content').blocked, true);
  assert.deepEqual(step(r, 'content').target, { tab: 'plan' });
});

test('setupSteps — צעדים מומלצים שלא רלוונטיים לא נספרים', () => {
  const r = setupSteps({});
  assert.equal(step(r, 'platform').relevant, false);
  assert.equal(step(r, 'connection').relevant, false);
  assert.equal(step(r, 'autopublish').relevant, true);
  assert.equal(step(r, 'autopublish').info, true);
});

/* ========================= חובה ========================= */

test('setupSteps — ערוצים ונקודות מושבתים לא נחשבים, והכפתור מוביל אליהם', () => {
  const r = setupSteps({
    channels: [{ id: 1, name: 'בלוג', active: false }],
    endpoints: [{ id: 1, active: false }],
  });
  assert.equal(step(r, 'channel').done, false);
  assert.equal(step(r, 'channel').target.add, false);
  assert.match(step(r, 'channel').detail, /מושבתים/);
  assert.equal(step(r, 'endpoint').done, false);
  assert.match(step(r, 'endpoint').detail, /מושבתות/);
});

test('setupSteps — ערוץ + נקודה + קמפיין (גם בלי תוכן) = הקמה הושלמה', () => {
  const base = {
    channels: [{ id: 1, name: 'בלוג', active: true, platform: 'manual' }],
    endpoints: [{ id: 3, active: true }],
  };
  assert.equal(setupSteps({ ...base, campaigns: 1 }).complete, true);
  assert.equal(setupSteps({ ...base, content: 2 }).complete, true);
  const none = setupSteps(base);
  assert.deepEqual(none.missing_required, ['content']);
  assert.equal(step(none, 'content').blocked, false);
});

/* ========================= מומלץ ========================= */

test('guessPlatform — לפי השם, עברית ואנגלית', () => {
  assert.equal(guessPlatform('פייסבוק'), 'facebook');
  assert.equal(guessPlatform('עמוד Facebook'), 'facebook');
  assert.equal(guessPlatform('אינסטגרם'), 'instagram');
  assert.equal(guessPlatform('קבוצת וואטסאפ'), 'whatsapp');
  assert.equal(guessPlatform('ניוזלטר שבועי'), 'newsletter');
  assert.equal(guessPlatform('בלוג'), null);
  assert.equal(guessPlatform(null), null);
});

test('setupSteps — פלטפורמה: רק ערוץ פעיל שהשם שלו מסגיר אותה ונשאר ידני', () => {
  const r = setupSteps({
    channels: [
      { id: 6, name: 'פייסבוק', active: true, platform: 'manual' },
      { id: 7, name: 'אינסטגרם', active: true, platform: 'instagram' },
      { id: 8, name: 'ניוזלטר', active: false, platform: 'manual' },
      { id: 9, name: 'בלוג', active: true, platform: 'manual' },
    ],
  });
  const p = step(r, 'platform');
  assert.equal(p.relevant, true);
  assert.equal(p.done, false);
  assert.match(p.detail, /פייסבוק/);
  assert.doesNotMatch(p.detail, /ניוזלטר|בלוג|אינסטגרם/);
  assert.deepEqual(p.target, { tab: 'manage', channel: 6, focus: 'platform' });
});

test('setupSteps — חיבור: נדרש טוקן וגם בדיקה שעברה', () => {
  const channels = [
    { id: 6, name: 'פייסבוק', active: true, platform: 'facebook' },
    { id: 7, name: 'אינסטגרם', active: true, platform: 'instagram' },
    { id: 9, name: 'וואטסאפ', active: true, platform: 'whatsapp' },
  ];
  const notChecked = setupSteps({
    channels,
    connections: [
      { channel_id: 6, has_token: true, last_check_ok: null },
      { channel_id: 7, has_token: true, last_check_ok: true },
    ],
  });
  const c = step(notChecked, 'connection');
  assert.equal(c.relevant, true);
  assert.equal(c.done, false);
  assert.deepEqual(c.target, { tab: 'manage', channel: 6, focus: 'token' });
  assert.doesNotMatch(c.detail, /אינסטגרם|וואטסאפ/);

  const ok = setupSteps({
    channels,
    connections: [
      { channel_id: 6, has_token: true, last_check_ok: true },
      { channel_id: 7, has_token: true, last_check_ok: true },
    ],
  });
  assert.equal(step(ok, 'connection').done, true);
  // מומלץ לא משפיע על "הושלם"
  assert.equal(step(ok, 'platform').done, true);
});

test('setupSteps — מתג הפרסום האוטומטי: מידע, לא חובה', () => {
  const off = setupSteps({ autopublish: false });
  assert.equal(step(off, 'autopublish').done, false);
  assert.equal(step(off, 'autopublish').required, false);
  assert.equal(step(setupSteps({ autopublish: true }), 'autopublish').done, true);
});

/* ========================= הדלקת פרסום אוטומטי לערוץ ========================= */

test('autoEnableBlocker — הדלקה רק אחרי בדיקה שעברה, בלי טוקן חדש באותה בקשה', async () => {
  const { autoEnableBlocker } = await import('../src/routes/publish.js');
  const msg = 'בודקים חיבור לפני שמדליקים פרסום אוטומטי';
  // כיבוי / בלי שינוי — תמיד מותר
  assert.equal(autoEnableBlocker({ wantsAuto: false, saved: null }), null);
  assert.equal(autoEnableBlocker({ wantsAuto: undefined, newToken: true, saved: null }), null);
  // הדלקה: אין חיבור / לא נבדק / נכשל
  assert.equal(autoEnableBlocker({ wantsAuto: true, saved: null }), msg);
  assert.equal(autoEnableBlocker({ wantsAuto: true, saved: { last_check_ok: null } }), msg);
  assert.equal(autoEnableBlocker({ wantsAuto: true, saved: { last_check_ok: false } }), msg);
  // נבדק ועבר — מותר; אבל טוקן חדש באותה בקשה עוד לא נבדק
  assert.equal(autoEnableBlocker({ wantsAuto: true, saved: { last_check_ok: true } }), null);
  assert.equal(autoEnableBlocker({ wantsAuto: true, newToken: true, saved: { last_check_ok: true } }), msg);
});
