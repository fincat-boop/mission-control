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

## מה עוד לא נבנה

**הרצה אוטומטית.** המנוע רץ בלחיצה. אין עדיין cron ששולח אותו לתכנן את השבוע הבא לבד.

**פרסום אמיתי.** המשימות נותנות "העתק טקסט" — אין אינטגרציה שמפרסמת לערוצים.

## חיזוקי אבטחה מומלצים

לפי סדר עדיפות, מה שעוד לא נעשה:

1. **הגבלת קצב בהתחברות** (`routes/auth.js`) — אין הגנה מפני brute-force. מגביל לפי
   IP+אימייל (5 לדקה).
2. **security headers** (`server.js`) — חסר `helmet` (CSP, HSTS, X-Frame-Options).
3. **טסטים** — אין. `_internals` ב-`assistant.js` כבר חשוף לבדיקות, אבל אין test runner.
   להתחיל מ-`node:test` על המנוע וההרשאות.
4. **תלות ב-instance יחיד** — טיימרים ברקע (`server.js`) והצעות העוזר (`assistant.js`)
   חיים בזיכרון התהליך. סקייל מעל instance אחד ישבור אותם — לתעד/להגן לפני סקייל.
5. **JWT בלי ביטול** — טוקן 30 יום, logout רק מנקה קוקי בצד לקוח. אופציונלי: עמודת `ver`
   שקופצת בשינוי סיסמה.
