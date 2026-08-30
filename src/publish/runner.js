import { one, query, rows } from '../db.js';
import { decryptSecret } from './crypto.js';
import { publishFacebook, publishInstagram } from './meta.js';
import { deletePublicAssets, publicAssetsReady, uploadPublicAsset } from './public-assets.js';
import { createNewsletter, hubMailReady, newsletterStatus } from '../hub-mail.js';
import { emitHubEventSafe } from '../hub-events.js';

/**
 * מסלול הפרסום האוטומטי.
 *
 * publishTick רץ כל דקה (server.js), לכל ארגון בנפרד:
 *   פוסט בסטטוס approved שהגיע זמנו → publishing → קריאת API → published.
 *   כשל → failed + משימה דחופה. שום דבר לא נעלם בשקט — הכול נרשם
 *   ב-publish_log וביומן הפעולות.
 *
 * וואטסאפ (קבוצה) — אין API רשמי, ולכן חצי-אוטומטי: כשמגיע הזמן נוצרת
 * משימה דחופה עם הטקסט המוכן, והמשתמש שולח ומסמן "פורסם" בעצמו.
 */

const MAX_LATE_HOURS = 12;   // approved שפוספס ביותר מזה — נכשל, לא מתפרסם באיחור
const WA_AHEAD_MINUTES = 15; // כמה דקות לפני הזמן נוצרת משימת הוואטסאפ

const isImage = (m) => /^image\//.test(m);
const isVideo = (m) => /^video\//.test(m);

const decryptToken = (post) => {
  try { return decryptSecret(post.access_token_enc); } catch { return null; }
};

/**
 * אירוע יוצא ל-HUB על גורל פוסט. fire-and-forget: כשל = לוג, הפרסום עצמו
 * לא תלוי בזה. id = "<type>:<post id>" — retry לעולם לא נרשם פעמיים.
 */
export const emitPostEvent = (type, post, extra = {}) =>
  emitHubEventSafe({
    id: `${type}:${post.id}`,
    type,
    data: {
      post_id: post.id, title: post.title, channel: post.channel_name,
      platform: post.platform, kind: post.kind, ...extra,
    },
  });

async function logPublish(post, ok, { externalId = null, error = null } = {}) {
  await query(
    `insert into publish_log (post_id, channel_id, platform, ok, external_id, error)
     values ($1,$2,$3,$4,$5,$6)`,
    [post.id, post.channel_id, post.platform, ok, externalId, error]
  ).catch((e) => console.error('כתיבה ל-publish_log נכשלה:', e.message));
}

async function logActivity(action, post, summary) {
  await query(
    `insert into activity_log (user_id, user_name, via, action, entity, entity_id, summary)
     values (null, 'פרסום אוטומטי', 'system', $1, 'posts', $2, $3)`,
    [action, String(post.id), summary]
  ).catch((e) => console.error('כתיבה ליומן הפעולות (פרסום) נכשלה:', e.message));
}

/** הפוסט + הערוץ + החיבור + הגרסה + הקבצים — כל מה שצריך לפרסום אחד */
export async function loadPayload(postId) {
  const post = await one(
    `select p.*, c.name as channel_name, c.platform,
            cc.page_id, cc.ig_user_id, cc.access_token_enc, cc.auto_enabled
       from posts p
       join channels c on c.id = p.channel_id
       left join channel_connections cc on cc.channel_id = c.id
      where p.id = $1`,
    [postId]
  );
  if (!post) return null;

  const variant = post.content_id
    ? await one('select * from content_variants where content_id = $1 and channel_id = $2',
                [post.content_id, post.channel_id])
    : null;

  const assets = post.content_id
    ? await rows(
        `select id, filename, mime, size_bytes, data
           from content_assets
          where content_id = $1 and (variant_id is null or variant_id = $2)
          order by variant_id nulls last, id`,
        [post.content_id, variant?.id ?? null])
    : [];

  return { post, variant, assets };
}

/** מה חוסם את הפוסט מפרסום אוטומטי? null = כלום, אפשר לפרסם. */
export function publishBlocker({ post, variant, assets }) {
  // ניוזלטר: השליחה בפועל דרך ה-HUB — נדרשים חיבור, נושא ורשימת יעד
  if (post.platform === 'newsletter') {
    if (!hubMailReady()) return 'חיבור ה-HUB לא מוגדר (HUB_API_URL / HUB_API_KEY בשרת)';
    if (!post.content_id) return 'אין תוכן משויך לשיבוץ';
    if (!variant || variant.status !== 'ready') return 'הגרסה למדיה הזו עוד לא מסומנת "מוכן"';
    const m = variant.meta ?? {};
    // התוכן חי או בגוף הגרסה או במילוי הממלא של ה-HUB (שדה תוכן בתבנית)
    const hasFilledContent = Object.entries(m.field_values ?? {}).some(
      ([k, val]) => ['תוכן', 'גוף הגיליון', 'גוף ההודעה'].includes(k) && String(val ?? '').trim());
    if (!variant.body?.trim() && !hasFilledContent) {
      return 'אין תוכן למייל — ממלאים בעריכת הגרסה (כפתור המילוי או שדה התוכן)';
    }
    if (!m.subject?.trim()) return 'חסר נושא למייל — ממלאים בעריכת הגרסה של ערוץ המייל';
    // בלי רשימה — ה-HUB שולח לרשימת העל (ברירת המחדל שלו); אין חסימה.
    return null;
  }

  if (!['facebook', 'instagram'].includes(post.platform)) {
    return `הערוץ "${post.channel_name}" לא מחובר לפרסום אוטומטי (${post.platform === 'whatsapp' ? 'וואטסאפ נשלח ידנית' : 'אין אינטגרציה'})`;
  }
  if (!post.access_token_enc) return 'אין חיבור פעיל לערוץ — מגדירים בניהול → ערוצי פרסום';
  if (post.platform === 'facebook' && !post.page_id) return 'חסר מזהה עמוד פייסבוק בחיבור';
  if (post.platform === 'instagram' && !post.ig_user_id) return 'חסר מזהה חשבון אינסטגרם בחיבור';
  if (!post.content_id) return 'אין תוכן משויך לשיבוץ';
  if (!variant || variant.status !== 'ready') return 'הגרסה למדיה הזו עוד לא מסומנת "מוכן"';

  const media = assets.filter((a) => isImage(a.mime) || isVideo(a.mime));
  if (post.platform === 'instagram') {
    if (!media.length) return 'אינסטגרם דורש תמונה או וידאו — אין מדיה לפוסט';
    if (!publicAssetsReady()) return 'הגשת מדיה ציבורית לא מוגדרת (R2_PUBLIC_*) — נדרשת לאינסטגרם';
  }
  if (post.platform === 'facebook' && !media.length && !variant.body?.trim()) {
    return 'אין טקסט ואין מדיה — אין מה לפרסם';
  }
  return null;
}

/**
 * פרסום פוסט אחד, מקצה לקצה. allowedFrom קובע מאילו סטטוסים מותר
 * לתפוס אותו (הטיק תופס רק approved; "פרסם עכשיו" גם scheduled/failed).
 * @returns {{ok: boolean, post?: object, error?: string}}
 */
export async function publishOne(postId, { allowedFrom = ['approved'] } = {}) {
  // תפיסה אטומית: רק מי שהצליח להעביר ל-publishing ממשיך — בלי פרסום כפול
  const claimed = await one(
    `update posts set status = 'publishing'
      where id = $1 and status = any($2) returning id`,
    [postId, allowedFrom]
  );
  if (!claimed) return { ok: false, error: 'הפוסט לא במצב שמאפשר פרסום' };

  const fail = async (post, error) => {
    await query(
      `update posts set status = 'failed', publish_error = $2 where id = $1`,
      [postId, error]);
    if (post) {
      await logPublish(post, false, { error });
      await logActivity('publish_failed', post, `פרסום אוטומטי נכשל — "${post.title}" ל${post.channel_name}: ${error}`);
      await emitPostEvent('post_publish_failed', post, { error });
      await query(
        `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on)
         values ($1,$2,'general',$3,$4,true,current_date)`,
        [`פרסום אוטומטי נכשל — ${post.channel_name}`,
         `"${post.title}": ${error}`, post.id, post.endpoint_id]
      ).catch((e) => console.error('יצירת משימת כשל נכשלה:', e.message));
    }
    return { ok: false, error };
  };

  let payload;
  try {
    payload = await loadPayload(postId);
  } catch (e) {
    return fail(null, `שליפת נתוני הפוסט נכשלה: ${e.message}`);
  }
  if (!payload) return fail(null, 'הפוסט נעלם');

  const { post, variant, assets } = payload;
  const blocker = publishBlocker(payload);
  if (blocker) return fail(post, blocker);

  const media = assets.filter((a) => isImage(a.mime) || isVideo(a.mime));
  const text = variant.body?.trim() ?? '';
  const publicKeys = [];

  try {
    let result;
    if (post.platform === 'newsletter') {
      // השליחה בפועל אצל ה-HUB. external_ref = מזהה הפוסט — idempotent:
      // retry לעולם לא שולח פעמיים. ה-HUB רשאי לסרב (HubMailError עם הודעה
      // בעברית) — ההודעה מוצגת כמו שהיא דרך מסלול הכשל הרגיל.
      const m = variant.meta ?? {};
      const r = await createNewsletter({
        externalRef: `post-${post.id}`,
        subject: m.subject,
        htmlBody: variant.body,
        listIds: m.list_ids ?? [],
        segmentIds: m.segment_ids ?? [],
        name: post.title,
        fieldValues: m.field_values ?? {},
      });
      if (r.status !== 'sent') {
        // ה-HUB קיבל והשליחה אסינכרונית אצלו — נשארים publishing,
        // ו-pollNewsletterOutcomes יסגור ל-published/failed לפי הסטטוס שם.
        await query(
          `update posts set external_id = $2, publish_error = null where id = $1`,
          [post.id, r.campaign_id]);
        await logPublish(post, true, { externalId: r.campaign_id });
        await logActivity('publish', post,
          `ניוזלטר "${post.title}" התקבל ב-HUB` +
          (r.recipient_count != null ? ` (${r.recipient_count} נמענים)` : '') +
          ' — ממתין לשליחה בפועל');
        console.log(`ניוזלטר #${post.id} ("${post.title}") התקבל ב-HUB — קמפיין ${r.campaign_id}`);
        return { ok: true, pending: true, post: await one('select * from posts where id = $1', [post.id]) };
      }
      result = { id: r.campaign_id, url: null };
    } else if (post.platform === 'facebook') {
      const token = decryptToken(post);
      if (!token) return fail(post, 'פענוח הטוקן נכשל — מזינים אותו מחדש בהגדרות הערוץ');
      result = await publishFacebook({
        pageId: post.page_id, token, message: text,
        assets: media.map((a) => ({ buffer: a.data, mime: a.mime, filename: a.filename })),
      });
    } else {
      // אינסטגרם מושך מ-URL ציבורי — העלאה זמנית ל-R2, מחיקה אחרי
      const token = decryptToken(post);
      if (!token) return fail(post, 'פענוח הטוקן נכשל — מזינים אותו מחדש בהגדרות הערוץ');
      const uploaded = [];
      for (const a of media) {
        const { url, key } = await uploadPublicAsset({
          buffer: a.data, mime: a.mime, filename: a.filename,
        });
        publicKeys.push(key);
        uploaded.push({ url, video: isVideo(a.mime) });
      }
      result = await publishInstagram({
        igUserId: post.ig_user_id, token, caption: text, media: uploaded,
      });
    }

    const updated = await one(
      `update posts set status = 'published', published_at = now(),
              external_id = $2, external_url = $3, publish_error = null
        where id = $1 returning *`,
      [post.id, result.id, result.url]
    );
    await query(
      `update tasks set done = true, done_at = now() where post_id = $1 and done = false`,
      [post.id]);
    await logPublish(post, true, { externalId: result.id });
    await logActivity('publish', post, `פורסם אוטומטית — "${post.title}" ל${post.channel_name}`);
    await emitPostEvent('post_published', post,
      { external_id: result.id, ...(result.url ? { external_url: result.url } : {}) });
    console.log(`פורסם אוטומטית: פוסט #${post.id} ("${post.title}") ל${post.channel_name}`);
    return { ok: true, post: updated };
  } catch (e) {
    return fail(post, e.message);
  } finally {
    if (publicKeys.length) await deletePublicAssets(publicKeys);
  }
}

/** הטיק לארגון אחד: מפרסם את מה שאושר והגיע זמנו, ומכין משימות וואטסאפ */
export async function publishTickForOrg() {
  // סגירת ניוזלטרים שכבר נשלחו ל-HUB רצה גם כשמתג-העל כבוי — היא משלימה
  // פעולה שכבר אושרה ויצאה, לא מתחילה חדשה.
  await pollNewsletterOutcomes().catch((e) =>
    console.error('בדיקת סטטוס ניוזלטרים נכשלה:', e.message));

  const settings = await one('select autopublish_enabled from engine_settings limit 1');
  if (!settings?.autopublish_enabled) return;

  // פוסטים שאושרו והגיע זמנם. איחור גדול מדי לא מתפרסם — נכשל עם הסבר.
  // ניוזלטר לא צריך channel_connection (החיבור שלו הוא HUB_API_* בסביבה).
  const due = await rows(
    `select p.id, p.scheduled_at < now() - ($1 || ' hours')::interval as too_late
       from posts p
       join channels c on c.id = p.channel_id
       left join channel_connections cc on cc.channel_id = c.id
      where p.status = 'approved' and p.scheduled_at <= now()
        and (cc.auto_enabled = true or c.platform = 'newsletter')
      order by p.scheduled_at`,
    [MAX_LATE_HOURS]
  );

  for (const { id, too_late } of due) {
    if (too_late) {
      await one(`update posts set status = 'failed',
                        publish_error = 'המועד עבר מזמן — הפרסום לא בוצע כדי לא להפתיע. משבצים מחדש או מפרסמים ידנית.'
                  where id = $1 and status = 'approved'`, [id]);
      continue;
    }
    await publishOne(id).catch((e) => console.error(`פרסום פוסט #${id} נכשל:`, e.message));
  }

  await whatsappPrep().catch((e) => console.error('הכנת משימות וואטסאפ נכשלה:', e.message));
}

/**
 * וואטסאפ חצי-אוטומטי: קצת לפני הזמן נוצרת משימת "לשלוח בוואטסאפ"
 * דחופה עם הטקסט המוכן ב-meta. פעם אחת לכל פוסט.
 */
async function whatsappPrep() {
  const due = await rows(
    `select p.id, p.title, p.endpoint_id, p.scheduled_at, v.body
       from posts p
       join channels c on c.id = p.channel_id and c.platform = 'whatsapp'
       join content_variants v on v.content_id = p.content_id
            and v.channel_id = p.channel_id and v.status = 'ready'
      where p.status = 'scheduled'
        and p.scheduled_at between now() - interval '24 hours'
                               and now() + ($1 || ' minutes')::interval
        and not exists (
          select 1 from tasks t
           where t.post_id = p.id and t.kind = 'publish' and (t.meta->>'wa_send') = 'true'
        )`,
    [WA_AHEAD_MINUTES]
  );

  for (const p of due) {
    await query(
      `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on, meta)
       values ($1,$2,'publish',$3,$4,true,$5,$6)`,
      [`לשלוח בוואטסאפ: ${p.title}`,
       `הטקסט מוכן — פותחים את הפוסט בלוח, מעתיקים ושולחים לקבוצה, ואז מסמנים "פורסם"`,
       p.id, p.endpoint_id, new Date(p.scheduled_at).toISOString().slice(0, 10),
       JSON.stringify({ wa_send: true, body: p.body })]
    );
    console.log(`נוצרה משימת וואטסאפ לפוסט #${p.id} ("${p.title}")`);
  }
}

/* ========================= ניוזלטר: סגירת מעגל מול ה-HUB ========================= */

/** מדדי שליחה מה-HUB אל post_results. לא נוגע ב-note/leads שהוזנו ידנית. */
async function saveNewsletterMetrics(postId, counts) {
  if (!counts) return;
  await query(
    `insert into post_results (post_id, reach, engagement, clicks)
     values ($1,$2,$3,$4)
     on conflict (post_id) do update set
       reach = excluded.reach, engagement = excluded.engagement,
       clicks = excluded.clicks, updated_at = now()`,
    [postId, counts.delivered ?? null, counts.opened ?? null, counts.clicked ?? null]
  ).catch((e) => console.error(`שמירת מדדי ניוזלטר לפוסט #${postId} נכשלה:`, e.message));
}

/** כשל שה-HUB דיווח אחרי שהפוסט כבר התקבל שם (השליחה אסינכרונית אצלו) */
async function failFromHub(post, error) {
  await query(`update posts set status = 'failed', publish_error = $2 where id = $1`,
    [post.id, error]);
  await logPublish(post, false, { error });
  await logActivity('publish_failed', post,
    `שליחת ניוזלטר נכשלה — "${post.title}": ${error}`);
  await emitPostEvent('post_publish_failed', post, { error });
  await query(
    `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on)
     values ($1,$2,'general',$3,$4,true,current_date)`,
    [`שליחת ניוזלטר נכשלה — ${post.channel_name}`,
     `"${post.title}": ${error}`, post.id, post.endpoint_id]
  ).catch((e) => console.error('יצירת משימת כשל נכשלה:', e.message));
}

/**
 * פוסטים של ערוץ המייל שכבר התקבלו ב-HUB (publishing + external_id) —
 * שואל את ה-HUB מה קרה איתם וסוגר ל-published/failed. רץ בכל טיק; זול,
 * כי בדרך כלל אין אף פוסט במצב הזה.
 */
export async function pollNewsletterOutcomes() {
  if (!hubMailReady()) return;
  const pending = await rows(
    `select p.id, p.title, p.channel_id, p.endpoint_id, p.kind,
            c.name as channel_name, c.platform
       from posts p
       join channels c on c.id = p.channel_id and c.platform = 'newsletter'
      where p.status = 'publishing' and p.external_id is not null`
  );

  for (const post of pending) {
    let s;
    try {
      s = await newsletterStatus(`post-${post.id}`);
    } catch (e) {
      console.error(`בדיקת סטטוס ניוזלטר #${post.id} נכשלה:`, e.message);
      continue; // תקלה זמנית מול ה-HUB — ננסה שוב בטיק הבא
    }

    if (s.status === 'sent') {
      await query(
        `update posts set status = 'published', published_at = now(), publish_error = null
          where id = $1`, [post.id]);
      await query(
        `update tasks set done = true, done_at = now() where post_id = $1 and done = false`,
        [post.id]);
      await saveNewsletterMetrics(post.id, s.counts);
      await logActivity('publish', post, `הניוזלטר "${post.title}" נשלח דרך ה-HUB`);
      await emitPostEvent('post_published', post, { external_id: s.campaign_id ?? null });
      console.log(`ניוזלטר #${post.id} ("${post.title}") נשלח — עודכן ל-published`);
    } else if (['failed', 'cancelled'].includes(s.status)) {
      await failFromHub(post,
        s.status === 'cancelled' ? 'הקמפיין בוטל בצד ה-HUB' : 'ה-HUB דיווח על כשל בשליחה');
    }
    // scheduled / sending — עוד באוויר, בודקים שוב בטיק הבא
  }
}

/**
 * רענון מדדים (delivered/opened/clicked) לניוזלטרים שכבר נשלחו — פתיחות
 * וקליקים ממשיכים להצטבר ימים אחרי השליחה. רץ פעם בשעה, שבוע אחורה.
 */
export async function refreshNewsletterMetrics() {
  if (!hubMailReady()) return;
  const recent = await rows(
    `select p.id from posts p
       join channels c on c.id = p.channel_id and c.platform = 'newsletter'
      where p.status = 'published' and p.external_id is not null
        and p.published_at >= now() - interval '7 days'`
  );

  for (const { id } of recent) {
    try {
      const s = await newsletterStatus(`post-${id}`);
      await saveNewsletterMetrics(id, s.counts);
    } catch (e) {
      console.error(`רענון מדדי ניוזלטר #${id} נכשל:`, e.message);
    }
  }
}
