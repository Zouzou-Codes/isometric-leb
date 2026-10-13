// Turns the raw OpenStreetMap download into small map chunks the viewer can stream.
//
//   node scripts/build.mjs
//
// Reads  cache/raw/*.json
// Writes public/data/meta.json, names.json and chunks/<cx>_<cz>.json
//
// Each chunk holds:
//   b  buildings  [h2, minH2, material, roof, roofH2, wallRGB, roofRGB, flags, ringCount, n, x,z, x,z…, n, …]
//   g  ground     [class, x,z, x,z…]  (parks, landuse, water… clipped to the chunk)
//   r  lines      [kind, x,z, x,z…]   (roads, rails, canals; kind + 32 for bridges)
//   t  trees      [x,z, x,z…]
//   m  landmarks  [modelIndex, x, z, rotation×10]
// Coordinates are in half-metres relative to the chunk's north-west corner.

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

/* ---------- geometry helpers ---------- */
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
const ptKey = (p) => p.lat.toFixed(7) + "," + p.lon.toFixed(7);
// Join way fragments (lists of {lat,lon}) end to end into chains; closed chains are rings.
function joinWays(list) {
  const segs = list.map((g) => g.slice());
  const out = [];
  while (segs.length) {
    let cur = segs.shift(); let guard = 0;
    while (ptKey(cur[0]) !== ptKey(cur[cur.length - 1]) && guard++ < 20000) {
      const end = ptKey(cur[cur.length - 1]), start = ptKey(cur[0]); let found = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (ptKey(s[0]) === end) { cur = cur.concat(s.slice(1)); segs.splice(i, 1); found = true; break; }
        if (ptKey(s[s.length - 1]) === end) { cur = cur.concat(s.slice(0, -1).reverse()); segs.splice(i, 1); found = true; break; }
        if (ptKey(s[s.length - 1]) === start) { cur = s.slice(0, -1).concat(cur); segs.splice(i, 1); found = true; break; }
        if (ptKey(s[0]) === start) { cur = s.slice(1).reverse().concat(cur); segs.splice(i, 1); found = true; break; }
      }
      if (!found) break;
    }
    out.push(cur);
  }
  return out;
}
// Multipolygon relation → { outers: [ring], inners: [ring] } (rings in metres)
function relationRings(members) {
  const res = { outers: [], inners: [] };
  for (const role of ["outer", "inner"]) {
    const ways = members.filter((m) => m.type === "way" && m.geometry && (role === "outer" ? m.role === "outer" || m.role === "" : m.role === "inner")).map((m) => m.geometry);
    for (const ch of joinWays(ways)) if (ch.length > 3 && ptKey(ch[0]) === ptKey(ch[ch.length - 1])) (role === "outer" ? res.outers : res.inners).push(ringFrom(ch));
  }
  return res;
}
const bboxOf = (r) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const [x, z] of r) { if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z; } return [a, b, c, d]; };
const centroid = (r) => { let x = 0, z = 0; for (const p of r) { x += p[0]; z += p[1]; } return [x / r.length, z / r.length]; };
function inside(x, z, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; }
// Sutherland–Hodgman clip of a polygon against an axis-aligned rectangle.
function clipRect(poly, x0, z0, x1, z1) {
  let out = poly;
  const edges = [[(p) => p[0] >= x0, (a, b) => { const t = (x0 - a[0]) / (b[0] - a[0]); return [x0, a[1] + t * (b[1] - a[1])]; }],
                 [(p) => p[0] <= x1, (a, b) => { const t = (x1 - a[0]) / (b[0] - a[0]); return [x1, a[1] + t * (b[1] - a[1])]; }],
                 [(p) => p[1] >= z0, (a, b) => { const t = (z0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), z0]; }],
                 [(p) => p[1] <= z1, (a, b) => { const t = (z1 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), z1]; }]];
  for (const [ins, cut] of edges) {
    const inp = out; out = []; if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      const ci = ins(cur), pi = ins(prev);
      if (ci) { if (!pi) out.push(cut(prev, cur)); out.push(cur); } else if (pi) out.push(cut(prev, cur));
    }
  }
  return out;
}

/* ---------- colours, heights, materials ---------- */
const NAMED = { white: 0xf2efe8, black: 0x2b2b2b, grey: 0x9a9a98, gray: 0x9a9a98, darkgrey: 0x5f5f5f, lightgrey: 0xc8c6c0, silver: 0xbfc3c6, red: 0xa8473a, darkred: 0x7a3328, brown: 0x8a5c3c, beige: 0xd9c9a3, cream: 0xeee3c8, tan: 0xc9a77a, yellow: 0xdcc27a, orange: 0xc9783e, green: 0x5f8a5c, darkgreen: 0x3d5e3f, blue: 0x5a7fa6, lightblue: 0x9cbfd6, navy: 0x2f3f5c, pink: 0xd9a3a3, maroon: 0x6e2f2a, sandstone: 0xd6bf8f, terracotta: 0xb8714a, bronze: 0x8a6a3c, gold: 0xc9a43c, copper: 0x6f9a8a };
function colourOf(v) {
  if (!v) return -1; const s = String(v).trim().toLowerCase().replace(/[\s_]/g, "");
  const m = s.match(/^#?([0-9a-f]{6})$/); if (m) return parseInt(m[1], 16);
  const m3 = s.match(/^#([0-9a-f]{3})$/); if (m3) return parseInt(m3[1].split("").map((c) => c + c).join(""), 16);
  return NAMED[s] ?? -1;
}
function parseLen(v) {
  if (!v) return null; const s = String(v).trim();
  const ft = s.match(/^([\d.]+)\s*(ft|')/); if (ft) return parseFloat(ft[1]) * 0.3048;
  const n = parseFloat(s.replace(",", ".")); return Number.isFinite(n) && n >= 0 && n < 400 ? n : null;
}
const DEFAULT_H = { house: 9, detached: 9, semidetached_house: 9, terrace: 11, residential: 13, apartments: 17, flats: 17, commercial: 18, office: 22, retail: 8, supermarket: 7, church: 16, cathedral: 30, chapel: 9, mosque: 12, synagogue: 12, temple: 10, civic: 16, government: 18, public: 14, museum: 18, university: 18, college: 15, school: 12, hospital: 20, hotel: 24, train_station: 16, transportation: 10, industrial: 9, warehouse: 10, garage: 3, garages: 3, shed: 3, hut: 3, roof: 5, parking: 12, service: 5, kiosk: 3, stadium: 25, theatre: 18, construction: 10, bridge: 10, greenhouse: 4, boathouse: 5 };
// material classes the renderer understands
const M = { REDBRICK: 0, STOCKBRICK: 1, STONE: 2, STUCCO: 3, GLASS: 4, GLASS2: 5, CONCRETE: 6, SHED: 7, CHURCH: 8, GOTHIC: 9, TERRACOTTA: 10, BRUTAL: 11, METAL: 12 };
function heightOf(t, id) {
  let h = parseLen(t.height) ?? parseLen(t["building:height"]);
  if (!h) { const lv = parseFloat(t["building:levels"]); if (lv > 0 && lv < 120) h = lv * 3.3 + (parseFloat(t["roof:levels"]) || 0) * 2.6 + 1; }
  if (!h && t["building:part"]) h = 12;
  if (!h) h = (DEFAULT_H[t.building] ?? 11) * (0.85 + hash(id) * 0.35);
  return Math.min(330, h);
}
function minHeightOf(t) {
  let m = parseLen(t.min_height) ?? parseLen(t["building:min_height"]);
  if (m == null) { const lv = parseFloat(t["building:min_level"]); if (lv > 0) m = lv * 3.3; }
  return m || 0;
}
const NAME_MAT = [
  [/Palace of Westminster|Houses of Parliament|Portcullis House/i, "GOTHIC"],
  [/Barbican|Cromwell Tower|Shakespeare Tower|Lauderdale Tower|Trellick|Balfron|Brunswick Centre|National Theatre|Hayward Gallery|Queen Elizabeth Hall/i, "BRUTAL"],
  [/Natural History Museum|Victoria and Albert|V&A|Science Museum/i, "TERRACOTTA"]
];
function materialOf(t, h, id) {
  const name = t.name || "";
  for (const [re, m] of NAME_MAT) if (re.test(name)) return M[m];
  const mat = (t["building:material"] || t["building:facade:material"] || "").toLowerCase();
  const col = (t["building:colour"] || "").toLowerCase();
  if (/glass|mirror/.test(mat)) return h > 80 ? pick(id, [M.GLASS, M.GLASS2]) : M.GLASS;
  if (/metal|steel|alumin/.test(mat)) return M.METAL;
  if (/concrete/.test(mat)) return h > 25 ? M.BRUTAL : M.CONCRETE;
  if (/stone|sandstone|limestone/.test(mat)) return M.STONE;
  if (/brick/.test(mat)) return /yellow|brown|beige|tan/.test(col) ? M.STOCKBRICK : /red/.test(col) ? M.REDBRICK : pick(id, [M.REDBRICK, M.STOCKBRICK]);
  if (/plaster|render|stucco/.test(mat) || /white|cream/.test(col)) return M.STUCCO;
  const b = t.building || t["building:part"];
  if (["cathedral"].includes(b)) return M.GOTHIC;
  if (["church", "chapel", "mosque", "synagogue", "temple"].includes(b) || t.amenity === "place_of_worship") return M.CHURCH;
  if (["garage", "garages", "shed", "hut", "roof", "kiosk", "carport", "greenhouse"].includes(b) || h < 4.5) return M.SHED;
  if (["industrial", "warehouse", "service", "transportation", "construction"].includes(b)) return pick(id, [M.CONCRETE, M.METAL, M.STOCKBRICK]);
  if (["parking", "train_station"].includes(b)) return M.CONCRETE;
  if (h >= 60) return pick(id, [M.GLASS, M.GLASS, M.GLASS2, M.METAL]);
  if (["civic", "government", "public", "museum", "university", "college", "hospital", "theatre"].includes(b) || t.tourism === "museum") return h > 30 ? pick(id, [M.STONE, M.CONCRETE]) : M.STONE;
  if (["commercial", "office", "hotel"].includes(b)) return h > 40 ? pick(id, [M.GLASS, M.GLASS2, M.STONE]) : pick(id, [M.STONE, M.STOCKBRICK, M.STUCCO, M.GLASS, M.STONE]);
  if (["house", "terrace", "semidetached_house", "detached"].includes(b)) return pick(id, [M.REDBRICK, M.STOCKBRICK, M.STOCKBRICK, M.STUCCO]);
  if (["apartments", "residential", "flats"].includes(b)) return h > 35 ? pick(id, [M.CONCRETE, M.GLASS, M.STOCKBRICK, M.BRUTAL]) : pick(id, [M.REDBRICK, M.STOCKBRICK, M.STUCCO, M.STOCKBRICK]);
  if (h > 28) return pick(id, [M.STONE, M.CONCRETE, M.GLASS2]);
  return pick(id, [M.REDBRICK, M.STOCKBRICK, M.STOCKBRICK, M.STUCCO, M.STONE]);
}
// roof: 0 flat, 1 gabled, 2 dome, 3 hipped, 4 pyramidal, 5 skillion, 6 mansard, 7 onion, 8 round (barrel)
const ROOF = { flat: 0, gabled: 1, dome: 2, hipped: 3, pyramidal: 4, skillion: 5, mansard: 6, gambrel: 6, onion: 7, round: 8, half_hipped: 3, side_hipped: 3, cone: 4, saltbox: 1 };
function roofOf(t, h, cls, a, elong) {
  const s = (t["roof:shape"] || "").toLowerCase();
  if (s in ROOF) return ROOF[s];
  if (cls === M.CHURCH || cls === M.GOTHIC) return a < 3000 ? 1 : 0;
  if ((cls === M.REDBRICK || cls === M.STOCKBRICK || cls === M.STUCCO) && h < 17 && a < 900) return elong > 1.6 ? 1 : 3;
  if (cls === M.SHED && a < 400) return 1;
  return 0;
}

/* ---------- ground classes (shared with public/iso.js) ---------- */
const G = { PARK: 0, PITCH: 1, CEMETERY: 2, WOOD: 3, ALLOT: 4, GRASS: 5, RESID: 10, COMM: 11, INDUS: 12, RAIL: 13, CONSTR: 14, PARKING: 15, PAVED: 16, SAND: 17, CIVIC: 18, BROWN: 19, WATER: 30, LAND: 31, PIER: 40, BRIDGE: 41 };
function groundClass(t) {
  const n = t.natural, l = t.landuse, le = t.leisure, am = t.amenity, mm = t.man_made, ww = t.waterway;
  if (n === "water" || ["riverbank", "dock", "canal", "basin"].includes(ww) || l === "basin" || l === "reservoir" || am === "fountain") return G.WATER;
  if (mm === "pier" || mm === "jetty" || mm === "breakwater") return G.PIER;
  if (mm === "bridge") return G.BRIDGE;
  if (n === "wood" || l === "forest" || le === "nature_reserve") return G.WOOD;
  if (n === "scrub" || n === "heath" || n === "grassland") return G.GRASS;
  if (n === "beach" || n === "sand") return G.SAND;
  if (l === "cemetery" || am === "grave_yard") return G.CEMETERY;
  if (l === "allotments") return G.ALLOT;
  if (le === "pitch" || le === "track" || le === "stadium") return G.PITCH;
  if (le === "park" || le === "garden" || le === "common" || le === "golf_course" || le === "recreation_ground") return G.PARK;
  if (["grass", "village_green", "meadow", "recreation_ground", "flowerbed", "greenfield", "orchard", "plant_nursery"].includes(l)) return G.GRASS;
  if (le === "playground" || t.place === "square" || (t.highway === "pedestrian" && t.area === "yes")) return G.PAVED;
  if (am === "parking") return G.PARKING;
  if (["school", "university", "college", "hospital"].includes(am) || l === "education" || l === "religious" || l === "institutional") return G.CIVIC;
  if (l === "residential") return G.RESID;
  if (["commercial", "retail", "office"].includes(l)) return G.COMM;
  if (["industrial", "port", "depot", "garages", "military", "quarry", "landfill"].includes(l)) return G.INDUS;
  if (l === "railway") return G.RAIL;
  if (l === "construction") return G.CONSTR;
  if (l === "brownfield") return G.BROWN;
  return -1;
}
const ROAD = { motorway: 0, motorway_link: 1, trunk: 0, trunk_link: 1, primary: 1, primary_link: 2, secondary: 2, secondary_link: 2, tertiary: 2, tertiary_link: 3, residential: 3, unclassified: 3, living_street: 3, service: 4, pedestrian: 5 };
const RAIL = 7, LIGHTRAIL = 8, CANAL = 9, BRIDGE_FLAG = 32;

/* ---------- read everything ---------- */
const seen = new Set();
const buildings = [];      // {rings, h, minH, cls, roof, roofH, wall, roofc, part, name, cx, cz, area, id}
const grounds = [];        // {cls, ring}
const lines = [];          // {kind, pts}
const trees = [];          // [x,z]
const coast = [];          // geometry arrays of {lat,lon}
const names = [];
let nR = 0;
const files = (await readdir(RAW)).filter((f) => f.endsWith(".json"));
if (!files.length) { console.error("No raw data found. Run: node scripts/fetch.mjs (or node scripts/make-sample.mjs for a test area)"); process.exit(1); }
console.log(`Reading ${files.length} cells…`);

const inMap = (x, z, m = 0) => x >= minX - m && x <= maxX + m && z >= minZ - m && z <= maxZ + m;
function addBuilding(t, outers, inners, id) {
  for (let outer of outers) {
    outer = simplify(outer, 0.4); if (outer.length < 3) continue;
    let a = area(outer); if (Math.abs(a) < 5) continue;
    if (a < 0) { outer = outer.reverse(); a = -a; }
    const [cx, cz] = centroid(outer); if (!inMap(cx, cz)) continue;
    const holes = [];
    for (let r of inners) { r = simplify(r, 0.4); if (r.length < 3 || Math.abs(area(r)) < 8) continue; const [hx, hz] = centroid(r); if (!inside(hx, hz, outer)) continue; if (area(r) > 0) r = r.reverse(); holes.push(r); }
    // elongation from the oriented edge directions
    let best = 0, bl = 0; for (let i = 0; i < outer.length; i++) { const j = (i + 1) % outer.length; const l = Math.hypot(outer[j][0] - outer[i][0], outer[j][1] - outer[i][1]); if (l > bl) { bl = l; best = i; } }
    const j = (best + 1) % outer.length; const ux = (outer[j][0] - outer[best][0]) / bl, uz = (outer[j][1] - outer[best][1]) / bl;
    let s0 = 1e9, s1 = -1e9, w0 = 1e9, w1 = -1e9; for (const [x, z] of outer) { const s = x * ux + z * uz, w = -x * uz + z * ux; s0 = Math.min(s0, s); s1 = Math.max(s1, s); w0 = Math.min(w0, w); w1 = Math.max(w1, w); }
    const elong = (s1 - s0) / Math.max(1, w1 - w0);
    const h = heightOf(t, id); const minH = Math.min(minHeightOf(t), h - 0.5); const cls = materialOf(t, h, id);
    const roof = roofOf(t, h, cls, a, elong);
    let roofH = parseLen(t["roof:height"]);
    if (roofH == null) { const lv = parseFloat(t["roof:levels"]); roofH = lv > 0 ? lv * 2.6 : roof === 0 ? 0 : roof === 2 || roof === 7 ? Math.min(30, (w1 - w0) * 0.5) : roof === 6 ? 3 : Math.min(6, (w1 - w0) * 0.35); }
    roofH = Math.max(0, Math.min(roofH, (h - minH) * 0.8));
    buildings.push({ rings: [outer, ...holes], h, minH, cls, roof, roofH, wall: colourOf(t["building:colour"]), roofc: colourOf(t["roof:colour"]), part: !!t["building:part"] && !t.building, name: t.name || "", cx, cz, area: a, id, dead: false });
    if (t.name && !t["building:part"] && (a > 1500 || t.tourism || t.historic || t.amenity)) names.push([t.name, Math.round(cx), Math.round(cz)]);
  }
}

for (const f of files) {
  const data = JSON.parse(await readFile(new URL(f, RAW), "utf8"));
  for (const el of data.elements || []) {
    const uid = el.type[0] + el.id; if (seen.has(uid)) continue; seen.add(uid);
    const t = el.tags || {};
    if (el.type === "node") { if (t.natural === "tree") { const [x, z] = proj(el.lat, el.lon); if (inMap(x, z)) trees.push([x, z]); } continue; }
    if (t.natural === "coastline" && el.type === "way" && el.geometry) { coast.push(el.geometry); continue; }
    const closedWay = el.type === "way" && el.geometry && el.geometry.length > 3 && ptKey(el.geometry[0]) === ptKey(el.geometry[el.geometry.length - 1]);
    let outers = [], inners = [];
    if (closedWay) outers = [ringFrom(el.geometry)];
    else if (el.type === "relation" && el.members && (t.type === "multipolygon" || t.type === "building" || !t.type)) ({ outers, inners } = relationRings(el.members));

    const isBuilding = (t.building && t.building !== "no") || (t["building:part"] && t["building:part"] !== "no");
    if (isBuilding) {
      if (t.location === "underground" || parseFloat(t.layer) < 0) continue;
      if (outers.length) addBuilding(t, outers, inners, el.id);
      continue;
    }
    const gc = groundClass(t);
    if (gc >= 0 && outers.length) {
      const holes = inners.map((r) => simplify(r, 1)).filter((r) => r.length >= 3 && Math.abs(area(r)) > 40);
      for (let r of outers) {
        r = simplify(r, gc === G.WATER ? 1.5 : 1); if (r.length < 3 || Math.abs(area(r)) < 20) continue;
        const bb = bboxOf(r); if (bb[2] < minX - 500 || bb[0] > maxX + 500 || bb[3] < minZ - 500 || bb[1] > maxZ + 500) continue;
        const mine = holes.filter((h) => { const [hx, hz] = centroid(h); return inside(hx, hz, r); });
        grounds.push({ cls: gc, ring: r, holes: mine, bb, id: el.id });
        if (t.name && Math.abs(area(r)) > 8000 && gc < 30) { const [x, z] = centroid(r); names.push([t.name, Math.round(x), Math.round(z)]); }
      }
      continue;
    }
    if (el.type !== "way" || !el.geometry) continue;
    let kind = t.highway != null ? ROAD[t.highway] : t.railway === "rail" || t.railway === "narrow_gauge" ? RAIL : t.railway === "light_rail" || t.railway === "subway" ? LIGHTRAIL : t.waterway === "canal" ? CANAL : undefined;
    if (kind === undefined) continue;
    if (t.tunnel === "yes" || t.tunnel === "building_passage" || t.covered === "yes" || parseFloat(t.layer) < 0) continue;
    if (t.highway === "pedestrian" && t.area === "yes") continue;
    if (t.bridge && t.bridge !== "no") kind += BRIDGE_FLAG;
    lines.push({ kind, pts: simplify(el.geometry.map((p) => proj(p.lat, p.lon)), 0.8) }); nR++;
  }
  process.stdout.write(".");
}
console.log(`\n${buildings.length} buildings/parts, ${nR} lines, ${grounds.length} ground areas, ${trees.length} mapped trees, ${coast.length} coastline ways`);

/* ---------- the tidal Thames: water from coastline ---------- */
// OpenStreetMap maps the tidal Thames as coastline (land on the left of each way,
// water on the right). Join the ways, clip them to the map box, and walk the box
// edge clockwise to close each stretch of water.
function coastWater() {
  if (!coast.length) return [];
  const M_ = 0; const bx0 = minX - M_, bx1 = maxX + M_, by0 = -(maxZ + M_), by1 = -(minZ - M_); // y = north
  const Wb = bx1 - bx0, Hb = by1 - by0, PER = 2 * (Wb + Hb);
  const ins = (p) => p[0] > bx0 && p[0] < bx1 && p[1] > by0 && p[1] < by1;
  const tOf = (p) => { const [x, y] = p; const e = 1e-6;
    if (Math.abs(y - by1) < e) return x - bx0; if (Math.abs(x - bx1) < e) return Wb + (by1 - y);
    if (Math.abs(y - by0) < e) return Wb + Hb + (bx1 - x); return 2 * Wb + Hb + (y - by0); };
  const snap = (p) => { const d = [p[0] - bx0, bx1 - p[0], p[1] - by0, by1 - p[1]]; const k = d.indexOf(Math.min(...d)); return k === 0 ? [bx0, p[1]] : k === 1 ? [bx1, p[1]] : k === 2 ? [p[0], by0] : [p[0], by1]; };
  // segment–box boundary intersection (Liang–Barsky)
  function crossing(a, b) {
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - bx0], [dx, bx1 - a[0]], [-dy, a[1] - by0], [dy, by1 - a[1]]]) {
      if (p === 0) { if (q < 0) return null; continue; }
      const r = q / p; if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [t0, t1];
  }
  const chains = joinWays(coast).map((ch) => ch.map((p) => { const [x, z] = proj(p.lat, p.lon); return [x, -z]; }));
  const pieces = [], rings = [];
  for (const ch of chains) {
    const closed = ch.length > 3 && ch[0][0] === ch[ch.length - 1][0] && ch[0][1] === ch[ch.length - 1][1];
    if (closed && ch.every(ins)) { const r = ch.slice(0, -1); if (area(r) < 0) rings.push(r); /* clockwise = water inside */ continue; }
    let cur = null;
    for (let i = 0; i < ch.length; i++) {
      const p = ch[i], pin = ins(p);
      if (i === 0) { if (pin) cur = [snap(p), p]; continue; }
      const prev = ch[i - 1], prin = ins(prev);
      if (prin && pin) { cur.push(p); continue; }
      const c = crossing(prev, p); if (!c) continue;
      const [t0, t1] = c; const at = (t) => [prev[0] + (p[0] - prev[0]) * t, prev[1] + (p[1] - prev[1]) * t];
      if (prin && !pin) { cur.push(at(t1)); pieces.push(cur); cur = null; }
      else if (!prin && pin) { cur = [at(t0), p]; }
      else if (t0 < t1) pieces.push([at(t0), at(t1)]);
    }
    if (cur) { cur.push(snap(cur[cur.length - 1])); pieces.push(cur); }
  }
  for (const p of pieces) { p.tin = tOf(p[0]); p.tout = tOf(p[p.length - 1]); p.used = false; }
  const corners = [[0, [bx0, by1]], [Wb, [bx1, by1]], [Wb + Hb, [bx1, by0]], [2 * Wb + Hb, [bx0, by0]]];
  for (const start of pieces) {
    if (start.used) continue;
    const ring = []; let cur = start; let guard = 0;
    while (guard++ < 1000) {
      cur.used = true; ring.push(...cur);
      let best = null, bd = 1e18;
      for (const q of pieces) { if (q.used && q !== start) continue; let d = (q.tin - cur.tout + PER) % PER; if (d < 1e-9 && q !== start) d = 0; if (d < bd) { bd = d; best = q; } }
      if (!best) break;
      const passed = corners.map(([tc, pc]) => [(tc - cur.tout + PER) % PER, pc]).filter(([dc]) => dc > 0 && dc < bd).sort((a, b) => a[0] - b[0]);
      for (const [, pc] of passed) ring.push(pc);
      if (best === start) break;
      cur = best;
    }
    rings.push(ring);
  }
  return rings.map((r) => r.map(([x, y]) => [x, -y]));
}
const coastRings = coastWater();
for (const r0 of coastRings) { const r = simplify(r0, 1.5); if (r.length >= 3) grounds.push({ cls: G.WATER, ring: r, bb: bboxOf(r), id: -1, coast: true }); }
if (coastRings.length) console.log(`Built ${coastRings.length} water area(s) from ${coast.length} coastline ways`);

/* ---------- building parts replace their outline ---------- */
const GRID = 120; const parts = new Map();
for (const b of buildings) if (b.part) { const k = Math.floor(b.cx / GRID) + "," + Math.floor(b.cz / GRID); (parts.get(k) || parts.set(k, []).get(k)).push(b); }
let dropped = 0;
for (const b of buildings) {
  if (b.part) continue;
  const [x0, z0, x1, z1] = bboxOf(b.rings[0]); let cover = 0;
  for (let gx = Math.floor(x0 / GRID); gx <= Math.floor(x1 / GRID); gx++) for (let gz = Math.floor(z0 / GRID); gz <= Math.floor(z1 / GRID); gz++)
    for (const p of parts.get(gx + "," + gz) || []) if (inside(p.cx, p.cz, b.rings[0])) cover += p.area;
  if (cover > b.area * 0.45) { b.dead = true; dropped++; }
}
if (dropped) console.log(`${dropped} outlines replaced by their building parts`);

/* ---------- hand-modelled landmarks ---------- */
const placed = [];
const models = config.models || [];
for (const [mi, m] of models.entries()) {
  let [x, z] = proj(m.lat, m.lng); let rot = m.rot || 0;
  const re = m.match ? new RegExp(m.match, "i") : null; let hit = null;
  if (re) for (const b of buildings) { if (b.dead || !re.test(b.name)) continue; const d = Math.hypot(b.cx - x, b.cz - z); if (d < 450 && (!hit || b.area > hit.area)) hit = b; }
  if (hit) {
    [x, z] = [hit.cx, hit.cz];
    const r = hit.rings[0]; let bl = 0, ang = 0;
    for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; const l = Math.hypot(r[j][0] - r[i][0], r[j][1] - r[i][1]); if (l > bl) { bl = l; ang = Math.atan2(r[j][1] - r[i][1], r[j][0] - r[i][0]) * 180 / Math.PI; } }
    let best = rot, bd = 1e9; for (let k = -4; k <= 4; k++) { const cand = ang + k * 90; const d = Math.abs(cand - rot); if (d < bd) { bd = d; best = cand; } }
    if (bd < 25 && !/eye|o2|gherkin|albert|monument|nelson|bt_tower/.test(m.id)) rot = best;
  }
  const cl = m.clear || {}; const th = rot * Math.PI / 180, co = Math.cos(th), si = Math.sin(th);
  const within = (px, pz) => {
    const dx = px - x, dz = pz - z; const lx = dx * co + dz * si, lz = -dx * si + dz * co;
    if (cl.r) return Math.hypot(dx, dz) < cl.r;
    if (cl.w) return Math.abs(lx - (cl.dx || 0)) < cl.w / 2 && Math.abs(lz - (cl.dz || 0)) < cl.d / 2;
    return false;
  };
  let removed = 0;
  for (const b of buildings) if (!b.dead && (within(b.cx, b.cz) || (b === hit && !m.keep && (cl.r || cl.w)))) { b.dead = true; removed++; }
  placed.push({ mi, x, z, rot });
  console.log(`  model ${m.id}: ${hit ? "matched “" + hit.name + "”" : "placed by coordinates"}, cleared ${removed}`);
}

/* ---------- whale route along the Thames ---------- */
const waterRings = grounds.filter((g) => g.cls === G.WATER && Math.abs(area(g.ring)) > 20000).map((g) => g.ring);
const inWater = (x, z) => waterRings.some((r) => inside(x, z, r));
let route = (config.thames || []).map(([lat, lng]) => proj(lat, lng)).map(([x, z]) => {
  if (!waterRings.length || inWater(x, z)) return [x, z];
  for (let rad = 15; rad <= 450; rad += 15) for (let a = 0; a < 16; a++) { const px = x + Math.cos(a / 16 * Math.PI * 2) * rad, pz = z + Math.sin(a / 16 * Math.PI * 2) * rad; if (inWater(px, pz)) return [px, pz]; }
  return null;
}).filter(Boolean).map(([x, z]) => [Math.round(x), Math.round(z)]);

/* ---------- distribute into chunks ---------- */
const chunks = new Map();
const chunkOf = (cx, cz) => { const k = cx + "_" + cz; let c = chunks.get(k); if (!c) { c = { cx, cz, b: [], g: [], r: [], t: [], m: [] }; chunks.set(k, c); } return c; };
const q = (v) => Math.round(v * 2); // 0.5 m precision
const cxMin = Math.floor(minX / C), cxMax = Math.floor(maxX / C), czMin = Math.floor(minZ / C), czMax = Math.floor(maxZ / C);

let nB = 0;
for (const b of buildings) {
  if (b.dead) continue;
  const cx = Math.floor(b.cx / C), cz = Math.floor(b.cz / C); const ox = cx * C, oz = cz * C;
  const rec = [Math.round(b.h * 2), Math.round(b.minH * 2), b.cls, b.roof, Math.round(b.roofH * 2), b.wall, b.roofc, b.part ? 1 : 0, b.rings.length];
  for (const r of b.rings) { rec.push(r.length); for (const [x, z] of r) rec.push(q(x - ox), q(z - oz)); }
  chunkOf(cx, cz).b.push(rec); nB++;
}
// ground areas: clipped to each chunk they touch
const ORDER = [G.RESID, G.COMM, G.CIVIC, G.INDUS, G.RAIL, G.BROWN, G.CONSTR, G.SAND, G.PARKING, G.PAVED, G.GRASS, G.ALLOT, G.CEMETERY, G.PARK, G.PITCH, G.WOOD, G.WATER, G.PIER, G.BRIDGE];
grounds.sort((a, b) => ORDER.indexOf(a.cls) - ORDER.indexOf(b.cls) || Math.abs(area(b.ring)) - Math.abs(area(a.ring)));
let nT = trees.length;
for (const gr of grounds) {
  const [x0, z0, x1, z1] = gr.bb;
  for (let cx = Math.max(cxMin, Math.floor(x0 / C)); cx <= Math.min(cxMax, Math.floor(x1 / C)); cx++) for (let cz = Math.max(czMin, Math.floor(z0 / C)); cz <= Math.min(czMax, Math.floor(z1 / C)); cz++) {
    const ox = cx * C, oz = cz * C, e = 4;
    const whole = x0 >= ox && x1 <= ox + C && z0 >= oz && z1 <= oz + C;
    const clip = (r) => (whole ? r : clipRect(r, ox - e, oz - e, ox + C + e, oz + C + e));
    const outer = clip(gr.ring); if (outer.length < 3) continue;
    const hs = (gr.holes || []).map(clip).filter((r) => r.length >= 3);
    let rec;
    if (!hs.length) { rec = [gr.cls]; for (const [x, z] of outer) rec.push(q(x - ox), q(z - oz)); }
    else { rec = [gr.cls + 128]; for (const r of [outer, ...hs]) { rec.push(r.length); for (const [x, z] of r) rec.push(q(x - ox), q(z - oz)); } }
    chunkOf(cx, cz).g.push(rec);
  }
  // scatter trees through green areas on a jittered grid
  const dens = { [G.PARK]: [15, 0.5], [G.WOOD]: [8, 0.2], [G.CEMETERY]: [13, 0.35], [G.GRASS]: [22, 0.75], [G.CIVIC]: [30, 0.85], [G.RESID]: [34, 0.88] }[gr.cls];
  if (dens && Math.abs(area(gr.ring)) > 300) {
    const [step, skip] = dens;
    for (let x = x0; x < x1; x += step) for (let z = z0; z < z1; z += step) {
      const hx = hash(Math.round(x * 7 + z * 13 + gr.id)), hz = hash(Math.round(x * 11 + z * 5 + gr.id));
      if (hx < skip) continue;
      const px = x + hz * step * 0.8, pz = z + hash(Math.round(x * 3 + z * 17)) * step * 0.8;
      if (!inMap(px, pz) || !inside(px, pz, gr.ring)) continue;
      trees.push([px, pz]);
    }
  }
}
// trees that would stand inside a building are dropped later by the renderer's depth order; drop obvious ones here
const bGrid = new Map(); for (const b of buildings) if (!b.dead) { const k = Math.floor(b.cx / 60) + "," + Math.floor(b.cz / 60); (bGrid.get(k) || bGrid.set(k, []).get(k)).push(b); }
for (const [x, z] of trees) {
  let blocked = false;
  for (let gx = Math.floor(x / 60) - 1; gx <= Math.floor(x / 60) + 1 && !blocked; gx++) for (let gz = Math.floor(z / 60) - 1; gz <= Math.floor(z / 60) + 1 && !blocked; gz++)
    for (const b of bGrid.get(gx + "," + gz) || []) if (inside(x, z, b.rings[0])) { blocked = true; break; }
  if (blocked) continue;
  const cx = Math.floor(x / C), cz = Math.floor(z / C); chunkOf(cx, cz).t.push(q(x - cx * C), q(z - cz * C));
}
nT = trees.length;
for (const { kind, pts } of lines) {
  const bb = bboxOf(pts);
  for (let cx = Math.max(cxMin, Math.floor((bb[0] - 10) / C)); cx <= Math.min(cxMax, Math.floor((bb[2] + 10) / C)); cx++) for (let cz = Math.max(czMin, Math.floor((bb[1] - 10) / C)); cz <= Math.min(czMax, Math.floor((bb[3] + 10) / C)); cz++) {
    const ox = cx * C, oz = cz * C; const rec = [kind]; for (const [x, z] of pts) rec.push(q(x - ox), q(z - oz));
    chunkOf(cx, cz).r.push(rec);
  }
}
for (const p of placed) { const cx = Math.floor(p.x / C), cz = Math.floor(p.z / C); chunkOf(cx, cz).m.push([p.mi, q(p.x - cx * C), q(p.z - cz * C), Math.round(p.rot * 10)]); }
console.log(`${nB} buildings and ${nT} trees placed`);

/* ---------- write ---------- */
const list = [];
for (let cx = cxMin; cx <= cxMax; cx++) for (let cz = czMin; cz <= czMax; cz++) {
  const c = chunks.get(cx + "_" + cz);
  if (c && (c.b.length || c.r.length || c.t.length || c.g.length || c.m.length)) {
    await writeFile(new URL(cx + "_" + cz + ".json", CHUNKS), JSON.stringify({ b: c.b, g: c.g, r: c.r, t: c.t, m: c.m }));
    list.push([cx, cz, 1]);
  } else list.push([cx, cz, 0]);
}
const uniq = new Map(); for (const n of names) { const k = n[0].toLowerCase(); if (!uniq.has(k)) uniq.set(k, n); }
await writeFile(new URL("names.json", OUT), JSON.stringify([...uniq.values()]));
const landmarks = config.landmarks.map(([n, lat, lng]) => { const [x, z] = proj(lat, lng); return [n, Math.round(x), Math.round(z)]; });
const [sx, sz] = proj(config.start.lat, config.start.lng);
await writeFile(new URL("meta.json", OUT), JSON.stringify({
  name: config.name, lat0: LAT0, lng0: LNG0, mx: MX, my: MY, chunk: C,
  bounds: [Math.round(minX), Math.round(minZ), Math.round(maxX), Math.round(maxZ)],
  chunks: list, landmarks, models: models.map((m) => m.id), whale: route,
  start: { x: Math.round(sx), z: Math.round(sz), zoom: config.start.zoom, rotation: config.start.rotation },
  built: new Date().toISOString().slice(0, 10)
}));
console.log(`Wrote ${list.filter((c) => c[2]).length} of ${list.length} chunks and ${uniq.size} place names to public/data/`);
