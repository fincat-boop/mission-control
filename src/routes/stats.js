import { Router } from 'express';
import { bad, wrap } from './_shared.js';
import { buildStats, readActivity } from '../stats.js';
import { buildPerformance } from '../performance.js';
import { buildResultsSummary, listForEntry, saveBatch } from '../results.js';
import { isPreset, presetRange } from '../../public/js/core/dataPeriod.js';
import { requirePerm } from '../auth.js';
import { assistantReady, chat, execute, takeProposal } from '../assistant.js';

const r = Router();

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

/** ביצועים מנורמלים: טבלאות לפי ממד (הפוסטים שממתינים להזנה — ב-GET /results) */
r.get('/performance', wrap(async (req, res) => {
  try {
    res.json(await buildPerformance(req.query.from, req.query.to));
  } catch (e) {
    return bad(res, e.message);
  }
}));

/* ========================= תוצאות ========================= */

/**
 * התקופה מהבקשה: ?preset=prev_month / this_month / 14 (מחושב בשעון ישראל,
 * מאותה פונקציה שהטאב משתמש בה), או from/to מפורשים.
 */
function rangeOf(q) {
  if (q.preset != null && q.preset !== '') {
    if (!isPreset(q.preset)) throw new Error('תקופה לא מוכרת');
    return presetRange(q.preset);
  }
  return { from: q.from, to: q.to };
}

/** טבלת ההזנה: פוסטים שפורסמו בתקופה. ?all=1 — גם מי שכבר נמדד. */
r.get('/results', wrap(async (req, res) => {
  try {
    const { from, to } = rangeOf(req.query);
    res.json(await listForEntry(from, to, { all: req.query.all === '1' }));
  } catch (e) {
    return bad(res, e.message);
  }
}));

/** סיכום גולמי + פילוח לפי ערוץ, נקודת קצה, סוג וקמפיין */
r.get('/results/summary', wrap(async (req, res) => {
  try {
    const { from, to } = rangeOf(req.query);
    res.json(await buildResultsSummary(from, to));
  } catch (e) {
    return bad(res, e.message);
  }
}));

/**
 * שמירה מרוכזת: { items: [{ post_id, reach, engagement, clicks, leads, note }] }.
 * הכול או כלום — שורה לא תקינה אחת מחזירה 400 עם שגיאה לכל שורה, ושום
 * דבר לא נשמר (ראו saveBatch).
 */
r.put('/results', requirePerm('content'), wrap(async (req, res) => {
  const out = await saveBatch(req.body?.items);
  if (out.errors.length) {
    const n = out.errors.length;
    const whole = out.errors[0].index < 0;            // הבקשה עצמה, לא שורה מסוימת
    return res.status(400).json({
      error: whole ? out.errors[0].error
        : n === 1 ? 'שורה אחת לא תקינה — שום דבר לא נשמר'
          : `${n} שורות לא תקינות — שום דבר לא נשמר`,
      errors: out.errors,
    });
  }
  res.json(out);
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



export default r;
