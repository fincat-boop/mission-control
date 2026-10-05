import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { migrate, pool, withOrg } from './db.js';
import { loadUser } from './auth.js';
import { csrfGuard } from './csrf.js';
import { audit } from './audit.js';
import {
  backupNow, cleanupStaleUrgent, forEachOrg, mediaMaintenance, suggestContentSwaps,
} from './maintenance.js';
import { publishTickForOrg, refreshNewsletterMetrics } from './publish/runner.js';
import api from './routes/api.js';
import { MAX_FILE_MB } from './routes/_shared.js';
import { mediaReady } from './media.js';
import { r2Host } from './r2.js';

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
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // https: — תצוגות המייל (ממלא התבניות והתצוגה החיה) מציגות תבניות
      // עם תמונות מדומיינים חיצוניים; iframe שנכתב מהדף יורש את ה-CSP הזה.
      imgSrc: ["'self'", 'https:', 'data:'],
      // העלאה ישירה מהדפדפן ל-R2 (presigned PUT) — רק כשאחסון המדיה מוגדר
      connectSrc: ["'self'", ...(mediaReady() && r2Host() ? [`https://${r2Host()}`] : [])],
      // וידאו מוגש מהכתובת הציבורית של ה-bucket (GET /api/assets/:id מפנה לשם)
      mediaSrc: ["'self'", ...(mediaOrigin ? [mediaOrigin] : [])],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// טבלת תוכן לשנה שלמה, מודבקת מ-Excel, עוברת בקלות את 256kb
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// כל בקשה מאומתת רצה בתוך הקשר הטננט של המשתמש (withOrg): set role app_user
// + app.current_org, וכל השאילתות בבקשה מסוננות ע"י RLS. בקשות אנונימיות
// (login/logout/me — req.org ריק) רצות על ה-pool כרגיל, וזה גם ה-bootstrap
// שמגלה את הארגון של המשתמש.
function tenantScope(req, res, next) {
  if (!req.org) return next();
  withOrg(req.org, () => new Promise((resolve) => {
    res.on('finish', resolve);
    res.on('close', resolve);
    next();
  })).catch(next);
}

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
  console.error(err);
  // שגיאות העלאה מ-multer מקבלות הודעה מובנת במקום "משהו נשבר"
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `הקובץ גדול מדי — עד ${MAX_FILE_MB}MB לקובץ` });
  }
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
});

// תחזוקה ברקע: גיבוי יומי, וניקוי מבצעים דחופים שעברו זמנם בלי תוכן —
// כמה דקות אחרי העלייה כדי לא להאט את ה-boot, ואז על פי לוח קבוע.
// אין תלות בגורם חיצוני (cron וכו') — מספיק כל עוד יש instance אחד.
const HOUR = 3600000;
const timers = [
  setTimeout(() => { backupNow().catch((e) => console.error('גיבוי אוטומטי נכשל:', e)); }, 2 * 60000),
  setInterval(() => { backupNow().catch((e) => console.error('גיבוי אוטומטי נכשל:', e)); }, 24 * HOUR),
  setTimeout(() => { cleanupStaleUrgent().catch((e) => console.error('ניקוי מבצעים דחופים נכשל:', e)); }, 5 * 60000),
  setInterval(() => { cleanupStaleUrgent().catch((e) => console.error('ניקוי מבצעים דחופים נכשל:', e)); }, 6 * HOUR),
  setTimeout(() => { suggestContentSwaps().catch((e) => console.error('הצעת החלפת תוכן נכשלה:', e)); }, 3 * 60000),
  setInterval(() => { suggestContentSwaps().catch((e) => console.error('הצעת החלפת תוכן נכשלה:', e)); }, HOUR),
  // מדיה ב-R2: סל מחזור, העברת קבצים ישנים מהמסד, יתומים (src/maintenance.js)
  setTimeout(() => { mediaMaintenance().catch((e) => console.error('תחזוקת מדיה נכשלה:', e)); }, 4 * 60000),
  setInterval(() => { mediaMaintenance().catch((e) => console.error('תחזוקת מדיה נכשלה:', e)); }, HOUR),
  // פרסום אוטומטי: כל דקה, לכל ארגון. הטיק עצמו בודק את מתג-העל של הארגון
  // ויוצא מיד כשהוא כבוי — הריצה הריקה זולה.
  setInterval(() => {
    forEachOrg(() => publishTickForOrg())
      .catch((e) => console.error('טיק הפרסום האוטומטי נכשל:', e));
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
