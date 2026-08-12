import 'dotenv/config';
import { migrate, one, pool, query, tenantContext } from './db.js';
import { hashPassword } from './auth.js';

/**
 * הקמת ארגון (טננט) חדש עם משתמש בעלים — לפרוביזיון לקוח נוסף.
 *
 *   node src/new-org.js "<שם הארגון>" <owner-email> "<שם הבעלים>" <סיסמה>
 *
 * או דרך npm:
 *   npm run new-org -- "לקוח ב'" boss@clientb.com "מנהל" סיסמה-חזקה
 *
 * יוצר: שורה ב-orgs, שורת engine_settings לארגון, ומשתמש בעלים עם כל
 * ההרשאות. שאר הנתונים (נקודות קצה, ערוצים...) נבנים מתוך האפליקציה.
 */
const [orgName, ownerEmailRaw, ownerName, password] = process.argv.slice(2);
const ownerEmail = String(ownerEmailRaw ?? '').trim().toLowerCase();

if (!orgName || !ownerEmail || !ownerName) {
  console.error('שימוש: node src/new-org.js "<שם הארגון>" <owner-email> "<שם הבעלים>" [סיסמה]');
  console.error('בלי סיסמה — הבעלים מתחבר דרך Google בלבד.');
  process.exit(1);
}
if (password && password.length < 8) {
  console.error('הסיסמה חייבת להיות באורך 8 תווים לפחות (או להשמיט אותה למשתמש Google בלבד).');
  process.exit(1);
}

await migrate();

// email ייחודי גלובלית (החלטת המודל) — בדיקה על ה-pool (superuser, רואה את כל
// הארגונים) לפני שיוצרים משהו.
const clash = await one('select id from users where lower(email) = $1', [ownerEmail]);
if (clash) {
  console.error(`כבר קיים משתמש עם האימייל ${ownerEmail} (במערכת יש email ייחודי גלובלית).`);
  await pool.end();
  process.exit(1);
}

const org = await one('insert into orgs (name) values ($1) returning id', [orgName]);

const client = await pool.connect();
try {
  await client.query('set role app_user');
  await client.query("select set_config('app.current_org', $1, false)", [String(org.id)]);
  await tenantContext.run({ client, orgId: org.id }, async () => {
    await query('insert into engine_settings default values');
    await one(
      `insert into users (name, email, password_hash, is_owner,
                          perm_content, perm_settings, perm_approve, perm_users)
       values ($1,$2,$3,true,true,true,true,true) returning id`,
      [ownerName, ownerEmail, password ? await hashPassword(password) : null]
    );
  });
  console.log(`נוצר ארגון "${orgName}" (id=${org.id}) עם בעלים ${ownerEmail}.`);
} finally {
  await client.query('reset all').catch(() => {});
  client.release();
  await pool.end();
}
