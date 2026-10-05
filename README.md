# Mission Control — חתול פיננסי

אפליקציית ניהול פרסום: לוח שבועי, אסטרטגיה תקופתית, ניהול נקודות קצה וערוצים, ומשימות.
Node + Express + Postgres, עברית RTL.

## מה יש כאן

```
src/
  server.js      עליית השרת. מריץ את הסכימה בכל deploy
  schema.sql     הסכימה. ניתן להרצה חוזרת
  db.js          חיבור ל-Postgres
  auth.js        סיסמאות (bcrypt), קוקי התחברות (JWT), בדיקת הרשאות
  board.js       חישובי הלוח: קיבולת, "חמצן" לנקודות קצה, יחס ערך/מכירתי
  urgent.js      מתכנן המבצע הדחוף — מוצא שטח פנוי בלי להזיז שום דבר
  routes/api.js  כל ה-API
  seed.js        משתמש בעלים + נתוני פתיחה
public/          הממשק (ללא build step)
```

## הרשאות

ארבע הרשאות נפרדות, כמו באבטיפוס. הבעלים מקבל את כולן ואי אפשר לשנות אותו:

| הרשאה | מה היא פותחת |
|---|---|
| `content` | הוספה ועריכה של שיבוצים, תוכן ומשימות |
| `settings` | נקודות קצה, ערוצים, קמפיינים, אסטרטגיה, כללי המנוע |
| `approve` | אישור מבצע דחוף שנכנס ללוח |
| `users` | הוספת משתמשים ושינוי הרשאות |

משתמשים נוספים נוצרים מתוך **ניהול → משתמשים**, כל אחד עם סיסמה משלו.

## העלאה ל-Railway

```bash
npx railway login
```

```bash
npx railway init
```

```bash
npx railway add --database postgres
```

הגדרת משתני הסביבה של שירות האפליקציה:

```bash
npx railway variables --set "SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" --set "TZ=Asia/Jerusalem" --set "NODE_ENV=production"
```

`DATABASE_URL` מגיע מ-Postgres. אם הוא לא נקשר אוטומטית, מוסיפים בלשונית Variables של האפליקציה
משתנה בשם `DATABASE_URL` עם הערך `${{Postgres.DATABASE_URL}}`.

```bash
npx railway up
```

```bash
npx railway domain
```

יצירת משתמש הבעלים ונתוני הפתיחה — פעם אחת בלבד:

```bash
npx railway run --service merkaz-bakara node src/seed.js
```

לפני ההרצה מגדירים `OWNER_EMAIL`, `OWNER_NAME` ו-`OWNER_PASSWORD` כמשתני סביבה בשירות
(אפשר למחוק את `OWNER_PASSWORD` מיד אחרי שה-seed רץ — הסיסמה כבר שמורה מוצפנת).

## גיט ו-deploy

הקוד נמצא ב-`github.com/fincat-boop/mission-control` (remote בשם `origin`, ענף `main`).
**גיבוי הקוד וה-deploy הם שני מסלולים נפרדים** — Railway לא מושך מ-GitHub:

```bash
git push            # גיבוי הקוד ל-GitHub
```

```bash
npx railway up      # deploy לפרודקשן (מעלה מהתיקייה המקומית, לא מ-git)
```

`.gitignore` חוסם את `.env` ואת `backups/` (hash-ים של סיסמאות) — הם לא עולים ל-GitHub.

## הרצה מקומית

צריך Postgres. אפשר גם להתחבר למסד של Railway דרך ה-`DATABASE_URL` הציבורי שלו.

```bash
cp .env.example .env
```

```bash
npm install && npm run seed && npm run dev
```

## המנוע

`src/engine.js` מתכנן שבוע: לכל נקודת קצה מחושב "חוב אוויר" מכמה היא מאחרת מול הקצב
שלה, כמה היא מפגרת מהנתח שהוגדר לקמפיין שלה, ומהחשיבות הידנית. החוב הגבוה ביותר שיש לו
תוכן מוכן זוכה במשבצת.

המנוע ממלא רק שטח פנוי ולא מזיז דבר שכבר על הלוח, ולכן אפשר להריץ אותו שוב ושוב על אותו
שבוע. הוא מכבד מכסות שבועיות, מכסה לכל סוג, תקרת מכירתיים יומית, `urgent_reserve_pct`,
ומרווח מינימלי בין נקודה לערוץ. `min_value_per_promo` חוסם פוסט מכירתי כשאין מספיק ערך
בשבוע שיאזן אותו.

התכנון וההרצה הם שני מסלולים נפרדים — שום דבר לא נכתב לפני שההצעה מאושרת.

### חשיבות: נקודת קצה מול קמפיין

שני שדות `importance` נפרדים (1–10), בשתי שכבות שלא מתערבבות בנוסחה אחת:

**חשיבות נקודת קצה** (מאקרו — מחלקת אוויר בין כל המוצרים):

1. **קצב ברירת מחדל** (`board.js`, `effectiveCadenceDays`) —
   `cadenceDays = min(30, max(2, round(60 / importance)))`. חשיבות 10 ⇒ פוסט כל ~6 ימים,
   חשיבות 2 ⇒ כל 30 יום. גובר עליו קצב ידני אם הוגדר.
2. **חוב אוויר** (`engine.js`) — רכיב אחד מתוך ארבעה בציון שקובע איזו נקודה תופסת את
   המשבצת הפנויה הבאה:
   `score = 1.0·staleness + 0.8·deficit + 0.5·(importance/10) + 0.6·performance`.
   החשיבות היא הרכיב החלש ביותר (0.5) — הוותק (staleness) שולט, בכוונה, כדי ש"אף אחד
   לא נשכח".

יש כאן הגברה עקיפה: חשיבות גבוהה מקצרת את הקצב, ואז ה-staleness (`daysSince/cadence`)
מטפס מהר יותר — כך שהחשיבות דוחפת גם ישירות ברכיב 0.5 וגם דרך הקצב.

**חשיבות קמפיין** (מיקרו — מחלקת את האוויר *בתוך* נקודת קצה אחת) —
`campaigns.js`, `effectiveShare`: בין קמפיינים שחופפים בזמן,
`share = campaign.importance / Σ(importance של החופפים)`. נכנס רק כשאין `share_pct` מפורש
(share_pct מנצח). ה-share קובע כמה פוסטים הקמפיין צריך בכל מדיה, ומשם את מספר הזוויות.

בקצרה: **חשיבות הנקודה** בוחרת מי ממלא את המשבצת הבאה; **חשיבות הקמפיין** בוחרת כמה תוכן
כל קמפיין תחת אותה נקודה מייצר.

## גיבוי

ארבע שכבות, כל אחת מגנה מפני משהו אחר:

1. **תקופתי בתוך ה-DB** (`src/maintenance.js` → `backupNow`) — כל 24 שעות, שומר
   14 אחרונים בטבלת `backups`. מגן מטעות ברמת אפליקציה (מחיקה בטעות וכו'),
   לא מאובדן הדיסק עצמו — לזה יש את השכבות הבאות.
2. **חיצוני ל-Google Drive** (`src/offsite-backup.js`, רץ אוטומטית בתוך אותה
   `backupNow`) — עותק מחוץ ל-Railway לגמרי. שלוש רמות רוטציה תחת אותה תיקיית
   שורש: `daily` (7 אחרונים), `weekly` (בימי שני, 5 אחרונים), `monthly`
   (ב-1 לחודש, נשמר לנצח). בלי בייטים של קבצים מצורפים, כמו בגיבוי הפנימי.
   אם המשתנים למטה לא מוגדרים — פשוט מדולג, לא שובר כלום.
3. **גיבוי מלא ל-Cloudflare R2** (`src/full-backup.js`, רץ אוטומטית בתוך אותה
   `backupNow`) — **כולל הבייטים של הקבצים המצורפים**, ולכן זו השכבה היחידה
   שמאפשרת שחזור מלא (טבלאות + קבצים) ממקום אחד מחוץ ל-Railway. אותן שלוש רמות
   רוטציה: `daily/<stamp>/` (7 אחרונים), `weekly/<stamp>/` (בימי שני, 5), `monthly/<stamp>/`
   (ב-1 לחודש, לנצח). כל גיבוי הוא prefix ובו `dump.json` + `assets/<id>`.
   אם משתני `R2_*` לא מוגדרים — מדולג, לא שובר כלום.
4. **הגיבוי המובנה של Railway ל-Postgres** — ברמת הדיסק עצמו, כולל בייטים של
   קבצים מצורפים. מוגדר מתוך ה-dashboard, לא מקוד:
   Railway → שירות ה-Postgres → **Settings → Backups** → להפעיל גיבוי מתוזמן
   (בתוכניות בתשלום יש גם PITR). זה השכבה שמגנה מאובדן הדיסק בפועל.

**מדיה ב-R2 לא משוכפלת לגיבויים.** קבצים שהועלו (או הועברו) ל-bucket המדיה
(`R2_PUBLIC_BUCKET`, ראו "אחסון מדיה" למטה) נשמרים בגיבוי רק כשורה עם
`storage_key` — הבייטים חיים ב-bucket עצמו, וגם השחזור מחזיר רק את השורה. רק
קבצים ישנים שעוד במסד (bytea) מגובים עם הבייטים שלהם, כמו קודם.
קובץ שנמחק מהממשק עובר ל**סל מחזור של 30 יום** (`media_trash`) לפני מחיקה
סופית מה-bucket, וקובץ יתום (העלאה שלא הושלמה, מחיקת זווית שלמה) נכנס לסל אחרי
24 שעות. לכן שחזור גיבוי בן פחות מ-30 יום מחזיר גם את הקבצים שנמחקו אחריו
(השחזור מוציא אותם מהסל); בגיבוי ישן יותר — קבצים שנמחקו מאז כבר אינם ב-bucket
והקישור שלהם שבור.

### הגדרת הגיבוי החיצוני ל-Drive

```
GOOGLE_DRIVE_FOLDER_ID=...
GOOGLE_SERVICE_ACCOUNT_KEY=...
```

1. **Google Cloud Console** → פרויקט → **APIs & Services → Library** → להפעיל
   **Google Drive API**.
2. **IAM & Admin → Service Accounts** → ליצור service account, ואז
   **Keys → Add Key → JSON** — מוריד קובץ מפתח.
3. לקודד את הקובץ ב-base64 (`base64 -i key.json | tr -d '\n'`) ולהדביק כערך
   `GOOGLE_SERVICE_ACCOUNT_KEY`.
4. ליצור תיקייה ב-Drive של הבעלים, לשתף אותה עם כתובת המייל של ה-service
   account (`...@...iam.gserviceaccount.com`) בהרשאת **עורך**, ולהדביק את
   מזהה התיקייה (מהכתובת URL) כ-`GOOGLE_DRIVE_FOLDER_ID`.
5. `npm run backup:offsite` — בדיקה ידנית שההעלאה עובדת.

### הגדרת הגיבוי המלא ל-R2

```
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=...
```

1. **Cloudflare dashboard → R2** → ליצור bucket (למשל `merkaz-bakara-backup`).
2. **R2 → Manage API Tokens → Create API Token** בהרשאת **Object Read & Write**
   על ה-bucket. מקבלים `Access Key ID` ו-`Secret Access Key`.
3. `R2_ACCOUNT_ID` הוא מזהה החשבון (מופיע ב-URL של ה-dashboard ובכתובת ה-endpoint
   `<account>.r2.cloudflarestorage.com`).
4. `npm run backup:full` — בדיקה ידנית שההעלאה עובדת (מעלה לפי אותה רוטציה).

הקוד ב-`src/r2.js` — לקוח R2 מינימלי עם חתימת SigV4 על `node:crypto`, בלי `aws-sdk`.

### שחזור

**מ-R2 (מלא, כולל קבצים מצורפים):**

```bash
npm run restore:r2
```

בלי ארגומנט — מדפיס את רשימת הגיבויים הזמינים לכל רמה. לשחזור אמיתי מעבירים prefix
ואת `--yes`:

```bash
node src/restore-r2.js daily/2026-08-11T08-07-42 --yes
```

**מקובץ מקומי (Drive/גיבוי ידני):**

```bash
node src/restore.js backups/backup-....json --yes
```

פעולה הרסנית — מוחקת את כל הנתונים הקיימים ומחליפה בתוכן הקובץ. בלי `--yes`
זו רק הרצה יבשה שמדווחת מה היה קורה. עובד על כל קובץ בפורמט של `buildDump`
(גם כאלה שהורדו מ-Drive) — מספיק להוריד את ה-JSON מהתיקייה המתאימה לדיסק
המקומי ולהריץ.

גיבוי ידני מלא, כולל בייטים של קבצים מצורפים, לדיסק המקומי:

```bash
npm run backup
```

נשמר ב-`backups/` (ב-`.gitignore` — מכיל hash-ים של סיסמאות).

## פרסום אוטומטי (Meta)

פוסט יכול לצאת לפייסבוק ולאינסטגרם לבד, במועד שנקבע לו. שום דבר לא נשלח בלי
שתי הסכמות מפורשות: מתג-העל ב**ניהול → ערוצי פרסום** דלוק, **וגם** אישור פרטני
לכל פוסט ("אשר לשליחה אוטומטית" בדיאלוג הפוסט, הרשאת `approve`).

**המסלול:** `scheduled` → אישור → `approved` → הטיק (כל דקה) תופס פוסט שהגיע
זמנו → `publishing` → Graph API → `published` + קישור לפוסט החי. כשל →
`failed` + הודעת שגיאה על הפוסט + משימה דחופה. כל ניסיון נרשם ב-`publish_log`.
פוסט שאושר אבל השרת היה למטה מעל 12 שעות מהמועד — נכשל בכוונה ולא מתפרסם
באיחור מפתיע.

**חיבור ערוץ:** בניהול → ערוצי פרסום קובעים לכל ערוץ פלטפורמה
(פייסבוק / אינסטגרם / וואטסאפ / ניוזלטר / ידני). לפייסבוק ואינסטגרם מזינים
מזהה עמוד/חשבון + Access Token (נשמר מוצפן AES-GCM במסד; לעולם לא חוזר
ב-API) ולוחצים "בדוק חיבור". הרשאות הטוקן הנדרשות:
`pages_manage_posts`, `pages_read_engagement` לפייסבוק;
`instagram_basic`, `instagram_content_publish` לאינסטגרם (חשבון עסקי מקושר לעמוד).

**מדיה:** קובץ ב-bucket המדיה (ראו "אחסון מדיה") נשלח לפי הקישור הציבורי
הקבוע שלו — אינסטגרם (`image_url`/`video_url`) ופייסבוק (`url`/`file_url`)
מושכים אותו בעצמם. קובץ ישן שעוד יושב במסד: פייסבוק מקבל אותו ישירות
(multipart), ולאינסטגרם הוא עולה עותק זמני ל-bucket הציבורי ונמחק מיד אחרי
הפרסום (רק העותק הזמני — קובץ קבוע לא נמחק לעולם). וידאו לאינסטגרם יוצא כריל;
כמה תמונות — קרוסלה. גרסת אינסטגרם בלי מדיה לא ניתנת לאישור.

**וואטסאפ (קבוצה):** אין API רשמי — חצי-אוטומטי: רבע שעה לפני המועד נוצרת
משימה דחופה עם "העתק טקסט", שולחים ידנית ומסמנים "פורסם".

**ניוזלטר (דרך ה-HUB):** למרכז-הבקרה אין צינור מייל משלו, בכוונה — ערוץ מסוג
"ניוזלטר" שולח דרך ה-API של HUB (חתול פיננסי), ששם חיים חוק הספאם,
ה-suppressions ומכסת השליחה. ההגדרה: `HUB_API_URL` + `HUB_API_KEY` ב-Railway
(המפתח זהה ל-`MISSION_CONTROL_API_KEY` שמוגדר ב-HUB). בעריכת הגרסה של ערוץ
המייל בתוכן ממלאים נושא, גוף HTML ורשימות יעד (נטענות מה-HUB). המסלול: אותו
אישור פר-פוסט; בזמן הביצוע נקרא `createNewsletter` עם `external_ref` = מזהה
הפוסט (idempotent — retry לעולם לא שולח פעמיים), הפוסט נשאר "שולח" עד שה-HUB
מדווח sent ואז נסגר ל"פורסם"; delivered/opened/clicked נשמרים ב-post_results
ומתרעננים שעה-שעה במשך שבוע. ה-HUB רשאי לסרב (הודעה בעברית) — ההודעה מוצגת
על הפוסט כמו שהיא. הקוד: `src/hub-mail.js` (קליינט) + החיווט ב-`src/publish/runner.js`.

**אירועים יוצאים ל-HUB** (`src/hub-events.js`, אותם `HUB_API_*`): כל פרסום —
אוטומטי או ידני — שולח `post_published`, וכשל שולח `post_publish_failed`
(fire-and-forget: כשל מול ה-HUB לא מפיל את הפרסום). id = `<type>:<post id>`,
ולכן retry לעולם לא נרשם פעמיים. האירועים מזינים את האוטומציות בצד ה-HUB.

## אחסון מדיה (R2)

תמונות, סרטונים, אודיו ו-PDF נשמרים ב-bucket **ציבורי** נפרד ב-Cloudflare R2,
לא במסד. כל קובץ מקבל קישור ציבורי קבוע שאי אפשר לנחש
(`<R2_PUBLIC_BASE_URL>/media/<org>/<uuid>/<שם>`) — כפתור **"העתק קישור"** ליד כל
קובץ, להדבקה ברשת חברתית או לשליחה לעורך. עד `MAX_MEDIA_MB` לקובץ (ברירת מחדל 1GB).

**המסלול:** הדפדפן מבקש חתימה (`POST /api/content/:id/uploads/sign`), מעלה ישירות
ל-R2 ב-PUT חתום (presigned, 15 דקות; נחתמים גם `content-type` וגם `content-length`
המוצהרים, כך ש-R2 דוחה קובץ מסוג או בגודל אחר — מתג `SIGN_CONTENT_LENGTH`
ב-`src/media.js`) עם פס התקדמות, ומדווח
(`.../uploads/complete`). השרת לא נוגע בבייטים — הוא בודק ב-HEAD את הגודל והסוג
האמיתיים (חורג/אסור נמחק מיד) ורושם שורה עם `storage_key`. ה-URL המלא לא נשמר —
הוא נגזר מ-`R2_PUBLIC_BASE_URL` בזמן קריאה, כך שמעבר לדומיין מותאם לא דורש מיגרציה.
`GET /api/assets/:id` מפנה (302) לקישור הקבוע. הקוד: `src/media.js`,
`public/js/core/upload.js`.

**תחזוקה שעתית** (`mediaMaintenance` ב-`src/maintenance.js`, לכל ארגון):
- קבצים ישנים (bytea במסד) מועברים ל-R2 — 10 לארגון בכל שעה, עם אימות גודל. המקום
  במסד מתפנה לשימוש חוזר אבל הדיסק לא מתכווץ מעצמו (`VACUUM FULL content_assets`
  ידני, אם צריך).
- מחיקה מהממשק → סל מחזור (`media_trash`) ל-30 יום → מחיקה סופית מה-bucket.
- פעם ביום: אובייקטים תחת `media/<org>/` מעל 24 שעות בלי שורה (העלאה שלא הושלמה,
  מחיקת זווית/גרסה שלמה) עוברים לסל.

**מחיקות רק בפרודקשן:** המחיקה הסופית מהסל וסריקת היתומים רצות רק כש-`NODE_ENV=production`
(או `MEDIA_SWEEP=1` במפורש). שרת מקומי רואה מסד אחר, ולכן כל אובייקט של פרוד
נראה לו יתום. **פיתוח מקומי — bucket נפרד** (למשל `mission-control-media-dev`),
לא `mission-control-media` של פרוד: גם בלי מחיקות, העלאות והעברות מקומיות היו
נוחתות ב-bucket הציבורי של פרוד.

**בלי המשתנים** — הכול עובד כמו קודם: הקבצים עולים לשרת ונשמרים במסד, עד 50MB.

### הגדרה

```
R2_PUBLIC_BUCKET=...
R2_PUBLIC_BASE_URL=https://pub-xxxx.r2.dev
MAX_MEDIA_MB=1024
```

1. **Cloudflare dashboard → R2 → Create bucket** (למשל `merkaz-bakara-media`) —
   נפרד מ-bucket הגיבויים, שנשאר פרטי.
2. ב-bucket החדש: **Settings → Public Development URL → Enable** (או **Custom
   Domains** — מומלץ לפרוד; ה-r2.dev מוגבל בקצב). הכתובת היא `R2_PUBLIC_BASE_URL`,
   בלי `/` בסוף.
3. **Settings → CORS Policy → Add CORS policy** — בלי זה הדפדפן לא יכול להעלות:

```json
[
  {
    "AllowedOrigins": ["https://merkaz-bakara-production.up.railway.app", "http://localhost:3000"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

4. ה-API token של `R2_ACCESS_KEY_ID` חייב הרשאת **Object Read & Write** גם על
   ה-bucket הזה (לא רק על bucket הגיבויים).
5. להגדיר את המשתנים ב-Railway ולעשות deploy — ה-CSP (`connect-src` ל-endpoint של
   R2, `media-src` לכתובת הציבורית) נבנה בעליית השרת.

## מה עוד לא נבנה

**הרצה אוטומטית.** המנוע רץ בלחיצה. אין עדיין cron ששולח אותו לתכנן את השבוע הבא לבד.

**חיבור הניוזלטר.** למערכת הדיוור הפרטית — ההתממשקות תוגדר בנפרד.

## התחברות דרך Google

בנוסף לסיסמה, אפשר להתחבר עם Google (OAuth server-side, בלי סקריפט של גוגל
בדף — ולכן בלי ריפוף CSP). **מי מורשה: רק email שכבר קיים כמשתמש** — הבעלים
מאשר ע"י הוספת המשתמש ב**ניהול → משתמשים**. Google מאמת את הזהות בלבד; אימייל
שלא קיים כמשתמש נדחה (`?error=not_approved`).

הגדרה:

1. **Google Cloud Console → APIs & Services → Credentials → Create OAuth client
   ID → Web application**.
2. תחת **Authorized redirect URIs** להוסיף את `<origin>/api/auth/google/callback`
   — גם לפרוד (`https://merkaz-bakara-production.up.railway.app/api/auth/google/callback`)
   וגם למקומי (`http://localhost:3000/api/auth/google/callback`).
3. להגדיר ב-Railway את `GOOGLE_CLIENT_ID` ו-`GOOGLE_CLIENT_SECRET`. הכפתור
   מופיע אוטומטית כשהם מוגדרים (`/api/auth/config`).

`src/google-auth.js` מחליף את ה-code בשרת (מאומת ב-client_secret), מוודא
`aud`/`iss`/`email_verified`, ו-state חתום מגן מפני CSRF.

## כניסת SSO מ-HUB

כפתור "בקרת שיגור" ב-HUB (חתול פיננסי) נכנס לכאן בקליק אחד, בלי מסך התחברות:
HUB חותם JWT קצר-חיים (HS256, 60 שניות, `purpose: hub-sso`) עם ה-email של
המשתמש המחובר שם, ומפנה ל-`GET /api/auth/sso?token=...`. הצד שלנו
(`src/hub-sso.js`) מאמת את החתימה ומציב את קוקי ה-session הרגיל.

**מי מורשה: בדיוק כמו Google** — רק email שכבר קיים כמשתמש כאן. ה-SSO מאמת
זהות בלבד, לא יוצר משתמשים ולא נותן הרשאות.

הגדרה: `HUB_SSO_SECRET` (מינימום 16 תווים) — אותו ערך כמו
`MISSION_CONTROL_SSO_SECRET` ב-HUB. בלי המשתנה הנתיב מחזיר 503 והכפתור
ב-HUB מפנה למסך ההתחברות הרגיל. שתי המערכות נשארות עם התחברות עצמאית מלאה.

## אבטחה

**כבר קיים:**

- **סיסמאות** — bcrypt, אף פעם לא מוחזרות ב-API (`auth.js`).
- **Session** — JWT בקוקי `httpOnly`+`secure`(prod)+`sameSite:lax`. `SESSION_SECRET` נבדק
  באורך מינימלי בעליית השרת.
- **SQL** — הכול פרמטרים. עדכונים חלקיים דרך `updateById` עם רשימה לבנה של שדות.
- **הרשאות** — שער `requireAuth` במקום אחד גלוי (`routes/api.js`), `requirePerm` לכל פעולה,
  בעלים לא ניתן לשינוי, הרשאות נקראות מ-DB בכל בקשה.
- **הגבלת קצב בהתחברות** (`auth.js`) — מבוסס-DB (טבלת `login_attempts`), 5 כשלונות לפי
  אימייל בחלון 15 דקות → 429. מבוסס-DB ולא זיכרון כי `req.ip` לא יציב מאחורי הפרוקסי.
- **security headers** (`server.js`) — `helmet` עם CSP מכוון (הכול מאותו מקור), HSTS,
  X-Frame-Options, nosniff.
- **CSRF** (`csrf.js`) — קוקי `sameSite:strict`, ובנוסף בדיקת Origin על כל בקשה
  משנת-מצב מדפדפן (בקשות שרת-לשרת בלי Origin עוברות).

**מה שעוד כדאי, לפי עדיפות:**

1. **תלות ב-instance יחיד** — טיימרים ברקע (`server.js`) והצעות העוזר (`assistant.js`)
   חיים בזיכרון התהליך. סקייל מעל instance אחד ישבור אותם — לתעד/להגן לפני סקייל.
2. **JWT בלי ביטול** — טוקן 30 יום, logout רק מנקה קוקי בצד לקוח. אופציונלי: עמודת `ver`
   שקופצת בשינוי סיסמה.

## טסטים

```bash
npm test
```

`node --test` — 29 טסטים על החישובים (מנוע/קמפיינים/קצב), ההרשאות וה-CSRF.
בלי DB: `test/_env.js` מזריק משתני סביבה דמה וה-Pool נוצר עצל, ולכן פונקציות
טהורות נבדקות בלי חיבור אמיתי.
