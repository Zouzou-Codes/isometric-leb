// Generates a fake London in the same format the Overpass API returns, so you can test
// the build and the viewer without downloading anything.
//
//   node scripts/make-sample.mjs && node scripts/build.mjs
//
// The Thames follows its real course (as coastline, like OpenStreetMap), the streets are
// a made-up grid, and the hand-modelled landmarks are placed from config.json.
// The real map comes from scripts/fetch.mjs. Delete cache/raw/sample.json before building it.

import { readFile, writeFile, mkdir } from "node:fs/promises";
const config = JSON.parse(await readFile(new URL("../config.json", import.meta.url)));
const OUT = new URL("../cache/raw/", import.meta.url);
await mkdir(OUT, { recursive: true });

let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let nextId = 1;
const LAT0 = 51.5035, LNG0 = -0.12, MY = 110574, MX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x, z) => ({ lat: LAT0 - z / MY, lon: LNG0 + x / MX });
const xz = (lat, lng) => [(lng - LNG0) * MX, -(lat - LAT0) * MY];
const els = [];
const way = (pts, tags, close = true) => { const g = pts.map(([x, z]) => ll(x, z)); if (close) g.push(g[0]); const w = { type: "way", id: nextId++, tags, geometry: g }; els.push(w); return w; };

// The Thames as two coastline ways (water on the right-hand side of each)
const raw = config.thames.map(([la, ln]) => xz(la, ln));
const centre = [];
for (let i = 0; i < raw.length - 1; i++) for (let s = 0; s < 6; s++) { const t = s / 6; centre.push([raw[i][0] + (raw[i + 1][0] - raw[i][0]) * t, raw[i][1] + (raw[i + 1][1] - raw[i][1]) * t]); }
centre.push(raw[raw.length - 1]);
for (let k = 0; k < 3; k++) for (let i = 1; i < centre.length - 1; i++) centre[i] = [(centre[i - 1][0] + centre[i][0] * 2 + centre[i + 1][0]) / 4, (centre[i - 1][1] + centre[i][1] * 2 + centre[i + 1][1]) / 4];
const HALF = 115, north = [], southB = [];
for (let i = 0; i < centre.length; i++) {
  const a = centre[Math.max(0, i - 1)], b = centre[Math.min(centre.length - 1, i + 1)];
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); const nx = dz / L, nz = -dx / L; // left of travel (north side when heading east)
  north.push([centre[i][0] + nx * HALF, centre[i][1] + nz * HALF]); southB.push([centre[i][0] - nx * HALF, centre[i][1] - nz * HALF]);
}
// extend both ends well outside the map so the build can clip them
const ext = (arr, i0, i1) => { const [ax, az] = arr[i0], [bx, bz] = arr[i1]; const L = Math.hypot(ax - bx, az - bz); return [ax + (ax - bx) / L * 4000, az + (az - bz) / L * 4000]; };
north.unshift(ext(north, 0, 1)); north.push(ext(north, north.length - 1, north.length - 2));
southB.unshift(ext(southB, 0, 1)); southB.push(ext(southB, southB.length - 1, southB.length - 2));
// split into a few ways, as OSM does
const split = (arr, tags) => { for (let i = 0; i < arr.length - 1; i += 40) way(arr.slice(i, Math.min(arr.length, i + 41)), tags, false); };
split(north, { natural: "coastline" });
split(southB.slice().reverse(), { natural: "coastline" });
const riverDist = (x, z) => { let d = 1e9; for (const c of centre) { const v = Math.hypot(c[0] - x, c[1] - z); if (v < d) d = v; } return d; };

// Landmark sites (keep the grid clear around them)
const sites = config.models.map((m) => { const [x, z] = xz(m.lat, m.lng); const r = m.clear?.r || Math.max(m.clear?.w || 0, m.clear?.d || 0) / 2 || 20; return [x, z, r + 20]; });
const nearSite = (x, z) => sites.some(([sx, sz, r]) => Math.hypot(x - sx, z - sz) < r);

// A park with a lake (relation with a hole would be the lake; here a separate water way)
way([[-2050, -620], [-1350, -560], [-1300, -100], [-2100, -160]], { leisure: "park", name: "Sample Park" });
way([[-1850, -420], [-1550, -440], [-1500, -330], [-1820, -300]], { natural: "water", name: "Sample Lake" });

// Street grid with perimeter blocks
const step = 110, X0 = -2400, X1 = 2600, Z0 = -1500, Z1 = 1300;
// streets stop at the river bank
function street(a, b, tags) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(L / 10); let run = [];
  for (let i = 0; i <= n; i++) { const p = [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n];
    if (riverDist(p[0], p[1]) > HALF + 4) run.push(p); else { if (run.length > 1) way(run, tags, false); run = []; } }
  if (run.length > 1) way(run, tags, false);
}
for (let gx = X0; gx < X1; gx += step) street([gx, Z0], [gx + 20, Z1], { highway: (gx - X0) % 440 === 0 ? "primary" : "residential" });
for (let gz = Z0; gz < Z1; gz += step) street([X0, gz], [X1, gz + 15], { highway: (gz - Z0) % 330 === 0 ? "secondary" : "residential" });
street([X0, 600], [X1, 200], { railway: "rail" });
// two bridges across the river near Westminster
const [wbx, wbz] = xz(51.5008, -0.1218);
way([[wbx - 260, wbz + 10], [wbx + 260, wbz - 10]], { highway: "primary", bridge: "yes", name: "Westminster Bridge" }, false);
const [bfx, bfz] = xz(51.5097, -0.1045);
way([[bfx - 10, bfz - 260], [bfx + 10, bfz + 260]], { highway: "primary", bridge: "yes" }, false);

for (let gx = X0; gx < X1; gx += step) for (let gz = Z0; gz < Z1; gz += step) {
  const x0 = gx + 10, z0 = gz + 10, s = step - 22;
  if (riverDist(x0 + s / 2, z0 + s / 2) < HALF + 70) continue;
  if (x0 > -2100 && x0 < -1300 && z0 > -620 && z0 < -100) continue;
  if (nearSite(x0 + s / 2, z0 + s / 2)) continue;
  const r = rnd();
  if (r < 0.05) {
    const h = 60 + rnd() * 160;
    way([[x0 + 15, z0 + 15], [x0 + s - 15, z0 + 15], [x0 + s - 15, z0 + s - 15], [x0 + 15, z0 + s - 15]], { building: "office", height: String(Math.round(h)) });
    continue;
  }
  if (r < 0.08) { way([[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]], { amenity: "parking" }); continue; }
  if (r < 0.11) {
    // a mansion block with a courtyard, as a multipolygon relation
    const o = [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s], [x0, z0]].map(([x, z]) => ll(x, z));
    const i = [[x0 + 20, z0 + 20], [x0 + s - 20, z0 + 20], [x0 + s - 20, z0 + s - 20], [x0 + 20, z0 + s - 20], [x0 + 20, z0 + 20]].map(([x, z]) => ll(x, z));
    els.push({ type: "relation", id: nextId++, tags: { type: "multipolygon", building: "apartments", "building:levels": "7", "building:material": "brick", "building:colour": "red" }, members: [{ type: "way", role: "outer", geometry: o }, { type: "way", role: "inner", geometry: i }] });
    continue;
  }
  const depth = 14 + rnd() * 6, plot = 6 + rnd() * 3;
  const type = rnd() < 0.55 ? "terrace" : rnd() < 0.5 ? "apartments" : "commercial";
  const lv = type === "terrace" ? 3 : 4 + Math.floor(rnd() * 4);
  for (let x = x0; x + plot <= x0 + s; x += plot) { way([[x, z0], [x + plot, z0], [x + plot, z0 + depth], [x, z0 + depth]], { building: type, "building:levels": String(lv) }); way([[x, z0 + s - depth], [x + plot, z0 + s - depth], [x + plot, z0 + s], [x, z0 + s]], { building: type, "building:levels": String(lv) }); }
  for (let z = z0 + depth; z + plot <= z0 + s - depth; z += plot) { way([[x0, z], [x0 + depth, z], [x0 + depth, z + plot], [x0, z + plot]], { building: type, "building:levels": String(lv) }); way([[x0 + s - depth, z], [x0 + s, z], [x0 + s, z + plot], [x0 + s - depth, z + plot]], { building: type, "building:levels": String(lv) }); }
  for (let k = 0; k < 3; k++) { const p = ll(x0 + 20 + rnd() * (s - 40), z0 + 20 + rnd() * (s - 40)); els.push({ type: "node", id: nextId++, lat: p.lat, lon: p.lon, tags: { natural: "tree" } }); }
}
// a stepped tower made of building parts
const tp = [[400, -900], [440, -900], [440, -860], [400, -860]];
way(tp, { building: "office", height: "120", name: "Sample Stepped Tower" });
way(tp, { "building:part": "yes", height: "60" });
way([[410, -890], [430, -890], [430, -870], [410, -870]], { "building:part": "yes", min_height: "60", height: "120", "building:material": "glass" });
// a dock
way([[2000, -300], [2400, -300], [2400, -150], [2000, -150]], { natural: "water", water: "dock" });
way([[2050, -340], [2350, -340], [2350, -320], [2050, -320]], { man_made: "pier" });

await writeFile(new URL("sample.json", OUT), JSON.stringify({ elements: els }));
console.log(`Wrote ${els.length} sample features to cache/raw/sample.json`);
