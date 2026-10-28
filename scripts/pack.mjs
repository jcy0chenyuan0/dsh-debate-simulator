#!/usr/bin/env node
// 纯 Node 打包：不依赖 npm / pnpm（别的机器上可能没有）。
// 产物：dist/dsh-debate-simulator-<version>.tgz（npm pack 布局，package/ 前缀，可复现）。
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

// package.json files 里的极简 glob：支持 * ? 与 **
function toRegExp(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

const patterns = (pkg.files ?? []).map(toRegExp);
const always = new Set(['package.json', 'README.md', 'LICENSE']);
const skipDir = new Set(['node_modules', '.git', 'dist', '.cache']);

async function walk(dir, rel) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (skipDir.has(e.name)) continue;
      out.push(...(await walk(path.join(dir, e.name), r)));
    } else if (e.isFile()) {
      out.push(r);
    }
  }
  return out;
}

const all = (await walk(root, '')).sort();
const entries = all.filter((r) => always.has(r) || patterns.some((p) => p.test(r)));
if (!entries.includes('package.json')) entries.unshift('package.json');

// --- 最小 ustar 写入器 ---
const BLOCK = 512;
function header(name, size, mtime) {
  const b = Buffer.alloc(BLOCK);
  const put = (str, off, len) => b.write(str, off, len, 'utf8');
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  put(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const byte of b) sum += byte;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return b;
}

const parts = [];
for (const rel of entries) {
  const abs = path.join(root, rel);
  const st = await stat(abs);
  const data = await readFile(abs);
  parts.push(header(`package/${rel}`, data.length, st.mtimeMs), data);
  const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
  if (pad) parts.push(Buffer.alloc(pad));
}
parts.push(Buffer.alloc(BLOCK * 2));

const tgz = gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 });
const outDir = path.join(root, 'dist');
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, `dsh-debate-simulator-${pkg.version}.tgz`);
await writeFile(outFile, tgz);

const kb = (tgz.length / 1024).toFixed(1);
console.log(`packed ${entries.length} files -> ${path.relative(root, outFile)} (${kb} KB)`);
for (const rel of entries) console.log('  ' + rel);
