import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';

const input = process.argv[2] ?? 'seongnae.dwg';
const outDir = process.argv[3] ?? 'result';
fs.mkdirSync(outDir, { recursive: true });
const bytes = fs.readFileSync(input);
const sourceSha = crypto.createHash('sha256').update(bytes).digest('hex');
if (sourceSha !== 'dab3babe4100cb4a330e2dda44ba43caa20456786a5893510b04f81157935535') {
  throw new Error(`source SHA mismatch: ${sourceSha}`);
}
if (bytes.length !== 1466909) throw new Error(`source size mismatch: ${bytes.length}`);

const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const wasmDir = path.resolve('node_modules/@mlightcad/libredwg-web/wasm');
const libredwg = await LibreDwg.create(wasmDir);
const ptr = libredwg.dwg_read_data(arrayBuffer, Dwg_File_Type.DWG);
if (!ptr) throw new Error('null DWG pointer');
let database, stats;
try {
  const converted = libredwg.convertEx(ptr);
  database = converted.database;
  stats = converted.stats;
} finally {
  libredwg.dwg_free(ptr);
}

const TEXT_TYPES = new Set(['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF']);
const POINT_KEYS = new Set(['startPoint','endPoint','insertionPoint','center','centerPoint','basePoint','location','position','point','firstPoint','secondPoint','thirdPoint','fourthPoint','vertices','points','controlPoints','fitPoints','corners','start','end','p1','p2','majorAxisEndPoint']);
const bounds = [409000, 500000, 764000, 808000];
function asPoint(v) {
  if (Array.isArray(v) && v.length >= 2 && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) return [Number(v[0]), Number(v[1])];
  if (v && typeof v === 'object' && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y))) return [Number(v.x), Number(v.y)];
  return null;
}
function collectPoints(value, key, output, depth = 0) {
  if (depth > 10 || value == null) return;
  const direct = asPoint(value);
  if (direct && POINT_KEYS.has(key)) { output.push(direct); return; }
  if (Array.isArray(value)) {
    if (!POINT_KEYS.has(key)) return;
    for (const item of value) collectPoints(item, key, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [childKey, childValue] of Object.entries(value)) if (POINT_KEYS.has(childKey)) collectPoints(childValue, childKey, output, depth + 1);
}
function textPoint(entity) {
  for (const key of ['startPoint','insertionPoint','position','location','point','endPoint']) {
    const point = asPoint(entity?.[key]); if (point) return point;
  }
  return null;
}
function assignmentPoint(entity) {
  if (TEXT_TYPES.has(String(entity?.type))) return textPoint(entity);
  const points = []; collectPoints(entity, '', points);
  if (!points.length) return null;
  const xs = points.map(p => p[0]); const ys = points.map(p => p[1]);
  return [(Math.min(...xs)+Math.max(...xs))/2, (Math.min(...ys)+Math.max(...ys))/2];
}
function contains(point) { return point && point[0] >= bounds[0] && point[0] < bounds[1] && point[1] >= bounds[2] && point[1] < bounds[3]; }
function clean(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return { byteLength: value.byteLength, omitted: true };
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k,v] of Object.entries(value)) {
      if (['xdata','proxyEntity','thumbnailImage','bmpPreview'].includes(k)) continue;
      out[k] = clean(v);
    }
    return out;
  }
  return value;
}
const entities = database.entities ?? [];
if (entities.length !== 42176) throw new Error(`model entity count drift: ${entities.length}`);
const windowEntities = entities.filter(e => contains(assignmentPoint(e)));
if (windowEntities.length !== 2533) throw new Error(`window count drift: ${windowEntities.length}`);
const selected = windowEntities.filter(e => ['WAL','wal2','WID','wid2','TEXT','TXT2'].includes(String(e.layer)));
const layerCounts = {};
const typeCounts = {};
for (const e of windowEntities) {
  layerCounts[e.layer] = (layerCounts[e.layer] ?? 0) + 1;
  typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
}
for (const [layer, expected] of Object.entries({WAL:566,WID:1754,TEXT:42,TXT2:1})) {
  if ((layerCounts[layer] ?? 0) !== expected) throw new Error(`${layer} drift: ${layerCounts[layer] ?? 0}`);
}
const summary = {
  source_sha256: sourceSha,
  source_bytes: bytes.length,
  model_entities: entities.length,
  window_bounds: bounds,
  window_entities: windowEntities.length,
  selected_entities: selected.length,
  layer_counts: layerCounts,
  type_counts: typeCounts,
  conversion_stats: clean(stats),
  selected_schema_samples: Object.fromEntries([...new Set(selected.map(e => `${e.layer}:${e.type}`))].sort().map(key => {
    const [layer,type] = key.split(':');
    const e = selected.find(x => String(x.layer) === layer && String(x.type) === type);
    return [key, clean(e)];
  }))
};
fs.writeFileSync(path.join(outDir,'summary.json'), JSON.stringify(summary,null,2));
fs.writeFileSync(path.join(outDir,'window-selected.json'), JSON.stringify(selected.map(clean)));
fs.writeFileSync(path.join(outDir,'texts.json'), JSON.stringify(selected.filter(e => ['TEXT','MTEXT','ATTRIB','ATTDEF'].includes(String(e.type))).map(clean),null,2));
console.log(JSON.stringify({ok:true, sourceSha, window:windowEntities.length, selected:selected.length, layerCounts}));
