import { Router } from 'express';
import multer from 'multer';
import { one, query, rows, tx } from '../db.js';
import { buildAlerts } from '../alerts.js';
import { angleCount, campaignsWithHealth, channelNeeds, currentAllocation, shareTimeline } from '../campaigns.js';
import {
  PUBLIC_USER_COLS, checkPassword, clearSession, hashPassword,
  issueSession, requireAuth, requirePerm,
} from '../auth.js';
import { buildBoard, weekMeta, ymd } from '../board.js';
import { planWeek } from '../engine.js';
import { planUrgent } from '../urgent.js';
import { assistantReady, chat, execute, takeProposal } from '../assistant.js';
import { buildStats, readActivity } from '../stats.js';
import { gapWarning } from '../gap.js';
import { analyzeImport, runImport } from '../import.js';

const r = Router();

/** עוטף handler אסינכרוני כך ששגיאה תגיע ל-error handler במקום להפיל את התהליך */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// הקבצים נשמרים במסד, לכן הם עוברים דרך הזיכרון ולא נכתבים לדיסק.
// 50MB מכסה ריל או סרטון קצר. ה-volume של Postgres הוא 500MB בסך הכול,
// ולכן יש התראת אחסון ב-alerts.js שמתריעה לפני שנגמר המקום.
const MAX_FILE_MB = 50;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 },
});

/** שם קובץ בלי הסיומת — משמש ככותרת ברירת מחדל בהעלאה מרוכזת */
const titleFromFilename = (name) =>
  name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || name;

/* ========================= התחברות ========================= */

r.post('/auth/login', wrap(async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) return bad(res, 'צריך אימייל וסיסמה');

  const user = await one('select * from users where lower(email) = $1', [email]);
  if (!user || !(await checkPassword(password, user.password_hash))) {
    return bad(res, 'אימייל או סיסמה לא נכונים', 401);
  }
  issueSession(res, user);
  const { password_hash, ...safe } = user;
  res.json({ user: safe });
}));

r.post('/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

r.get('/me', (req, res) => res.json({ user: req.user }));

// מכאן והלאה — הכול דורש התחברות
r.use(requireAuth);

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
  // שיבוץ צמוד מדי לפוסט קיים של אותה נקודה — מזהיר, לא חוסם
  const gap = await gapWarning({
    endpointId: b.endpoint_id, channelId: b.channel_id, when: b.scheduled_at,
  });
  if (gap && !b.confirm_gap) {
    return res.status(409).json({ error: gap.message, warning: gap, needs_confirm: true });
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

const POST_FIELDS = ['channel_id', 'endpoint_id', 'content_id', 'title', 'kind',
                     'scheduled_at', 'status', 'assignee_id', 'urgent', 'note'];

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

    const gap = await gapWarning({
      endpointId: endpoint, channelId: channel, when, excludePostId: current.id,
    });
    if (gap && !b.confirm_gap) {
      return res.status(409).json({ error: gap.message, warning: gap, needs_confirm: true });
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
    `select p.*, c.name as channel_name, e.name as endpoint_name,
            u.name as assignee_name, ci.title as content_title, ci.kind as content_kind,
            ci.evergreen, ca.name as campaign_name
       from posts p
       left join channels c       on c.id = p.channel_id
       left join endpoints e      on e.id = p.endpoint_id
       left join users u          on u.id = p.assignee_id
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.id = $1`,
    [req.params.id]
  );
  if (!p) return bad(res, 'לא נמצא שיבוץ כזה', 404);

  const variant = p.content_id
    ? await one('select * from content_variants where content_id = $1 and channel_id = $2',
                [p.content_id, p.channel_id])
    : null;

  const assets = p.content_id
    ? await rows(
        `select id, filename, mime, size_bytes, variant_id
           from content_assets
          where content_id = $1 and (variant_id is null or variant_id = $2)
          order by variant_id nulls last, id`,
        [p.content_id, variant?.id ?? null])
    : [];

  res.json({ post: p, variant, assets });
}));

r.delete('/posts/:id', requirePerm('content'), wrap(async (req, res) => {
  await query('delete from posts where id = $1', [req.params.id]);
  res.json({ ok: true });
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

/* ========================= מנוע השיבוץ ========================= */

/** תכנון בלבד — לא נכתב כלום */
r.post('/engine/plan', requirePerm('content'), wrap(async (req, res) => {
  res.json(await planWeek(req.body?.week));
}));

/** ביצוע התכנון. מריץ תכנון טרי כדי שלא ייכתב משהו על סמך מצב ישן. */
r.post('/engine/apply', requirePerm('content'), wrap(async (req, res) => {
  const plan = await planWeek(req.body?.week);
  if (plan.placements.length === 0 && plan.holes.length === 0) {
    return bad(res, 'אין מה לשבץ — הלוח מלא או שאין תוכן מוכן');
  }

  const created = [];
  for (const p of plan.placements) {
    created.push(await one(
      `insert into posts (channel_id, endpoint_id, content_id, title, kind,
                          scheduled_at, status, note)
       values ($1,$2,$3,$4,$5,$6,'scheduled',$7) returning *`,
      [p.channel_id, p.endpoint_id, p.content_id, p.title, p.kind, p.scheduled_at, p.reason]
    ));
  }

  const holes = [];
  for (const h of plan.holes) {
    const post = await one(
      `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, status, note)
       values ($1,$2,'מחכה לתוכן',$3,$4,'hole',$5) returning *`,
      [h.channel_id, h.endpoint_id, h.kind, h.scheduled_at, h.reason]
    );
    holes.push(post);
    await query(
      `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on)
       values ($1,$2,'write',$3,$4,true,$5)`,
      [`לכתוב: תוכן ערך על "${h.endpoint_name}" ל${h.channel_name}`,
       `${h.reason} · הלוח מחכה לזה ל${h.day_label}`,
       post.id, h.endpoint_id, h.date]
    );
  }

  res.status(201).json({ placed: created.length, holes: holes.length });
}));

/* ========================= מבצע דחוף ========================= */

/** תצוגה מקדימה: "מה יקרה" — בלי לשמור כלום */
r.post('/urgent/preview', requirePerm('content'), wrap(async (req, res) => {
  res.json(await planUrgent(req.body ?? {}));
}));

/** אישור: משבץ בפועל לפי אותה תוכנית */
r.post('/urgent/commit', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const plan = await planUrgent(b);
  if (plan.errors?.length) return bad(res, plan.errors.join(' · '));
  if (plan.placements.length === 0) return bad(res, 'לא נמצא שטח פנוי לשיבוץ הדחוף');

  const needsApproval = !(req.user.is_owner || req.user.perm_approve);
  const created = [];
  for (const p of plan.placements) {
    const post = await one(
      `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at,
                          status, assignee_id, urgent, note)
       values ($1,$2,$3,'promo',$4,$5,$6,true,$7) returning *`,
      [p.channel_id, b.endpoint_id ?? null, b.title, p.scheduled_at,
       needsApproval ? 'pending_approval' : 'scheduled',
       b.assignee_id ?? req.user.id, p.note ?? null]
    );
    created.push(post);
    if (needsApproval) {
      await query(
        `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent)
         values ($1,$2,'approve',$3,$4,true)`,
        [`לאשר: ${b.title}`, `${p.channel_name} · ${p.day_label} · דורש הרשאת אישור`,
         post.id, b.endpoint_id ?? null]
      );
    }
  }
  res.status(201).json({ posts: created, pending: needsApproval });
}));

/* ========================= נקודות קצה ========================= */

r.get('/endpoints', wrap(async (_req, res) => {
  const list = await rows('select * from endpoints order by importance desc, id');
  const [campaigns, content] = await Promise.all([
    rows('select * from campaigns order by starts_on nulls last, id'),
    rows('select * from content_items order by created_at desc'),
  ]);
  res.json({
    endpoints: list.map((e) => ({
      ...e,
      campaigns: campaigns.filter((c) => c.endpoint_id === e.id),
      content: content.filter((c) => c.endpoint_id === e.id),
    })),
  });
}));

const ENDPOINT_FIELDS = ['name', 'importance', 'min_days_between', 'active', 'sort_order'];

r.post('/endpoints', requirePerm('settings'), wrap(async (req, res) => {
  if (!req.body?.name) return bad(res, 'צריך שם לנקודת הקצה');
  const e = await one(
    `insert into endpoints (name, importance, min_days_between)
     values ($1, coalesce($2,5), coalesce($3,7)) returning *`,
    [req.body.name, req.body.importance ?? null, req.body.min_days_between ?? null]
  );
  res.status(201).json({ endpoint: e });
}));

r.patch('/endpoints/:id', requirePerm('settings'), wrap(async (req, res) => {
  const e = await updateById('endpoints', ENDPOINT_FIELDS, req.params.id, req.body);
  if (!e) return bad(res, 'לא נמצאה נקודת קצה כזו', 404);
  res.json({ endpoint: e });
}));

r.delete('/endpoints/:id', requirePerm('settings'), wrap(async (req, res) => {
  await query('delete from endpoints where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ========================= קמפיינים ========================= */

/** כל הקמפיינים עם מצב מלאות, קצב והתוכן שמשויך אליהם */
r.get('/campaigns', wrap(async (_req, res) => {
  const [campaigns, allocation, milestones] = await Promise.all([
    campaignsWithHealth(),
    currentAllocation(),
    rows(`select m.*, e.name as endpoint_name
            from strategy_milestones m
            left join endpoints e on e.id = m.endpoint_id
           order by m.on_date`),
  ]);
  res.json({ campaigns, allocation, milestones });
}));

const CAMPAIGN_FIELDS = ['name', 'endpoint_id', 'starts_on', 'ends_on', 'share_pct',
                         'importance', 'target_posts', 'goal', 'urgent', 'active'];

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

r.post('/campaigns', requirePerm('settings'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!b.endpoint_id || !b.name) return bad(res, 'צריך נקודת קצה ושם קמפיין');
  if (b.starts_on && b.ends_on && b.starts_on > b.ends_on) {
    return bad(res, 'תאריך הסיום מוקדם מתאריך ההתחלה');
  }
  const c = await one(
    `insert into campaigns (endpoint_id, name, starts_on, ends_on, share_pct,
                            importance, target_posts, goal, urgent)
     values ($1,$2,$3,$4,$5,
             coalesce($6,(select importance from endpoints where id = $1)),
             $7,$8,coalesce($9,false))
     returning *`,
    [b.endpoint_id, b.name, b.starts_on ?? null, b.ends_on ?? null, b.share_pct ?? null,
     b.importance ?? null, b.target_posts ?? null, b.goal ?? null, b.urgent ?? false]
  );
  if (Array.isArray(b.channel_ids)) {
    await tx((client) => setCampaignChannels(client, c.id, b.channel_ids));
  }
  res.status(201).json({ campaign: c });
}));

r.patch('/campaigns/:id', requirePerm('settings'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (b.starts_on && b.ends_on && b.starts_on > b.ends_on) {
    return bad(res, 'תאריך הסיום מוקדם מתאריך ההתחלה');
  }

  const before = await one('select * from campaigns where id = $1', [req.params.id]);
  if (!before) return bad(res, 'לא נמצא קמפיין כזה', 404);

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
            and p.status in ('scheduled','pending_approval','hole')
            and p.scheduled_at >= now()
          returning p.id`,
        [days, c.id]
      );
      movedPosts = moved.length;
    }
  }

  res.json({ campaign: c, moved_posts: movedPosts });
}));

/** מספר ימים בין שני תאריכים, בלי להיתקל במעבר שעון */
function daysBetweenDates(a, b) {
  const p = (s) => String(s).slice(0, 10).split('-').map(Number);
  const [ay, am, ad] = p(a);
  const [by, bm, bd] = p(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

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
  res.json({ variant: v });
}));

r.delete('/content/:id/variants/:channelId', requirePerm('content'), wrap(async (req, res) => {
  await query('delete from content_variants where content_id = $1 and channel_id = $2',
    [req.params.id, req.params.channelId]);
  res.json({ ok: true });
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
  res.json({ campaign: c, held: held.n });
}));

r.post('/campaigns/:id/resume', requirePerm('settings'), wrap(async (req, res) => {
  const c = await one(
    'update campaigns set paused_at = null where id = $1 returning *', [req.params.id]);
  if (!c) return bad(res, 'לא נמצא קמפיין כזה', 404);
  res.json({ campaign: c });
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
  res.json({ ok: true });
}));

r.delete('/campaigns/:id', requirePerm('settings'), wrap(async (req, res) => {
  await query('delete from campaigns where id = $1', [req.params.id]);
  res.json({ ok: true });
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
  res.status(201).json({ content: c });
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
  res.json({ content: c });
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
  res.json({ ok: true });
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

r.post('/campaigns/:id/import', requirePerm('content'), wrap(async (req, res) => {
  try {
    res.status(201).json(await runImport(req.params.id, req.body?.text));
  } catch (e) {
    return bad(res, e.message);
  }
}));

/** מקבל מערך, מחרוזת JSON או רשימה מופרדת בפסיקים */
function parseIdList(v) {
  if (Array.isArray(v)) return v.map(Number).filter(Boolean);
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.map(Number).filter(Boolean);
  } catch { /* לא JSON — ננסה כרשימה מופרדת בפסיקים */ }
  return v.split(',').map(Number).filter(Boolean);
}

/* ========================= ערוצים ========================= */

r.get('/channels', wrap(async (_req, res) => {
  res.json({ channels: await rows('select * from channels order by sort_order, id') });
}));

const CHANNEL_FIELDS = ['name', 'max_per_week', 'target_per_week', 'max_promo_per_week',
                        'max_hybrid_per_week', 'max_value_per_week', 'urgent_reserve_pct',
                        'blocked_days', 'active', 'sort_order'];

r.post('/channels', requirePerm('settings'), wrap(async (req, res) => {
  if (!req.body?.name) return bad(res, 'צריך שם לערוץ');
  const c = await one(
    `insert into channels (name, max_per_week) values ($1, coalesce($2,5)) returning *`,
    [req.body.name, req.body.max_per_week ?? null]
  );
  res.status(201).json({ channel: c });
}));

r.patch('/channels/:id', requirePerm('settings'), wrap(async (req, res) => {
  const c = await updateById('channels', CHANNEL_FIELDS, req.params.id, req.body);
  if (!c) return bad(res, 'לא נמצא ערוץ כזה', 404);
  res.json({ channel: c });
}));

r.delete('/channels/:id', requirePerm('settings'), wrap(async (req, res) => {
  await query('delete from channels where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ========================= אסטרטגיה ========================= */

/**
 * התמונה ברמת נקודות הקצה: איך השטח מתחלק ביניהן לאורך הזמן,
 * וכמה כל אחת קיבלה בפועל.
 */
r.get('/strategy', wrap(async (_req, res) => {
  const [timeline, allocation, milestones, endpoints, campaigns] = await Promise.all([
    shareTimeline(),
    currentAllocation(),
    rows(`select m.*, e.name as endpoint_name from strategy_milestones m
            left join endpoints e on e.id = m.endpoint_id order by m.on_date`),
    rows('select * from endpoints order by importance desc, id'),
    rows(`select c.*, count(ci.id)::int as content_count,
                 count(ci.id) filter (where ci.evergreen)::int as evergreen_count
            from campaigns c
            left join content_items ci on ci.campaign_id = c.id
           group by c.id order by c.starts_on nulls last, c.id`),
  ]);

  // הספירה היא ישירות מול נקודת הקצה ולא דרך הקמפיינים,
  // אחרת התוכן השוטף — שאין לו קמפיין — נופל מהספירה
  const contentStats = await rows(
    `select endpoint_id,
            count(*)::int as content_count,
            count(*) filter (where evergreen)::int as evergreen_count,
            count(*) filter (where campaign_id is null)::int as background_count
       from content_items group by endpoint_id`
  );
  const statsBy = new Map(contentStats.map((s) => [s.endpoint_id, s]));

  const byEndpoint = endpoints.map((e) => {
    const s = statsBy.get(e.id);
    return {
      ...e,
      campaigns: campaigns.filter((c) => c.endpoint_id === e.id),
      content_count: s?.content_count ?? 0,
      evergreen_count: s?.evergreen_count ?? 0,
      background_count: s?.background_count ?? 0,
    };
  });

  res.json({ timeline, allocation, milestones, endpoints: byEndpoint });
}));

/* ========================= התראות ========================= */

/**
 * ההתראות מחושבות בזמן קריאה מהמצב האמיתי, ולא נשמרות בטבלה —
 * ולכן התראה נעלמת מעצמה ברגע שהבעיה נפתרה.
 */
r.get('/alerts', wrap(async (_req, res) => {
  res.json(await buildAlerts());
}));

/* ========================= אבני דרך ========================= */

r.post('/strategy/milestones', requirePerm('settings'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!b.label || !b.on_date) return bad(res, 'צריך שם ותאריך לאבן הדרך');
  const m = await one(
    `insert into strategy_milestones (endpoint_id, label, on_date)
     values ($1,$2,$3) returning *`,
    [b.endpoint_id ?? null, b.label, b.on_date]
  );
  res.status(201).json({ milestone: m });
}));

r.delete('/strategy/milestones/:id', requirePerm('settings'), wrap(async (req, res) => {
  await query('delete from strategy_milestones where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ========================= משימות ========================= */

r.get('/tasks', wrap(async (_req, res) => {
  const all = await rows(
    `select t.*, u.name as assignee_name, e.name as endpoint_name,
            p.title as post_title, p.scheduled_at, c.name as channel_name,
            ci.body as content_body
       from tasks t
       left join users u         on u.id = t.assignee_id
       left join endpoints e     on e.id = t.endpoint_id
       left join posts p         on p.id = t.post_id
       left join channels c      on c.id = p.channel_id
       left join content_items ci on ci.id = p.content_id
      order by t.urgent desc, t.due_on nulls last, t.id`
  );
  const today = ymd(new Date());
  const week = weekMeta(new Date());

  res.json({
    // due_on מגיע כמחרוזת 'YYYY-MM-DD'
    today: all.filter((t) => !t.done && t.due_on === today),
    attention: all.filter((t) => !t.done && t.due_on !== today),
    done_this_week: all.filter(
      (t) => t.done && t.done_at && ymd(new Date(t.done_at)) >= week.start
    ),
    open_count: all.filter((t) => !t.done).length,
  });
}));

r.post('/tasks', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!b.title) return bad(res, 'צריך כותרת למשימה');
  const t = await one(
    `insert into tasks (title, subtitle, kind, post_id, endpoint_id, assignee_id, due_on, urgent)
     values ($1,$2,coalesce($3,'general'),$4,$5,$6,$7,coalesce($8,false)) returning *`,
    [b.title, b.subtitle ?? null, b.kind ?? null, b.post_id ?? null, b.endpoint_id ?? null,
     b.assignee_id ?? null, b.due_on ?? null, b.urgent ?? false]
  );
  res.status(201).json({ task: t });
}));

r.patch('/tasks/:id', requirePerm('content'), wrap(async (req, res) => {
  const body = { ...req.body };
  // סימון "בוצע" מחתים גם את השעה
  if (body.done === true) body.done_at = new Date().toISOString();
  if (body.done === false) body.done_at = null;
  const t = await updateById('tasks',
    ['title', 'subtitle', 'kind', 'assignee_id', 'due_on', 'urgent', 'done', 'done_at'],
    req.params.id, body);
  if (!t) return bad(res, 'לא נמצאה משימה כזו', 404);
  res.json({ task: t });
}));

r.delete('/tasks/:id', requirePerm('content'), wrap(async (req, res) => {
  await query('delete from tasks where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ========================= כללי המנוע ========================= */

r.get('/settings', wrap(async (_req, res) => {
  res.json({ settings: await one('select * from engine_settings where id = 1') });
}));

r.patch('/settings', requirePerm('settings'), wrap(async (req, res) => {
  const s = await updateById('engine_settings',
    ['min_gap_days', 'max_promo_per_day', 'hybrid_weight', 'content_alert_hours',
     'min_value_per_promo'],
    1, req.body);
  res.json({ settings: s });
}));

/* ========================= משתמשים ========================= */

r.get('/users', wrap(async (_req, res) => {
  res.json({ users: await rows(`select ${PUBLIC_USER_COLS} from users order by is_owner desc, id`) });
}));

r.post('/users', requirePerm('users'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!b.name || !email || !b.password) return bad(res, 'צריך שם, אימייל וסיסמה');
  if (String(b.password).length < 8) return bad(res, 'הסיסמה חייבת להיות באורך 8 תווים לפחות');

  const exists = await one('select id from users where lower(email) = $1', [email]);
  if (exists) return bad(res, 'כבר קיים משתמש עם האימייל הזה');

  const u = await one(
    `insert into users (name, email, password_hash, perm_content, perm_settings, perm_approve, perm_users)
     values ($1,$2,$3,coalesce($4,true),coalesce($5,false),coalesce($6,false),coalesce($7,false))
     returning ${PUBLIC_USER_COLS}`,
    [b.name, email, await hashPassword(String(b.password)),
     b.perm_content ?? null, b.perm_settings ?? null, b.perm_approve ?? null, b.perm_users ?? null]
  );
  res.status(201).json({ user: u });
}));

r.patch('/users/:id', requirePerm('users'), wrap(async (req, res) => {
  const target = await one('select * from users where id = $1', [req.params.id]);
  if (!target) return bad(res, 'לא נמצא משתמש כזה', 404);
  if (target.is_owner) return bad(res, 'אי אפשר לשנות את הרשאות הבעלים', 403);

  const b = { ...req.body };
  if (b.password) {
    if (String(b.password).length < 8) return bad(res, 'הסיסמה חייבת להיות באורך 8 תווים לפחות');
    await query('update users set password_hash = $1 where id = $2',
      [await hashPassword(String(b.password)), target.id]);
    delete b.password;
  }
  const u = await updateById('users',
    ['name', 'perm_content', 'perm_settings', 'perm_approve', 'perm_users'],
    target.id, b, PUBLIC_USER_COLS);
  res.json({ user: u ?? await one(`select ${PUBLIC_USER_COLS} from users where id = $1`, [target.id]) });
}));

r.delete('/users/:id', requirePerm('users'), wrap(async (req, res) => {
  const target = await one('select is_owner from users where id = $1', [req.params.id]);
  if (target?.is_owner) return bad(res, 'אי אפשר למחוק את הבעלים', 403);
  if (Number(req.params.id) === req.user.id) return bad(res, 'אי אפשר למחוק את עצמך');
  await query('delete from users where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ========================= נתונים ויומן ========================= */

/**
 * סטטיסטיקה לתקופה. בלי from/to — 30 הימים האחרונים.
 * הכול נספר בזמן הקריאה, ולכן תמיד מעודכן.
 */
r.get('/stats', wrap(async (req, res) => {
  try {
    res.json(await buildStats(req.query.from, req.query.to));
  } catch (e) {
    return bad(res, e.message);
  }
}));

/** מי עשה מה. פתוח לכל מי שמחובר — שקיפות, לא סוד. */
r.get('/activity', wrap(async (req, res) => {
  try {
    res.json(await readActivity({
      from: req.query.from, to: req.query.to,
      user_id: req.query.user_id, via: req.query.via,
      entity: req.query.entity, limit: req.query.limit,
    }));
  } catch (e) {
    return bad(res, e.message);
  }
}));

/* ========================= העוזר ========================= */

r.get('/assistant/status', (_req, res) => res.json({ ready: assistantReady() }));

/**
 * שיחה. ההיסטוריה נשמרת אצל הלקוח ונשלחת בכל פנייה — השרת חסר מצב.
 * כלי כתיבה לא מבצעים כלום: הם מחזירים הצעות שממתינות לאישור.
 */
r.post('/assistant/chat', wrap(async (req, res) => {
  const message = String(req.body?.message ?? '').trim();
  if (!message) return bad(res, 'צריך לכתוב משהו');
  if (!assistantReady()) return bad(res, 'העוזר לא מחובר — חסר מפתח API בהגדרות השרת', 503);

  try {
    res.json(await chat(req.user, req.body?.messages ?? [], message));
  } catch (e) {
    // שגיאת ספק (מפתח לא תקין, מכסה) — הודעה מובנת במקום "משהו נשבר"
    return bad(res, `העוזר לא זמין כרגע: ${e.message}`, 502);
  }
}));

/** ביצוע הצעה שהמשתמש אישר. עוברת דרך אותו נתיב API כמו פעולה ידנית. */
r.post('/assistant/confirm', wrap(async (req, res) => {
  const proposal = takeProposal(String(req.body?.proposal_id ?? ''), req.user.id);
  if (!proposal) return bad(res, 'ההצעה כבר בוצעה או פגה — בקש מהעוזר להציע שוב', 410);

  const result = await execute(proposal, req.headers.cookie);
  res.json({ ok: true, summary: proposal.summary, result });
}));

/* ========================= עזר ========================= */

/**
 * עדכון חלקי בטוח: רק שדות מהרשימה הלבנה נכנסים ל-SQL,
 * והערכים תמיד עוברים כפרמטרים.
 */
async function updateById(table, allowed, id, body, returning = '*') {
  const entries = Object.entries(body ?? {}).filter(([k]) => allowed.includes(k));
  if (entries.length === 0) {
    return one(`select ${returning} from ${table} where id = $1`, [id]);
  }
  const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const values = entries.map(([, v]) => v);
  return one(
    `update ${table} set ${sets} where id = $1 returning ${returning}`,
    [id, ...values]
  );
}

export default r;
