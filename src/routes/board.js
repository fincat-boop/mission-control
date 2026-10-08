import { Router } from 'express';
import { bad, updateById, wrap } from './_shared.js';
import { buildBoard, ymd } from '../board.js';
import { requirePerm } from '../auth.js';
import {
  campaignWindowWarning, capWarning, gapWarning, linkDayWarning, softWarning, warningsConfirmed,
} from '../gap.js';
import { one, query, rows } from '../db.js';
import { parseMetric } from '../performance.js';
import { hubMailReady } from '../hub-mail.js';
import { autopublishOn, emitPostEvent, maybeOutSql } from '../publish/runner.js';
import { hubStale, hubUnverified } from '../publish/newsletter.js';
import { assetView } from '../media.js';
import { contentState } from '../publish/readiness.js';
import {
  attachToPost, contentCandidates, liftDismissals, plannedDate, recordDismissals, takesRoomSql,
} from '../engine.js';
import { candidateColumnsSql, fitsSlotChannel } from '../candidates.js';
import { itemAssetsSql } from '../links.js';
import { unconfirmedPosts } from '../unconfirmed.js';
import { postIsLiveSql } from '../live.js';

/** פוסט שתופס את היום שלו על הלוח — אותם מצבים כמו במנוע (LIVE ב-gap.js) */
const LIVE_STATUSES = ['scheduled', 'approved', 'publishing', 'failed', 'published', 'pending_approval'];

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
  // אין פוסט בלי נקודת קצה (החלטת המשתמש 8.10.26): כל קמפיין שייך לנקודה,
  // ופוסט בלי נקודה הוא פוסט בלי קמפיין — כרטיס אפור שאיש לא מתכנן
  const epErr = await postEndpointError({ endpointId: b.endpoint_id, contentId: b.content_id });
  if (epErr) return bad(res, epErr.error, epErr.status);
  // מועד שעבר לא יתפרסם לעולם (כמו בהזזה — moveBlocker). אותו יום בשעה
  // מאוחרת יותר — בסדר.
  const when = new Date(b.scheduled_at);
  if (Number.isNaN(when.getTime())) return bad(res, 'המועד לא תקין');
  if (when.getTime() < Date.now()) return bad(res, 'אי אפשר לשבץ פוסט לזמן שעבר');
  // אותם כללים קשיחים כמו בהזזה: יום שהערוץ חסם, ושני פוסטים לאותה נקודת
  // קצה באותו ערוץ באותו יום
  const target = await one('select name, blocked_days, active from channels where id = $1', [b.channel_id]);
  if (!target) return bad(res, 'לא נמצא ערוץ כזה', 404);
  const blockedDay = blockedDayError(target, b.scheduled_at);
  if (blockedDay) return bad(res, blockedDay);
  const clash = await sameDayClash({ endpointId: b.endpoint_id, channelId: b.channel_id,
                                     when: b.scheduled_at });
  if (clash) return bad(res, `כבר יש פוסט לאותה נקודת קצה במדיה הזו באותו יום: ${clash.title}`);

  // שיבוץ צמוד מדי לפוסט קיים של אותה נקודה, תוכן של קמפיין מחוץ לחלון
  // שלו, פוסט מקושר באותו יום, או חריגה ממכסות — מזהיר, לא חוסם
  const warning = softWarning(
    await gapWarning({ endpointId: b.endpoint_id, channelId: b.channel_id, when: b.scheduled_at,
                       contentId: b.content_id ?? null }),
    await campaignWindowWarning({ contentId: b.content_id, when: b.scheduled_at }),
    await linkDayWarning({ contentId: b.content_id, when: b.scheduled_at }),
    await capWarning({ channelId: b.channel_id, when: b.scheduled_at, kind: b.kind }),
  );
  if (warning && !warningsConfirmed(b)) {
    return res.status(409).json({ error: warning.message, warning, needs_confirm: true });
  }

  // פוסט ידני נולד תמיד "מתוכנן": status מהגוף לא נקרא — אחרת אפשר ליצור
  // פוסט מאושר (או "פורסם") בלי הרשאת אישור. מעברי סטטוס — רק בנתיבים
  // הייעודיים (approve / publish / reject).
  const post = await one(
    `insert into posts (channel_id, endpoint_id, content_id, title, kind,
                        scheduled_at, status, assignee_id, urgent, note)
     values ($1,$2,$3,$4,$5,$6,'scheduled',$7,coalesce($8,false),$9)
     returning *`,
    [b.channel_id, b.endpoint_id ?? null, b.content_id ?? null, b.title, b.kind,
     b.scheduled_at, b.assignee_id ?? null, b.urgent ?? false, b.note ?? null]
  );
  // שיבוץ ידני עם תוכן גובר על חסימה ממחיקה קודמת (סעיף 14)
  if (post.content_id) await liftDismissals(post.content_id, post.channel_id);
  res.status(201).json({ post });
}));

export const ENDPOINT_REQUIRED = 'צריך לבחור נקודת קצה לפוסט — אין פוסט בלי נקודת קצה';

/**
 * למה נקודת הקצה של פוסט לא תקינה, או null: חובה, קיימת ופעילה, ואם יש לפוסט
 * תוכן — הנקודה של התוכן (תוכן תמיד שייך לנקודה, ותוכן של קמפיין — לנקודה
 * של הקמפיין). { status, error }. גם PATCH /posts (כשהנקודה או התוכן משתנים).
 */
export async function postEndpointError({ endpointId, contentId = null }) {
  const id = idOrNull(endpointId);
  if (!id || !Number.isInteger(id) || id <= 0) return { status: 400, error: ENDPOINT_REQUIRED };
  const ep = await one('select active from endpoints where id = $1', [id]);
  if (!ep) return { status: 404, error: 'לא נמצאה נקודת קצה כזו' };
  if (!ep.active) return { status: 409, error: 'נקודת הקצה הזו מושבתת — בוחרים נקודה פעילה' };
  const cid = idOrNull(contentId);
  if (cid) {
    const item = await one('select endpoint_id from content_items where id = $1', [cid]);
    if (!item) return { status: 404, error: 'לא נמצא תוכן כזה' };
    if (item.endpoint_id !== id) {
      return { status: 400, error: 'התוכן שייך לנקודת קצה אחרת מזו של הפוסט' };
    }
  }
  return null;
}

/** הודעת החסימה של יום שהערוץ לא מקבל בו תוכן, או null. target — שורת הערוץ */
export function blockedDayError(target, when) {
  const dow = new Date(when).getDay();
  if (!(target?.blocked_days ?? []).includes(dow)) return null;
  const names = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  return `${target.name} לא מקבל תוכן בימי ${names[dow]}`;
}

/**
 * פוסט אחר של אותה נקודת קצה באותו ערוץ באותו יום (postId — לא הוא עצמו), או
 * null. היום — בלוח של ישראל בשני הצדדים (פוסט ב-01:00 שייך ליום שלו, לא ליום
 * הקודם ב-UTC). נספרים רק פוסטים חיים שעל הלוח (LIVE_STATUSES), בלי פוסט
 * מוחזק שירד מהלוח (קמפיין מושהה, ערוץ / נקודה מושבתים — postIsLiveSql)
 * אלא אם כבר פורסם, ובלי נכשל שהמועד שלו עבר (לא עלה לאוויר, takesRoom) —
 * כמו במנוע. גם העוזר בודק דרכה (checkMove).
 */
export function sameDayClash({ postId = null, endpointId, channelId, when }) {
  if (!endpointId) return null;
  return one(
    `select p.id, p.title from posts p
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where ($1::int is null or p.id <> $1) and p.endpoint_id = $2 and p.channel_id = $3
        and p.status = any($5) and ${takesRoomSql('p')}
        and (p.status = 'published' or ${postIsLiveSql('p')})
        and (p.scheduled_at at time zone 'Asia/Jerusalem')::date
          = ($4::timestamptz at time zone 'Asia/Jerusalem')::date`,
    [postId, endpointId, channelId, when, LIVE_STATUSES]
  );
}

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
    // ניוזלטר שהועבר ל-HUB: המועד שם הוא הקובע (אין ל-HUB נתיב עדכון)
    return current.hub_transferred_at
      ? { status: 409, error: 'הניוזלטר כבר הועבר ל-HUB — משנים את המועד שם, במסך האישור' }
      : { status: 409, error: 'הפוסט נשלח ברגע זה — אי אפשר להזיז אותו' };
  }
  if (new Date(when).getTime() < now.getTime()) {
    return { status: 400, error: 'אי אפשר להזיז פוסט לזמן שעבר' };
  }
  return null;
}

/**
 * למה אסור לערוך או למחוק את הפוסט עכשיו, או null (טהורה). publishing =
 * בדרך לפלטפורמה ברגע זה — עריכה הייתה נכתבת על פוסט שכבר יצא (או נמחק
 * פוסט שבאוויר). ניוזלטר ב-publishing נמצא בידי ה-HUB, לפעמים ימים.
 * פוסט שכבר פורסם — הזזה חסומה ב-moveBlocker; מחיקה מהלוח מותרת (כמו בממשק).
 */
export function publishingBlocker(current) {
  if (current.status !== 'publishing') return null;
  return current.hub_transferred_at
    ? 'הניוזלטר כבר הועבר ל-HUB — משנים או מבטלים אותו שם'
    : 'הפוסט מתפרסם ממש עכשיו — נסו שוב בעוד דקה';
}

// status לא כאן בכוונה: מעבר סטטוס עובר רק בנתיבים הייעודיים (אישור, פרסום,
// "סמן כפורסם") שבודקים הרשאת approve. אחרת content יכול לקבוע approved.
const POST_FIELDS = ['channel_id', 'endpoint_id', 'content_id', 'title', 'kind',
                     'scheduled_at', 'assignee_id', 'urgent', 'note'];

r.patch('/posts/:id', requirePerm('content'), wrap(async (req, res) => {
  const b = req.body ?? {};
  // נעילת השורה עד סוף הבקשה: התפיסה לפרסום (publishOne) מחכה לה, ורואה את
  // המועד/הערוץ החדשים. בלי הנעילה עדכון יכול היה לנחות על פוסט שבדיוק עבר
  // ל-publishing / published.
  const current = await one('select * from posts where id = $1 for update', [req.params.id]);
  if (!current) return bad(res, 'לא נמצא שיבוץ כזה', 404);
  const publishing = publishingBlocker(current);
  if (publishing) return bad(res, publishing, 409);

  // הזזה על הלוח עוברת את אותו כלל שהמנוע והמבצע הדחוף מכבדים:
  // נקודת קצה אחת, מדיה אחת, יום אחד. גם שינוי של נקודת הקצה, הסוג או
  // התוכן בלי הזזה (עריכת פוסט, החלפת תוכן ממשימת תחזוקה) — אותן בדיקות:
  // נקודה אחרת יכולה להתנגש באותו יום / במרווח, וסוג אחר — במכסה לסוג
  // (ניתוק תוכן — content_id ריק — לא מוסיף כלל, ולכן לא מעורר בדיקות)
  const changed = (key) => key in b && idOrNull(b[key]) !== (current[key] ?? null);
  const contentChanged = b.content_id != null && changed('content_id');
  const kindChanged = b.kind != null && b.kind !== current.kind;
  // אין פוסט בלי נקודת קצה: אי אפשר לאפס אותה, ותוכן חדש / נקודה חדשה — רק
  // כשהם תואמים (postEndpointError). פוסט ישן בלי נקודה (פורסם לפני הכלל)
  // עדיין נערך בכותרת / בהערה — נבדק רק מה שהבקשה משנה.
  // שארית ישנה בלי נקודה: הזזה (מועד או ערוץ) מחזירה אותה לתכנון, ולכן רק
  // עם נקודה באותה בקשה. כותרת, הערה וסימון "פורסם" — בלי
  if (current.endpoint_id == null && isMove(current, b) && !idOrNull(b.endpoint_id)) {
    return bad(res, ENDPOINT_REQUIRED);
  }
  if (changed('endpoint_id') || contentChanged) {
    const epErr = await postEndpointError({
      endpointId: 'endpoint_id' in b ? b.endpoint_id : current.endpoint_id,
      contentId: 'content_id' in b ? b.content_id : current.content_id,
    });
    if (epErr) return bad(res, epErr.error, epErr.status);
  }
  if (b.scheduled_at || b.channel_id || changed('endpoint_id') || contentChanged || kindChanged) {
    const when = b.scheduled_at ?? current.scheduled_at;
    const channel = b.channel_id ?? current.channel_id;
    const endpoint = 'endpoint_id' in b ? idOrNull(b.endpoint_id) : current.endpoint_id;

    const moving = isMove(current, b);
    const blocked = moving && moveBlocker(current, when);
    if (blocked) return bad(res, blocked.error, blocked.status);

    const clash = await sameDayClash({ postId: current.id, endpointId: endpoint, channelId: channel, when });
    if (clash) {
      return bad(res, `כבר יש פוסט לאותה נקודת קצה במדיה הזו באותו יום: ${clash.title}`);
    }

    // יום שהמדיה לא מקבלת בו תוכן
    const target = await one('select name, blocked_days, active from channels where id = $1', [channel]);
    const blockedDay = blockedDayError(target, when);
    if (blockedDay) return bad(res, blockedDay);

    // מעבר לערוץ אחר — אותם כללים כמו שיוך תוכן (attach-content): ערוץ פעיל,
    // ניסוח לתוכן בערוץ הזה שאינו "לא רלוונטי", ומשבצת-מדיה של קמפיין כללי
    // רק בערוץ שלה. אחרת היינו מפרסמים שם ניסוח שנכתב למדיה אחרת.
    if (Number(channel) !== current.channel_id) {
      const contentId = 'content_id' in b ? b.content_id : current.content_id;
      const item = contentId
        ? await one('select id, slot_channel_id from content_items where id = $1', [contentId]) : null;
      const variant = item
        ? await one('select status from content_variants where content_id = $1 and channel_id = $2',
                    [item.id, channel]) : null;
      const blocker = channelChangeBlocker({ target, item, variant }, Number(channel));
      if (blocker) return bad(res, blocker.error, blocker.status);
    }

    const contentAfter = 'content_id' in b ? b.content_id : current.content_id;
    // פוסט מקושר באותו יום — רק כשהיום או התוכן באמת משתנים; הזזת שעה או
    // ערוץ באותו יום לא מעוררת שוב אזהרה שכבר אושרה
    const relinked = ymd(new Date(when)) !== ymd(new Date(current.scheduled_at)) ||
      Number(contentAfter ?? 0) !== Number(current.content_id ?? 0);
    const warning = softWarning(
      // המרווח של הקמפיין של התוכן שיישאר על הפוסט אחרי העדכון
      await gapWarning({ endpointId: endpoint, channelId: channel, when, excludePostId: current.id,
                         contentId: contentAfter }),
      // רק כשהתאריך או התוכן באמת משתנים — שינוי ערוץ באותו יום לא מעורר אותה שוב
      b.scheduled_at || contentChanged
        ? await campaignWindowWarning({ contentId: contentAfter, when })
        : null,
      relinked
        ? await linkDayWarning({ contentId: contentAfter, when, excludePostId: current.id })
        : null,
      // מכסות — רק כשהפוסט נכנס לשבוע / ערוץ / סוג / יום שלא נספר בו קודם
      await capWarning({ channelId: channel, when, kind: b.kind ?? current.kind,
                         excludePostId: current.id }),
    );
    if (warning && !warningsConfirmed(b)) {
      return res.status(409).json({ error: warning.message, warning, needs_confirm: true });
    }
  }

  if ('title' in b) {
    const title = String(b.title ?? '').trim();
    if (!title) return bad(res, 'צריך כותרת לפוסט');
    b.title = title.slice(0, 200);
  }

  let post = await updateById('posts', POST_FIELDS, req.params.id, b);
  // תוכן שהמשתמש שם בפוסט ביד גובר על חסימה ממחיקה קודמת (סעיף 14)
  if (contentChanged && post?.content_id) await liftDismissals(post.content_id, post.channel_id);
  // האישור לפרסום אוטומטי ניתן על מה שיוצא בפועל: הערוץ (החיבור, הניסוח),
  // התוכן ונקודת הקצה — שינוי של אחד מהם מחזיר למתוכנן. מועד בלבד משאיר.
  const approvalReset = current.status === 'approved' && approvalResetOnChange(current, b);
  if (approvalReset) {
    post = await one(
      `update posts set status = 'scheduled', approved_by = null, approved_at = null
        where id = $1 and status = 'approved' returning *`,
      [current.id]) ?? post;
  }
  // פרסום אוטומטי כבוי (runner.js AUTOPUBLISH_OFF_ERROR): נכשל שקיבל מועד
  // חדש חוזר למתוכנן — אין מי שיאשר אותו שוב, ובלי זה הוא היה נשאר אדום
  // לתמיד. משימת הכשל שלו נסגרת. רק נכשל שבוודאות לא יצא (maybeOutSql) —
  // מה שאולי יצא נשאר נכשל, ומסמנים אותו "פורסם". מתג דלוק — נשאר נכשל עד
  // אישור, כמו היום.
  if (current.status === 'failed' && isMove(current, b) && !(await autopublishOn())) {
    const back = await one(
      `update posts p set status = 'scheduled', publish_error = null, approved_by = null,
                          approved_at = null
        where p.id = $1 and p.status = 'failed' and not ${maybeOutSql('p')} returning *`, [current.id]);
    if (back) {
      post = back;
      await query(
        "update tasks set done = true, done_at = now() where post_id = $1 and kind = 'failed' and not done",
        [current.id]);
    }
  }
  res.json({ post, approval_reset: approvalReset });
}));

/**
 * למה אי אפשר להעביר פוסט לערוץ הזה, או null. טהורה (טסט ב-post-move.test.js).
 * target — שורת הערוץ; item — פריט התוכן של הפוסט (או null); variant — הניסוח
 * של התוכן לערוץ היעד (או null).
 */
export function channelChangeBlocker({ target, item, variant }, channelId) {
  if (!target) return { status: 404, error: 'לא נמצא ערוץ כזה' };
  if (!target.active) return { status: 409, error: `הערוץ ${target.name} מושבת` };
  if (!item) return null;
  if (!fitsSlotChannel(item, channelId)) {
    return { status: 400, error: 'התוכן הזה הוא משבצת של ערוץ אחר בקמפיין — הוא לא עובר ערוץ' };
  }
  if (!variant) {
    return { status: 400, error: `אין לתוכן הזה גרסה ל${target.name} — כותבים אותה קודם בתוכן` };
  }
  if (variant.status === 'not_relevant') {
    return { status: 400, error: `התוכן הזה מסומן "לא רלוונטי" ל${target.name}` };
  }
  return null;
}

/** ערך מזהה מהבקשה מול הקיים: null/'' = ריק, אחרת מספר */
const idOrNull = (v) => (v == null || v === '' ? null : Number(v));

/**
 * האם שינוי מבטל אישור לפרסום אוטומטי: ערוץ אחר, תוכן אחר (גם "החלף תוכן"
 * ממשימת swap, שעובר ב-PATCH) או נקודת קצה אחרת. מועד, כותרת, אחראי — לא.
 */
export function approvalResetOnChange(current, b) {
  const changed = (key) => key in b && idOrNull(b[key]) !== (current[key] ?? null);
  return (b.channel_id != null && changed('channel_id')) || changed('content_id') || changed('endpoint_id');
}

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
            cc.access_token_enc is not null as autopub_connected,
            -- נכשל שאולי כבר יצא — לא חוזר למתוכנן כשהמתג כבוי (runner.js maybeOutSql)
            (p.status = 'failed' and ${maybeOutSql('p')}) as maybe_out
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
  // סעיף 23: פוסט עם תוכן מוצג בכותרת העדכנית של התוכן (כמו כרטיס הלוח);
  // הכותרת שהועתקה בשיבוץ נשארת ב-post_title
  if (p.content_title) {
    p.post_title = p.title;
    p.title = p.content_title;
  }

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

  // "חסר תוכן" (טיוטה בלי טקסט ובלי מדיה) ו"מוכן ⚠ <סיבה>" — אותה בדיקה
  // כמו כרטיס הלוח והטבלה (contentState, readiness.js — סעיפים 20–21)
  if (p.content_id) {
    const st = contentState({ platform: p.platform, variant, assets });
    p.content_empty = st.empty;
    p.ready_warn = st.warn;
  }

  // ניוזלטר שהועבר ל-HUB: האם השתנה משהו בלוח מאז (השינוי לא יגיע לשם)
  if (p.platform === 'newsletter') {
    // הטביעה בהעברה חושבה מ-posts.title (מה שה-runner שולח), לא מכותרת התוכן שמוצגת
    p.hub_stale = hubStale({ post: { ...p, title: p.post_title ?? p.title }, variant });
    p.hub_unverified = hubUnverified(p);
  }

  // התוצאות נשלחות יחד עם התצוגה המקדימה כדי שהדיאלוג לא יצטרך קריאה שנייה
  const results = await one('select * from post_results where post_id = $1', [p.id]);

  // מבצע דחוף שממתין לאישור: כמה פוסטים של אותו מבצע עוד ממתינים ואפשר
  // לאשר אותם (המועד לא עבר) — כולל זה
  p.group_pending = p.status === 'pending_approval' && p.urgent_group
    ? (await one(
        `select count(*)::int as n from posts
          where urgent_group = $1 and status = 'pending_approval' and scheduled_at > now()`,
        [p.urgent_group])).n
    : 0;

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
 * כוויתור בערוץ הזה, כדי שגם מילוי שיופעל משינוי אחר לא יחזיר אותו
 * (engine_dismissals): תוכן של קמפיין — לכל תקופת הקמפיין (סעיף 14), שוטף —
 * לשבוע הזה. להזיז רק את המועד — "הזז לתאריך אחר", לא מחיקה.
 */
r.delete('/posts/:id', requirePerm('content'), wrap(async (req, res) => {
  // נעילה ובדיקה לפני המחיקה — פוסט שבדרך לפלטפורמה לא נמחק (ראו publishingBlocker)
  const locked = await one(
    'select status, hub_transferred_at from posts where id = $1 for update', [req.params.id]);
  const publishing = locked && publishingBlocker(locked);
  if (publishing) return bad(res, publishing, 409);
  const post = await one(
    'delete from posts where id = $1 returning id, content_id, channel_id, scheduled_at',
    [req.params.id]
  );
  if (post?.content_id) await recordDismissals([post], { campaignWide: true });
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
 * קמפיין פעיל ולא מושהה ותאריך בתוך החלון שלו. משימות "לכתוב"/"החלפה" נסגרות.
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
            ca.name as campaign_name, ca.paused_at, ca.active as campaign_active,
            ca.starts_on, ca.ends_on,
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
    // קמפיין לא פעיל — כמו מושהה לשיבוץ (candidateFilterSql): הרשימה לא מציעה אותו
    if (!c.campaign_active) return bad(res, `הקמפיין "${c.campaign_name}" לא פעיל`, 409);
    const day = post.local_date;
    if ((c.starts_on && c.starts_on > day) || (c.ends_on && c.ends_on < day)) {
      return bad(res, `הפוסט מחוץ לתאריכי הקמפיין "${c.campaign_name}"` +
        ` (${c.starts_on ?? '…'} – ${c.ends_on ?? '…'})`);
    }
    // קמפיין מוכן: הפריט יוצא לא לפני התאריך המתוכנן שלו — כמו במנוע
    const planned = plannedDate(c);
    if (planned && day < planned) {
      return bad(res, `"${c.title}" מתוכנן ל-${planned} בקמפיין "${c.campaign_name}"` +
        ' (סומן "סיימתי לכתוב") — אי אפשר לשייך אותו לפוסט מוקדם יותר');
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

  // המרווח לפי הקמפיין של התוכן שמשויך — פוסט שהיה תקין כחסר תוכן יכול
  // להיות צמוד מדי לשכן כשהתוכן בא מקמפיין עם מרווח ארוך; פוסט מקושר באותו
  // יום; ותוכן מסוג אחר שחורג מהתקרה לסוג. אזהרה שאפשר לאשר
  // (confirm_warnings / confirm_gap), כמו בהזזה ובפוסט ידני.
  const warning = softWarning(
    await gapWarning({
      endpointId: post.endpoint_id ?? c.endpoint_id, channelId: post.channel_id,
      when: post.scheduled_at, excludePostId: post.id, contentId: c.id,
    }),
    await linkDayWarning({ contentId: c.id, when: post.scheduled_at, excludePostId: post.id }),
    await capWarning({ channelId: post.channel_id, when: post.scheduled_at, kind: c.kind,
                       excludePostId: post.id }),
  );
  if (warning && !warningsConfirmed(req.body)) {
    return res.status(409).json({ error: warning.message, warning, needs_confirm: true });
  }

  // פוסט שאושר לפרסום אוטומטי חוזר ל"מתוכנן" — האישור לא היה על התוכן הזה
  const done = await attachToPost(post.id, {
    content_id: c.id, title: c.title, kind: c.kind, endpoint_id: c.endpoint_id,
  });
  if (!done) return bad(res, 'הפוסט השתנה בינתיים — רעננו ונסו שוב', 409);
  // שיוך מפורש גובר על חסימה ממחיקה קודמת של אותו תוכן בערוץ (סעיף 14)
  await liftDismissals(c.id, post.channel_id);
  // תוכן בלי טקסט ובלי מדיה (כותרת בלבד): "לכתוב" נשארת פתוחה — attachToPost,
  // אותו כלל כמו במילוי של המנוע
  res.json({ post: done.post, draft: c.variant_status !== 'ready',
             approval_reset: done.approval_reset });
}));

/** מאילו מצבים מותר לסמן "פורסם" ביד — לא ממתין לאישור, לא באמצע פרסום, לא פעמיים */
export const MARKABLE_STATUSES = ['scheduled', 'approved', 'failed'];

/**
 * published_at של סימון ידני: המועד המתוכנן כשהוא כבר עבר (השעה האמיתית
 * לא ידועה, ושעת הלחיצה — שבוע אחרי, לפעמים — בטוח לא נכונה), אחרת עכשיו.
 * אותו ביטוי בסימון בודד ובסימון המרוכז.
 */
export const MARK_PUBLISHED_AT_SQL =
  'case when p.scheduled_at < now() then p.scheduled_at else now() end';

export const MARK_STATUS_ERROR = {
  published: 'הפוסט כבר מסומן כפורסם',
  publishing: 'הפוסט מתפרסם ממש עכשיו — אי אפשר לסמן אותו ביד',
  pending_approval: 'הפוסט ממתין לאישור — קודם מאשרים או דוחים אותו',
};

/** סימון "פורסם" — מעדכן גם את המשימה הצמודה */
r.post('/posts/:id/publish', requirePerm('content'), wrap(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return bad(res, 'לא נמצא שיבוץ כזה', 404);
  const post = await one(
    `update posts p set status = 'published', published_at = ${MARK_PUBLISHED_AT_SQL}
      where p.id = $1 and p.status = any($2) returning *`,
    [req.params.id, MARKABLE_STATUSES]
  );
  if (!post) {
    const cur = await one('select status from posts where id = $1', [req.params.id]);
    if (!cur) return bad(res, 'לא נמצא שיבוץ כזה', 404);
    return bad(res, MARK_STATUS_ERROR[cur.status] ?? 'אי אפשר לסמן את הפוסט הזה כפורסם', 409);
  }
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

/** כמה פוסטים אפשר לסמן בבת אחת (כמו BULK_MAX של המשימות) */
export const PUBLISH_BULK_MAX = 200;

/** רשימת מזהים לסימון מרוכז: 1–200 מספרים שלמים חיוביים. { ids } או { error } */
export function parsePostIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return { error: 'לא נבחרו פוסטים' };
  if (ids.length > PUBLISH_BULK_MAX) return { error: `אפשר לסמן עד ${PUBLISH_BULK_MAX} פוסטים בבת אחת` };
  const ok = ids.every((v) => /^\d+$/.test(String(v)) && Number(v) > 0 && Number(v) <= 2147483647);
  if (!ok) return { error: 'רשימת הפוסטים לא תקינה' };
  return { ids: [...new Set(ids.map(Number))] };
}

/** "לא אושר שיצא" — השורות של חלון האישור (אותה רשימה שההתראה סופרת) */
r.get('/posts/unconfirmed', wrap(async (_req, res) => {
  res.json({ posts: await unconfirmedPosts() });
}));

/**
 * "סמן שפורסמו" מחלון האישור: אותו כלל כמו סימון בודד (MARKABLE_STATUSES,
 * published_at = המועד כשהוא עבר) בפקודה אחת. מה שכבר לא במצב שמותר לסמן
 * (סומן בינתיים, נמחק, ממתין לאישור) — מדולג ונספר ב-skipped.
 */
r.post('/posts/publish-bulk', requirePerm('content'), wrap(async (req, res) => {
  const parsed = parsePostIds(req.body?.ids);
  if (parsed.error) return bad(res, parsed.error);
  const posts = await rows(
    `update posts p set status = 'published', published_at = ${MARK_PUBLISHED_AT_SQL}
      where p.id = any($1::int[]) and p.status = any($2) returning *`,
    [parsed.ids, MARKABLE_STATUSES]
  );
  if (posts.length) {
    const marked = posts.map((p) => p.id);
    await query(
      'update tasks set done = true, done_at = now() where post_id = any($1::int[]) and done = false',
      [marked]);
    // אירוע ל-HUB לכל פוסט — כמו בסימון בודד, אבל בלי לחכות: עשרות קריאות
    // ברצף היו מחזיקות את הבקשה (ואת הטרנזקציה) פתוחה. לא זורק לעולם.
    const chans = new Map((await rows('select id, name, platform from channels where id = any($1::int[])',
      [[...new Set(posts.map((p) => p.channel_id))]])).map((c) => [c.id, c]));
    for (const post of posts) {
      const ch = chans.get(post.channel_id);
      void emitPostEvent('post_published', { ...post, channel_name: ch?.name, platform: ch?.platform });
    }
  }
  res.json({ marked: posts.length, skipped: parsed.ids.length - posts.length });
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
export const APPROVE_PAST = 'המועד עבר — קבעו מועד חדש ואז אשרו';

r.post('/posts/:id/approve', requirePerm('approve'), wrap(async (req, res) => {
  const cur = await one('select id, status, scheduled_at from posts where id = $1', [req.params.id]);
  if (!cur || cur.status !== 'pending_approval') {
    return bad(res, 'אין שיבוץ שממתין לאישור עם המזהה הזה', 404);
  }
  // מועד שעבר: אישור היה משאיר "מתוכנן" שכבר לא יצא — קודם מועד חדש
  if (new Date(cur.scheduled_at) <= new Date()) return bad(res, APPROVE_PAST);
  const post = await one(
    `update posts set status = 'scheduled' where id = $1 and status = 'pending_approval'
      returning *`,
    [req.params.id]
  );
  if (!post) return bad(res, 'אין שיבוץ שממתין לאישור עם המזהה הזה', 404);
  await query(`update tasks set done = true, done_at = now() where post_id = $1`, [post.id]);
  res.json({ post });
}));

/**
 * "אשר את כל המבצע": כל הפוסטים של אותו מבצע דחוף (urgent_group) שעוד ממתינים
 * לאישור עוברים למתוכנן, ומשימות האישור שלהם נסגרות — כמו אישור של כל אחד.
 */
r.post('/posts/:id/approve-group', requirePerm('approve'), wrap(async (req, res) => {
  const group = `urgent_group is not null
        and urgent_group = (select urgent_group from posts where id = $1)`;
  // מה שהמועד שלו עבר לא מאושר — חוזר ב-skipped, כמו באישור בודד
  const skipped = await rows(
    `select id, title, channel_id from posts
      where status = 'pending_approval' and ${group} and scheduled_at <= now()`,
    [req.params.id]
  );
  const approved = await rows(
    `update posts set status = 'scheduled'
      where status = 'pending_approval' and ${group} and scheduled_at > now()
      returning id`,
    [req.params.id]
  );
  if (approved.length === 0) {
    return skipped.length ? bad(res, APPROVE_PAST)
      : bad(res, 'אין במבצע הזה פוסטים שממתינים לאישור', 404);
  }
  const ids = approved.map((x) => x.id);
  await query(
    `update tasks set done = true, done_at = now() where post_id = any($1::int[]) and done = false`, [ids]);
  res.json({ approved: ids.length, ids, skipped });
}));

/**
 * דחיית פוסט שממתין לאישור (מבצע דחוף של מי שאין לו הרשאת אישור) — הפוסט
 * נמחק, ומשימת האישור שלו איתו (cascade). הרשאת approve, כמו האישור עצמו —
 * לא DELETE /posts, שדורש הרשאת תוכן. בלי מילוי מחדש: המקום נשאר פנוי.
 */
r.post('/posts/:id/reject', requirePerm('approve'), wrap(async (req, res) => {
  const post = await one(
    `delete from posts where id = $1 and status = 'pending_approval'
      returning id, content_id, channel_id, scheduled_at`,
    [req.params.id]
  );
  if (!post) return bad(res, 'אין פוסט שממתין לאישור עם המזהה הזה', 404);
  if (post.content_id) await recordDismissals([post]);
  res.json({ ok: true });
}));

export default r;
