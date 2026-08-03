import { Router } from 'express';
import { bad, wrap } from './_shared.js';
import { buildStats, readActivity } from '../stats.js';
import { buildPerformance } from '../performance.js';
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

/** יעילות נמדדת: טבלאות לפי ממד + הפוסטים שממתינים להזנת תוצאות */
r.get('/performance', wrap(async (req, res) => {
  try {
    res.json(await buildPerformance(req.query.from, req.query.to));
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



export default r;
