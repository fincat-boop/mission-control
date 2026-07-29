import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { migrate, pool } from './db.js';
import { loadUser } from './auth.js';
import api from './routes/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

const app = express();
app.set('trust proxy', 1); // Railway מגיש דרך פרוקסי — נחוץ ל-secure cookies

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use('/api', loadUser, api);

app.use(express.static(publicDir, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(join(publicDir, 'index.html')));

// eslint-disable-next-line no-unused-vars -- express מזהה error handler לפי 4 ארגומנטים
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'משהו נשבר בשרת' });
});

const port = process.env.PORT || 3000;

// הסכימה מיושמת בכל עלייה — כך ש-deploy ל-Railway לא דורש צעד ידני
await migrate();

const server = app.listen(port, () => {
  console.log(`מרכז בקרה פרסומי — מאזין על פורט ${port}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
