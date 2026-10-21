/**
 * ZIP（store 模式，UTF-8 文件名）与最小合法 DOCX 生成，以及文件落盘辅助。
 * 无第三方依赖。契约见 docs/CONTRACT.md §6。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const year = Math.max(1980, d.getFullYear())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, day }
}

function normalizeEntryData(data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  return Buffer.from(String(data ?? ''), 'utf8')
}

/** 生成 ZIP Buffer。entries: [{name, data, date?}]，name 使用正斜杠。 */
export function createZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('ZIP 至少需要一个文件')
  const chunks = []
  const central = []
  let offset = 0
  const { time, day } = dosDateTime()
  for (const entry of entries) {
    const name = String(entry.name || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!name) throw new Error('ZIP 条目缺少文件名')
    const nameBuf = Buffer.from(name, 'utf8')
    const data = normalizeEntryData(entry.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, data)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(0, 10)
    dir.writeUInt16LE(time, 12)
    dir.writeUInt16LE(day, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt16LE(0, 30)
    dir.writeUInt16LE(0, 32)
    dir.writeUInt16LE(0, 34)
    dir.writeUInt16LE(0, 36)
    dir.writeUInt32LE(0, 38)
    dir.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([dir, nameBuf]))
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, end])
}

export async function writeZipFile(filePath, entries) {
  await ensureDir(path.dirname(filePath))
  const buf = createZip(entries)
  await fsp.writeFile(filePath, buf)
  return { bytes: buf.length }
}

/* ------------------------------- DOCX ---------------------------------- */

function escapeXml(value) {
  return String(value ?? '')
    // 去掉 XML 1.0 不允许的控制字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function runXml(text, opts = {}) {
  const props = []
  if (opts.bold) props.push('<w:b/>')
  if (opts.italic) props.push('<w:i/>')
  if (opts.size) props.push(`<w:sz w:val="${Math.round(opts.size * 2)}"/><w:szCs w:val="${Math.round(opts.size * 2)}"/>`)
  if (opts.color) props.push(`<w:color w:val="${opts.color}"/>`)
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : ''
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
}

function paragraphXml(text, opts = {}) {
  const pPr = []
  if (opts.style) pPr.push(`<w:pStyle w:val="${opts.style}"/>`)
  if (opts.align) pPr.push(`<w:jc w:val="${opts.align}"/>`)
  if (opts.spacingAfter !== undefined) pPr.push(`<w:spacing w:after="${opts.spacingAfter}"/>`)
  if (opts.indent) pPr.push('<w:ind w:firstLine="420"/>')
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''
  const runs = Array.isArray(text) ? text : [text]
  return `<w:p>${pPrXml}${runs.map((t) => runXml(t, opts)).join('')}</w:p>`
}

function tableXml(table) {
  const headers = Array.isArray(table.headers) ? table.headers : []
  const rows = Array.isArray(table.rows) ? table.rows : []
  const cols = Math.max(headers.length, ...rows.map((r) => r.length), 1)
  const width = Math.floor(9200 / cols)
  const cell = (text, bold) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${paragraphXml(text ?? '', {
      bold,
      size: 9.5,
    })}</w:tc>`
  const tr = (cells, bold = false) =>
    `<w:tr>${cells.map((c) => cell(c, bold)).join('')}</w:tr>`
  const headerRow = headers.length ? tr(headers, true) : ''
  const bodyRows = rows.map((r) => tr(r)).join('')
  return `<w:tbl>
<w:tblPr><w:tblW w:w="9200" w:type="dxa"/><w:tblBorders>
<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>
</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>
${headerRow}${bodyRows}</w:tbl>`
}

function documentXml(model) {
  const body = []
  if (model.title) body.push(paragraphXml(model.title, { style: 'Title', align: 'center', bold: true, size: 22, spacingAfter: 120 }))
  if (model.subtitle) body.push(paragraphXml(model.subtitle, { align: 'center', color: '666666', size: 11, spacingAfter: 240 }))
  for (const section of model.sections || []) {
    if (section.heading) body.push(paragraphXml(section.heading, { style: 'Heading1', bold: true, size: 15, spacingAfter: 100 }))
    for (const p of section.paragraphs || []) {
      const text = String(p ?? '')
      if (!text) continue
      if (text.startsWith('• ')) body.push(paragraphXml(text, { size: 11, indent: false }))
      else body.push(paragraphXml(text, { size: 11, indent: true }))
    }
    for (const b of section.bullets || []) body.push(paragraphXml(`• ${b}`, { size: 11 }))
    if (section.table) body.push(tableXml(section.table))
    body.push(paragraphXml('', { size: 6 }))
  }
  if (model.footer) body.push(paragraphXml(model.footer, { align: 'center', color: '888888', size: 9 }))
  body.push(
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>',
  )
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${body.join('')}</w:body></w:document>`
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

function coreXml(model) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(model.title || '辩论模拟总结')}</dc:title>
<dc:creator>DSH 辩论模拟插件</dc:creator>
<cp:lastModifiedBy>DSH 辩论模拟插件</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`
}

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>DSH Debate Simulator</Application>
</Properties>`

/** 生成 DOCX Buffer。 */
export function buildDocx(model) {
  return createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: documentXml(model || {}) },
    { name: 'word/styles.xml', data: STYLES_XML },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'docProps/core.xml', data: coreXml(model || {}) },
    { name: 'docProps/app.xml', data: APP_XML },
  ])
}

export async function writeDocxFile(filePath, model) {
  await ensureDir(path.dirname(filePath))
  const buf = buildDocx(model)
  await fsp.writeFile(filePath, buf)
  return { bytes: buf.length }
}

/* ------------------------------ file utils ----------------------------- */

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

export async function writeTextFile(filePath, text) {
  await writeFileAtomic(filePath, Buffer.from(String(text ?? ''), 'utf8'))
}

export async function writeJsonFile(filePath, value) {
  await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writeFileAtomic(filePath, data) {
  await ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, filePath)
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

export async function removeDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 })
}

export async function removeFile(filePath) {
  await fsp.rm(filePath, { force: true })
}

export async function listFilesRecursive(dir) {
  const out = []
  async function walk(current) {
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) {
        let size = 0
        try {
          size = (await fsp.stat(abs)).size
        } catch {
          size = 0
        }
        out.push({ abs, rel: path.relative(dir, abs).split(path.sep).join('/'), size })
      }
    }
  }
  await walk(dir)
  return out
}

/** 防止路径穿越；越界返回 null。 */
export function safeJoin(baseDir, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null
  if (rel.includes('\0')) return null
  const normalized = rel.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null
  const base = path.resolve(baseDir)
  const target = path.resolve(base, normalized)
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep
  if (target !== base && !target.startsWith(baseWithSep)) return null
  return target
}

export function slugify(input, fallback = 'debate') {
  const text = String(input ?? '').trim()
  const slug = text
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || fallback
}

export function formatBytes(n) {
  const num = Number(n) || 0
  if (num < 1024) return `${num} B`
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`
  return `${(num / 1024 / 1024).toFixed(2)} MB`
}

export function runIdFor(topic, now = new Date()) {
  const pad = (v) => String(v).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${slugify(topic, 'debate')}`
}

export function hostPlatform() {
  return `${os.platform()}-${os.arch()}`
}
