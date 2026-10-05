import { one, rows, query } from './db.js';
import { weekMeta, ymd, effectiveCadenceDays } from './board.js';
import { performanceMultipliers, hourBucket } from './performance.js';
import { candidateFilterSql, fitsSlotChannel } from './candidates.js';

/**
 * מנוע השיבוץ.
 *
 * הכלל המרכזי: המנוע לא נוגע בשום דבר שכבר על הלוח. הוא ממלא רק שטח פנוי,
 * ולכן אפשר להריץ אותו שוב ושוב על אותו שבוע בלי לשבור כלום.
 *
 * לכל נקודת קצה מחושב "חוב אוויר" משלושה מרכיבים, וההצעה הולכת תמיד
 * לנקודה עם החוב הגבוה ביותר שיש לה תוכן מוכן ומקום שמותר לה לשבת בו.
 */

// משקלים של רכיבי החוב. שינוי כאן משנה את אופי המנוע:
// יותר STALENESS = "אף אחד לא נשכח", יותר STRATEGY = "נצמדים ליעדי הרבעון".
const W_STALENESS = 1.0;  // כמה זמן עבר מאז שהנקודה פורסמה, ביחס לקצב שהוגדר לה
const W_STRATEGY  = 0.8;  // כמה היא מפגרת אחרי יעד האסטרטגיה
const W_IMPORTANCE = 0.5; // החשיבות הידנית שהוגדרה לה
// יעילות שנמדדה בפועל. פועל רק כשהמתג use_performance דלוק, ובכוונה
// נמוך מהוותק — מה שעבד טוב מקבל דחיפה, אבל נקודה חלשה לא נעלמת מהלוח.
const W_PERFORMANCE = 0.6;

const DEFAULT_HOUR = 10;
const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/**
 * מתכנן שבוע. לא כותב כלום.
 *
 * holes:false — המילוי האוטומטי שרץ אחרי כל שינוי: משבץ ומשייך רק תוכן
 * קיים, ולא מציע פוסטים חסרי תוכן. אותם (ואת משימות "לכתוב" שלהם) מציע
 * רק חלון "מלא את השבוע", שבו המשתמש רואה ומאשר כל פריט.
 *
 * @param {string|Date} [anchorDate] תאריך כלשהו בתוך השבוע המבוקש
 * @param {{holes?:boolean}} [opts]
 * @returns {Promise<{week:object, placements:object[], attachments:object[], holes:object[], notes:string[]}>}
 */
export async function planWeek(anchorDate, { holes: withHoles = true } = {}) {
  const week = weekMeta(anchorDate);
  const from = week.startDate;
  const to = new Date(week.endDate);
  to.setHours(23, 59, 59, 999);

  const [settings, channels, endpoints, content, existing, campaigns, dismissals] = await Promise.all([
    one('select * from engine_settings limit 1'),
    rows('select * from channels where active = true order by sort_order, id'),
    rows('select * from endpoints where active = true'),
    // הזווית נושאת את השיוך; הגרסה קובעת אם היא מוכנה למדיה מסוימת.
    // תוכן של קמפיין מושהה לא נכנס לתכנון.
    //
    // ready_channel_ids — רק גרסה שסומנה "מוכן". eligible_channel_ids — גם
    // טיוטה: השיבוץ הולך לפי האסטרטגיה, לא לפי אם כבר נכתב טקסט סופי.
    // המנוע ממשיך להעדיף מוכן על פני טיוטה כשיש ברירה (ראו chooseForSlot).
    // תאריכי הקמפיין נשלפים עם התוכן: תוכן של קמפיין לא יוצא לפני
    // starts_on ולא אחרי ends_on (ראו outsideCampaignWindow).
    rows(`select ci.*,
                 ca.starts_on as campaign_starts_on, ca.ends_on as campaign_ends_on,
                 coalesce(
                   array_agg(v.channel_id) filter (where v.status = 'ready'),
                   '{}'
                 ) as ready_channel_ids,
                 coalesce(
                   array_agg(v.channel_id) filter (where v.status in ('ready','draft')),
                   '{}'
                 ) as eligible_channel_ids
            from content_items ci
            left join content_variants v on v.content_id = ci.id
            left join campaigns ca on ca.id = ci.campaign_id
           where (ca.id is null or ca.paused_at is null)
             -- משבצת של קמפיין כללי שהמדיה שלה הוסרה מהקמפיין: נשמרת, לא משובצת
             and (ci.slot_channel_id is null or exists (
                   select 1 from campaign_channels cc
                    where cc.campaign_id = ci.campaign_id and cc.channel_id = ci.slot_channel_id))
           group by ci.id, ca.id
           order by ci.created_at`),
    // שיבוץ של קמפיין מושהה יורד מהלוח (board.js) ולכן גם לא אמור לתפוס
    // מקום בקיבולת שהמנוע רואה — אחרת ערוץ נראה מלא בזמן שהלוח הפעיל ריק.
    // פוסט שכבר פורסם נשאר תפוס גם אם הקמפיין הושהה אחרי מכן — זו עובדה
    // שכבר קרתה, בדיוק כמו ב-board.js.
    rows(
      `select p.id, p.channel_id, p.endpoint_id, p.content_id, p.kind, p.scheduled_at, p.status,
              p.title, p.published_at, p.auto_hole
         from posts p
         left join content_items ci on ci.id = p.content_id
         left join campaigns ca     on ca.id = ci.campaign_id
        where p.scheduled_at >= $1 and p.scheduled_at <= $2
          and p.status in ('scheduled','approved','publishing','failed','published','pending_approval')
          and (ca.paused_at is null or p.status = 'published')`,
      [from, to]
    ),
    rows('select * from campaigns where active = true and paused_at is null'),
    // תוכן שהמשתמש הוריד מהשבוע הזה (מחיקת פוסט / ביטול מילוי) — לא חוזר
    rows('select content_id, channel_id from engine_dismissals where week_start = $1', [week.start]),
  ]);

  const notes = [];
  if (channels.length === 0) notes.push('אין ערוצים פעילים.');
  if (endpoints.length === 0) notes.push('אין נקודות קצה פעילות.');
  if (content.length === 0) {
    notes.push(withHoles
      ? 'אין תוכן מוכן — המנוע יכול רק לסמן פוסטים חסרי תוכן.'
      : 'אין תוכן מוכן לשיבוץ.');
  }

  // יעילות נמדדת מתוצאות אמיתיות. נטענת רק כשהמתג דלוק — כשהוא כבוי
  // אין אפילו שאילתה, והמנוע מתנהג בדיוק כמו לפני הפיצ'ר.
  const perf = settings?.use_performance ? await performanceMultipliers() : null;

  const debts = await computeDebts(endpoints, settings, perf);

  // מצב מתגלגל של הקיבולת. מתעדכן תוך כדי התכנון.
  const usage = buildUsage(channels, existing, settings);

  // תוכן שכבר משובץ השבוע — או שהמשתמש הוריד מהשבוע — לא יוצע שוב לאותו ערוץ
  const usedContent = blockedContent(existing, dismissals);

  // ההיסטוריה המלאה של כל פריט תוכן — בלעדיה תוכן חד-פעמי היה חוזר לאוויר
  // בכל שבוע שבו הוא לא במקרה משובץ
  const history = await contentHistory();

  // קודם ממלאים את מה שכבר על הלוח וחסר לו תוכן, ורק אחר כך פותחים פוסטים
  // חדשים — אחרת תוכן שנכתב בדיוק בשביל פוסט ריק נוחת במשבצת אחרת והריק נשאר.
  const attachments = chooseHoleFills({
    // מילוי שקט (holes:false) משייך רק לפוסטים שהמנוע עצמו יצר כחסרי תוכן;
    // החלון הידני מציע לכל פוסט חסר תוכן — שם המשתמש רואה ובוחר
    holes: openHoles(existing, channels, endpoints, new Date(), { autoOnly: !withHoles }),
    content, usedContent, history, settings, usage,
  }).map((a) => ({
    ...a,
    channel_name: channels.find((ch) => ch.id === a.channel_id)?.name ?? '',
    endpoint_name: endpoints.find((e) => e.id === a.endpoint_id)?.name ?? '',
    key: planItemKey('attach', a),
  }));

  // נקודת קצה לא מקבלת שני פוסטים באותה מדיה באותו יום.
  // בלי זה אפשר להגיע למצב שבו באותו יום ובאותו ערוץ יוצא גם תוכן מכירתי
  // וגם תוכן ערך על אותה נקודה, וזה קורא כמו שתי הודעות סותרות.
  const sameDay = new Set(
    existing
      .filter((p) => p.endpoint_id)
      .map((p) => `${p.endpoint_id}:${p.channel_id}:${ymd(new Date(p.scheduled_at))}`)
  );

  // המרווח האחרון של כל נקודה בכל ערוץ, כדי לכבד min_gap_days
  const lastPerPair = await lastPostPerEndpointChannel();

  const placements = [];

  // כל שילוב (ערוץ, יום) אפשרי. הסדר נקבע תוך כדי, לא מראש — ראו nextSlot.
  const pending = new Set(buildSlots(week, channels, perf));

  while (pending.size) {
    const slot = nextSlot(pending, usage, week);
    pending.delete(slot);
    if (!usage.channelHasRoom(slot.channel_id)) continue;

    const pick = chooseForSlot({
      slot, endpoints, content, campaigns, debts, usage,
      usedContent, lastPerPair, settings, placements, history, sameDay,
    });
    if (!pick) continue;

    const at = new Date(slot.date);
    at.setHours(DEFAULT_HOUR, 0, 0, 0);
    // התנגשות שעה באותו ערוץ באותו יום — מזיזים שעה קדימה
    let hour = DEFAULT_HOUR;
    while (usage.hourTaken(slot.channel_id, slot.dateKey, hour) && hour < 22) hour += 1;
    at.setHours(hour, 0, 0, 0);

    const placement = {
      channel_id: slot.channel_id,
      channel_name: slot.channel_name,
      endpoint_id: pick.endpoint.id,
      endpoint_name: pick.endpoint.name,
      content_id: pick.content.id,
      title: pick.content.title,
      kind: pick.content.kind,
      scheduled_at: at.toISOString(),
      date: slot.dateKey,
      day_label: `${HE_DAYS[at.getDay()]} ${at.getDate()}.${at.getMonth() + 1}`,
      time: `${String(hour).padStart(2, '0')}:00`,
      reason: pick.reason,
      score: Number(pick.score.toFixed(2)),
    };
    placement.key = planItemKey('placement', placement);
    placements.push(placement);

    usage.take(slot.channel_id, slot.dateKey, pick.content.kind, hour);
    usedContent.add(`${slot.channel_id}:${pick.content.id}`);
    sameDay.add(`${pick.endpoint.id}:${slot.channel_id}:${slot.dateKey}`);
    lastPerPair.set(`${pick.endpoint.id}:${slot.channel_id}`, slot.dateKey);
    debts.markScheduled(pick.endpoint.id);
  }

  const holes = withHoles
    ? findHoles({ endpoints, content, debts, channels, usage, week, existing })
        .map((h) => ({ ...h, key: planItemKey('hole', h) }))
    : [];

  const ratio = usage.ratioReport();
  if (ratio.promoBlocked > 0) {
    notes.push(
      `נחסמו פוסטים מכירתיים כדי לשמור על יחס של ${ratio.minRatio} ערך לכל מכירתי. ` +
      `כדי לפרסם יותר מכירתי — צריך יותר תוכן ערך מוכן.`
    );
  }

  return {
    week: { start: week.start, end: week.end, label: week.label },
    placements,
    attachments,
    holes,
    ratio,
    notes,
  };
}

// שרשרת שממתינה שהריצה הקודמת תיגמר, כדי שתי הרצות חופפות (למשל שינוי
// כלל ואז מיד גרירת קמפיין) לא יחשבו את אותה משבצת פנויה פעמיים.
let applyChain = Promise.resolve();
export function withEngineLock(fn) {
  const run = applyChain.then(fn, fn);
  applyChain = run.catch(() => {});
  return run;
}

/**
 * מתכננת שבוע וכותבת בפועל את מה שהיא הציעה: פוסטים חדשים למשבצות פנויות,
 * תוכן לפוסטים קיימים שחסר להם תוכן, ו — רק כש-holes דלוק (חלון "מלא את
 * השבוע") — פוסטים חסרי תוכן עם משימת "לכתוב". לא מזיזה שום דבר שעל הלוח.
 *
 * selected — רשימת מפתחות (key) מתוך ההצעה שהמשתמש ראה. התכנון רץ שוב
 * טרי (כדי לא לכתוב על סמך מצב ישן), ונכתב רק מה שגם נבחר וגם עדיין
 * מופיע בהצעה הטרייה. מה שנבחר ונעלם בינתיים נספר ב-skipped.
 *
 * @param {string|Date} [anchorDate]
 * @param {{holes?:boolean, selected?:string[]|null}} [opts]
 * @returns {Promise<{placed:number, attached:number, holes:number, skipped:number,
 *   created_ids:number[], attached_items:object[], summary:object[]}>}
 */
export async function applyWeek(anchorDate, { holes: withHoles = true, selected = null } = {}) {
  const fresh = await planWeek(anchorDate, { holes: withHoles });
  const { plan, skipped } = selectPlanItems(fresh, selected);

  const createdIds = [];
  const summary = [];
  const brief = (x, attach = false) =>
    ({ title: x.title, channel_name: x.channel_name, day_label: x.day_label, attach });

  for (const p of plan.placements) {
    const post = await one(
      `insert into posts (channel_id, endpoint_id, content_id, title, kind,
                          scheduled_at, status, note)
       values ($1,$2,$3,$4,$5,$6,'scheduled',$7) returning id`,
      [p.channel_id, p.endpoint_id, p.content_id, p.title, p.kind, p.scheduled_at, p.reason]
    );
    createdIds.push(post.id);
    summary.push(brief(p));
  }

  // השם והסוג הקודמים חוזרים ללקוח, כדי ש"בטל" יחזיר את הפוסט בדיוק כמו שהיה
  const attached = [];
  for (const a of plan.attachments) {
    const done = await attachToPost(a.post_id, a);
    if (!done) continue; // מישהו שייך תוכן לפוסט הזה בינתיים, או שהמועד עבר
    attached.push({ post_id: a.post_id, content_id: a.content_id,
                    prev_title: a.prev_title, prev_kind: a.prev_kind });
    summary.push(brief(a, true));
  }

  let holeCount = 0;
  for (const h of plan.holes) {
    // status='scheduled', לא 'hole': המשבצת משובצת לפי האסטרטגיה כמו כל
    // שיבוץ אחר (תופסת קיבולת אמיתית, נספרת בסיכום) — רק שאין לה תוכן
    // עדיין. content_id נשאר null, ולכן הלוח מסמן אותה "חסר תוכן".
    const post = await one(
      `insert into posts (channel_id, endpoint_id, title, kind, scheduled_at, status, note, auto_hole)
       values ($1,$2,'חסר תוכן',$3,$4,'scheduled',$5,true) returning id`,
      [h.channel_id, h.endpoint_id, h.kind, h.scheduled_at, h.reason]
    );
    createdIds.push(post.id);
    holeCount += 1;
    await query(
      `insert into tasks (title, subtitle, kind, post_id, endpoint_id, urgent, due_on)
       values ($1,$2,'write',$3,$4,true,$5)`,
      [`לכתוב: תוכן ערך על "${h.endpoint_name}" ל${h.channel_name}`,
       `${h.reason} · הלוח מחכה לזה ל${h.day_label}`,
       post.id, h.endpoint_id, h.date]
    );
  }

  return {
    placed: plan.placements.length,
    attached: attached.length,
    holes: holeCount,
    skipped,
    created_ids: createdIds,
    attached_items: attached,
    summary,
  };
}

/**
 * משייך תוכן לפוסט קיים שאין לו תוכן: הכותרת והסוג מהתוכן, נקודת הקצה
 * רק אם לא הייתה. משימות "לכתוב" ו"החלפה" של הפוסט נסגרות — התנאי שלהן
 * נפתר. פוסט שאושר לפרסום אוטומטי חוזר ל"מתוכנן": האישור ניתן לפוסט בלי
 * התוכן הזה. מחזיר null אם בינתיים כבר יש לפוסט תוכן, הוא יצא לאוויר,
 * או שהמועד שלו עבר. משמש גם את המנוע וגם את "שייך תוכן" בחלון הפוסט.
 * @returns {Promise<{post:object, closed_task_ids:number[], approval_reset:boolean}|null>}
 */
export async function attachToPost(postId, c) {
  const post = await one(
    `update posts p set content_id = $2, title = $3, kind = $4,
                        endpoint_id = coalesce(p.endpoint_id, $5),
                        status = case when p.status = 'approved' then 'scheduled' else p.status end,
                        approved_by = case when p.status = 'approved' then null else p.approved_by end,
                        approved_at = case when p.status = 'approved' then null else p.approved_at end
       from (select status as old_status from posts where id = $1) o
      where p.id = $1 and p.content_id is null
        and p.status not in ('published','publishing') and p.scheduled_at > now()
      returning p.*, o.old_status`,
    [postId, c.content_id, c.title, c.kind, c.endpoint_id]
  );
  if (!post) return null;
  const closed = await rows(
    `update tasks set done = true, done_at = now()
      where post_id = $1 and kind in ('write','swap') and done = false
      returning id`,
    [postId]
  );
  const { old_status: oldStatus, ...row } = post;
  return {
    post: row,
    closed_task_ids: closed.map((t) => t.id),
    approval_reset: oldStatus === 'approved',
  };
}

/**
 * זוכר שהמשתמש הוריד תוכן מערוץ בשבוע מסוים (מחיקת פוסט, ביטול מילוי),
 * כדי שהמילוי האוטומטי הבא — שרץ אחרי כל שינוי אחר — לא יחזיר אותו מיד.
 * רשומות בנות יותר משמונה שבועות נמחקות על הדרך; אין בהן צורך יותר.
 * @param {{content_id:number|null, channel_id:number, scheduled_at:string|Date}[]} list
 */
export async function recordDismissals(list) {
  const items = (list ?? []).filter((x) => x?.content_id && x.channel_id && x.scheduled_at);
  if (items.length === 0) return;
  for (const x of items) {
    await query(
      `insert into engine_dismissals (week_start, content_id, channel_id)
       values ($1,$2,$3) on conflict do nothing`,
      [weekMeta(x.scheduled_at).start, x.content_id, x.channel_id]
    );
  }
  await query(`delete from engine_dismissals where week_start < current_date - 56`);
}

/**
 * תוכן שאפשר לשייך לפוסט בערוץ channelId: יש לו ניסוח לערוץ (מוכן או
 * טיוטה), הקמפיין שלו לא מושהה, והתאריך (אם נתון) בתוך חלון הקמפיין.
 * endpointId null = מכל נקודות הקצה (פוסט שעוד אין לו נקודה).
 * מוכן קודם; בתוך כל קבוצה — מה שעוד לא שובץ בערוץ הזה, ואז הוותיק.
 */
export function contentCandidates({ endpointId = null, channelId, date = null }) {
  return rows(
    `select ci.id, ci.title, ci.kind, ci.endpoint_id, e.name as endpoint_name,
            ci.campaign_id, ca.name as campaign_name, v.status as variant_status,
            exists (select 1 from posts p2
                     where p2.content_id = ci.id and p2.channel_id = $2
                       and p2.status <> 'hole') as used_on_channel
       from content_items ci
       join content_variants v on v.content_id = ci.id and v.channel_id = $2
                              and v.status in ('ready','draft')
       join endpoints e        on e.id = ci.endpoint_id
       left join campaigns ca  on ca.id = ci.campaign_id
      where ($1::int is null or ci.endpoint_id = $1)
        and ${candidateFilterSql({ channel: '$2::int', date: '$3::date' })}
      order by (v.status = 'ready') desc, used_on_channel, ci.created_at
      limit 100`,
    [endpointId, channelId, date]
  );
}

/* ========================= בחירה מתוך ההצעה ========================= */

/**
 * מפתח יציב לפריט בהצעה — מה שחלון המילוי שולח בחזרה כ"מסומן".
 * שיבוץ ופוסט חסר תוכן מזוהים לפי תוכן/ערוץ/מועד/נקודה; שיוך לפי הפוסט שמתמלא.
 */
export function planItemKey(type, x) {
  if (type === 'attach') return `attach|${x.post_id}|${x.content_id}`;
  const head = type === 'hole' ? 'hole' : x.content_id;
  return `${head}|${x.channel_id}|${x.scheduled_at}|${x.endpoint_id}`;
}

/**
 * חיתוך של ההצעה הטרייה עם מה שהמשתמש סימן. בלי selected — הכול, כמו
 * תמיד (העוזר, מילוי אוטומטי). skipped = מסומנים שכבר לא בהצעה.
 */
export function selectPlanItems(plan, selected) {
  if (!Array.isArray(selected)) return { plan, skipped: 0 };
  const want = new Set(selected.map(String));
  const keep = (list) => (list ?? []).filter((x) => want.has(x.key));
  const out = {
    ...plan,
    placements: keep(plan.placements),
    attachments: keep(plan.attachments),
    holes: keep(plan.holes),
  };
  const found = out.placements.length + out.attachments.length + out.holes.length;
  return { plan: out, skipped: want.size - found };
}

/* ========================= פוסטים חסרי תוכן ========================= */

/**
 * תוכן שלא יוצע לערוץ השבוע: כבר משובץ בו, או שהמשתמש הוריד אותו ממנו.
 * @returns {Set<string>} `${channel_id}:${content_id}`
 */
export function blockedContent(existing, dismissals = []) {
  const set = new Set(
    existing.filter((p) => p.content_id).map((p) => `${p.channel_id}:${p.content_id}`)
  );
  for (const d of dismissals) set.add(`${d.channel_id}:${d.content_id}`);
  return set;
}

/**
 * פוסטים על הלוח שאין להם תוכן ושעוד אפשר למלא: עתידיים, מתוכננים,
 * בערוץ פעיל ועם נקודת קצה פעילה (בלי נקודה אין לפי מה לבחור תוכן).
 * autoOnly — רק פוסטים שהמנוע יצר כחסרי תוכן (auto_hole), למילוי השקט.
 */
export function openHoles(existing, channels, endpoints, now = new Date(), { autoOnly = false } = {}) {
  const active = new Set(channels.map((ch) => ch.id));
  const activeEp = new Set(endpoints.map((e) => e.id));
  return existing
    .filter((p) => !p.content_id && p.status === 'scheduled' && !p.published_at &&
                   activeEp.has(p.endpoint_id) && active.has(p.channel_id) &&
                   (!autoOnly || p.auto_hole) &&
                   new Date(p.scheduled_at) > now)
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
}

/**
 * לכל פוסט חסר תוכן — התוכן שימלא אותו, אם יש: אותה נקודת קצה, גרסה
 * לערוץ שלו, בתוך חלון הקמפיין, ולא משובץ (או הורד) השבוע באותו ערוץ.
 * מוכן קודם לטיוטה, ובתוך כל קבוצה — מה שתואם לסוג שהפוסט סומן בו.
 * מעדכנת את usedContent, כדי שאותו תוכן לא ימלא שני פוסטים ולא ייפתח
 * לו פוסט חדש אחר כך באותה ריצה.
 *
 * usage (לא חובה בבדיקות): הפוסט כבר נספר בקיבולת לפי הסוג שסומן לו. תוכן
 * מסוג אחר עובר את אותם שערים כמו שיבוץ חדש (מכסה לסוג, מכירתי ליום, יחס
 * ערך/מכירתי) דרך allowsRetag; אם הסוג נחסם — עוברים למועמד הבא, ומועמד
 * מאותו סוג של הפוסט תמיד עובר. אחרי הבחירה — retag, כדי שהבאים יראו אותו.
 */
export function chooseHoleFills({
  holes, content, usedContent, history = new Map(), settings = null, usage = null,
}) {
  const out = [];
  for (const h of holes) {
    const at = new Date(h.scheduled_at);
    const dateKey = ymd(at);
    const slot = { channel_id: h.channel_id, dateKey };
    const fits = content.filter((c) =>
      c.endpoint_id === h.endpoint_id &&
      (c.eligible_channel_ids ?? []).includes(h.channel_id) &&
      fitsSlotChannel(c, h.channel_id) &&
      !usedContent.has(`${h.channel_id}:${c.id}`) &&
      !outsideCampaignWindow(c, dateKey) &&
      reusable(c, slot, history, settings)
    );
    if (fits.length === 0) continue;

    const isReady = (c) => (c.ready_channel_ids ?? []).includes(h.channel_id);
    fits.sort((a, b) => (isReady(b) - isReady(a)) ||
                        ((b.kind === h.kind) - (a.kind === h.kind)));
    const c = fits.find((x) => !usage || usage.allowsRetag(h.channel_id, dateKey, h.kind, x.kind));
    if (!c) continue;
    usedContent.add(`${h.channel_id}:${c.id}`);
    usage?.retag(h.channel_id, dateKey, h.kind, c.kind);

    out.push({
      post_id: h.id,
      channel_id: h.channel_id,
      endpoint_id: h.endpoint_id,
      content_id: c.id,
      title: c.title,
      kind: c.kind,
      prev_title: h.title ?? null,
      prev_kind: h.kind,
      scheduled_at: at.toISOString(),
      date: dateKey,
      day_label: `${HE_DAYS[at.getDay()]} ${at.getDate()}.${at.getMonth() + 1}`,
      time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
      draft: !isReady(c),
      reason: isReady(c)
        ? 'הפוסט חיכה לתוכן — יש עכשיו תוכן מוכן לנקודה ולערוץ'
        : 'הפוסט חיכה לתוכן — יש טיוטה; צריך לכתוב את הניסוח הסופי',
    });
  }
  return out;
}

/* ========================= חוב אוויר ========================= */

async function computeDebts(endpoints, settings, perf = null) {
  const lastPublished = await rows(
    `select endpoint_id, max(published_at) as last_at
       from posts where status = 'published' and endpoint_id is not null
      group by endpoint_id`
  );
  const lastMap = new Map(lastPublished.map((r) => [r.endpoint_id, r.last_at]));

  // פער מהנתח שהוגדר לקמפיינים שרצים עכשיו. קמפיין מושהה לא מתחרה על שטח,
  // ולכן לא אמור למשוך יעד — בדיוק כמו שהוא לא מוצג בלוח.
  const today = ymd(new Date());
  const allocs = await rows(
    `select endpoint_id, max(share_pct) as target_pct
       from campaigns
      where active = true and paused_at is null and share_pct is not null
        and (starts_on is null or starts_on <= $1)
        and (ends_on is null or ends_on >= $1)
      group by endpoint_id`,
    [today]
  );
  const published = await rows(
    `select p.endpoint_id, count(*)::int as n
       from posts p
      where p.status = 'published' and p.endpoint_id is not null
        and p.published_at >= coalesce(
              (select min(starts_on) from campaigns
                where active = true and paused_at is null and share_pct is not null
                  and (starts_on is null or starts_on <= $1)
                  and (ends_on is null or ends_on >= $1)),
              $1::date - 90)
      group by p.endpoint_id`,
    [today]
  );
  const totalPublished = published.reduce((s, p) => s + p.n, 0);
  const actualPct = new Map(
    published.map((p) => [p.endpoint_id, totalPublished ? (p.n / totalPublished) * 100 : 0])
  );
  const targetPct = new Map(allocs.map((a) => [a.endpoint_id, a.target_pct]));

  const now = new Date();
  const scheduledBoost = new Map(); // כמה כבר הצענו לה בריצה הזו

  const parts = new Map();
  for (const e of endpoints) {
    const lastAt = lastMap.get(e.id) ?? null;
    const daysSince = lastAt ? (now - new Date(lastAt)) / 86400000 : null;
    // נקודה שמעולם לא פורסמה מקבלת את החוב הגבוה ביותר
    const staleness = daysSince === null
      ? 2
      : daysSince / Math.max(1, effectiveCadenceDays(e));

    const target = targetPct.get(e.id) ?? 0;
    const actual = actualPct.get(e.id) ?? 0;
    const deficit = Math.max(0, target - actual) / 100;

    // המכפיל מרוכז סביב 1.0 (ניטרלי). מחסרים 1 כדי שנקודה בלי נתונים
    // תתרום בדיוק 0 לציון, נקודה מוצלחת תוסיף, וחלשה תוריד מעט.
    const perfMult = perf?.endpoint.get(e.id) ?? 1;

    parts.set(e.id, {
      staleness, deficit, importance: e.importance / 10, daysSince,
      performance: perf ? perfMult : null,
    });
  }

  return {
    score(endpointId) {
      const p = parts.get(endpointId);
      if (!p) return 0;
      // כל שיבוץ שכבר הוצע בריצה הזו מקטין את החוב, כדי שהמנוע יתפזר
      const already = scheduledBoost.get(endpointId) ?? 0;
      return W_STALENESS * p.staleness
           + W_STRATEGY * p.deficit
           + W_IMPORTANCE * p.importance
           + (p.performance == null ? 0 : W_PERFORMANCE * (p.performance - 1))
           - already * 0.6;
    },
    parts: (id) => parts.get(id),
    markScheduled(id) {
      scheduledBoost.set(id, (scheduledBoost.get(id) ?? 0) + 1);
    },
    scheduledCount: (id) => scheduledBoost.get(id) ?? 0,
  };
}

/* ========================= קיבולת ========================= */

/**
 * המשקל של כל צד: "משולב" נספר hybrid_weight כמכירתי והשאר כערך.
 * אותה נוסחה בשער היחס של המנוע ובכרטיס "ערך לכל מכירתי" בנתונים.
 */
export function kindWeights({ promo = 0, value = 0, hybrid = 0 }, hybridWeight) {
  const hw = Number(hybridWeight);
  return { promo: promo + hybrid * hw, value: value + hybrid * (1 - hw) };
}

/** ערך לכל מכירתי (עשרון אחד), או null כשאין שום משקל מכירתי */
export function valuePerPromo(kinds, hybridWeight) {
  const w = kindWeights(kinds, hybridWeight);
  return w.promo > 0 ? Number((w.value / w.promo).toFixed(1)) : null;
}

export function buildUsage(channels, existing, settings) {
  const byChannel = new Map();
  for (const ch of channels) {
    // חלק מהקיבולת נשמר לדברים דחופים ולכן המנוע לא נוגע בו
    const reserved = Math.floor(ch.max_per_week * (ch.urgent_reserve_pct / 100));
    byChannel.set(ch.id, {
      ch,
      budget: Math.max(0, ch.max_per_week - reserved),
      used: 0,
      byKind: { promo: 0, value: 0, hybrid: 0 },
      perDay: new Map(),   // dateKey -> count
      hours: new Set(),    // `${channel}:${date}:${hour}`
    });
  }

  const promoPerDay = new Map(); // dateKey -> count (חוצה ערוצים)
  const allPerDay = new Map();   // dateKey -> count בכל הערוצים, לפיזור בין ערוצים
  const weekKind = { promo: 0, value: 0, hybrid: 0 }; // סך השבוע בכל הערוצים
  let promoBlocked = 0; // כמה פעמים שער היחס חסם מכירתי

  for (const p of existing) {
    const u = byChannel.get(p.channel_id);
    const dateKey = ymd(new Date(p.scheduled_at));
    if (u) {
      u.used += 1;
      u.byKind[p.kind] = (u.byKind[p.kind] ?? 0) + 1;
      u.perDay.set(dateKey, (u.perDay.get(dateKey) ?? 0) + 1);
      u.hours.add(`${p.channel_id}:${dateKey}:${new Date(p.scheduled_at).getHours()}`);
    }
    if (p.kind === 'promo') {
      promoPerDay.set(dateKey, (promoPerDay.get(dateKey) ?? 0) + 1);
    }
    allPerDay.set(dateKey, (allPerDay.get(dateKey) ?? 0) + 1);
    weekKind[p.kind] = (weekKind[p.kind] ?? 0) + 1;
  }

  const maxPromoPerDay = settings?.max_promo_per_day ?? 1;
  const hybridWeight = Number(settings?.hybrid_weight ?? 0.5);
  const minRatio = Number(settings?.min_value_per_promo ?? 3);

  // "משולב" נספר חלקית בשני הצדדים, לפי hybrid_weight
  const promoWeight = () => kindWeights(weekKind, hybridWeight).promo;
  const valueWeight = () => kindWeights(weekKind, hybridWeight).value;

  return {
    channelHasRoom: (channelId) => {
      const u = byChannel.get(channelId);
      return !!u && u.used < u.budget;
    },
    dayCount: (channelId, dateKey) => byChannel.get(channelId)?.perDay.get(dateKey) ?? 0,
    dayTotal: (dateKey) => allPerDay.get(dateKey) ?? 0,
    hourTaken: (channelId, dateKey, hour) =>
      byChannel.get(channelId)?.hours.has(`${channelId}:${dateKey}:${hour}`) ?? false,

    /** האם מותר להכניס פוסט מסוג kind לערוץ ביום הזה */
    allows(channelId, dateKey, kind) {
      const u = byChannel.get(channelId);
      if (!u || u.used >= u.budget) return false;

      // יום שהוגדר כחסום למדיה הזו
      const dow = new Date(`${dateKey}T00:00:00`).getDay();
      if ((u.ch.blocked_days ?? []).includes(dow)) return false;

      const capField = { promo: 'max_promo_per_week', value: 'max_value_per_week',
                         hybrid: 'max_hybrid_per_week' }[kind];
      const cap = u.ch[capField];
      if (cap != null && u.byKind[kind] >= cap) return false;

      if (kind === 'promo') {
        if ((promoPerDay.get(dateKey) ?? 0) >= maxPromoPerDay) return false;
        // שער היחס: מכירתי נוסף מותר רק אם יש מספיק ערך בשבוע שיאזן אותו
        if (valueWeight() < minRatio * (promoWeight() + 1)) {
          promoBlocked += 1;
          return false;
        }
      }

      return true;
    },

    take(channelId, dateKey, kind, hour) {
      const u = byChannel.get(channelId);
      if (!u) return;
      u.used += 1;
      u.byKind[kind] = (u.byKind[kind] ?? 0) + 1;
      u.perDay.set(dateKey, (u.perDay.get(dateKey) ?? 0) + 1);
      u.hours.add(`${channelId}:${dateKey}:${hour}`);
      allPerDay.set(dateKey, (allPerDay.get(dateKey) ?? 0) + 1);
      if (kind === 'promo') promoPerDay.set(dateKey, (promoPerDay.get(dateKey) ?? 0) + 1);
      weekKind[kind] = (weekKind[kind] ?? 0) + 1;
    },

    /**
     * האם פוסט שכבר נספר יכול להחליף סוג (שיוך תוכן לפוסט חסר תוכן). בלי
     * בדיקת תקציב — הפוסט כבר תופס את מקומו. אותו סוג — תמיד מותר.
     */
    allowsRetag(channelId, dateKey, fromKind, toKind) {
      if (fromKind === toKind) return true;
      const u = byChannel.get(channelId);
      if (!u) return false;
      const capField = { promo: 'max_promo_per_week', value: 'max_value_per_week',
                         hybrid: 'max_hybrid_per_week' }[toKind];
      const cap = u.ch[capField];
      if (cap != null && u.byKind[toKind] >= cap) return false;
      if (toKind === 'promo') {
        if ((promoPerDay.get(dateKey) ?? 0) >= maxPromoPerDay) return false;
        // שער היחס, כשהפוסט כבר לא נספר בסוג הקודם שלו
        const without = { ...weekKind, [fromKind]: Math.max(0, (weekKind[fromKind] ?? 0) - 1) };
        const w = kindWeights(without, hybridWeight);
        if (w.value < minRatio * (w.promo + 1)) {
          promoBlocked += 1;
          return false;
        }
      }
      return true;
    },

    /** פוסט שכבר נספר משנה סוג — כל המונים זזים, בלי לתפוס מקום נוסף */
    retag(channelId, dateKey, fromKind, toKind) {
      if (fromKind === toKind) return;
      const u = byChannel.get(channelId);
      if (u) {
        u.byKind[fromKind] = Math.max(0, (u.byKind[fromKind] ?? 0) - 1);
        u.byKind[toKind] = (u.byKind[toKind] ?? 0) + 1;
      }
      if (fromKind === 'promo') {
        promoPerDay.set(dateKey, Math.max(0, (promoPerDay.get(dateKey) ?? 0) - 1));
      }
      if (toKind === 'promo') promoPerDay.set(dateKey, (promoPerDay.get(dateKey) ?? 0) + 1);
      weekKind[fromKind] = Math.max(0, (weekKind[fromKind] ?? 0) - 1);
      weekKind[toKind] = (weekKind[toKind] ?? 0) + 1;
    },

    remaining: (channelId) => {
      const u = byChannel.get(channelId);
      return u ? Math.max(0, u.budget - u.used) : 0;
    },

    ratioReport: () => ({
      promoBlocked,
      minRatio,
      value_per_promo: promoWeight() > 0
        ? Number((valueWeight() / promoWeight()).toFixed(1)) : null,
      counts: { ...weekKind },
    }),
  };
}

/**
 * כל המשבצות האפשריות (ערוץ × יום), בלי סדר. הסדר נקבע דינמית ב-nextSlot,
 * כי סדר שנקבע מראש לא יודע איפה כבר נחתו שיבוצים באותה ריצה — וזה בדיוק
 * מה שגרם למנוע לדחוס את כל השבוע לימים הראשונים עד גמר תקציב הערוץ.
 *
 * ימים שהערוץ חסם לגמרי לא נכנסים בכלל, כדי שחישוב המרווח לא יתייחס אליהם
 * כמקום פנוי אפשרי.
 *
 * efficiency = איכות המשבצת: יעילות שנמדדה בפועל (ערוץ × יום × חלון שעות)
 * כשהמתג דלוק ויש מספיק דגימות; אחרת דירוג ידני channels.efficiency.
 */
export function buildSlots(week, channels, perf = null) {
  const slots = [];
  for (const ch of channels) {
    week.days.forEach((day, index) => {
      const date = new Date(`${day.date}T00:00:00`);
      if ((ch.blocked_days ?? []).includes(date.getDay())) return;

      // הנמדד מנורמל סביב 1.0 והידני הוא 1–10 — מיישרים אותו לאותו סולם
      // כדי ששני המקורות יהיו בני-השוואה במיון אחד.
      const measured = perf
        ? (perf.channel.get(ch.id) ?? 1)
            * (perf.dow.get(date.getDay()) ?? 1)
            * (perf.bucket.get(hourBucket(DEFAULT_HOUR)) ?? 1)
        : null;

      slots.push({
        channel_id: ch.id,
        channel_name: ch.name,
        date,
        dateKey: day.date,
        index,
        label: day.label,
        efficiency: measured != null ? measured * 5 : (ch.efficiency ?? 5),
      });
    });
  }
  return slots;
}

/**
 * המשבצת הבאה שתקבל הצעה. נבחרת מחדש בכל צעד לפי מצב הלוח *העדכני*, ולא
 * לפי מיון שנעשה פעם אחת בהתחלה.
 *
 * הכלל: המשבצת הרחוקה ביותר ממה שכבר תפוס באותו ערוץ. כך שיבוץ ראשון נוחת
 * באמצע השבוע, השני קופץ לקצה, השלישי נכנס בין שניהם — התוכן נפרש על כל
 * השבוע ומצטופף רק כשהתקציב באמת מחייב את זה.
 *
 * שוברי שוויון, לפי הסדר: יום עמוס פחות בכל הערוצים (שלא ייווצר יום שכולם
 * מפרסמים בו), אחר כך איכות המשבצת, ולבסוף התאריך — כדי שהתוצאה תהיה יציבה.
 */
export function nextSlot(pending, usage, week) {
  let best = null;
  let bestKey = null;

  for (const slot of pending) {
    const key = [
      -spreadDistance(slot, usage, week),
      usage.dayTotal(slot.dateKey),
      Math.abs(slot.index - (week.days.length - 1) / 2), // עוגן ראשון = אמצע השבוע
      -slot.efficiency,
      slot.dateKey,
    ];
    if (!bestKey || compareKeys(key, bestKey) < 0) {
      best = slot;
      bestKey = key;
    }
  }
  return best;
}

/** המרחק בימים מהיום התפוס הקרוב ביותר באותו ערוץ. ערוץ ריק = מרחק מקסימלי. */
function spreadDistance(slot, usage, week) {
  let nearest = Infinity;
  week.days.forEach((day, i) => {
    if (usage.dayCount(slot.channel_id, day.date) > 0) {
      nearest = Math.min(nearest, Math.abs(i - slot.index));
    }
  });
  return nearest === Infinity ? week.days.length : nearest;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    return typeof a[i] === 'string' ? a[i].localeCompare(b[i]) : a[i] - b[i];
  }
  return 0;
}

/* ========================= בחירה למשבצת ========================= */

/**
 * האם התאריך מחוץ לחלון של הקמפיין שהתוכן שייך אליו. תוכן שוטף (בלי
 * קמפיין) וקמפיין בלי תאריכים — אף פעם לא מחוץ לחלון. התאריכים הם
 * YYYY-MM-DD, ולכן השוואת מחרוזות מדויקת.
 */
export function outsideCampaignWindow(c, dateKey) {
  if (!c?.campaign_id) return false;
  if (c.campaign_starts_on && dateKey < c.campaign_starts_on) return true;
  if (c.campaign_ends_on && dateKey > c.campaign_ends_on) return true;
  return false;
}

export function chooseForSlot(ctx) {
  const { slot, endpoints, content, campaigns, debts, usage,
          usedContent, lastPerPair, settings, history, sameDay } = ctx;

  const minGap = settings?.min_gap_days ?? 7;
  const candidates = [];

  for (const e of endpoints) {
    // אותה נקודה, אותה מדיה, אותו יום — לא משנה מאיזה סוג
    if (sameDay.has(`${e.id}:${slot.channel_id}:${slot.dateKey}`)) continue;
    // מרווח מינימלי לאותה נקודה באותו ערוץ
    const lastKey = lastPerPair.get(`${e.id}:${slot.channel_id}`);
    if (lastKey) {
      const gapDays = Math.abs(
        (new Date(slot.dateKey) - new Date(lastKey)) / 86400000
      );
      if (gapDays < minGap) continue;
    }

    // טיוטה נחשבת מועמדת כמו תוכן מוכן — השיבוץ הולך לפי האסטרטגיה,
    // לא לפי אם כבר נכתב טקסט סופי. bool כדי שאפשר יהיה להעדיף מוכן
    // על פני טיוטה כשיש ברירה, בלי לפסול טיוטה כשאין ברירה אחרת.
    const ready = content.filter((c) =>
      c.endpoint_id === e.id &&
      (c.eligible_channel_ids ?? []).includes(slot.channel_id) &&
      fitsSlotChannel(c, slot.channel_id) &&
      !outsideCampaignWindow(c, slot.dateKey) &&
      !usedContent.has(`${slot.channel_id}:${c.id}`) &&
      reusable(c, slot, history, settings) &&
      usage.allows(slot.channel_id, slot.dateKey, c.kind)
    );
    if (ready.length === 0) continue;

    // קמפיין שרץ בתאריך הזה מטה לכיוון תוכן מכירתי/משולב
    const inCampaign = campaigns.some((c) =>
      c.endpoint_id === e.id &&
      (!c.starts_on || c.starts_on <= slot.dateKey) &&
      (!c.ends_on || c.ends_on >= slot.dateKey)
    );
    const rank = inCampaign
      ? { promo: 0, hybrid: 1, value: 2 }
      : { value: 0, hybrid: 1, promo: 2 };
    const isReady = (c) => (c.ready_channel_ids ?? []).includes(slot.channel_id);
    // מוכן קודם, טיוטה רק אם אין ברירה — בתוך כל קבוצה, לפי סוג התוכן
    ready.sort((a, b) => (isReady(b) - isReady(a)) || (rank[a.kind] - rank[b.kind]));

    candidates.push({
      endpoint: e,
      content: ready[0],
      score: debts.score(e.id),
      inCampaign,
      draft: !isReady(ready[0]),
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const p = debts.parts(best.endpoint.id);
  const bits = [];
  if (p.daysSince === null) bits.push('עוד לא פורסמה מעולם');
  else if (p.staleness >= 1) bits.push(`${Math.floor(p.daysSince)} ימים בלי פרסום`);
  if (p.deficit > 0.05) bits.push(`מפגרת ${Math.round(p.deficit * 100)} נק' אחרי יעד הרבעון`);
  if (best.inCampaign) bits.push('קמפיין רץ');
  if (best.draft) bits.push('התוכן עוד בטיוטה — צריך לכתוב את הניסוח הסופי');
  // רק כשהיעילות הנמדדת באמת הזיזה משהו — 1.0 הוא ניטרלי ולא מעניין
  if (p.performance != null && Math.abs(p.performance - 1) >= 0.08) {
    bits.push(p.performance > 1
      ? `יעילות נמדדת גבוהה (${p.performance.toFixed(2)})`
      : `יעילות נמדדת נמוכה (${p.performance.toFixed(2)})`);
  }
  bits.push(`חשיבות ${best.endpoint.importance}`);

  return { ...best, reason: bits.join(' · ') };
}

/* ========================= חורים ========================= */

/**
 * נקודה שהחוב שלה גבוה אבל אין לה תוכן מוכן — הלוח צריך להראות
 * שהוא מחכה לה, ולא סתם לדלג עליה בשקט.
 */
function findHoles({ endpoints, content, debts, channels, usage, week, existing }) {
  const holes = [];

  for (const e of endpoints) {
    const p = debts.parts(e.id);
    if (!p || p.staleness < 1) continue;                 // עוד בקצב
    if (debts.scheduledCount(e.id) > 0) continue;         // כבר קיבלה שיבוץ בריצה הזו
    if (existing.some((x) => x.endpoint_id === e.id)) continue; // כבר על הלוח השבוע

    const mine = content.filter((c) => c.endpoint_id === e.id);

    // הערוץ הכי פנוי — שם נשבץ בלי תוכן. גם טיוטה כבר נבדקה ונפסלה
    // למעלה בלולאת ה-slots הרגילה, אז אם הגענו לכאן — באמת אין כלום.
    const target = channels
      .filter((ch) => usage.remaining(ch.id) > 0)
      .sort((a, b) => usage.remaining(b.id) - usage.remaining(a.id))[0];
    if (!target) continue;

    // לא בתחילת השבוע, כדי שיישאר זמן לכתוב; ומתוך מה שנשאר — היום שהכי
    // רחוק ממה שכבר תפוס באותו ערוץ, כדי שהחורים לא ייערמו כולם על יום אחד.
    const day = pickHoleDay(week, target, usage);
    let hour = 12;
    while (usage.hourTaken(target.id, day.date, hour) && hour < 22) hour += 1;
    // תופסים בפועל את המקום כדי ששיבוץ נוסף באותה ריצה לא יחשוב שהמשבצת פנויה.
    usage.take(target.id, day.date, 'value', hour);

    holes.push({
      channel_id: target.id,
      channel_name: target.name,
      endpoint_id: e.id,
      endpoint_name: e.name,
      kind: 'value',
      date: day.date,
      day_label: day.label,
      scheduled_at: new Date(`${day.date}T${String(hour).padStart(2, '0')}:00:00`).toISOString(),
      reason: holeReason(mine, day.date),
      days_since: p.daysSince === null ? null : Math.floor(p.daysSince),
    });
  }

  return holes;
}

/**
 * למה אין תוכן לנקודה במשבצת — הטקסט שמופיע על החור ובמשימת "לכתוב".
 * תוכן שכולו של קמפיינים שלא רצים בתאריך הזה הוא סיבה אחרת לגמרי מ"אין
 * גרסה מתאימה", ומי שקורא את ההודעה צריך לדעת איזו מהן.
 */
export function holeReason(endpointContent, dateKey) {
  if (!endpointContent.length) return 'אין שום תוכן (גם לא טיוטה) לנקודה הזו';
  if (endpointContent.every((c) => outsideCampaignWindow(c, dateKey))) {
    return 'התוכן של נקודת הקצה שייך לקמפיינים שלא רצים בתאריך הזה, ואין לה תוכן שוטף';
  }
  return 'יש תוכן לנקודה הזו, אבל אף גרסה לא מתאימה לערוץ פנוי כרגע';
}

/** היום שבו יישב חור: לא בתחילת השבוע, ורחוק ככל האפשר משאר הלוח של הערוץ. */
function pickHoleDay(week, channel, usage) {
  const usable = week.days
    .map((day, index) => ({ day, index }))
    .filter(({ day, index }) => {
      if (index < 2) return false; // צריך זמן לכתוב
      const dow = new Date(`${day.date}T00:00:00`).getDay();
      return !(channel.blocked_days ?? []).includes(dow);
    });
  if (usable.length === 0) return week.days[3] ?? week.days[0];

  return usable.sort((a, b) => {
    const key = ({ day, index }) => [
      -spreadDistance({ channel_id: channel.id, index }, usage, week),
      usage.dayTotal(day.date),
      index,
    ];
    return compareKeys(key(a), key(b));
  })[0].day;
}

/**
 * האם מותר להשתמש בפריט התוכן הזה במשבצת הזו.
 *
 * תוכן חד-פעמי (ברירת המחדל) יוצא לאוויר פעם אחת ונגמר.
 * תוכן evergreen חוזר, אבל רק אחרי שעבר מספיק זמן מהפעם הקודמת באותו ערוץ.
 */
function reusable(c, slot, history, settings) {
  const h = history.get(c.id);
  if (!h) return true; // עוד לא פורסם מעולם

  if (!c.evergreen) return false;

  const lastHere = h.lastByChannel.get(slot.channel_id);
  if (!lastHere) return true; // evergreen שעוד לא היה בערוץ הזה

  const gap = Math.abs((new Date(slot.dateKey) - new Date(lastHere)) / 86400000);
  return gap >= (c.reuse_after_days ?? settings?.min_gap_days ?? 7);
}

/** מתי כל פריט תוכן פורסם או שובץ, לכל ערוץ */
async function contentHistory() {
  const r = await rows(
    `select content_id, channel_id, max(scheduled_at) as last_at
       from posts
      where content_id is not null
        and status in ('scheduled','approved','publishing','failed','published','pending_approval')
      group by content_id, channel_id`
  );
  const map = new Map();
  for (const x of r) {
    if (!map.has(x.content_id)) map.set(x.content_id, { lastByChannel: new Map() });
    map.get(x.content_id).lastByChannel.set(x.channel_id, ymd(new Date(x.last_at)));
  }
  return map;
}

/** המרווח האחרון בין נקודת קצה לערוץ, לצורך min_gap_days */
async function lastPostPerEndpointChannel() {
  const r = await rows(
    `select endpoint_id, channel_id, max(scheduled_at) as last_at
       from posts
      where endpoint_id is not null and status in ('scheduled','approved','publishing','failed','published','pending_approval')
      group by endpoint_id, channel_id`
  );
  return new Map(r.map((x) => [`${x.endpoint_id}:${x.channel_id}`, ymd(new Date(x.last_at))]));
}
