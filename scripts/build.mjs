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
import { OVERRIDES, SPECIALS } from "./landmarks.mjs";

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
function assembleRings(members, role = "outer") {
  const segs = members.filter((m) => m.type === "way" && (role === "outer" ? m.role === "outer" || m.role === "" : m.role === role) && m.geometry).map((m) => m.geometry.map((p) => [p.lat, p.lon]));
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
// Beirut: most blocks are 6–10 floor apartment buildings, so residential defaults are taller than London's.
const DEFAULT_H = { house: 9, detached: 9, semidetached_house: 9, terrace: 10, residential: 22, apartments: 25, flats: 25, commercial: 20, office: 30, retail: 8, supermarket: 7, church: 16, cathedral: 30, chapel: 9, mosque: 12, synagogue: 12, temple: 10, civic: 16, government: 18, public: 14, museum: 18, university: 18, college: 15, school: 12, hospital: 20, hotel: 22, train_station: 16, transportation: 10, industrial: 9, warehouse: 9, garage: 3, garages: 3, shed: 3, hut: 3, roof: 4, parking: 12, service: 5, kiosk: 3, stadium: 25, theatre: 16, construction: 10 };
// material classes the renderer understands
const M = { REDBRICK: 0, STOCKBRICK: 1, STONE: 2, STUCCO: 3, GLASS: 4, GLASS2: 5, CONCRETE: 6, SHED: 7, CHURCH: 8 };
// Height to the top of the walls, from OSM if it says, otherwise from the floor count,
// otherwise estimated from the building type and footprint size.
function tagged(t) { return parseLen(t.height) ?? parseLen(t["building:height"]) ?? (parseFloat(t["building:levels"]) > 0 ? parseFloat(t["building:levels"]) * 3.3 + 1 : null); }
function heightOf(t, id, a = 200) {
  let h = parseLen(t.height) ?? parseLen(t["building:height"]);
  const roofH = parseLen(t["roof:height"]) ?? (parseFloat(t["roof:levels"]) > 0 ? parseFloat(t["roof:levels"]) * 2.6 : 0);
  if (h && roofH && roofH < h * 0.6 && /gabled|hipped|pyramid|dome|onion|spire|cone|mansard/.test(t["roof:shape"] || "")) h -= roofH; // OSM height is to the top of the roof
  if (!h) { const lv = parseFloat(t["building:levels"]); if (lv > 0 && lv < 120) h = lv * 3.3 + 1; }
  if (!h) {
    let d = DEFAULT_H[t.building] ?? DEFAULT_H[t["building:part"]];
    if (d == null) d = a < 60 ? 6 : a < 150 ? 12 : a < 400 ? 20 : a < 1500 ? 25 : 22; // untyped: bigger footprints tend to be taller
    h = d * (0.88 + hash(id) * 0.28);
  }
  return Math.round(Math.min(330, h) * 2) / 2;
}
function baseOf(t) { const m = parseLen(t.min_height) ?? parseLen(t["building:min_height"]); if (m) return m; const ml = parseFloat(t["building:min_level"]) || parseFloat(t.min_level); return ml > 0 ? ml * 3.3 : 0; }
// OSM colour names and hex codes → 0xRRGGBB, or -1
const NAMED = { white: 0xf2efe8, black: 0x2b2b2e, grey: 0x9a9a9a, gray: 0x9a9a9a, silver: 0xb9bcc2, red: 0xa8473a, brown: 0x7a5a42, maroon: 0x6d2f2a, beige: 0xd9cba8, cream: 0xefe5c9, tan: 0xc9ad84, yellow: 0xd8c27a, orange: 0xc9783c, green: 0x5f8a5a, darkgreen: 0x3f5f45, blue: 0x5f7fa6, lightblue: 0x9cc2d9, darkblue: 0x34496b, darkgrey: 0x5a5c60, darkgray: 0x5a5c60, lightgrey: 0xc7c7c7, lightgray: 0xc7c7c7, sandstone: 0xd8c8a0, copper: 0x6e9e8f };
function colourOf(v) { if (!v) return -1; v = String(v).toLowerCase().trim().replace(/[\s_-]/g, ""); if (/^#?[0-9a-f]{6}$/.test(v)) return parseInt(v.replace("#", ""), 16); if (/^#[0-9a-f]{3}$/.test(v)) return parseInt(v[1] + v[1] + v[2] + v[2] + v[3] + v[3], 16); return NAMED[v] ?? -1; }
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
  // Beirut palette: REDBRICK = ochre plaster, STOCKBRICK = sandstone, STUCCO = white/cream plaster
  if (["house", "terrace", "semidetached_house", "detached"].includes(b)) return pick(id, [M.REDBRICK, M.STOCKBRICK, M.STUCCO, M.STUCCO]);
  if (["apartments", "residential", "flats"].includes(b)) return h > 35 ? pick(id, [M.CONCRETE, M.STUCCO, M.GLASS]) : pick(id, [M.CONCRETE, M.STUCCO, M.STUCCO, M.STOCKBRICK, M.CONCRETE, M.REDBRICK]);
  if (h > 28) return pick(id, [M.CONCRETE, M.STUCCO, M.STONE, M.GLASS2]);
  return pick(id, [M.CONCRETE, M.STUCCO, M.STUCCO, M.STOCKBRICK, M.STONE, M.REDBRICK]);
}
// roof style: 0 flat, 1 pitched (drawn with a ridge), 2 dome, 3 pyramid / spire
function roofOf(t, h, cls) {
  const s = (t["roof:shape"] || "").toLowerCase();
  if (s === "dome" || s === "onion" || s === "half-dome") return 2;
  if (/pyramid|spire|cone|conical/.test(s)) return 3;
  if (/gabled|hipped|pitched|mansard|gambrel/.test(s)) return 1;
  if (s === "flat") return 0;
  // Beirut: flat roofs, except low traditional houses, which get red-tile pitched roofs
  if (["house", "terrace", "semidetached_house", "detached"].includes(t.building) && h < 14) return 1;
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
const chunkOf = (cx, cz) => { const k = cx + "_" + cz; let c = chunks.get(k); if (!c) { c = { cx, cz, b: [], r: [], t: [], s: null }; chunks.set(k, c); } return c; };
const water = [], green = [], names = [], outlines = [], parts = [], coastLines = [];
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
    if (t.natural === "coastline" && el.type === "way" && el.geometry) { coastLines.push(el.geometry.map((p) => [p.lat, p.lon])); continue; }
    const isClosed = el.type === "relation" || (el.geometry && el.geometry.length > 3 && el.geometry[0].lat === el.geometry[el.geometry.length - 1].lat && el.geometry[0].lon === el.geometry[el.geometry.length - 1].lon);

    const isPart = t["building:part"] && t["building:part"] !== "no";
    if (((t.building && t.building !== "no") || isPart) && isClosed && (el.type === "way" || /multipolygon|building/.test(t.type || "multipolygon"))) {
      if (t.location === "underground" || (parseFloat(t.layer) < 0 && !isPart) || t.building === "bridge" && !isPart && !t.height) continue;
      const inners = el.type === "relation" ? assembleRings(el.members, "inner") : [];
      for (const ring of rings) {
        let r = simplify(ring, 0.4); if (r.length < 3) continue;
        const a = area(r); if (Math.abs(a) < 5) continue;
        if (a < 0) r = r.reverse(); // consistent winding
        const [cx0, cz0] = centroid(r);
        if (cx0 < minX || cx0 > maxX || cz0 < minZ || cz0 > maxZ) continue;
        const holes = inners.map((h) => simplify(h, 0.4)).filter((h) => h.length >= 3 && Math.abs(area(h)) > 8 && inside(h[0][0], h[0][1], r));
        (isPart ? parts : outlines).push({ id: el.id, t, r, holes, a: Math.abs(a), c: [cx0, cz0], bb: bboxOf(r) });
        if (!isPart && t.name && (Math.abs(a) > 1500 || t.tourism || t.historic || t.amenity)) names.push([t.name, Math.round(cx0), Math.round(cz0)]);
      }
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

/* ---------- the sea (Beirut addition) ---------- */
// OpenStreetMap coastlines are lines with the land on the left and the sea on the right.
// Join them into one chain, clip it to a box a little bigger than the map, then close it
// clockwise around the box, which encloses the sea side.
function buildSea(lines) {
  if (!lines.length) return null;
  const key = (p) => p[0].toFixed(7) + "," + p[1].toFixed(7);
  const segs = lines.slice(); const chains = [];
  while (segs.length) {
    let cur = segs.shift(), grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (key(s[0]) === key(cur[cur.length - 1])) { cur = cur.concat(s.slice(1)); segs.splice(i, 1); grew = true; break; }
        if (key(s[s.length - 1]) === key(cur[0])) { cur = s.concat(cur.slice(1)); segs.splice(i, 1); grew = true; break; }
      }
    }
    chains.push(cur);
  }
  const MG = 1500, x0 = minX - MG, z0 = minZ - MG, x1 = maxX + MG, z1 = maxZ + MG, W = x1 - x0, H = z1 - z0, P = 2 * (W + H);
  const inE = ([x, z]) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
  const clamp = ([x, z]) => [Math.min(x1, Math.max(x0, x)), Math.min(z1, Math.max(z0, z))];
  // position along the box edge, clockwise from the north-west corner (x = east, z = south)
  const param = ([x, z]) => {
    const d = [z - z0, x1 - x, z1 - z, x - x0]; const e = d.indexOf(Math.min(...d));
    return e === 0 ? x - x0 : e === 1 ? W + (z - z0) : e === 2 ? W + H + (x1 - x) : 2 * W + H + (z1 - z);
  };
  const at = (t) => { t = ((t % P) + P) % P; return t < W ? [x0 + t, z0] : t < W + H ? [x1, z0 + t - W] : t < 2 * W + H ? [x1 - (t - W - H), z1] : [x0, z1 - (t - 2 * W - H)]; };
  let best = null, bestN = 0;
  for (const ch of chains) {
    const pts = ch.map(([lat, lon]) => proj(lat, lon));
    const i0 = pts.findIndex(inE); if (i0 < 0) continue;
    let i1 = pts.length - 1; while (!inE(pts[i1])) i1--;
    const sub = pts.slice(i0, i1 + 1);
    if (i0 > 0) sub.unshift(clamp(pts[i0 - 1]));
    if (i1 < pts.length - 1) sub.push(clamp(pts[i1 + 1]));
    if (sub.length > bestN) { best = sub; bestN = sub.length; }
  }
  if (!best) return null;
  const ts = param(best[0]), te = param(best[best.length - 1]);
  let dist = ts - te; if (dist <= 0) dist += P;
  const corners = [0, W, W + H, 2 * W + H].map((c) => { let d = c - te; if (d <= 0) d += P; return [c, d]; })
    .filter(([, d]) => d < dist).sort((a, b) => a[1] - b[1]).map(([c]) => at(c));
  const ring = best.concat([at(te)], corners, [at(ts)]);
  return simplify(ring, 2);
}
{
  const sea = buildSea(coastLines);
  if (sea) { const flat = []; for (const [x, z] of sea) flat.push(Math.round(x), Math.round(z)); water.push([1, ...bboxOf(sea).map(Math.round), ...flat]); console.log(`\nSea built from ${coastLines.length} coastline pieces (${sea.length} points)`); }
  else console.warn("\nNo coastline found: the sea will be drawn as land. Check that cache/raw/coast.json downloaded.");
}

/* ---------- buildings: outlines, 3D parts and landmark fixes ---------- */
// Grid index so "which building is at this point" is quick.
const GI = 100, grid = new Map();
for (const o of outlines) for (let gx = Math.floor(o.bb[0] / GI); gx <= Math.floor(o.bb[2] / GI); gx++) for (let gz = Math.floor(o.bb[1] / GI); gz <= Math.floor(o.bb[3] / GI); gz++) { const k = gx + "," + gz; let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(o); }
const outlineAt = (x, z) => { let best = null; for (const o of grid.get(Math.floor(x / GI) + "," + Math.floor(z / GI)) || []) if (x >= o.bb[0] && x <= o.bb[2] && z >= o.bb[1] && z <= o.bb[3] && inside(x, z, o.r) && (!best || o.a < best.a)) best = o; return best; };
// OSM's 3D convention: when a building is described by parts, the parts replace the outline.
for (const pt of parts) { const o = outlineAt(pt.c[0], pt.c[1]); if (o) { pt.parent = o; o.partArea = (o.partArea || 0) + pt.a; } }
const MATS = { stone: M.STONE, glass: M.GLASS, glass2: M.GLASS2, concrete: M.CONCRETE, redbrick: M.REDBRICK, stockbrick: M.STOCKBRICK, stucco: M.STUCCO, church: M.CHURCH };
const ROOFS = { flat: 0, gabled: 1, dome: 2, pyramid: 3 };
const circle = (x, z, r, n = 20) => [...Array(n).keys()].map((i) => [x + Math.cos((i / n) * 6.2832) * r, z + Math.sin((i / n) * 6.2832) * r]);
function emit(r, holes, p) {
  const [cx0, cz0] = centroid(r); const cx = Math.floor(cx0 / C), cz = Math.floor(cz0 / C), ox = cx * C, oz = cz * C;
  // [height×2, material, roof, base×2, wall colour, roof colour, roof height×2, points in outline, …outline, (points in hole, …hole)…]
  const rec = [Math.round(p.h * 2), p.cls, p.roof, Math.round((p.base || 0) * 2), p.wall ?? -1, p.rcol ?? -1, Math.round((p.roofH || 0) * 2), r.length];
  for (const [x, z] of r) rec.push(q(x - ox), q(z - oz));
  for (const h of holes || []) { rec.push(h.length); for (const [x, z] of h) rec.push(q(x - ox), q(z - oz)); }
  chunkOf(cx, cz).b.push(rec); nB++;
}
function propsOf(t, id, a, inherit) {
  const tt = inherit ? { ...Object.fromEntries(Object.entries(inherit).filter(([k]) => /material|colour|^building$/.test(k))), ...t } : t;
  const h = heightOf(tt, id, a), cls = materialOf(tt, h, id);
  let roof = roofOf(tt, h, cls); const rh = parseLen(tt["roof:height"]) ?? (parseFloat(tt["roof:levels"]) > 0 ? parseFloat(tt["roof:levels"]) * 2.6 : 0);
  let rcol = colourOf(tt["roof:colour"]); if (rcol < 0 && roof === 1 && cls !== M.CHURCH) rcol = 0xb5533c; // red tiles
  return { h, base: baseOf(tt), cls, roof, roofH: rh, wall: colourOf(tt["building:colour"] || tt.colour), rcol };
}
// Landmark fixes (Beirut): find each listed building by name or by point. Taller entries claim
// their building first, so a nearby shorter tower can't overwrite a taller one's height.
const fixes = new Map(), fixLog = [];
const nameOf = (o) => [o.t.name, o.t["name:en"], o.t["name:fr"]].filter(Boolean);
for (const L of [...OVERRIDES].sort((a, b) => b.h - a.h)) {
  let o = null;
  if (L.match) { const re = new RegExp(L.match, "i"); for (const c of outlines) if (!fixes.has(c) && nameOf(c).some((n) => re.test(n)) && (!o || c.a > o.a)) o = c; }
  else {
    const [x, z] = proj(...L.at); if (x < minX || x > maxX || z < minZ || z > maxZ) { fixLog.push(`  – ${L.name}: outside the map`); continue; }
    o = outlineAt(x, z); if (o && fixes.has(o)) o = null;
    if (!o) { let bd = 40; for (const c of outlines) { if (fixes.has(c) || c.a < 250) continue; const d = Math.hypot(c.c[0] - x, c.c[1] - z); if (d < bd) { bd = d; o = c; } } }
  }
  if (o) { fixes.set(o, L); fixLog.push(`  ✓ ${L.name}: ${L.h} m${o.partArea > o.a * 0.55 ? " (OSM has 3D parts, drawn from those)" : ""}`); }
  else fixLog.push(`  ✗ ${L.name}: no building found in OpenStreetMap`);
}
console.log(`\nPublished heights:\n${fixLog.join("\n")}`);
let nFix = 0, nAdd = 0;
for (const o of outlines) {
  const hasParts = o.partArea > o.a * 0.55;
  const L = fixes.get(o);
  if (hasParts) continue; // drawn by its parts below
  const p = propsOf(o.t, o.id, o.a);
  if (L) { // Beirut: published heights always win over OSM's tags
    p.h = L.h; p.base = 0; p.roof = L.roof ? ROOFS[L.roof] : 0; p.roofH = L.roofH || 0; p.rcol = colourOf(o.t["roof:colour"]);
    p.cls = L.mat ? MATS[L.mat] : materialOf(o.t, L.h, o.id); nFix++;
  }
  emit(o.r, o.holes, p);
  // extra pieces for landmarks OSM only has as a flat outline
  if (L && L.add && !o.partArea) for (const ad of L.add) {
    const pp = { h: ad.h, base: ad.base || 0, cls: MATS[ad.mat] ?? p.cls, roof: ROOFS[ad.roof] || 0, roofH: ad.roofH || 0 };
    if (ad.circle) { const [x, z] = proj(ad.circle[0], ad.circle[1]); emit(circle(x, z, ad.circle[2]), [], pp); nAdd++; }
    if (ad.corners != null) { // four round towers at the corners of the footprint's oriented box
      let best = 0, bl = 0; for (let i = 0; i < o.r.length; i++) { const j = (i + 1) % o.r.length, l = Math.hypot(o.r[j][0] - o.r[i][0], o.r[j][1] - o.r[i][1]); if (l > bl) { bl = l; best = i; } }
      const j = (best + 1) % o.r.length, ux = (o.r[j][0] - o.r[best][0]) / bl, uz = (o.r[j][1] - o.r[best][1]) / bl;
      let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9; for (const [x, z] of o.r) { const u = x * ux + z * uz, v = -x * uz + z * ux; a0 = Math.min(a0, u); a1 = Math.max(a1, u); b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
      const ia = (a1 - a0) * ad.corners, ib = (b1 - b0) * ad.corners;
      for (const [u, v] of [[a0 + ia, b0 + ib], [a1 - ia, b0 + ib], [a1 - ia, b1 - ib], [a0 + ia, b1 - ib]]) { emit(circle(u * ux - v * uz, u * uz + v * ux, ad.radius, 14), [], pp); nAdd++; }
    }
  }
}
for (const pt of parts) {
  const p = propsOf(pt.t, pt.id, pt.a, pt.parent && pt.parent.t);
  if (!parseLen(pt.t.height) && !pt.t["building:levels"] && pt.parent && tagged(pt.parent.t)) p.h = Math.max(p.base + 3, heightOf(pt.parent.t, pt.parent.id, pt.parent.a));
  if (p.base >= p.h) p.h = p.base + 2;
  emit(pt.r, pt.holes, p);
}
// Tower Bridge, the London Eye and the columns
const specials = [];
for (const S of SPECIALS) {
  if (S.type === "towerbridge") {
    const [nx, nz] = proj(...S.north), [sx, sz] = proj(...S.south); const dx = sx - nx, dz = sz - nz, l = Math.hypot(dx, dz), ux = dx / l, uz = dz / l;
    const sq = (x, z, s) => [[x - ux * s - uz * s, z - uz * s + ux * s], [x + ux * s - uz * s, z + uz * s + ux * s], [x + ux * s + uz * s, z + uz * s - ux * s], [x - ux * s + uz * s, z - uz * s - ux * s]];
    const tall = (x, z) => parts.concat(outlines).some((o) => Math.hypot(o.c[0] - x, o.c[1] - z) < 20 && heightOf(o.t, o.id, o.a) > 40);
    if (tall(nx, nz) || tall(sx, sz)) continue;
    for (const [x, z] of [[nx, nz], [sx, sz]]) { emit(sq(x, z, 8), [], { h: 52, cls: M.STONE, roof: 3, roofH: 13 }); for (const [cx, cz] of sq(x, z, 7.5)) emit(circle(cx, cz, 1.6, 8), [], { h: 58, base: 40, cls: M.STONE, roof: 3, roofH: 6 }); }
    for (const off of [-5.5, 5.5]) { const a0 = [nx + ux * 8 - uz * off, nz + uz * 8 + ux * off], b0 = [sx - ux * 8 - uz * off, sz - uz * 8 + ux * off], w = 1.6;
      emit([[a0[0] - uz * w, a0[1] + ux * w], [b0[0] - uz * w, b0[1] + ux * w], [b0[0] + uz * w, b0[1] - ux * w], [a0[0] + uz * w, a0[1] - ux * w]], [], { h: 46, base: 42, cls: M.STONE, roof: 0, wall: 0x5f86a8, rcol: 0x9fb8cc }); }
    nAdd += 12; continue;
  }
  const [x, z] = proj(...S.at); if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
  const cx = Math.floor(x / C), cz = Math.floor(z / C);
  const c = chunkOf(cx, cz); c.s = c.s || [];
  if (S.type === "wheel") c.s.push([1, q(x - cx * C), q(z - cz * C), S.diameter, S.hub, S.bearing]);
  if (S.type === "column") c.s.push([2, q(x - cx * C), q(z - cz * C), S.h, S.r]);
}
console.log(`${outlines.length} building outlines, ${parts.length} 3D parts, ${nFix} published heights applied, ${nAdd} landmark pieces added`);
console.log(`\n${nB} buildings, ${nR} roads/rails, ${water.length} water and ${green.length} green areas, ${nT} trees`);

/* ---------- write ---------- */
// Every chunk in the bounding box is listed, so open ground and the river still get drawn.
// Only chunks that contain something get a file; the third number says whether to fetch one.
const list = [];
for (let cx = Math.floor(minX / C); cx <= Math.floor(maxX / C); cx++) for (let cz = Math.floor(minZ / C); cz <= Math.floor(maxZ / C); cz++) {
  const c = chunks.get(cx + "_" + cz);
  if (c && (c.b.length || c.r.length || c.t.length || c.s)) {
    await writeFile(new URL(cx + "_" + cz + ".json", CHUNKS), JSON.stringify({ b: c.b, r: c.r, t: c.t, s: c.s || [] }));
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
