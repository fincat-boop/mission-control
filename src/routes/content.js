import { Router } from 'express';
import { requirePerm } from '../auth.js';
import { autoFill, bad, parseIdList, titleFromFilename, updateById, upload, wrap } from './_shared.js';
import { currentOrg, one, query, rows, tx } from '../db.js';
import {
  MAX_MEDIA_BYTES, TRASH_DAYS, assetView, headMime, isOwnKey, mediaReady, mediaStore, mediaUrl,
  newMediaKey, uploadSignedHeaders, validateSignRequest, verifyUploaded,
} from '../media.js';
import { channelNeeds, freeAngleSlots, nextSlots } from '../campaigns.js';
import { analyzeImport, runImport } from '../import.js';
import { assistantReady } from '../assistant.js';
import { extract } from '../extract.js';
import { analyzeDocument } from '../analyze.js';
import {
  LinkError, assetOwnerId, itemAssetsSql, linkGroup, linkSlots, lockLinkScope, mediaOwner,
  releaseLinks, syncFrom, unlink,
} from '../links.js';
import { contentBlocker, readyRejection } from '../publish/readiness.js';
import { STALE_VARIANT, staleVariant } from '../variant-lock.js';

const r = Router();

/**
 * פריט של משבצת בקמפיין כללי שייך למדיה אחת בלבד. גרסה או קובץ למדיה אחרת
 * היו הופכים אותו למועמד בעוד ערוץ (המנוע בוחר לפי הגרסאות) — ולכן נחסם.
 * @returns {Promise<string|null>} הודעת שגיאה, או null כשמותר
 */
async function slotChannelError(contentId, channelId) {
  const item = await one('select slot_channel_id from content_items where id = $1', [contentId]);
  if (!item?.slot_channel_id || Number(channelId) === item.slot_channel_id) return null;
  return 'הפוסט הזה שייך למדיה אחת בקמפיין כללי — אין לו גרסה למדיה אחרת';
}

/** שגיאת קישור (LinkError) חוזרת למשתמש כמו שהיא; כל השאר — שגיאת שרת */
function linkFail(res, e) {
  if (e instanceof LinkError) return res.status(e.status).json({ error: e.message, ...e.extra });
  throw e;
}

/**
 * האם גרסה עם התוכן הזה יכולה להיות "מוכן" בערוץ הזה — אותם כללי תוכן כמו
 * בפרסום (readiness.js). הקבצים: מה שהפריט יצא איתו בערוץ (משבצת מקושרת —
 * של המקור). רץ לפני הכתיבה: הבקשה נשמרת (commit) גם כשהתשובה 400.
 * @returns {Promise<string|null>} ההודעה למשתמש, או null כשמותר
 */
async function readyError(contentId, channelId, variant, { assets } = {}) {
  const ch = await one('select platform from channels where id = $1', [channelId]);
  if (!ch) return null;
  const files = assets ?? (contentId ? await rows(itemAssetsSql('a.mime'), [contentId, channelId]) : []);
  const reason = contentBlocker({ platform: ch.platform, variant, assets: files });
  return reason ? readyRejection(reason) : null;
}

/* ---------- נעילה אופטימית של גרסה (src/variant-lock.js) ---------- */

/** 409 עם הגרסה השמורה — הטופס מציג אותה ומשאיר את הטקסט של המשתמש להעתקה */
const staleReply = (res, current) =>
  res.status(409).json({ error: STALE_VARIANT, stale: true, current: current ?? null });

/** מקום במשבצת: מספר שלם 1–1000 */
const validSlot = (n) => Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= 1000;

/**
 * מריץ fn בתוך savepoint. הבקשה כולה רצה בטרנזקציה אחת (withOrg), וכשל
 * ייחודיות היה מפיל אותה בשקט — כאן חוזרים לנקודה שלפני ומחזירים null.
 */
/** התנגשות על משבצת שנשארה למרות הנעילה (למשל מילוי ידני באותו רגע) */
const SLOT_RACE = 'המשבצת תפוסה, נסה שוב';

async function uniqueOrNull(fn) {
  await query('savepoint slot_unique');
  try {
    const out = await fn();
    await query('release savepoint slot_unique');
    return out;
  } catch (e) {
    await query('rollback to savepoint slot_unique');
    if (e.code === '23505') return null;
    throw e;
  }
}

/* ========================= גרסאות לפי מדיה ========================= */

/** יצירה או עדכון של הגרסה של זווית מסוימת במדיה מסוימת */
r.put('/content/:id/variants/:channelId', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  // משבצת מקושרת: סדר הנעילה של הקבוצה (קמפיין ← פריטים) לפני כל כתיבה
  try { await lockLinkScope(req.params.id); } catch (e) { return linkFail(res, e); }
  const slotErr = await slotChannelError(req.params.id, req.params.channelId);
  if (slotErr) return bad(res, slotErr);
  const status = ['draft', 'ready', 'not_relevant'].includes(b.status) ? b.status : 'draft';

  const before = await one(
    `select id, body, status, meta, updated_at from content_variants
      where content_id = $1 and channel_id = $2 for update`,
    [req.params.id, req.params.channelId]);
  // נעילה אופטימית — רק כשהטופס שלח מול מה הוא נפתח (העוזר וקריאות ישנות לא)
  if ('base_updated_at' in b && staleVariant(before, b.base_updated_at)) {
    return staleReply(res, before);
  }
  // "מוכן" נבדק מול התוכן שיישמר בפועל (מה שלא נשלח — נשאר מהקיים)
  if (status === 'ready') {
    const err = await readyError(req.params.id, req.params.channelId, {
      body: b.body ?? before?.body ?? '', meta: b.meta ?? before?.meta ?? null,
    });
    if (err) return bad(res, err);
  }

  // meta — נושא ורשימות יעד של ערוץ המייל. לא נשלח = לא נוגעים בקיים.
  const meta = b.meta != null ? JSON.stringify(b.meta) : null;
  const v = await one(
    `insert into content_variants (content_id, channel_id, body, status, meta)
     values ($1,$2,coalesce($3,''),$4,$5::jsonb)
     on conflict (content_id, channel_id)
       do update set body = coalesce($3, content_variants.body), status = $4,
                     meta = coalesce($5::jsonb, content_variants.meta)
     returning *`,
    [req.params.id, req.params.channelId, b.body ?? null, status, meta]
  );
  // משבצת מקושרת: אותו טקסט ומצב לכל המשבצות בקבוצה
  await syncFrom(req.params.id);
  const engine = await autoFill(b.week);
  res.json({ variant: v, engine });
}));

r.delete('/content/:id/variants/:channelId', requirePerm('content'), wrap(async (req, res) => {
  try { await lockLinkScope(req.params.id); } catch (e) { return linkFail(res, e); }
  await query('delete from content_variants where content_id = $1 and channel_id = $2',
    [req.params.id, req.params.channelId]);
  // משבצת מקושרת: הגרסה המשותפת יורדת מכל המשבצות בקבוצה, כל אחת במדיה שלה
  const group = await linkGroup(req.params.id);
  const self = group.find((x) => x.id === Number(req.params.id));
  if (group.length > 1 && self?.slot_channel_id === Number(req.params.channelId)) {
    await query(
      `delete from content_variants v using content_items ci
        where ci.id = v.content_id and v.channel_id = ci.slot_channel_id
          and ci.id = any($1::int[])`,
      [group.map((x) => x.id)]);
  }
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, engine });
}));

/**
 * השהיה והפעלה מחדש.
 * השהיה לא מוחקת כלום: הפוסטים נשארים במסד ופשוט מסוננים מהלוח וממנוע
 * השיבוץ. בהחזרה לפעילות מנקים את מה שעוד לא אושר (ראו resume).
 */

// פוסטים עתידיים של הקמפיין שעוד לא יצאו — מה שיורד מהלוח בהשהיה
const FUTURE_OPEN = `
  from posts p join content_items ci on ci.id = p.content_id
 where ci.campaign_id = $1 and p.scheduled_at >= now()
   and p.status in ('scheduled','approved','failed','pending_approval','hole')`;

/** מה השהיה / החזרה לפעילות יעשו לפוסטים — לחלון האישור לפני הפעולה */
async function pauseImpact(campaignId) {
  return one(
    `select count(*)::int as open,
            count(*) filter (where p.status = 'approved')::int as approved
       ${FUTURE_OPEN}`,
    [campaignId]
  );
}

r.get('/campaigns/:id/pause-impact', wrap(async (req, res) => {
  const c = await one('select id, name, paused_at from campaigns where id = $1', [req.params.id]);
  if (!c) return bad(res, 'לא נמצא קמפיין כזה', 404);
  const n = await pauseImpact(c.id);
  res.json({
    paused: !!c.paused_at,
    // השהיה: כל הפתוחים יורדים מהלוח (approved ביניהם)
    pause: { hidden: n.open, approved: n.approved },
    // החזרה: מה שלא אושר נמחק ומשובץ מחדש; מה שאושר לפרסום אוטומטי נשאר
    resume: { cleared: n.open - n.approved, kept_approved: n.approved },
  });
}));

r.post('/campaigns/:id/pause', requirePerm('settings'), wrap(async (req, res) => {
  const c = await one(
    'update campaigns set paused_at = now() where id = $1 returning *', [req.params.id]);
  if (!c) return bad(res, 'לא נמצא קמפיין כזה', 404);

  const held = await pauseImpact(c.id);
  const engine = await autoFill(req.body?.week);
  res.json({ campaign: c, held: held.open, engine });
}));

r.post('/campaigns/:id/resume', requirePerm('settings'), wrap(async (req, res) => {
  const c = await one(
    'update campaigns set paused_at = null where id = $1 returning *', [req.params.id]);
  if (!c) return bad(res, 'לא נמצא קמפיין כזה', 404);

  // המשבצות הישנות קפאו בזמן ההשהיה — בינתיים המנוע כבר יכול היה למלא
  // את אותו יום/ערוץ עם משהו אחר. במקום להחזיר אוטומטית לאותו מקום
  // (וליצור התנגשות), מנקים את מה שעוד לא יצא לאוויר והמנוע ממקם מחדש.
  // פוסט שאושר לפרסום אוטומטי נשאר: מישהו בדק ואישר אותו במועד הזה,
  // ומחיקה שקטה שלו הייתה מבטלת החלטה של אדם.
  const cleared = await rows(
    `delete from posts p using content_items ci
      where ci.id = p.content_id and ci.campaign_id = $1
        and p.status in ('scheduled','failed','pending_approval','hole')
        and p.scheduled_at >= now()
      returning p.id`,
    [c.id]
  );
  // מאושר שבזמן ההשהיה המנוע מילא את אותה נקודה+ערוץ+יום — היו יוצאים שניים,
  // בניגוד לכלל של הלוח. האישור ניתן לפני שהיום התמלא, אז הוא מתפנה כמו השאר.
  const clashed = await rows(
    `delete from posts p using content_items ci
      where ci.id = p.content_id and ci.campaign_id = $1
        and p.status = 'approved' and p.scheduled_at >= now()
        and exists (select 1 from posts o
                     where o.id <> p.id and o.endpoint_id = p.endpoint_id
                       and o.channel_id = p.channel_id
                       and (o.scheduled_at at time zone 'Asia/Jerusalem')::date
                         = (p.scheduled_at at time zone 'Asia/Jerusalem')::date
                       and (o.content_id is null or o.content_id not in
                            (select id from content_items where campaign_id = $1)))
      returning p.id`,
    [c.id]
  );

  const engine = await autoFill(req.body?.week);
  res.json({ campaign: c, cleared: cleared.length + clashed.length, engine });
}));

/** סידור מחדש של התוכן בתוך קמפיין */
r.patch('/campaigns/:id/order', requirePerm('content'), wrap(async (req, res) => {
  const ids = req.body?.content_ids;
  if (!Array.isArray(ids)) return bad(res, 'צריך רשימת מזהי תוכן');
  const c = await one('select structure from campaigns where id = $1', [req.params.id]);
  if (c?.structure === 'general') {
    return bad(res, 'בקמפיין כללי אין סדר זוויות — כל פוסט יושב במשבצת של המדיה שלו');
  }
  await tx(async (client) => {
    for (const [i, contentId] of ids.entries()) {
      await client.query(
        'update content_items set sort_order = $1 where id = $2 and campaign_id = $3',
        [i + 1, contentId, req.params.id]
      );
    }
  });
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, engine });
}));

r.delete('/campaigns/:id', requirePerm('settings'), wrap(async (req, res) => {
  // נעילת הקמפיין לפני הקבוצות (אותו סדר כמו בכל שינוי של משבצות מקושרות)
  await query('select id from campaigns where id = $1 for update', [req.params.id]);
  // משבצות מקושרות מתפרקות קודם: בתוכן שוטף אין משבצות לקשר ביניהן, וכל
  // אחת נשארת עם עותק משלה של התוכן (קבצים מועתקים מהמקור)
  const sources = await rows(
    `select distinct linked_to_id as id from content_items
      where campaign_id = $1 and linked_to_id is not null`, [req.params.id]);
  try {
    for (const s of sources) await releaseLinks(s.id);
  } catch (e) { return linkFail(res, e); }
  // התוכן נשאר ומתנתק (on delete set null). משבצת-מדיה בלי קמפיין היא
  // סתם תוכן שוטף, ולכן גם השיוך למשבצת יורד.
  await query('update content_items set slot_channel_id = null where campaign_id = $1',
    [req.params.id]);
  await query('delete from campaigns where id = $1', [req.params.id]);
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, engine });
}));

/* ========================= תוכן ========================= */

/** ספריית התוכן, עם הגרסאות לכל מדיה ולאן כל פריט כבר שובץ */
r.get('/content', wrap(async (_req, res) => {
  const [items, variants, assets] = await Promise.all([
    rows(
      `select ci.*, e.name as endpoint_name, c.name as campaign_name,
              coalesce(p.placements, 0) as placements
         from content_items ci
         join endpoints e on e.id = ci.endpoint_id
         left join campaigns c on c.id = ci.campaign_id
         left join (select content_id, count(*)::int as placements
                      from posts where content_id is not null group by content_id) p
                on p.content_id = ci.id
        order by ci.campaign_id nulls last, ci.sort_order, ci.id`
    ),
    rows('select * from content_variants order by content_id, channel_id'),
    rows(`select id, content_id, variant_id, filename, mime, size_bytes, storage_key
            from content_assets order by id`),
  ]);

  res.json({
    content: items.map((x) => ({
      ...x,
      variants: variants.filter((v) => v.content_id === x.id),
      // משבצת מקושרת מציגה את הקבצים של המקור (הם יושבים רק שם)
      assets: assets.filter((a) => a.content_id === assetOwnerId(x)).map(assetView),
    })),
  });
}));

const CONTENT_FIELDS = ['endpoint_id', 'campaign_id', 'kind', 'title', 'body',
                        'ready_channel_ids', 'sort_order', 'evergreen', 'reuse_after_days'];

r.post('/content', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!b.title) return bad(res, 'צריך כותרת');
  if (!['promo', 'value', 'hybrid'].includes(b.kind)) {
    return bad(res, 'סוג התוכן חייב להיות promo / value / hybrid');
  }

  // נקודת הקצה מוגדרת על הקמפיין, לא על הזווית הבודדת
  const endpointId = await resolveEndpoint(b);
  if (!endpointId) {
    return bad(res, 'תוכן שלא משויך לקמפיין צריך נקודת קצה');
  }
  b.endpoint_id = endpointId;

  // קמפיין כללי: הפריט ממלא משבצת של מדיה אחת, ולא נפרש על כל המדיות
  const campaign = b.campaign_id
    ? await one('select id, structure from campaigns where id = $1', [b.campaign_id]) : null;
  const slotChannel = campaign?.structure === 'general' ? Number(b.slot_channel_id) : null;
  if (campaign?.structure === 'general') {
    const onCampaign = slotChannel && await one(
      'select 1 from campaign_channels where campaign_id = $1 and channel_id = $2',
      [campaign.id, slotChannel]);
    if (!onCampaign) return bad(res, 'בקמפיין כללי צריך לבחור מדיה מהמדיות של הקמפיין');
  }

  // משבצת מפורשת מנצחת (מילוי משבצת מהציר). בלעדיה — סוף התור.
  // בזוויות המשבצת היא שורה ברשת; בכללי — מקום ברשימה של מדיה אחת.
  let nextOrder = 0;
  if (slotChannel && b.sort_order != null && !validSlot(b.sort_order)) {
    return bad(res, 'מספר המשבצת חייב להיות מספר שלם בין 1 ל-1000');
  }
  if (b.campaign_id) {
    if (b.sort_order != null) {
      const taken = await one(
        `select 1 from content_items
          where campaign_id = $1 and sort_order = $2
            and slot_channel_id is not distinct from $3`,
        [b.campaign_id, b.sort_order, slotChannel]
      );
      if (taken) return bad(res, 'המשבצת הזו כבר תפוסה');
      nextOrder = Number(b.sort_order);
    } else if (slotChannel) {
      nextOrder = (await one(
        `select coalesce(max(sort_order),0) + 1 as n from content_items
          where campaign_id = $1 and slot_channel_id = $2`,
        [b.campaign_id, slotChannel]
      ))?.n ?? 1;
    } else {
      // זווית בלי מקום מפורש — המקום הפנוי הראשון ברשת, לא אחרי האחרון.
      // נעילת הקמפיין כמו בהעלאה המרוכזת: שתי יצירות במקביל לא יקבלו אותו מקום
      await one('select id from campaigns where id = $1 for update', [b.campaign_id]);
      nextOrder = (await freeAngleSlots(b.campaign_id, 1)).slots[0] ?? 1;
    }
  }

  // משבצת חדשה שנשלחת כ"מוכן" — אותם כללי תוכן כמו בעריכת גרסה. אין לה
  // עדיין קבצים (הם עולים אחרי היצירה), ולכן הטופס שולח קודם טיוטה כשיש קבצים.
  if (slotChannel && b.status === 'ready') {
    const err = await readyError(null, slotChannel, { body: b.body ?? '' }, { assets: [] });
    if (err) return bad(res, err);
  }

  // ready_channel_ids חייב המרת טיפוס מפורשת: בלעדיה Postgres מפרש
  // את ברירת המחדל '{}' כטקסט ונופל על אי-התאמה ל-integer[]
  // שני משתמשים שממלאים את אותה משבצת באותו רגע: האינדקס הייחודי תופס,
  // והשני מקבל 409 במקום שגיאת שרת
  const c = await uniqueOrNull(() => one(
    `insert into content_items (endpoint_id, campaign_id, kind, title, body,
                                ready_channel_ids, sort_order, evergreen, reuse_after_days,
                                slot_channel_id)
     values ($1,$2,$3,$4,coalesce($5,''),coalesce($6::int[],'{}'::int[]),$7,
             coalesce($8,false),$9,$10) returning *`,
    [b.endpoint_id, b.campaign_id ?? null, b.kind, b.title, b.body ?? null,
     slotChannel ? [slotChannel] : (b.ready_channel_ids ?? null), nextOrder,
     b.evergreen ?? null, b.reuse_after_days ?? null, slotChannel]
  ));
  if (!c) return bad(res, 'המשבצת תפוסה', 409);

  if (slotChannel) {
    // הגרסה היחידה של הפריט — לאותה מדיה. הטקסט שלה הוא הטקסט של הפריט.
    const variant = await one(
      `insert into content_variants (content_id, channel_id, body, status)
       values ($1,$2,coalesce($3,''),$4) returning *`,
      [c.id, slotChannel, b.body ?? null, b.status === 'ready' ? 'ready' : 'draft']
    );
    const engine = await autoFill(b.week);
    // variant — לנעילה האופטימית של השמירה הבאה מאותו טופס (updated_at)
    return res.status(201).json({ content: c, variant, engine });
  }

  // זווית חדשה נפתחת עם גרסת טיוטה לכל מדיה שביקשו — הניסוח נכתב לכל אחת בנפרד
  // טקסט שנשלח עם הזווית נכנס לכל גרסה, אבל "מוכן" רק בערוץ שהטקסט לבדו
  // מספיק לו (אינסטגרם בלי מדיה, ניוזלטר בלי נושא — נשארים טיוטה)
  const channelIds = parseIdList(b.channel_ids ?? b.ready_channel_ids);
  if (channelIds.length) {
    const platforms = new Map((await rows(
      'select id, platform from channels where id = any($1::int[])', [channelIds]))
      .map((ch) => [ch.id, ch.platform]));
    await tx(async (client) => {
      for (const channelId of channelIds) {
        const ready = !!b.body && !contentBlocker({
          platform: platforms.get(channelId), variant: { body: b.body }, assets: [] });
        await client.query(
          `insert into content_variants (content_id, channel_id, body, status)
           values ($1,$2,coalesce($3,''),$4) on conflict do nothing`,
          [c.id, channelId, b.body ?? null, ready ? 'ready' : 'draft']
        );
      }
    });
  }
  const engine = await autoFill(b.week);
  res.status(201).json({ content: c, engine });
}));

r.patch('/content/:id', requirePerm('content'), wrap(async (req, res) => {
  const b = { ...req.body };
  // משבצת מקושרת: נעילת הקמפיין ואז הקבוצה — לפני ש-updateById נועל את
  // הפריט עצמו. עריכה של המקור ושל העוקבת במקביל רצות בתור, לא בדדלוק.
  try { await lockLinkScope(req.params.id); } catch (e) { return linkFail(res, e); }
  const current = await one('select id, campaign_id, slot_channel_id from content_items where id = $1',
    [req.params.id]);
  if (!current) return bad(res, 'לא נמצא תוכן כזה', 404);

  // פוסט של משבצת יוצא מהקמפיין רק לתוכן שוטף: המשבצת שלו יורדת איתו
  // (גרסה אחת למדיה אחת נשארת). לקמפיין אחר הוא לא עובר — שם אין לו משבצת.
  const leavingSlot = current.slot_channel_id && 'campaign_id' in b &&
    b.campaign_id !== current.campaign_id;
  if (leavingSlot && b.campaign_id != null) {
    return bad(res, 'פוסט של קמפיין כללי יכול לצאת רק לתוכן שוטף, לא לקמפיין אחר');
  }
  if (current.slot_channel_id && b.sort_order != null && !leavingSlot) {
    if (!validSlot(b.sort_order)) return bad(res, 'מספר המשבצת חייב להיות מספר שלם בין 1 ל-1000');
    const taken = await one(
      `select 1 from content_items where campaign_id = $1 and slot_channel_id = $2
          and sort_order = $3 and id <> $4`,
      [current.campaign_id, current.slot_channel_id, b.sort_order, current.id]);
    if (taken) return bad(res, 'המשבצת תפוסה', 409);
  }

  // משבצת שנשמרת כ"מוכן" (או נשארת "מוכן" וטקסט שלה משתנה) — אותם כללי
  // תוכן כמו בעריכת גרסה
  if (current.slot_channel_id && !leavingSlot && (b.body !== undefined || b.status !== undefined)) {
    const v = await one(
      `select id, body, status, meta, updated_at from content_variants
        where content_id = $1 and channel_id = $2 for update`,
      [current.id, current.slot_channel_id]);
    if ('base_updated_at' in b && staleVariant(v, b.base_updated_at)) return staleReply(res, v);
    const status = ['ready', 'draft'].includes(b.status) ? b.status : (v?.status ?? 'draft');
    if (status === 'ready') {
      const err = await readyError(current.id, current.slot_channel_id, {
        body: b.body !== undefined ? (b.body ?? '') : (v?.body ?? ''), meta: v?.meta ?? null,
      });
      if (err) return bad(res, err);
    }
  }

  // מעבר לקמפיין אחר גורר איתו את נקודת הקצה שלו
  if (b.campaign_id && b.campaign_id !== current.campaign_id) {
    // נעילה כמו בהעלאה המרוכזת ובסימון "מוכן" — הסדר נקבע מול מצב יציב
    const owner = await one(
      'select endpoint_id, structure, content_complete_at from campaigns where id = $1 for update',
      [b.campaign_id]);
    if (owner) b.endpoint_id = owner.endpoint_id;
    // זווית לא נכנסת לקמפיין כללי ומשבצת-מדיה לא נכנסת לקמפיין זוויות:
    // אין לה מקום ברשת של המבנה האחר, והיא הייתה נעלמת מהמסך
    if (owner && (owner.structure === 'general') !== !!current.slot_channel_id) {
      return bad(res, owner.structure === 'general'
        ? 'אי אפשר להעביר זווית לקמפיין כללי'
        : 'אי אפשר להעביר תוכן של משבצת לקמפיין לפי זוויות');
    }
    // זווית שעוברת לקמפיין אחר מקבלת שם את המקום הפנוי הראשון — לא את
    // המספר שהיה לה בקמפיין הקודם (שם הוא יכול להיות תפוס, והזווית הייתה
    // נעלמת מהרשת). קמפיין מוכן: בסוף התור, ולא לפני הפוסטים שכבר נפרסו.
    // (Number: מזהה שהגיע כמחרוזת מהעוזר הוא אותו קמפיין, לא מעבר)
    if (owner && b.sort_order == null && Number(b.campaign_id) !== current.campaign_id) {
      b.sort_order = (await freeAngleSlots(b.campaign_id, 1)).slots[0] ?? 1;
    }
  }
  // משבצת מקושרת שיוצאת מהקמפיין מתנתקת קודם — עם עותק משלה של התוכן
  if (leavingSlot) {
    try { await releaseLinks(current.id); } catch (e) { return linkFail(res, e); }
  }
  const c = await uniqueOrNull(() => updateById('content_items', CONTENT_FIELDS, req.params.id, b));
  if (!c) return bad(res, 'המשבצת תפוסה', 409);
  if (leavingSlot) {
    await query('update content_items set slot_channel_id = null where id = $1', [c.id]);
    c.slot_channel_id = null;
  }
  if (current.campaign_id && c.campaign_id !== current.campaign_id) {
    await reopenIfEmpty(current.campaign_id);
  }

  // משבצת בקמפיין כללי: הטקסט והמצב נשמרים גם על הגרסה היחידה שלה,
  // כדי שהטופס הפשוט יישמר בבקשה אחת
  if (c.slot_channel_id && (b.body !== undefined || b.status !== undefined)) {
    await query(
      `insert into content_variants (content_id, channel_id, body, status)
       values ($1,$2,coalesce($3,''),coalesce($4,'draft'))
       on conflict (content_id, channel_id)
         do update set body = coalesce($3, content_variants.body),
                       status = coalesce($4, content_variants.status)`,
      [c.id, c.slot_channel_id, b.body !== undefined ? (b.body ?? '') : null,
       ['ready', 'draft'].includes(b.status) ? b.status : null]
    );
  }
  // משבצת מקושרת: התוכן (כותרת, סוג, טקסט, מצב) אחד לכל הקבוצה — עריכה
  // מכל משבצת בה עוברת לכולן. המיקום (משבצת, קמפיין) נשאר של כל אחת.
  if (['title', 'kind', 'body', 'status'].some((k) => b[k] !== undefined)) {
    await syncFrom(c.id);
  }
  // משבצת: הגרסה היחידה שלה — לנעילה האופטימית של השמירה הבאה מאותו טופס
  const variant = c.slot_channel_id
    ? await one('select * from content_variants where content_id = $1 and channel_id = $2',
      [c.id, c.slot_channel_id])
    : null;
  const engine = await autoFill(b.week);
  res.json({ content: c, variant, engine });
}));

/**
 * קישור משבצת למשבצת של מדיה אחרת באותו קמפיין כללי — מכאן הן חולקות תוכן
 * אחד (טקסט וקבצים), וכל אחת מתוזמנת לפי המדיה שלה. ראו src/links.js.
 * {target_campaign_slot: {channel_id, sort_order}} או {target_content_id};
 * יעד עם תוכן דורש replace: true (אחרת 409 עם needs_confirm).
 */
r.post('/content/:id/link', requirePerm('content'), wrap(async (req, res) => {
  let out;
  try { out = await linkSlots(req.params.id, req.body ?? {}); } catch (e) { return linkFail(res, e); }
  const engine = await autoFill(req.body?.week);
  res.json({ content: out.source, follower: out.follower, engine });
}));

/**
 * "נתק קישור": עוקבת מתנתקת מהמקור שלה; מקור — כל העוקבות שלו מתנתקות.
 * כל משבצת נשארת עם עותק עצמאי של התוכן (הטקסט כבר אצלה, הקבצים מועתקים).
 */
r.post('/content/:id/unlink', requirePerm('content'), wrap(async (req, res) => {
  let out;
  try { out = await unlink(req.params.id); } catch (e) { return linkFail(res, e); }
  const content = await one('select * from content_items where id = $1', [req.params.id]);
  const engine = await autoFill(req.body?.week);
  res.json({ content, ...out, engine });
}));

/** נקודת הקצה של תוכן: מהקמפיין אם יש, אחרת מה שנשלח במפורש */
async function resolveEndpoint(b) {
  if (b.campaign_id) {
    const c = await one('select endpoint_id from campaigns where id = $1', [b.campaign_id]);
    if (c) return c.endpoint_id;
  }
  return b.endpoint_id ?? null;
}

/**
 * קמפיין מוכן שנשאר בלי תוכן (הפריט האחרון נמחק או יצא ממנו) חוזר להקצאה
 * הרגילה — באותה טרנזקציה של הבקשה — כדי שהתפריט, הרשת והסטטוס יסכימו.
 */
async function reopenIfEmpty(campaignId) {
  await query(
    `update campaigns set content_complete_at = null
      where id = $1 and content_complete_at is not null
        and not exists (select 1 from content_items where campaign_id = $1)`,
    [campaignId]);
}

r.delete('/content/:id', requirePerm('content'), wrap(async (req, res) => {
  // מקור שנמחק לא משאיר עוקבות ריקות: כל אחת נשארת עם עותק משלה (הראשונה
  // יורשת את הקבצים עצמם). עוקבת שנמחקת פשוט יוצאת מהקבוצה.
  try {
    await releaseLinks(req.params.id, { sourceGoing: true });
  } catch (e) { return linkFail(res, e); }
  const gone = await one('delete from content_items where id = $1 returning campaign_id',
    [req.params.id]);
  if (gone?.campaign_id) await reopenIfEmpty(gone.campaign_id);
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, engine });
}));

/* ========================= קבצים מצורפים ========================= */

/**
 * שני מסלולי העלאה:
 *
 * 1. R2 (כש-mediaReady): הדפדפן מבקש חתימה (uploads/sign), מעלה ישירות
 *    ל-R2 ב-PUT, ומדווח (uploads/complete). השרת לא נוגע בבייטים — רק
 *    בודק ב-HEAD את הגודל והסוג האמיתיים ורושם שורה עם storage_key.
 * 2. multipart → bytea במסד (multer, עד 50MB): מקומית ולפני שמשתני
 *    R2_PUBLIC_* מוגדרים. התחזוקה מעבירה שורות כאלה ל-R2 ברקע.
 */

/** הגרסה של זווית במדיה מסוימת — נוצרת אם עוד אין, כדי לתלות עליה קבצים */
async function ensureVariant(contentId, channelId) {
  return one(
    `insert into content_variants (content_id, channel_id)
     values ($1,$2) on conflict (content_id, channel_id) do update set content_id = $1
     returning *`,
    [contentId, channelId]
  );
}

/** קבצים משותפים לכל המדיות של הזווית */
r.post('/content/:id/assets', requirePerm('content'), upload.array('files'),
  wrap(async (req, res) => {
    // משבצת מקושרת: הקובץ נרשם על המקור, ומשם כל הקבוצה רואה אותו
    const owner = await mediaOwner(req.params.id);
    if (!owner) return bad(res, 'לא נמצא תוכן כזה', 404);
    res.status(201).json({ assets: await saveAssets(req.files, owner.contentId, null) });
  }));

/** קבצים ששייכים לגרסה של מדיה אחת — הריל, התמונה המרובעת וכדומה */
r.post('/content/:id/variants/:channelId/assets', requirePerm('content'),
  upload.array('files'), wrap(async (req, res) => {
    const slotErr = await slotChannelError(req.params.id, req.params.channelId);
    if (slotErr) return bad(res, slotErr);
    const owner = await mediaOwner(req.params.id, req.params.channelId);
    if (!owner) return bad(res, 'לא נמצא תוכן כזה', 404);
    const v = await ensureVariant(owner.contentId, owner.channelId);
    res.status(201).json({ assets: await saveAssets(req.files, v.content_id, v.id) });
  }));

async function saveAssets(files, contentId, variantId) {
  if (!files?.length) throw new Error('לא הגיעו קבצים');
  const saved = [];
  for (const f of files) {
    saved.push(await one(
      `insert into content_assets (content_id, variant_id, filename, mime, size_bytes, data)
       values ($1,$2,$3,$4,$5,$6)
       returning id, content_id, variant_id, filename, mime, size_bytes, storage_key`,
      [contentId, variantId, f.originalname, f.mimetype, f.size, f.buffer]
    ));
  }
  return saved.map(assetView);
}

/** שם התצוגה של קובץ: מה שהלקוח שלח, אחרת המקטע האחרון של המפתח */
const displayName = (filename, key) =>
  (typeof filename === 'string' && filename.trim() ? filename.trim() : key.split('/').pop())
    .slice(0, 255);

/**
 * בדיקות משותפות לכל קובץ שהדפדפן כבר העלה ל-R2: המפתח שייך לארגון,
 * עוד לא נרשם, לא בסל המחזור, ו-HEAD מאשר גודל וסוג. מחזיר {head} או
 * {error, status}.
 */
async function checkUploadedKey(key) {
  if (!isOwnKey(currentOrg(), key)) return { error: 'מפתח קובץ לא תקין', status: 400 };
  if (await one('select 1 from content_assets where storage_key = $1', [key])) {
    return { error: 'הקובץ הזה כבר נשמר', status: 409 };
  }
  if (await one('select 1 from media_trash where storage_key = $1', [key])) {
    return { error: 'הקובץ הזה נמחק', status: 409 };
  }
  const { head, problem } = await verifyUploaded(key);
  return problem ?? { head };
}

/** ערוץ קיים (בארגון — RLS). מזהה לא מספרי לא מגיע ל-SQL. */
async function channelExists(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return false;
  return !!(await one('select 1 from channels where id = $1', [n]));
}

/** שורת content_assets לקובץ שיושב ב-R2. runner = client של טרנזקציה או {query}. */
async function insertR2Asset(runner, { contentId, variantId, key, filename, head }) {
  const r = await runner.query(
    `insert into content_assets (content_id, variant_id, filename, mime, size_bytes, storage_key)
     values ($1,$2,$3,$4,$5,$6)
     returning id, content_id, variant_id, filename, mime, size_bytes, storage_key`,
    [contentId, variantId, displayName(filename, key), headMime(head), head.size, key]
  );
  return r.rows[0];
}

/**
 * שלב 1 בהעלאה ל-R2: חתימה. {filename, mime, size, channel_id?} → {key, url}.
 * הגודל המוצהר נבדק כאן, והגודל האמיתי שוב ב-complete (HEAD).
 */
r.post('/content/:id/uploads/sign', requirePerm('content'), wrap(async (req, res) => {
  if (!mediaReady()) return bad(res, 'אחסון המדיה לא מוגדר בשרת', 503);
  const b = req.body ?? {};
  const err = validateSignRequest(b);
  if (err) return bad(res, err, Number(b.size) > MAX_MEDIA_BYTES ? 413 : 400);

  const item = await one('select id from content_items where id = $1', [req.params.id]);
  if (!item) return bad(res, 'לא נמצא תוכן כזה', 404);
  if (b.channel_id != null && !(await channelExists(b.channel_id))) {
    return bad(res, 'לא נמצא ערוץ כזה', 404);
  }
  if (b.channel_id != null) {
    const slotErr = await slotChannelError(item.id, b.channel_id);
    if (slotErr) return bad(res, slotErr);
  }

  const key = newMediaKey(currentOrg(), b.filename);
  // הדפדפן חייב לשלוח בדיוק את הכותרות החתומות (סוג וגודל) — אחרת R2 דוחה
  const headers = uploadSignedHeaders(b.mime, b.size);
  res.json({ key, url: mediaStore.presignPut(key, headers), method: 'PUT',
             headers: { 'Content-Type': headers['content-type'] } });
}));

/**
 * שלב 2: הדפדפן סיים את ה-PUT. {key, filename, channel_id?} → שורת קובץ.
 * בלי channel_id — משותף לזווית; עם — של הגרסה למדיה (נוצרת אם אין).
 */
r.post('/content/:id/uploads/complete', requirePerm('content'), wrap(async (req, res) => {
  if (!mediaReady()) return bad(res, 'אחסון המדיה לא מוגדר בשרת', 503);
  const { key, filename, channel_id: channelId } = req.body ?? {};

  const item = await one('select id from content_items where id = $1', [req.params.id]);
  if (!item) return bad(res, 'לא נמצא תוכן כזה', 404);

  if (channelId != null && !(await channelExists(channelId))) {
    return bad(res, 'לא נמצא ערוץ כזה', 404);
  }
  if (channelId != null) {
    const slotErr = await slotChannelError(item.id, channelId);
    if (slotErr) return bad(res, slotErr);
  }

  const checked = await checkUploadedKey(key);
  if (checked.error) return bad(res, checked.error, checked.status);

  // משבצת מקושרת: הקובץ נרשם על המקור (ובגרסה — על הגרסה של המקור)
  const owner = await mediaOwner(item.id, channelId);
  const variantId = owner.channelId != null
    ? (await ensureVariant(owner.contentId, owner.channelId)).id : null;
  const asset = await insertR2Asset({ query }, {
    contentId: owner.contentId, variantId, key, filename, head: checked.head,
  });
  res.status(201).json({ asset: assetView(asset) });
}));


/**
 * הגשת הקובץ עצמו. מאחורי אותה בדיקת התחברות כמו כל השאר.
 * קובץ ב-R2 — הפניה לקישור הציבורי הקבוע (הבייטים לא עוברים דרכנו);
 * קובץ ישן (bytea) — מוגש מהמסד כמו קודם.
 */
r.get('/assets/:id', wrap(async (req, res) => {
  const a = await one(
    `select filename, mime, storage_key,
            case when storage_key is null then data end as data
       from content_assets where id = $1`, [req.params.id]
  );
  if (!a) return bad(res, 'לא נמצא קובץ כזה', 404);
  if (a.storage_key) {
    const url = mediaUrl(a.storage_key);
    if (!url) return bad(res, 'הכתובת הציבורית של המדיה לא מוגדרת (R2_PUBLIC_BASE_URL)', 503);
    return res.redirect(302, url);
  }
  res.setHeader('Content-Type', a.mime);
  // inline כדי שתמונות ייפתחו בתצוגה מקדימה ולא ירדו כקובץ
  res.setHeader('Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.send(a.data);
}));

/**
 * מחיקת קובץ. קובץ ב-R2 לא נמחק מה-bucket מיד: השורה יורדת והמפתח עובר
 * לסל המחזור לשלושים יום (חלון לשחזור מגיבוי) — באותה פקודה, כך שאין
 * מצב ביניים של שורה שנמחקה בלי רישום בסל. התחזוקה מוחקת כשמגיע הזמן.
 */
r.delete('/assets/:id', requirePerm('content'), wrap(async (req, res) => {
  await query(
    `with gone as (delete from content_assets where id = $1 returning storage_key)
     insert into media_trash (bucket, storage_key, delete_after)
     select $2, storage_key, now() + make_interval(days => $3)
       from gone where storage_key is not null
     on conflict (bucket, storage_key) do nothing`,
    [req.params.id, process.env.R2_PUBLIC_BUCKET ?? '', TRASH_DAYS]
  );
  res.json({ ok: true });
}));

/**
 * העלאה מרוכזת: כל קובץ הופך לפריט תוכן, והפריטים מתפזרים
 * למשבצות הריקות של הקמפיין לפי הסדר. שני מסלולים חולקים את הלוגיקה —
 * multipart (bytea) ו-R2 (קבצים שכבר עלו) — ונבדלים רק בשורת הקובץ.
 *
 * @param files [{filename}] — לפי הסדר
 * @param attach (client, contentId, index) → מוסיף את שורת הקובץ לפריט
 */
async function bulkAngles(req, res, files, attach) {
  // נעילת שורת הקמפיין עד סוף הבקשה (כל בקשה היא טרנזקציה אחת, withOrg):
  // המשבצות הפנויות נקראות אחרי הנעילה, ו"קמפיין מוכן" (שדוחס את הסדר)
  // לוקח אותה נעילה — שתי העלאות במקביל, או העלאה מול סימון, לא יחשבו
  // את אותה משבצת פנויה
  const campaign = await one('select * from campaigns where id = $1 for update', [req.params.id]);
  if (!campaign) return bad(res, 'לא נמצא קמפיין כזה', 404);
  if (!files?.length) return bad(res, 'לא הגיעו קבצים');

  const kind = ['promo', 'value', 'hybrid'].includes(req.body?.kind)
    ? req.body.kind : 'value';
  if (campaign.structure === 'general') {
    return bulkGeneral(req, res, campaign, kind, files, attach);
  }
  const channelIds = parseIdList(req.body?.ready_channel_ids);

  const myChannels = await rows(
    `select ch.* from campaign_channels cc join channels ch on ch.id = cc.channel_id
      where cc.campaign_id = $1 order by ch.sort_order, ch.id`,
    [campaign.id]
  );
  // המשבצות הריקות לפי הסדר, ואחריהן המשך אחרי האחרונה — אותו חשבון כמו
  // המסך (כולל הנתח שנגזר מהקמפיינים החופפים). קמפיין שסומן מוכן הוא בגודל
  // התוכן שלו: מה שנוסף נכנס בסוף ומגדיל אותו.
  const { slots, need: required } = await freeAngleSlots(campaign.id, files.length);

  const created = [];
  const ok = await uniqueOrNull(() => tx(async (client) => {
    for (const [i, f] of files.entries()) {
      const slot = slots[i];
      const item = (await client.query(
        `insert into content_items (endpoint_id, campaign_id, kind, title,
                                    ready_channel_ids, sort_order)
         values ($1,$2,$3,$4,$5::int[],$6) returning *`,
        [campaign.endpoint_id, campaign.id, kind, titleFromFilename(f.filename),
         channelIds.length ? channelIds : myChannels.map((c) => c.id), slot]
      )).rows[0];

      // הזווית נפתחת עם טיוטה לכל מדיה של הקמפיין — הטקסט נכתב לכל אחת בנפרד
      for (const ch of (channelIds.length ? channelIds : myChannels.map((c) => c.id))) {
        await client.query(
          `insert into content_variants (content_id, channel_id, status)
           values ($1,$2,'draft') on conflict do nothing`,
          [item.id, ch]
        );
      }

      await attach(client, item.id, i);
      created.push({ id: item.id, title: item.title, slot });
    }
    return true;
  }));
  if (!ok) return bad(res, SLOT_RACE, 409);

  res.status(201).json({
    created,
    filled_slots: created.filter((c) => required === null || c.slot <= required).length,
    overflow: created.filter((c) => required !== null && c.slot > required).length,
  });
}

/**
 * העלאה מרוכזת לקמפיין כללי: לעמודה של מדיה אחת (channel_id). כל קובץ
 * ממלא את המשבצת הפנויה הבאה של המדיה הזו, עם גרסת טיוטה אחת — לאותה
 * מדיה בלבד. כשהמשבצות נגמרות ממשיכים אחריהן, כמו בזוויות.
 */
async function bulkGeneral(req, res, campaign, kind, files, attach) {
  const channelId = Number(req.body?.channel_id);
  const myChannels = await rows(
    `select ch.* from campaign_channels cc join channels ch on ch.id = cc.channel_id
      where cc.campaign_id = $1 order by ch.sort_order, ch.id`,
    [campaign.id]
  );
  if (!myChannels.some((c) => c.id === channelId)) {
    return bad(res, 'בקמפיין כללי ההעלאה המרוכזת היא למדיה אחת מהמדיות של הקמפיין');
  }

  // אותו חשבון בדיוק כמו המסך (campaignsWithHealth) — כולל הנתח שנגזר
  // מהקמפיינים החופפים — כדי שהקבצים ימלאו את המשבצות שהמשתמש רואה
  const concurrent = await rows('select * from campaigns');
  // קמפיין שסומן מוכן: אין משבצות ריקות — הקבצים נכנסים בסוף ומגדילים אותו
  const need = campaign.content_complete_at
    ? null : channelNeeds(campaign, myChannels, concurrent).get(channelId) ?? null;

  const existing = await rows(
    'select sort_order from content_items where campaign_id = $1 and slot_channel_id = $2',
    [campaign.id, channelId]
  );
  const slots = nextSlots(need, existing.map((x) => x.sort_order), files.length);

  const created = [];
  const ok = await uniqueOrNull(() => tx(async (client) => {
    for (const [i, f] of files.entries()) {
      const slot = slots[i];
      const item = (await client.query(
        `insert into content_items (endpoint_id, campaign_id, kind, title,
                                    ready_channel_ids, sort_order, slot_channel_id)
         values ($1,$2,$3,$4,$5::int[],$6,$7) returning *`,
        [campaign.endpoint_id, campaign.id, kind, titleFromFilename(f.filename),
         [channelId], slot, channelId]
      )).rows[0];
      await client.query(
        `insert into content_variants (content_id, channel_id, status) values ($1,$2,'draft')`,
        [item.id, channelId]
      );
      await attach(client, item.id, i);
      created.push({ id: item.id, title: item.title, slot });
    }
    return true;
  }));
  if (!ok) return bad(res, SLOT_RACE, 409);

  res.status(201).json({
    created,
    filled_slots: created.filter((c) => need === null || c.slot <= need).length,
    overflow: created.filter((c) => need !== null && c.slot > need).length,
  });
}

/** ייבוא וניתוח יוצרים זוויות — בקמפיין כללי אין להן מקום */
async function anglesOnly(req, res) {
  const c = await one('select structure from campaigns where id = $1', [req.params.id]);
  if (c?.structure === 'general') {
    bad(res, 'ייבוא מטבלה זמין רק בקמפיין לפי זוויות');
    return false;
  }
  return true;
}

/** העלאה מרוכזת — multipart, הבייטים נשמרים במסד */
r.post('/campaigns/:id/bulk', requirePerm('content'), upload.array('files'),
  wrap(async (req, res) => {
    const files = (req.files ?? []).map((f) => ({ ...f, filename: f.originalname }));
    await bulkAngles(req, res, files, (client, contentId, i) => client.query(
      `insert into content_assets (content_id, filename, mime, size_bytes, data)
       values ($1,$2,$3,$4,$5)`,
      [contentId, files[i].originalname, files[i].mimetype, files[i].size, files[i].buffer]
    ));
  }));

/**
 * העלאה מרוכזת — R2. הדפדפן כבר העלה כל קובץ (חתימה מול זווית קיימת לא
 * רלוונטית כאן, ולכן החתימה מגיעה מ-bulk/sign). {kind, files:[{key, filename}]}.
 * כל המפתחות נבדקים לפני שנוצר משהו — קובץ פסול אחד עוצר את כל המנה.
 */
r.post('/campaigns/:id/bulk/sign', requirePerm('content'), wrap(async (req, res) => {
  if (!mediaReady()) return bad(res, 'אחסון המדיה לא מוגדר בשרת', 503);
  const b = req.body ?? {};
  const err = validateSignRequest(b);
  if (err) return bad(res, err, Number(b.size) > MAX_MEDIA_BYTES ? 413 : 400);
  const campaign = await one('select id from campaigns where id = $1', [req.params.id]);
  if (!campaign) return bad(res, 'לא נמצא קמפיין כזה', 404);
  const key = newMediaKey(currentOrg(), b.filename);
  // הדפדפן חייב לשלוח בדיוק את הכותרות החתומות (סוג וגודל) — אחרת R2 דוחה
  const headers = uploadSignedHeaders(b.mime, b.size);
  res.json({ key, url: mediaStore.presignPut(key, headers), method: 'PUT',
             headers: { 'Content-Type': headers['content-type'] } });
}));

r.post('/campaigns/:id/bulk/media', requirePerm('content'), wrap(async (req, res) => {
  if (!mediaReady()) return bad(res, 'אחסון המדיה לא מוגדר בשרת', 503);
  const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 100) : [];
  if (new Set(files.map((f) => f?.key)).size !== files.length) {
    return bad(res, 'אותו קובץ נשלח פעמיים');
  }
  const heads = [];
  for (const f of files) {
    const checked = await checkUploadedKey(f?.key);
    if (checked.error) return bad(res, `${f?.filename ?? 'קובץ'}: ${checked.error}`, checked.status);
    heads.push(checked.head);
  }
  await bulkAngles(req, res, files, (client, contentId, i) => insertR2Asset(client, {
    contentId, variantId: null, key: files[i].key, filename: files[i].filename, head: heads[i],
  }));
}));


/**
 * ייבוא תוכן מטבלה. שני שלבים בכוונה: תצוגה מקדימה שלא כותבת כלום,
 * ואז ביצוע — כדי שאף אחד לא יטעין 200 שורות בלי לראות מה ייווצר.
 */
r.post('/campaigns/:id/import/preview', requirePerm('content'), wrap(async (req, res) => {
  if (!(await anglesOnly(req, res))) return;
  try {
    res.json(await analyzeImport(req.params.id, req.body?.text));
  } catch (e) {
    return bad(res, e.message);
  }
}));

/**
 * ניתוח מסמך חופשי. המודל ממיר אותו לטבלה, והטבלה חוזרת ללקוח לעריכה
 * ולאישור — היא לא נכתבת. הכתיבה עוברת אחר כך באותו נתיב ייבוא רגיל.
 */
r.post('/campaigns/:id/import/analyze', requirePerm('content'), upload.single('file'),
  wrap(async (req, res) => {
    if (!(await anglesOnly(req, res))) return;
    if (!assistantReady()) {
      return bad(res, 'הניתוח לא זמין — חסר מפתח API בהגדרות השרת', 503);
    }
    try {
      const doc = req.file
        ? extract(req.file)
        : { kind: 'text', text: String(req.body?.text ?? ''), source: 'טקסט שהודבק' };
      if (doc.kind === 'text' && !doc.text.trim()) return bad(res, 'אין מה לנתח');

      res.json({ ...await analyzeDocument(req.params.id, doc), source: doc.source });
    } catch (e) {
      return bad(res, e.message, 502);
    }
  }));

r.post('/campaigns/:id/import', requirePerm('content'), wrap(async (req, res) => {
  if (!(await anglesOnly(req, res))) return;
  try {
    res.status(201).json(await runImport(req.params.id, req.body?.text));
  } catch (e) {
    return bad(res, e.message);
  }
}));

export default r;
