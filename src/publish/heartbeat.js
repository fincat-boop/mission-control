/**
 * דופק טיק הפרסום: מתי השרת התחיל להריץ את הטיק, ומתי טיק התחיל והסתיים
 * לאחרונה. server.js מסמן סביב publishTickAllOrgs, ומרכז ההתראות
 * (alerts.js) מתריע כשהטיק לא הסתיים כבר יותר מ-STALL_MINUTES — טיק
 * שנתקע (טיק אחד בכל רגע, tickRunning) או לולאה שמתה.
 *
 * בזיכרון התהליך בלבד: ב-Railway רץ instance אחד, והוא גם זה שמגיש את
 * ההתראות. בשני instances כל אחד היה מדווח על הטיק של עצמו.
 * לפני armTickHeartbeat (בטסטים, בכלי CLI) — אין התראה.
 */

export const STALL_MINUTES = 10;

const state = { armedAt: null, startedAt: null, finishedAt: null };

/** השרת עלה ורשם את לולאת הטיק — מכאן סופרים */
export function armTickHeartbeat(now = Date.now()) {
  state.armedAt = now;
  state.startedAt = null;
  state.finishedAt = null;
}

export function tickStarted(now = Date.now()) { state.startedAt = now; }
export function tickFinished(now = Date.now()) { state.finishedAt = now; }

export const tickHeartbeat = () => ({ ...state });

const hhmm = (ms) => new Date(ms).toLocaleTimeString('he-IL',
  { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });

/**
 * ההתראה (טהורה): השרת רץ יותר מ-STALL_MINUTES, והטיק האחרון שהסתיים
 * (או העלייה, אם עוד אף טיק לא הסתיים) ישן מזה. טיק שרץ יותר מ-STALL_MINUTES
 * נכלל בזה — הקודם לו הסתיים עוד לפני שהוא התחיל. null = בסדר.
 */
export function tickStallAlert({ armedAt, startedAt, finishedAt }, now = Date.now()) {
  if (armedAt == null) return null;
  const limit = STALL_MINUTES * 60000;
  if (now - armedAt <= limit) return null;
  const last = finishedAt ?? armedAt;
  if (now - last <= limit) return null;

  const minutes = Math.floor((now - last) / 60000);
  const running = startedAt != null && (finishedAt == null || startedAt > finishedAt);
  const why = running
    ? `טיק שהתחיל ב-${hhmm(startedAt)} עדיין לא הסתיים`
    : finishedAt == null ? 'מאז שהשרת עלה אף טיק לא הסתיים' : `הטיק האחרון הסתיים ב-${hhmm(finishedAt)}`;
  return {
    id: 'publish-tick-stalled',
    level: 'crit',
    title: `הפרסום האוטומטי לא רץ כבר ${minutes} דקות`,
    detail: [
      why,
      'פוסטים מאושרים לא יוצאים לאוויר, ומשימות "לפרסם היום" לא נוצרות, עד שזה יחזור לפעול',
      'מעבירים למפתח את ההודעה הזו — צריך לבדוק את השרת',
    ].join(' · '),
    tab: null,
  };
}
