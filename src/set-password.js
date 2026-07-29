import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { one, pool } from './db.js';

/**
 * איפוס סיסמה למשתמש קיים.
 * הסיסמה נקראת מ-stdin ולא מהארגומנטים, כדי שלא תישאר בהיסטוריית ה-shell.
 *
 *   printf '%s' 'סיסמה' | node src/set-password.js someone@example.com
 */
const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email) {
  console.error('שימוש: node src/set-password.js <email>   (הסיסמה נכנסת דרך stdin)');
  process.exit(1);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');

if (password.length < 8) {
  console.error('הסיסמה חייבת להיות באורך 8 תווים לפחות.');
  process.exit(1);
}

const user = await one('select id, name from users where lower(email) = $1', [email]);
if (!user) {
  console.error(`לא נמצא משתמש עם האימייל ${email}`);
  process.exit(1);
}

await pool.query('update users set password_hash = $1 where id = $2',
  [await bcrypt.hash(password, 10), user.id]);

console.log(`הסיסמה של ${user.name} (${email}) עודכנה. אורך: ${password.length} תווים.`);
await pool.end();
