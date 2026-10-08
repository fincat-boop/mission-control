/**
 * פוסט "חי" — כזה שהלוח מציג, הטיק מפרסם, וההתראות והמכסות סופרות.
 *
 * שלושה דברים מחזיקים פוסט בצד (סעיף 16 בשיפורי ההתנהגות): קמפיין מושהה,
 * ערוץ מושבת ונקודת קצה מושבתת. שלושתם הפיכים — הפוסטים נשארים במסד
 * ("מוחזקים"), ולא נמחקים ולא יוצאים עד שמפעילים שוב. כל שאילתה שמחליטה מה
 * יוצא / מתריע / נספר משתמשת בתנאי מכאן, כדי שלא יהיה מקום אחד ששכח את
 * אחד השלושה.
 *
 * פוסט שכבר פורסם הוא עובדה: הלוח והמונים מוסיפים "או שפורסם" בעצמם.
 * פוסט בלי נקודת קצה (endpoint_id ריק — הנקודה נמחקה) לא מוחזק בגללה.
 *
 * הכינויים בתוך התת-שאילתות (lch/lep/lci/lca) — שלא יתנגשו בכינויים של
 * השאילתה העוטפת.
 */

/** הערוץ של הפוסט פעיל */
export const channelLiveSql = (p = 'p') =>
  `exists (select 1 from channels lch where lch.id = ${p}.channel_id and lch.active)`;

/** נקודת הקצה של הפוסט לא מושבתת (או שאין לו נקודה) */
export const endpointLiveSql = (p = 'p') =>
  `not exists (select 1 from endpoints lep where lep.id = ${p}.endpoint_id and not lep.active)`;

/** הקמפיין של התוכן של הפוסט לא מושהה (או שאין לו קמפיין) */
export const campaignLiveSql = (p = 'p') =>
  `not exists (select 1 from content_items lci join campaigns lca on lca.id = lci.campaign_id
                where lci.id = ${p}.content_id and lca.paused_at is not null)`;

/** הכול יחד: ערוץ פעיל, נקודה פעילה, קמפיין לא מושהה */
export const postIsLiveSql = (p = 'p') =>
  `(${channelLiveSql(p)} and ${endpointLiveSql(p)} and ${campaignLiveSql(p)})`;

/**
 * פוסטים שלא פורסמו ועדיין יכולים לצאת — מה שהשבתה מחזיקה ומחיקה מורידה.
 * 'publishing' לא כאן: פרסום באמצע לא נעצר (מסלול התקיעה מטפל בו).
 */
export const OPEN_STATUSES = ['scheduled', 'approved', 'failed', 'pending_approval', 'hole'];
export const openPostSql = (p = 'p') =>
  `${p}.status in (${OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`;
