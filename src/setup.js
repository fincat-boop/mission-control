/**
 * רשימת ההקמה של ארגון חדש — מה חסר כדי שהלוח יתחיל לעבוד.
 *
 * ארגון חדש (new-org.js) נוחת על לוח ריק, וההנחיה היחידה הייתה שורת טקסט
 * בתוך הטבלה. כאן מחושב, בפונקציה טהורה, אילו צעדים בוצעו — והלוח מציג
 * כרטיס "הקמה" כל עוד חסר צעד חובה. בלי DB: הנתיב (routes/settings.js)
 * אוסף את הנתונים ומעביר לכאן, והטסט בודק את ההחלטות בלי מסד.
 *
 * חובה: ערוץ פעיל, נקודת קצה פעילה, קמפיין או פריט תוכן.
 * מומלץ: פלטפורמה לערוצים שנראים כמו פייסבוק/אינסטגרם/וואטסאפ/ניוזלטר,
 * חיבור מאומת לפייסבוק/אינסטגרם, ומתג הפרסום האוטומטי (מידע בלבד).
 *
 * target — לאן הכפתור מנווט: טאב, ואופציונלית אזור / ערוץ ושדה לפוקוס.
 */

/** ערוץ שהשם שלו מסגיר פלטפורמה מוכרת — כדי להציע להגדיר אותה */
const NAME_HINTS = [
  ['facebook', /פייסבוק|facebook|\bfb\b/i],
  ['instagram', /אינסטגרם|אינסטה|instagram|\big\b/i],
  ['whatsapp', /וואטסאפ|ווטסאפ|וואצאפ|whatsapp/i],
  ['newsletter', /ניוזלטר|דיוור|newsletter/i],
];

export function guessPlatform(name) {
  const n = String(name ?? '');
  return NAME_HINTS.find(([, re]) => re.test(n))?.[0] ?? null;
}

const names = (list) => list.map((c) => c.name).join(', ');

/**
 * @param {{channels: {id:number,name:string,active:boolean,platform?:string}[],
 *          connections: {channel_id:number,has_token:boolean,last_check_ok:boolean|null}[],
 *          endpoints: {id:number,active:boolean}[],
 *          campaigns: number, content: number, autopublish: boolean}} input
 */
export function setupSteps({ channels = [], connections = [], endpoints = [],
  campaigns = 0, content = 0, autopublish = false }) {
  const activeChannels = channels.filter((c) => c.active);
  const activeEndpoints = endpoints.filter((e) => e.active);
  const steps = [];

  // 1. ערוץ פעיל — בלעדיו אין שורות בלוח בכלל
  steps.push({
    id: 'channel',
    required: true,
    done: activeChannels.length > 0,
    title: 'ערוץ פרסום פעיל',
    detail: activeChannels.length === 1 ? 'ערוץ פעיל אחד'
      : activeChannels.length ? `${activeChannels.length} ערוצים פעילים`
      : channels.length ? 'יש ערוצים, אבל כולם מושבתים — מפעילים אחד מהם'
      : 'כל ערוץ הוא שורה בלוח: פייסבוק, אינסטגרם, ניוזלטר…',
    action: channels.length ? 'לערוצים' : 'הוסף ערוץ',
    target: { tab: 'manage', section: 'channels', add: channels.length === 0 },
  });

  // 2. פלטפורמה לערוצים שהשם שלהם מסגיר אותה (מומלץ). ערוץ שהשם לא מסגיר —
  //    לא נספר: אי אפשר לדעת שהוא אמור להיות משהו אחר מ"ידני".
  const named = activeChannels.filter((c) => guessPlatform(c.name));
  const noPlatform = named.filter((c) => (c.platform ?? 'manual') === 'manual');
  steps.push({
    id: 'platform',
    required: false,
    relevant: named.length > 0,
    done: noPlatform.length === 0,
    title: 'פלטפורמה לכל ערוץ',
    detail: noPlatform.length
      ? `עוד לא נבחרה פלטפורמה: ${names(noPlatform)} — בלעדיה אין פרסום אוטומטי`
      : 'לכל ערוץ מוגדר איך מפרסמים אליו',
    action: 'בחר פלטפורמה',
    target: noPlatform.length
      ? { tab: 'manage', channel: noPlatform[0].id, focus: 'platform' }
      : { tab: 'manage', section: 'channels' },
  });

  // 3. נקודת קצה פעילה — בלעדיה למנוע אין מה לשבץ
  steps.push({
    id: 'endpoint',
    required: true,
    done: activeEndpoints.length > 0,
    title: 'נקודת קצה פעילה',
    detail: activeEndpoints.length === 1 ? 'נקודת קצה פעילה אחת'
      : activeEndpoints.length ? `${activeEndpoints.length} נקודות קצה פעילות`
      : endpoints.length ? 'יש נקודות קצה, אבל כולן מושבתות — מפעילים אחת מהן'
      : 'מוצר או שירות שמקבל פרסום. לכל אחת חשיבות',
    action: endpoints.length ? 'לנקודות הקצה' : 'הוסף נקודת קצה',
    target: { tab: 'manage', section: 'endpoints', add: endpoints.length === 0 },
  });

  // 4. קמפיין או פריט תוכן — שייכים לנקודת קצה, ולכן אחרי צעד 3
  const hasContent = campaigns + content > 0;
  steps.push({
    id: 'content',
    required: true,
    done: hasContent,
    title: 'קמפיין או פריט תוכן ראשון',
    detail: hasContent ? `${campaigns} קמפיינים · ${content} פריטי תוכן`
      : activeEndpoints.length ? 'מה שהמנוע משבץ ללוח'
      : 'אחרי שיש נקודת קצה — הקמפיינים והתוכן שייכים לה',
    action: 'לקמפיינים ותוכן',
    target: { tab: 'plan' },
    blocked: !hasContent && activeEndpoints.length === 0,
  });

  // 5. חיבור שמור ומאומת לכל ערוץ פייסבוק/אינסטגרם (מומלץ)
  const meta = activeChannels.filter((c) => ['facebook', 'instagram'].includes(c.platform));
  const conn = new Map(connections.map((c) => [c.channel_id, c]));
  const notConnected = meta.filter((c) => {
    const x = conn.get(c.id);
    return !x?.has_token || x.last_check_ok !== true;
  });
  steps.push({
    id: 'connection',
    required: false,
    relevant: meta.length > 0,
    done: notConnected.length === 0,
    title: 'חיבור מאומת לפייסבוק ואינסטגרם',
    detail: notConnected.length
      ? `לא מחובר או לא נבדק: ${names(notConnected)} — שומרים מזהה וטוקן ולוחצים "בדוק חיבור"`
      : 'כל הערוצים מחוברים והחיבור נבדק',
    action: 'לחיבור',
    target: notConnected.length
      ? { tab: 'manage', channel: notConnected[0].id, focus: 'token' }
      : { tab: 'manage', section: 'channels' },
  });

  // 6. מתג הפרסום האוטומטי — מידע בלבד: כבוי זו בחירה לגיטימית
  steps.push({
    id: 'autopublish',
    required: false,
    info: true,
    relevant: true,
    done: !!autopublish,
    title: autopublish ? 'פרסום אוטומטי פעיל' : 'פרסום אוטומטי כבוי',
    detail: autopublish
      ? 'יתפרסמו רק פוסטים שאושרו אחד-אחד'
      : 'שום פוסט לא יוצא לבד — מפרסמים ידנית ומסמנים "פורסם"',
    action: 'להגדרה',
    target: { tab: 'manage', section: 'autopublish' },
  });

  for (const s of steps) s.relevant ??= true;
  const missing = steps.filter((s) => s.required && !s.done).map((s) => s.id);
  return { steps, missing_required: missing, complete: missing.length === 0 };
}
