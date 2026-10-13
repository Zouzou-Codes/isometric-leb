// Generates a small fake neighbourhood in the same format the Overpass API returns,
// so you can test the build and the viewer without downloading anything.
//
//   node scripts/make-sample.mjs && node scripts/build.mjs
//
// The real map comes from scripts/fetch.mjs. Delete cache/raw/sample.json before building it.

import { writeFile, mkdir } from "node:fs/promises";
const OUT = new URL("../cache/raw/", import.meta.url);
await mkdir(OUT, { recursive: true });

let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let nextId = 1;
const LAT0 = 51.5035, LNG0 = -0.12, MY = 110574, MX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x, z) => ({ lat: LAT0 - z / MY, lon: LNG0 + x / MX });
const els = [];
const way = (pts, tags, close = true) => { const g = pts.map(([x, z]) => ll(x, z)); if (close) g.push(g[0]); const w = { type: "way", id: nextId++, tags, geometry: g }; els.push(w); return w; };

// River: a bending band, delivered as a relation of two outer ways (like the real Thames)
const centre = []; for (let i = 0; i <= 40; i++) { const t = i / 40; centre.push([-900 + t * 1900, 700 - t * 1300 + Math.sin(t * 3.2) * 160]); }
const W = 120, left = [], right = [];
for (let i = 0; i < centre.length; i++) {
  const a = centre[Math.max(0, i - 1)], b = centre[Math.min(centre.length - 1, i + 1)];
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); const nx = -dz / L, nz = dx / L;
  left.push([centre[i][0] + nx * W, centre[i][1] + nz * W]); right.push([centre[i][0] - nx * W, centre[i][1] - nz * W]);
}
const half1 = left.concat([right[right.length - 1]]), half2 = right.slice().reverse().concat([left[0]]);
const riverArea = ({ type: "relation", id: nextId++, tags: { natural: "water", water: "river", name: "River Thames" }, members: [
  { type: "way", role: "outer", geometry: half1.map(([x, z]) => ll(x, z)) },
  { type: "way", role: "outer", geometry: half2.reverse().map(([x, z]) => ll(x, z)) }
] });
const riverDist = (x, z) => { let d = 1e9; for (const c of centre) d = Math.min(d, Math.hypot(c[0] - x, c[1] - z)); return d; };

// The river's centreline, as OpenStreetMap maps it (waterway=river)
els.push({ type: "way", id: nextId++, tags: { waterway: "river", name: "River Thames" }, geometry: centre.map(([x, z]) => ll(x, z)) });

// Park with a name
way([[-850, -650], [-450, -620], [-430, -380], [-860, -400]], { leisure: "park", name: "Sample Park" });

// Street grid + perimeter blocks of terraces
const step = 110;
for (let gx = -1000; gx < 1000; gx += step) {
  way([[gx, -800], [gx + 20, 800]], { highway: gx % 440 === 0 ? "primary" : "residential" }, false);
}
for (let gz = -800; gz < 800; gz += step) way([[-1000, gz], [1000, gz + 15]], { highway: gz % 330 === 0 ? "secondary" : "residential" }, false);
way([[-1000, 300], [1000, -100]], { railway: "rail" }, false);

for (let gx = -1000; gx < 1000; gx += step) for (let gz = -800; gz < 800; gz += step) {
  const x0 = gx + 10, z0 = gz + 10, s = step - 22;
  if (riverDist(x0 + s / 2, z0 + s / 2) < W + 70) continue;
  if (x0 > -880 && x0 < -420 && z0 > -680 && z0 < -360) continue;
  const tall = rnd() < 0.06;
  if (tall) {
    const h = 60 + rnd() * 180;
    way([[x0 + 15, z0 + 15], [x0 + s - 15, z0 + 15], [x0 + s - 15, z0 + s - 15], [x0 + 15, z0 + s - 15]], { building: "office", height: String(Math.round(h)) });
    continue;
  }
  // terraces along all four edges
  const depth = 14 + rnd() * 6, plot = 7 + rnd() * 4;
  const type = rnd() < 0.5 ? "terrace" : rnd() < 0.5 ? "apartments" : "commercial";
  for (let x = x0; x + plot <= x0 + s; x += plot) { way([[x, z0], [x + plot, z0], [x + plot, z0 + depth], [x, z0 + depth]], { building: type }); way([[x, z0 + s - depth], [x + plot, z0 + s - depth], [x + plot, z0 + s], [x, z0 + s]], { building: type }); }
  for (let z = z0 + depth; z + plot <= z0 + s - depth; z += plot) { way([[x0, z], [x0 + depth, z], [x0 + depth, z + plot], [x0, z + plot]], { building: type }); way([[x0 + s - depth, z], [x0 + s, z], [x0 + s, z + plot], [x0 + s - depth, z + plot]], { building: type }); }
}
// A clock tower and a dome
way([[300, 200], [312, 200], [312, 212], [300, 212]], { building: "yes", height: "96", name: "Sample Clock Tower", tourism: "attraction", "building:material": "stone" });
way([[-200, -200], [-150, -205], [-145, -150], [-195, -145]], { building: "cathedral", name: "Sample Cathedral", "roof:shape": "dome", height: "45" });

// 3D detail, as OpenStreetMap maps it: a domed church described by building:parts, a courtyard
// block mapped as a multipolygon, a coloured building, and a tower at Big Ben's real position
// with no height in OSM (the landmark table fills it in).
const circ = (cx, cz, r, n = 18) => [...Array(n).keys()].map((i) => [cx + Math.cos((i / n) * 6.283) * r, cz + Math.sin((i / n) * 6.283) * r]);
const sq = (x, z, w, d) => [[x, z], [x + w, z], [x + w, z + d], [x, z + d]];
way(sq(-640, 120, 60, 40), { building: "church", name: "Sample Domed Church" });
way(sq(-640, 120, 60, 40), { "building:part": "yes", height: "24", "roof:shape": "gabled", "roof:height": "6" });
way(circ(-610, 140, 13), { "building:part": "yes", min_height: "24", height: "48", "building:colour": "#e8dec5" });
way(circ(-610, 140, 11), { "building:part": "yes", min_height: "48", height: "50", "roof:shape": "dome", "roof:height": "14", "roof:colour": "#6e8a83" });
const ring = (pts) => pts.concat([pts[0]]).map(([x, z]) => ll(x, z));
els.push({ type: "relation", id: nextId++, tags: { type: "multipolygon", building: "museum", name: "Sample Courtyard Museum", height: "26" }, members: [
  { type: "way", role: "outer", geometry: ring(sq(-560, 200, 110, 90)) }, { type: "way", role: "inner", geometry: ring(sq(-530, 225, 50, 40)) }] });
way(sq(-420, 160, 30, 18), { building: "commercial", height: "30", "building:colour": "#c9783c", "roof:colour": "#3a3f45" });
const bb = [(-0.12463 - LNG0) * MX, (LAT0 - 51.50073) * MY]; way(sq(bb[0] - 6, bb[1] - 6, 12, 12), { building: "yes", name: "Elizabeth Tower" });
await writeFile(new URL("sample.json", OUT), JSON.stringify({ elements: els }));
console.log(`Wrote ${els.length} sample features to cache/raw/sample.json`);
