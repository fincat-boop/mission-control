import {
  averageSharesByChannel, blendShares, channelBudget, channelEndpoints, effectiveGap, gapOn,
  ratioPromoLimit, RATIO_WINDOW_DAYS, weeklyPromoCap,
} from './capacity.js';
import { effectiveCadenceDays } from './board.js';
import { urgentReserve } from '../public/js/core/reserve.js';

/**
 * שורת ההשלכה מתחת לכל הגדרה של השיבוץ (סעיף 35): מה המספר שהוקלד עושה
 * בפועל — מחושב כאן מ-capacity.js (ומהקצב ב-board.js), לא בדפדפן, כדי שלא
 * תהיה נוסחה שנייה. טהור — הטעינה ב-loadConsequences (routes/settings.js).
 *
 * draft — הערכים שבשדות עכשיו, לפני שמירה (כל אחד לא חובה):
 *   endpoints: {id: importance}
 *   channels:  {id: {max_per_week?, urgent_reserve_pct?}}  (urgent_reserve_pct null = 20)
 *   settings:  {min_gap_days?, min_value_per_promo?}       (יחס 0 = כבוי)
 *
 * @param base {campaigns (CAMPAIGNS_WEIGHTED_SQL), channels, endpoints, standalone
 *              (loadStandalone), settings (engine_settings), week ({from, to} — השבוע הנוכחי)}
 */
export function settingConsequences(base, draft = {}) {
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? undefined : Number(v));

  const epImportance = new Map(base.endpoints.map((e) => [e.id, e.importance]));
  for (const [id, v] of Object.entries(draft.endpoints ?? {})) {
    if (num(v) !== undefined && epImportance.has(Number(id))) epImportance.set(Number(id), num(v));
  }

  const channels = base.channels.map((ch) => {
    const d = draft.channels?.[ch.id];
    if (!d) return ch;
    const out = { ...ch };
    if (num(d.max_per_week) !== undefined) out.max_per_week = num(d.max_per_week);
    if ('urgent_reserve_pct' in d) out.urgent_reserve_pct = num(d.urgent_reserve_pct) ?? null;
    return out;
  });

  const settings = { ...base.settings };
  for (const k of ['min_gap_days', 'min_value_per_promo']) {
    const v = num(draft.settings?.[k]);
    if (v !== undefined) settings[k] = v;
  }

  // החשיבות שהוקלדה נכנסת לנתח דרך הקמפיינים של הנקודה (normalizeShares)
  const campaigns = base.campaigns.map((c) => ({
    ...c, endpoint_importance: epImportance.get(c.endpoint_id) ?? c.endpoint_importance,
  }));

  const active = channels.filter((ch) => ch.active);
  const { from, to } = base.week;
  // הנתח של כל קמפיין בשבוע הנוכחי, בכל ערוץ — אותו חשבון כמו היעד של המנוע (strategyTargets)
  const shares = averageSharesByChannel(campaigns, { from, to, channelIds: active.map((ch) => ch.id) });

  const endpoints = base.endpoints.map((e) => {
    const importance = epImportance.get(e.id);
    // הנקודה בכל ערוץ: סכום הנתחים של הקמפיינים שלה; משוקלל בתקציבי הערוצים שבהם יש לה
    const per = new Map();
    for (const [ch, byCampaign] of shares) {
      for (const c of campaigns) {
        if (c.endpoint_id !== e.id || !byCampaign.has(c.id)) continue;
        per.set(ch, (per.get(ch) ?? 0) + byCampaign.get(c.id));
      }
    }
    const mine = active.filter((ch) => per.has(ch.id));
    return {
      id: e.id,
      importance,
      share_pct: mine.length ? Math.round(blendShares(per, mine) * 100) : null,
      channels: mine.map((ch) => ch.name),
      cadence_days: effectiveCadenceDays({ importance }),
    };
  });

  const ctx = {
    channels: new Map(channels.map((ch) => [ch.id, ch])),
    endpoints: channelEndpoints(campaigns, base.standalone ?? new Map(), { from, to }),
  };
  const minRatio = settings.min_value_per_promo ?? 3;
  const ratioOn = Number(minRatio) > 0;

  const channelRows = channels.map((ch) => {
    const budget = channelBudget(ch);
    const room = ratioPromoLimit(budget, RATIO_WINDOW_DAYS, RATIO_WINDOW_DAYS / 7, minRatio);
    const weekCap = weeklyPromoCap(budget, minRatio);
    return {
      id: ch.id,
      name: ch.name,
      active: !!ch.active,
      max_per_week: Number(ch.max_per_week ?? 1),
      budget,
      reserve: urgentReserve(ch.max_per_week ?? 1, ch.urgent_reserve_pct ?? null),
      gap_days: effectiveGap(null, settings, gapOn(ctx, ch.id)),
      promo_28: ratioOn && room !== Infinity ? room : null,
      promo_week: ratioOn && weekCap !== Infinity ? weekCap : null,
    };
  });

  return {
    week: { from, to },
    ratio_window_days: RATIO_WINDOW_DAYS,
    ratio_on: ratioOn,
    endpoints,
    channels: channelRows,
  };
}
