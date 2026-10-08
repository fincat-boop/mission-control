import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compressGap, completeFit, daysLabel, fitsText, gapReason, joinHe, postsLabel, rateNoteText,
  sameShortage, shortChannels, totalCapacity, validGap,
} from '../public/js/core/fitChoice.js';

const ch = (o) => ({ channel_id: 1, name: 'פייסבוק', wanted: 5, rate_cap: 4, capacity: 3,
  gap_cap: 3, siblings: 1, limited_by: 'gap', gap_to_fit: 5, ...o });

const PREVIEW = {
  from: '2030-11-20', to: '2030-12-10', gap_days: 7, short: true, fixed: null,
  channels: [
    ch({}),
    ch({ channel_id: 2, name: 'אינסטגרם', capacity: 2, rate_cap: 4, gap_to_fit: 4, siblings: 2 }),
    ch({ channel_id: 3, name: 'לינקדאין', capacity: 2, rate_cap: 2, limited_by: 'rate', gap_to_fit: null }),
  ],
};

test('shortChannels — רק ערוצים שהמרווח מקצץ בהם', () => {
  assert.deepEqual(shortChannels(PREVIEW).map((c) => c.channel_id), [1, 2]);
  assert.deepEqual(shortChannels(null), []);
  // המרווח מגביל אבל הכול נכנס — לא חסר
  assert.deepEqual(shortChannels({ channels: [ch({ capacity: 4 })] }), []);
});

test('compressGap — הקטן מבין gap_to_fit, ו-null כשאין', () => {
  assert.equal(compressGap(shortChannels(PREVIEW)), 4);
  assert.equal(compressGap([ch({ gap_to_fit: null }), ch({ gap_to_fit: 6 })]), 6);
  assert.equal(compressGap([ch({ gap_to_fit: null })]), null);
  assert.equal(compressGap([]), null);
});

test('fitsText / totalCapacity — כמה נכנס, לכל הערוצים או לחלק', () => {
  assert.equal(fitsText(PREVIEW), 'פייסבוק 3, אינסטגרם 2, לינקדאין 2');
  assert.equal(fitsText(PREVIEW, [2, 1]), 'פייסבוק 3, אינסטגרם 2');
  assert.equal(totalCapacity(PREVIEW), 7);
  assert.equal(totalCapacity({ channels: [] }), 0);
});

test('gapReason — המרווח, ואחים רק כשיש', () => {
  assert.equal(gapReason(PREVIEW, [PREVIEW.channels[0]]),
    'המרווח בין פוסטים של אותה נקודת קצה באותו ערוץ הוא 7 ימים.');
  assert.equal(gapReason(PREVIEW, shortChannels(PREVIEW)),
    'המרווח בין פוסטים של אותה נקודת קצה באותו ערוץ הוא 7 ימים ' +
    '(מתחלק עם עוד קמפיין אחד של אותה נקודה).');
  assert.match(gapReason({ gap_days: 1 }, [ch({ siblings: 4 })]),
    /יום אחד \(מתחלק עם עוד 3 קמפיינים של אותה נקודה\)\.$/);
});

test('sameShortage — אותו מחסור בלי קשר לסדר; שינוי בקיבולת = מחסור אחר', () => {
  const reordered = { ...PREVIEW, channels: [...PREVIEW.channels].reverse() };
  assert.equal(sameShortage(PREVIEW, reordered), true);
  const changed = { ...PREVIEW, channels: [ch({ capacity: 2 }), PREVIEW.channels[1]] };
  assert.equal(sameShortage(PREVIEW, changed), false);
  assert.equal(sameShortage({ channels: [] }, PREVIEW), false);
});

test('completeFit — רק ערוצים שנכתב בהם יותר ממה שנכנס', () => {
  const fixed = { channels: [
    { channel_id: 1, written: 5, capacity: 3, rate_cap: 4, rate_short: true, gap_to_fit: 3,
      end_to_fit: '2030-12-18' },
    { channel_id: 2, written: 4, capacity: 2, rate_cap: 4, rate_short: false, gap_to_fit: 5,
      end_to_fit: '2030-12-25' },
    { channel_id: 3, written: 2, capacity: 2, rate_cap: 2, rate_short: false, gap_to_fit: 7,
      end_to_fit: '2030-12-01' },
  ] };
  const fit = completeFit({ gap_days: 7, fixed }, { 1: 'פייסבוק', 2: 'אינסטגרם', 3: 'לינקדאין' });
  assert.deepEqual(fit.rows.map((r) => [r.name, r.written, r.capacity]),
    [['פייסבוק', 5, 3], ['אינסטגרם', 4, 2]]);
  assert.equal(fit.gap, 3);
  assert.deepEqual(fit.rateNotes.map((r) => r.name), ['פייסבוק']);
  assert.equal(fit.extendTo, '2030-12-25');
  assert.equal(fit.lost, 4);

  // אין לאן להאריך ואין מרווח שמכיל — שתי האפשרויות נעלמות
  // מרווח שאינו קצר מהנוכחי — אין מה לדחוס (הקצב חוסם)
  assert.equal(completeFit({ gap_days: 3, fixed }).gap, null);

  const none = completeFit({ gap_days: 7, fixed: { channels: [
    { channel_id: 1, written: 50, capacity: 3, rate_cap: 4, rate_short: true, gap_to_fit: null,
      end_to_fit: null }] } });
  assert.equal(none.gap, null);
  assert.equal(none.extendTo, null);
  assert.equal(none.lost, 47);

  // הכול נכנס, או שאין fixed — אין מה להציג
  assert.equal(completeFit({ fixed: { channels: [fixed.channels[2]] } }), null);
  assert.equal(completeFit({ fixed: null }), null);
});

test('תוויות ומרווח תקין', () => {
  assert.equal(postsLabel(1), 'פוסט אחד');
  assert.equal(postsLabel(3), '3 פוסטים');
  assert.equal(daysLabel(1), 'יום אחד');
  assert.equal(daysLabel(5), '5 ימים');
  for (const n of [1, 7, 30]) assert.equal(validGap(n), true);
  for (const n of [0, 31, 2.5, NaN, null]) assert.equal(validGap(n), false);
});

test('rateNoteText — משפט אחד לכל תקרה, עם חיבור שמות בעברית', () => {
  assert.equal(joinHe(['א']), 'א');
  assert.equal(joinHe(['א', 'ב', 'ג']), 'א, ב וג');
  assert.equal(rateNoteText([{ name: 'פייסבוק', rate_cap: 4 }]),
    'גם בדחיסה, פייסבוק יכניס עד 4 — הקצב של הערוץ.');
  assert.equal(rateNoteText([{ name: 'פייסבוק', rate_cap: 4 }, { name: 'אינסטגרם', rate_cap: 4 },
                             { name: 'וואטסאפ', rate_cap: 2 }]),
    'גם בדחיסה, פייסבוק ואינסטגרם יכניסו עד 4 כל אחד — הקצב של הערוץ. ' +
    'גם בדחיסה, וואטסאפ יכניס עד 2 — הקצב של הערוץ.');
  assert.equal(rateNoteText([]), '');
});

/* ========================= חלון ההתאמה — מה נספר ========================= */

import { defaultGapLabel, windowNotes } from '../public/js/core/fitChoice.js';

test('windowNotes — התחלה בעבר: רק מהיום; ארוך מ-26 שבועות: השבועות שאחרי יתמלאו כשיתקרבו', () => {
  assert.deepEqual(windowNotes({ channels: [] }), []);
  const past = windowNotes({ started_past: true, starts_on: '2026-09-01', from: '2026-10-08',
                             channels: [] });
  assert.deepEqual(past, ['הקמפיין התחיל ב-1.9 — נספר רק מה שעוד אפשר לשבץ, מ-8.10.']);
  const long = windowNotes({ to: '2027-04-10', later_from: '2027-04-11',
    channels: [{ channel_id: 1, later: 20 }, { channel_id: 2, later: 6 }] }, [1]);
  assert.deepEqual(long, ['השבועות שאחרי 10.4 יתמלאו כשיתקרבו (עוד 20 פוסטים עד סוף הקמפיין).']);
  // קמפיין מוכן — לפי fixed
  const fixed = windowNotes({ to: '2027-04-10', later_from: '2027-04-11', channels: [],
    fixed: { channels: [{ channel_id: 1, later: 1 }] } });
  assert.match(fixed[0], /עוד פוסט אחד עד סוף הקמפיין/);
});

test('rateNoteText — מגבלת המכירתיים ולא "הקצב" כשהיא שמגבילה', () => {
  assert.equal(rateNoteText([{ name: 'וואטסאפ', rate_cap: 2, rate_reason: 'promo' }]),
    'גם בדחיסה, וואטסאפ יכניס עד 2 — מגבלת המכירתיים בערוץ.');
  assert.equal(rateNoteText([{ name: 'פייסבוק', rate_cap: 4 }]),
    'גם בדחיסה, פייסבוק יכניס עד 4 — הקצב של הערוץ.');
});

test('defaultGapLabel / gapReason — ברירת מחדל לכל ערוץ (סעיף 5)', () => {
  assert.equal(defaultGapLabel({ gap_days: 1, channels: [{ name: 'א', gap_days: 1 }] }),
    'ברירת המחדל (יום אחד)');
  assert.equal(defaultGapLabel({ gap_days: 3, channels: [{ name: 'א', gap_days: 1 },
                                                        { name: 'ב', gap_days: 3 }] }),
    'ברירת המחדל, לפי הקצב של כל ערוץ (א יום אחד, ב 3 ימים)');
  assert.match(gapReason({ gap_days: 7 }, [{ gap_days: 3, siblings: 1 }]), /הוא 3 ימים\.$/);
});
