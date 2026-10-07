import { Router } from 'express';
import { requirePerm } from '../auth.js';
import {
  autoFill, autoFillCampaign, bad, lockEngineOr503, parseIdList, titleFromFilename, updateById,
  upload, wrap,
} from './_shared.js';
import { revalidateCampaignPosts } from '../campaign-shift.js';
import { currentOrg, one, query, rows, tx } from '../db.js';
import {
  MAX_MEDIA_BYTES, TRASH_DAYS, assetView, headMime, isOwnKey, mediaReady, mediaStore, mediaUrl,
  newMediaKey, uploadSignedHeaders, validateSignRequest, verifyUploaded,
} from '../media.js';
import {
  CAMPAIGNS_WEIGHTED_SQL, channelNeeds, freeAngleSlots, loadGapDays, nextSlots,
} from '../campaigns.js';
import { analyzeImport, runImport, undoImport } from '../import.js';
import { assistantReady } from '../assistant.js';
import { extract } from '../extract.js';
import { analyzeDocument } from '../analyze.js';
import {
  LinkError, applyLinkPlan, assetOwnerId, autoLinkNew, copyAssetsTo, itemAssetsSql, linkGroup,
  linkRulesError, linkRulesPlan, linkSlots, linkedBetween, lockLinkScope, mediaOwner,
  normalizeLinkRules, releaseLinks, syncFrom, unlink,
} from '../links.js';
import { contentBlocker, metaExtrasError, readyRejection } from '../publish/readiness.js';
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
  return 'הפוסט הזה שייך לערוץ אחד בקמפיין כללי — אין לו גרסה לערוץ אחר';
}

/** שגיאת קישור (LinkError) חוזרת למשתמש כמו שהיא; כל השאר — שגיאת שרת */
function linkFail(res, e) {
  if (e instanceof LinkError) return res.status(e.status).json({ error: e.message, ...e.extra });
  throw e;
}

/**
 * מה חסר לגרסה עם התוכן הזה כדי להיות "מוכן" בערוץ הזה — אותם כללי תוכן
 * כמו בפרסום (readiness.js). הקבצים: מה שהפריט יצא איתו בערוץ (משבצת
 * מקושרת — של המקור). רץ לפני הכתיבה: הבקשה נשמרת (commit) גם כשהתשובה 400.
 * @returns {Promise<string|null>} הסיבה, או null כשאין חסר
 */
async function readyReason(contentId, channelId, variant, { assets } = {}) {
  const ch = await one('select platform from channels where id = $1', [channelId]);
  if (!ch) return null;
  const files = assets ?? (contentId ? await rows(itemAssetsSql('a.id, a.mime'), [contentId, channelId]) : []);
  return contentBlocker({ platform: ch.platform, variant, assets: files });
}

/**
 * "מוכן" נבדק רק במעבר אליו (או ביצירה כמוכן): שם החסר נדחה ב-400. גרסה
 * שכבר "מוכן" נשמרת גם כשהיא לא עוברת — אחרת אי אפשר היה לתקן בה טקסט —
 * והסיבה חוזרת כ-warn (התא מסומן "מוכן ⚠").
 * @returns {Promise<{error?:string, warn:string|null}>}
 */
async function readyCheck(contentId, channelId, variant, wasReady, opts) {
  const reason = await readyReason(contentId, channelId, variant, opts);
  if (reason && !wasReady) return { error: readyRejection(reason), warn: reason };
  return { warn: reason };
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
  const metaErr = metaExtrasError(b.meta);
  if (metaErr) return bad(res, metaErr);

  const before = await one(
    `select id, body, status, meta, updated_at from content_variants
      where content_id = $1 and channel_id = $2 for update`,
    [req.params.id, req.params.channelId]);
  // נעילה אופטימית — רק כשהטופס שלח מול מה הוא נפתח (העוזר וקריאות ישנות לא)
  if ('base_updated_at' in b && staleVariant(before, b.base_updated_at)) {
    return staleReply(res, before);
  }
  // "מוכן" נבדק מול התוכן שיישמר בפועל (מה שלא נשלח — נשאר מהקיים)
  let warn = null;
  if (status === 'ready') {
    const check = await readyCheck(req.params.id, req.params.channelId, {
      body: b.body ?? before?.body ?? '', meta: b.meta ?? before?.meta ?? null,
    }, before?.status === 'ready');
    if (check.error) return bad(res, check.error);
    warn = check.warn;
  }

  // meta — נושא ורשימות יעד של ערוץ המייל. לא נשלח = לא נוגעים בקיים.
  const meta = b.meta != null ? JSON.stringify(b.meta) : null;
  const params = [req.params.id, req.params.channelId, b.body ?? null, status, meta];
  let v;
  if ('base_updated_at' in b && !before) {
    // שמירה ראשונה מטופס שנפתח בלי גרסה: אין שורה לנעול, ושתי שמירות במקביל
    // היו דורסות זו את זו. השנייה לא מוסיפה כלום ומקבלת 409, כמו גרסה ישנה.
    v = await one(
      `insert into content_variants (content_id, channel_id, body, status, meta)
       values ($1,$2,coalesce($3,''),$4,$5::jsonb)
       on conflict (content_id, channel_id) do nothing returning *`, params);
    if (!v) {
      return staleReply(res, await one(
        `select id, body, status, meta, updated_at from content_variants
          where content_id = $1 and channel_id = $2`, [req.params.id, req.params.channelId]));
    }
  } else {
    v = await one(
      `insert into content_variants (content_id, channel_id, body, status, meta)
       values ($1,$2,coalesce($3,''),$4,$5::jsonb)
       on conflict (content_id, channel_id)
         do update set body = coalesce($3, content_variants.body), status = $4,
                       meta = coalesce($5::jsonb, content_variants.meta)
       returning *`, params);
  }
  // משבצת מקושרת: אותו טקסט ומצב לכל המשבצות בקבוצה (downgraded — עוקבות
  // שנשארו טיוטה כי התוכן לא מספיק לערוץ שלהן)
  const { downgraded } = await syncFrom(req.params.id,
    { statusChanged: (before?.status ?? null) !== status });
  const engine = await autoFill(b.week);
  res.json({ variant: v, warn, downgraded, engine });
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

  const engine = await autoFillCampaign(c.id, req.body?.week);
  res.json({ campaign: c, cleared: cleared.length + clashed.length, engine });
}));

/** סידור מחדש של התוכן בתוך קמפיין */
r.patch('/campaigns/:id/order', requirePerm('content'), wrap(async (req, res) => {
  const ids = req.body?.content_ids;
  if (!Array.isArray(ids)) return bad(res, 'צריך רשימת מזהי תוכן');
  const c = await one('select structure from campaigns where id = $1', [req.params.id]);
  if (c?.structure === 'general') {
    return bad(res, 'בקמפיין כללי אין סדר זוויות — כל פוסט יושב במשבצת של הערוץ שלו');
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

/**
 * פוסטים של התוכן שלא פורסמו — עתידיים, וגם כאלה שהמועד שלהם עבר (נכשל,
 * חסר תוכן, ממתין לאישור). 'publishing' בכוונה לא כאן: פרסום באמצע לא נעצר
 * ממחיקה; הפוסט נשאר, בלי תוכן, ומסלול התקיעה מטפל בו.
 */
const UNPUBLISHED = `p.status in ('scheduled','approved','failed','pending_approval','hole')`;
const FUTURE_UNPUBLISHED = `${UNPUBLISHED} and p.scheduled_at >= now()`;

/**
 * מה מחיקת הקמפיין נוגעת בו — לשאלה לפני המחיקה: כמה פריטי תוכן, כמה
 * פוסטים שלהם לא פורסמו (יורדים במחיקה עם התוכן), כמה מהם עתידיים (נשארים
 * על הלוח כשמשאירים את התוכן), וכמה כבר פורסמו (נשארים בהיסטוריה תמיד).
 */
r.get('/campaigns/:id/delete-impact', wrap(async (req, res) => {
  const c = await one('select id, name from campaigns where id = $1', [req.params.id]);
  if (!c) return bad(res, 'לא נמצא קמפיין כזה', 404);
  const n = await one(
    `select (select count(*)::int from content_items where campaign_id = $1) as content,
            (select count(*)::int from posts p join content_items ci on ci.id = p.content_id
              where ci.campaign_id = $1 and ${FUTURE_UNPUBLISHED}) as future_posts,
            (select count(*)::int from posts p join content_items ci on ci.id = p.content_id
              where ci.campaign_id = $1 and ${UNPUBLISHED}) as unpublished_posts,
            (select count(*)::int from posts p join content_items ci on ci.id = p.content_id
              where ci.campaign_id = $1 and p.status = 'published') as published`,
    [c.id]);
  res.json(n);
}));

/**
 * מחיקת קמפיין. ?content=delete — גם התוכן שלו נמחק, עם כל הפוסטים שלו שלא
 * פורסמו (גם כאלה שהמועד שלהם עבר); מה שפורסם נשאר בהיסטוריה, בלי תוכן. קבצים ב-R2 עוברים
 * לסל המחזור. ?content=keep (ברירת המחדל לקריאה בלי פרמטר — העוזר, קריאות
 * ישנות): התוכן נשאר כתוכן שוטף של נקודת הקצה, כמו עד היום.
 */
r.delete('/campaigns/:id', requirePerm('settings'), wrap(async (req, res) => {
  const mode = req.query.content === 'delete' ? 'delete' : 'keep';
  // נעילת הקמפיין לפני הקבוצות (אותו סדר כמו בכל שינוי של משבצות מקושרות)
  const exists = await one('select id from campaigns where id = $1 for update', [req.params.id]);
  if (!exists) return bad(res, 'לא נמצא קמפיין כזה', 404);

  let removed = { content: 0, posts: 0 };
  if (mode === 'delete') {
    // כל הקבוצה נמחקת יחד — אין טעם להעתיק קבצים לעוקבות שנמחקות גם הן
    const posts = await rows(
      `delete from posts p using content_items ci
        where ci.id = p.content_id and ci.campaign_id = $1 and ${UNPUBLISHED}
        returning p.id`, [req.params.id]);
    await query(
      `insert into media_trash (bucket, storage_key, delete_after)
       select $2, a.storage_key, now() + make_interval(days => $3)
         from content_assets a join content_items ci on ci.id = a.content_id
        where ci.campaign_id = $1 and a.storage_key is not null
       on conflict (bucket, storage_key) do nothing`,
      [req.params.id, process.env.R2_PUBLIC_BUCKET ?? '', TRASH_DAYS]);
    const items = await rows('delete from content_items where campaign_id = $1 returning id',
      [req.params.id]);
    removed = { content: items.length, posts: posts.length };
  } else {
    // משבצות מקושרות מתפרקות קודם: בתוכן שוטף אין משבצות לקשר ביניהן, וכל
    // אחת נשארת עם עותק משלה של התוכן (קבצים מועתקים מהמקור)
    const sources = await rows(
      `select distinct linked_to_id as id from content_items
        where campaign_id = $1 and linked_to_id is not null`, [req.params.id]);
    try {
      for (const s of sources) await releaseLinks(s.id);
    } catch (e) { return linkFail(res, e); }
    // התוכן נשאר ומתנתק (on delete set null). משבצת-ערוץ בלי קמפיין היא
    // סתם תוכן שוטף, ולכן גם השיוך למשבצת יורד.
    await query('update content_items set slot_channel_id = null where campaign_id = $1',
      [req.params.id]);
  }
  await query('delete from campaigns where id = $1', [req.params.id]);
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, content: mode, removed, engine });
}));

/* ========================= תוכן ========================= */

/** ספריית התוכן, עם הגרסאות לכל מדיה ולאן כל פריט כבר שובץ */
r.get('/content', wrap(async (_req, res) => {
  const items = await rows(
    `select ci.*, e.name as endpoint_name, c.name as campaign_name,
            coalesce(p.placements, 0) as placements
       from content_items ci
       join endpoints e on e.id = ci.endpoint_id
       left join campaigns c on c.id = ci.campaign_id
       left join (select content_id, count(*)::int as placements
                    from posts where content_id is not null group by content_id) p
              on p.content_id = ci.id
      order by ci.campaign_id nulls last, ci.sort_order, ci.id`
  );
  const variants = await rows('select * from content_variants order by content_id, channel_id');
  const assets = await rows(`select id, content_id, variant_id, filename, mime, size_bytes, storage_key
          from content_assets order by id`);

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
    if (!onCampaign) return bad(res, 'בקמפיין כללי צריך לבחור ערוץ מהערוצים של הקמפיין');
  }

  // משבצת מפורשת מנצחת (מילוי משבצת מהציר). בלעדיה — סוף התור.
  // בזוויות המשבצת היא שורה ברשת; בכללי — מקום ברשימה של מדיה אחת.
  let nextOrder = 0;
  if (slotChannel && b.sort_order != null && !validSlot(b.sort_order)) {
    return bad(res, 'מספר המשבצת חייב להיות מספר שלם בין 1 ל-1000');
  }
  if (b.campaign_id) {
    // נעילת הקמפיין לפני שבודקים מקום — גם במקום מפורש, כמו בהעלאה המרוכזת.
    // שתי יצירות במקביל לא יקבלו אותו מקום. גם במשבצת של קמפיין כללי: קישור
    // העמודות (autoLinkNew) נועל את הקמפיין אחרי היצירה, ובלי הנעילה כאן
    // יצירה מול העלאה מרוכזת לאותה עמודה נתקעות זו בזו (deadlock)
    await one('select id from campaigns where id = $1 for update', [b.campaign_id]);
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
      // זווית בלי מקום מפורש — המקום הפנוי הראשון ברשת, לא אחרי האחרון
      nextOrder = (await freeAngleSlots(b.campaign_id, 1)).slots[0] ?? 1;
    }
  }

  // משבצת חדשה שנשלחת כ"מוכן" — אותם כללי תוכן כמו בעריכת גרסה. אין לה
  // עדיין קבצים (הם עולים אחרי היצירה), ולכן הטופס שולח קודם טיוטה כשיש קבצים.
  // שדות הפרסום הנוספים (סוג פרסום, תגובה ראשונה...) — רק למשבצת, שיש לה גרסה
  const slotMeta = slotChannel && b.meta != null ? b.meta : null;
  const metaErr = metaExtrasError(slotMeta);
  if (metaErr) return bad(res, metaErr);
  if (slotChannel && b.status === 'ready') {
    const check = await readyCheck(null, slotChannel, { body: b.body ?? '', meta: slotMeta },
      false, { assets: [] });
    if (check.error) return bad(res, check.error);
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
      `insert into content_variants (content_id, channel_id, body, status, meta)
       values ($1,$2,coalesce($3,''),$4,$5::jsonb) returning *`,
      [c.id, slotChannel, b.body ?? null, b.status === 'ready' ? 'ready' : 'draft',
       slotMeta ? JSON.stringify(slotMeta) : null]
    );
    // קישור עמודות של הקמפיין: הפוסט מועתק למשבצת הפנויה הבאה בעמודות היעד
    const copied = await autoLinkNew(c.id);
    // fill: false — משבצת שנפתחה מפוסט על הלוח (סעיף 17): הטופס משייך אותה
    // לפוסט הזה מיד אחרי היצירה, ומילוי עכשיו היה משבץ אותה גם במקום אחר
    const engine = b.fill === false ? null : await fillFor(c, b.week);
    // variant — לנעילה האופטימית של השמירה הבאה מאותו טופס (updated_at)
    return res.status(201).json({ content: c, variant, copied, engine });
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
  const engine = await fillFor(c, b.week);
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

  // משבצת שעוברת ל"מוכן" — אותם כללי תוכן כמו בעריכת גרסה. משבצת שכבר
  // "מוכן" נשמרת, והסיבה (אם יש) חוזרת כ-warn
  let warn = null;
  // המצב של המשבצת לפני העריכה — המצב עובר לקבוצה המקושרת רק כשהוא השתנה
  let statusBefore = null;
  // meta — שדות הפרסום הנוספים של המשבצת; לא נשלח = לא נוגעים בקיים
  const slotMeta = current.slot_channel_id && b.meta != null ? b.meta : null;
  const metaErr = metaExtrasError(slotMeta);
  if (metaErr) return bad(res, metaErr);
  const touchesVariant = b.body !== undefined || b.status !== undefined || slotMeta != null;
  if (current.slot_channel_id && !leavingSlot && touchesVariant) {
    const v = await one(
      `select id, body, status, meta, updated_at from content_variants
        where content_id = $1 and channel_id = $2 for update`,
      [current.id, current.slot_channel_id]);
    if ('base_updated_at' in b && staleVariant(v, b.base_updated_at)) return staleReply(res, v);
    statusBefore = v?.status ?? null;
    const status = ['ready', 'draft'].includes(b.status) ? b.status : (v?.status ?? 'draft');
    if (status === 'ready') {
      const check = await readyCheck(current.id, current.slot_channel_id, {
        body: b.body !== undefined ? (b.body ?? '') : (v?.body ?? ''), meta: slotMeta ?? v?.meta ?? null,
      }, v?.status === 'ready');
      if (check.error) return bad(res, check.error);
      warn = check.warn;
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
  if (c.slot_channel_id && touchesVariant) {
    await query(
      `insert into content_variants (content_id, channel_id, body, status, meta)
       values ($1,$2,coalesce($3,''),coalesce($4,'draft'),$5::jsonb)
       on conflict (content_id, channel_id)
         do update set body = coalesce($3, content_variants.body),
                       status = coalesce($4, content_variants.status),
                       meta = coalesce($5::jsonb, content_variants.meta)`,
      [c.id, c.slot_channel_id, b.body !== undefined ? (b.body ?? '') : null,
       ['ready', 'draft'].includes(b.status) ? b.status : null,
       slotMeta ? JSON.stringify(slotMeta) : null]
    );
  }
  // משבצת מקושרת: התוכן (כותרת, סוג, טקסט, מצב) אחד לכל הקבוצה — עריכה
  // מכל משבצת בה עוברת לכולן. המיקום (משבצת, קמפיין) נשאר של כל אחת.
  let downgraded = [];
  if (['title', 'kind', 'body', 'status'].some((k) => b[k] !== undefined) || slotMeta != null) {
    ({ downgraded } = await syncFrom(c.id, {
      statusChanged: ['ready', 'draft'].includes(b.status) && b.status !== statusBefore,
    }));
  }
  // משבצת: הגרסה היחידה שלה — לנעילה האופטימית של השמירה הבאה מאותו טופס
  const variant = c.slot_channel_id
    ? await one('select * from content_variants where content_id = $1 and channel_id = $2',
      [c.id, c.slot_channel_id])
    : null;
  const engine = await fillFor(c, b.week);
  res.json({ content: c, variant, warn, downgraded, engine });
}));

/**
 * קישור משבצת למשבצת של מדיה אחרת באותו קמפיין כללי — מכאן הן חולקות תוכן
 * אחד (טקסט וקבצים), וכל אחת מתוזמנת לפי המדיה שלה. ראו src/links.js.
 * {target_campaign_slot: {channel_id, sort_order}} או {target_content_id};
 * יעד עם תוכן דורש replace: true (אחרת 409 עם needs_confirm).
 */
r.post('/content/:id/link', requirePerm('content'), wrap(async (req, res) => {
  // קישור למשבצת שכבר משובצת: הפוסטים שלה נשארים במועדים שלהם ומעכשיו יוצאים
  // עם התוכן של המקור — ואם אחד מהם באותו יום כמו פוסט של הקבוצה, "לא באותו
  // יום" (links_apart) נשבר בלי התראה. לכן בקמפיין שהכלל דולק בו — נעילת
  // המנוע לפני כל כתיבה, ואחרי הקישור הפוסטים של העוקבת נבדקים מחדש מול
  // הכלל הזה בלבד (משבצת חדשה / ריקה — אין מה לבדוק; המילוי משבץ לפי הכלל)
  const scope = await one(
    `select ca.id, ca.links_apart from content_items ci join campaigns ca on ca.id = ci.campaign_id
      where ci.id = $1`, [Number(req.params.id) || 0]);
  const apart = !!scope && scope.links_apart !== false;
  if (apart && !(await lockEngineOr503(res))) return;
  let out;
  try { out = await linkSlots(req.params.id, req.body ?? {}); } catch (e) { return linkFail(res, e); }
  const shift = apart
    ? await revalidateCampaignPosts(scope.id, { rules: { linksApart: true }, contentIds: [out.follower.id] })
    : null;
  const engine = await fillFor(out.source, req.body?.week);
  res.json({ content: out.source, follower: out.follower, downgraded: out.downgraded, shift, engine });
}));

/**
 * קישור עמודות בקמפיין כללי: {rules: [{from, to}], links_apart?, dry_run}. links_apart — פוסטים
 * מקושרים לא יוצאים באותו יום (נאכף במנוע). dry_run מחזיר כמה
 * פוסטים קיימים יועתקו (להצגה לפני אישור); בלעדיו — החוקים נשמרים והפוסטים
 * הקיימים בעמודות המקור של קישור חדש מועתקים עכשיו. הסרת חוק עוצרת העתקה של פוסטים חדשים
 * ומנתקת את הפוסטים שמקושרים בין שתי העמודות (dry_run מחזיר גם unlinks).
 */
r.post('/campaigns/:id/link-rules', requirePerm('content'), wrap(async (req, res) => {
  const c = await one(
    'select id, structure, link_rules, links_apart from campaigns where id = $1 for update',
    [req.params.id]);
  if (!c) return bad(res, 'לא נמצא קמפיין כזה', 404);
  if (c.structure !== 'general') return bad(res, 'קישור עמודות זמין רק בקמפיין כללי');
  const channels = await rows(
    `select ch.id, ch.name, ch.platform from campaign_channels cc
       join channels ch on ch.id = cc.channel_id where cc.campaign_id = $1`, [c.id]);
  const rules = req.body?.rules;
  const err = linkRulesError(rules, channels);
  if (err) return bad(res, err);
  const clean = normalizeLinkRules(rules);
  // רק קישור חדש מעתיק את מה שכבר קיים. קישור שכבר היה — שמירה חוזרת לא
  // מעתיקה שוב פוסט שהמשתמש ניתק או שהעותק שלו נמחק
  const key = (x) => `${Number(x.from)}>${Number(x.to)}`;
  const had = new Set((c.link_rules ?? []).map(key));
  const plan = await linkRulesPlan(c.id, clean.filter((x) => !had.has(key(x))));
  // קישור עמודות שהוסר — גם הפוסטים שמקושרים בין שתי העמודות מתנתקים (כל
  // אחד נשאר עם עותק משלו), כדי שסימן הקישור לא יישאר בלי קישור
  const now = new Set(clean.map(key));
  const removed = normalizeLinkRules((c.link_rules ?? []).filter((x) => !now.has(key(x))));
  const followers = await linkedBetween(c.id, removed);
  if (req.body?.dry_run) return res.json({ copies: plan.length, unlinks: followers.length });

  const apart = typeof req.body?.links_apart === 'boolean' ? req.body.links_apart : null;
  // "לא באותו יום" נדלק: פוסטים מקושרים שכבר משובצים באותו יום נבדקים מחדש
  // (revalidateCampaignPosts) — נעילת המנוע לפני כל כתיבה, כמו בעריכת קמפיין
  const tighten = apart === true && c.links_apart === false;
  if (tighten && !(await lockEngineOr503(res))) return;
  await query(
    `update campaigns set link_rules = $2::jsonb, links_apart = coalesce($3, links_apart)
      where id = $1`, [c.id, JSON.stringify(clean), apart]);
  let unlinked = 0;
  for (const id of followers) {
    try { await unlink(id); unlinked += 1; } catch (e) { if (!(e instanceof LinkError)) throw e; }
  }
  const out = await applyLinkPlan(plan);
  // מה שירד מהלוח משובץ מחדש על כל התקופה של הקמפיין, לא רק בשבוע שמוצג
  const shift = tighten ? await revalidateCampaignPosts(c.id, { rules: { linksApart: true } }) : null;
  const engine = shift?.rescheduled
    ? await autoFillCampaign(c.id, req.body?.week)
    : await autoFill(req.body?.week);
  res.json({ rules: clean, ...out, unlinked, shift, engine });
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

/** תוכן בקמפיין — כל התקופה של הקמפיין (autoFillCampaign); שוטף — השבוע שמוצג */
const fillFor = (item, week) =>
  (item?.campaign_id ? autoFillCampaign(item.campaign_id, week) : autoFill(week));

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

/**
 * "העתק מ־" עם "כולל קבצים" בחלון המשבצת (סעיף 18): הקבצים של פוסט אחר
 * באותו קמפיין מועתקים לפוסט הזה — עותקים עצמאיים (copyAssetsTo, כמו
 * בניתוק), לא קישור. מקור מקושר — הקבצים של המקור שלו; יעד מקושר — נרשמים
 * על המקור של היעד (mediaOwner), ומשם כל הקבוצה רואה אותם.
 */
r.post('/content/:id/copy-assets', requirePerm('content'), wrap(async (req, res) => {
  const fromId = Number(req.body?.from);
  if (!Number.isInteger(fromId) || fromId <= 0) return bad(res, 'צריך לבחור מאיפה להעתיק');
  const owner = await mediaOwner(req.params.id);
  if (!owner) return bad(res, 'לא נמצא תוכן כזה', 404);
  // בזו אחר זו — client אחד לבקשה
  const item = (id) => one('select id, campaign_id, linked_to_id from content_items where id = $1', [id]);
  const to = await item(req.params.id);
  const from = await item(fromId);
  if (!from) return bad(res, 'לא נמצא התוכן להעתקה', 404);
  if (!to.campaign_id || from.campaign_id !== to.campaign_id) {
    return bad(res, 'מעתיקים קבצים רק מפוסט באותו קמפיין');
  }
  // רק קמפיין כללי: בזוויות הקבצים של כל הגרסאות היו הופכים למשותפים ביעד
  const camp = await one('select structure from campaigns where id = $1', [to.campaign_id]);
  if (camp?.structure !== 'general') return bad(res, 'העתקת קבצים — רק בקמפיין כללי');
  const source = assetOwnerId(from);
  if (source === owner.contentId) return bad(res, 'הקבצים כבר משותפים לשני הפוסטים (מקושרים)');
  let copied;
  try { copied = await copyAssetsTo(source, owner.contentId); } catch (e) { return linkFail(res, e); }
  res.json({ copied, warns: await readyWarns(owner.contentId) });
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
  const asset = await one('select content_id from content_assets where id = $1', [req.params.id]);
  await query(
    `with gone as (delete from content_assets where id = $1 returning storage_key)
     insert into media_trash (bucket, storage_key, delete_after)
     select $2, storage_key, now() + make_interval(days => $3)
       from gone where storage_key is not null
     on conflict (bucket, storage_key) do nothing`,
    [req.params.id, process.env.R2_PUBLIC_BUCKET ?? '', TRASH_DAYS]
  );
  // גרסה "מוכן" שאיבדה את המדיה שלה — התא מתעדכן ל"מוכן ⚠" בלי טעינה מחדש
  res.json({ ok: true, warns: asset ? await readyWarns(asset.content_id) : [] });
}));

/**
 * הגרסאות "מוכן" של פריט (ושל העוקבות שלו — הקבצים של המקור הם שלהן) ומה
 * חסר בכל אחת לפי כללי הפרסום. [{content_id, channel_id, warn|null}]
 */
async function readyWarns(contentId) {
  const ready = await rows(
    `select v.content_id, v.channel_id, v.body, v.meta, ch.platform
       from content_variants v
       join content_items ci on ci.id = v.content_id
       join channels ch on ch.id = v.channel_id
      where (ci.id = $1 or ci.linked_to_id = $1) and v.status = 'ready'`, [contentId]);
  const out = [];
  for (const v of ready) {
    const assets = await rows(itemAssetsSql('a.id, a.mime'), [v.content_id, v.channel_id]);
    out.push({ content_id: v.content_id, channel_id: v.channel_id,
               warn: contentBlocker({ platform: v.platform, variant: v, assets }) });
  }
  return out;
}

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
    return bad(res, 'בקמפיין כללי ההעלאה המרוכזת היא לערוץ אחד מהערוצים של הקמפיין');
  }

  // אותו חשבון בדיוק כמו המסך (campaignsWithHealth) — כולל הנתח שנגזר
  // מהקמפיינים החופפים והמרווח של המנוע — כדי שהקבצים ימלאו את המשבצות
  // שהמשתמש רואה
  const concurrent = await rows(CAMPAIGNS_WEIGHTED_SQL);
  const gapDays = await loadGapDays();
  // קמפיין שסומן מוכן: אין משבצות ריקות — הקבצים נכנסים בסוף ומגדילים אותו
  const need = campaign.content_complete_at
    ? null : channelNeeds(campaign, myChannels, concurrent, { gapDays }).get(channelId) ?? null;

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

  // קישור עמודות: כל פוסט שנוצר מועתק לעמודות היעד, לפי הסדר
  let copied = 0;
  for (const c of created) copied += (await autoLinkNew(c.id)).linked;

  res.status(201).json({
    created,
    copied,
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
    res.json(await analyzeImport(req.params.id, req.body?.text,
      { markReady: req.body?.mark_ready === true }));
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
  // נעילת הקמפיין (כמו בהעלאה המרוכזת): המקומות הפנויים נקבעים מול מצב יציב
  await one('select id from campaigns where id = $1 for update', [req.params.id]);
  let out;
  try {
    out = await runImport(req.params.id, req.body?.text,
      { markReady: req.body?.mark_ready === true });
  } catch (e) {
    return bad(res, e.message);
  }
  // כמו כל שינוי בתוכן: המנוע משבץ ממה שנכנס, והתשובה אומרת מה (עם "בטל")
  const engine = await autoFillCampaign(req.params.id, req.body?.week);
  res.status(201).json({ ...out, engine });
}));

/** "בטל ייבוא": הפריטים של המנה שלא נערכו מאז נמחקים (src/import.js) */
r.delete('/campaigns/:id/import/:batch', requirePerm('content'), wrap(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.batch)) return bad(res, 'מזהה ייבוא לא תקין');
  res.json(await undoImport(req.params.id, req.params.batch));
}));

export default r;
