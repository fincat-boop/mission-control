import { Router } from 'express';
import { EMPTY_FILL, autoFill, bad, updateById, wrap } from './_shared.js';
import {
  campaignsWithHealth, completionSummary, currentAllocation, loadCapacityPreview, resolvePeriod,
  structureChangeError,
} from '../campaigns.js';
import { currentOrg, one, rows, tx } from '../db.js';
import { TRASH_DAYS, mediaReady, mediaStore, newMediaKey } from '../media.js';
import { requirePerm } from '../auth.js';
import { isDate, rerunPeriod, runName } from '../../public/js/core/period.js';
import { ymd } from '../board.js';

const r = Router();

/* ========================= קמפיינים ========================= */

/** כל הקמפיינים עם מצב מלאות, קצב והתוכן שמשויך אליהם */
r.get('/campaigns', wrap(async (_req, res) => {
  const campaigns = await campaignsWithHealth();
  const allocation = await currentAllocation();
  const milestones = await rows(`select m.*, e.name as endpoint_name
          from strategy_milestones m
          left join endpoints e on e.id = m.endpoint_id
         order by m.on_date`);
  res.json({ campaigns, allocation, milestones });
}));

const CAMPAIGN_FIELDS = ['name', 'endpoint_id', 'starts_on', 'ends_on', 'share_pct',
                         'importance', 'target_posts', 'goal', 'urgent', 'active',
                         'period', 'structure', 'recurring', 'min_gap_days'];

/** מחיל את resolvePeriod על גוף הבקשה. מחזיר הודעת שגיאה או null. */
function applyPeriod(b, before) {
  const r = resolvePeriod(b, before);
  if (r.error) return r.error;
  if ('period' in r) b.period = r.period;
  if ('ends_on' in r) b.ends_on = r.ends_on;
  const start = b.starts_on !== undefined ? b.starts_on : before?.starts_on;
  const end = b.ends_on !== undefined ? b.ends_on : before?.ends_on;
  if (start && end && start > end) return 'תאריך הסיום מוקדם מתאריך ההתחלה';
  // בקמפיין כללי המשבצות נפרסות על החלון — בלי תאריכים אין משבצות
  const structure = b.structure ?? before?.structure ?? 'general';
  if (structure === 'general' && (!start || !end)) {
    return 'בקמפיין כללי צריך תאריך יעד לפוסט הראשון ותקופה';
  }
  return null;
}

/** מעדכן על אילו מדיות הקמפיין יושב */
async function setCampaignChannels(client, campaignId, ids) {
  await client.query('delete from campaign_channels where campaign_id = $1', [campaignId]);
  for (const channelId of ids) {
    await client.query(
      `insert into campaign_channels (campaign_id, channel_id) values ($1,$2)
       on conflict do nothing`,
      [campaignId, channelId]
    );
  }
}

/** תאריך שנשלח חייב להיות תאריך אמיתי — לפני כל כתיבה (או העתקת קבצים ב-R2) */
function datesError(b) {
  if (b.starts_on != null && !isDate(b.starts_on)) return 'תאריך היעד לפוסט הראשון לא תקין';
  if (b.ends_on != null && !isDate(b.ends_on)) return 'תאריך הסיום לא תקין';
  return null;
}

/**
 * המרווח בין פוסטים של הקמפיין: מספר שלם 1–30, או null/ריק = ברירת המחדל
 * הכללית. מנרמל את b.min_gap_days במקום (מחרוזת מהטופס → מספר, '' → null),
 * כדי שהשמירה והתצוגה המקדימה יקבלו אותו ערך. אותו טווח כמו האילוץ במסד.
 * @returns {string|null} הודעת שגיאה, או null
 */
export function gapDaysError(b) {
  if (!('min_gap_days' in b) || b.min_gap_days === undefined) return null;
  const v = b.min_gap_days;
  if (v === null || v === '') { b.min_gap_days = null; return null; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 30) {
    return 'המרווח בין פוסטים צריך להיות מספר שלם של ימים, בין 1 ל-30';
  }
  b.min_gap_days = n;
  return null;
}

/** בדיקות של קמפיין חדש (גם בשכפול). מחזיר הודעת שגיאה או null. */
function newCampaignError(b) {
  if (!b.endpoint_id || !b.name) return 'צריך נקודת קצה ושם קמפיין';
  const dateErr = datesError(b);
  if (dateErr) return dateErr;
  const gapErr = gapDaysError(b);
  if (gapErr) return gapErr;
  const periodErr = applyPeriod(b, null);
  if (periodErr) return periodErr;
  // קמפיין חדש הוא כללי. "לפי זוויות" נשאר רק לקמפיינים ישנים (ולשכפול שלהם);
  // קישור פוסטים בין ערוצים מחליף אותו.
  return structureChangeError('general', b.structure ?? 'general', 0);
}

async function insertCampaign(b) {
  const c = await one(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, share_pct,
                            importance, target_posts, goal, urgent, period, structure,
                            min_gap_days)
     values ($1,$2,$3,$4,$5,
             coalesce($6,(select importance from endpoints where id = $1)),
             $7,$8,coalesce($9,false),$10,coalesce($11,'general'),$12)
     returning *`,
    [b.endpoint_id, b.name, b.starts_on ?? null, b.ends_on ?? null, b.share_pct ?? null,
     b.importance ?? null, b.target_posts ?? null, b.goal ?? null, b.urgent ?? false,
     b.period ?? null, b.structure ?? null, b.min_gap_days ?? null]
  );
  if (Array.isArray(b.channel_ids)) {
    await tx((client) => setCampaignChannels(client, c.id, b.channel_ids));
  }
  return c;
}

r.post('/campaigns', requirePerm('settings'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const err = newCampaignError(b);
  if (err) return bad(res, err);
  const c = await insertCampaign(b);
  const engine = await autoFill(b.week);
  res.status(201).json({ campaign: c, engine });
}));

/** השדות של הטופס שמשנים את הקיבולת — מה שהתצוגה המקדימה לוקחת מהגוף */
const PREVIEW_FIELDS = ['endpoint_id', 'starts_on', 'ends_on', 'period', 'share_pct',
                        'min_gap_days', 'structure'];

/**
 * כמה נכנס לקמפיין שבטופס, לפני שמירה — לחלון ההתאמה (לדחוס / להאריך /
 * להסתפק). גוף = השדות כמו שהטופס שולח בשמירה (id בעריכה, endpoint_id,
 * starts_on, period ו/או ends_on, channel_ids, share_pct, min_gap_days).
 * אותן בדיקות כמו בשמירה (תאריכים, מרווח, תקופה), בלי לכתוב כלום. בעריכה
 * הטיוטה מחליפה את השורה השמורה; ערוצים שלא נשלחו — של הקמפיין השמור.
 * החישוב: loadCapacityPreview (src/campaigns.js).
 */
r.post('/campaigns/capacity-preview', requirePerm('settings'), wrap(async (req, res) => {
  const b = { ...(req.body ?? {}) };
  let before = null;
  if (b.id != null) {
    before = await one('select * from campaigns where id = $1', [b.id]);
    if (!before) return bad(res, 'לא נמצא קמפיין כזה', 404);
  } else if (!b.endpoint_id) {
    return bad(res, 'צריך נקודת קצה');
  }
  const err = datesError(b) ?? gapDaysError(b) ?? applyPeriod(b, before);
  if (err) return bad(res, err);

  const draft = { ...(before ?? {}) };
  for (const k of PREVIEW_FIELDS) if (b[k] !== undefined) draft[k] = b[k];
  const endpoint = await one('select id from endpoints where id = $1', [draft.endpoint_id]);
  if (!endpoint) return bad(res, 'לא נמצאה נקודת קצה כזו');

  const channelIds = Array.isArray(b.channel_ids) ? b.channel_ids
    : before ? (await rows('select channel_id from campaign_channels where campaign_id = $1',
                           [before.id])).map((x) => x.channel_id)
    : [];
  res.json(await loadCapacityPreview(draft, channelIds));
}));

/**
 * העתקת קמפיין: קמפיין חדש עם ההגדרות שב-b (כבר עברו newCampaignError), ואותו
 * תוכן — זוויות/משבצות, ניסוחים לכל מדיה (כולל המצב וה-meta של ניוזלטר:
 * נושא ורשימות) וקבצים. השיבוצים בלוח לא מועתקים: המנוע משבץ את החדש לפי
 * התאריכים שלו. קובץ ב-R2 מועתק לאובייקט חדש, כי מחיקה מאחד הקמפיינים
 * מוחקת את האובייקט. משבצות מקושרות נשארות מקושרות בעותק, זו לזו (לעוקבת
 * אין קבצים משלה — הם על המקור).
 *
 * complete: העותק מסומן "מוכן" (הרצה חדשה של קמפיין מחזורי שהמקור שלו
 * מוכן — אותו תוכן נפרס על החלון החדש). בשכפול רגיל לא: הקצאה לפי קצב על
 * התאריכים החדשים, עד שמסמנים אותו מוכן בעצמו.
 * templateId: העותק הוא הרצה של קמפיין מחזורי (campaigns.template_id).
 *
 * @returns {Promise<{error?:string, status?:number, campaign?:object, copied?:object}>}
 */
async function copyCampaign(src, b, { complete = false, templateId = null } = {}) {
  const assets = await rows(
    `select a.id, a.storage_key, a.filename from content_assets a
       join content_items ci on ci.id = a.content_id
      where ci.campaign_id = $1 and a.storage_key is not null`, [src.id]);
  if (assets.length && !mediaReady()) {
    return { error: 'אחסון המדיה לא מוגדר בשרת — אי אפשר להעתיק את הקבצים של הקמפיין', status: 503 };
  }
  // קודם הקבצים: אם העתקה נכשלת לא נוצר כלום במסד. מה שכבר הועתק נשאר
  // יתום, וסריקת היתומים מנקה אותו.
  const newKey = new Map();
  for (const a of assets) {
    const key = newMediaKey(currentOrg(), a.filename);
    await mediaStore.copy(a.storage_key, key);
    newKey.set(a.id, key);
  }

  let c = await insertCampaign(b);
  if (complete || templateId != null) {
    c = await one(
      `update campaigns set content_complete_at = case when $2 then now() end, template_id = $3
        where id = $1 returning *`, [c.id, complete, templateId]);
  }
  const counts = await tx(async (client) => {
    const items = await client.query(
      'select * from content_items where campaign_id = $1 order by sort_order, id', [src.id]);
    let variantsN = 0;
    let assetsN = 0;
    const copyOf = new Map();   // מזהה במקור → מזהה בעותק, לקישורים בין משבצות
    for (const it of items.rows) {
      const { rows: [copy] } = await client.query(
        `insert into content_items (endpoint_id, campaign_id, kind, title, body, ready_channel_ids,
                                    sort_order, evergreen, reuse_after_days, slot_channel_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [c.endpoint_id, c.id, it.kind, it.title, it.body, it.ready_channel_ids,
         it.sort_order, it.evergreen, it.reuse_after_days, it.slot_channel_id]);
      copyOf.set(it.id, copy.id);

      const vmap = new Map();
      const vs = await client.query(
        'select id, channel_id, body, status, meta from content_variants where content_id = $1',
        [it.id]);
      for (const v of vs.rows) {
        const { rows: [nv] } = await client.query(
          `insert into content_variants (content_id, channel_id, body, status, meta)
           values ($1,$2,$3,$4,$5::jsonb) returning id`,
          [copy.id, v.channel_id, v.body, v.status, v.meta == null ? null : JSON.stringify(v.meta)]);
        vmap.set(v.id, nv.id);
        variantsN++;
      }

      // קובץ ישן (bytea, בלי storage_key) מועתק בתוך Postgres — הבייטים לא
      // עוברים דרך השרת
      const as = await client.query(
        'select id, variant_id, storage_key from content_assets where content_id = $1 order by id',
        [it.id]);
      for (const a of as.rows) {
        await client.query(
          `insert into content_assets (content_id, variant_id, filename, mime, size_bytes, data, storage_key)
           select $1, $2, filename, mime, size_bytes,
                  case when $3::text is null then data end, $3
             from content_assets where id = $4`,
          [copy.id, a.variant_id ? vmap.get(a.variant_id) ?? null : null,
           newKey.get(a.id) ?? null, a.id]);
        assetsN++;
      }
    }
    // משבצות מקושרות נשארות מקושרות בעותק — זו לזו, לא לקמפיין המקורי.
    // אחרי שכל העותקים נוצרו, כי עוקבת יכולה לבוא לפני המקור שלה בסדר.
    let linksN = 0;
    for (const it of items.rows) {
      const to = it.linked_to_id != null ? copyOf.get(it.linked_to_id) : null;
      if (!to) continue;
      await client.query('update content_items set linked_to_id = $1 where id = $2',
        [to, copyOf.get(it.id)]);
      linksN++;
    }
    return { items: items.rows.length, variants: variantsN, assets: assetsN, links: linksN };
  });
  return { campaign: c, copied: counts };
}

/**
 * שכפול: הטופס נפתח עם ההגדרות של המקור, ומשנים בו מה שרוצים. העותק
 * מתחיל לא "מוכן" ולא מחזורי (ראו copyCampaign).
 */
r.post('/campaigns/:id/duplicate', requirePerm('settings'), wrap(async (req, res) => {
  const src = await one('select * from campaigns where id = $1', [req.params.id]);
  if (!src) return bad(res, 'לא נמצא קמפיין כזה', 404);

  // הנתח הקבוע ומספר הזוויות כבר לא בטופס — עוברים מהמקור, כמו ב"שבץ מחדש".
  // המרווח עובר מהמקור, אלא אם הטופס שלח אחר
  const b = { share_pct: src.share_pct, target_posts: src.target_posts,
              min_gap_days: src.min_gap_days,
              ...(req.body ?? {}), structure: src.structure };
  const err = newCampaignError(b);
  if (err) return bad(res, err);

  const out = await copyCampaign(src, b);
  if (out.error) return bad(res, out.error, out.status);
  const engine = await autoFill(b.week);
  res.status(201).json({ ...out, engine });
}));

/**
 * "שבץ מחדש" של קמפיין מחזורי: הרצה חדשה מתאריך יעד חדש. הכול כמו בתבנית —
 * נקודת קצה, מדיות, מבנה, חשיבות ונתח, מטרה, אורך התקופה והתוכן עם המצבים
 * שלו (מוכן נשאר מוכן) — חוץ מהשם (ברירת מחדל: "<שם> · <חודש שנה>") ומה
 * שנבחר בטופס. תבנית שסומנה "מוכן" נותנת הרצה מוכנה: אותו תוכן נפרס על
 * החלון החדש. התבנית וההרצות הקודמות לא משתנות.
 *
 * גוף: { starts_on, name?, period?, ends_on?, week? } — period/ends_on כמו
 * בטופס הקמפיין; בלעדיהם אורך התבנית (rerunPeriod).
 */
r.post('/campaigns/:id/replace', requirePerm('settings'), wrap(async (req, res) => {
  const src = await one('select * from campaigns where id = $1', [req.params.id]);
  if (!src) return bad(res, 'לא נמצא קמפיין כזה', 404);
  if (!src.recurring) return bad(res, 'הקמפיין לא מסומן כקמפיין מחזורי', 409);

  const body = req.body ?? {};
  if (!body.starts_on) return bad(res, 'צריך תאריך יעד לפוסט הראשון');
  const dateErr = datesError(body);
  if (dateErr) return bad(res, dateErr);
  // הרצה חדשה מתחילה מהיום והלאה — פוסטים בעבר לא ייצאו לעולם
  if (body.starts_on < ymd(new Date())) {
    return bad(res, 'תאריך היעד לפוסט הראשון כבר עבר — בוחרים תאריך מהיום והלאה');
  }
  let period;
  if (body.period != null) {
    period = { period: body.period, ...(body.ends_on !== undefined ? { ends_on: body.ends_on } : {}) };
  } else {
    period = rerunPeriod(src, body.starts_on);
    if (!period) return bad(res, 'לקמפיין המקורי אין תאריך סיום — צריך לבחור תקופה');
  }

  const channels = await rows(
    'select channel_id from campaign_channels where campaign_id = $1 order by channel_id', [src.id]);
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim() : runName(src.name, body.starts_on);
  const b = {
    endpoint_id: src.endpoint_id, name, goal: src.goal, starts_on: body.starts_on, ...period,
    share_pct: src.share_pct, importance: src.importance, target_posts: src.target_posts,
    urgent: src.urgent, structure: src.structure, min_gap_days: src.min_gap_days,
    channel_ids: channels.map((x) => x.channel_id),
  };
  const err = newCampaignError(b);
  if (err) return bad(res, err);

  const out = await copyCampaign(src, b,
    { complete: !!src.content_complete_at, templateId: src.id });
  if (out.error) return bad(res, out.error, out.status);
  const engine = await autoFill(body.week ?? body.starts_on);
  res.status(201).json({ ...out, engine });
}));

/* ---------- "קמפיין מוכן": הקמפיין בגודל התוכן שקיים ---------- */

/** הקמפיין עם המצב המלא שלו, או null */
async function campaignWithHealth(id) {
  return (await campaignsWithHealth()).find((c) => c.id === Number(id)) ?? null;
}

/** מה יקרה בלחיצה על "קמפיין מוכן" — לדיאלוג האישור. לא כותב כלום. */
r.get('/campaigns/:id/complete-preview', wrap(async (req, res) => {
  const c = await campaignWithHealth(req.params.id);
  if (!c) return bad(res, 'לא נמצא קמפיין כזה', 404);
  const summary = completionSummary(c);
  if (summary.error) return bad(res, summary.error);
  res.json({ summary });
}));

/**
 * המשבצות הריקות יורדות והקמפיין מצטמצם בדיוק לתוכן שקיים (גם טיוטות).
 * הסדר נדחס ל-1..n — בכללי לכל מדיה בנפרד, בזוויות לכל הזוויות — בלי
 * לשנות את הסדר היחסי, והמנוע פורס את הפוסטים על אותה תקופה.
 */
r.post('/campaigns/:id/complete', requirePerm('settings'), wrap(async (req, res) => {
  // אותה נעילה כמו בהעלאה המרוכזת (routes/content.js), עד סוף הבקשה: הדחיסה
  // לא רצה באמצע העלאה שחישבה משבצות פנויות לפי הסדר הישן
  await one('select id from campaigns where id = $1 for update', [req.params.id]);
  const before = await campaignWithHealth(req.params.id);
  if (!before) return bad(res, 'לא נמצא קמפיין כזה', 404);
  const summary = completionSummary(before);
  if (summary.error) return bad(res, summary.error);

  const campaign = await tx(async (client) => {
    // דרך ערכים שליליים: האינדקס הייחודי על משבצות של כללי נבדק בכל שורה,
    // ודחיסה ישירה (5→3 לפני ש-3→2) הייתה נתקלת בו באמצע
    await client.query(
      `with r as (
         select id, row_number() over (partition by slot_channel_id
                                       order by sort_order, id) as n
           from content_items where campaign_id = $1)
       update content_items ci set sort_order = -r.n from r where ci.id = r.id`,
      [before.id]);
    await client.query(
      `update content_items set sort_order = -sort_order
        where campaign_id = $1 and sort_order < 0`, [before.id]);
    const { rows: [c] } = await client.query(
      `update campaigns set content_complete_at = coalesce(content_complete_at, now())
        where id = $1 returning *`, [before.id]);
    return c;
  });

  const engine = await autoFill(req.body?.week);
  res.json({ campaign, summary, engine });
}));

/** חזרה להקצאה לפי קצב: המשבצות הריקות חוזרות. שום דבר אחר לא משתנה. */
r.post('/campaigns/:id/reopen', requirePerm('settings'), wrap(async (req, res) => {
  const campaign = await one(
    'update campaigns set content_complete_at = null where id = $1 returning *',
    [req.params.id]);
  if (!campaign) return bad(res, 'לא נמצא קמפיין כזה', 404);
  const engine = await autoFill(req.body?.week);
  res.json({ campaign, engine });
}));

/**
 * המרת קמפיין לפי זוויות לכללי. כל ניסוח של זווית (גרסה לערוץ) הופך לפוסט
 * משלו במשבצת של הערוץ שלו, באותו מספר כמו הזווית (או הפנוי הבא, כשיש שתי
 * זוויות באותו מקום). עובר איתו: הטקסט והמצב (הגרסה עצמה, כולל meta של
 * ניוזלטר), הקבצים של הגרסה, הפוסטים שכבר שובצו/פורסמו בערוץ הזה וההחלטות
 * "לא לשבץ" של המנוע. קבצים משותפים לזווית נשארים בפוסט הראשון ומועתקים
 * לשאר. הפוסטים לא מקושרים זה לזה — כל ערוץ שומר את הניסוח שלו.
 * הפריט המקורי של הזווית נשאר כפוסט של הערוץ הראשון שלה (אותו מזהה).
 */
r.post('/campaigns/:id/to-general', requirePerm('settings'), wrap(async (req, res) => {
  const c = await one('select * from campaigns where id = $1 for update', [req.params.id]);
  if (!c) return bad(res, 'לא נמצא קמפיין כזה', 404);
  if (c.structure === 'general') return bad(res, 'הקמפיין כבר כללי');
  if (!c.starts_on || !c.ends_on) {
    return bad(res, 'לקמפיין אין תאריך סיום — קובעים תקופה ב"ערוך קמפיין", ואז ממירים');
  }

  const channels = await rows(
    `select ch.id, ch.platform from campaign_channels cc join channels ch on ch.id = cc.channel_id
      where cc.campaign_id = $1 order by ch.sort_order, ch.id`, [c.id]);
  // בלי ערוצים אין עמודות — זווית בלי ניסוח לא הייתה מקבלת משבצת ונעלמת
  if (!channels.length) return bad(res, 'לקמפיין אין ערוצים — בוחרים ערוצים, ואז ממירים');
  const chOrder = new Map(channels.map((ch, i) => [ch.id, i]));
  const items = await rows(
    'select * from content_items where campaign_id = $1 order by sort_order, id', [c.id]);
  const variants = await rows(
    `select v.id, v.content_id, v.channel_id, v.body, v.status from content_variants v
       join content_items ci on ci.id = v.content_id
      where ci.campaign_id = $1`, [c.id]);
  // "לא רלוונטי לערוץ הזה" — הוחלט שהזווית לא יוצאת בו, ולכן אין לו פוסט
  const dropped = variants.filter((v) => v.status === 'not_relevant');
  const shared = await rows(
    `select a.id, a.content_id, a.storage_key, a.filename from content_assets a
       join content_items ci on ci.id = a.content_id
      where ci.campaign_id = $1 and a.variant_id is null`, [c.id]);

  // התוכנית: לכל זווית — משבצת לכל גרסה, לפי סדר הערוצים בקמפיין
  const used = new Map();   // ערוץ → מספרי משבצות תפוסים
  const take = (channelId, want) => {
    const set = used.get(channelId) ?? new Set();
    used.set(channelId, set);
    let n = Math.max(1, want);
    while (set.has(n)) n += 1;
    set.add(n);
    return n;
  };
  const fallback = channels.find((ch) => ch.platform !== 'newsletter') ?? channels[0];
  const plan = items.map((it) => {
    const vs = variants.filter((v) => v.content_id === it.id && v.status !== 'not_relevant')
      .sort((a, b) => (chOrder.get(a.channel_id) ?? 999) - (chOrder.get(b.channel_id) ?? 999)
        || a.channel_id - b.channel_id);
    // זווית בלי אף ניסוח — פוסט אחד (טיוטה) בערוץ הראשון, עם הטקסט של הזווית
    const targets = vs.length ? vs : [{ id: null, channel_id: fallback.id, body: it.body }];
    return { it, targets: targets.map((v) => ({ v, slot: take(v.channel_id, it.sort_order) })) };
  });

  // קבצים משותפים ב-R2 שצריך להעתיק (לכל פוסט נוסף של הזווית) — לפני כל
  // כתיבה במסד, כמו בשכפול: העתקה שנכשלת לא משאירה המרה חצויה
  const copies = plan.flatMap(({ it, targets }) => targets.slice(1).flatMap(() =>
    shared.filter((a) => a.content_id === it.id && a.storage_key)));
  if (copies.length && !mediaReady()) {
    return bad(res, 'אחסון המדיה לא מוגדר בשרת — אי אפשר להעתיק את הקבצים המשותפים', 503);
  }
  const newKeys = [];
  for (const a of copies) {
    const key = newMediaKey(currentOrg(), a.filename);
    await mediaStore.copy(a.storage_key, key);
    newKeys.push(key);
  }

  const counts = await tx(async (client) => {
    let posts = 0;
    let keyAt = 0;
    if (dropped.length) {
      // קבצים של ניסוח "לא רלוונטי" נמחקים איתו (cascade) — הקבצים ב-R2 עוברים
      // לסל המחזור, כמו בכל מחיקה, ולא נשארים יתומים
      await client.query(
        `insert into media_trash (bucket, storage_key, delete_after)
         select $2, storage_key, now() + make_interval(days => $3)
           from content_assets where variant_id = any($1::int[]) and storage_key is not null
         on conflict (bucket, storage_key) do nothing`,
        [dropped.map((v) => v.id), process.env.R2_PUBLIC_BUCKET ?? '', TRASH_DAYS]);
      await client.query('delete from content_variants where id = any($1::int[])',
        [dropped.map((v) => v.id)]);
    }
    for (const { it, targets } of plan) {
      for (const [i, { v, slot }] of targets.entries()) {
        let id = it.id;
        if (i === 0) {
          // ניסוח ריק (גרסה שנוצרה רק בשביל קובץ) — נשאר הטקסט של הזווית
          await client.query(
            `update content_items set slot_channel_id = $2, sort_order = $3,
                    body = coalesce(nullif($4, ''), body)
              where id = $1`, [it.id, v.channel_id, slot, v.body]);
        } else {
          ({ rows: [{ id }] } = await client.query(
            `insert into content_items (endpoint_id, campaign_id, kind, title, body, ready_channel_ids,
                                        sort_order, evergreen, reuse_after_days, slot_channel_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
            [it.endpoint_id, c.id, it.kind, it.title, v.body || it.body, it.ready_channel_ids,
             slot, it.evergreen, it.reuse_after_days, v.channel_id]));
          await client.query('update content_variants set content_id = $1 where id = $2', [id, v.id]);
          await client.query('update content_assets set content_id = $1 where variant_id = $2', [id, v.id]);
          for (const a of shared.filter((x) => x.content_id === it.id)) {
            await client.query(
              `insert into content_assets (content_id, filename, mime, size_bytes, data, storage_key)
               select $1, filename, mime, size_bytes, case when $2::text is null then data end, $2
                 from content_assets where id = $3`,
              [id, a.storage_key ? newKeys[keyAt++] : null, a.id]);
          }
          const moved = await client.query(
            'update posts set content_id = $1 where content_id = $2 and channel_id = $3',
            [id, it.id, v.channel_id]);
          posts += moved.rowCount;
          await client.query(
            `update engine_dismissals set content_id = $1 where content_id = $2 and channel_id = $3`,
            [id, it.id, v.channel_id]);
        }
        // זווית בלי ניסוח: הגרסה של המשבצת נוצרת כטיוטה
        if (!v.id) {
          await client.query(
            `insert into content_variants (content_id, channel_id, body, status)
             values ($1,$2,$3,'draft') on conflict (content_id, channel_id) do nothing`,
            [id, v.channel_id, it.body]);
        }
      }
    }
    // פוסט שעוד לא פורסם ונשאר על הזווית בערוץ שאין לו ניסוח (לא רלוונטי, או
    // שובץ ידנית) — היה יוצא עם הניסוח של ערוץ אחר. מנותק מהתוכן: נשאר בלוח
    // עם הכותרת שלו, כמו פוסט בלי תוכן. פוסט שפורסם נשאר — זו היסטוריה.
    let detached = 0;
    for (const { it, targets } of plan) {
      const r = await client.query(
        `update posts set content_id = null
          where content_id = $1 and channel_id <> $2 and status <> 'published'`,
        [it.id, targets[0].v.channel_id]);
      detached += r.rowCount;
    }
    await client.query(
      `update campaigns set structure = 'general', target_posts = null where id = $1`, [c.id]);
    return { angles: items.length, posts: plan.reduce((s, p) => s + p.targets.length, 0),
             moved_posts: posts, detached_posts: detached };
  });
  const engine = await autoFill(req.body?.week);
  res.json({ converted: counts, engine });
}));

r.patch('/campaigns/:id', requirePerm('settings'), wrap(async (req, res) => {
  const b = { ...(req.body ?? {}) };

  const before = await one('select * from campaigns where id = $1', [req.params.id]);
  if (!before) return bad(res, 'לא נמצא קמפיין כזה', 404);

  const periodErr = applyPeriod(b, before);
  if (periodErr) return bad(res, periodErr);
  const gapErr = gapDaysError(b);
  if (gapErr) return bad(res, gapErr);

  // קמפיין מחזורי (תבנית ל"שבץ מחדש" בלוח האסטרטגיה) — דגל בלבד, בלי
  // השפעה על המנוע. עותקים נוצרים לא מחזוריים (insertCampaign).
  if (b.recurring !== undefined && typeof b.recurring !== 'boolean') {
    return bad(res, 'ערך לא תקין לקמפיין מחזורי');
  }
  // רק הדגל השתנה — אין מה לשבץ, והמילוי האוטומטי לא רץ
  if (Object.keys(req.body ?? {}).filter((k) => k !== 'week').join() === 'recurring') {
    const campaign = await one('update campaigns set recurring = $2 where id = $1 returning *',
      [before.id, b.recurring]);
    return res.json({ campaign, moved_posts: 0, engine: EMPTY_FILL });
  }

  if (b.structure == null) delete b.structure; // עמודה not null — "לא נשלח" = לא נוגעים
  if (b.structure != null && b.structure !== before.structure) {
    const n = await one('select count(*)::int as n from content_items where campaign_id = $1',
      [before.id]);
    const err = structureChangeError(before.structure, b.structure, n.n);
    if (err) return bad(res, err, 409);
  }

  // הסרת מדיה מקמפיין כללי שיש לה פוסטים במשבצות: הפוסטים נשמרים (החזרת
  // המדיה מחזירה אותם), אבל המנוע לא משבץ אותם כל עוד המדיה לא בקמפיין.
  // אזהרה שאפשר לאשר — כמו המרווח בלוח (confirm_gap).
  if (Array.isArray(b.channel_ids) && before.structure === 'general' && !b.confirm_gap) {
    const keep = b.channel_ids.map(Number);
    const orphans = await rows(
      `select ch.name, count(*)::int as n
         from content_items ci join channels ch on ch.id = ci.slot_channel_id
        where ci.campaign_id = $1 and not (ci.slot_channel_id = any($2::int[]))
          -- רק מדיות שיורדות עכשיו; מה שכבר הוסר קודם לא חוזר באזהרה
          and ci.slot_channel_id in (select channel_id from campaign_channels where campaign_id = $1)
        group by ch.name order by ch.name`,
      [before.id, keep]);
    if (orphans.length) {
      const total = orphans.reduce((sum, o) => sum + o.n, 0);
      const message =
        `לערוצים שיורדים מהקמפיין יש ${total === 1 ? 'פוסט אחד' : `${total} פוסטים`}: ` +
        `${orphans.map((o) => `${o.name} (${o.n})`).join(', ')}. ` +
        'אחרי ההסרה הפוסטים נשמרים אבל לא ישובצו יותר; מה שכבר בלוח נשאר. ' +
        'החזרת הערוץ לקמפיין מחזירה אותם.';
      return res.status(409).json({
        error: message, needs_confirm: true, warning: { message, orphans },
      });
    }
  }

  const c = await updateById('campaigns', CAMPAIGN_FIELDS, req.params.id, b);
  if (Array.isArray(b.channel_ids)) {
    await tx((client) => setCampaignChannels(client, c.id, b.channel_ids));
  }

  // הזזת קמפיין בזמן גוררת איתה את השיבוצים שלו. בלי זה הקמפיין זז
  // והפוסטים נשארים מאחור, מנותקים מהחלון שהם אמורים לשרת.
  let movedPosts = 0;
  if (b.starts_on && before.starts_on && b.starts_on !== before.starts_on) {
    const days = daysBetweenDates(before.starts_on, b.starts_on);
    if (days !== 0) {
      // רק מה שעוד לא יצא ועוד לא עבר. היסטוריה לא מזיזים.
      const moved = await rows(
        `update posts p
            set scheduled_at = p.scheduled_at + ($1 || ' days')::interval
           from content_items ci
          where ci.id = p.content_id
            and ci.campaign_id = $2
            and p.status in ('scheduled','approved','failed','pending_approval','hole')
            and p.scheduled_at >= now()
          returning p.id`,
        [days, c.id]
      );
      movedPosts = moved.length;
    }
  }

  const engine = await autoFill(b.week);
  res.json({ campaign: c, moved_posts: movedPosts, engine });
}));

/** מספר ימים בין שני תאריכים, בלי להיתקל במעבר שעון */
function daysBetweenDates(a, b) {
  const p = (s) => String(s).slice(0, 10).split('-').map(Number);
  const [ay, am, ad] = p(a);
  const [by, bm, bd] = p(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export default r;
