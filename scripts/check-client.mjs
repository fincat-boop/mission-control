import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * בדיקה סטטית לקוד הלקוח.
 *
 * הקוד רץ בדפדפן כ-ES modules בלי build step, ולכן אין מי שיתפוס טעות
 * לפני שמשתמש לוחץ על טאב מסוים ומגלה מסך לבן. הבדיקה הזו תופסת בלי דפדפן:
 *
 *   1. קבוע בשימוש שלא הוגדר ולא יובא          (קרה כבר פעמיים בפועל)
 *   2. אותו שם מוצהר פעמיים באותו קובץ
 *   3. שורת 'async' יתומה — נופלת בשקט לפי ASI
 *   4. רנדרר שמוזכר ב-RENDERERS ולא קיים
 *   5. יבוא של קובץ שלא קיים
 *   6. מעגל יבוא בין מודולים
 *   7. הפרת שכבות: מודול פיצ'ר שמייבא מודול פיצ'ר אחר
 *
 * עובדת גם על קובץ אחד גדול וגם אחרי פירוק לתיקיות — כדי שאפשר יהיה
 * לפרק בשלבים בלי להישאר בלי רשת ביטחון באמצע.
 *
 *   npm run check
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', 'public');

/* ========================= איסוף הקבצים ========================= */

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collect(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

const files = (await collect(ROOT)).sort();
const rel = (p) => relative(ROOT, p);

/* ========================= ניתוח קובץ בודד ========================= */

/** מה שקובץ מייצא — כדי לוודא שכל יבוא בשם באמת מוצא אותו שם בצד השני */
function parseExports(src) {
  const names = new Set();
  for (const m of src.matchAll(
    /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm
  )) names.add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default\b/m.test(src)) names.add('default');
  return names;
}

/** שמות שיובאו לקובץ — הם "מוצהרים" לצורך הבדיקה, בדיוק כמו הצהרה מקומית */
function parseImports(src) {
  const names = new Set();
  const specs = [];
  // import ... from '...'  /  import '...'
  const RE = /import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(RE)) {
    const named = new Set();
    specs.push({ spec: m[2], named });
    const clause = m[1];
    if (!clause) continue;
    // { a, b as c } — נשמר גם המקור, כדי לאמת מול הייצוא בצד השני
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const raw = part.trim();
        if (!raw) continue;
        const [source, alias] = raw.split(/\s+as\s+/).map((x) => x.trim());
        named.add(source);
        names.add(alias || source);
      }
    }
    // * as ns  /  default
    const star = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (star) names.add(star[1]);
    const def = clause.replace(/\{[\s\S]*?\}/, '').replace(/\*\s+as\s+[\w$]+/, '')
      .split(',')[0]?.trim();
    if (def && /^[A-Za-z_$][\w$]*$/.test(def)) { names.add(def); named.add('default'); }
  }
  return { names, specs };
}

const DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm;
const DUP_RE = /^(?:export\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm;

const IGNORE = new Set(['JSON', 'GET', 'POST', 'PATCH', 'PUT', 'DELETE',
  'UTF', 'MB', 'KB', 'URL', 'API', 'RTL', 'LTR', 'CSS', 'HTML', 'PDF', 'CSV',
  'TSV', 'XLSX', 'AI']);

const problems = [];
const graph = new Map();   // path -> [paths]
const analyzed = [];

for (const file of files) {
  const src = await readFile(file, 'utf8');
  const { names: imported, specs } = parseImports(src);
  const declared = new Set([...src.matchAll(DECL_RE)].map((m) => m[1]));
  const known = new Set([...declared, ...imported]);
  analyzed.push({ file, src, known, exports: parseExports(src), imports: [] });

  /* --- 1. קבוע בשימוש שלא הוגדר ולא יובא --- */
  // מסירים מה שאינו קוד לפני הסריקה: <code> הוא טקסט שמוצג למשתמש,
  // והערות יכולות להזכיר מונחים באותיות גדולות (DOM, API) שאינם מזהים.
  const scanned = src
    .replace(/<code>[\s\S]*?<\/code>/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');   // לא נוגע ב-https://
  for (const m of scanned.matchAll(/(?<![.\w])([A-Z][A-Z0-9_]{2,})\b/g)) {
    const name = m[1];
    if (!known.has(name) && !IGNORE.has(name) && !/^T\d/.test(name)) {
      problems.push(`${rel(file)}: קבוע בשימוש ולא מוגדר: ${name}`);
    }
  }

  /* --- 2. הצהרה כפולה באותו קובץ --- */
  const counts = new Map();
  for (const m of src.matchAll(DUP_RE)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  for (const [name, n] of counts) {
    if (n > 1) problems.push(`${rel(file)}: מוגדר ${n} פעמים ברמה העליונה: ${name}`);
  }

  /* --- 3. 'async' יתום --- */
  if (/^async\s*$/m.test(src)) {
    problems.push(`${rel(file)}: נשארה שורת 'async' יתומה — הערכת המודול תיפול שם`);
  }

  /* --- 5. יבוא לקובץ שלא קיים --- */
  const deps = [];
  for (const { spec, named } of specs) {
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;   // חיצוני
    const target = spec.startsWith('/')
      ? resolve(ROOT, `.${spec}`)
      : resolve(dirname(file), spec);
    if (!files.includes(target)) {
      problems.push(`${rel(file)}: מייבא קובץ שלא קיים: ${spec}`);
      continue;
    }
    deps.push(target);
    analyzed.at(-1).imports.push({ target, named, spec });
  }
  graph.set(file, deps);
}

/* --- 8. שם מיובא שלא באמת מיוצא --- */
// בדפדפן זו SyntaxError בזמן קישור, כלומר כל האפליקציה לא עולה. זו בדיוק
// הטעות שקל לעשות בהעברת קוד בין קבצים, ולכן היא נתפסת כאן.
const exportsOf = new Map(analyzed.map((a) => [a.file, a.exports]));
for (const { file, imports } of analyzed) {
  for (const { target, named, spec } of imports) {
    const avail = exportsOf.get(target);
    if (!avail) continue;
    for (const name of named) {
      if (!avail.has(name)) {
        problems.push(`${rel(file)}: מייבא "${name}" מ-${spec}, אבל הוא לא מיוצא שם`);
      }
    }
  }
}

/* --- 4. רנדרר שמוזכר ב-RENDERERS וחסר --- */
for (const { file, src, known } of analyzed) {
  const renderers = src.match(/const RENDERERS = \{([\s\S]*?)\};/);
  if (!renderers) continue;
  for (const m of renderers[1].matchAll(/=>\s*(\w+)\(/g)) {
    if (!known.has(m[1])) problems.push(`${rel(file)}: רנדרר חסר: ${m[1]}`);
  }
}

/* ========================= 6. מעגלי יבוא ========================= */
// מעגל בין מודולים לא תמיד נופל מיד, אבל הוא הופך את סדר האתחול לתלוי
// מזל — ולכן עדיף להיכשל כאן ולא בדפדפן של המשתמש.
const WHITE = 0; const GREY = 1; const BLACK = 2;
const color = new Map(files.map((f) => [f, WHITE]));
const stack = [];
const reported = new Set();

function walk(node) {
  color.set(node, GREY);
  stack.push(node);
  for (const dep of graph.get(node) ?? []) {
    if (color.get(dep) === GREY) {
      const cycle = stack.slice(stack.indexOf(dep)).concat(dep).map(rel);
      const key = [...cycle].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        problems.push(`מעגל יבוא: ${cycle.join(' -> ')}`);
      }
    } else if (color.get(dep) === WHITE) walk(dep);
  }
  stack.pop();
  color.set(node, BLACK);
}
for (const f of files) if (color.get(f) === WHITE) walk(f);

/* ========================= 7. שכבות ========================= */
// מודול פיצ'ר לא מייבא מודול פיצ'ר אחר. מה שנראה כמו תלות כזו הוא כמעט
// תמיד תלות רענון, ומקומה ב-ui/refresh.js שמזריק את הרנדררים בזמן עלייה.
const featureOf = (p) => rel(p).match(/^js[/\\]features[/\\]([^/\\]+)\.js$/)?.[1];
for (const [file, deps] of graph) {
  const from = featureOf(file);
  if (!from) continue;
  for (const dep of deps) {
    const to = featureOf(dep);
    if (to && to !== from) {
      problems.push(
        `הפרת שכבות: features/${from} מייבא את features/${to} — ` +
        'תלות בין פיצ\'רים עוברת דרך ui/refresh.js'
      );
    }
  }
}

/* ========================= תוצאה ========================= */

if (problems.length) {
  console.error(`נמצאו ${problems.length} בעיות בקוד הלקוח:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `קוד הלקוח תקין (${files.length} קבצים): ` +
  'אין קבועים חסרים, כפילויות, יבוא שבור, מעגלים או הפרות שכבות.'
);
