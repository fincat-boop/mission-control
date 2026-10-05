import crypto from 'node:crypto';
import express, { Router } from 'express';
import { bad, wrap } from './_shared.js';
import { one, query, rows } from '../db.js';
import { requirePerm } from '../auth.js';
import { encryptSecret, decryptSecret } from '../publish/crypto.js';
import { verifyConnection } from '../publish/meta.js';
import { loadPayload, publishBlocker, publishOne } from '../publish/runner.js';
import { HubMailError, audienceLists, hubMailReady,
         newsletterTemplate, newsletterPreview } from '../hub-mail.js';
import { weekMeta } from '../board.js';

const r = Router();

/* ========================= חיבורי ערוצים ========================= */

/**
 * מצב הפרסום האוטומטי: המתג הגלובלי + החיבור של כל ערוץ.
 * הטוקן לעולם לא חוזר — רק העובדה שהוא קיים.
 */
r.get('/publish/status', wrap(async (_req, res) => {
  const [settings, connections] = await Promise.all([
    one('select autopublish_enabled from engine_settings limit 1'),
    rows(
      `select cc.channel_id, cc.page_id, cc.ig_user_id, cc.auto_enabled,
              cc.access_token_enc is not null as has_token,
              cc.last_check_at, cc.last_check_ok, cc.last_check_note
         from channel_connections cc`),
  ]);
  res.json({
    autopublish_enabled: settings?.autopublish_enabled ?? false,
    hub_mail_ready: hubMailReady(),
    connections,
  });
}));

/**
 * רשימות הקהל מה-HUB — לבורר בעריכת גרסת המייל. שגיאת HUB חוזרת עם
 * ההודעה הידידותית שלו (העברית של HubMailError), לא כ"משהו נשבר".
 */
r.get('/publish/hub-lists', wrap(async (_req, res) => {
  try {
    res.json({ lists: await audienceLists() });
  } catch (e) {
    if (e instanceof HubMailError) {
      const status = e.status === 401 || e.status === 403 ? 502 : e.status >= 500 ? 502 : e.status;
      const msg = e.status === 401 ? 'ה-HUB דחה את המפתח (HUB_API_KEY) — בדוק שהוא זהה ל-MISSION_CONTROL_API_KEY שם' : e.message;
      return bad(res, msg, status);
    }
    throw e;
  }
}));

/**
 * תבנית הניוזלטר שמוגדרת ב-HUB — מזינה את טופס המילוי בעריכת גרסת המייל.
 * null = אין תבנית, הלוח מציג רק נושא+תוכן+רשימה.
 */
r.get('/publish/newsletter-template', wrap(async (_req, res) => {
  try {
    // fill_url — הממלא המלא ב-HUB (נפתח בטאב, מחזיר ערכים ב-postMessage)
    const hubBase = String(process.env.HUB_API_URL ?? '').trim().replace(/\/+$/, '');
    res.json({
      template: await newsletterTemplate(),
      fill_url: hubBase ? `${hubBase}/dashboard/mission-control/fill` : null,
    });
  } catch (e) {
    if (e instanceof HubMailError) {
      const status = e.status === 401 || e.status === 403 ? 502 : e.status >= 500 ? 502 : e.status;
      const msg = e.status === 401 ? 'ה-HUB דחה את המפתח (HUB_API_KEY) — בדוק שהוא זהה ל-MISSION_CONTROL_API_KEY שם' : e.message;
      return bad(res, msg, status);
    }
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
      fieldValues: b.fieldValues ?? {},
    });
    const warn = preview.unsafe_vars?.length
      ? `<div style="position:sticky;top:0;background:#7a1f1f;color:#fff;font:12px sans-serif;padding:6px 10px;direction:rtl">שים לב — משתנים שנשארו בלי ערך: ${preview.unsafe_vars.map((v) => String(v).replace(/</g, '&lt;')).join(', ')}</div>`
      : '';
    res.json({ ...preview, frame_token: stashPreview(warn + (preview.html ?? '')) });
  } catch (e) {
    if (e instanceof HubMailError) {
      const status = e.status === 401 || e.status === 403 ? 502 : e.status >= 500 ? 502 : e.status;
      const msg = e.status === 401 ? 'ה-HUB דחה את המפתח (HUB_API_KEY) — בדוק שהוא זהה ל-MISSION_CONTROL_API_KEY שם' : e.message;
      return bad(res, msg, status);
    }
    throw e;
  }
}));

/** שמירת חיבור. טוקן שלא נשלח — נשאר כמו שהוא (עריכה בלי להזין מחדש). */
r.put('/channels/:id/connection', requirePerm('settings'), wrap(async (req, res) => {
  const b = req.body ?? {};
  const channel = await one('select id, platform from channels where id = $1', [req.params.id]);
  if (!channel) return bad(res, 'לא נמצא ערוץ כזה', 404);
  if (!['facebook', 'instagram'].includes(channel.platform)) {
    return bad(res, 'חיבור API רלוונטי רק לערוץ פייסבוק או אינסטגרם — קודם מגדירים פלטפורמה לערוץ');
  }

  const tokenEnc = b.access_token?.trim() ? encryptSecret(b.access_token.trim()) : null;

  const c = await one(
    `insert into channel_connections (channel_id, page_id, ig_user_id, access_token_enc, auto_enabled)
     values ($1,$2,$3,$4,coalesce($5,false))
     on conflict (channel_id) do update set
       page_id          = coalesce($2, channel_connections.page_id),
       ig_user_id       = coalesce($3, channel_connections.ig_user_id),
       access_token_enc = coalesce($4, channel_connections.access_token_enc),
       auto_enabled     = coalesce($5, channel_connections.auto_enabled),
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
 * אישור שליחה אוטומטית לפוסט בודד. הבדיקות רצות כאן, לא רק בשליחה —
 * כדי שבעיה תתגלה מול המשתמש שמאשר, לא בלילה מול אף אחד.
 */
r.post('/posts/:id/approve-publish', requirePerm('approve'), wrap(async (req, res) => {
  const payload = await loadPayload(req.params.id);
  if (!payload) return bad(res, 'לא נמצא שיבוץ כזה', 404);
  if (!['scheduled', 'failed'].includes(payload.post.status)) {
    return bad(res, 'אפשר לאשר רק שיבוץ מתוכנן (או כזה שנכשל)');
  }
  // מועד שעבר: הרַנֶר היה מפרסם מיד (או מכשיל אחרי 12 שעות) — לא מה שאושר
  if (isPast(payload.post)) return bad(res, 'המועד עבר — קבעו מועד חדש ואז אשרו');

  const blocker = publishBlocker(payload);
  if (blocker) return bad(res, blocker);
  // ניוזלטר לא צריך channel_connection — החיבור שלו הוא HUB_API_* בסביבה,
  // ו-publishBlocker כבר בדק אותו
  if (!payload.post.auto_enabled && payload.post.platform !== 'newsletter') {
    return bad(res, 'השליחה האוטומטית כבויה לערוץ הזה — מדליקים בניהול → ערוצי פרסום');
  }

  const post = await one(
    `update posts set status = 'approved', approved_by = $2, approved_at = now(),
            publish_error = null
      where id = $1 returning *`,
    [payload.post.id, req.user.id]
  );
  res.json({ post });
}));

const isPast = (post, now = new Date()) => new Date(post.scheduled_at).getTime() < now.getTime();

/**
 * למה פוסט לא נכלל באישור המרוכז, או null אם אפשר לאשר אותו.
 * אותן בדיקות כמו באישור בודד: מועד עתידי, שליחה אוטומטית דלוקה לערוץ
 * (ניוזלטר — החיבור שלו ב-HUB_API_*), ו-publishBlocker.
 */
export function weekApprovalReason(payload, now = new Date()) {
  if (isPast(payload.post, now)) return 'המועד עבר';
  const autoOk = payload.post.auto_enabled || payload.post.platform === 'newsletter';
  return publishBlocker(payload) ??
    (autoOk ? null : 'השליחה האוטומטית כבויה לערוץ הזה — מדליקים בניהול → ערוצי פרסום');
}

/**
 * אישור מרוכז לכל השבוע: כל השיבוצים העתידיים שמוכנים ואפשר לשלוח אותם
 * אוטומטית (תוכן מוכן, ערוץ מחובר, שליחה אוטומטית דלוקה) עוברים ל-approved
 * בבת אחת. שום דבר לא נשלח מיד — הרַנֶר שולח כל אחד במועד שנקבע לו.
 * מה שלא עומד בתנאים חוזר עם הסיבה (skipped), לא נופל בשקט.
 */
r.post('/publish/approve-week', requirePerm('approve'), wrap(async (req, res) => {
  const week = weekMeta(req.body?.week);
  const from = week.startDate;
  const to = new Date(week.endDate);
  to.setHours(23, 59, 59, 999);

  const candidates = await rows(
    `select p.id, p.title from posts p
       join channels c on c.id = p.channel_id
      where p.scheduled_at >= $1 and p.scheduled_at <= $2
        and p.status in ('scheduled', 'failed')
        and c.platform in ('facebook', 'instagram', 'newsletter')
        and c.active
        and not exists (select 1 from content_items ci
                          join campaigns ca on ca.id = ci.campaign_id
                         where ci.id = p.content_id and ca.paused_at is not null)
      order by p.scheduled_at`,
    [from, to]
  );

  const eligible = [];
  const skipped = [];
  for (const { id, title } of candidates) {
    const payload = await loadPayload(id);
    const reason = payload ? weekApprovalReason(payload) : 'הפוסט לא נמצא';
    if (reason) skipped.push({ id, title, reason });
    else eligible.push(id);
  }

  if (eligible.length) {
    await query(
      `update posts set status = 'approved', approved_by = $2, approved_at = now(),
              publish_error = null
        where id = any($1)`,
      [eligible, req.user.id]
    );
  }

  const settings = await one('select autopublish_enabled from engine_settings limit 1');
  res.json({
    approved: eligible.length,
    skipped,
    autopublish_enabled: settings?.autopublish_enabled ?? false,
  });
}));

/** ביטול אישור — חוזר למתוכנן, שום דבר לא נשלח */
r.post('/posts/:id/unapprove-publish', requirePerm('approve'), wrap(async (req, res) => {
  const post = await one(
    `update posts set status = 'scheduled', approved_by = null, approved_at = null
      where id = $1 and status = 'approved' returning *`,
    [req.params.id]
  );
  if (!post) return bad(res, 'אין שיבוץ שמאושר לשליחה עם המזהה הזה', 404);
  res.json({ post });
}));

/** שליחה מיידית, בלי לחכות לטיק — למי שרוצה לראות את זה קורה עכשיו */
r.post('/posts/:id/publish-now', requirePerm('approve'), wrap(async (req, res) => {
  const result = await publishOne(req.params.id, {
    allowedFrom: ['scheduled', 'approved', 'failed'],
  });
  if (!result.ok) return bad(res, result.error);
  // pending — ניוזלטר שהתקבל ב-HUB ועוד נשלח אצלו (הפוסט נשאר publishing)
  res.json({ post: result.post, pending: result.pending ?? false });
}));

/** היסטוריית הניסיונות של פוסט — מוצג בדיאלוג הפוסט */
r.get('/posts/:id/publish-log', wrap(async (req, res) => {
  res.json({
    log: await rows(
      `select id, platform, ok, external_id, error, created_at
         from publish_log where post_id = $1 order by created_at desc limit 20`,
      [req.params.id]),
  });
}));

export default r;
