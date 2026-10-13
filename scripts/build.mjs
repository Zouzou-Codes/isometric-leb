// Turns the raw OpenStreetMap download into small map chunks the viewer can stream.
//
//   node scripts/build.mjs
//
// Reads  cache/raw/*.json
// Writes public/data/meta.json, ground.json, names.json and chunks/<cx>_<cz>.json
//
// Every building gets a height (from OSM tags, or estimated from its type) and a
// material class that the renderer maps to a pixel-art palette.

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("config.json", ROOT)));
const RAW = new URL("cache/raw/", ROOT);
const OUT = new URL("public/data/", ROOT);
const CHUNKS = new URL("chunks/", OUT);
await rm(OUT, { recursive: true, force: true });
await mkdir(CHUNKS, { recursive: true });

/* ---------- projection: local metres, x = east, z = south ---------- */
const { south, west, north, east } = config.bbox;
const LAT0 = (south + north) / 2, LNG0 = (west + east) / 2;
const MY = 110574, MX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const proj = (lat, lng) => [(lng - LNG0) * MX, -(lat - LAT0) * MY];
const C = config.chunkMeters;
const [minX, maxZ] = proj(south, west), [maxX, minZ] = proj(north, east);

/* ---------- helpers ---------- */
function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296; }
const pick = (id, arr) => arr[Math.floor(hash(id) * arr.length) % arr.length];
function area(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return a / 2; }
function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let maxD = 0, idx = -1;
    const [ax, az] = pts[a], [bx, bz] = pts[b]; const dx = bx - ax, dz = bz - az; const L = Math.hypot(dx, dz) || 1e-9;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dz * pts[i][0] - dx * pts[i][1] + bx * az - bz * ax) / L; if (d > maxD) { maxD = d; idx = i; } }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function ringFrom(geom) {
  let r = geom.map((p) => proj(p.lat, p.lon));
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
  return r;
}
// Join relation member ways into closed rings.
function assembleRings(members) {
  const segs = members.filter((m) => m.type === "way" && (m.role === "outer" || m.role === "") && m.geometry).map((m) => m.geometry.map((p) => [p.lat, p.lon]));
  const rings = []; const key = (p) => p[0].toFixed(7) + "," + p[1].toFixed(7);
  while (segs.length) {
    let cur = segs.shift();
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 5000) {
      const end = key(cur[cur.length - 1]); let found = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (key(s[0]) === end) { cur = cur.concat(s.slice(1)); segs.splice(i, 1); found = true; break; }
        if (key(s[s.length - 1]) === end) { cur = cur.concat(s.slice(0, -1).reverse()); segs.splice(i, 1); found = true; break; }
      }
      if (!found) break;
    }
    if (cur.length > 3) rings.push(ringFrom(cur.map(([lat, lon]) => ({ lat, lon }))));
  }
  return rings;
}
const bboxOf = (r) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const [x, z] of r) { if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z; } return [a, b, c, d]; };
const centroid = (r) => { let x = 0, z = 0; for (const p of r) { x += p[0]; z += p[1]; } return [x / r.length, z / r.length]; };
function inside(x, z, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; }

/* ---------- building height & material ---------- */
function parseLen(v) {
  if (!v) return null; const s = String(v).trim();
  const ft = s.match(/^([\d.]+)\s*(ft|')/); if (ft) return parseFloat(ft[1]) * 0.3048;
  const n = parseFloat(s.replace(",", ".")); return Number.isFinite(n) && n > 0 && n < 400 ? n : null;
}
const DEFAULT_H = { house: 8, detached: 8, semidetached_house: 8, terrace: 10, residential: 12, apartments: 16, flats: 16, commercial: 18, office: 22, retail: 8, supermarket: 7, church: 16, cathedral: 30, chapel: 9, mosque: 12, synagogue: 12, temple: 10, civic: 16, government: 18, public: 14, museum: 18, university: 18, college: 15, school: 12, hospital: 20, hotel: 22, train_station: 16, transportation: 10, industrial: 9, warehouse: 9, garage: 3, garages: 3, shed: 3, hut: 3, roof: 4, parking: 12, service: 5, kiosk: 3, stadium: 25, theatre: 16, construction: 10 };
// material classes the renderer understands
const M = { REDBRICK: 0, STOCKBRICK: 1, STONE: 2, STUCCO: 3, GLASS: 4, GLASS2: 5, CONCRETE: 6, SHED: 7, CHURCH: 8 };
function heightOf(t, id) {
  let h = parseLen(t.height) ?? parseLen(t["building:height"]);
  if (!h) { const lv = parseFloat(t["building:levels"]); if (lv > 0 && lv < 120) h = lv * 3.3 + (parseFloat(t["roof:levels"]) || 0) * 2.2 + 1; }
  if (!h) h = (DEFAULT_H[t.building] ?? 11) * (0.85 + hash(id) * 0.35);
  return Math.round(Math.min(330, h) * 2) / 2;
}
function materialOf(t, h, id) {
  const mat = (t["building:material"] || t["building:facade:material"] || "").toLowerCase();
  const col = (t["building:colour"] || "").toLowerCase();
  if (/glass|mirror/.test(mat)) return h > 80 ? pick(id, [M.GLASS, M.GLASS2]) : M.GLASS;
  if (/concrete/.test(mat)) return M.CONCRETE;
  if (/stone|sandstone|limestone/.test(mat)) return M.STONE;
  if (/brick/.test(mat)) return /yellow|brown|beige/.test(col) ? M.STOCKBRICK : pick(id, [M.REDBRICK, M.STOCKBRICK]);
  if (/plaster|render|stucco/.test(mat) || /white|cream/.test(col)) return M.STUCCO;
  const b = t.building;
  if (["church", "cathedral", "chapel", "mosque", "synagogue", "temple"].includes(b) || t.amenity === "place_of_worship") return M.CHURCH;
  if (["garage", "garages", "shed", "hut", "roof", "kiosk", "carport"].includes(b) || h < 4.5) return M.SHED;
  if (["industrial", "warehouse", "parking", "service", "transportation", "train_station", "construction"].includes(b)) return M.CONCRETE;
  if (h >= 60) return pick(id, [M.GLASS, M.GLASS, M.GLASS2]);
  if (["civic", "government", "public", "museum", "university", "college", "hospital", "theatre"].includes(b) || t.tourism === "museum") return h > 30 ? pick(id, [M.STONE, M.CONCRETE]) : M.STONE;
  if (["commercial", "office", "hotel"].includes(b)) return h > 40 ? pick(id, [M.GLASS, M.GLASS2, M.STONE]) : pick(id, [M.STONE, M.STOCKBRICK, M.STUCCO, M.GLASS]);
  if (["house", "terrace", "semidetached_house", "detached"].includes(b)) return pick(id, [M.REDBRICK, M.STOCKBRICK, M.STOCKBRICK, M.STUCCO]);
  if (["apartments", "residential", "flats"].includes(b)) return h > 35 ? pick(id, [M.CONCRETE, M.GLASS, M.STOCKBRICK]) : pick(id, [M.REDBRICK, M.STOCKBRICK, M.STUCCO, M.STOCKBRICK]);
  if (h > 28) return pick(id, [M.STONE, M.CONCRETE, M.GLASS2]);
  return pick(id, [M.REDBRICK, M.STOCKBRICK, M.STOCKBRICK, M.STUCCO, M.STONE]);
}
// roof style: 0 flat, 1 pitched (drawn with a ridge), 2 dome
function roofOf(t, h, cls) {
  const s = (t["roof:shape"] || "").toLowerCase();
  if (s === "dome" || s === "onion") return 2;
  if (/gabled|hipped|pitched|mansard|gambrel/.test(s)) return 1;
  if (s === "flat") return 0;
  if ((cls === M.REDBRICK || cls === M.STOCKBRICK || cls === M.STUCCO) && h < 16) return 1;
  if (cls === M.CHURCH) return 1;
  return 0;
}

/* ---------- ground classes ---------- */
const ROAD = { motorway: 0, trunk: 0, primary: 1, secondary: 2, tertiary: 2, residential: 3, unclassified: 3, living_street: 3, service: 4, pedestrian: 5, footway: 6 };
function greenClass(t) {
  if (t.landuse === "cemetery") return 2;
  if (t.landuse === "forest" || t.leisure === "nature_reserve") return 3;
  if (t.landuse === "allotments") return 4;
  if (t.leisure === "pitch") return 1;
  return 0;
}

/* ---------- read everything ---------- */
const seen = new Set();
const chunks = new Map();
const chunkOf = (cx, cz) => { const k = cx + "_" + cz; let c = chunks.get(k); if (!c) { c = { cx, cz, b: [], r: [], t: [] }; chunks.set(k, c); } return c; };
const water = [], green = [], names = [];
let nB = 0, nR = 0, nT = 0;
const files = (await readdir(RAW)).filter((f) => f.endsWith(".json"));
if (!files.length) { console.error("No raw data found. Run: node scripts/fetch.mjs (or node scripts/make-sample.mjs for a test area)"); process.exit(1); }
console.log(`Reading ${files.length} cells…`);

const q = (v) => Math.round(v * 2); // 0.5 m precision

for (const f of files) {
  const data = JSON.parse(await readFile(new URL(f, RAW), "utf8"));
  for (const el of data.elements || []) {
    const id = el.type[0] + el.id; if (seen.has(id)) continue; seen.add(id);
    const t = el.tags || {};
    let rings = [];
    if (el.type === "way" && el.geometry) rings = [ringFrom(el.geometry)];
    else if (el.type === "relation" && el.members) rings = assembleRings(el.members);
    if (!rings.length) continue;
    const isClosed = el.type === "relation" || (el.geometry && el.geometry.length > 3 && el.geometry[0].lat === el.geometry[el.geometry.length - 1].lat && el.geometry[0].lon === el.geometry[el.geometry.length - 1].lon);

    if (t.building && t.building !== "no" && isClosed && el.type === "way") {
      if (t.location === "underground" || parseFloat(t.layer) < 0) continue;
      let r = simplify(rings[0], 0.5); if (r.length < 3) continue;
      const a = area(r); if (Math.abs(a) < 6) continue;
      if (a < 0) r = r.reverse(); // consistent winding
      const [cx0, cz0] = centroid(r);
      if (cx0 < minX || cx0 > maxX || cz0 < minZ || cz0 > maxZ) continue;
      const h = heightOf(t, el.id); const cls = materialOf(t, h, el.id); const roof = roofOf(t, h, cls);
      const cx = Math.floor(cx0 / C), cz = Math.floor(cz0 / C); const ox = cx * C, oz = cz * C;
      const rec = [Math.round(h * 2), cls, roof]; for (const [x, z] of r) rec.push(q(x - ox), q(z - oz));
      chunkOf(cx, cz).b.push(rec); nB++;
      if (t.name && (Math.abs(a) > 1500 || t.tourism || t.historic || t.amenity)) names.push([t.name, Math.round(cx0), Math.round(cz0)]);
      continue;
    }
    const isWater = t.natural === "water" || t.waterway === "riverbank" || t.water === "river";
    const isGreen = !isWater && (t.leisure || t.landuse);
    if ((isWater || isGreen) && isClosed) {
      const gc = isWater ? 0 : greenClass(t);
      for (let r of rings) {
        r = simplify(r, 1.5); if (r.length < 3 || Math.abs(area(r)) < 30) continue;
        const bb = bboxOf(r); if (bb[2] < minX - 2000 || bb[0] > maxX + 2000 || bb[3] < minZ - 2000 || bb[1] > maxZ + 2000) continue;
        const flat = []; for (const [x, z] of r) flat.push(Math.round(x), Math.round(z));
        (isWater ? water : green).push([gc, ...bb.map(Math.round), ...flat]);
        if (isGreen && [0, 2, 3].includes(gc)) {
          // scatter trees on a jittered grid
          const step = gc === 3 ? 9 : 16;
          for (let x = bb[0]; x < bb[2]; x += step) for (let z = bb[1]; z < bb[3]; z += step) {
            const hx = hash(Math.round(x * 7 + z * 13 + el.id)), hz = hash(Math.round(x * 11 + z * 5 + el.id));
            if (hx < (gc === 0 ? 0.45 : 0.25)) continue;
            const px = x + hx * step * 0.8, pz = z + hz * step * 0.8;
            if (!inside(px, pz, r)) continue;
            const cx = Math.floor(px / C), cz = Math.floor(pz / C);
            chunkOf(cx, cz).t.push(q(px - cx * C), q(pz - cz * C)); nT++;
          }
        }
        if (t.name && Math.abs(area(r)) > 8000) { const [x, z] = centroid(r); names.push([t.name, Math.round(x), Math.round(z)]); }
      }
      continue;
    }
    if (t.waterway === "river" && el.type === "way" && el.geometry) {
      // a river centreline: widen it into water (the Thames is ~250 m across in central London)
      const thames = /thames/i.test(t.name || "");
      const width = parseLen(t.width) || (thames ? 250 : 22);
      const line = simplify(el.geometry.map((p) => proj(p.lat, p.lon)), 2);
      for (let s0 = 0; s0 < line.length - 1; s0 += 40) {
        const part = line.slice(s0, Math.min(line.length, s0 + 41)); if (part.length < 2) continue;
        const L2 = [], R2 = [];
        for (let i = 0; i < part.length; i++) {
          const a = part[Math.max(0, i - 1)], b = part[Math.min(part.length - 1, i + 1)]; const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
          const nx = -dz / l, nz = dx / l, h = width / 2;
          L2.push([part[i][0] + nx * h, part[i][1] + nz * h]); R2.push([part[i][0] - nx * h, part[i][1] - nz * h]);
        }
        // round the ends a little so consecutive pieces overlap without gaps
        const ring = L2.concat(R2.reverse()); const bb = bboxOf(ring);
        if (bb[2] < minX - 2000 || bb[0] > maxX + 2000 || bb[3] < minZ - 2000 || bb[1] > maxZ + 2000) continue;
        const flat = []; for (const [x, z] of ring) flat.push(Math.round(x), Math.round(z));
        water.push([thames ? 1 : 2, ...bb.map(Math.round), ...flat]);
      }
      continue;
    }
    const kind = t.highway != null ? ROAD[t.highway] : t.railway ? (t.railway === "rail" ? 7 : 8) : undefined;
    if (kind !== undefined && el.type === "way" && el.geometry) {
      if (t.tunnel === "yes" || t.tunnel === "building_passage" || parseFloat(t.layer) < 0) continue;
      const line = simplify(el.geometry.map((p) => proj(p.lat, p.lon)), 1);
      const bb = bboxOf(line);
      for (let cx = Math.floor(bb[0] / C); cx <= Math.floor(bb[2] / C); cx++) for (let cz = Math.floor(bb[1] / C); cz <= Math.floor(bb[3] / C); cz++) {
        const ox = cx * C, oz = cz * C; const rec = [kind]; for (const [x, z] of line) rec.push(q(x - ox), q(z - oz));
        chunkOf(cx, cz).r.push(rec);
      }
      nR++;
    }
  }
  process.stdout.write(".");
}
console.log(`\n${nB} buildings, ${nR} roads/rails, ${water.length} water and ${green.length} green areas, ${nT} trees`);

/* ---------- write ---------- */
// Every chunk in the bounding box is listed, so open ground and the river still get drawn.
// Only chunks that contain something get a file; the third number says whether to fetch one.
const list = [];
for (let cx = Math.floor(minX / C); cx <= Math.floor(maxX / C); cx++) for (let cz = Math.floor(minZ / C); cz <= Math.floor(maxZ / C); cz++) {
  const c = chunks.get(cx + "_" + cz);
  if (c && (c.b.length || c.r.length || c.t.length)) {
    await writeFile(new URL(cx + "_" + cz + ".json", CHUNKS), JSON.stringify({ b: c.b, r: c.r, t: c.t }));
    list.push([cx, cz, 1]);
  } else list.push([cx, cz, 0]);
}
await writeFile(new URL("ground.json", OUT), JSON.stringify({ water, green }));
const uniq = new Map(); for (const n of names) { const k = n[0].toLowerCase(); if (!uniq.has(k)) uniq.set(k, n); }
await writeFile(new URL("names.json", OUT), JSON.stringify([...uniq.values()]));
const landmarks = config.landmarks.map(([n, lat, lng]) => { const [x, z] = proj(lat, lng); return [n, Math.round(x), Math.round(z)]; });
const [sx, sz] = proj(config.start.lat, config.start.lng);
await writeFile(new URL("meta.json", OUT), JSON.stringify({
  name: config.name, lat0: LAT0, lng0: LNG0, mx: MX, my: MY, chunk: C,
  bounds: [Math.round(minX), Math.round(minZ), Math.round(maxX), Math.round(maxZ)],
  chunks: list, landmarks, start: { x: Math.round(sx), z: Math.round(sz), zoom: config.start.zoom, rotation: config.start.rotation },
  built: new Date().toISOString().slice(0, 10)
}));
console.log(`Wrote ${list.filter((c) => c[2]).length} of ${list.length} chunks and ${uniq.size} place names to public/data/`);
