import 'dotenv/config';
import { migrate, pool } from './db.js';

await migrate();
console.log('הסכימה עודכנה.');
await pool.end();
