/**
 * חילוץ טקסט מקבצים שמגיעים כמו שהם — לא בפורמט שהמערכת מבקשת.
 *
 * xlsx ו-docx הם ארכיוני ZIP עם XML בפנים, ולכן אפשר לקרוא אותם בלי
 * שום תלות חיצונית: קוראים את ספריית הקבצים של ה-ZIP, מפרקים את
 * הרכיבים הרלוונטיים, ושולפים מהם טקסט. PDF לא מפורק כאן — הוא נשלח
 * למודל כמסמך, שיודע לקרוא אותו טוב יותר מכל מחלץ טקסט.
 */

import { inflateRawSync } from 'node:zlib';

/* ========================= ZIP ========================= */

/**
 * קורא ארכיון ZIP מתוך buffer ומחזיר Map של שם קובץ לתוכן.
 * נשען על ספריית הקבצים המרכזית שבסוף הארכיון, ולכן לא תלוי בסדר.
 */
function readZip(buf) {
  // End of central directory: חתימה PK\x05\x06, נמצאת בסוף ואחריה תגובה
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('הקובץ לא נראה כמו xlsx/docx תקין');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // הכותרת המקומית מכילה את האורכים האמיתיים של השם והתוספת
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataAt, dataAt + compSize);

    try {
      files.set(name, method === 0 ? raw : inflateRawSync(raw));
    } catch {
      /* רכיב פגום — מדלגים עליו במקום להפיל את כל הקובץ */
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');

/** כל הטקסט מתוך רצף אלמנטי <t> — כך מיוצג טקסט גם ב-xlsx וגם ב-docx */
const textOfT = (xml) =>
  [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');

/* ========================= xlsx ========================= */

const colOf = (ref) => {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/**
 * הופך גיליון לטקסט מופרד בטאבים — הצורה שהמודל מקבל, וגם הצורה
 * שהייבוא הרגיל מבין, כך שהתוצאה ניתנת לעריכה ידנית לפני שמייבאים.
 */
function xlsxToText(buf) {
  const files = readZip(buf);

  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared = [...sharedXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)]
    .map((m) => textOfT(m[1]));

  const sheetNames = [...files.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort();
  if (!sheetNames.length) throw new Error('לא נמצא גיליון בקובץ');

  const out = [];
  for (const name of sheetNames.slice(0, 3)) {     // עד שלושה גיליונות
    const xml = files.get(name).toString('utf8');
    const lines = [];

    for (const rowM of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cM of rowM[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cM[1];
        const body = cM[2];
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? 'A1';
        const type = /t="(\w+)"/.exec(attrs)?.[1];

        let value = '';
        if (type === 's') {
          const idx = Number(/<v>(\d+)<\/v>/.exec(body)?.[1] ?? -1);
          value = shared[idx] ?? '';
        } else if (type === 'inlineStr') {
          value = textOfT(body);
        } else {
          value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        }

        const at = colOf(ref);
        while (cells.length < at) cells.push('');
        cells[at] = value.replace(/[\t\n]+/g, ' ').trim();
      }
      if (cells.some((c) => c !== '')) lines.push(cells.join('\t'));
    }
    if (lines.length) {
      out.push(sheetNames.length > 1 ? `# גיליון: ${name}\n${lines.join('\n')}` : lines.join('\n'));
    }
  }
  return out.join('\n\n');
}

/* ========================= docx ========================= */

function docxToText(buf) {
  const xml = readZip(buf).get('word/document.xml')?.toString('utf8');
  if (!xml) throw new Error('לא נמצא מסמך בתוך הקובץ');

  // כל פסקה היא שורה, וכל תא בטבלה מופרד בטאב — כך טבלה במסמך
  // מגיעה למודל כטבלה ולא כרצף מילים
  return xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => unescapeXml(line).replace(/[  ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/* ========================= נקודת הכניסה ========================= */

const isZip = (buf) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

/**
 * @param {{originalname:string, mimetype:string, buffer:Buffer}} file
 * @returns {{kind:'text'|'pdf', text?:string, base64?:string, source:string}}
 */
export function extract(file) {
  const name = String(file.originalname ?? '').toLowerCase();
  const buf = file.buffer;

  if (name.endsWith('.pdf') || file.mimetype === 'application/pdf') {
    // PDF נשלח למודל כמסמך: הוא קורא גם פריסה וטבלאות, לא רק תווים
    return { kind: 'pdf', base64: buf.toString('base64'), source: file.originalname };
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    return { kind: 'text', text: xlsxToText(buf), source: file.originalname };
  }
  if (name.endsWith('.docx')) {
    return { kind: 'text', text: docxToText(buf), source: file.originalname };
  }

  // xls ישן ו-doc ישן הם פורמטים בינאריים אחרים לגמרי
  if (name.endsWith('.xls') || name.endsWith('.doc')) {
    throw new Error('הפורמט הישן (xls/doc) לא נתמך — שמרו כ-xlsx / docx / CSV');
  }

  if (isZip(buf)) {
    throw new Error('הקובץ נראה כמו ארכיון שאינו xlsx או docx');
  }

  const text = buf.toString('utf8').replace(/^﻿/, '');
  if (!text.trim()) throw new Error('הקובץ ריק או שאינו טקסט');
  return { kind: 'text', text, source: file.originalname };
}
