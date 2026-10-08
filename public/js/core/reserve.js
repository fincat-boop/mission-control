/**
 * כמה פוסטים בשבוע שמורים לדחופים בערוץ: max_per_week × urgent_reserve_pct,
 * מעוגל לקרוב (סעיף 7). קודם עוגל למטה, ובערוץ של 4 ומטה השמורה הייתה 0 —
 * ומבצע דחוף קיבל "הערוץ מלא". 3 → 1, 4 → 1, 2 → 0, 5 → 1, 10 → 2.
 *
 * משותף לשרת (src/capacity.js — channelBudget, ממנו התקציב של המנוע)
 * ולמסך הניהול (המספר ליד האחוז), כדי שיהיה חשבון אחד.
 * @param max פוסטים בשבוע (max_per_week)
 * @param pct אחוז לדחופים (urgent_reserve_pct; ריק — 20)
 */
export function urgentReserve(max, pct) {
  const m = Math.max(0, Number(max) || 0);
  const p = pct == null || pct === '' ? 20 : Number(pct);
  return Math.min(m, Math.max(0, Math.round((m * (Number.isFinite(p) ? p : 20)) / 100)));
}
