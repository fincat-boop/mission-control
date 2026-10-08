import { currentOrg, one, rows, query } from './db.js';
import { weekMeta, ymd, effectiveCadenceDays } from './board.js';
import { performanceMultipliers, hourBucket } from './performance.js';
import { candidateColumnsSql, candidateFilterSql, candidateFits, fitsSlotChannel } from './candidates.js';
import { spreadDate } from '../public/js/core/period.js';
import {
  averageSharesByChannel, channelBudget, effectiveGap, gapOn, kindWeights, promoRoomAllows,
  RATIO_WINDOW_DAYS, ratioPromoLimit, ratioWindowStart, weeklyPromoCap, windowRatio,
} from './capacity.js';
import { CAMPAIGNS_WEIGHTED_SQL, loadGapContext } from './capacity-db.js';
import { isEmptyContent } from './publish/readiness.js';
import { itemAssetsSql } from './links.js';
import { endpointLiveSql, postIsLiveSql } from './live.js';
import {
  KIND_LIMITS, LIMIT_ORDER, kindLimits, mergeLimits, notPlacedNotes,
} from '../public/js/core/limitNotes.js';

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

/** שעת השיבוץ כשלערוץ אין שעה משלו (channels.default_hour) */
export const DEFAULT_HOUR = 10;
/** השעה האחרונה ביום שבה המנוע עוד משבץ */
const LAST_HOUR = 22;

/**
 * שעת הפרסום הרגילה של ערוץ (סעיף 12): channels.default_hour, ובלעדיה 10:00.
 * המנוע משבץ בה, ומשם — השעה הפנויה הבאה באותו יום; היום אחרי השעה —
 * השעה העגולה הבאה. אותה ברירת מחדל במבצע דחוף וב"הוסף פוסט".
 */
export function channelHour(ch) {
  const h = ch?.default_hour;
  return h == null || Number.isNaN(Number(h)) ? DEFAULT_HOUR
    : Math.min(LAST_HOUR, Math.max(0, Math.round(Number(h))));
}

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
  // תוכן של קמפיין מושהה או לא פעיל (active = false) לא נכנס לתכנון — כמו
  // הקיבולת (capacity.js) ומילוי התקופה (campaignFillWeeks), שכבר מדלגים
  // על קמפיין לא פעיל. פוסטים שכבר על הלוח לקמפיין כזה נשארים (existing
  // למטה סופר אותם) — המנוע רק לא מוסיף.
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
         where (ca.id is null or (ca.active and ca.paused_at is null))
           -- משבצת של קמפיין כללי שהמדיה שלה הוסרה מהקמפיין: נשמרת, לא משובצת
           and (ci.slot_channel_id is null or exists (
                 select 1 from campaign_channels cc
                  where cc.campaign_id = ci.campaign_id and cc.channel_id = ci.slot_channel_id))
         group by ci.id, ca.id
         order by ci.created_at, ci.id`);
  // שיבוץ מוחזק — קמפיין מושהה, ערוץ או נקודה מושבתים (postIsLiveSql, סעיף 16) —
  // יורד מהלוח (board.js) ולכן גם לא תופס מקום בקיבולת ובמונים שהמנוע רואה
  // (buildUsage) — אחרת ערוץ נראה מלא בזמן שהלוח הפעיל ריק. פוסט שכבר פורסם
  // נשאר תפוס — זו עובדה שכבר קרתה, בדיוק כמו ב-board.js.
  const onBoard = await rows(
    `select p.id, p.channel_id, p.endpoint_id, p.content_id, p.kind, p.scheduled_at, p.status,
            p.title, p.published_at, p.auto_hole
       from posts p
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.scheduled_at >= $1 and p.scheduled_at <= $2
        and p.status in ('scheduled','approved','publishing','failed','published','pending_approval')
        and (p.status = 'published' or ${postIsLiveSql('p')})`,
    [from, to]
  );
  // מה שתופס מקום — קיבולת, אותו יום, חורים, מילוי מרוסן. פוסט שנכשל ושהמועד
  // שלו עבר לא עלה לאוויר ולא תופס (takesRoom); התוכן שלו נשאר חסום לשבוע
  // (usedContent למטה, מכל onBoard)
  const existing = onBoard.filter((p) => takesRoom(p, now));
  const campaigns = await rows('select * from campaigns where active = true and paused_at is null');
  // תוכן שהמשתמש הוריד מהשבוע הזה (מחיקת פוסט / ביטול מילוי) — לא חוזר. פוסט
  // של קמפיין שנמחק — לכל תקופת הקמפיין, כל עוד התוכן עדיין בו (סעיף 14)
  const dismissals = await rows(
    `select d.content_id, d.channel_id from engine_dismissals d
      where d.week_start = $1
         or (d.campaign_id is not null and exists (
               select 1 from content_items dci
                where dci.id = d.content_id and dci.campaign_id = d.campaign_id))`,
    [week.start]);

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
  // לפי תקרה צפויה (ראו buildUsage). שער היחס נמדד על 28 יום לכל ערוץ:
  // שלושת השבועות שלפני השבוע (prior) והשבוע עצמו
  const prior = await priorKinds(from);
  const usage = buildUsage(channels, existing, settings, { prior });

  // תוכן שכבר משובץ השבוע — או שהמשתמש הוריד מהשבוע — לא יוצע שוב לאותו ערוץ
  const usedContent = blockedContent(onBoard, dismissals);
  // מה שהיה חסום עוד לפני הריצה — לא נספר כ"לא נכנס" (notPlacedLimits)
  const usedBefore = new Set(usedContent);
  // למה תוכן לא נכנס למשבצות שבדק (chooseForSlot) — `${channel}:${content}` → סיבה → מספרים
  const misses = new Map();

  // ההיסטוריה המלאה של כל פריט תוכן בכל ערוץ — בלעדיה תוכן חד-פעמי היה
  // חוזר לאוויר בכל שבוע שבו הוא לא במקרה משובץ
  const history = await contentHistory();

  // כל הפוסטים החיים של כל נקודה בכל ערוץ סביב השבוע — לבדיקת המרווח מול
  // השכן הקרוב לשני הכיוונים (ראו contentGap / nearestDays), גם בשיוך תוכן
  // לפוסטים חסרי תוכן וגם בשיבוץ חדש
  // pairGaps — המרווח של הקמפיין של כל אחד מהם (סעיף 11: פוסט מכבד גם את
  // המרווח של השכן, לא רק את שלו — gapViolation)
  const { dates: pairDates, gaps: pairGaps } =
    await postDatesPerEndpointChannel(from, to, settings, now);

  // הימים שבהם כבר יוצא פוסט של כל קבוצת קישור (מקור + עוקבות), בכל ערוץ —
  // פוסט מקושר לא יוצא באותו יום כשהקמפיין מבקש (links_apart)
  const groupDays = await linkGroupDays(from, to);

  // המרווח בכל ערוץ כשלתוכן אין מרווח משלו — נגזר מהקצב של הערוץ ומכמה
  // נקודות מתחרות בו בשבוע הזה (effectiveGap + gapOn, סעיף 5)
  const gapCtx = await loadGapContext(week.start, week.end, { settings });

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
    content: candidates, usedContent, history, settings, usage, pairDates, pairGaps, groupDays,
    gapCtx,
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
  // ceil(תקציב הערוץ × הנתח הממוצע של הקמפיין בשבוע באותו ערוץ — מול מי
  // שיושב בו, סעיף 4), כולל מה שכבר שלו על הלוח באותו שבוע.
  const shareCap = new Map();
  const campaignUsed = new Map();
  if (onlyCampaignId != null) {
    for (const ch of channels) {
      shareCap.set(ch.id, Math.ceil(channelBudget(ch) * debts.campaignShare(onlyCampaignId, ch.id)));
    }
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
      usedContent, pairDates, pairGaps, settings, placements, history, sameDay, groupDays, gapCtx,
      misses,
    });
    if (!pick) continue;

    const at = new Date(slot.date);
    // שעת הפרסום הרגילה של הערוץ (סעיף 12). היום, אחרי השעה — השעה העגולה
    // הבאה, לא ויתור על כל היום
    let hour = slot.dateKey === today ? Math.max(slot.hour, now.getHours() + 1) : slot.hour;
    // התנגשות שעה באותו ערוץ באותו יום — מזיזים שעה קדימה
    while (usage.hourTaken(slot.channel_id, slot.dateKey, hour) && hour < LAST_HOUR) hour += 1;
    // היום כבר נגמר, או שגם 22:00 תפוסה (הלולאה נעצרת עליה — קודם שובץ שם שני)
    if (hour > LAST_HOUR || usage.hourTaken(slot.channel_id, slot.dateKey, hour)) continue;
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
    addPairGap(pairGaps, `${pick.endpoint.id}:${slot.channel_id}`, slot.dateKey, ownGapDays(pick.content));
    addGroupDay(groupDays, linkRoot(pick.content), pick.content.id, slot.dateKey);
    debts.markScheduled(pick.endpoint.id,
      { channelId: slot.channel_id, campaignId: pick.content.campaign_id });
    campaignUsed.set(slot.channel_id, (campaignUsed.get(slot.channel_id) ?? 0) + 1);
  }

  const holes = withHoles
    ? findHoles({ endpoints, content, debts, channels, usage, week, existing, now,
                  pairDates, pairGaps, sameDay, settings, gapCtx })
        .map((h) => ({ ...h, key: planItemKey('hole', h) }))
    : [];

  const { blockedPairs, ...ratio } = usage.ratioReport();
  // פוסטים מכירתיים שנחסמו בשער היחס ולא נכנסו בסוף לאותו ערוץ
  const landed = new Set([...placements, ...attachments].map((x) => `${x.channel_id}:${x.content_id}`));
  ratio.promo_blocked_posts = blockedPairs.filter((k) => !landed.has(k)).length;
  // מה לא נכנס ולמה — המגבלה שעצרה בפועל, עם המספרים (סעיף 6). הנתח רק
  // בשבוע מרוסן: הקמפיין הגיע לתקרה שלו בערוץ
  const limits = notPlacedLimits({
    content: candidates, channels, misses, landed, skip: usedBefore,
    open: (c, ch) => week.days.some((d) => d.date >= today && !notDueOn(c, d.date)) &&
      reusable(c, { channel_id: ch.id, dateKey: week.days[week.days.length - 1].date }, history,
               settings),
    share: (chId) => (onlyCampaignId != null && overShare(chId)
      ? { share_pct: Math.round(debts.campaignShare(onlyCampaignId, chId) * 100),
          cap: shareCap.get(chId) ?? 0 }
      : null),
  });
  // תוכן שרק מחכה למרווח — המצב הרגיל, לא "לא נכנס"
  notes.push(...notPlacedNotes(limits.filter((x) => x.reason !== 'gap')));

  const result = {
    week: { start: week.start, end: week.end, label: week.label },
    placements,
    attachments,
    holes,
    ratio,
    limits,
    notes,
  };
  // מצב הלוח שהתכנון נשען עליו — לבדיקה חוזרת של בחירה חלקית ב-applyWeek.
  // לא נספר (enumerable:false), ולכן לא נשלח ללקוח ב-/engine/plan.
  Object.defineProperty(result, 'ctx', { value: { channels, existing, settings, prior },
                                          enumerable: false });
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
    // מה לא נכנס בגלל מגבלה של הקיבולת לפי סוג (יחס, תקרה לסוג, מכירתי ליום),
    // עם ההודעה שאומרת איזו (notPlacedNotes). promo_blocked — כמה מהם
    // מכירתיים / משולבים; שם ישן, כמו קודם
    limits: kindLimits(fresh.limits),
    limit_notes: notPlacedNotes(kindLimits(fresh.limits)),
    promo_blocked: promoBlockedOf(kindLimits(fresh.limits)),
    // מה נכנס בריצה — `${channel}:${content}`; איחוד של כמה שבועות (mergeLimits)
    // מוריד ממה שלא נכנס תוכן שנכנס בשבוע אחר
    placed_pairs: [...plan.placements,
      ...plan.attachments.filter((a) => attached.some((x) => x.post_id === a.post_id))]
      .map((x) => `${x.channel_id}:${x.content_id}`),
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
 *
 * תוכן בלי טקסט ובלי מדיה לערוץ (כותרת בלבד — isEmptyContent) עדיין "חסר
 * תוכן" (סעיף 20): "לכתוב" נשארת פתוחה — נסגרת כשהתוכן מוכן
 * (taskCloseReason). הצעת החלפה נסגרת בכל מקרה: נבחר תוכן משלו. קודם רק
 * השיוך הידני פתח אותה מחדש, והמנוע סגר אותה על פוסט ריק. closed_task_ids
 * — רק מה שנשאר סגור, ש"בטל" יפתח מחדש.
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
  const variant = await one(
    'select status, body, meta from content_variants where content_id = $1 and channel_id = $2',
    [c.content_id, post.channel_id]);
  const files = await rows(itemAssetsSql('a.id, a.mime, a.variant_id'), [c.content_id, post.channel_id]);
  const platform = (await one('select platform from channels where id = $1', [post.channel_id]))?.platform;
  const empty = isEmptyContent({ platform, variant, assets: files });
  const closed = await rows(
    `update tasks set done = true, done_at = now()
      where post_id = $1 and done = false
        and (kind = 'swap' or (kind = 'write' and not $2::boolean))
      returning id`,
    [postId, empty]
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
 *
 * campaignWide — מחיקת פוסט (סעיף 14): תוכן של קמפיין נחסם בערוץ לכל תקופת
 * הקמפיין (campaign_id ברשומה), לא רק לשבוע — קודם השמירה הבאה של הקמפיין
 * החזירה אותו לשבוע שאחרי. תוכן שוטף — לשבוע, כמו קודם. "הזז לתאריך אחר"
 * נשאר הדרך לשנות רק את המועד; שיוך מפורש של המשתמש מסיר את החסימה
 * (liftDismissals).
 * @param {{content_id:number|null, channel_id:number, scheduled_at:string|Date}[]} list
 * @param {{weeks?:string[], campaignWide?:boolean}} [opts] weeks — תחילות שבוע, YYYY-MM-DD
 */
export async function recordDismissals(list, { weeks = [], campaignWide = false } = {}) {
  const items = (list ?? []).filter((x) => x?.content_id && x.channel_id && x.scheduled_at);
  if (items.length === 0) return;
  for (const x of items) {
    const campaignId = campaignWide
      ? (await one('select campaign_id from content_items where id = $1', [x.content_id]))?.campaign_id ?? null
      : null;
    const all = new Set([weekMeta(x.scheduled_at).start, ...weeks]);
    for (const week of all) {
      await query(
        `insert into engine_dismissals (week_start, content_id, channel_id, campaign_id)
         values ($1,$2,$3,$4)
         on conflict (org_id, week_start, content_id, channel_id)
           do update set campaign_id = coalesce(excluded.campaign_id, engine_dismissals.campaign_id)`,
        [week, x.content_id, x.channel_id, campaignId]
      );
    }
  }
  // חסימה לכל הקמפיין נשמרת עד 8 שבועות אחרי שהוא נגמר
  await query(
    `delete from engine_dismissals d
      where d.week_start < current_date - 56
        and (d.campaign_id is null or not exists (
              select 1 from campaigns ca where ca.id = d.campaign_id
                 and (ca.ends_on is null or ca.ends_on >= current_date - 56)))`);
}

/**
 * שיוך מפורש של המשתמש (שייך תוכן, פוסט ידני עם תוכן, החלפת תוכן בפוסט) גובר
 * על חסימה שנרשמה במחיקה (סעיף 14): התוכן חוזר להיות זמין למנוע בערוץ הזה.
 */
export async function liftDismissals(contentId, channelId) {
  if (!contentId || !channelId) return;
  await query('delete from engine_dismissals where content_id = $1 and channel_id = $2',
    [contentId, channelId]);
}

/**
 * תוכן שאפשר לשייך לפוסט בערוץ channelId: יש לו ניסוח לערוץ (מוכן או
 * טיוטה), הקמפיין שלו פעיל ולא מושהה, והתאריך (אם נתון) בתוך חלון הקמפיין.
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
        -- תוכן של נקודה מושבתת מוחזק כמו הפוסטים שלה (סעיף 16) — לא מוצע
        and ${endpointLiveSql('ci')}
        and ${candidateFilterSql({ channel: '$2::int', date: '$3::date' })}
      order by (v.status = 'ready') desc, used_on_channel, ci.created_at
      limit 100`,
    [endpointId, channelId, date]
  );
  // קמפיין מוכן: לא לפני התאריך המתוכנן של הפריט (candidateFits)
  return list.filter((c) => candidateFits(c, channelId, date));
}

/* ========================= מה לא נכנס ולמה ========================= */

// הסדר, הסוגים, האיחוד וההודעות — ב-public/js/core/limitNotes.js (גם הלקוח
// מאחד מילויים של כמה בקשות); מיוצאים מכאן לקוראים הקיימים
export { KIND_LIMITS, LIMIT_ORDER, kindLimits, mergeLimits, notPlacedNotes };

/** כמה מכירתיים / משולבים לא נכנסו בגלל מגבלה לפי סוג (שם ישן: promo_blocked) */
export const promoBlockedOf = (limits) =>
  (limits ?? []).reduce((sum, x) => sum + (x.kinds?.promo ?? 0) + (x.kinds?.hybrid ?? 0), 0);

/**
 * התוכן שהתאים לערוץ ולא נכנס אליו בריצה, מקובץ לפי (סיבה, ערוץ). סיבה —
 * הראשונה לפי LIMIT_ORDER מבין מה שעצר אותו במשבצות שנבדקו (misses), או
 * הנתח (share) כשהקמפיין הגיע לתקרה שלו בערוץ. תוכן ערך — רק כשתקרת הערך
 * של הערוץ עצרה אותו: ערך שמחכה למקום (מרווח, נתח) הוא המצב הרגיל.
 * open(c, ch) — האם התוכן בכלל יכול לצאת בערוץ השבוע (חלון קמפיין, חד-פעמי).
 * items — התוכן עצמו ({id, kind}), כדי שאיחוד של כמה שבועות (mergeLimits) לא
 * יספור פעמיים, ולא יספור תוכן שנכנס בשבוע אחר.
 * @returns {{reason, channel_id, channel_name, count, kinds, items, ...מספרים}[]}
 */
export function notPlacedLimits({ content, channels, misses, landed, skip = new Set(),
                                  open = () => true, share = () => null }) {
  const out = new Map();
  for (const c of content) {
    for (const ch of channels) {
      const k = `${ch.id}:${c.id}`;
      if (landed.has(k) || skip.has(k)) continue;
      if (!(c.eligible_channel_ids ?? []).includes(ch.id) || !fitsSlotChannel(c, ch.id)) continue;
      const reasons = new Map(misses.get(k) ?? []);
      const sh = share(ch.id, c);
      if (sh) reasons.set('share', sh);
      const why = LIMIT_ORDER.find((r) => reasons.has(r));
      if (!why || (c.kind === 'value' && why !== 'value_week') || !open(c, ch)) continue;
      const key = `${why}:${ch.id}`;
      if (!out.has(key)) {
        out.set(key, { ...reasons.get(why), reason: why, channel_id: ch.id,
                       channel_name: ch.name, count: 0, kinds: { promo: 0, hybrid: 0, value: 0 },
                       items: [] });
      }
      const e = out.get(key);
      e.count += 1;
      e.kinds[c.kind] = (e.kinds[c.kind] ?? 0) + 1;
      e.items.push({ id: c.id, kind: c.kind });
    }
  }
  return [...out.values()];
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
 * בדיקה חוזרת של שער היחס על מה שנבחר בפועל: קודם נכנס כל מה שאינו עובר
 * בשער (ערך, פוסטים חסרי תוכן, שיוכים), ואז כל מכירתי ומשולב, לפי הסדר, מול
 * usage.allows — אותו שער כמו בתכנון. השער הוא חדר מכירתי (promoRoomAllows),
 * ולכן חלק ממה שתוכנן נכנס תמיד; רשת ביטחון מול מצב שהשתנה בין התכנון לכתיבה.
 * @returns {{placements:object[], dropped:object[]}}
 */
export function recheckSelection(plan, { channels, existing, settings, prior = new Map() }) {
  const usage = buildUsage(channels, existing, settings, { prior });
  const gated = (x) => x.kind === 'promo' || x.kind === 'hybrid';
  for (const a of plan.attachments ?? []) usage.retag(a.channel_id, a.date, a.prev_kind, a.kind);
  for (const h of plan.holes ?? []) usage.take(h.channel_id, h.date, h.kind, -1);
  for (const p of plan.placements.filter((x) => !gated(x))) {
    usage.take(p.channel_id, p.date, p.kind, -1);
  }
  const dropped = [];
  for (const p of plan.placements.filter(gated)) {
    if (usage.allows(p.channel_id, p.date, p.kind)) {
      usage.take(p.channel_id, p.date, p.kind, -1);
    } else {
      dropped.push({
        key: p.key, title: p.title,
        reason: `החדר של היחס בערוץ כבר מלא — הפוסט ${
          p.kind === 'hybrid' ? 'המשולב' : 'המכירתי'} לא נכנס`,
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
  pairDates = new Map(), pairGaps = new Map(), groupDays = new Map(), gapCtx = null,
}) {
  const out = [];
  for (const h of holes) {
    const on = gapOn(gapCtx, h.channel_id);
    const at = new Date(h.scheduled_at);
    const dateKey = ymd(at);
    const slot = { channel_id: h.channel_id, dateKey };
    const pair = `${h.endpoint_id}:${h.channel_id}`;
    const neighbours = [...(pairDates.get(pair) ?? [])];
    const self = neighbours.indexOf(dateKey);
    if (self >= 0) neighbours.splice(self, 1);
    const fits = content.filter((c) =>
      c.endpoint_id === h.endpoint_id &&
      (c.eligible_channel_ids ?? []).includes(h.channel_id) &&
      fitsSlotChannel(c, h.channel_id) &&
      !usedContent.has(`${h.channel_id}:${c.id}`) &&
      !notDueOn(c, dateKey) &&
      gapViolation(contentGap(c, settings, on), neighbours, dateKey, pairGaps.get(pair),
        settings, on) == null &&
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
    // היום של הפוסט נושא עכשיו את המרווח של הקמפיין של התוכן
    setPairGap(pairGaps, pair, dateKey, ownGapDays(c));
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

/** הסטטוסים של פוסט שתופס שטח — אותם שהמנוע סופר כקיימים על הלוח */
const LIVE_STATUSES = ['scheduled', 'approved', 'publishing', 'failed', 'published', 'pending_approval'];

/**
 * האם פוסט חי תופס מקום: תקציב שבועי, מרווח, אותו יום, מכירתי ליום ותקרה
 * לסוג. פוסט שנכשל ושהמועד שלו עבר לא עלה לאוויר — הוא לא תופס מקום, ומשבצת
 * אחרת יכולה להיכנס במקומו באותו שבוע (קודם הוא אכל אחד מ-max_per_week וחסם
 * את המרווח, ושום דבר לא החליף אותו). התוכן שלו עדיין "יש לו פוסט" (HAS_POST
 * ב-campaigns.js, contentHistory כאן) — המנוע לא משבץ אותו שוב לבד; המשתמש
 * מטפל דרך משימת הכישלון (ניסיון חוזר או הזזה). נכשל שהמועד שלו עוד לפניו
 * (נדיר) — תופס מקום כמו קודם.
 */
export const takesRoom = (p, now = new Date()) =>
  p.status !== 'failed' || new Date(p.scheduled_at) > now;

/** אותו כלל כביטוי SQL. p — כינוי טבלת posts; now — ביטוי זמן (פרמטר או now()) */
export const takesRoomSql = (p = 'p', now = 'now()') =>
  `(${p}.status <> 'failed' or ${p}.scheduled_at > ${now})`;
/** פוסט שעוד עתיד לצאת — נספר בוותק כשהמועד שלו לפני השבוע המתוכנן */
const UPCOMING_STATUSES = ['scheduled', 'approved', 'publishing', 'pending_approval'];

/**
 * היעד האסטרטגי של כל נקודת קצה בשבוע המתוכנן — לא היום, ולכל ערוץ בנפרד.
 * קמפיין שמתחיל בעוד חודש מושך את הנקודה שלו כשמתכננים את השבוע שבו הוא רץ
 * (קודם בלאק פריידי קיבל 0 משבצות, כי המנוע הסתכל רק על הקמפיינים של היום).
 *
 * היעד של נקודה בערוץ = סכום הנתחים של הקמפיינים שלה שחופפים לשבוע ויושבים
 * בערוץ, כל אחד ממוצע הנתח היומי שלו בשבוע באותו ערוץ (averageSharesByChannel
 * — אותו חשבון כמו הרשת, סעיף 4). החלון שבו נמדד "בפועל" — 28 הימים של חלון
 * היחס (ratioWindowStart: שלושת השבועות שלפני השבוע המתוכנן והשבוע עצמו,
 * סעיף 9). קודם הוא התחיל ב-starts_on המוקדם של הקמפיינים בשבוע, וקמפיין
 * שהתחיל מאוחר יותר "פיגר" לתמיד מול ותיק שצבר פוסטים מתחילתו.
 *
 * @param campaigns שורות CAMPAIGNS_WEIGHTED_SQL (עם endpoint_importance ו-channel_ids)
 * @param week {days:[{date}]} — weekMeta
 * @param opts.channelIds הערוצים לחשב (ברירת מחדל — כל מי שמופיע ב-channel_ids)
 * @returns {{targetPct: Map<number, Map<number, number>>, from: string, to: string,
 *            shares: Map<number, Map>}} targetPct — ערוץ → (נקודה → אחוז);
 *   shares — ערוץ → הנתח הממוצע של כל קמפיין בשבוע (averageSharesByChannel)
 */
export function strategyTargets(campaigns, week, { channelIds = null } = {}) {
  const weekFrom = week.days[0].date;
  const weekTo = week.days[week.days.length - 1].date;
  const shares = averageSharesByChannel(campaigns, { from: weekFrom, to: weekTo, channelIds });

  const targetPct = new Map();
  for (const [ch, byCampaign] of shares) {
    const t = new Map();
    for (const c of campaigns) {
      if (!byCampaign.has(c.id)) continue;
      t.set(c.endpoint_id, (t.get(c.endpoint_id) ?? 0) + byCampaign.get(c.id) * 100);
    }
    if (t.size) targetPct.set(ch, t);
  }
  return { targetPct, from: ratioWindowStart(weekFrom), to: weekTo, shares };
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
  // הפוסט האחרון של כל נקודה לפני נקודת הייחוס, משלושה סוגים:
  //  - מה שפורסם (מתי שפורסם), בכל זמן לפני הייחוס;
  //  - מה שעוד עתיד לצאת (מתוכנן/מאושר/ממתין/בפרסום, scheduled_at >= עכשיו)
  //    ולפני הייחוס — שבוע עתידי רואה מה כבר שובץ לפניו.
  //  - מה שהמועד שלו עבר ולא סומן ("לא אושר שיצא" — UNCONFIRMED_SQL ב-
  //    unconfirmed.js, משוכפל כאן): לפי המועד. לא ידוע ≠ לא יצא — כמעט הכול
  //    מתפרסם ביד ולא מסומן, ובלי זה הנקודה נראתה רעבה והמנוע דחס אליה עוד.
  //    החלטה ה1: הפוסט לא מסומן "פורסם" אוטומטית; הוא רק לא מפיל את הוותק.
  // לא נספרים: נכשל, וממלא מקום של המנוע בלי תוכן (auto_hole) שעבר — הם לא
  // באמת עלו לאוויר. קודם נמדד מהיום לפי הפרסום האחרון בלבד, ושבוע
  // עתידי התעלם ממה שכבר שובץ לפניו — בלאק פריידי קיבל 0/12 משבצות.
  // בשבוע הנוכחי (ייחוס = עכשיו) אין "עתיד לפני הייחוס", ולכן זה בדיוק
  // הפרסום האחרון, כמו קודם. שיבוץ מוחזק (postIsLiveSql — קמפיין מושהה,
  // ערוץ / נקודה מושבתים) לא נספר: הוא לא על הלוח. אותו כלל כמו UNCONFIRMED_SQL.
  const reference = stalenessReference(week, now);
  const lastLive = await rows(
    `select p.endpoint_id, p.channel_id, max(coalesce(p.published_at, p.scheduled_at)) as last_at
       from posts p
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.endpoint_id is not null
        and ((p.status = 'published' and coalesce(p.published_at, p.scheduled_at) < $1)
          or (p.status = any($3::text[]) and p.published_at is null
              and p.scheduled_at >= $2 and p.scheduled_at < $1
              and ${postIsLiveSql('p')})
          or (p.status in ('scheduled', 'approved') and p.published_at is null
              and p.scheduled_at < $2::timestamptz - interval '30 minutes' and p.scheduled_at < $1
              and ${postIsLiveSql('p')}
              and (p.content_id is not null or p.urgent or not p.auto_hole)
              and exists (select 1 from channels uc where uc.id = p.channel_id
                             and uc.platform <> 'newsletter')))
      group by p.endpoint_id, p.channel_id`,
    [reference, now, UPCOMING_STATUSES]
  );
  // הוותק נמדד לכל נקודה × ערוץ (סעיף 8): נקודה שמתפרסמת כל שבוע בוואטסאפ
  // ונעדרת חודשיים מפייסבוק היא "טרייה" רק בוואטסאפ. lastPair — `${נקודה}:${ערוץ}`;
  // lastMap — הנקודה בכלל (האחרון מבין הערוצים), לחורים ולבדיקות
  const lastPair = new Map(lastLive.map((r) => [`${r.endpoint_id}:${r.channel_id}`, r.last_at]));
  const lastMap = new Map();
  for (const r of lastLive) {
    const cur = lastMap.get(r.endpoint_id);
    if (!cur || new Date(r.last_at) > new Date(cur)) lastMap.set(r.endpoint_id, r.last_at);
  }

  // פער מהנתח של הקמפיינים שרצים בשבוע המתוכנן, לכל ערוץ בנפרד (סעיף 4).
  // קמפיין מושהה לא מתחרה על שטח (normalizeShares מסנן אותו), בדיוק כמו
  // שהוא לא מוצג בלוח. endpoint_active — קמפיין של נקודה מושבתת לא מתחרה
  // (normalizeShares, סעיף 16)
  const campaigns = await rows(CAMPAIGNS_WEIGHTED_SQL);
  const activeChannels = await rows('select id from channels where active = true');
  const { targetPct, from, to, shares } = strategyTargets(campaigns, week,
    { channelIds: activeChannels.map((ch) => ch.id) });
  // "בפועל" נספר מכל מה שתופס שטח — גם מה שמתוכנן לשבוע הזה ולפניו, לא רק
  // מה שפורסם — כדי שתכנון שבוע עתידי יראה מה כבר שובץ לפניו. שיבוץ של
  // קמפיין מושהה לא נספר (כמו existing ב-planWeek), אלא אם כבר פורסם.
  // לכל נקודה × ערוץ × קמפיין (campaign_id null — תוכן שוטף / בלי תוכן): הנקודה
  // סוכמת על הקמפיינים, והקמפיין לבד — לבחירה בתוך הנקודה (סעיף 11)
  const byCampaign = targetPct.size === 0 ? [] : await rows(
    `select p.endpoint_id, p.channel_id, ci.campaign_id, count(*)::int as n
       from posts p
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.endpoint_id is not null
        and p.status = any($3::text[])
        and (p.status = 'published' or ${postIsLiveSql('p')})
        -- פוסט שפורסם נספר לפי מתי שפורסם, אחר — לפי מתי שמתוכנן. שני תנאים
        -- נפרדים ולא coalesce, כדי שהאינדקסים על published_at ו-scheduled_at ישמשו
        and ((p.published_at >= $1::date and p.published_at < ($2::date + 1))
          or (p.published_at is null
              and p.scheduled_at >= $1::date and p.scheduled_at < ($2::date + 1)))
      group by p.endpoint_id, p.channel_id, ci.campaign_id`,
    [from, to, LIVE_STATUSES]
  );
  const countMap = new Map();
  for (const r of byCampaign) {
    const k = `${r.endpoint_id}:${r.channel_id}`;
    countMap.set(k, (countMap.get(k) ?? 0) + r.n);
  }
  const counts = [...countMap].map(([k, n]) => {
    const [endpoint_id, channel_id] = k.split(':').map(Number);
    return { endpoint_id, channel_id, n };
  });
  // ערוץ → (נקודה → פיגור): בכל ערוץ מול הנקודות שיש להן יעד בו
  const deficits = new Map([...targetPct].map(([ch, t]) =>
    [ch, strategyDeficits(t, counts.filter((c) => c.channel_id === ch))]));
  const deficitOf = (endpointId, channelId) => (channelId == null
    ? Math.max(0, ...[...deficits.values()].map((d) => d.get(endpointId) ?? 0))
    : deficits.get(channelId)?.get(endpointId) ?? 0);

  // הפיגור של כל קמפיין מהנתח שלו בערוץ (סעיף 11): היעד — הנתח הממוצע שלו
  // בשבוע (shares), מנורמל מול הקמפיינים שבערוץ; בפועל — החלק שלו מהפוסטים של
  // אותם קמפיינים בחלון, כולל מה שהוצע בריצה הזו (markScheduled). חיובי =
  // מפגר; שלילי = מקדים. בבחירה בין התוכן של נקודה — המפגר ביותר קודם
  const campaignCounts = new Map(); // ערוץ → (קמפיין → פוסטים בחלון)
  for (const r of byCampaign) {
    if (r.campaign_id == null) continue;
    if (!campaignCounts.has(r.channel_id)) campaignCounts.set(r.channel_id, new Map());
    const m = campaignCounts.get(r.channel_id);
    m.set(r.campaign_id, (m.get(r.campaign_id) ?? 0) + r.n);
  }
  const campaignLag = (campaignId, channelId) => {
    const target = shares.get(Number(channelId));
    if (!target?.has(Number(campaignId))) return 0;
    const want = target.get(Number(campaignId)) /
      [...target.values()].reduce((sum, v) => sum + v, 0);
    const m = campaignCounts.get(Number(channelId)) ?? new Map();
    const total = [...target.keys()].reduce((sum, id) => sum + (m.get(id) ?? 0), 0);
    return want - (total ? (m.get(Number(campaignId)) ?? 0) / total : 0);
  };

  const scheduledBoost = new Map(); // כמה כבר הצענו לה בריצה הזו

  // התקרה של נקודה שלא פורסמה: הוותיקה ביותר מבין אלה שיש להן פוסט לפני
  // הייחוס (3 כשאין אף אחת) — ראו stalenessOf. לנקודה בכלל — מול כל הנקודות;
  // לנקודה × ערוץ — מול הנקודות שיש להן פוסט באותו ערוץ (סעיף 8)
  const capOf = (has, last) => {
    const list = endpoints.filter(has).map((e) => stalenessOf(last(e), reference, e).staleness);
    return list.length ? Math.max(...list) : 3;
  };
  const neverCap = capOf((e) => lastMap.has(e.id), (e) => lastMap.get(e.id));
  const channelCaps = new Map();
  const channelNeverCap = (channelId) => {
    if (!channelCaps.has(channelId)) {
      const k = (e) => `${e.id}:${channelId}`;
      channelCaps.set(channelId, capOf((e) => lastPair.has(k(e)), (e) => lastPair.get(k(e))));
    }
    return channelCaps.get(channelId);
  };
  // הוותק של נקודה בערוץ — אותו כלל כמו לנקודה (stalenessOf), רק על הפוסטים
  // שלה בערוץ הזה; "עוד לא פורסמה בערוץ" — מאז שנוצרה, לפחות 2, עד הוותיקה בערוץ
  const pairStale = new Map();
  const stalenessIn = (e, channelId) => {
    const k = `${e.id}:${channelId}`;
    if (!pairStale.has(k)) {
      pairStale.set(k, stalenessOf(lastPair.get(k) ?? null, reference, e,
        channelNeverCap(channelId)));
    }
    return pairStale.get(k);
  };
  const byId = new Map(endpoints.map((e) => [e.id, e]));

  const parts = new Map();
  for (const e of endpoints) {
    const { daysSince, staleness } = stalenessOf(lastMap.get(e.id) ?? null, reference, e, neverCap);

    // המכפיל מרוכז סביב 1.0 (ניטרלי). מחסרים 1 כדי שנקודה בלי נתונים
    // תתרום בדיוק 0 לציון, נקודה מוצלחת תוסיף, וחלשה תוריד מעט.
    const perfMult = perf?.endpoint.get(e.id) ?? 1;

    parts.set(e.id, {
      staleness, importance: e.importance / 10, daysSince,
      performance: perf ? perfMult : null,
    });
  }

  /** המרכיבים של נקודה — בערוץ channelId הוותק נמדד באותו ערוץ (סעיף 8) */
  const partsIn = (endpointId, channelId) => {
    const p = parts.get(endpointId);
    if (!p || channelId == null) return p;
    const { daysSince, staleness } = stalenessIn(byId.get(endpointId), Number(channelId));
    return { ...p, daysSince, staleness };
  };

  return {
    /**
     * הציון של נקודה למשבצת בערוץ channelId — הוותק והפיגור מהנתח נמדדים
     * באותו ערוץ. בלי ערוץ — הוותק של הנקודה בכלל
     */
    score(endpointId, channelId = null) {
      const p = partsIn(endpointId, channelId);
      if (!p) return 0;
      // כל שיבוץ שכבר הוצע בריצה הזו מקטין את החוב, כדי שהמנוע יתפזר
      const already = scheduledBoost.get(endpointId) ?? 0;
      return W_STALENESS * p.staleness
           + W_STRATEGY * deficitOf(endpointId, channelId)
           + W_IMPORTANCE * p.importance
           + (p.performance == null ? 0 : W_PERFORMANCE * (p.performance - 1))
           - already * 0.6;
    },
    /**
     * המרכיבים של נקודה. עם ערוץ — הוותק (staleness, daysSince) והפיגור
     * (deficit) באותו ערוץ; בלי ערוץ — הוותק של הנקודה בכלל (הפוסט האחרון
     * בכל ערוץ — לחורים) והפיגור הגדול מבין הערוצים
     */
    parts: (id, channelId = null) => {
      const p = partsIn(id, channelId);
      return p && { ...p, deficit: deficitOf(id, channelId) };
    },
    /** הנתח הממוצע של קמפיין בשבוע המתוכנן בערוץ (0 כשאינו רץ בו) */
    campaignShare: (campaignId, channelId) =>
      shares.get(Number(channelId))?.get(Number(campaignId)) ?? 0,
    /**
     * הפיגור של קמפיין מהנתח שלו בערוץ (חיובי = מפגר; 0 כשאינו רץ בערוץ) —
     * לבחירה בין התוכן של נקודה (chooseForSlot, סעיף 11)
     */
    campaignLag,
    /** שיבוץ בריצה: הנקודה (פיזור), והקמפיין בערוץ (campaignLag) כשנתון */
    markScheduled(id, { channelId = null, campaignId = null } = {}) {
      scheduledBoost.set(id, (scheduledBoost.get(id) ?? 0) + 1);
      if (channelId != null && campaignId != null) {
        if (!campaignCounts.has(Number(channelId))) campaignCounts.set(Number(channelId), new Map());
        const m = campaignCounts.get(Number(channelId));
        m.set(Number(campaignId), (m.get(Number(campaignId)) ?? 0) + 1);
      }
    },
    scheduledCount: (id) => scheduledBoost.get(id) ?? 0,
  };
}

/* ========================= קיבולת ========================= */

// kindWeights עבר ל-capacity.js (גם הקיבולת של קמפיין צריכה אותו); מיוצא
// מכאן לקוראים הקיימים (stats.js, הבדיקות)
export { kindWeights };

/** ערך לכל מכירתי (עשרון אחד), או null כשאין שום משקל מכירתי */
export function valuePerPromo(kinds, hybridWeight) {
  const w = kindWeights(kinds, hybridWeight);
  return w.promo > 0 ? Number((w.value / w.promo).toFixed(1)) : null;
}

/** שדה התקרה השבועית של כל סוג בערוץ */
const KIND_CAP_FIELD = { promo: 'max_promo_per_week', value: 'max_value_per_week',
                         hybrid: 'max_hybrid_per_week' };

/**
 * מצב הקיבולת של שבוע: תקציב לכל ערוץ, מונים לפי סוג/יום/שעה, ושער היחס
 * בין ערך למכירתי.
 *
 * שער היחס (סעיף 6) — שער אחד בכל מילוי (רגיל, יומי, מרוסן לקמפיין) ובקיבולת:
 * לכל ערוץ בנפרד, המשקל המכירתי (kindWeights — משולב נספר חלקית) ב-28 ימים —
 * שלושת השבועות שלפני השבוע המתוכנן (prior — מה שתופס מקום או פורסם בהם)
 * ועוד השבוע עצמו, כולל מה שמתוכנן באותה ריצה — לא עובר את ratioPromoLimit
 * של החלון, ובשבוע אחד לא את weeklyPromoCap (רבע ממנה), דרך promoRoomAllows.
 * קודם השבועות הקרובים נבדקו מול הערך שכבר בחלון, ושבוע מרוסן מול התקרה
 * הצפויה — שני שערים שלא הסכימו (משולבים: 0 בשבוע הקרוב, והרשת הבטיחה
 * אותם). 0 ביחס = שער כבוי.
 *
 * reason(…) — למה פוסט מסוג kind לא נכנס לערוץ ביום (null = נכנס): 'full'
 * (התקציב השבועי), 'blocked_day', 'promo_week' / 'hybrid_week' / 'value_week'
 * (התקרה לסוג), 'promo_day' (מכירתי ליום בכל הערוצים), 'ratio' (החדר
 * המכירתי של היחס). detail(…) — המספרים של המגבלה, להודעה (notPlacedNotes).
 *
 * blocked — זוגות `${channel}:${content}` שנחסמו בשער היחס (כשהקורא מעביר
 * contentId), כדי לומר למשתמש כמה פוסטים מכירתיים לא שובצו בגללו.
 * @param opts.prior Map<channelId, {promo, value, hybrid}> — 21 הימים שלפני השבוע
 */
export function buildUsage(channels, existing, settings, { prior = new Map() } = {}) {
  const byChannel = new Map();
  for (const ch of channels) {
    // חלק מהקיבולת נשמר לדברים דחופים ולכן המנוע לא נוגע בו. אותו חשבון
    // שמחשב כמה נכנס לקמפיין (capacity.js) — מקור אחד.
    const before = prior.get(ch.id) ?? {};
    byChannel.set(ch.id, {
      ch,
      budget: channelBudget(ch),
      used: 0,
      byKind: { promo: 0, value: 0, hybrid: 0 },
      // החלון של שער היחס: 21 הימים שלפני השבוע + השבוע
      win: { promo: before.promo ?? 0, value: before.value ?? 0, hybrid: before.hybrid ?? 0 },
      perDay: new Map(),   // dateKey -> count
      hours: new Set(),    // `${channel}:${date}:${hour}`
    });
  }

  const promoPerDay = new Map(); // dateKey -> count (חוצה ערוצים)
  const allPerDay = new Map();   // dateKey -> count בכל הערוצים, לפיזור בין ערוצים
  const weekKind = { promo: 0, value: 0, hybrid: 0 }; // סך השבוע בכל הערוצים
  let promoBlocked = 0; // כמה פעמים שער היחס חסם מכירתי
  const blockedPairs = new Set(); // `${channel}:${content}` שנחסמו בשער היחס

  const bump = (obj, kind, n) => { obj[kind] = Math.max(0, (obj[kind] ?? 0) + n); };

  for (const p of existing) {
    const u = byChannel.get(p.channel_id);
    const dateKey = ymd(new Date(p.scheduled_at));
    if (u) {
      u.used += 1;
      bump(u.byKind, p.kind, 1);
      bump(u.win, p.kind, 1);
      u.perDay.set(dateKey, (u.perDay.get(dateKey) ?? 0) + 1);
      u.hours.add(`${p.channel_id}:${dateKey}:${new Date(p.scheduled_at).getHours()}`);
    }
    if (p.kind === 'promo') {
      promoPerDay.set(dateKey, (promoPerDay.get(dateKey) ?? 0) + 1);
    }
    allPerDay.set(dateKey, (allPerDay.get(dateKey) ?? 0) + 1);
    bump(weekKind, p.kind, 1);
  }

  const maxPromoPerDay = settings?.max_promo_per_day ?? 1;
  const hybridWeight = Number(settings?.hybrid_weight ?? 0.5);
  const minRatio = Number(settings?.min_value_per_promo ?? 3);

  // "משולב" נספר חלקית בשני הצדדים, לפי hybrid_weight
  const promoWeight = () => kindWeights(weekKind, hybridWeight).promo;
  const valueWeight = () => kindWeights(weekKind, hybridWeight).value;

  /** החדר המכירתי של היחס ב-28 הימים בערוץ (ratioPromoLimit) ובשבוע אחד */
  const promoRoomOf = (u) => ratioPromoLimit(u.budget, RATIO_WINDOW_DAYS, RATIO_WINDOW_DAYS / 7,
    minRatio);
  /**
   * שער היחס בערוץ לפוסט מסוג kind (מכירתי או משולב — promoRoomAllows, אותה
   * פונקציה כמו הקיבולת), מול החלון win ומונה השבוע week: 'ratio' / null
   */
  const ratioReason = (u, win, week, kind = 'promo') => {
    const room = promoRoomOf(u);
    if (room === Infinity) return null;
    const fits = (w, r) => promoRoomAllows(kind, kindWeights(w, hybridWeight),
      { room: r, hybridWeight });
    return fits(win, room) && fits(week, weeklyPromoCap(u.budget, minRatio)) ? null : 'ratio';
  };
  const block = (channelId, contentId) => {
    promoBlocked += 1;
    if (contentId != null) blockedPairs.add(`${channelId}:${contentId}`);
  };
  const capReached = (u, kind) => {
    const cap = u.ch[KIND_CAP_FIELD[kind]];
    return cap != null && (u.byKind[kind] ?? 0) >= cap;
  };

  /** למה פוסט מסוג kind לא נכנס לערוץ ביום — null כשנכנס (ראו למעלה) */
  function reason(channelId, dateKey, kind, contentId = null) {
    const u = byChannel.get(channelId);
    if (!u || u.used >= u.budget) return 'full';

    // יום שהוגדר כחסום למדיה הזו
    const dow = new Date(`${dateKey}T00:00:00`).getDay();
    if ((u.ch.blocked_days ?? []).includes(dow)) return 'blocked_day';

    if (capReached(u, kind)) return `${kind}_week`;

    if (kind === 'promo' && (promoPerDay.get(dateKey) ?? 0) >= maxPromoPerDay) return 'promo_day';
    if (kind === 'promo' || kind === 'hybrid') {
      // שער היחס: מכירתי / משולב נוסף מותר רק אם יש מספיק ערך בחלון שיאזן
      // אותו (או, בשבוע מרוסן, רק עד התקרה הצפויה)
      const why = ratioReason(u, u.win, u.byKind, kind);
      if (why) { block(channelId, contentId); return why; }
    }
    return null;
  }

  /**
   * למה פוסט שכבר נספר לא יכול להחליף סוג (שיוך תוכן לפוסט חסר תוכן). בלי
   * בדיקת תקציב — הפוסט כבר תופס את מקומו. אותו סוג — תמיד מותר.
   */
  function retagReason(channelId, dateKey, fromKind, toKind, contentId = null) {
    if (fromKind === toKind) return null;
    const u = byChannel.get(channelId);
    if (!u) return 'full';
    if (capReached(u, toKind)) return `${toKind}_week`;
    if (toKind === 'promo' && (promoPerDay.get(dateKey) ?? 0) >= maxPromoPerDay) return 'promo_day';
    if (toKind === 'promo' || toKind === 'hybrid') {
      // שער היחס, כשהפוסט כבר לא נספר בסוג הקודם שלו
      const less = (o) => ({ ...o, [fromKind]: Math.max(0, (o[fromKind] ?? 0) - 1) });
      const why = ratioReason(u, less(u.win), less(u.byKind), toKind);
      if (why) { block(channelId, contentId); return why; }
    }
    return null;
  }

  return {
    channelHasRoom: (channelId) => {
      const u = byChannel.get(channelId);
      return !!u && u.used < u.budget;
    },
    dayCount: (channelId, dateKey) => byChannel.get(channelId)?.perDay.get(dateKey) ?? 0,
    dayTotal: (dateKey) => allPerDay.get(dateKey) ?? 0,
    hourTaken: (channelId, dateKey, hour) =>
      byChannel.get(channelId)?.hours.has(`${channelId}:${dateKey}:${hour}`) ?? false,

    reason,
    /** האם מותר להכניס פוסט מסוג kind לערוץ ביום הזה (contentId — לספירת חסומים) */
    allows: (channelId, dateKey, kind, contentId = null) =>
      !reason(channelId, dateKey, kind, contentId),

    take(channelId, dateKey, kind, hour) {
      const u = byChannel.get(channelId);
      if (!u) return;
      u.used += 1;
      bump(u.byKind, kind, 1);
      bump(u.win, kind, 1);
      u.perDay.set(dateKey, (u.perDay.get(dateKey) ?? 0) + 1);
      u.hours.add(`${channelId}:${dateKey}:${hour}`);
      allPerDay.set(dateKey, (allPerDay.get(dateKey) ?? 0) + 1);
      if (kind === 'promo') promoPerDay.set(dateKey, (promoPerDay.get(dateKey) ?? 0) + 1);
      bump(weekKind, kind, 1);
    },

    retagReason,
    allowsRetag: (channelId, dateKey, fromKind, toKind, contentId = null) =>
      !retagReason(channelId, dateKey, fromKind, toKind, contentId),

    /** פוסט שכבר נספר משנה סוג — כל המונים זזים, בלי לתפוס מקום נוסף */
    retag(channelId, dateKey, fromKind, toKind) {
      if (fromKind === toKind) return;
      const u = byChannel.get(channelId);
      if (u) {
        bump(u.byKind, fromKind, -1);
        bump(u.byKind, toKind, 1);
        bump(u.win, fromKind, -1);
        bump(u.win, toKind, 1);
      }
      if (fromKind === 'promo') {
        promoPerDay.set(dateKey, Math.max(0, (promoPerDay.get(dateKey) ?? 0) - 1));
      }
      if (toKind === 'promo') promoPerDay.set(dateKey, (promoPerDay.get(dateKey) ?? 0) + 1);
      bump(weekKind, fromKind, -1);
      bump(weekKind, toKind, 1);
    },

    remaining: (channelId) => {
      const u = byChannel.get(channelId);
      return u ? Math.max(0, u.budget - u.used) : 0;
    },

    /**
     * המספרים של מגבלה בערוץ, להודעה (notPlacedNotes): התקרה לסוג, מכירתי
     * ליום, היחס בפועל והמשקלים בחלון, התקרה הצפויה והתקציב.
     */
    detail(channelId, why) {
      const u = byChannel.get(channelId);
      if (!u) return {};
      const w = kindWeights(u.win, hybridWeight);
      const kind = /^(promo|hybrid|value)_week$/.exec(why)?.[1];
      return {
        cap: kind ? Number(u.ch[KIND_CAP_FIELD[kind]]) : null,
        per_day: Number(maxPromoPerDay),
        ratio: windowRatio(minRatio, u.budget),
        value: Number(w.value.toFixed(1)),
        promo: Number(w.promo.toFixed(1)),
        ratio_cap: promoRoomOf(u) === Infinity ? null : promoRoomOf(u),
        week_cap: promoRoomOf(u) === Infinity ? null : weeklyPromoCap(u.budget, minRatio),
        hybrid_weight: hybridWeight,
        budget: u.budget,
        // המספר שהמשתמש קבע לערוץ ("פוסטים בשבוע"), לא התקציב אחרי השמורה
        max_per_week: Number(u.ch.max_per_week),
      };
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
            * (perf.bucket.get(hourBucket(channelHour(ch))) ?? 1)
        : null;

      slots.push({
        channel_id: ch.id,
        channel_name: ch.name,
        hour: channelHour(ch),
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
 * העמודות ש-outsideCampaignWindow צריך כדי לכבד "קמפיין מוכן", ו-pacedDate
 * לפיזור של כל קמפיין במנוע (סעיף 10), לשאילתת תוכן עם הכינויים ci
 * (content_items) ו-ca (campaigns). המקום של הפריט בתור של הקמפיין (בכללי —
 * של המדיה שלו) וכמה פריטים בתור, כמו ברשת (src/campaigns.js). שאילתות משנה
 * ולא פונקציית חלון — כדי שהמספרים לא ישתנו לפי מה שהשאילתה החיצונית מסננת.
 * לכל תוכן של קמפיין; plannedDate עצמה חלה רק על קמפיין שסומן מוכן.
 */
export const COMPLETE_SPREAD_COLUMNS = `
  ca.content_complete_at as campaign_complete_at,
  case when ca.id is not null then (
    select count(*)::int from content_items x
     where x.campaign_id = ci.campaign_id
       and x.slot_channel_id is not distinct from ci.slot_channel_id
       and (x.sort_order, x.id) <= (ci.sort_order, ci.id)) end as campaign_slot_rank,
  case when ca.id is not null then (
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

/**
 * התאריך שלפניו המנוע לא משבץ פריט של קמפיין (סעיף 10): פרוס אחיד על
 * תקופת הקמפיין לפי המקום שלו בתור — אותה spreadDate של "קמפיין מוכן", לכל
 * קמפיין עם תאריכי התחלה וסוף. קודם קמפיין לפי קצב התמלא שבוע אחרי שבוע
 * לפי הסדר, ו-4 פוסטים של קמפיין בן 10 שבועות נחתו בשבועות 1–4. אחרי
 * התאריך — מותר (משבצת שהתפספסה, או יותר תוכן ממשבצות: התור מתקדם).
 * רק במילוי של המנוע: שיבוץ ידני ("שייך תוכן", פוסט ידני) נשאר חופשי, חוץ
 * מקמפיין מוכן (plannedDate). null — אין תאריך כזה.
 */
export function pacedDate(c) {
  if (!c?.campaign_id || !c.campaign_starts_on || !c.campaign_ends_on) return null;
  if (!c.campaign_slot_rank || !c.campaign_slot_count) return null;
  return spreadDate(c.campaign_starts_on, c.campaign_ends_on,
    c.campaign_slot_rank - 1, c.campaign_slot_count);
}

/** יום ראשון של השבוע של YYYY-MM-DD (השבוע בלוח מתחיל בראשון, כמו weekMeta) */
function sundayOf(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  return new Date(t - new Date(t).getUTCDay() * 86400000).toISOString().slice(0, 10);
}

/**
 * מחוץ למה שהמנוע משבץ ביום הזה: מחוץ לחלון הקמפיין (outsideCampaignWindow),
 * או בשבוע שלפני השבוע של התאריך המפוזר של הפריט (pacedDate, סעיף 10).
 * בשבוע עצמו — מותר מכל יום: המנוע ממלא שבוע ממרכזו לקצוות (nextSlot), ותור
 * שנפתח רק ביום המדויק היה משאיר את תחילת השבוע ריקה גם כשיש יותר תוכן
 * ממשבצות. שיבוץ, שיוך לפוסט חסר תוכן, "לא נכנס" וסיבת החור — כולם דרכה.
 */
export function notDueOn(c, dateKey) {
  if (outsideCampaignWindow(c, dateKey)) return true;
  const paced = pacedDate(c);
  return !!paced && sundayOf(dateKey) < sundayOf(paced);
}

/** בתוך החלון של הקמפיין, אבל לפני התאריך המתוכנן / המפוזר של הפריט (notDueOn) */
function waitingForPlannedDate(c, dateKey) {
  const planned = plannedDate(c);
  const paced = pacedDate(c);
  const waiting = (planned && dateKey < planned) || (paced && sundayOf(dateKey) < sundayOf(paced));
  return !!waiting &&
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
 * הקמפיין שלו (campaign_min_gap_days), ובלעדיו ברירת המחדל — בערוץ ידוע
 * (on = gapOn(...)) נגזרת מהקצב שלו (effectiveGap, סעיף 5).
 */
export function contentGap(c, settings, on = {}) {
  return effectiveGap(c?.campaign_id ? { min_gap_days: c.campaign_min_gap_days } : null,
    settings, on);
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

/**
 * המרווח של הקמפיין של תוכן (min_gap_days), או null — ברירת המחדל (תוכן
 * שוטף, קמפיין בלי מרווח משלו, פוסט בלי תוכן). מה שנרשם ב-pairGaps.
 */
export const ownGapDays = (c) => (c?.campaign_id ? c.campaign_min_gap_days ?? null : null);

/**
 * רושם את המרווח של פוסט ביום של נקודה×ערוץ (pairGaps: key → (יום → מרווחים)).
 * gap — min_gap_days של הקמפיין שלו, או null (ברירת המחדל).
 */
export function addPairGap(map, key, dateKey, gap) {
  if (!map) return;
  if (!map.has(key)) map.set(key, new Map());
  const days = map.get(key);
  days.set(dateKey, [...(days.get(dateKey) ?? []), gap]);
}

/** כמו addPairGap, אבל מחליף את מה שנרשם ליום (פוסט חסר תוכן שקיבל תוכן) */
function setPairGap(map, key, dateKey, gap) {
  if (!map) return;
  if (!map.has(key)) map.set(key, new Map());
  map.get(key).set(dateKey, [gap]);
}

/**
 * האם פוסט ביום dateKey מפר מרווח מול השכנים של אותה נקודה באותו ערוץ
 * (dates — התאריכים שלהם). לכל שכן נדרש הגדול מבין המרווח של הפוסט עצמו
 * (own — contentGap) לבין המרווח של השכן (gapsAt: יום → min_gap_days של
 * הקמפיינים שלו; null = ברירת המחדל), שניהם דרך effectiveGap (סעיף 11) —
 * קודם רק המרווח של הפוסט עצמו, וקמפיין עם מרווח קצר נצמד לשכן שביקש מרווח
 * ארוך. שכן בלי רישום — רק own (כמו קודם). מחזירה את המרווח שהופר, או null.
 */
export function gapViolation(own, dates, dateKey, gapsAt = null, settings = null, on = {}) {
  for (const d of dates ?? []) {
    const theirs = (gapsAt?.get(d) ?? []).reduce((m, g) =>
      Math.max(m, effectiveGap(g == null ? null : { min_gap_days: g }, settings, on)), 0);
    const need = Math.max(own, theirs);
    if (nearestDays([d], dateKey) < need) return need;
  }
  return null;
}

/**
 * הסדר בין התוכן המתאים של נקודה למשבצת (סעיף 11):
 *   1. תוכן של קמפיין שרץ בתאריך (עבר את notDueOn) — לפני תוכן שוטף/ותיק;
 *      בין קמפיינים — המפגר ביותר מהנתח שלו בערוץ קודם (debts.campaignLag),
 *      ולא תמיד הוותיק
 *   2. בתוך כל קבוצה — מוכן לפני טיוטה, ואז לפי סוג: כשקמפיין רץ לנקודה
 *      משולב → מכירתי → ערך (משולבים קודם בחדר המכירתי של היחס — החלטת
 *      משתמש; כמו kindLimited בקיבולת), אחרת ערך קודם
 *   3. פיגור שווה — הקמפיין עם המזהה הקטן; בתוך קמפיין — לפי התור
 *      (sort_order); תוכן שוטף — הסדר שבו נטען (הוותיק)
 * מפתח מילוני אחד, כדי שהמיון יהיה עקבי.
 */
export function contentOrder({ channelId, inCampaign, debts = null }) {
  const rank = inCampaign
    ? { hybrid: 0, promo: 1, value: 2 }
    : { value: 0, hybrid: 1, promo: 2 };
  const isReady = (c) => (c.ready_channel_ids ?? []).includes(channelId);
  const lag = new Map();
  const lagOf = (c) => {
    if (!lag.has(c.campaign_id)) lag.set(c.campaign_id, debts?.campaignLag?.(c.campaign_id, channelId) ?? 0);
    return lag.get(c.campaign_id);
  };
  return (a, b) => {
    const ca = a.campaign_id != null;
    const cb = b.campaign_id != null;
    if (ca !== cb) return cb - ca;
    return (ca ? lagOf(b) - lagOf(a) : 0) ||
      (isReady(b) - isReady(a)) || (rank[a.kind] - rank[b.kind]) ||
      (ca ? (a.campaign_id - b.campaign_id) || ((a.sort_order ?? 0) - (b.sort_order ?? 0)) : 0);
  };
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
        -- פוסט מוחזק ירד מהלוח (אלא אם כבר פורסם), כמו existing
        and (p.status = 'published' or ${postIsLiveSql('p')})
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
          usedContent, pairDates = new Map(), pairGaps = new Map(), settings, history, sameDay,
          groupDays = new Map(), gapCtx = null, misses = null } = ctx;
  const on = gapOn(gapCtx, slot.channel_id);
  // למה תוכן שמתאים למשבצת לא נכנס אליה — המרווח או מגבלה של הקיבולת (סעיף 6;
  // notPlacedNotes אחרי הריצה, רק לתוכן שבסוף לא נכנס לערוץ בכלל)
  const miss = (c, why, gap = null) => {
    if (!misses) return;
    const k = `${slot.channel_id}:${c.id}`;
    if (!misses.has(k)) misses.set(k, new Map());
    if (!misses.get(k).has(why)) {
      misses.get(k).set(why, { ...usage.detail?.(slot.channel_id, why), gap });
    }
  };

  const candidates = [];

  for (const e of endpoints) {
    // אותה נקודה, אותה מדיה, אותו יום — לא משנה מאיזה סוג
    if (sameDay.has(`${e.id}:${slot.channel_id}:${slot.dateKey}`)) continue;
    // הפוסטים של הנקודה בערוץ הזה. המרווח עצמו תלוי בתוכן — כל קמפיין קובע
    // את שלו — ובשכן (סעיף 11: הגדול מבין השניים), ולכן נבדק לכל מועמד בנפרד
    const pair = `${e.id}:${slot.channel_id}`;
    const neighbours = pairDates.get(pair);

    // טיוטה נחשבת מועמדת כמו תוכן מוכן — השיבוץ הולך לפי האסטרטגיה,
    // לא לפי אם כבר נכתב טקסט סופי. bool כדי שאפשר יהיה להעדיף מוכן
    // על פני טיוטה כשיש ברירה, בלי לפסול טיוטה כשאין ברירה אחרת.
    const ready = content.filter((c) => {
      if (c.endpoint_id !== e.id ||
          !(c.eligible_channel_ids ?? []).includes(slot.channel_id) ||
          !fitsSlotChannel(c, slot.channel_id) ||
          notDueOn(c, slot.dateKey) ||
          linkedSameDay(c, groupDays, slot.dateKey) ||
          usedContent.has(`${slot.channel_id}:${c.id}`) ||
          !reusable(c, slot, history, settings)) return false;
      const gapNeed = gapViolation(contentGap(c, settings, on), neighbours, slot.dateKey,
        pairGaps.get(pair), settings, on);
      if (gapNeed != null) { miss(c, 'gap', gapNeed); return false; }
      const why = usage.reason
        ? usage.reason(slot.channel_id, slot.dateKey, c.kind, c.id)
        : (usage.allows(slot.channel_id, slot.dateKey, c.kind, c.id) ? null : 'full');
      if (why) { miss(c, why); return false; }
      return true;
    });
    if (ready.length === 0) continue;

    // קמפיין שרץ בתאריך הזה מטה לכיוון תוכן מכירתי/משולב
    const inCampaign = campaigns.some((c) =>
      c.endpoint_id === e.id &&
      (!c.starts_on || c.starts_on <= slot.dateKey) &&
      (!c.ends_on || c.ends_on >= slot.dateKey)
    );
    ready.sort(contentOrder({ channelId: slot.channel_id, inCampaign, debts }));

    candidates.push({
      endpoint: e,
      content: ready[0],
      score: debts.score(e.id, slot.channel_id),
      inCampaign,
      draft: !(ready[0].ready_channel_ids ?? []).includes(slot.channel_id),
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const p = debts.parts(best.endpoint.id, slot.channel_id);
  const bits = [];
  // הוותק בערוץ של המשבצת (סעיף 8)
  if (p.daysSince === null) bits.push(`עוד לא פורסמה ב${slot.channel_name ?? 'ערוץ הזה'}`);
  else if (p.staleness >= 1) {
    bits.push(`${Math.floor(p.daysSince)} ימים בלי פרסום ב${slot.channel_name ?? 'ערוץ הזה'}`);
  }
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

/**
 * השעה של פוסט חסר תוכן: שעתיים אחרי שעת הפרסום הרגילה של הערוץ (null —
 * 12:00, כמו תמיד), כדי שלא יתנגש בשיבוץ הרגיל באותו יום; עד 22:00. באותו
 * ערוץ ויום תפוסים — השעה הפנויה הבאה.
 */
const holeHour = (ch) => Math.min(LAST_HOUR, channelHour(ch) + 2);

/**
 * נקודה שהחוב שלה גבוה אבל אין לה תוכן מוכן — הלוח צריך להראות
 * שהוא מחכה לה, ולא סתם לדלג עליה בשקט.
 *
 * פוסט חסר תוכן הוא פוסט לכל דבר, ולכן עובר את אותם כללים כמו שיבוץ רגיל
 * (קודם הוא עקף את כולם): usage.allows לסוג 'value' — הסוג שבו הוא נפתח —
 * כלומר תקציב, יום חסום ותקרת ערך שבועית (מכירתי ליום ושער היחס לא חלים על
 * ערך); לא באותו יום כמו פוסט אחר של הנקודה באותו ערוץ (sameDay); ומרווח
 * מהשכן הקרוב לשני הכיוונים (pairDates) — ברירת המחדל של הערוץ (effectiveGap
 * עם gapCtx), כי אין תוכן ולכן אין קמפיין. הערוצים נבדקים מהפנוי ביותר; ערוץ בלי יום חוקי — עוברים לבא.
 * אחרי היצירה הפוסט נכנס ל-sameDay ול-pairDates, כמו שיבוץ.
 */
export function findHoles({ endpoints, content, debts, channels, usage, week, existing,
                            now = new Date(), pairDates = new Map(), pairGaps = new Map(),
                            sameDay = new Set(), settings = null, gapCtx = null }) {
  const holes = [];
  // המרווח הכללי של הערוץ — אין תוכן, ולכן אין קמפיין (effectiveGap, סעיף 5)
  const gapIn = (ch) => effectiveGap(null, settings, gapOn(gapCtx, ch.id));
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
      at(dateKey, holeHour(ch)) > now &&
      usage.allows(ch.id, dateKey, 'value') &&
      !sameDay.has(`${e.id}:${ch.id}:${dateKey}`) &&
      gapViolation(gapIn(ch), pairDates.get(`${e.id}:${ch.id}`), dateKey,
        pairGaps.get(`${e.id}:${ch.id}`), settings, gapOn(gapCtx, ch.id)) == null;
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

    let hour = holeHour(target);
    while (usage.hourTaken(target.id, day.date, hour) && hour < LAST_HOUR) hour += 1;
    if (usage.hourTaken(target.id, day.date, hour)) continue; // עד 22:00 הכול תפוס
    // תופסים בפועל את המקום כדי ששיבוץ נוסף באותה ריצה לא יחשוב שהמשבצת פנויה.
    usage.take(target.id, day.date, 'value', hour);
    sameDay.add(`${e.id}:${target.id}:${day.date}`);
    addPairDate(pairDates, `${e.id}:${target.id}`, day.date);
    addPairGap(pairGaps, `${e.id}:${target.id}`, day.date, null);

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
  if (endpointContent.every((c) => notDueOn(c, dateKey)) &&
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
 * כמה פוסטים מכל סוג יש בכל ערוץ ב-21 הימים שלפני השבוע (weekStart) — החלק
 * של חלון היחס (28 יום, סעיף 6) שלפני השבוע המתוכנן. אותם פוסטים שתופסים
 * מקום במנוע: חיים (postIsLiveSql) או שפורסמו, ונכשל שהמועד שלו עבר — לא
 * (takesRoom). מתוכנן שעבר ולא סומן ("לא אושר שיצא") נספר — לא ידוע ≠ לא יצא.
 * @returns {Promise<Map<number, {promo:number, value:number, hybrid:number}>>}
 */
async function priorKinds(weekStart) {
  const r = await rows(
    `select p.channel_id, p.kind, count(*)::int as n
       from posts p
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.scheduled_at >= $1::timestamptz - make_interval(days => $2)
        and p.scheduled_at < $1::timestamptz
        and p.status = any($3::text[])
        and ${takesRoomSql('p')}
        and (p.status = 'published' or ${postIsLiveSql('p')})
      group by p.channel_id, p.kind`,
    [weekStart, RATIO_WINDOW_DAYS - 7, LIVE_STATUSES]
  );
  const out = new Map();
  for (const x of r) {
    if (!out.has(x.channel_id)) out.set(x.channel_id, { promo: 0, value: 0, hybrid: 0 });
    out.get(x.channel_id)[x.kind] = x.n;
  }
  return out;
}

/**
 * כל התאריכים שבהם לנקודת קצה יש פוסט חי בערוץ, סביב השבוע המתוכנן —
 * מפה `${endpoint_id}:${channel_id}` → YYYY-MM-DD ממוינים. המרווח נבדק מול
 * השכן הקרוב לשני הכיוונים (nearestDays), ולכן צריך את כולם ולא רק את
 * האחרון. הטווח: השבוע ± המרווח הגדול ביותר שאפשר (30 — התקרה של מרווח
 * קמפיין — או הכללי אם גדול יותר); פוסט רחוק מזה לא משנה שום החלטה.
 * אותם מצבים כמו בלוח (LIVE ב-gap.js). gaps — המרווח של הקמפיין של כל
 * פוסט (addPairGap), לבדיקה מול השכן (gapViolation, סעיף 11).
 * @returns {Promise<{dates: Map<string, string[]>, gaps: Map<string, Map<string, (number|null)[]>>}>}
 */
async function postDatesPerEndpointChannel(from, to, settings, now = new Date()) {
  const horizon = Math.max(30, effectiveGap(null, settings));
  // נכשל שהמועד שלו עבר לא חוסם מרווח (takesRoom)
  const r = await rows(
    `select p.endpoint_id, p.channel_id, p.scheduled_at, ca.min_gap_days as campaign_min_gap_days
       from posts p
       left join content_items ci on ci.id = p.content_id
       left join campaigns ca     on ca.id = ci.campaign_id
      where p.endpoint_id is not null
        and p.status in ('scheduled','approved','publishing','failed','published','pending_approval')
        and ${takesRoomSql('p', '$4::timestamptz')}
        and p.scheduled_at >= $1::timestamptz - make_interval(days => $3)
        and p.scheduled_at <= $2::timestamptz + make_interval(days => $3)
      order by p.scheduled_at`,
    [from, to, horizon, now]
  );
  const dates = new Map();
  const gaps = new Map();
  for (const x of r) {
    const key = `${x.endpoint_id}:${x.channel_id}`;
    const day = ymd(new Date(x.scheduled_at));
    if (!dates.has(key)) dates.set(key, []);
    dates.get(key).push(day);
    addPairGap(gaps, key, day, x.campaign_min_gap_days ?? null);
  }
  return { dates, gaps };
}
