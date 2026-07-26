import fs from 'node:fs'
import path from 'node:path'
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web'

const input = process.argv[2] ?? 'nuwon.dwg'
const outDir = process.argv[3] ?? 'result'
fs.mkdirSync(outDir, { recursive: true })

const bytes = fs.readFileSync(input)
const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
const wasmDir = path.resolve('node_modules/@mlightcad/libredwg-web/wasm')
const libredwg = await LibreDwg.create(wasmDir)
const ptr = libredwg.dwg_read_data(arrayBuffer, Dwg_File_Type.DWG)
if (!ptr) throw new Error('LibreDWG returned a null DWG pointer')

let database
let stats
try {
  const converted = libredwg.convertEx(ptr)
  database = converted.database
  stats = converted.stats
} finally {
  libredwg.dwg_free(ptr)
}

const countBy = (items, keyFn) => {
  const out = {}
  for (const item of items) {
    const key = String(keyFn(item) ?? '<null>')
    out[key] = (out[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y)
const geometryPoints = e => {
  const pts = []
  const add = p => { if (finitePoint(p)) pts.push({ x: p.x, y: p.y }) }
  switch (e.type) {
    case 'LINE': add(e.startPoint); add(e.endPoint); break
    case 'LWPOLYLINE': for (const p of e.vertices ?? []) add(p); break
    case 'POLYLINE2D': for (const v of e.vertices ?? []) add(v.point ?? v); break
    case 'POLYLINE3D': for (const v of e.vertices ?? []) add(v.point ?? v); break
    case 'TEXT': add(e.startPoint); add(e.endPoint); break
    case 'MTEXT': add(e.insertionPoint); break
    case 'INSERT': add(e.insertionPoint); break
    case 'ARC': case 'CIRCLE': case 'ELLIPSE': add(e.center); break
    case 'POINT': add(e.point); break
    default:
      add(e.startPoint); add(e.endPoint); add(e.insertionPoint); add(e.center); add(e.point)
  }
  return pts
}

const bboxOf = entities => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0
  for (const e of entities) for (const p of geometryPoints(e)) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); count++
  }
  return count ? { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, pointCount: count } : null
}

const clean = value => {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return { byteLength: value.byteLength, omitted: true }
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'xdata' || k === 'proxyEntity' || k === 'thumbnailImage' || k === 'bmpPreview') continue
      out[k] = clean(v)
    }
    return out
  }
  return value
}

const compactEntity = e => {
  const base = {
    type: e.type,
    handle: e.handle,
    layer: e.layer,
    ownerBlockRecordSoftId: e.ownerBlockRecordSoftId
  }
  const keysByType = {
    LINE: ['startPoint', 'endPoint', 'thickness'],
    LWPOLYLINE: ['flag', 'vertices', 'constantWidth', 'elevation', 'thickness'],
    POLYLINE2D: ['flag', 'vertices', 'elevation', 'startWidth', 'endWidth', 'thickness'],
    POLYLINE3D: ['flag', 'vertices'],
    TEXT: ['text', 'startPoint', 'endPoint', 'textHeight', 'rotation', 'halign', 'valign'],
    MTEXT: ['text', 'insertionPoint', 'textHeight', 'rectWidth', 'rectHeight', 'rotation'],
    INSERT: ['name', 'insertionPoint', 'xScale', 'yScale', 'zScale', 'rotation', 'columnCount', 'rowCount', 'columnSpacing', 'rowSpacing', 'attribs'],
    ARC: ['center', 'radius', 'startAngle', 'endAngle', 'thickness'],
    CIRCLE: ['center', 'radius', 'thickness'],
    ELLIPSE: ['center', 'majorAxisEndPoint', 'axisRatio', 'startParameter', 'endParameter'],
    POINT: ['point']
  }
  for (const key of keysByType[e.type] ?? []) if (e[key] !== undefined) base[key] = clean(e[key])
  return base
}

const model = database.entities ?? []
const blockEntries = database.tables?.BLOCK_RECORD?.entries ?? database.tables?.BLOCK_RECORD ?? []
const blocks = Array.isArray(blockEntries) ? blockEntries : (blockEntries.entries ?? [])
const allBlockEntities = blocks.flatMap(b => b.entities ?? [])
const allEntities = [...model, ...allBlockEntities]

const textEntities = allEntities.filter(e => e.type === 'TEXT' || e.type === 'MTEXT').map(e => ({
  scope: model.includes(e) ? 'model' : 'block',
  ownerBlockRecordSoftId: e.ownerBlockRecordSoftId,
  type: e.type,
  layer: e.layer,
  text: e.text,
  point: e.type === 'TEXT' ? e.startPoint : e.insertionPoint,
  textHeight: e.textHeight,
  rotation: e.rotation
}))

const summary = {
  input: path.basename(input),
  byteLength: bytes.byteLength,
  header: clean(database.header),
  conversionStats: clean(stats),
  modelEntityCount: model.length,
  blockCount: blocks.length,
  blockEntityCount: allBlockEntities.length,
  modelLayerCounts: countBy(model, e => e.layer),
  modelTypeCounts: countBy(model, e => e.type),
  allLayerCounts: countBy(allEntities, e => e.layer),
  allTypeCounts: countBy(allEntities, e => e.type),
  modelBBox: bboxOf(model),
  allBBox: bboxOf(allEntities),
  blockIndex: blocks.map(b => ({
    name: b.name,
    handle: b.handle,
    ownerBlockRecordSoftId: b.ownerBlockRecordSoftId,
    entityCount: (b.entities ?? []).length,
    layerCounts: countBy(b.entities ?? [], e => e.layer),
    typeCounts: countBy(b.entities ?? [], e => e.type),
    bbox: bboxOf(b.entities ?? []),
    basePoint: clean(b.basePoint),
    flags: b.flags,
    insertionUnits: b.insertionUnits
  })).sort((a, b) => b.entityCount - a.entityCount),
  floorTitleTexts: textEntities.filter(t => /(?:^|\s)(?:지하\s*)?(?:[0-9一二三四五六七八九십]+\s*)?층\s*평면도|평면도/i.test(String(t.text ?? ''))),
  textCount: textEntities.length
}

fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
fs.writeFileSync(path.join(outDir, 'texts.json'), JSON.stringify(textEntities, null, 2))

const writeChunks = (prefix, records, maxBytes = 700_000) => {
  let chunk = [], size = 2, index = 0
  const flush = () => {
    if (!chunk.length) return
    const name = `${prefix}-${String(index++).padStart(3, '0')}.json`
    fs.writeFileSync(path.join(outDir, name), JSON.stringify(chunk))
    chunk = []; size = 2
  }
  for (const record of records) {
    const text = JSON.stringify(record)
    if (chunk.length && size + text.length + 1 > maxBytes) flush()
    chunk.push(record); size += text.length + 1
  }
  flush()
  return index
}

const keptTypes = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE2D', 'POLYLINE3D', 'TEXT', 'MTEXT', 'INSERT', 'ARC', 'CIRCLE', 'ELLIPSE', 'POINT'])
const modelKept = model.filter(e => keptTypes.has(e.type)).map(compactEntity)
const blockKept = blocks.flatMap(b => (b.entities ?? []).filter(e => keptTypes.has(e.type)).map(e => ({ blockName: b.name, blockHandle: b.handle, entity: compactEntity(e) })))
summary.modelChunkCount = writeChunks('model', modelKept)
summary.blockChunkCount = writeChunks('blocks', blockKept)
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ ok: true, model: model.length, blocks: blocks.length, texts: textEntities.length, outDir }))
