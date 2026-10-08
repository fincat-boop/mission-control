import { Router } from 'express';
import { bad, wrap } from './_shared.js';
import { API_SCOPE_REGISTRY, API_SCOPES, derivedScopes, parseScopes } from '../agent-api/scopes.js';
import { buildAgentHandbook } from '../agent-api/handbook.js';
import { currentKeyEnv } from '../agent-api/secret.js';
import {
  deleteKey, getKey, issueKey, listKeys, parseExpiry, recentRequests, renewKey, revokeKey,
  updateScopes,
} from '../agent-api/store.js';

/**
 * ניהול מפתחות API לסוכנים (ניהול ← מערכת). בעלים בלבד, כמו ב-Backbone:
 * מפתח פועל בלי אדם מאחוריו, ולכן רק מי שמחזיק בכל ההרשאות מנפיק.
 *
 * הסוד חוזר פעם אחת — בתשובה ליצירה או לסוד חדש — ולא נשמר. יומן
 * הפעולות רושם את גוף הבקשה (שם, הרשאות, תאריך), לא את התשובה.
 */
const r = Router();

function requireOwner(req, res, next) {
  if (!req.user?.is_owner) return bad(res, 'רק הבעלים מנהל מפתחות API', 403);
  next();
}

const isId = (v) => /^\d+$/.test(String(v));

function withDerived(key) {
  return key && { ...key, derived: derivedScopes(key.scopes) };
}

r.get('/api-keys', requireOwner, wrap(async (_req, res) => {
  const keys = await listKeys();
  res.json({
    keys: keys.map(withDerived),
    scopes: API_SCOPES.map((s) => ({ scope: s, ...API_SCOPE_REGISTRY[s] })),
    env: currentKeyEnv(),
  });
}));

r.get('/api-keys/handbook', requireOwner, (req, res) => {
  res.json({ text: buildAgentHandbook(`${req.protocol}://${req.get('host')}`) });
});

r.post('/api-keys', requireOwner, wrap(async (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? '').trim();
  if (name.length < 2 || name.length > 80) return bad(res, 'שם המפתח צריך להיות בין 2 ל-80 תווים');
  const scopes = parseScopes(b.scopes);
  if (!scopes.length) return bad(res, 'צריך לסמן לפחות הרשאה אחת');
  const exp = parseExpiry(b.expires_on);
  if (exp.error) return bad(res, exp.error);
  const { key, secret } = await issueKey({ name, scopes, expires: exp.value, userId: req.user.id });
  res.status(201).json({ key: withDerived(key), secret });
}));

r.patch('/api-keys/:id', requireOwner, wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, 'לא נמצא מפתח כזה', 404);
  const scopes = parseScopes(req.body?.scopes);
  if (!scopes.length) return bad(res, 'צריך לסמן לפחות הרשאה אחת');
  const key = await updateScopes(req.params.id, scopes);
  if (!key) return bad(res, 'אפשר לשנות הרשאות רק למפתח פעיל', 409);
  res.json({ key: withDerived(key) });
}));

r.post('/api-keys/:id/revoke', requireOwner, wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, 'לא נמצא מפתח כזה', 404);
  const key = await revokeKey(req.params.id);
  if (!key) return bad(res, 'לא נמצא מפתח כזה', 404);
  res.json({ key: withDerived(key) });
}));

/** סוד חדש לאותו מפתח: חידוש של פג, החזרה של מבוטל, או סוד שאבד */
r.post('/api-keys/:id/renew', requireOwner, wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, 'לא נמצא מפתח כזה', 404);
  const exp = parseExpiry(req.body?.expires_on);
  if (exp.error) return bad(res, exp.error);
  const out = await renewKey(req.params.id, { expires: exp.value, userId: req.user.id });
  if (!out) return bad(res, 'לא נמצא מפתח כזה', 404);
  res.json({ key: withDerived(out.key), secret: out.secret });
}));

/** מחיקה מבטלת קודם — מפתח פעיל לא נמחק בלי שבוטל */
r.delete('/api-keys/:id', requireOwner, wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, 'לא נמצא מפתח כזה', 404);
  if (!(await getKey(req.params.id))) return bad(res, 'לא נמצא מפתח כזה', 404);
  await revokeKey(req.params.id);
  await deleteKey(req.params.id);
  res.json({ ok: true });
}));

r.get('/api-keys/:id/requests', requireOwner, wrap(async (req, res) => {
  if (!isId(req.params.id)) return bad(res, 'לא נמצא מפתח כזה', 404);
  res.json({ requests: await recentRequests(req.params.id) });
}));

export default r;
