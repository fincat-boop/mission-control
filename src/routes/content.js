import { Router } from 'express';
import { requirePerm } from '../auth.js';
import { autoFill, bad, parseIdList, titleFromFilename, updateById, upload, wrap } from './_shared.js';
import { one, query, rows, tx } from '../db.js';
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

  const v = await one(
    `insert into content_variants (content_id, channel_id, body, status)
     values ($1,$2,coalesce($3,''),$4)
     on conflict (content_id, channel_id)
       do update set body = coalesce($3, content_variants.body), status = $4
     returning *`,
    [req.params.id, req.params.channelId, b.body ?? null, status]
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
      where ci.campaign_id = $1 and p.status in ('scheduled','pending_approval','hole')
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
        and p.status in ('scheduled','pending_approval','hole')
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
    rows('select id, content_id, variant_id, filename, mime, size_bytes from content_assets order by id'),
  ]);

  res.json({
    content: items.map((x) => ({
      ...x,
      variants: variants.filter((v) => v.content_id === x.id),
      assets: assets.filter((a) => a.content_id === x.id),
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
    const v = await one(
      `insert into content_variants (content_id, channel_id)
       values ($1,$2) on conflict (content_id, channel_id) do update set content_id = $1
       returning *`,
      [req.params.id, req.params.channelId]
    );
    res.status(201).json({ assets: await saveAssets(req.files, v.content_id, v.id) });
  }));

async function saveAssets(files, contentId, variantId) {
  if (!files?.length) throw new Error('לא הגיעו קבצים');
  const saved = [];
  for (const f of files) {
    saved.push(await one(
      `insert into content_assets (content_id, variant_id, filename, mime, size_bytes, data)
       values ($1,$2,$3,$4,$5,$6)
       returning id, content_id, variant_id, filename, mime, size_bytes`,
      [contentId, variantId, f.originalname, f.mimetype, f.size, f.buffer]
    ));
  }
  return saved;
}

/** הגשת הקובץ עצמו. מאחורי אותה בדיקת התחברות כמו כל השאר. */
r.get('/assets/:id', wrap(async (req, res) => {
  const a = await one(
    'select filename, mime, data from content_assets where id = $1', [req.params.id]
  );
  if (!a) return bad(res, 'לא נמצא קובץ כזה', 404);
  res.setHeader('Content-Type', a.mime);
  // inline כדי שתמונות ייפתחו בתצוגה מקדימה ולא ירדו כקובץ
  res.setHeader('Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.send(a.data);
}));

r.delete('/assets/:id', requirePerm('content'), wrap(async (req, res) => {
  await query('delete from content_assets where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/**
 * העלאה מרוכזת: כל קובץ הופך לפריט תוכן, והפריטים מתפזרים
 * למשבצות הריקות של הקמפיין לפי הסדר.
 */
r.post('/campaigns/:id/bulk', requirePerm('content'), upload.array('files'),
  wrap(async (req, res) => {
    const campaign = await one('select * from campaigns where id = $1', [req.params.id]);
    if (!campaign) return bad(res, 'לא נמצא קמפיין כזה', 404);
    if (!req.files?.length) return bad(res, 'לא הגיעו קבצים');

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
      for (const f of req.files) {
        const slot = freeSlots.shift() ?? (overflowFrom += 1);
        const item = (await client.query(
          `insert into content_items (endpoint_id, campaign_id, kind, title,
                                      ready_channel_ids, sort_order)
           values ($1,$2,$3,$4,$5::int[],$6) returning *`,
          [campaign.endpoint_id, campaign.id, kind, titleFromFilename(f.originalname),
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

        await client.query(
          `insert into content_assets (content_id, filename, mime, size_bytes, data)
           values ($1,$2,$3,$4,$5)`,
          [item.id, f.originalname, f.mimetype, f.size, f.buffer]
        );
        created.push({ id: item.id, title: item.title, slot });
      }
    });

    res.status(201).json({
      created,
      filled_slots: created.filter((c) => required === null || c.slot <= required).length,
      overflow: created.filter((c) => required !== null && c.slot > required).length,
    });
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
