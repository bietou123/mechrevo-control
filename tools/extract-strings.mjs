/**
 * 从 .NET 程序集（PE）里提取字符串：UTF-16LE（.NET 字符串堆）与 ASCII。
 * 用法: node tools/extract-strings.mjs <文件> [关键词正则]
 * 只读文件，不修改任何东西。
 */
import fs from 'node:fs';

const [, , file, pattern] = process.argv;
if (!file) { console.error('usage: node extract-strings.mjs <file> [regex]'); process.exit(2); }

const buf = fs.readFileSync(file);
const re = pattern ? new RegExp(pattern, 'i') : null;

/* UTF-16LE：连续 >=4 个可打印 ASCII 字符，字符间夹 0x00 */
function utf16(b) {
  const out = [];
  let start = -1;
  for (let i = 0; i + 1 < b.length; i += 2) {
    const lo = b[i], hi = b[i + 1];
    const printable = hi === 0 && lo >= 0x20 && lo < 0x7f;
    if (printable) { if (start < 0) start = i; }
    else {
      if (start >= 0 && (i - start) / 2 >= 4) {
        out.push(b.subarray(start, i).toString('utf16le'));
      }
      start = -1;
    }
  }
  if (start >= 0) out.push(b.subarray(start).toString('utf16le'));
  return out;
}

/* ASCII：连续 >=4 个可打印字符 */
function ascii(b) {
  const out = [];
  let start = -1;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    const printable = c >= 0x20 && c < 0x7f;
    if (printable) { if (start < 0) start = i; }
    else {
      if (start >= 0 && i - start >= 4) out.push(b.subarray(start, i).toString('latin1'));
      start = -1;
    }
  }
  return out;
}

const seen = new Set();
const all = [...utf16(buf), ...ascii(buf)];
for (const s of all) {
  const t = s.trim();
  if (t.length < 3 || seen.has(t)) continue;
  if (re && !re.test(t)) continue;
  seen.add(t);
  console.log(t);
}
