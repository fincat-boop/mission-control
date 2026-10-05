import { Router } from 'express';
import { requirePerm } from '../auth.js';
import { autoFill, bad, parseIdList, titleFromFilename, updateById, upload, wrap } from './_shared.js';
import { currentOrg, one, query, rows, tx } from '../db.js';
import {
  MAX_MEDIA_BYTES, TRASH_DAYS, assetView, headMime, isOwnKey, mediaReady, mediaStore, mediaUrl,
  newMediaKey,
  validateSignRequest, verifyUploaded,
} from '../media.js';
import { angleCount, channelNeeds } from '../campaigns.js';
import { analyzeImport, runImport } from '../import.js';
import { assistantReady } from '../assistant.js';
import { extract } from '../extract.js';
import { analyzeDocument } from '../analyze.js';

const r = Router();

/* ========================= גרסאות לפי מדיה ========================= */

/** יצירה או עדכון של הגרסה של זווית מסוימת במדיה מסוימת */
r.put('/content/:id/variants/:channelId', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const status = ['draft', 'ready', 'not_relevant'].includes(b.status) ? b.status : 'draft';

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
  const engine = await autoFill(b.week);
  res.json({ variant: v, engine });
}));

r.delete('/content/:id/variants/:channelId', requirePerm('content'), wrap(async (req, res) => {
  await query('delete from content_variants where content_id = $1 and channel_id = $2',
    [req.params.id, req.params.channelId]);
  const engine = await autoFill(req.body?.week);
  res.json({ ok: true, engine });
}));

/**
 * השהיה והפעלה מחדש.
 * לא נמחק כלום: השיבוצים נשארים במסד ופשוט מסוננים מהלוח וממנוע השיבוץ,
 * כך שהפעלה מחדש מחזירה את התמונה בדיוק כפי שהייתה.
 */
r.post('/campaigns/:id/pause', requirePerm('settings'), wrap(async (req, res) => {
  const c = await one(
    'update campaigns set paused_at = now() where id = $1 returning *', [req.params.id]);
  if (!c) return bad(res, 'לא נמצא קמפיין כזה', 404);

  const held = await one(
    `select count(*)::int as n from posts p join content_items ci on ci.id = p.content_id
      where ci.campaign_id = $1 and p.status in ('scheduled','approved','failed','pending_approval','hole')
        and p.scheduled_at >= now()`,
    [c.id]
  );
  const engine = await autoFill(req.body?.week);
  res.json({ campaign: c, held: held.n, engine });
}));

r.post('/campaigns/:id/resume', requirePerm('settings'), wrap(async (req, res) => {
  const c = await one(
    'update campaigns set paused_at = null where id = $1 returning *', [req.params.id]);
  if (!c) return bad(res, 'לא נמצא קמפיין כזה', 404);

  // המשבצות הישנות קפאו בזמן ההשהיה — בינתיים המנוע כבר יכול היה למלא
  // את אותו יום/ערוץ עם משהו אחר. במקום להחזיר אוטומטית לאותו מקום
  // (וליצור התנגשות), מנקים את מה שעוד לא יצא לאוויר והמנוע ממקם מחדש.
  const cleared = await rows(
    `delete from posts p using content_items ci
      where ci.id = p.content_id and ci.campaign_id = $1
        and p.status in ('scheduled','approved','failed','pending_approval','hole')
        and p.scheduled_at >= now()
      returning p.id`,
    [c.id]
  );

  const engine = await autoFill(req.body?.week);
  res.json({ campaign: c, cleared: cleared.length, engine });
}));

/** סידור מחדש של התוכן בתוך קמפיין */
r.patch('/campaigns/:id/order', requirePerm('content'), wrap(async (req, res) => {
  const ids = req.body?.content_ids;
  if (!Array.isArray(ids)) return bad(res, 'צריך רשימת מזהי תוכן');
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
      assets: assets.filter((a) => a.content_id === x.id).map(assetView),
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
  // משבצת מפורשת מנצחת (מילוי משבצת מהציר). בלעדיה — סוף התור.
  let nextOrder = 0;
  if (b.campaign_id) {
    if (b.sort_order != null) {
      const taken = await one(
        'select 1 from content_items where campaign_id = $1 and sort_order = $2',
        [b.campaign_id, b.sort_order]
      );
      if (taken) return bad(res, 'המשבצת הזו כבר תפוסה');
      nextOrder = Number(b.sort_order);
    } else {
      nextOrder = (await one(
        'select coalesce(max(sort_order),0) + 1 as n from content_items where campaign_id = $1',
        [b.campaign_id]
      ))?.n ?? 1;
    }
  }

  // ready_channel_ids חייב המרת טיפוס מפורשת: בלעדיה Postgres מפרש
  // את ברירת המחדל '{}' כטקסט ונופל על אי-התאמה ל-integer[]
  const c = await one(
    `insert into content_items (endpoint_id, campaign_id, kind, title, body,
                                ready_channel_ids, sort_order, evergreen, reuse_after_days)
     values ($1,$2,$3,$4,coalesce($5,''),coalesce($6::int[],'{}'::int[]),$7,
             coalesce($8,false),$9) returning *`,
    [b.endpoint_id, b.campaign_id ?? null, b.kind, b.title, b.body ?? null,
     b.ready_channel_ids ?? null, nextOrder, b.evergreen ?? null, b.reuse_after_days ?? null]
  );

  // זווית חדשה נפתחת עם גרסת טיוטה לכל מדיה שביקשו — הניסוח נכתב לכל אחת בנפרד
  const channelIds = parseIdList(b.channel_ids ?? b.ready_channel_ids);
  if (channelIds.length) {
    await tx(async (client) => {
      for (const channelId of channelIds) {
        await client.query(
          `insert into content_variants (content_id, channel_id, body, status)
           values ($1,$2,coalesce($3,''),$4) on conflict do nothing`,
          [c.id, channelId, b.body ?? null, b.body ? 'ready' : 'draft']
        );
      }
    });
  }
  const engine = await autoFill(b.week);
  res.status(201).json({ content: c, engine });
}));

r.patch('/content/:id', requirePerm('content'), wrap(async (req, res) => {
  const b = { ...req.body };
  // מעבר לקמפיין אחר גורר איתו את נקודת הקצה שלו
  if (b.campaign_id) {
    const owner = await one('select endpoint_id from campaigns where id = $1', [b.campaign_id]);
    if (owner) b.endpoint_id = owner.endpoint_id;
  }
  const c = await updateById('content_items', CONTENT_FIELDS, req.params.id, b);
  if (!c) return bad(res, 'לא נמצא תוכן כזה', 404);
  const engine = await autoFill(b.week);
  res.json({ content: c, engine });
}));

/** נקודת הקצה של תוכן: מהקמפיין אם יש, אחרת מה שנשלח במפורש */
async function resolveEndpoint(b) {
  if (b.campaign_id) {
    const c = await one('select endpoint_id from campaigns where id = $1', [b.campaign_id]);
    if (c) return c.endpoint_id;
  }
  return b.endpoint_id ?? null;
}

r.delete('/content/:id', requirePerm('content'), wrap(async (req, res) => {
  await query('delete from content_items where id = $1', [req.params.id]);
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
    const item = await one('select id from content_items where id = $1', [req.params.id]);
    if (!item) return bad(res, 'לא נמצא תוכן כזה', 404);
    res.status(201).json({ assets: await saveAssets(req.files, item.id, null) });
  }));

/** קבצים ששייכים לגרסה של מדיה אחת — הריל, התמונה המרובעת וכדומה */
r.post('/content/:id/variants/:channelId/assets', requirePerm('content'),
  upload.array('files'), wrap(async (req, res) => {
    const v = await ensureVariant(req.params.id, req.params.channelId);
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

  const key = newMediaKey(currentOrg(), b.filename);
  res.json({ key, url: mediaStore.presignPut(key), method: 'PUT' });
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

  const checked = await checkUploadedKey(key);
  if (checked.error) return bad(res, checked.error, checked.status);

  const variantId = channelId != null ? (await ensureVariant(item.id, channelId)).id : null;
  const asset = await insertR2Asset({ query }, {
    contentId: item.id, variantId, key, filename, head: checked.head,
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
  const campaign = await one('select * from campaigns where id = $1', [req.params.id]);
  if (!campaign) return bad(res, 'לא נמצא קמפיין כזה', 404);
  if (!files?.length) return bad(res, 'לא הגיעו קבצים');

  const kind = ['promo', 'value', 'hybrid'].includes(req.body?.kind)
    ? req.body.kind : 'value';
  const channelIds = parseIdList(req.body?.ready_channel_ids);

  const existing = await rows(
    'select sort_order from content_items where campaign_id = $1', [campaign.id]
  );
  const taken = new Set(existing.map((x) => x.sort_order));

  const myChannels = await rows(
    `select ch.* from campaign_channels cc join channels ch on ch.id = cc.channel_id
      where cc.campaign_id = $1 order by ch.sort_order, ch.id`,
    [campaign.id]
  );
  // כמה זוויות הקמפיין צריך — נגזר מהקצב של המדיות ומהנתח שלו
  const required = angleCount(campaign, channelNeeds(campaign, myChannels));

  // המשבצות הריקות, לפי הסדר. אם נגמרו — ממשיכים אחרי המשבצת האחרונה.
  const freeSlots = [];
  for (let i = 1; required !== null && i <= required; i += 1) {
    if (!taken.has(i)) freeSlots.push(i);
  }
  let overflowFrom = Math.max(0, ...existing.map((x) => x.sort_order), required ?? 0);

  const created = [];
  await tx(async (client) => {
    for (const [i, f] of files.entries()) {
      const slot = freeSlots.shift() ?? (overflowFrom += 1);
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
  });

  res.status(201).json({
    created,
    filled_slots: created.filter((c) => required === null || c.slot <= required).length,
    overflow: created.filter((c) => required !== null && c.slot > required).length,
  });
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
  res.json({ key, url: mediaStore.presignPut(key), method: 'PUT' });
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
  try {
    res.status(201).json(await runImport(req.params.id, req.body?.text));
  } catch (e) {
    return bad(res, e.message);
  }
}));

export default r;
