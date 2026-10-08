import { Router } from 'express';
import { requireAuth } from '../auth.js';

import publicRoutes from './auth.js';
import boardRoutes from './board.js';
import engineRoutes from './engine.js';
import endpointRoutes from './endpoints.js';
import campaignRoutes from './campaigns.js';
import contentRoutes from './content.js';
import channelRoutes from './channels.js';
import strategyRoutes from './strategy.js';
import taskRoutes from './tasks.js';
import settingsRoutes from './settings.js';
import statsRoutes from './stats.js';
import publishRoutes from './publish.js';
import apiKeyRoutes from './api-keys.js';

/**
 * הרכבת ה-API. הקובץ הזה לא מגדיר אף נתיב בעצמו — כל אחד מהראוטרים
 * מגדיר את הנתיבים שלו במלואם, ולכן הכתובות זהות למה שהיו כשהכול ישב
 * בקובץ אחד.
 *
 * הסדר כאן משמעותי: קודם הנתיבים הפתוחים (התחברות), אחריהם requireAuth
 * כשער מפורש, וכל מה שמתחתיו מוגן. השער נמצא כאן ולא בתוך אחד הראוטרים
 * כדי שיהיה אפשר לראות במבט אחד מה פתוח ומה סגור.
 */
const r = Router();

r.use(publicRoutes);
r.use(requireAuth);
// ניהול מפתחות ה-API — רק מהממשק (קוקי), ולכן לא בתוך protectedApi
r.use(apiKeyRoutes);

/**
 * הנתיבים המוגנים, בלי שער ההתחברות. מורכבים פעמיים: כאן מאחורי
 * requireAuth (הממשק), וב-/api/v1 מאחורי שער מפתחות ה-API
 * (src/agent-api/router.js) — שם רק מה שברשימה הלבנה עובר.
 */
export const protectedApi = Router();
protectedApi.use(boardRoutes);
protectedApi.use(engineRoutes);
protectedApi.use(endpointRoutes);
protectedApi.use(campaignRoutes);
protectedApi.use(contentRoutes);
protectedApi.use(channelRoutes);
protectedApi.use(strategyRoutes);
protectedApi.use(taskRoutes);
protectedApi.use(settingsRoutes);
protectedApi.use(statsRoutes);
protectedApi.use(publishRoutes);

r.use(protectedApi);

export default r;
