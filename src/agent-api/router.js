/**
 * /api/v1 — ה-API לסוכנים חיצוניים. מפתח API ב-Authorization: Bearer,
 * בלי קוקי (loadUser לא רץ כאן), ורק הנתיבים שב-ROUTES (scopes.js).
 *
 * המפתח פועל כ"משתמש" סינתטי: בלי מזהה, שם = "סוכן: <שם המפתח>", ומתג
 * content דולק רק אם יש לו הרשאת כתיבה. אישור, הגדרות ומשתמשים — כבויים
 * תמיד, כך שגם נתיב שנפתח בטעות נחסם בבדיקת requirePerm שלו. אחרי השער
 * הבקשה רצה בדיוק כמו בקשה מהממשק: הקשר הארגון (RLS), יומן הפעולות
 * (via='api'), ואותו handler.
 */

import { Router } from 'express';
import { tenantScope } from '../db.js';
import { audit } from '../audit.js';
import { protectedApi } from '../routes/api.js';
import { authenticateApiKey } from './authenticate.js';
import { agentGuards } from './guards.js';
import { API_SCOPE_REGISTRY, writesContent } from './scopes.js';
import { logRequest, lookupByPrefix, touchLastUsed } from './store.js';

const deps = {
  lookupByPrefix,
  touchLastUsed,
  environment: () => (process.env.NODE_ENV === 'production' ? 'production' : 'other'),
  now: () => Date.now(),
};

export function agentUser(key) {
  return {
    id: null,
    name: `סוכן: ${key.name}`,
    email: null,
    is_owner: false,
    org_id: key.orgId,
    perm_content: writesContent(key.scopes),
    perm_settings: false,
    perm_approve: false,
    perm_users: false,
  };
}

/**
 * השער. יומן הבקשות: כל בקשה שהמפתח שלה זוהה — גם דחייה אחרי זיהוי — חוץ
 * מ-429 לפי מפתח (הצפה לא הופכת להצפת כתיבות). בקשה שלא זוהתה לא נרשמת:
 * אין לאיזה מפתח לשייך אותה, והסיבה בלוג השרת.
 */
export function agentGate(req, res, next) {
  const startedAt = Date.now();
  const write = (identified, status) => logRequest({
    orgId: identified.orgId, keyId: identified.id, method: req.method, path: req.path,
    status, ip: req.ip, durationMs: Date.now() - startedAt,
  });

  authenticateApiKey({
    method: req.method,
    path: req.path,
    origin: req.get('origin'),
    authorization: req.get('authorization'),
    ip: req.ip,
  }, deps).then((decision) => {
    if ('status' in decision) {
      if (decision.identified && decision.status !== 429) write(decision.identified, decision.status);
      return res.status(decision.status).json({ error: decision.error });
    }
    const { key } = decision;
    req.apiKey = key;
    req.org = key.orgId;
    req.user = agentUser(key);
    res.on('finish', () => write(key, res.statusCode));
    next();
  }).catch(next);
}

const r = Router();
r.use(agentGate, tenantScope, audit);

r.get('/whoami', (req, res) => {
  const { name, prefix, env, scopes, granted } = req.apiKey;
  res.json({
    key: { name, prefix, env },
    scopes: scopes.map((s) => ({
      scope: s, label: API_SCOPE_REGISTRY[s].label, implied: !granted.includes(s),
    })),
  });
});

// כללים שחלים רק על סוכן (guards.js) — אחרי tenantScope, לפני הנתיבים
r.use(agentGuards);
r.use(protectedApi);
r.use((_req, res) => res.status(404).json({ error: 'לא נמצא' }));

export default r;
