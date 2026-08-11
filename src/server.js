import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { migrate, pool } from './db.js';
import { loadUser } from './auth.js';
import { audit } from './audit.js';
import { backupNow, cleanupStaleUrgent, suggestContentSwaps } from './maintenance.js';
import api from './routes/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

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
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
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

app.use('/api', loadUser, audit, api);

// נתיב /api שלא נתפס הוא שגיאה, לא בקשה לדף
app.use('/api', (_req, res) => res.status(404).json({ error: 'לא נמצא' }));

app.use(express.static(publicDir, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(join(publicDir, 'index.html')));

// eslint-disable-next-line no-unused-vars -- express מזהה error handler לפי 4 ארגומנטים
app.use((err, _req, res, _next) => {
  console.error(err);
  // שגיאות העלאה מ-multer מקבלות הודעה מובנת במקום "משהו נשבר"
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'הקובץ גדול מדי — עד 10MB לקובץ' });
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
