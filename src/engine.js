import { currentOrg, one, rows, query } from './db.js';
import { weekMeta, ymd, effectiveCadenceDays } from './board.js';
import { performanceMultipliers, hourBucket } from './performance.js';
import { candidateColumnsSql, candidateFilterSql, candidateFits, fitsSlotChannel } from './candidates.js';
import { spreadDate } from '../public/js/core/period.js';
import { averageShares, channelBudget, effectiveGap } from './capacity.js';

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
// יותר STALENESS = "אף אחד לא נשכח", יותר STRATEGY = "נצמדים לנתחים של הקמפיינים".
const W_STALENESS = 1.0;  // כמה זמן עבר מאז שהנקודה פורסמה, ביחס לקצב שהוגדר לה
const W_STRATEGY  = 0.8;  // כמה היא מפגרת אחרי הנתח של הקמפיינים שלה (strategyTargets)
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
 * ימים שעברו לא מקבלים שיבוץ (buildSlots עם today), וגם לא שעה שכבר עברה
 * היום — פוסט "מתוכנן" לעבר לא ייצא לעולם.
 *
 * onlyCampaignId — מילוי של קמפיין בשבועות שהמשתמש לא מסתכל עליהם
 * (autoFillCampaign): רק התוכן של הקמפיין הזה משובץ או משויך. כל השאר —
 * משבצות, קיבולת, מרווח, חוב — כרגיל, כך שהפוסטים הקיימים של נקודות אחרות
 * עדיין תופסים מקום.
 *
 * @param {string|Date} [anchorDate] תאריך כלשהו בתוך השבוע המבוקש
 * @param {{holes?:boolean, now?:Date, onlyCampaignId?:number|null}} [opts] now — לבדיקות; ברירת מחדל: עכשיו
 * @returns {Promise<{week:object, placements:object[], attachments:object[], holes:object[], notes:string[]}>}
 */
export async function planWeek(anchorDate, {
  holes: withHoles = true, now = new Date(), onlyCampaignId = null,
} = {}) {
  const week = weekMeta(anchorDate);
  const today = ymd(now);
  const from = week.startDate;
  const to = new Date(week.endDate);
  to.setHours(23, 59, 59, 999);

  const settings = await one('select * from engine_settings limit 1');
  const channels = await rows('select * from channels where active = true order by sort_order, id');
  // סדר קבוע: בשוויון ציון הנקודה הראשונה זוכה, ותכנון וביצוע חייבים
  // לבחור אותה נקודה — אחרת המפתחות שהמשתמש סימן לא יימצאו בהצעה הטרייה
  const endpoints = await rows('select * from endpoints where active = true order by id');
  // הזווית נושאת את השיוך; הגרסה קובעת אם היא מוכנה למדיה מסוימת.
  // תוכן של קמפיין מושהה לא נכנס לתכנון.
  //
  // ready_channel_ids — רק גרסה שסומנה "מוכן". eligible_channel_ids — גם
  // טיוטה: השיבוץ הולך לפי האסטרטגיה, לא לפי אם כבר נכתב טקסט סופי.
  // המנוע ממשיך להעדיף מוכן על פני טיוטה כשיש ברירה (ראו chooseForSlot).
  // תאריכי הקמפיין נשלפים עם התוכן: תוכן של קמפיין לא יוצא לפני
  // starts_on ולא אחרי ends_on (ראו outsideCampaignWindow).
  // campaign_min_gap_days — המרווח של הקמפיין של התוכן (contentGap).
  // linked_to_id (ב-ci.*) ו-campaign_links_apart — פוסטים מקושרים לא באותו
  // יום (linkedSameDay)
  const content = await rows(`select ci.*,
               ca.starts_on as campaign_starts_on, ca.ends_on as campaign_ends_on,
               ca.min_gap_days as campaign_min_gap_days,
               ca.links_apart as campaign_links_apart,
               ${COMPLETE_SPREAD_COLUMNS},
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
         order by ci.created_at, ci.id`);
  // שיבוץ של קמפיין מושהה יורד מהלוח (board.js) ולכן גם לא אמור לתפוס
  // מקום בקיבולת שהמנוע רואה — אחרת ערוץ נראה מלא בזמן שהלוח הפעיל ריק.
  // פוסט שכבר פורסם נשאר תפוס גם אם הקמפיין הושהה אחרי מכן — זו עובדה
  // שכבר קרתה, בדיוק כמו ב-board.js.
  const existing = await rows(
    `select p.id, p.channel_id, p.endpoint_id, p.content_id, p.kind, p.scheduled_at, p.status,
            p.title, p.published_at, p.auto_hole
       from posts p
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.scheduled_at >= $1 and p.scheduled_at <= $2
        and p.status in ('scheduled','approved','publishing','failed','published','pending_approval')
        and (ca.paused_at is null or p.status = 'published')`,
    [from, to]
  );
  const campaigns = await rows('select * from campaigns where active = true and paused_at is null');
  // תוכן שהמשתמש הוריד מהשבוע הזה (מחיקת פוסט / ביטול מילוי) — לא חוזר
  const dismissals = await rows('select content_id, channel_id from engine_dismissals where week_start = $1', [week.start]);

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

  const debts = await computeDebts(endpoints, settings, perf, week, now);

  // מצב מתגלגל של הקיבולת. מתעדכן תוך כדי התכנון. שבוע מרוסן — שער יחס
  // לפי תקרה צפויה (ראו buildUsage)
  const usage = buildUsage(channels, existing, settings,
    { projectedPromoCap: onlyCampaignId != null });

  // תוכן שכבר משובץ השבוע — או שהמשתמש הוריד מהשבוע — לא יוצע שוב לאותו ערוץ
  const usedContent = blockedContent(existing, dismissals);

  // ההיסטוריה המלאה של כל פריט תוכן בכל ערוץ — בלעדיה תוכן חד-פעמי היה
  // חוזר לאוויר בכל שבוע שבו הוא לא במקרה משובץ
  const history = await contentHistory();

  // כל הפוסטים החיים של כל נקודה בכל ערוץ סביב השבוע — לבדיקת המרווח מול
  // השכן הקרוב לשני הכיוונים (ראו contentGap / nearestDays), גם בשיוך תוכן
  // לפוסטים חסרי תוכן וגם בשיבוץ חדש
  const pairDates = await postDatesPerEndpointChannel(from, to, settings);

  // הימים שבהם כבר יוצא פוסט של כל קבוצת קישור (מקור + עוקבות), בכל ערוץ —
  // פוסט מקושר לא יוצא באותו יום כשהקמפיין מבקש (links_apart)
  const groupDays = await linkGroupDays(from, to);

  // המועמדים לשיבוץ ולשיוך — כל התוכן, או רק של הקמפיין (onlyCampaignId)
  const candidates = onlyCampaignId == null
    ? content
    : content.filter((c) => c.campaign_id === Number(onlyCampaignId));

  // קודם ממלאים את מה שכבר על הלוח וחסר לו תוכן, ורק אחר כך פותחים פוסטים
  // חדשים — אחרת תוכן שנכתב בדיוק בשביל פוסט ריק נוחת במשבצת אחרת והריק נשאר.
  const attachments = chooseHoleFills({
    // מילוי שקט (holes:false) משייך רק לפוסטים שהמנוע עצמו יצר כחסרי תוכן;
    // החלון הידני מציע לכל פוסט חסר תוכן — שם המשתמש רואה ובוחר
    holes: openHoles(existing, channels, endpoints, now, { autoOnly: !withHoles }),
    content: candidates, usedContent, history, settings, usage, pairDates, groupDays,
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

  const placements = [];

  // שבוע מרוסן: הקמפיין לא תופס יותר מהנתח שלו בכל ערוץ — אחרת שמירה שלו
  // ממלאת את כל המשבצות של שבועות רחוקים לפני שלאחרים יש שם תוכן. התקרה =
  // ceil(תקציב הערוץ × הנתח הממוצע של הקמפיין בשבוע), כולל מה שכבר שלו על
  // הלוח באותו שבוע.
  const shareCap = new Map();
  const campaignUsed = new Map();
  if (onlyCampaignId != null) {
    const share = debts.campaignShare(onlyCampaignId);
    for (const ch of channels) shareCap.set(ch.id, Math.ceil(channelBudget(ch) * share));
    const mine = new Set(candidates.map((c) => c.id));
    // פוסטים שלו על הלוח, וגם פוסטים חסרי תוכן שהשיוך שלמעלה ממלא בתוכן שלו
    for (const p of [...existing.filter((x) => mine.has(x.content_id)), ...attachments]) {
      campaignUsed.set(p.channel_id, (campaignUsed.get(p.channel_id) ?? 0) + 1);
    }
  }
  const overShare = (channelId) =>
    onlyCampaignId != null && (campaignUsed.get(channelId) ?? 0) >= (shareCap.get(channelId) ?? 0);

  // כל שילוב (ערוץ, יום) אפשרי. הסדר נקבע תוך כדי, לא מראש — ראו nextSlot.
  // ימים שעברו לא נכנסים בכלל — קודם תכנון השבוע של 6.9 הציע פוסטים ל-6–12.9
  const pending = new Set(buildSlots(week, channels, perf, { today }));

  while (pending.size) {
    const slot = nextSlot(pending, usage, week);
    pending.delete(slot);
    if (!usage.channelHasRoom(slot.channel_id)) continue;
    if (overShare(slot.channel_id)) continue;

    const pick = chooseForSlot({
      slot, endpoints, content: candidates, campaigns, debts, usage,
      usedContent, pairDates, settings, placements, history, sameDay, groupDays,
    });
    if (!pick) continue;

    const at = new Date(slot.date);
    // היום, אחרי שעת ברירת המחדל — השעה העגולה הבאה, לא ויתור על כל היום
    let hour = slot.dateKey === today ? Math.max(DEFAULT_HOUR, now.getHours() + 1) : DEFAULT_HOUR;
    // התנגשות שעה באותו ערוץ באותו יום — מזיזים שעה קדימה
    while (usage.hourTaken(slot.channel_id, slot.dateKey, hour) && hour < 22) hour += 1;
    // היום כבר נגמר, או שגם 22:00 תפוסה (הלולאה נעצרת עליה — קודם שובץ שם שני)
    if (hour > 22 || usage.hourTaken(slot.channel_id, slot.dateKey, hour)) continue;
    at.setHours(hour, 0, 0, 0);
    if (at <= now) continue;

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
    addPairDate(pairDates, `${pick.endpoint.id}:${slot.channel_id}`, slot.dateKey);
    addGroupDay(groupDays, linkRoot(pick.content), pick.content.id, slot.dateKey);
    debts.markScheduled(pick.endpoint.id);
    campaignUsed.set(slot.channel_id, (campaignUsed.get(slot.channel_id) ?? 0) + 1);
  }

  const holes = withHoles
    ? findHoles({ endpoints, content, debts, channels, usage, week, existing, now,
                  pairDates, sameDay, settings })
        .map((h) => ({ ...h, key: planItemKey('hole', h) }))
    : [];

  const { blockedPairs, ...ratio } = usage.ratioReport();
  // פוסטים מכירתיים שנחסמו בשער היחס ולא נכנסו בסוף לאותו ערוץ
  const landed = new Set([...placements, ...attachments].map((x) => `${x.channel_id}:${x.content_id}`));
  ratio.promo_blocked_posts = blockedPairs.filter((k) => !landed.has(k)).length;
  if (ratio.promoBlocked > 0) {
    notes.push(
      `נחסמו פוסטים מכירתיים כדי לשמור על יחס של ${ratio.minRatio} ערך לכל מכירתי. ` +
      `כדי לפרסם יותר מכירתי — צריך יותר תוכן ערך מוכן.`
    );
  }

  const result = {
    week: { start: week.start, end: week.end, label: week.label },
    placements,
    attachments,
    holes,
    ratio,
    notes,
  };
  // מצב הלוח שהתכנון נשען עליו — לבדיקה חוזרת של בחירה חלקית ב-applyWeek.
  // לא נספר (enumerable:false), ולכן לא נשלח ללקוח ב-/engine/plan.
  Object.defineProperty(result, 'ctx', { value: { channels, existing, settings }, enumerable: false });
  return result;
}

// שרשרת שממתינה שהריצה הקודמת תיגמר, כדי שתי הרצות חופפות (למשל שינוי
// כלל ואז מיד גרירת קמפיין) לא יחשבו את אותה משבצת פנויה פעמיים.
//
// השרשרת לבדה לא מספיקה: היא משחררת כשהמילוי נגמר, אבל הבקשה עושה commit
// רק אחר כך — מילוי שני (בתהליך אחר, או באותו תהליך ברגע שבין שני
// commit-ים) רואה לוח בלי מה שהראשון כתב. לכן כל מילוי בתוך בקשה לוקח גם
// lockEngine — נעילת advisory של Postgres לכל ארגון, עד סוף הטרנזקציה.
// השרשרת נשארת: היא מסדרת את העבודה בתוך התהליך (גם בלי טרנזקציה, כמו
// respace מהשורה), ובקשה לא תופסת חיבור מה-pool רק כדי לחכות לנעילה.
let applyChain = Promise.resolve();
/** המפתח הראשון של נעילת המנוע ב-pg_advisory_xact_lock; השני — הארגון */
export const ENGINE_LOCK_KEY = 7301;

/**
 * נעילת המנוע של הארגון עד סוף הטרנזקציה של הבקשה (pg_advisory_xact_lock),
 * כך ששני מילויים — גם משני תהליכים — לא חושבים את אותה משבצת כפנויה. ממתינה
 * עד lock_timeout (ברירת מחדל 5 שניות, ENGINE_LOCK_TIMEOUT לבדיקות) ואז זורקת
 * 55P03 ושוברת את הטרנזקציה — הקורא אחראי ל-savepoint (guardedFill) או
 * לתשובה מסודרת (/engine/apply). רק בתוך טרנזקציה של ארגון.
 */
export async function lockEngine(timeout = process.env.ENGINE_LOCK_TIMEOUT || '5s') {
  const { prev } = await one("select current_setting('lock_timeout') as prev");
  await query("select set_config('lock_timeout', $1, true)", [timeout]);
  await query('select pg_advisory_xact_lock($1, $2)', [ENGINE_LOCK_KEY, currentOrg() ?? 0]);
  await query("select set_config('lock_timeout', $1, true)", [prev]);
}

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
 * @param {{holes?:boolean, selected?:string[]|null, onlyCampaignId?:number|null}} [opts]
 *   onlyCampaignId — ראו planWeek
 * @returns {Promise<{placed:number, attached:number, holes:number, skipped:number,
 *   created_ids:number[], created_items:object[], attached_items:object[], summary:object[]}>}
 */
export async function applyWeek(anchorDate, {
  holes: withHoles = true, selected = null, onlyCampaignId = null,
} = {}) {
  const fresh = await planWeek(anchorDate, { holes: withHoles, onlyCampaignId });
  const { plan, skipped: stale } = selectPlanItems(fresh, selected);
  // בחירה חלקית: מכירתי שעבר את שער היחס בזכות פריטי ערך שהמשתמש הוריד
  // מהסימון כבר לא מאוזן — יורד, ונאמר למה
  let dropped = [];
  if (Array.isArray(selected)) {
    ({ placements: plan.placements, dropped } = recheckSelection(plan, fresh.ctx));
  }
  // אף פוסט לא נכתב לעבר. planWeek כבר לא מציע כאלה; זו רשת ביטחון למקרה
  // שהתכנון והכתיבה חוצים שעה עגולה (משבצת של 10:00 שתוכננה ב-9:59).
  const now = Date.now();
  const future = (x) => new Date(x.scheduled_at).getTime() > now;
  const pastCount = plan.placements.filter((x) => !future(x)).length +
                    plan.holes.filter((x) => !future(x)).length;
  plan.placements = plan.placements.filter(future);
  plan.holes = plan.holes.filter(future);
  const skipped = stale + dropped.length + pastCount;

  const createdIds = [];
  const created = []; // { post_id, content_id } — "בטל" מוחק רק מה שלא השתנה מאז
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
    created.push({ post_id: post.id, content_id: p.content_id });
    summary.push(brief(p));
  }

  // השם והסוג הקודמים חוזרים ללקוח, כדי ש"בטל" יחזיר את הפוסט בדיוק כמו שהיה
  const attached = [];
  for (const a of plan.attachments) {
    const done = await attachToPost(a.post_id, a);
    if (!done) continue; // מישהו שייך תוכן לפוסט הזה בינתיים, או שהמועד עבר
    // title — מה שהשיוך כתב; "בטל" מחזיר רק אם הכותרת לא נערכה מאז.
    // closed_task_ids — בדיוק המשימות שהשיוך סגר, ש"בטל" יפתח מחדש.
    attached.push({ post_id: a.post_id, content_id: a.content_id, title: a.title,
                    prev_title: a.prev_title, prev_kind: a.prev_kind,
                    closed_task_ids: done.closed_task_ids });
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
    created.push({ post_id: post.id, content_id: null });
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
    // מכירתיים שלא שובצו כי חסר ערך שיאזן אותם (ראו buildUsage)
    promo_blocked: fresh.ratio.promo_blocked_posts,
    // השבועות שהמילוי עבר עליהם — "בטל" רושם ויתור לכל אחד (recordDismissals)
    covered_weeks: [fresh.week.start],
    skipped,
    dropped: dropped.map(({ title, reason }) => ({ title, reason })),
    created_ids: createdIds,
    created_items: created,
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
 *
 * weeks — "בטל" על מילוי של כמה שבועות (autoFillCampaign): הוויתור נרשם
 * לכל שבוע שהמילוי עבר עליו, לא רק לשבוע של הפוסט — אחרת השמירה הבאה של
 * הקמפיין הייתה מחזירה את אותו תוכן לשבוע אחר בתקופה.
 * @param {{content_id:number|null, channel_id:number, scheduled_at:string|Date}[]} list
 * @param {{weeks?:string[]}} [opts] תחילות שבוע, YYYY-MM-DD
 */
export async function recordDismissals(list, { weeks = [] } = {}) {
  const items = (list ?? []).filter((x) => x?.content_id && x.channel_id && x.scheduled_at);
  if (items.length === 0) return;
  for (const x of items) {
    const all = new Set([weekMeta(x.scheduled_at).start, ...weeks]);
    for (const week of all) {
      await query(
        `insert into engine_dismissals (week_start, content_id, channel_id)
         values ($1,$2,$3) on conflict do nothing`,
        [week, x.content_id, x.channel_id]
      );
    }
  }
  await query(`delete from engine_dismissals where week_start < current_date - 56`);
}

/**
 * תוכן שאפשר לשייך לפוסט בערוץ channelId: יש לו ניסוח לערוץ (מוכן או
 * טיוטה), הקמפיין שלו לא מושהה, והתאריך (אם נתון) בתוך חלון הקמפיין.
 * endpointId null = מכל נקודות הקצה (פוסט שעוד אין לו נקודה).
 * מוכן קודם; בתוך כל קבוצה — מה שעוד לא שובץ בערוץ הזה, ואז הוותיק.
 */
export async function contentCandidates({ endpointId = null, channelId, date = null }) {
  const list = await rows(
    `select ci.id, ci.title, ci.kind, ci.endpoint_id, e.name as endpoint_name,
            ca.name as campaign_name, v.status as variant_status, ${candidateColumnsSql()},
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
  // קמפיין מוכן: לא לפני התאריך המתוכנן של הפריט (candidateFits)
  return list.filter((c) => candidateFits(c, channelId, date));
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

/**
 * בדיקה חוזרת של שער היחס על מה שנבחר בפועל. התכנון אישר כל מכירתי מול
 * כל ההצעה; אם המשתמש הוריד פריטי ערך, מכירתי שנשען עליהם כבר לא מאוזן.
 * קודם נכנס כל מה שאינו מכירתי (ערך, משולב, פוסטים חסרי תוכן, שיוכים),
 * ורק אז כל מכירתי נבדק מחדש מול usage.allows — אותו שער כמו בתכנון.
 * @returns {{placements:object[], dropped:object[]}}
 */
export function recheckSelection(plan, { channels, existing, settings }) {
  const usage = buildUsage(channels, existing, settings);
  for (const a of plan.attachments ?? []) usage.retag(a.channel_id, a.date, a.prev_kind, a.kind);
  for (const h of plan.holes ?? []) usage.take(h.channel_id, h.date, h.kind, -1);
  for (const p of plan.placements.filter((x) => x.kind !== 'promo')) {
    usage.take(p.channel_id, p.date, p.kind, -1);
  }
  const dropped = [];
  for (const p of plan.placements.filter((x) => x.kind === 'promo')) {
    if (usage.allows(p.channel_id, p.date, 'promo')) {
      usage.take(p.channel_id, p.date, 'promo', -1);
    } else {
      dropped.push({
        key: p.key, title: p.title,
        reason: 'בלי פריטי הערך שהורדו מהסימון אין מספיק ערך לאזן את הפוסט המכירתי',
      });
    }
  }
  const gone = new Set(dropped.map((d) => d.key));
  return { placements: plan.placements.filter((p) => !gone.has(p.key)), dropped };
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
 *
 * pairDates (postDatesPerEndpointChannel): התוכן חייב לכבד את המרווח של
 * הקמפיין שלו מול השכן הקרוב — פוסט שהיה תקין כחסר תוכן יכול להיות צמוד
 * מדי לתוכן של קמפיין עם מרווח ארוך. הפוסט עצמו ברשימה, ולכן התאריך שלו
 * יורד ממנה פעם אחת לפני המדידה.
 *
 * groupDays (linkGroupDays): תוכן מקושר לא נכנס ליום שבו כבר יוצא פוסט
 * אחר מהקבוצה שלו (linkedSameDay). לפוסט חסר תוכן אין קבוצה, ולכן אין מה
 * להוציא. אחרי השיוך — היום נרשם לקבוצה, כמו בשיבוץ.
 */
export function chooseHoleFills({
  holes, content, usedContent, history = new Map(), settings = null, usage = null,
  pairDates = new Map(), groupDays = new Map(),
}) {
  const out = [];
  for (const h of holes) {
    const at = new Date(h.scheduled_at);
    const dateKey = ymd(at);
    const slot = { channel_id: h.channel_id, dateKey };
    const neighbours = [...(pairDates.get(`${h.endpoint_id}:${h.channel_id}`) ?? [])];
    const self = neighbours.indexOf(dateKey);
    if (self >= 0) neighbours.splice(self, 1);
    const nearest = nearestDays(neighbours, dateKey);
    const fits = content.filter((c) =>
      c.endpoint_id === h.endpoint_id &&
      (c.eligible_channel_ids ?? []).includes(h.channel_id) &&
      fitsSlotChannel(c, h.channel_id) &&
      !usedContent.has(`${h.channel_id}:${c.id}`) &&
      !outsideCampaignWindow(c, dateKey) &&
      nearest >= contentGap(c, settings) &&
      !linkedSameDay(c, groupDays, dateKey) &&
      reusable(c, slot, history, settings)
    );
    if (fits.length === 0) continue;

    const isReady = (c) => (c.ready_channel_ids ?? []).includes(h.channel_id);
    fits.sort((a, b) => (isReady(b) - isReady(a)) ||
                        ((b.kind === h.kind) - (a.kind === h.kind)));
    const c = fits.find((x) => !usage ||
      usage.allowsRetag(h.channel_id, dateKey, h.kind, x.kind, x.id));
    if (!c) continue;
    usedContent.add(`${h.channel_id}:${c.id}`);
    usage?.retag(h.channel_id, dateKey, h.kind, c.kind);
    addGroupDay(groupDays, linkRoot(c), c.id, dateKey);

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

/** YYYY-MM-DD + n ימים, בלי מעבר שעון */
function addDaysKey(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** הסטטוסים של פוסט שתופס שטח — אותם שהמנוע סופר כקיימים על הלוח */
const LIVE_STATUSES = ['scheduled', 'approved', 'publishing', 'failed', 'published', 'pending_approval'];
/** פוסט שעוד עתיד לצאת — נספר בוותק כשהמועד שלו לפני השבוע המתוכנן */
const UPCOMING_STATUSES = ['scheduled', 'approved', 'publishing', 'pending_approval'];

/**
 * היעד האסטרטגי של כל נקודת קצה בשבוע המתוכנן — לא היום. קמפיין שמתחיל
 * בעוד חודש מושך את הנקודה שלו כשמתכננים את השבוע שבו הוא רץ (קודם בלאק
 * פריידי קיבל 0 משבצות, כי המנוע הסתכל רק על הקמפיינים של היום).
 *
 * היעד של נקודה = סכום הנתחים של הקמפיינים שלה שחופפים לשבוע, כל אחד ממוצע
 * הנתח היומי שלו בשבוע (averageShares — אותו חשבון כמו הרשת וציר
 * האסטרטגיה, כולל נתחים אוטומטיים). החלון שבו נמדד "בפועל" מתחיל ב-starts_on המוקדם של אותם קמפיינים,
 * ובלי תאריך כזה — 90 יום לפני השבוע; ונגמר בסוף השבוע המתוכנן.
 *
 * @param campaigns שורות campaigns עם endpoint_importance
 * @param week {days:[{date}]} — weekMeta
 * @returns {{targetPct: Map<number, number>, from: string, to: string, shares: Map}}
 *   shares — הנתח הממוצע של כל קמפיין בשבוע (averageShares)
 */
export function strategyTargets(campaigns, week) {
  const weekFrom = week.days[0].date;
  const weekTo = week.days[week.days.length - 1].date;
  const shares = averageShares(campaigns, { from: weekFrom, to: weekTo });

  const targetPct = new Map();
  const starts = [];
  for (const c of campaigns) {
    if (!shares.has(c.id)) continue;
    targetPct.set(c.endpoint_id, (targetPct.get(c.endpoint_id) ?? 0) + shares.get(c.id) * 100);
    if (c.starts_on) starts.push(String(c.starts_on).slice(0, 10));
  }
  const from = starts.sort()[0] ?? addDaysKey(weekFrom, -90);
  return { targetPct, from, to: weekTo, shares };
}

/**
 * כמה כל נקודה מפגרת אחרי היעד שלה (0..1).
 *
 * בסיס אחד לשני הצדדים, כמו currentAllocation: "בפועל" = החלק של הנקודה
 * מהפוסטים החיים בחלון של הנקודות שיש להן יעד בלבד (counts: [{endpoint_id, n}]),
 * והיעדים מנורמלים לאותו בסיס (חלקי סכום היעדים). אחרת נקודה שוטפת בלי
 * קמפיין, שמתפרסמת הרבה, הייתה משאירה את נקודות הקמפיינים בפיגור קבוע —
 * ולהפך, יעדים שסכומם מתחת ל-100% היו נמדדים מול בפועל שסכומו 100%.
 * מכאן שקמפיין יחיד בשבוע לא מפגר אחרי אף אחד: הדחיפה שלו היא "קמפיין רץ"
 * והוותק, לא הנתח.
 */
export function strategyDeficits(targetPct, counts) {
  const targetSum = [...targetPct.values()].reduce((s, v) => s + v, 0);
  const mine = counts.filter((c) => targetPct.has(c.endpoint_id));
  const total = mine.reduce((s, c) => s + c.n, 0);
  const actual = new Map(mine.map((c) => [c.endpoint_id, total ? (c.n / total) * 100 : 0]));
  const out = new Map();
  for (const [id, target] of targetPct) {
    const want = targetSum > 0 ? (target / targetSum) * 100 : 0;
    out.set(id, Math.max(0, want - (actual.get(id) ?? 0)) / 100);
  }
  return out;
}

/**
 * נקודת הייחוס של הוותק: תחילת השבוע המתוכנן, או עכשיו אם השבוע כבר התחיל.
 * תכנון שבוע עתידי שואל "כמה זמן הנקודה תחכה עד השבוע הזה", לא "כמה זמן
 * עבר עד היום".
 */
export function stalenessReference(week, now = new Date()) {
  const start = new Date(`${week.days[0].date}T00:00:00`);
  return start > now ? start : now;
}

/**
 * הוותק של נקודה: הימים מהפוסט החי האחרון שלה לפני נקודת הייחוס ועד אליה,
 * ביחס לקצב שלה. נקודה בלי אף פוסט חי לפני הייחוס (daysSince = null, "עוד
 * לא פורסמה"): max(2, min(הימים מאז שנוצרה / קצב, cap)). cap — הוותק הגבוה
 * ביותר של נקודה שכן יש לה פוסט לפני הייחוס, באותה ריצה (3 כשאין כזו;
 * ראו computeDebts). כך היא לא מפסידה רק כי לא פורסמה (בשבוע רחוק היא
 * שווה לוותיקה ביותר — קודם 2 קבוע, וובינר ירד ל-0 בשבוע של בלאק פריידי),
 * וגם לא בולעת את הלוח (שנה = 30 בלי התקרה); 0.6- לכל שיבוץ מפזר אותה.
 * בלי created_at — 2.
 */
export function stalenessOf(lastAt, reference, endpoint, cap = 3) {
  const cadence = Math.max(1, effectiveCadenceDays(endpoint));
  if (lastAt) {
    const daysSince = (reference - new Date(lastAt)) / 86400000;
    return { daysSince, staleness: daysSince / cadence };
  }
  const age = endpoint?.created_at ? (reference - new Date(endpoint.created_at)) / 86400000 : null;
  return { daysSince: null, staleness: age === null ? 2 : Math.max(2, Math.min(age / cadence, cap)) };
}

/** חוב האוויר של כל נקודה לשבוע המתוכנן. מיוצא לבדיקות. */
export async function computeDebts(endpoints, settings, perf = null, week = weekMeta(new Date()), now = new Date()) {
  // הפוסט האחרון של כל נקודה לפני נקודת הייחוס, משני סוגים:
  //  - מה שפורסם (מתי שפורסם), בכל זמן לפני הייחוס;
  //  - מה שעוד עתיד לצאת (מתוכנן/מאושר/ממתין/בפרסום, scheduled_at >= עכשיו)
  //    ולפני הייחוס — שבוע עתידי רואה מה כבר שובץ לפניו.
  // לא נספרים: נכשל, ומה שהמועד שלו עבר ולא יצא — הם לא באמת עלו לאוויר,
  // והנקודה עדיין מחכה. קודם נמדד מהיום לפי הפרסום האחרון בלבד, ושבוע
  // עתידי התעלם ממה שכבר שובץ לפניו — בלאק פריידי קיבל 0/12 משבצות.
  // בשבוע הנוכחי (ייחוס = עכשיו) אין "עתיד לפני הייחוס", ולכן זה בדיוק
  // הפרסום האחרון, כמו קודם. שיבוץ של קמפיין מושהה לא נספר (לא על הלוח).
  const reference = stalenessReference(week, now);
  const lastLive = await rows(
    `select p.endpoint_id, max(coalesce(p.published_at, p.scheduled_at)) as last_at
       from posts p
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.endpoint_id is not null
        and ((p.status = 'published' and coalesce(p.published_at, p.scheduled_at) < $1)
          or (p.status = any($3::text[]) and p.published_at is null
              and p.scheduled_at >= $2 and p.scheduled_at < $1
              and ca.paused_at is null))
      group by p.endpoint_id`,
    [reference, now, UPCOMING_STATUSES]
  );
  const lastMap = new Map(lastLive.map((r) => [r.endpoint_id, r.last_at]));

  // פער מהנתח של הקמפיינים שרצים בשבוע המתוכנן. קמפיין מושהה לא מתחרה על
  // שטח (normalizeShares מסנן אותו), בדיוק כמו שהוא לא מוצג בלוח.
  const campaigns = await rows(
    `select c.*, e.importance as endpoint_importance
       from campaigns c join endpoints e on e.id = c.endpoint_id`);
  const { targetPct, from, to, shares } = strategyTargets(campaigns, week);
  // "בפועל" נספר מכל מה שתופס שטח — גם מה שמתוכנן לשבוע הזה ולפניו, לא רק
  // מה שפורסם — כדי שתכנון שבוע עתידי יראה מה כבר שובץ לפניו. שיבוץ של
  // קמפיין מושהה לא נספר (כמו existing ב-planWeek), אלא אם כבר פורסם.
  const counts = targetPct.size === 0 ? [] : await rows(
    `select p.endpoint_id, count(*)::int as n
       from posts p
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.endpoint_id is not null
        and p.status = any($3::text[])
        and (ca.paused_at is null or p.status = 'published')
        -- פוסט שפורסם נספר לפי מתי שפורסם, אחר — לפי מתי שמתוכנן. שני תנאים
        -- נפרדים ולא coalesce, כדי שהאינדקסים על published_at ו-scheduled_at ישמשו
        and ((p.published_at >= $1::date and p.published_at < ($2::date + 1))
          or (p.published_at is null
              and p.scheduled_at >= $1::date and p.scheduled_at < ($2::date + 1)))
      group by p.endpoint_id`,
    [from, to, LIVE_STATUSES]
  );
  const deficits = strategyDeficits(targetPct, counts);

  const scheduledBoost = new Map(); // כמה כבר הצענו לה בריצה הזו

  // התקרה של נקודה שלא פורסמה: הוותיקה ביותר מבין אלה שיש להן פוסט לפני
  // הייחוס (3 כשאין אף אחת) — ראו stalenessOf
  const published = endpoints.filter((e) => lastMap.has(e.id))
    .map((e) => stalenessOf(lastMap.get(e.id), reference, e).staleness);
  const neverCap = published.length ? Math.max(...published) : 3;

  const parts = new Map();
  for (const e of endpoints) {
    const { daysSince, staleness } = stalenessOf(lastMap.get(e.id) ?? null, reference, e, neverCap);

    const deficit = deficits.get(e.id) ?? 0;

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
    /** הנתח הממוצע של קמפיין בשבוע המתוכנן (0 כשאינו רץ בו) */
    campaignShare: (campaignId) => shares.get(Number(campaignId)) ?? 0,
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

/**
 * מצב הקיבולת של שבוע: תקציב לכל ערוץ, מונים לפי סוג/יום/שעה, ושער היחס
 * בין ערך למכירתי.
 *
 * projectedPromoCap — שבוע מרוסן של מילוי קמפיין (onlyCampaignId): הלוח
 * של השבוע עוד לא מלא (שבועות רחוקים מתמלאים בתוכן הקמפיין בלבד), ולכן
 * "כמה ערך כבר יש" לא אומר כלום — קמפיין שכולו מכירתי (בלאק פריידי) היה
 * מקבל 0 בשקט. במקומו תקרה צפויה: מכירתיים לשבוע = floor(סך התקציבים של
 * הערוצים / (1 + min_value_per_promo)), פחות המכירתי שכבר על הלוח באותו
 * שבוע (משולב נספר חלקית, כמו בשער הרגיל — kindWeights). 0 = שער כבוי.
 *
 * blocked — זוגות `${channel}:${content}` שנחסמו בשער היחס (כשהקורא מעביר
 * contentId), כדי לומר למשתמש כמה פוסטים מכירתיים לא שובצו בגללו.
 */
export function buildUsage(channels, existing, settings, { projectedPromoCap = false } = {}) {
  const byChannel = new Map();
  for (const ch of channels) {
    // חלק מהקיבולת נשמר לדברים דחופים ולכן המנוע לא נוגע בו. אותו חשבון
    // שמחשב כמה נכנס לקמפיין (capacity.js) — מקור אחד.
    byChannel.set(ch.id, {
      ch,
      budget: channelBudget(ch),
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
  const blockedPairs = new Set(); // `${channel}:${content}` שנחסמו בשער היחס

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

  // שער היחס מול המשקלים של השבוע: האם עוד מכירתי אחד חורג
  const totalBudget = [...byChannel.values()].reduce((sum, u) => sum + u.budget, 0);
  const promoCap = Math.floor(totalBudget / (1 + minRatio));
  const ratioBlocks = (w) => (projectedPromoCap
    ? minRatio > 0 && w.promo + 1 > promoCap
    : w.value < minRatio * (w.promo + 1));
  const block = (channelId, contentId) => {
    promoBlocked += 1;
    if (contentId != null) blockedPairs.add(`${channelId}:${contentId}`);
    return false;
  };

  return {
    channelHasRoom: (channelId) => {
      const u = byChannel.get(channelId);
      return !!u && u.used < u.budget;
    },
    dayCount: (channelId, dateKey) => byChannel.get(channelId)?.perDay.get(dateKey) ?? 0,
    dayTotal: (dateKey) => allPerDay.get(dateKey) ?? 0,
    hourTaken: (channelId, dateKey, hour) =>
      byChannel.get(channelId)?.hours.has(`${channelId}:${dateKey}:${hour}`) ?? false,

    /** האם מותר להכניס פוסט מסוג kind לערוץ ביום הזה (contentId — לספירת חסומים) */
    allows(channelId, dateKey, kind, contentId = null) {
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
        // (או, בשבוע מרוסן, רק עד התקרה הצפויה)
        if (ratioBlocks(kindWeights(weekKind, hybridWeight))) return block(channelId, contentId);
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
    allowsRetag(channelId, dateKey, fromKind, toKind, contentId = null) {
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
        if (ratioBlocks(kindWeights(without, hybridWeight))) return block(channelId, contentId);
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
      blockedPairs: [...blockedPairs],
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
 *
 * today (YYYY-MM-DD, לא חובה) — ימים לפניו לא נכנסים: המנוע לא מציע פוסט
 * לתאריך שכבר עבר. בלי today — כל השבוע (בדיקות של הלולאה על שבוע קבוע).
 */
export function buildSlots(week, channels, perf = null, { today = null } = {}) {
  const slots = [];
  for (const ch of channels) {
    week.days.forEach((day, index) => {
      if (today && day.date < today) return;
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
 * העמודות ש-outsideCampaignWindow צריך כדי לכבד "קמפיין מוכן", לשאילתת
 * תוכן עם הכינויים ci (content_items) ו-ca (campaigns). המקום של הפריט
 * בתור של הקמפיין (בכללי — של המדיה שלו) וכמה פריטים בתור, כמו ברשת
 * (src/campaigns.js). שאילתות משנה ולא פונקציית חלון — כדי שהמספרים לא
 * ישתנו לפי מה שהשאילתה החיצונית מסננת. רק כשהקמפיין סומן מוכן.
 */
export const COMPLETE_SPREAD_COLUMNS = `
  ca.content_complete_at as campaign_complete_at,
  case when ca.content_complete_at is not null then (
    select count(*)::int from content_items x
     where x.campaign_id = ci.campaign_id
       and x.slot_channel_id is not distinct from ci.slot_channel_id
       and (x.sort_order, x.id) <= (ci.sort_order, ci.id)) end as campaign_slot_rank,
  case when ca.content_complete_at is not null then (
    select count(*)::int from content_items x
     where x.campaign_id = ci.campaign_id
       and x.slot_channel_id is not distinct from ci.slot_channel_id) end as campaign_slot_count`;

/**
 * התאריך המתוכנן של פריט בקמפיין שסומן מוכן: פרוס אחיד על התקופה לפי
 * המקום שלו בתור — אותה spreadDate שהרשת מציגה. null = אין תאריך מתוכנן
 * (קמפיין רגיל, בלי תאריכים, או שהעמודות לא נשלפו).
 */
export function plannedDate(c) {
  if (!c?.campaign_complete_at || !c.campaign_starts_on || !c.campaign_ends_on) return null;
  if (!c.campaign_slot_rank || !c.campaign_slot_count) return null;
  return spreadDate(c.campaign_starts_on, c.campaign_ends_on,
    c.campaign_slot_rank - 1, c.campaign_slot_count);
}

/** בתוך החלון של הקמפיין, אבל לפני התאריך המתוכנן של הפריט (קמפיין מוכן) */
function waitingForPlannedDate(c, dateKey) {
  const planned = plannedDate(c);
  return !!planned && dateKey < planned &&
    !(c.campaign_starts_on && dateKey < c.campaign_starts_on) &&
    !(c.campaign_ends_on && dateKey > c.campaign_ends_on);
}

/**
 * האם התאריך מחוץ לחלון של הקמפיין שהתוכן שייך אליו. תוכן שוטף (בלי
 * קמפיין) וקמפיין בלי תאריכים — אף פעם לא מחוץ לחלון. התאריכים הם
 * YYYY-MM-DD, ולכן השוואת מחרוזות מדויקת.
 *
 * קמפיין מוכן: פריט לא יוצא לפני התאריך המתוכנן שלו (plannedDate) — אחרת
 * קמפיין קטן היה נגמר בשבועות הראשונים בקצב המלא של המדיה. אחריו מותר,
 * אם המשבצת שלו התפספסה.
 */
export function outsideCampaignWindow(c, dateKey) {
  if (!c?.campaign_id) return false;
  if (c.campaign_starts_on && dateKey < c.campaign_starts_on) return true;
  if (c.campaign_ends_on && dateKey > c.campaign_ends_on) return true;
  const planned = plannedDate(c);
  if (planned && dateKey < planned) return true;
  return false;
}

/**
 * המרווח שהתוכן הזה דורש בינו לבין פוסט אחר של אותה נקודה באותו ערוץ: של
 * הקמפיין שלו (campaign_min_gap_days), ותוכן בלי קמפיין — הכללי.
 */
export function contentGap(c, settings) {
  return effectiveGap(c?.campaign_id ? { min_gap_days: c.campaign_min_gap_days } : null, settings);
}

/**
 * המרחק בימים מהתאריך dateKey לפוסט הקרוב ביותר ברשימה, לפני או אחרי.
 * Infinity כשאין אף פוסט. שני הכיוונים: פוסט עתידי שכבר על הלוח קובע
 * בדיוק כמו פוסט שעבר — קודם נבדק רק האחרון בזמן (max), ופוסט עתידי הסתיר
 * שכן קרוב שלפניו.
 */
export function nearestDays(dates, dateKey) {
  let best = Infinity;
  const at = new Date(dateKey).getTime();
  for (const d of dates ?? []) {
    const days = Math.abs(Math.round((at - new Date(d).getTime()) / 86400000));
    if (days < best) best = days;
  }
  return best;
}

/** מוסיף תאריך לרשימה של נקודה×ערוץ, בסדר עולה */
export function addPairDate(map, key, dateKey) {
  const list = map.get(key) ?? [];
  list.push(dateKey);
  list.sort();
  map.set(key, list);
}

/* ========================= פוסטים מקושרים ========================= */

/**
 * הסטטוסים של פוסט שנספר ביום של קבוצת קישור: כל מה שעוד יוצא או כבר יצא.
 * נכשל לא נספר — הוא לא יצא, והמשתמש יקבע לו מועד חדש.
 */
export const LINK_LIVE_STATUSES = ['scheduled', 'approved', 'publishing', 'published', 'pending_approval'];

/** שורש קבוצת הקישור של פריט תוכן: המקור, או הפריט עצמו (רמה אחת — links.js) */
export const linkRoot = (c) => c.linked_to_id ?? c.id;

/**
 * רושם שפריט התוכן contentId (מהקבוצה rootId) יוצא ביום dateKey.
 * groupDays: rootId → (YYYY-MM-DD → מזהי תוכן, עם כפילויות — אותו פריט
 * בשני ערוצים נרשם פעמיים, כדי שהסרה של אחד תשאיר את השני).
 */
export function addGroupDay(groupDays, rootId, contentId, dateKey) {
  if (rootId == null || contentId == null) return;
  if (!groupDays.has(rootId)) groupDays.set(rootId, new Map());
  const days = groupDays.get(rootId);
  days.set(dateKey, [...(days.get(dateKey) ?? []), contentId]);
}

/** מוריד רישום אחד (פוסט שזז) — ההפך של addGroupDay */
export function removeGroupDay(groupDays, rootId, contentId, dateKey) {
  const list = groupDays.get(rootId)?.get(dateKey);
  const i = list ? list.indexOf(contentId) : -1;
  if (i >= 0) list.splice(i, 1);
}

/**
 * האם ביום הזה כבר יוצא פוסט של פריט *אחר* מאותה קבוצה. אותו פריט בערוץ
 * אחר לא נחשב — זה לא פוסט מקושר, זה אותו תוכן (והמנוע מאפשר אותו כמו קודם).
 */
export function linkDayTaken(groupDays, rootId, contentId, dateKey) {
  const list = groupDays.get(rootId)?.get(dateKey);
  return !!list && list.some((id) => id !== contentId);
}

/**
 * תוכן c לא נכנס ליום dateKey: הקמפיין שלו מבקש שפוסטים מקושרים לא ייצאו
 * באותו יום (links_apart, ברירת מחדל כן) ופריט אחר מהקבוצה כבר יוצא בו —
 * בכל ערוץ. c — שורת תוכן עם id, linked_to_id, campaign_links_apart.
 */
export function linkedSameDay(c, groupDays, dateKey) {
  return c.campaign_links_apart !== false && linkDayTaken(groupDays, linkRoot(c), c.id, dateKey);
}

/**
 * הימים של כל קבוצת קישור סביב השבוע המתוכנן, מהפוסטים החיים
 * (LINK_LIVE_STATUSES) — רק פריטים שבאמת בקבוצה (עוקבת, או מקור שיש לו
 * עוקבות). יומיים לכל צד מספיקים: הכלל הוא "לא באותו יום".
 */
export async function linkGroupDays(from, to) {
  const r = await rows(
    `select p.content_id, coalesce(ci.linked_to_id, ci.id) as root, p.scheduled_at
       from posts p join content_items ci on ci.id = p.content_id
       left join campaigns ca on ca.id = ci.campaign_id
      where p.status = any($3)
        -- פוסט של קמפיין מושהה ירד מהלוח (אלא אם כבר פורסם), כמו existing
        and (ca.paused_at is null or p.status = 'published')
        and (ci.linked_to_id is not null
             or exists (select 1 from content_items f where f.linked_to_id = ci.id))
        and p.scheduled_at >= $1::timestamptz - interval '2 days'
        and p.scheduled_at <= $2::timestamptz + interval '2 days'`,
    [from, to, LINK_LIVE_STATUSES]
  );
  const map = new Map();
  for (const x of r) addGroupDay(map, x.root, x.content_id, ymd(new Date(x.scheduled_at)));
  return map;
}

export function chooseForSlot(ctx) {
  const { slot, endpoints, content, campaigns, debts, usage,
          usedContent, pairDates = new Map(), settings, history, sameDay,
          groupDays = new Map() } = ctx;

  const candidates = [];

  for (const e of endpoints) {
    // אותה נקודה, אותה מדיה, אותו יום — לא משנה מאיזה סוג
    if (sameDay.has(`${e.id}:${slot.channel_id}:${slot.dateKey}`)) continue;
    // המרחק מהפוסט הקרוב של הנקודה בערוץ הזה. המרווח עצמו תלוי בתוכן — כל
    // קמפיין קובע את שלו — ולכן נבדק לכל מועמד בנפרד, למטה.
    const nearest = nearestDays(pairDates.get(`${e.id}:${slot.channel_id}`), slot.dateKey);

    // טיוטה נחשבת מועמדת כמו תוכן מוכן — השיבוץ הולך לפי האסטרטגיה,
    // לא לפי אם כבר נכתב טקסט סופי. bool כדי שאפשר יהיה להעדיף מוכן
    // על פני טיוטה כשיש ברירה, בלי לפסול טיוטה כשאין ברירה אחרת.
    const ready = content.filter((c) =>
      c.endpoint_id === e.id &&
      (c.eligible_channel_ids ?? []).includes(slot.channel_id) &&
      fitsSlotChannel(c, slot.channel_id) &&
      !outsideCampaignWindow(c, slot.dateKey) &&
      nearest >= contentGap(c, settings) &&
      !linkedSameDay(c, groupDays, slot.dateKey) &&
      !usedContent.has(`${slot.channel_id}:${c.id}`) &&
      reusable(c, slot, history, settings) &&
      usage.allows(slot.channel_id, slot.dateKey, c.kind, c.id)
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
  if (p.deficit > 0.05) bits.push(`מפגרת ${Math.round(p.deficit * 100)} נק' אחרי הנתח שלה`);
  if (best.inCampaign) bits.push('קמפיין רץ');
  if (best.draft) bits.push('התוכן עוד בטיוטה — צריך לכתוב את הניסוח הסופי');
  // רק כשהיעילות הנמדדת באמת הזיזה משהו — 1.0 הוא ניטרלי ולא מעניין
  if (p.performance != null && Math.abs(p.performance - 1) >= 0.08) {
    bits.push(p.performance > 1
      ? `ביצועים גבוהים (${p.performance.toFixed(2)})`
      : `ביצועים נמוכים (${p.performance.toFixed(2)})`);
  }
  bits.push(`חשיבות ${best.endpoint.importance}`);

  return { ...best, reason: bits.join(' · ') };
}

/* ========================= חורים ========================= */

/** השעה של פוסט חסר תוכן (באותו ערוץ ויום תפוסים — השעה הפנויה הבאה) */
const HOLE_HOUR = 12;

/**
 * נקודה שהחוב שלה גבוה אבל אין לה תוכן מוכן — הלוח צריך להראות
 * שהוא מחכה לה, ולא סתם לדלג עליה בשקט.
 *
 * פוסט חסר תוכן הוא פוסט לכל דבר, ולכן עובר את אותם כללים כמו שיבוץ רגיל
 * (קודם הוא עקף את כולם): usage.allows לסוג 'value' — הסוג שבו הוא נפתח —
 * כלומר תקציב, יום חסום ותקרת ערך שבועית (מכירתי ליום ושער היחס לא חלים על
 * ערך); לא באותו יום כמו פוסט אחר של הנקודה באותו ערוץ (sameDay); ומרווח
 * מהשכן הקרוב לשני הכיוונים (pairDates) — המרווח הכללי, כי אין תוכן ולכן
 * אין קמפיין. הערוצים נבדקים מהפנוי ביותר; ערוץ בלי יום חוקי — עוברים לבא.
 * אחרי היצירה הפוסט נכנס ל-sameDay ול-pairDates, כמו שיבוץ.
 */
export function findHoles({ endpoints, content, debts, channels, usage, week, existing,
                            now = new Date(), pairDates = new Map(), sameDay = new Set(),
                            settings = null }) {
  const holes = [];
  const gap = effectiveGap(null, settings);
  const at = (date, hour) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`);

  for (const e of endpoints) {
    const p = debts.parts(e.id);
    if (!p || p.staleness < 1) continue;                 // עוד בקצב
    if (debts.scheduledCount(e.id) > 0) continue;         // כבר קיבלה שיבוץ בריצה הזו
    if (existing.some((x) => x.endpoint_id === e.id)) continue; // כבר על הלוח השבוע

    const mine = content.filter((c) => c.endpoint_id === e.id);

    // הערוץ הכי פנוי שיש בו יום חוקי — שם נשבץ בלי תוכן. גם טיוטה כבר
    // נבדקה ונפסלה למעלה בלולאת ה-slots הרגילה, אז אם הגענו לכאן — באמת אין כלום.
    const legal = (ch) => (dateKey) =>
      at(dateKey, HOLE_HOUR) > now &&
      usage.allows(ch.id, dateKey, 'value') &&
      !sameDay.has(`${e.id}:${ch.id}:${dateKey}`) &&
      nearestDays(pairDates.get(`${e.id}:${ch.id}`), dateKey) >= gap;
    let target = null;
    let day = null;
    for (const ch of channels.filter((x) => usage.remaining(x.id) > 0)
      .sort((a, b) => usage.remaining(b.id) - usage.remaining(a.id))) {
      // לא בתחילת השבוע, כדי שיישאר זמן לכתוב; ומתוך מה שנשאר — היום שהכי
      // רחוק ממה שכבר תפוס באותו ערוץ, כדי שהחורים לא ייערמו כולם על יום אחד.
      day = pickHoleDay(week, ch, usage, ymd(now), legal(ch));
      if (day) { target = ch; break; }
    }
    if (!target) continue; // אין ערוץ עם יום עתידי שמותר לשים בו פוסט לנקודה

    let hour = HOLE_HOUR;
    while (usage.hourTaken(target.id, day.date, hour) && hour < 22) hour += 1;
    if (usage.hourTaken(target.id, day.date, hour)) continue; // עד 22:00 הכול תפוס
    // תופסים בפועל את המקום כדי ששיבוץ נוסף באותה ריצה לא יחשוב שהמשבצת פנויה.
    usage.take(target.id, day.date, 'value', hour);
    sameDay.add(`${e.id}:${target.id}:${day.date}`);
    addPairDate(pairDates, `${e.id}:${target.id}`, day.date);

    holes.push({
      channel_id: target.id,
      channel_name: target.name,
      endpoint_id: e.id,
      endpoint_name: e.name,
      kind: 'value',
      date: day.date,
      day_label: day.label,
      scheduled_at: at(day.date, hour).toISOString(),
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
  // קמפיין מוכן: התוכן בחלון, אבל כל פריט מחכה לתאריך המתוכנן שלו
  if (endpointContent.every((c) => outsideCampaignWindow(c, dateKey)) &&
      endpointContent.some((c) => waitingForPlannedDate(c, dateKey))) {
    return 'התוכן של הקמפיין מתוכנן לתאריכים מאוחרים יותר';
  }
  if (endpointContent.every((c) => outsideCampaignWindow(c, dateKey))) {
    return 'התוכן של נקודת הקצה שייך לקמפיינים שלא רצים בתאריך הזה, ואין לה תוכן שוטף';
  }
  return 'יש תוכן לנקודה הזו, אבל אף גרסה לא מתאימה לערוץ פנוי כרגע';
}

/**
 * היום שבו יישב פוסט חסר תוכן: לא בתחילת השבוע, ורחוק ככל האפשר משאר הלוח
 * של הערוץ. לא לפני today, ורק יום ש-ok מאשר (findHoles: תקציב, יום חסום,
 * אותו יום, מרווח). כשאין יום כזה אחרי תחילת השבוע — היום החוקי הראשון
 * בתחילתו; null כשאין בכלל (קודם נפל ליום הרביעי גם כשהוא חסום).
 */
function pickHoleDay(week, channel, usage, today = null, ok = () => true) {
  const legal = week.days
    .map((day, index) => ({ day, index }))
    .filter(({ day }) => {
      if (today && day.date < today) return false;
      const dow = new Date(`${day.date}T00:00:00`).getDay();
      return !(channel.blocked_days ?? []).includes(dow) && ok(day.date);
    });
  const usable = legal.filter(({ index }) => index >= 2); // צריך זמן לכתוב
  if (usable.length === 0) return legal[0]?.day ?? null;

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
 * תוכן חד-פעמי (ברירת המחדל) יוצא לאוויר פעם אחת בכל ערוץ שיש לו גרסה
 * אליו, ונגמר שם. קודם "פעם אחת" נספר על כל הערוצים יחד: זווית שנחתה
 * בפייסבוק (גרירה ידנית, או שבאינסטגרם לא היה מקום באותו שבוע) לא הגיעה
 * לאינסטגרם לעולם — בזמן שהרשת ו-unplacedOf (לפי תוכן×ערוץ) הראו אותה
 * ממתינה. בתוך ריצה אחת היא כן יכלה לצאת בשניהם, כך שהתוצאה הייתה מזל.
 * תוכן evergreen חוזר, אבל רק אחרי שעבר מספיק זמן מהפעם הקרובה באותו ערוץ
 * — לשני הכיוונים: פוסט עתידי רחוק לא מסתיר פעם קרובה לפני המשבצת.
 *
 * תוכן מקושר (linked_to_id) לא מושפע: כל משבצת בקבוצה היא פריט נפרד שקשור
 * לערוץ אחד (slot_channel_id, fitsSlotChannel), ולכל ערוץ לכל היותר אחת.
 */
function reusable(c, slot, history, settings) {
  const here = history.get(c.id)?.datesByChannel.get(slot.channel_id);
  if (!here?.length) return true; // עוד לא היה בערוץ הזה

  if (!c.evergreen) return false;

  // מרווח שימוש חוזר של התוכן — לא המרווח של הקמפיין; ברירת המחדל הכללית
  return nearestDays(here, slot.dateKey) >= (c.reuse_after_days ?? effectiveGap(null, settings));
}

/** כל התאריכים שבהם כל פריט תוכן פורסם או שובץ, לכל ערוץ */
async function contentHistory() {
  const r = await rows(
    `select content_id, channel_id, array_agg(scheduled_at order by scheduled_at) as dates
       from posts
      where content_id is not null
        and status in ('scheduled','approved','publishing','failed','published','pending_approval')
      group by content_id, channel_id`
  );
  const map = new Map();
  for (const x of r) {
    if (!map.has(x.content_id)) map.set(x.content_id, { datesByChannel: new Map() });
    map.get(x.content_id).datesByChannel.set(x.channel_id, x.dates.map((d) => ymd(new Date(d))));
  }
  return map;
}

/**
 * כל התאריכים שבהם לנקודת קצה יש פוסט חי בערוץ, סביב השבוע המתוכנן —
 * מפה `${endpoint_id}:${channel_id}` → YYYY-MM-DD ממוינים. המרווח נבדק מול
 * השכן הקרוב לשני הכיוונים (nearestDays), ולכן צריך את כולם ולא רק את
 * האחרון. הטווח: השבוע ± המרווח הגדול ביותר שאפשר (30 — התקרה של מרווח
 * קמפיין — או הכללי אם גדול יותר); פוסט רחוק מזה לא משנה שום החלטה.
 * אותם מצבים כמו בלוח (LIVE ב-gap.js).
 */
async function postDatesPerEndpointChannel(from, to, settings) {
  const horizon = Math.max(30, effectiveGap(null, settings));
  const r = await rows(
    `select endpoint_id, channel_id, scheduled_at
       from posts
      where endpoint_id is not null
        and status in ('scheduled','approved','publishing','failed','published','pending_approval')
        and scheduled_at >= $1::timestamptz - make_interval(days => $3)
        and scheduled_at <= $2::timestamptz + make_interval(days => $3)
      order by scheduled_at`,
    [from, to, horizon]
  );
  const map = new Map();
  for (const x of r) {
    const key = `${x.endpoint_id}:${x.channel_id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ymd(new Date(x.scheduled_at)));
  }
  return map;
}
