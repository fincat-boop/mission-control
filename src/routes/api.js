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

r.use(boardRoutes);
r.use(engineRoutes);
r.use(endpointRoutes);
r.use(campaignRoutes);
r.use(contentRoutes);
r.use(channelRoutes);
r.use(strategyRoutes);
r.use(taskRoutes);
r.use(settingsRoutes);
r.use(statsRoutes);

export default r;
