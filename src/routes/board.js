import { Router } from 'express';
import { bad, updateById, wrap } from './_shared.js';
import { buildBoard } from '../board.js';
import { requirePerm } from '../auth.js';
import { campaignWindowWarning, gapWarning, softWarning } from '../gap.js';
import { one, query, rows } from '../db.js';
import { parseMetric } from '../performance.js';
import { hubMailReady } from '../hub-mail.js';
import { emitPostEvent } from '../publish/runner.js';
import { assetView } from '../media.js';
import { attachToPost, contentCandidates, plannedDate, recordDismissals } from '../engine.js';
import { candidateColumnsSql } from '../candidates.js';
import { itemAssetsSql } from '../links.js';

const r = Router();

/* ========================= הלוח ========================= */

r.get('/board', wrap(async (req, res) => {
  res.json(await buildBoard(req.query.week));
}));

r.post('/posts', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!b.channel_id || !b.scheduled_at || !b.title) {
    return bad(res, 'צריך ערוץ, כותרת ומועד');
  }
  if (!['promo', 'value', 'hybrid'].includes(b.kind)) {
    return bad(res, 'סוג הפוסט חייב להיות promo / value / hybrid');
  }
  // שיבוץ צמוד מדי לפוסט קיים של אותה נקודה, או תוכן של קמפיין מחוץ
  // לחלון שלו — מזהיר, לא חוסם
  const warning = softWarning(
    await gapWarning({ endpointId: b.endpoint_id, channelId: b.channel_id, when: b.scheduled_at }),
    await campaignWindowWarning({ contentId: b.content_id, when: b.scheduled_at }),
  );
  if (warning && !b.confirm_gap) {
    return res.status(409).json({ error: warning.message, warning, needs_confirm: true });
  }

  const post = await one(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind,
                        scheduled_at, status, assignee_id, urgent, note)
     values ($1,$2,$3,$4,$5,$6,coalesce($7,'scheduled'),$8,coalesce($9,false),$10)
     returning *`,
    [b.channel_id, b.endpoint_id ?? null, b.content_id ?? null, b.title, b.kind,
     b.scheduled_at, b.status ?? null, b.assignee_id ?? null, b.urgent ?? false, b.note ?? null]
  );
  res.status(201).json({ post });
}));

/** האם הבקשה מזיזה את הפוסט בפועל (מועד או ערוץ אחר) — לא רק שולחת את הקיים */
export function isMove(current, b) {
  const timeChanged = b.scheduled_at != null &&
    new Date(b.scheduled_at).getTime() !== new Date(current.scheduled_at).getTime();
  const channelChanged = b.channel_id != null && Number(b.channel_id) !== current.channel_id;
  return timeChanged || channelChanged;
}

/**
 * למה אסור להזיז את הפוסט, או null. פוסט שכבר יצא (או בשליחה ברגע זה)
 * הוא עובדה, לא תכנון; ומועד שעבר לא יתפרסם לעולם — הרַנֶר מפרסם רק
 * מה שהגיע זמנו מעכשיו והלאה.
 */
export function moveBlocker(current, when, now = new Date()) {
  if (current.status === 'published') {
    return { status: 409, error: 'אי אפשר להזיז פוסט שכבר פורסם' };
  }
  if (current.status === 'publishing') {
    return { status: 409, error: 'הפוסט נשלח ברגע זה — אי אפשר להזיז אותו' };
  }
  if (new Date(when).getTime() < now.getTime()) {
    return { status: 400, error: 'אי אפשר להזיז פוסט לזמן שעבר' };
  }
  return null;
}

// status לא כאן בכוונה: מעבר סטטוס עובר רק בנתיבים הייעודיים (אישור, פרסום,
// "סמן כפורסם") שבודקים הרשאת approve. אחרת content יכול לקבוע approved.
const POST_FIELDS = ['channel_id', 'endpoint_id', 'content_id', 'title', 'kind',
                     'scheduled_at', 'assignee_id', 'urgent', 'note'];

r.patch('/posts/:id', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const current = await one('select * from posts where id = $1', [req.params.id]);
  if (!current) return bad(res, 'לא נמצא שיבוץ כזה', 404);

  // הזזה על הלוח עוברת את אותו כלל שהמנוע והמבצע הדחוף מכבדים:
  // נקודת קצה אחת, מדיה אחת, יום אחד.
  if (b.scheduled_at || b.channel_id) {
    const when = b.scheduled_at ?? current.scheduled_at;
    const channel = b.channel_id ?? current.channel_id;
    const endpoint = b.endpoint_id ?? current.endpoint_id;

    const moving = isMove(current, b);
    const blocked = moving && moveBlocker(current, when);
    if (blocked) return bad(res, blocked.error, blocked.status);

    if (endpoint) {
      const clash = await one(
        `select p.id, p.title from posts p
          where p.id <> $1 and p.endpoint_id = $2 and p.channel_id = $3
            and p.scheduled_at::date = $4::date`,
        [current.id, endpoint, channel, when]
      );
      if (clash) {
        return bad(res, `כבר יש פוסט לאותה נקודת קצה במדיה הזו באותו יום: ${clash.title}`);
      }
    }

    // יום שהמדיה לא מקבלת בו תוכן
    const target = await one('select name, blocked_days from channels where id = $1', [channel]);
    const dow = new Date(when).getDay();
    if ((target?.blocked_days ?? []).includes(dow)) {
      const names = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
      return bad(res, `${target.name} לא מקבל תוכן בימי ${names[dow]}`);
    }

    // מעבר למדיה אחרת דורש שקיימת לתוכן גרסה למדיה הזו — אחרת היינו
    // מפרסמים שם ניסוח שנכתב למדיה אחרת
    if (b.channel_id && b.channel_id !== current.channel_id && current.content_id) {
      const v = await one(
        'select status from content_variants where content_id = $1 and channel_id = $2',
        [current.content_id, b.channel_id]
      );
      if (!v) {
        const ch = await one('select name from channels where id = $1', [b.channel_id]);
        return bad(res, `אין לתוכן הזה גרסה ל${ch?.name ?? 'מדיה הזו'} — כותבים אותה קודם בתוכן`);
      }
    }

    const warning = softWarning(
      await gapWarning({ endpointId: endpoint, channelId: channel, when, excludePostId: current.id }),
      // רק כשהתאריך באמת זז — שינוי ערוץ באותו יום לא מעורר אותה שוב
      b.scheduled_at
        ? await campaignWindowWarning({ contentId: b.content_id ?? current.content_id, when })
        : null,
    );
    if (warning && !b.confirm_gap) {
      return res.status(409).json({ error: warning.message, warning, needs_confirm: true });
    }
  }

  const post = await updateById('posts', POST_FIELDS, req.params.id, b);
  res.json({ post });
}));

/**
 * מה שאמור לצאת בפועל: הטקסט של המדיה הזו והקבצים שלה.
 * הלוח מציג את זה בלחיצה, במקום טופס עריכה — הפרמטרים נקבעים בתוכן.
 */
r.get('/posts/:id/preview', wrap(async (req, res) => {
  const p = await one(
    `select p.*, c.name as channel_name, c.platform, e.name as endpoint_name,
            u.name as assignee_name, ci.title as content_title, ci.kind as content_kind,
            ci.evergreen, ca.name as campaign_name, au.name as approved_by_name,
            cc.auto_enabled as autopub_enabled,
            cc.access_token_enc is not null as autopub_connected
       from posts p
       left join channels c       on c.id = p.channel_id
       left join channel_connections cc on cc.channel_id = p.channel_id
       left join endpoints e      on e.id = p.endpoint_id
       left join users u          on u.id = p.assignee_id
       left join users au         on au.id = p.approved_by
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.id = $1`,
    [req.params.id]
  );
  if (!p) return bad(res, 'לא נמצא שיבוץ כזה', 404);

  // ערוץ המייל: ה"חיבור" שלו הוא משתני HUB_API_* בשרת, לא channel_connection
  if (p.platform === 'newsletter') {
    p.autopub_connected = hubMailReady();
    p.autopub_enabled = hubMailReady();
  }

  const variant = p.content_id
    ? await one('select * from content_variants where content_id = $1 and channel_id = $2',
                [p.content_id, p.channel_id])
    : null;

  // משבצת מקושרת: הקבצים של המקור (itemAssetsSql עוקב אחרי הקישור)
  const assets = p.content_id
    ? await rows(
        itemAssetsSql('a.id, a.filename, a.mime, a.size_bytes, a.variant_id, a.storage_key'),
        [p.content_id, p.channel_id]).then((list) => list.map(assetView))
    : [];

  // התוצאות נשלחות יחד עם התצוגה המקדימה כדי שהדיאלוג לא יצטרך קריאה שנייה
  const results = await one('select * from post_results where post_id = $1', [p.id]);

  res.json({ post: p, variant, assets, results });
}));

/**
 * הזנת התוצאות בפועל. שדה ריק נשמר כ-null ("לא נמדד") ולא כאפס —
 * ההבחנה הזו היא הבסיס לכל חישוב היעילות (ראו src/performance.js).
 */
r.put('/posts/:id/results', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const post = await one('select id from posts where id = $1', [req.params.id]);
  if (!post) return bad(res, 'לא נמצא שיבוץ כזה', 404);

  let vals;
  try {
    vals = [parseMetric(b.reach), parseMetric(b.engagement),
            parseMetric(b.clicks), parseMetric(b.leads)];
  } catch (e) {
    return bad(res, e.message);
  }

  const results = await one(
    `insert into post_results (post_id, reach, engagement, clicks, leads, note)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (post_id) do update set
       reach = excluded.reach, engagement = excluded.engagement,
       clicks = excluded.clicks, leads = excluded.leads,
       note = excluded.note, updated_at = now()
     returning *`,
    [req.params.id, ...vals, b.note?.trim() || null]
  );
  res.json({ results });
}));

r.delete('/posts/:id/results', requirePerm('content'), wrap(async (req, res) => {
  await query('delete from post_results where post_id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/**
 * הסרת פוסט מהלוח. בכוונה בלי מילוי אוטומטי אחריה: מי שמוחק פוסט רוצה
 * מקום פנוי, לא פוסט אחר (לרוב עם אותו תוכן) שקופץ למקומו. התוכן נרשם
 * כוויתור לשבוע הזה בערוץ הזה, כדי שגם מילוי שיופעל משינוי אחר לא יחזיר
 * אותו לשם (engine_dismissals).
 */
r.delete('/posts/:id', requirePerm('content'), wrap(async (req, res) => {
  const post = await one(
    'delete from posts where id = $1 returning id, content_id, channel_id, scheduled_at',
    [req.params.id]
  );
  if (post?.content_id) await recordDismissals([post]);
  res.json({ ok: true });
}));

/**
 * תוכן שאפשר לשייך לפוסט: לפי נקודת קצה (לא חובה), ערוץ (חובה) ותאריך
 * (לחלון הקמפיין). משמש את "שייך תוכן" בחלון הפוסט ואת הוספת פוסט ידנית.
 */
r.get('/posts/candidates', wrap(async (req, res) => {
  const channelId = Number(req.query.channel_id);
  if (!channelId) return bad(res, 'צריך ערוץ');
  const endpointId = Number(req.query.endpoint_id) || null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date : null;
  res.json({ candidates: await contentCandidates({ endpointId, channelId, date }) });
}));

/**
 * שיוך תוכן לפוסט שאין לו תוכן ("חסר תוכן"). אותם כללים כמו המנוע: ניסוח
 * לערוץ הזה, אותה נקודת קצה (תוכן תמיד שייך לנקודה — ראו content_items),
 * קמפיין לא מושהה ותאריך בתוך החלון שלו. משימות "לכתוב"/"החלפה" נסגרות.
 */
r.post('/posts/:id/attach-content', requirePerm('content'), wrap(async (req, res) => {
  const contentId = Number(req.body?.content_id);
  if (!contentId) return bad(res, 'צריך לבחור תוכן');

  const post = await one(
    `select p.*, c.name as channel_name, c.active as channel_active,
            (p.scheduled_at at time zone 'Asia/Jerusalem')::date as local_date
       from posts p join channels c on c.id = p.channel_id
      where p.id = $1`,
    [req.params.id]
  );
  if (!post) return bad(res, 'לא נמצא פוסט כזה', 404);
  if (['published', 'publishing'].includes(post.status)) {
    return bad(res, 'הפוסט כבר יצא לאוויר — אי אפשר לשנות לו תוכן', 409);
  }
  if (post.content_id) return bad(res, 'לפוסט הזה כבר יש תוכן', 409);
  if (new Date(post.scheduled_at) <= new Date()) {
    return bad(res, 'אי אפשר לשייך תוכן לפוסט שהמועד שלו עבר');
  }
  if (!post.channel_active) return bad(res, `הערוץ ${post.channel_name} מושבת`, 409);

  const c = await one(
    `select ci.id, ci.title, ci.kind, ci.endpoint_id, ${candidateColumnsSql()},
            ca.name as campaign_name, ca.paused_at, ca.starts_on, ca.ends_on,
            v.status as variant_status,
            (select active from endpoints where id = ci.endpoint_id) as endpoint_active,
            ci.slot_channel_id is null or exists (
              select 1 from campaign_channels cc
               where cc.campaign_id = ci.campaign_id and cc.channel_id = ci.slot_channel_id
            ) as slot_channel_ok
       from content_items ci
       left join campaigns ca       on ca.id = ci.campaign_id
       left join content_variants v on v.content_id = ci.id and v.channel_id = $2
      where ci.id = $1`,
    [contentId, post.channel_id]
  );
  if (!c) return bad(res, 'לא נמצא תוכן כזה', 404);
  if (!c.variant_status || c.variant_status === 'not_relevant') {
    return bad(res, `אין לתוכן הזה ניסוח ל${post.channel_name} — כותבים אותו קודם בתוכן`);
  }
  // משבצת-מדיה של קמפיין כללי שייכת למדיה אחת — וכשהמדיה הוסרה מהקמפיין
  // היא נשמרת אבל לא משובצת (כמו במנוע, ראו planWeek)
  if (c.slot_channel_id && (c.slot_channel_id !== post.channel_id || !c.slot_channel_ok)) {
    return bad(res, c.slot_channel_id !== post.channel_id
      ? 'התוכן הזה הוא משבצת של ערוץ אחר בקמפיין'
      : `הערוץ ${post.channel_name} הוסר מהקמפיין "${c.campaign_name}" — התוכן שלו לא משובץ`);
  }
  if (!c.endpoint_active) return bad(res, 'נקודת הקצה של התוכן הזה מושבתת', 409);
  if (post.endpoint_id && c.endpoint_id !== post.endpoint_id) {
    return bad(res, 'התוכן שייך לנקודת קצה אחרת מזו של הפוסט');
  }
  if (c.campaign_id) {
    if (c.paused_at) return bad(res, `הקמפיין "${c.campaign_name}" מושהה`, 409);
    const day = post.local_date;
    if ((c.starts_on && c.starts_on > day) || (c.ends_on && c.ends_on < day)) {
      return bad(res, `הפוסט מחוץ לתאריכי הקמפיין "${c.campaign_name}"` +
        ` (${c.starts_on ?? '…'} – ${c.ends_on ?? '…'})`);
    }
    // קמפיין מוכן: הפריט יוצא לא לפני התאריך המתוכנן שלו — כמו במנוע
    const planned = plannedDate(c);
    if (planned && day < planned) {
      return bad(res, `"${c.title}" מתוכנן ל-${planned} בקמפיין "${c.campaign_name}"` +
        ' (קמפיין מוכן) — אי אפשר לשייך אותו לפוסט מוקדם יותר');
    }
  }
  // פוסט בלי נקודת קצה מקבל את של התוכן — ואז חל עליו אותו כלל כמו בהזזה:
  // נקודת קצה אחת, ערוץ אחד, יום אחד.
  if (!post.endpoint_id) {
    const clash = await one(
      `select title from posts
        where id <> $1 and endpoint_id = $2 and channel_id = $3
          and (scheduled_at at time zone 'Asia/Jerusalem')::date = $4::date`,
      [post.id, c.endpoint_id, post.channel_id, post.local_date]
    );
    if (clash) {
      return bad(res, `כבר יש פוסט לאותה נקודת קצה בערוץ הזה באותו יום: ${clash.title}`, 409);
    }
  }

  // פוסט שאושר לפרסום אוטומטי חוזר ל"מתוכנן" — האישור לא היה על התוכן הזה
  const done = await attachToPost(post.id, {
    content_id: c.id, title: c.title, kind: c.kind, endpoint_id: c.endpoint_id,
  });
  if (!done) return bad(res, 'הפוסט השתנה בינתיים — רעננו ונסו שוב', 409);
  res.json({ post: done.post, draft: c.variant_status !== 'ready',
             approval_reset: done.approval_reset });
}));

/** סימון "פורסם" — מעדכן גם את המשימה הצמודה */
r.post('/posts/:id/publish', requirePerm('content'), wrap(async (req, res) => {
  const post = await one(
    `update posts set status = 'published', published_at = now()
      where id = $1 returning *`,
    [req.params.id]
  );
  if (!post) return bad(res, 'לא נמצא שיבוץ כזה', 404);
  await query(
    `update tasks set done = true, done_at = now() where post_id = $1 and done = false`,
    [post.id]
  );
  // אירוע ל-HUB גם על פרסום ידני — אותו id כמו במסלול האוטומטי, לא נרשם פעמיים
  const ch = await one('select name, platform from channels where id = $1', [post.channel_id]);
  await emitPostEvent('post_published', {
    ...post, channel_name: ch?.name, platform: ch?.platform,
  });
  res.json({ post });
}));

/** ביטול "פורסם" — חוזר למתוכנן, למקרה שסימנו בטעות */
r.post('/posts/:id/unpublish', requirePerm('content'), wrap(async (req, res) => {
  const post = await one(
    `update posts set status = 'scheduled', published_at = null
      where id = $1 and status = 'published' returning *`,
    [req.params.id]
  );
  if (!post) return bad(res, 'אין שיבוץ מפורסם עם המזהה הזה', 404);
  res.json({ post });
}));

/** אישור דחוף־דורס — הרשאה נפרדת */
r.post('/posts/:id/approve', requirePerm('approve'), wrap(async (req, res) => {
  const post = await one(
    `update posts set status = 'scheduled' where id = $1 and status = 'pending_approval'
      returning *`,
    [req.params.id]
  );
  if (!post) return bad(res, 'אין שיבוץ שממתין לאישור עם המזהה הזה', 404);
  await query(`update tasks set done = true, done_at = now() where post_id = $1`, [post.id]);
  res.json({ post });
}));

export default r;
