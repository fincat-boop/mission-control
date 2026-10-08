import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { migrate, pool, tenantScope } from './db.js';
import { loadUser } from './auth.js';
import { csrfGuard } from './csrf.js';
import { audit } from './audit.js';
import {
  backupNow, cleanupStaleUrgent, forEachOrg, mediaMaintenance, suggestContentSwaps, sweepTasks,
} from './maintenance.js';
import { publishTickForOrg, refreshNewsletterMetrics } from './publish/runner.js';
import { armTickHeartbeat, tickFinished, tickStarted } from './publish/heartbeat.js';
import api from './routes/api.js';
import agentApi from './agent-api/router.js';
import { pruneApiRequests } from './agent-api/store.js';
import { MAX_FILE_MB } from './routes/_shared.js';
import { mediaReady } from './media.js';
import { r2Host } from './r2.js';
import { hubAppMissing } from './hub-mail.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

// המקור (origin) של הכתובת הציבורית של המדיה, ל-CSP
const mediaOrigin = (() => {
  try { return process.env.R2_PUBLIC_BASE_URL ? new URL(process.env.R2_PUBLIC_BASE_URL).origin : null; }
  catch { return null; }
})();

const app = express();
app.set('trust proxy', 1); // Railway מגיש דרך פרוקסי — נחוץ ל-secure cookies

// כותרות אבטחה. CSP מכוון לאפליקציה: הכול מאותו מקור, בלי hosts חיצוניים.
// 'unsafe-inline' רק ל-style — יש בהצגה מאפייני style="" (הסקריפטים כולם בקבצים).
// HSTS ו-upgrade-insecure-requests רק בפרודקשן: מקומית אין https, ו-Safari
// זוכר HSTS גם ל-localhost — כל localhost (כל פורט) היה נאלץ ל-https לשנה.
const isProd = process.env.NODE_ENV === 'production';
app.use(helmet({
  strictTransportSecurity: isProd,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // https: — תצוגות המייל (ממלא התבניות והתצוגה החיה) מציגות תבניות
      // עם תמונות מדומיינים חיצוניים; iframe שנכתב מהדף יורש את ה-CSP הזה.
      imgSrc: ["'self'", 'https:', 'data:', ...(mediaOrigin ? [mediaOrigin] : [])],
      // העלאה ישירה מהדפדפן ל-R2 (presigned PUT) — רק כשאחסון המדיה מוגדר
      connectSrc: ["'self'", ...(mediaReady() && r2Host() ? [`https://${r2Host()}`] : [])],
      // וידאו מוגש מהכתובת הציבורית של ה-bucket (GET /api/assets/:id מפנה לשם)
      mediaSrc: ["'self'", ...(mediaOrigin ? [mediaOrigin] : [])],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
  // עורך המייל של ה-HUB נפתח בחלון חדש ומחזיר ערכים ב-postMessage דרך
  // window.opener. ברירת המחדל של helmet (same-origin) מנתקת חלון שנפתח
  // לאתר אחר: אצל ה-HUB opener ריק, ואצלנו החלון נראה סגור מיד.
  // allow-popups שומר את הקשר רק לחלונות שאנחנו פותחים — ההודעות מהם
  // נבדקות לפי מקור וחלון (public/js/core/hubFill.js).
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));

// טבלת תוכן לשנה שלמה, מודבקת מ-Excel, עוברת בקלות את 256kb
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// API לסוכנים: מפתח API ולא קוקי, ורק נתיבים מרשימה לבנה (src/agent-api).
// לפני /api — שם הבקשה הייתה נבדקת לפי קוקי. הראוטר תמיד עונה (404 בסופו).
app.use('/api/v1', agentApi);

// כל בקשה מאומתת רצה בתוך הקשר הטננט של המשתמש (tenantScope ב-db.js).
app.use('/api', csrfGuard, loadUser, tenantScope, audit, api);

// נתיב /api שלא נתפס הוא שגיאה, לא בקשה לדף
app.use('/api', (_req, res) => res.status(404).json({ error: 'לא נמצא' }));

// no-cache = הדפדפן חייב לאמת מול השרת בכל טעינה (ETag ⇒ 304 זול כשאין
// שינוי). בלי זה ספארי שמר קבצים ישנים אחרי דיפלוי וערבב גרסאות —
// HTML חדש עם JS/CSS ישנים — וכל עדכון ממשק "לא הגיע" עד רענון עמוק.
app.use(express.static(publicDir, {
  extensions: ['html'],
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));
app.get('*', (_req, res) => res.sendFile(join(publicDir, 'index.html')));

// eslint-disable-next-line no-unused-vars -- express מזהה error handler לפי 4 ארגומנטים
app.use((err, _req, res, _next) => {
  // גוף בקשה שאינו JSON תקין (express.json) — טעות של הבקשה, לא תקלה בשרת
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'הבקשה לא תקינה' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'הבקשה גדולה מדי' });
  }
  console.error(err);
  // שגיאות העלאה מ-multer מקבלות הודעה מובנת במקום "משהו נשבר"
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `הקובץ גדול מדי — עד ${MAX_FILE_MB}MB לקובץ` });
  }
  // סוג קובץ שלא ברשימה (mediaUpload ב-_shared.js)
  if (err?.code === 'UNSUPPORTED_MEDIA_TYPE') return res.status(415).json({ error: err.message });
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: 'יותר מדי קבצים בבת אחת — עד 20' });
  }
  res.status(500).json({ error: 'משהו נשבר בשרת' });
});

const port = process.env.PORT || 3000;

// הסכימה מיושמת בכל עלייה — כך ש-deploy ל-Railway לא דורש צעד ידני
await migrate();

const server = app.listen(port, () => {
  console.log(`Mission Control — מאזין על פורט ${port}`);
  if (hubAppMissing()) {
    console.warn('אזהרה: HUB_APP_URL לא מוגדר — עורך המייל של ה-HUB והקישור "פתח ב-HUB" לא זמינים ' +
      '(השליחה דרך ה-HUB עצמה עובדת). בפרוד: HUB_APP_URL=https://backbone.co.il');
  }
  // "היום", שעות עגולות וימים חסומים מחושבים בשעון התהליך — חייב להיות ישראל
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Asia/Jerusalem') console.warn(`⚠ אזור הזמן של השרת הוא ${Intl.DateTimeFormat().resolvedOptions().timeZone} ולא Asia/Jerusalem — הגדירו TZ=Asia/Jerusalem, אחרת "היום" ושעות השיבוץ יזוזו`);
});

// תחזוקה ברקע: גיבוי יומי, וניקוי מבצעים דחופים שעברו זמנם בלי תוכן —
// כמה דקות אחרי העלייה כדי לא להאט את ה-boot, ואז על פי לוח קבוע.
// אין תלות בגורם חיצוני (cron וכו') — מספיק כל עוד יש instance אחד.
const HOUR = 3600000;
let tickRunning = false;

async function publishTickAllOrgs() {
  const { rows: orgs } = await pool.query('select id from orgs order by id');
  for (const { id } of orgs) {
    await publishTickForOrg(id).catch((e) =>
      console.error(`טיק הפרסום נכשל לארגון ${id}:`, e.message));
  }
}
// הדופק של הטיק (publish/heartbeat.js) — התראה כשהטיק לא הסתיים 10 דקות
armTickHeartbeat();
const timers = [
  setTimeout(() => { backupNow().catch((e) => console.error('גיבוי אוטומטי נכשל:', e)); }, 2 * 60000),
  setInterval(() => { backupNow().catch((e) => console.error('גיבוי אוטומטי נכשל:', e)); }, 24 * HOUR),
  setTimeout(() => { cleanupStaleUrgent().catch((e) => console.error('ניקוי מבצעים דחופים נכשל:', e)); }, 5 * 60000),
  setInterval(() => { cleanupStaleUrgent().catch((e) => console.error('ניקוי מבצעים דחופים נכשל:', e)); }, 6 * HOUR),
  setTimeout(() => { suggestContentSwaps().catch((e) => console.error('הצעת החלפת תוכן נכשלה:', e)); }, 3 * 60000),
  setInterval(() => { suggestContentSwaps().catch((e) => console.error('הצעת החלפת תוכן נכשלה:', e)); }, HOUR),
  // משימות שהתנאי שלהן נפתר נסגרות לבד (src/task-lifecycle.js)
  setTimeout(() => { sweepTasks().catch((e) => console.error('סגירת משימות שנפתרו נכשלה:', e)); }, 6 * 60000),
  setInterval(() => { sweepTasks().catch((e) => console.error('סגירת משימות שנפתרו נכשלה:', e)); }, HOUR),
  // מדיה ב-R2: סל מחזור, העברת קבצים ישנים מהמסד, יתומים (src/maintenance.js)
  setTimeout(() => { mediaMaintenance().catch((e) => console.error('תחזוקת מדיה נכשלה:', e)); }, 4 * 60000),
  setInterval(() => { mediaMaintenance().catch((e) => console.error('תחזוקת מדיה נכשלה:', e)); }, HOUR),
  // יומן הבקשות של ה-API לסוכנים נשמר 90 יום
  setInterval(() => {
    pruneApiRequests().catch((e) => console.error('ניקוי יומן בקשות ה-API נכשל:', e));
  }, 24 * HOUR),
  // פרסום אוטומטי: כל דקה, לכל ארגון. הטיק עצמו בודק את מתג-העל של הארגון
  // ויוצא מיד כשהוא כבוי — הריצה הריקה זולה.
  // בלי withOrg סביב הטיק: הוא פותח טרנזקציה קצרה משלו לכל שלב (runner.js),
  // כך שקריאה ל-Graph לא רצה בתוך טרנזקציה, וכשל בשלב אחד לא מבטל את מה
  // שכבר נשמר. ארגון שהטיק שלו נכשל — נרשם בלוג, וממשיכים לבא.
  // טיק לא מתחיל כשהקודם עוד רץ: פרסום לאינסטגרם יכול לחכות דקות, וטיק
  // מקביל היה עובר על אותן רשימות (משימות וואטסאפ כפולות).
  setInterval(() => {
    if (tickRunning) return;
    tickRunning = true;
    tickStarted();
    publishTickAllOrgs()
      .catch((e) => console.error('טיק הפרסום האוטומטי נכשל:', e))
      .finally(() => { tickRunning = false; tickFinished(); });
  }, 60000),
  // מדדי ניוזלטר (פתיחות/קליקים) ממשיכים להצטבר אחרי השליחה — רענון שעתי
  setInterval(() => {
    forEachOrg(() => refreshNewsletterMetrics())
      .catch((e) => console.error('רענון מדדי ניוזלטר נכשל:', e));
  }, HOUR),
];

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    timers.forEach(clearTimeout);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
