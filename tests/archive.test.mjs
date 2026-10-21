/**
 * archive 组测试：ZIP（store / UTF-8 文件名 / CRC32）与最小合法 DOCX。
 * 契约见 docs/CONTRACT.md §6 / §8。
 *
 * 校验分层：
 * 1. Node 侧自写解包器（中央目录 + 本地头 + CRC 复核）；
 * 2. python zipfile 深度校验（testzip + sha256 对照，若本机有 Python）；
 * 3. python-docx 打开 DOCX 并读取段落/表格（若本机有 python-docx）。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  crc32,
  createZip,
  writeZipFile,
  buildDocx,
  writeDocxFile,
  safeJoin,
  slugify,
  runIdFor,
  formatBytes,
} from '../lib/host/archive.js'

const ZIP_EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06])
const ZIP_CENTRAL = 0x02014b50
const ZIP_LOCAL = 0x04034b50

/** 极简 ZIP 解包器：只支持 store（method 0），足以校验本插件的产物。 */
function parseZip(buf) {
  const eocd = buf.lastIndexOf(ZIP_EOCD)
  assert.ok(eocd >= 0, 'ZIP 缺少 EOCD 结束记录')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  assert.equal(cdOffset + cdSize, eocd, '中央目录大小与位置不一致')
  const entries = []
  let pos = cdOffset
  for (let index = 0; index < count; index += 1) {
    assert.equal(buf.readUInt32LE(pos), ZIP_CENTRAL, `第 ${index + 1} 条中央目录签名不符`)
    const flags = buf.readUInt16LE(pos + 8)
    const method = buf.readUInt16LE(pos + 10)
    const crc = buf.readUInt32LE(pos + 16)
    const csize = buf.readUInt32LE(pos + 20)
    const usize = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen)
    assert.equal(buf.readUInt32LE(localOffset), ZIP_LOCAL, `${name} 本地文件头签名不符`)
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const data = buf.subarray(dataStart, dataStart + csize)
    assert.equal(crc32(data), crc, `${name} CRC32 校验失败`)
    assert.equal(usize, data.length, `${name} 解压后大小不符`)
    entries.push({ name, flags, method, crc, data })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/* ----------------------------- Python 探测 ----------------------------- */

let pythonCache

function candidates() {
  return [
    process.env.DSH_PYTHON,
    process.env.DEBATE_PYTHON,
    process.env.PYTHON,
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
    'python3',
  ].filter((value) => typeof value === 'string' && value.trim())
}

/** 找到能 import docx + zipfile 的 Python；找不到返回 null（相关断言 skip）。 */
function findPython() {
  if (pythonCache !== undefined) return pythonCache
  for (const exe of candidates()) {
    const probe = spawnSync(exe, ['-c', 'import docx, zipfile'], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    if (probe.status === 0) {
      pythonCache = exe
      return pythonCache
    }
  }
  pythonCache = null
  return pythonCache
}

function runPython(exe, code, args = []) {
  const result = spawnSync(exe, ['-c', code, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (result.status !== 0) {
    throw new Error(`Python 执行失败（status=${result.status}）：${result.stderr || ''}`)
  }
  return result.stdout
}

const PY_ZIP_INSPECT = `
import hashlib, json, sys, zipfile, xml.etree.ElementTree as ET
path = sys.argv[1]
archive = zipfile.ZipFile(path)
bad = archive.testzip()
entries = []
for info in archive.infolist():
    data = archive.read(info)
    entries.append({
        "name": info.filename,
        "flags": info.flag_bits,
        "method": info.compress_type,
        "crc": info.CRC,
        "size": info.file_size,
        "sha256": hashlib.sha256(data).hexdigest(),
    })
print(json.dumps({"bad": bad, "entries": entries}, ensure_ascii=False))
`

const PY_DOCX_INSPECT = `
import json, sys, zipfile, xml.etree.ElementTree as ET
import docx
path = sys.argv[1]
archive = zipfile.ZipFile(path)
parts = sorted(archive.namelist())
bad = archive.testzip()
for name in parts:
    if name.endswith(".xml") or name.endswith(".rels"):
        ET.fromstring(archive.read(name))
document = docx.Document(path)
print(json.dumps({
    "bad": bad,
    "parts": parts,
    "paragraphs": [p.text for p in document.paragraphs],
    "tables": [[[cell.text for cell in row.cells] for row in table.rows] for table in document.tables],
}, ensure_ascii=False))
`

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/* -------------------------------- CRC32 -------------------------------- */

test('crc32：标准测试向量与空输入', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0, '空输入 CRC32 应为 0')
  assert.equal(crc32(Buffer.from('abc', 'utf8')), 0x352441c2)
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926)
  assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog', 'utf8')), 0x414fa339)
  // 中文按 UTF-8 字节计算，稳定可复现
  assert.equal(crc32(Buffer.from('辩论', 'utf8')), crc32(Buffer.from('辩论', 'utf8')))
  assert.notEqual(crc32(Buffer.from('辩论', 'utf8')), crc32(Buffer.from('辩论赛', 'utf8')))
})

/* --------------------------------- ZIP --------------------------------- */

test('createZip：store 模式、UTF-8 文件名、CRC 正确，可被自写解包器还原', async (t) => {
  const binary = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
  const entries = [
    { name: 'README.txt', data: '辩论模拟归档说明\n第二行\n' },
    { name: '正方/发言记录.md', data: '# 正方发言记录\n\n一辩：数字化让生活更美好。\n' },
    { name: '评委/计分板.md', data: '正方 88 : 76 反方\n' },
    { name: 'bin/data.bin', data: binary },
    { name: 'emoji-🏛️.txt', data: '法庭' },
  ]
  const zip = createZip(entries)
  assert.ok(Buffer.isBuffer(zip))

  const parsed = parseZip(zip)
  assert.equal(parsed.length, entries.length)
  assert.deepEqual(parsed.map((entry) => entry.name), entries.map((entry) => entry.name))
  for (const [index, entry] of parsed.entries()) {
    assert.equal(entry.method, 0, `${entry.name} 应为 store（不压缩）`)
    assert.equal(entry.flags & 0x0800, 0x0800, `${entry.name} 必须置 UTF-8 通用标志位 0x0800`)
    const expected = entries[index].data
    const expectedBuf = Buffer.isBuffer(expected) ? expected : Buffer.from(expected, 'utf8')
    assert.deepEqual(entry.data, expectedBuf, `${entry.name} 内容应逐字节一致`)
  }

  // 落盘后用 python zipfile 做独立校验（若有 Python）
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-debate-archive-'))
  t.after(async () => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'sample.zip')
  const written = await writeZipFile(file, entries)
  assert.equal(written.bytes, zip.length)
  assert.equal((await fsp.stat(file)).size, zip.length)

  const python = findPython()
  if (!python) {
    t.diagnostic('未找到 python（含 zipfile），跳过 python zipfile 交叉校验')
    return
  }
  const report = JSON.parse(runPython(python, PY_ZIP_INSPECT, [file]))
  assert.equal(report.bad, null, 'python zipfile.testzip() 应报告所有条目 CRC 正确')
  assert.deepEqual(
    report.entries.map((entry) => entry.name),
    entries.map((entry) => entry.name),
    'python zipfile 读出的条目顺序/名称应与写入一致',
  )
  for (const [index, entry] of report.entries.entries()) {
    const expected = entries[index].data
    const expectedBuf = Buffer.isBuffer(expected) ? expected : Buffer.from(expected, 'utf8')
    assert.equal(entry.sha256, sha256(expectedBuf), `${entry.name} 内容 sha256 不一致`)
    assert.equal(entry.size, expectedBuf.length)
    assert.equal(entry.flags & 0x0800, 0x0800)
    assert.equal(entry.method, 0)
  }
})

test('createZip：拒绝空条目列表与缺失文件名', () => {
  assert.throws(() => createZip([]), /至少需要一个文件/)
  assert.throws(() => createZip(null), /至少需要一个文件/)
  assert.throws(() => createZip([{ data: 'x' }]), /缺少文件名/)
  assert.throws(() => createZip([{ name: '', data: 'x' }]), /缺少文件名/)
})

/* --------------------------------- DOCX -------------------------------- */

test('buildDocx：最小合法 OOXML，python-docx 可读段落与表格', async (t) => {
  const model = {
    title: '辩论模拟总结：数字化让生活更美好',
    subtitle: '20261021-175309-测试 · 2026-10-21 17:53:09',
    sections: [
      {
        heading: '一、轮次总览',
        paragraphs: ['辩题：数字化让生活更美好', '模式：演示模式，轮次 1。'],
        table: {
          headers: ['轮次', '正方', '反方', '发言数'],
          rows: [['第 1 轮', '88', '76', '5']],
        },
      },
      {
        heading: '二、教练总结',
        bullets: ['正方教练总结：立论清晰。', '反方教练总结：需补齐数据。'],
      },
    ],
    footer: '由 DSH 辩论模拟插件生成',
  }

  const docx = buildDocx(model)
  assert.ok(docx.length > 1024, 'DOCX 体积应大于 1KB')

  // 1) ZIP 结构正确（DOCX 本身是 store 模式的 ZIP）
  const parsed = parseZip(docx)
  const parts = parsed.map((entry) => entry.name)
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/_rels/document.xml.rels',
    'docProps/core.xml',
    'docProps/app.xml',
  ]) {
    assert.ok(parts.includes(required), `DOCX 缺少必需部件：${required}`)
  }

  // 2) 落盘 + python-docx 打开并读取段落
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-debate-docx-'))
  t.after(async () => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'summary.docx')
  const written = await writeDocxFile(file, model)
  assert.equal(written.bytes, docx.length)

  const python = findPython()
  if (!python) {
    t.diagnostic('未找到带 python-docx 的 Python，跳过 python-docx 段落校验')
    return
  }
  const report = JSON.parse(runPython(python, PY_DOCX_INSPECT, [file]))
  assert.equal(report.bad, null, 'DOCX 内部 ZIP 的 CRC 应全部正确')
  assert.deepEqual(report.parts, parts.sort(), 'python 读出的部件清单应与 Node 解包一致')
  const paragraphs = report.paragraphs
  assert.equal(paragraphs[0], model.title, '首段应为文档标题')
  assert.equal(paragraphs[1], model.subtitle, '第二段应为副标题')
  assert.ok(paragraphs.includes('一、轮次总览'), '应包含章节标题')
  assert.ok(paragraphs.includes('辩题：数字化让生活更美好'), '应包含正文段落')
  assert.ok(
    paragraphs.some((line) => line.startsWith('• 正方教练总结')),
    `应包含项目符号段落，实际段落：${JSON.stringify(paragraphs)}`,
  )
  assert.equal(paragraphs[paragraphs.length - 1], model.footer, '末段应为页脚')

  assert.equal(report.tables.length, 1, '应生成 1 个表格')
  assert.deepEqual(report.tables[0][0], ['轮次', '正方', '反方', '发言数'], '表头应一致')
  assert.deepEqual(report.tables[0][1], ['第 1 轮', '88', '76', '5'], '表格数据应一致')
})

test('buildDocx：空模型也能生成可被 python-docx 打开的文档', async () => {
  const docx = buildDocx({})
  const parsed = parseZip(docx)
  assert.ok(parsed.some((entry) => entry.name === 'word/document.xml'))
  const python = findPython()
  if (!python) return
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-debate-docx-empty-'))
  try {
    const file = path.join(dir, 'empty.docx')
    await fsp.writeFile(file, docx)
    const report = JSON.parse(runPython(python, PY_DOCX_INSPECT, [file]))
    assert.equal(report.bad, null)
    assert.ok(Array.isArray(report.paragraphs))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------- 路径与工具 ------------------------------ */

test('safeJoin：阻止路径穿越与绝对路径', () => {
  const base = path.join(os.tmpdir(), 'dsh-debate-safejoin')
  assert.equal(safeJoin(base, '第01轮_辩论归档.zip'), path.resolve(base, '第01轮_辩论归档.zip'))
  assert.equal(safeJoin(base, '正方/发言记录.md'), path.resolve(base, '正方', '发言记录.md'))
  assert.equal(safeJoin(base, 'a/./b.md'), path.resolve(base, 'a', 'b.md'))

  for (const bad of ['', '../evil.txt', '..\\evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/Windows/win.ini', '\\\\server\\share\\x', null, undefined, 42]) {
    assert.equal(safeJoin(base, bad), null, `应拒绝非法路径：${String(bad)}`)
  }
  assert.equal(safeJoin(base, 'a/../b.md'), path.resolve(base, 'b.md'), '归一化后仍在 base 内则允许')
})

test('slugify / runIdFor / formatBytes：命名规则稳定可追溯', () => {
  assert.equal(slugify('数字化让生活更美好'), '数字化让生活更美好')
  assert.equal(slugify('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i')
  assert.equal(slugify('  多 空格  与 换行\n第二行  '), '多-空格-与-换行-第二行')
  assert.equal(slugify('***'), 'debate', '无有效字符时回落到默认值')
  assert.equal(slugify('', 'fallback'), 'fallback')
  assert.equal(slugify('长'.repeat(100)).length, 40, 'slug 最长 40 字符')

  const id = runIdFor('数字化 让生活更美好', new Date(2026, 9, 21, 17, 53, 9))
  assert.equal(id, '20261021-175309-数字化-让生活更美好')
  assert.match(id, /^\d{8}-\d{6}-/)

  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1024 * 1024), '1.00 MB')
})
