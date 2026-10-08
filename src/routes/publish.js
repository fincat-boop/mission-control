import crypto from 'node:crypto';
import express, { Router } from 'express';
import { bad, wrap } from './_shared.js';
import { one, query, rows } from '../db.js';
import { requirePerm } from '../auth.js';
import { encryptSecret, decryptSecret } from '../publish/crypto.js';
import { verifyConnection } from '../publish/meta.js';
import { AUTOPUBLISH_OFF_ERROR, autopublishOn, loadPayload, maybeOutSql, publishBlocker, publishOne,
         resetPublishing, transferNewsletter } from '../publish/runner.js';
import { HubMailError, audienceLists, hubFillUrl, hubMailReady, hubOrigins,
         newsletterTemplate, newsletterPreview } from '../hub-mail.js';
import { NEWSLETTER_NO_APPROVE, hubStale, hubUnverified } from '../publish/newsletter.js';
import { weekMeta } from '../board.js';
import { friendlyPublishError } from '../publish/errors.js';
import { postIsLiveSql } from '../live.js';
import { approvalDigest } from '../publish/approval.js';

const r = Router();

/* ========================= חיבורי ערוצים ========================= */

/**
 * מצב הפרסום האוטומטי: המתג הגלובלי + החיבור של כל ערוץ.
 * הטוקן לעולם לא חוזר — רק העובדה שהוא קיים.
 */
r.get('/publish/status', wrap(async (_req, res) => {
  const settings = await one('select autopublish_enabled from engine_settings limit 1');
  const connections = await rows(
    `select cc.channel_id, cc.page_id, cc.ig_user_id, cc.auto_enabled,
            cc.access_token_enc is not null as has_token,
            cc.last_check_at, cc.last_check_ok, cc.last_check_note
       from channel_connections cc`);
  // כמה פוסטים יחזרו למתוכנן בכיבוי המתג (resetToManual) — לחלון האישור בניהול.
  // נכשל שאולי כבר יצא (maybeOutSql) לא חוזר, ולכן לא נספר
  const reset = await one(
    `select count(*) filter (where status = 'approved')::int as approved,
            count(*) filter (where status = 'failed' and not ${maybeOutSql('p')})::int as failed
       from posts p where status in ('approved', 'failed')`);
  res.json({
    autopublish_enabled: settings?.autopublish_enabled ?? false,
    hub_mail_ready: hubMailReady(),
    connections,
    manual_reset: reset,
  });
}));

/**
 * רשימות הקהל מה-HUB — לבורר בעריכת גרסת המייל. שגיאת HUB חוזרת עם
 * ההודעה הידידותית שלו (העברית של HubMailError), לא כ"משהו נשבר".
 */
/** שגיאת HUB → תשובה עם ההודעה הידידותית שלו (או הסבר על מפתח שנדחה) */
function hubFail(res, e) {
  // ה-HUB מגביל 30 בקשות לדקה — סירוב קצב הוא "נסה שוב", לא תקלה
  if (e.status === 429) return bad(res, 'ה-HUB עמוס כרגע — נסה שוב בעוד דקה', 429);
  const status = e.status === 401 || e.status === 403 ? 502 : e.status >= 500 ? 502 : e.status;
  const msg = e.status === 401 ? 'ה-HUB דחה את המפתח (HUB_API_KEY) — בדוק שהוא זהה ל-MISSION_CONTROL_API_KEY שם' : e.message;
  return bad(res, msg, status);
}

r.get('/publish/hub-lists', wrap(async (_req, res) => {
  try {
    res.json({ lists: await audienceLists() });
  } catch (e) {
    if (e instanceof HubMailError) return hubFail(res, e);
    throw e;
  }
}));

/**
 * תבנית הניוזלטר שמוגדרת ב-HUB + איפה עורך המייל שלו.
 * null = אין תבנית, הלוח מציג נושא + גוף HTML חופשי.
 * fill_url — עורך המייל של ה-HUB (נפתח בחלון חדש, מחזיר ערכים ב-postMessage);
 * hub_origins — המקורות היחידים שהלוח מקבל מהם את ההודעות של העורך.
 */
r.get('/publish/newsletter-template', wrap(async (_req, res) => {
  try {
    const template = await newsletterTemplate();
    // ה-HTML של התבנית לא נחוץ ללוח (העורך והתצוגה ב-HUB) — רק התיאור
    res.json({
      template: template ? { id: template.id, name: template.name, fields: template.fields ?? [] } : null,
      fill_url: hubFillUrl(),
      hub_origins: hubOrigins(),
    });
  } catch (e) {
    if (e instanceof HubMailError) return hubFail(res, e);
    throw e;
  }
}));

/**
 * מסגרת התצוגה החיה — שני שלבים: POST newsletter-preview מרנדר ב-HUB,
 * שומר את התוצאה במטמון קצר-חיים ומחזיר frame_token; ה-iframe נטען
 * ב-GET newsletter-frame/:token. למה לא srcdoc/טופס-אל-מסגרת: srcdoc
 * יורש את ה-CSP הקשוח של האפליקציה (תמונות נחסמות), ושליחת טופס אל
 * iframe עם sandbox נחסמת בחלק מהדפדפנים. עמוד ה-GET מקבל CSP משלו —
 * תמונות/סגנונות כן, סקריפטים לא. מטמון בזיכרון התהליך — עוד תלות
 * ב-instance יחיד, כמו הטיימרים (מתועד ב-README).
 */
const previewCache = new Map(); // token -> { html, at }
const PREVIEW_TTL_MS = 2 * 60 * 1000;

function stashPreview(html) {
  const now = Date.now();
  for (const [t, e] of previewCache) if (now - e.at > PREVIEW_TTL_MS) previewCache.delete(t);
  const token = crypto.randomUUID();
  previewCache.set(token, { html, at: now });
  return token;
}

r.get('/publish/newsletter-frame/:token', (req, res) => {
  const entry = previewCache.get(req.params.token);
  if (!entry || Date.now() - entry.at > PREVIEW_TTL_MS) {
    return res.status(404).type('html').send('<div style="font:13px sans-serif;direction:rtl;padding:20px">התצוגה פגה — הקלד משהו כדי לרענן.</div>');
  }
  res.set('Content-Security-Policy',
    "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https:; font-src https: data:");
  res.type('html').send(entry.html);
});

/**
 * תצוגה מקדימה — ה-HUB מרנדר את מה שהנמען יראה, והלוח רק מציג את ה-HTML
 * שחוזר. unsafe_vars = משתנים שנשארו בלי ערך, מוצגים כאזהרה.
 */
r.post('/publish/newsletter-preview', wrap(async (req, res) => {
  const b = req.body ?? {};
  try {
    const preview = await newsletterPreview({
      subject: b.subject,
      htmlBody: b.htmlBody,
      name: b.name,
      scheduledAt: b.scheduledAt,
      templateId: b.templateId,
      fieldValues: b.fieldValues ?? {},
    });
    const warn = preview.unsafe_vars?.length
      ? `<div style="position:sticky;top:0;background:#7a1f1f;color:#fff;font:12px sans-serif;padding:6px 10px;direction:rtl">שים לב — משתנים שנשארו בלי ערך: ${preview.unsafe_vars.map((v) => String(v).replace(/</g, '&lt;')).join(', ')}</div>`
      : '';
    res.json({ ...preview, frame_token: stashPreview(warn + (preview.html ?? '')) });
  } catch (e) {
    if (e instanceof HubMailError) return hubFail(res, e);
    throw e;
  }
}));

/**
 * הדלקת פרסום אוטומטי לערוץ דורשת חיבור שנבדק ועבר. טוקן חדש באותה בקשה
 * עוד לא נבדק — קודם שומרים, בודקים, ורק אז מדליקים. כיבוי תמיד מותר.
 * מחזיר הודעת שגיאה או null.
 */
export function autoEnableBlocker({ wantsAuto, newToken, saved }) {
  if (wantsAuto !== true) return null;
  if (newToken || saved?.last_check_ok !== true) return 'בודקים חיבור לפני שמדליקים פרסום אוטומטי';
  return null;
}

/** שמירת חיבור. טוקן שלא נשלח — נשאר כמו שהוא (עריכה בלי להזין מחדש). */
r.put('/channels/:id/connection', requirePerm('settings'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const channel = await one('select id, platform from channels where id = $1', [req.params.id]);
  if (!channel) return bad(res, 'לא נמצא ערוץ כזה', 404);
  if (!['facebook', 'instagram'].includes(channel.platform)) {
    return bad(res, 'חיבור API רלוונטי רק לערוץ פייסבוק או אינסטגרם — קודם מגדירים פלטפורמה לערוץ');
  }

  const tokenEnc = b.access_token?.trim() ? encryptSecret(b.access_token.trim()) : null;
  const saved = await one(
    'select last_check_ok from channel_connections where channel_id = $1', [channel.id]);
  const blocked = autoEnableBlocker({ wantsAuto: b.auto_enabled, newToken: !!tokenEnc, saved });
  if (blocked) return bad(res, blocked);

  const c = await one(
    `insert into channel_connections (channel_id, page_id, ig_user_id, access_token_enc, auto_enabled)
     values ($1,$2,$3,$4,coalesce($5,false))
     on conflict (channel_id) do update set
       page_id          = coalesce($2, channel_connections.page_id),
       ig_user_id       = coalesce($3, channel_connections.ig_user_id),
       access_token_enc = coalesce($4, channel_connections.access_token_enc),
       -- טוקן חדש מכבה פרסום אוטומטי עד שייבדק — אחרת היה ממשיך לפרסם
       -- על טוקן שאף אחד לא בדק
       auto_enabled     = case when $4 is not null then false
                               else coalesce($5, channel_connections.auto_enabled) end,
       -- טוקן חדש עוד לא נבדק: הבדיקה הקודמת הייתה על הטוקן הישן
       last_check_ok    = case when $4 is null then channel_connections.last_check_ok end,
       last_check_at    = case when $4 is null then channel_connections.last_check_at end,
       last_check_note  = case when $4 is null then channel_connections.last_check_note end,
       updated_at       = now()
     returning channel_id, page_id, ig_user_id, auto_enabled,
               access_token_enc is not null as has_token`,
    [channel.id, b.page_id?.trim() || null, b.ig_user_id?.trim() || null,
     tokenEnc, b.auto_enabled ?? null]
  );
  res.json({ connection: c });
}));

/** בדיקת חיים: קריאה אמיתית ל-Graph עם הטוקן השמור, והתוצאה נשמרת לתצוגה */
r.post('/channels/:id/connection/verify', requirePerm('settings'), wrap(async (req, res) => {
  const c = await one(
    `select cc.*, ch.platform from channel_connections cc
       join channels ch on ch.id = cc.channel_id
      where cc.channel_id = $1`,
    [req.params.id]
  );
  if (!c) return bad(res, 'אין עדיין חיבור לערוץ הזה', 404);
  if (!c.access_token_enc) return bad(res, 'אין טוקן שמור — מזינים אותו קודם');

  let ok = true;
  let note;
  try {
    note = await verifyConnection({
      platform: c.platform, pageId: c.page_id, igUserId: c.ig_user_id,
      token: decryptSecret(c.access_token_enc),
    });
  } catch (e) {
    ok = false;
    note = e.message;
  }

  await query(
    `update channel_connections
        set last_check_at = now(), last_check_ok = $2, last_check_note = $3
      where channel_id = $1`,
    [c.channel_id, ok, note]);
  res.json({ ok, note });
}));

r.delete('/channels/:id/connection', requirePerm('settings'), wrap(async (req, res) => {
  await query('delete from channel_connections where channel_id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ========================= אישור ושליחה פר-פוסט ========================= */

/**
 * מתג-העל כבוי = אין פרסום אוטומטי בכלל (runner.js AUTOPUBLISH_OFF_ERROR):
 * אישור, אישור השבוע, "פרסם עכשיו" ו"העבר ל-HUB" נדחים. ביטול אישור ושחרור
 * פרסום תקוע — לא כאן בכוונה: הם מחזירים מצב, לא מפרסמים.
 */
const requireAutopublish = wrap(async (_req, res, next) => {
  if (!(await autopublishOn())) return bad(res, AUTOPUBLISH_OFF_ERROR, 409);
  next();
});

/**
 * אישור שליחה אוטומטית לפוסט בודד. הבדיקות רצות כאן, לא רק בשליחה —
 * כדי שבעיה תתגלה מול המשתמש שמאשר, לא בלילה מול אף אחד.
 */
r.post('/posts/:id/approve-publish', requirePerm('approve'), requireAutopublish, wrap(async (req, res) => {
  const payload = await loadPayload(req.params.id);
  if (!payload) return bad(res, 'לא נמצא פוסט כזה', 404);
  // ניוזלטר מאושר ב-HUB, לא כאן: "העבר ל-HUB" יוצר שם טיוטה לאישור
  if (payload.post.platform === 'newsletter') return bad(res, NEWSLETTER_NO_APPROVE);
  // סעיף 30: אישור מגן רק על ערוץ שמתפרסם לבד. ערוץ בלי פרסום אוטומטי
  // (ידני, וואטסאפ, חיבור כבוי או ערוץ מושבת) — אין מה לאשר, ו"מאושר" שם
  // היה מבטיח פרסום שלא יקרה
  if (!channelAutoOn(payload.post)) return bad(res, NOT_AUTO_CHANNEL_ERROR, 409);
  if (!['scheduled', 'failed'].includes(payload.post.status)) {
    return bad(res, 'אפשר לאשר רק פוסט מתוכנן (או כזה שנכשל)');
  }
  // מועד שעבר: הרַנֶר היה מפרסם מיד (או מכשיל אחרי 12 שעות) — לא מה שאושר
  if (isPast(payload.post)) return bad(res, 'המועד עבר — קבעו מועד חדש ואז אשרו');

  const blocker = publishBlocker(payload);
  if (blocker) return bad(res, blocker);

  // הטביעה של מה שאושר (סעיף 31): שינוי תוכן אחרי זה מחזיר לאישור
  const post = await one(
    `update posts set status = 'approved', approved_by = $2, approved_at = now(),
            publish_error = null, approved_digest = $3, publish_retry_at = null
      where id = $1 returning *`,
    [payload.post.id, req.user.id, approvalDigest(payload)]
  );
  res.json({ post });
}));

const isPast = (post, now = new Date()) => new Date(post.scheduled_at).getTime() < now.getTime();

/**
 * סעיף 30: האם הערוץ של הפוסט מתפרסם לבד — פעיל, עם חיבור שהפרסום
 * האוטומטי דלוק בו (loadPayload: channel_active, auto_enabled). רק שם
 * לאישור יש מה להגן עליו.
 */
export const channelAutoOn = (post) => post.channel_active !== false && !!post.auto_enabled;

export const NOT_AUTO_CHANNEL_ERROR =
  'הפרסום האוטומטי לא מופעל לערוץ הזה, ולכן אין מה לאשר — מפרסמים ידנית ומסמנים "פורסם", ' +
  'או מדליקים פרסום אוטומטי לערוץ בניהול ← ערוצי פרסום';

/**
 * למה פוסט לא נכלל באישור המרוכז, או null אם אפשר לאשר אותו.
 * אותן בדיקות כמו באישור בודד: מועד עתידי, שליחה אוטומטית דלוקה לערוץ
 * (ניוזלטר — החיבור שלו ב-HUB_API_*), ו-publishBlocker.
 */
export function weekApprovalReason(payload, now = new Date()) {
  // ניוזלטר לא מאושר כאן — עובר ל-HUB בכפתור משלו, ומאושר שם
  if (payload.post.platform === 'newsletter') return NEWSLETTER_NO_APPROVE;
  if (isPast(payload.post, now)) return 'המועד עבר';
  return publishBlocker(payload) ??
    (payload.post.auto_enabled ? null : 'הפרסום האוטומטי כבוי לערוץ הזה — מדליקים בניהול → ערוצי פרסום');
}

/**
 * אישור מרוכז לכל השבוע: כל השיבוצים העתידיים שמוכנים ואפשר לשלוח אותם
 * אוטומטית (תוכן מוכן, ערוץ מחובר, שליחה אוטומטית דלוקה) עוברים ל-approved
 * בבת אחת. שום דבר לא נשלח מיד — הרַנֶר שולח כל אחד במועד שנקבע לו.
 * מה שלא עומד בתנאים חוזר עם הסיבה (skipped), לא נופל בשקט.
 */
r.post('/publish/approve-week', requirePerm('approve'), requireAutopublish, wrap(async (req, res) => {
  const week = weekMeta(req.body?.week);
  const from = week.startDate;
  const to = new Date(week.endDate);
  to.setHours(23, 59, 59, 999);

  const candidates = await rows(
    `select p.id, p.title from posts p
       join channels c on c.id = p.channel_id
      where p.scheduled_at >= $1 and p.scheduled_at <= $2
        and p.status in ('scheduled', 'failed')
        -- ניוזלטר לא כאן בכלל: הוא עובר ל-HUB בכפתור משלו ומאושר שם
        and c.platform in ('facebook', 'instagram')
        -- פוסט מוחזק (ערוץ / נקודה מושבתים, קמפיין מושהה) — לא על הלוח, לא מאשרים
        and ${postIsLiveSql('p')}
      order by p.scheduled_at`,
    [from, to]
  );

  const eligible = [];
  const digests = [];
  const skipped = [];
  for (const { id, title } of candidates) {
    const payload = await loadPayload(id);
    const reason = payload ? weekApprovalReason(payload) : 'הפוסט לא נמצא';
    if (reason) skipped.push({ id, title, reason });
    else {
      eligible.push(id);
      digests.push(approvalDigest(payload)); // סעיף 31 — מה שאושר
    }
  }

  if (eligible.length) {
    await query(
      `update posts p set status = 'approved', approved_by = $3, approved_at = now(),
              publish_error = null, approved_digest = x.digest, publish_retry_at = null
         from unnest($1::int[], $2::text[]) as x(id, digest)
        where p.id = x.id`,
      [eligible, digests, req.user.id]
    );
  }

  const settings = await one('select autopublish_enabled from engine_settings limit 1');
  res.json({
    approved: eligible.length,
    skipped,
    autopublish_enabled: settings?.autopublish_enabled ?? false,
  });
}));

/**
 * "העבר ל-HUB" — הרגע היחיד שבו ניוזלטר נוצר ב-HUB: טיוטה שממתינה לאישור
 * בעל העסק שם, עם המועד של הפוסט. idempotent — לחיצה שנייה מחזירה את מה
 * שכבר הועבר. הרשאת approve, כמו אישור לפרסום אוטומטי.
 */
r.post('/posts/:id/newsletter/transfer', requirePerm('approve'), requireAutopublish, wrap(async (req, res) => {
  let out;
  try {
    out = await transferNewsletter(req.params.id, req.user);
  } catch (e) {
    if (e instanceof HubMailError) return hubFail(res, e);
    throw e;
  }
  if (out.error) return bad(res, out.error, out.status);
  res.json(out);
}));

/**
 * הפוסטים של ניוזלטר מסוים (תוכן + ערוץ) ומצב ההעברה שלהם ל-HUB —
 * לעורך הניוזלטר, שמציג "העבר ל-HUB" / "ממתין לאישור ב-HUB" לכל אחד.
 * stale — השתנה משהו בלוח מאז ההעברה (השינוי לא יגיע ל-HUB).
 */
r.get('/publish/newsletter-posts', wrap(async (req, res) => {
  const contentId = Number(req.query.content_id);
  const channelId = Number(req.query.channel_id);
  if (!contentId || !channelId) return bad(res, 'חסרים content_id ו-channel_id');
  const variant = await one(
    'select * from content_variants where content_id = $1 and channel_id = $2', [contentId, channelId]);
  const posts = await rows(
    `select p.id, p.title, p.status, p.scheduled_at, p.external_id, p.external_url,
            p.hub_status, p.hub_digest, p.hub_transferred_at, p.publish_error, c.platform
       from posts p join channels c on c.id = p.channel_id
      where p.content_id = $1 and p.channel_id = $2
        and p.status in ('scheduled','approved','publishing','published','failed')
      order by p.scheduled_at`,
    [contentId, channelId]);
  res.json({
    posts: posts.map(({ hub_digest: _d, ...p }) => ({
      ...p, hub_stale: hubStale({ post: { ...p, hub_digest: _d }, variant }),
      hub_unverified: hubUnverified({ hub_digest: _d }),
    })),
  });
}));

/** ביטול אישור — חוזר למתוכנן, שום דבר לא נשלח */
r.post('/posts/:id/unapprove-publish', requirePerm('approve'), wrap(async (req, res) => {
  const post = await one(
    `update posts set status = 'scheduled', approved_by = null, approved_at = null,
                      publish_retry_at = null, publish_error = null
      where id = $1 and status = 'approved' returning *`,
    [req.params.id]
  );
  if (!post) return bad(res, 'אין פוסט שמאושר לפרסום אוטומטי עם המזהה הזה', 404);
  res.json({ post });
}));

/** שליחה מיידית, בלי לחכות לטיק — למי שרוצה לראות את זה קורה עכשיו */
r.post('/posts/:id/publish-now', requirePerm('approve'), requireAutopublish, wrap(async (req, res) => {
  // ניוזלטר לא "מתפרסם עכשיו" מכאן — הוא עובר ל-HUB ומאושר שם
  const target = await one(
    `select c.platform from posts p join channels c on c.id = p.channel_id where p.id = $1`,
    [req.params.id]);
  if (target?.platform === 'newsletter') {
    return bad(res, 'ניוזלטר לא נשלח מכאן — לוחצים "העבר ל-HUB" ומאשרים את השליחה ב-HUB');
  }
  // publishOne פותח טרנזקציה משלו לכל שלב (runner.js) — הפרסום לא תלוי
  // בטרנזקציית הבקשה ובחיבור שלה, וגם דפדפן שהתנתק באמצע (וידאו לאינסטגרם
  // — דקות) לא מפיל את שמירת התוצאה. ולכן אין כאן נעילה על הפוסט לפני.
  const result = await publishOne(req.params.id, {
    allowedFrom: ['scheduled', 'approved', 'failed'],
  });
  if (!result.ok) return bad(res, result.error);
  // pending — ניוזלטר שהתקבל ב-HUB ועוד נשלח אצלו (הפוסט נשאר publishing)
  res.json({ post: result.post, pending: result.pending ?? false });
}));

/**
 * פוסט שתקוע ב-publishing (פרסום שנקטע, ניוזלטר שה-HUB לא סגר) — מעבירים
 * ידנית ל-failed עם הערה, בלי לחכות לטיק (30 דקות / יממה). הפוסט מקבל
 * משימת כשל: בודקים בעמוד אם עלה, ואז מסמנים פורסם או מפרסמים שוב.
 */
r.post('/posts/:id/reset-publishing', requirePerm('approve'), wrap(async (req, res) => {
  const r = await resetPublishing(req.params.id, req.user);
  if (!r) return bad(res, 'הפוסט לא תקוע בפרסום — אין מה לאפס', 409);
  if (r.error) return bad(res, r.error, 409);
  res.json({ post: r.post });
}));

/**
 * היסטוריית הניסיונות של פוסט — מוצג בחלון הפוסט. message: מה שבן אדם מבין
 * (friendlyPublishError); error הגולמי נשאר בשביל המפתח (title בחלון).
 */
r.get('/posts/:id/publish-log', wrap(async (req, res) => {
  const log = await rows(
    `select id, platform, ok, external_id, error, created_at
       from publish_log where post_id = $1 order by created_at desc limit 20`,
    [req.params.id]);
  res.json({
    log: log.map((x) => ({
      ...x,
      message: x.ok ? null : friendlyPublishError(x.error ?? '', { platform: x.platform }).message,
    })),
  });
}));

export default r;
