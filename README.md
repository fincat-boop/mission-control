# מרכז בקרה פרסומי — חתול פיננסי

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

## הרצה מקומית

צריך Postgres. אפשר גם להתחבר למסד של Railway דרך ה-`DATABASE_URL` הציבורי שלו.

```bash
cp .env.example .env
```

```bash
npm install && npm run seed && npm run dev
```

## מה עוד לא נבנה

**מנוע השיבוץ האוטומטי.** כרגע השיבוץ ידני, והמערכת מראה את כל האותות שהמנוע יצטרך —
ניצול קיבולת בכל ערוץ, כמה זמן כל נקודת קצה לא פורסמה, יחס ערך מול מכירתי, ופער בין
יעד האסטרטגיה לביצוע בפועל. מתכנן המבצע הדחוף (`src/urgent.js`) הוא כבר חתיכה אמיתית
מהמנוע: הוא בוחר מיקום לפי מכסות שבועיות, תקרת מכירתיים יומית וחלון התאריכים.
