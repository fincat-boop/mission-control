import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedCampaignFields, shiftNote, tidyCampaignDates } from '../public/js/core/campaignEdit.js';

test('shiftNote — כמה זזו, כמה שובצו מחדש וכמה מאושרים צריכים אישור מחדש', () => {
  assert.equal(shiftNote(null), '');
  assert.equal(shiftNote({ moved: 0, rescheduled: 0, approved: 0 }), '');
  assert.equal(shiftNote({ moved: 3, rescheduled: 0, approved: 0 }), '3 פוסטים זזו עם הקמפיין.');
  assert.equal(shiftNote({ moved: 1, rescheduled: 0, approved: 0 }), 'פוסט אחד זז עם הקמפיין.');
  assert.equal(shiftNote({ moved: 4, rescheduled: 2, approved: 1 }),
    '4 פוסטים זזו עם הקמפיין, 2 פוסטים שובצו מחדש כי התאריך החדש לא התאים ' +
    '(אחד מהם היה מאושר ויצטרך אישור מחדש).');
  assert.equal(shiftNote({ moved: 0, rescheduled: 1, approved: 0 }),
    'פוסט אחד שובץ מחדש כי התאריך החדש לא התאים.');
  assert.equal(shiftNote({ moved: 0, rescheduled: 3, approved: 2 }),
    '3 פוסטים שובצו מחדש כי התאריך החדש לא התאים (2 מהם היו מאושרים ויצטרכו אישור מחדש).');
});

const INITIAL = {
  name: 'בלאק פריידי', endpoint_id: 3, goal: null, starts_on: '2030-11-20', period: '2w',
  ends_on: '2030-12-03', channel_ids: [2, 5],
};
/** הערכים מהטופס כמו ש-onSave מקבל אותם, אחרי tidyCampaignDates */
const form = (o = {}) => tidyCampaignDates({ ...INITIAL, channel_ids: [5, 2], goal: '', ...o });

test('changedCampaignFields — בלי שינוי לא נשלח כלום (גם סדר ערוצים וריק מול null)', () => {
  assert.deepEqual(changedCampaignFields(INITIAL, form()), {});
});

test('changedCampaignFields — שינוי שם שולח רק שם: לא תאריכים, ערוצים או נקודת קצה', () => {
  assert.deepEqual(changedCampaignFields(INITIAL, form({ name: 'חדש' })), { name: 'חדש' });
  assert.deepEqual(changedCampaignFields(INITIAL, form({ channel_ids: [2] })), { channel_ids: [2] });
});

test('changedCampaignFields — התאריכים הולכים יחד', () => {
  assert.deepEqual(changedCampaignFields(INITIAL, form({ starts_on: '2030-11-27' })),
    { starts_on: '2030-11-27', period: '2w' });
  assert.deepEqual(changedCampaignFields(INITIAL, form({ period: '3w' })),
    { starts_on: '2030-11-20', period: '3w' });
  // ידני: גם הסיום; וסיום ידני שהשתנה
  assert.deepEqual(changedCampaignFields(INITIAL, form({ period: 'custom', ends_on: '2030-12-01' })),
    { starts_on: '2030-11-20', period: 'custom', ends_on: '2030-12-01' });
  const custom = { ...INITIAL, period: 'custom' };
  assert.deepEqual(changedCampaignFields(custom, tidyCampaignDates({ ...custom })), {});
  assert.deepEqual(
    changedCampaignFields(custom, tidyCampaignDates({ ...custom, ends_on: '2030-12-10' })),
    { starts_on: '2030-11-20', period: 'custom', ends_on: '2030-12-10' });
});
