/**
 * ארגון הפלטפורמה — הארגון שמחזיק את מה ששייך למערכת כולה ולא לארגון
 * אחד: מצב הגיבויים והנפח של המסד (גלובליים), והחיבור היחיד ל-HUB
 * (HUB_API_* — חיבור אחד לכל השרת). איתות כלל-מערכתי מגיע רק לארגון הזה;
 * ארגון אחר לא רואה התראות גיבוי/אחסון, ואירוע כשל שלו לא נושא מייל.
 *
 *   PLATFORM_ORG_ID — מזהה הארגון (ברירת מחדל 1, הארגון הראשון)
 */
export function platformOrgId(env = process.env) {
  const n = Number(env.PLATFORM_ORG_ID);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** האם הארגון הנתון הוא ארגון הפלטפורמה. null (בלי הקשר ארגון) = לא. */
export const isPlatformOrg = (orgId, env = process.env) =>
  orgId != null && Number(orgId) === platformOrgId(env);
