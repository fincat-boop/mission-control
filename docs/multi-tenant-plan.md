# תוכנית מולטי-טננט — Mission Control

מטרה: להפוך את המערכת מטננט-יחיד למרובת-ארגונים, עם בידוד מלא בין ארגונים.
מבוסס על הדפוס שהוכח ב-FINcat HUB (RLS + wrapper יחיד לגישת DB + guard),
מותאם ל-stack כאן: Express + `pg` גולמי + JWT (בלי Supabase).

## מודל נבחר

**משתמש אחד ⇐ ארגון אחד** ("model A"). כל `user` נושא `org_id`. אין החלפת
ארגון ואין חברות מרובה — זה הפשוט ביותר, ומספיק לרוב מקרי SaaS. אם בעתיד
צריך משתמש בכמה ארגונים — מוסיפים טבלת `org_members` + ארגון פעיל ב-session.

**החלטה פתוחה:** האם `email` ייחודי גלובלית (אותו אדם לא יכול להיות בשני
ארגונים) או `unique(org_id, email)` (אותו email בשני ארגונים). model A עם
email גלובלי = login פשוט בלי בורר ארגון. **המלצה: email גלובלי בהתחלה.**

## עיקרון הליבה — RLS, לא סינון ידני

במקום לצוד `where org_id = $x` בעשרות queries גולמיים (שביר, query שנשכח =
דליפה בין לקוחות), האכיפה יורדת ל-DB:

1. **RLS policy** על כל טבלת-טננט: שורה נראית רק אם `org_id` שווה למשתנה
   סשן `app.current_org`.
2. **חיבור ממודר לכל בקשה:** בתחילת כל בקשה — `set local app.current_org = <org>`
   בתוך טרנזקציה. `set local` מתאפס בסוף הטרנזקציה, ולכן לא דולף בין בקשות
   על אותו חיבור מה-pool.
3. **wrapper יחיד** (`req.db`) — נקודת החנק היחידה. שום handler לא נוגע ב-pool
   הגלובלי. `guard:tenant` (grep/lint) נכשל אם מישהו כן.

RLS הוא גם ה-backstop: גם אם query אחד פספס סינון — ה-DB עדיין חוסם.

---

## שלבים

### שלב 0 — הכנה ובטיחות
- ענף `multi-tenant`. גיבוי מלא (כבר יש R2).
- לכתוב טסט בידוד-בין-טננט **לפני** השינוי (אדום עכשיו, ירוק בסוף).
- לתעד את המודל (למעלה).

### שלב 1 — סכימה בסיס (מיגרציה idempotent + backfill)
1. טבלת `orgs (id serial pk, name text, created_at)`.
2. `org_id int` (nullable בהתחלה) לטבלאות השורש:
   `users, endpoints, channels, campaigns, content_items, posts, tasks,
    strategy_milestones, activity_log`.
3. גם לטבלאות הבנות — denormalized, כדי ש-policy ה-RLS יהיה אחיד ופשוט:
   `campaign_channels, content_variants, content_assets, post_results`.
   (backfill מה-parent.)
4. **`engine_settings` — השינוי המבני:** היום סינגלטון
   `id int pk default 1 check (id=1)`. להסיר את ה-check, PK חדש = `org_id`,
   שורה לכל ארגון.
5. ליצור ארגון ברירת-מחדל, `update ... set org_id = <default>` לכל השורות.
6. אחרי backfill: `alter column org_id set not null` + FK `references orgs(id)`.
7. `unique(users.email)` — להשאיר גלובלי (model A), או `unique(org_id,email)`
   אם בוחרים email פר-ארגון.
8. אינדקסים חמים מקבלים `org_id` מוביל: `(org_id, scheduled_at)` על posts,
   `(org_id, campaign_id)` על content וכו'.

### שלב 2 — אכיפת RLS (הלב, והחלק המסוכן)
1. `alter table <t> enable row level security;` **`... force row level security;`**
   — FORCE חשוב: בלעדיו בעל הטבלה (המשתמש שאיתו מתחברים ב-Railway) עוקף RLS
   ו-הבידוד לא נאכף. חלופה: role ייעודי `NOSUPERUSER` בלי `BYPASSRLS`.
2. policy לכל טבלה:
   ```sql
   create policy org_isolation on <t>
     using (org_id = current_setting('app.current_org')::int)
     with check (org_id = current_setting('app.current_org')::int);
   ```
3. **`db.js` — refactor:** פונקציה `scoped(orgId)` שמוציאה client מה-pool,
   פותחת טרנזקציה, `set local app.current_org = orgId`, ומחזירה
   `{ query, one, rows, tx }` קשורים לאותו client. משחררת בסוף.
4. middleware: `req.db = scoped(req.org)` (וסוגר בסיום הבקשה).
5. **המסה המכנית:** לנתב את כל קריאות ה-`one/rows/query` ב-routes ובמנוע דרך
   `req.db` במקום הייבוא הגלובלי. מודולים מושפעים: `routes/*`, `engine.js`,
   `board.js`, `campaigns.js`, `alerts.js`, `stats.js`, `performance.js`,
   `urgent.js`, `assistant.js`, `gap.js`, `import.js`, `analyze.js`.
6. `guard:tenant` — סקריפט שנכשל אם קובץ route/דומיין מייבא `one/rows/query`
   ישירות מ-`db.js` (מותר רק ל-db.js, migrations, ועבודות רקע מפורשות).

### שלב 3 — Auth / session
- `PUBLIC_USER_COLS` += `org_id`. `loadUser` → `req.org = user.org_id`.
- `requireAuth` מוודא `req.org` קיים.
- login: עם email גלובלי — נפתר מ-`user.org_id`, בלי בורר.
- העוזר (`assistant.js`): `execute()` כבר עובר דרך API עם הקוקי ⇐ ממודר
  אוטומטית ברגע שה-queries עוברים ל-`req.db`. ה-snapshot של הפרומפט עובר גם הוא.

### שלב 4 — עבודות רקע per-org
- `maintenance.js`: גיבוי נשאר גלובלי (dump של הכול). אבל
  `cleanupStaleUrgent` ו-`suggestContentSwaps` רצים היום גלובלית ⇒ ללולאה על
  כל org עם client ממודר.
- מנוע: `applyWeek/planWeek/autoFill` מקבלים `orgId` ורצים תחת client ממודר.
  `select ... engine_settings where id=1` → `where org_id = <current>`.

### שלב 5 — הקמת ארגון / signup
- flow ליצירת org: `orgs` + בעלים + שורת `engine_settings` דיפולטית (+seed
  אופציונלי). route `POST /orgs` (הרשמה או הזמנה), או CLI `npm run new-org`.
- `seed.js` מותאם: יוצר org ואז את הבעלים בתוכו.

### שלב 6 — Frontend
- מינימלי: הצגת שם הארגון. model A ⇒ בלי switcher. דף signup אם self-serve.

### שלב 7 — טסטים + guard
- טסטי בידוד: org A לא קורא/מעדכן שורות של org B גם עם id מזויף (RLS חוסם).
  להריץ מול client ממודר אמיתי (טרנזקציה + `set local`).
- `guard:tenant` ב-CI/precommit.

### שלב 8 — הגירת פרודקשן
- ה-deploy מריץ את המיגרציה (backfill לארגון ברירת-מחדל). הטננט הקיים הופך
  ל-org 1. אפס downtime — backfill ואז NOT NULL בצעדים נפרדים. לאמת אחרי.

---

## מלכודות (מפורשות)

1. **`engine_settings` סינגלטון** — `check(id=1)` + `insert(1)`. שינוי מבני, לא
   רק עמודה.
2. **RLS נעקף ע"י בעל הטבלה** — ב-Railway מתחברים כבעל ה-DB. בלי `force row
   level security` (או role ייעודי בלי BYPASSRLS) הבידוד לא נאכף בכלל.
3. **דליפת `SET` בין בקשות ב-pool** — משתמשים ב-`set local` **בתוך טרנזקציה**
   בלבד; `set` רגיל נשאר על החיבור וזולג לבקשה הבאה.
4. **עבודות רקע בלי `req`** — אין org מובלע. חייב לולאת org מפורשת עם client
   ממודר, אחרת מערבב ארגונים או קורס.
5. **query שנשכח** — guard תופס סטטית, RLS תופס בזמן ריצה. שתי רשתות.
6. **גיבוי/שחזור** — dump ל-R2 גלובלי (כל הארגונים). שחזור מוחק הכול. ל-MT
   אמיתי — export/restore per-org בהמשך (לא חוסם את הבסיס).
7. **denormalized `org_id`** בטבלאות בנות — לוודא עקביות (טריגר שמזריק מה-parent,
   או אכיפה באפליקציה).

---

## הערכת זמן

| חלק | היקף |
|---|---|
| שלב 1 — סכימה + orgs + backfill | ~יום |
| שלב 2 — RLS + refactor ל-`req.db` + guard | 1–2 ימים (הנתיב הקריטי) |
| שלב 3–4 — auth, engine_settings, רקע per-org | ~יום |
| שלב 5–6 — signup/הקמה + frontend מינימלי | ~חצי-יום |
| שלב 7 — טסטי בידוד + guard | ~חצי-יום |

**סה"כ ~3–4 ימי מפתח מנוסה בקוד.** הנתיב הקריטי והמסוכן = שלב 2 (RLS + מעבר
כל הגישה ל-`req.db`). אם עושים אותו נכון — הבידוד נאכף ב-DB ולא תלוי במשמעת
של כל query עתידי.
