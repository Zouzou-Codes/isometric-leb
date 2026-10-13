// Isometric London — a pixel-art city renderer drawn entirely with the Canvas 2D API.
//
// How it works
//  1. The city is split into 500 m chunks (built by scripts/build.mjs).
//  2. Each visible chunk is painted once into two off-screen bitmaps: the ground
//     (pavement, parks, water, roads) and the objects (buildings and trees).
//  3. Bitmaps are cached per level of detail, rotation and day/night, so panning
//     only copies pixels. Zooming out swaps to half-, quarter-… resolution bitmaps.
//  4. Buildings are extruded footprints. Walls facing the viewer are shaded by
//     direction, windows are drawn per floor, and objects are depth-sorted
//     (painter's algorithm) within each chunk.
"use strict";
(async function () {
  const $ = (s) => document.querySelector(s);
  const canvas = $("#map"), ctx = canvas.getContext("2d");
  const HF = 1.0;                 // screen pixels per metre of height (relative to ground scale)
  const MAX_CACHE_PX = 70e6;      // ~280 MB of bitmaps at most
  const ZMIN = 1 / 48, ZMAX = 4;

  /* ---------- palettes ---------- */
  // per material: [lit wall, shaded wall, roof, roof edge, window]
  const DAY = {
    mat: [
      ["#b95b40", "#8b3f2d", "#6d707a", "#4b4d56", "#5b3a33"], // red brick
      ["#cda86c", "#9e7d4b", "#6d707a", "#4b4d56", "#6a5537"], // London stock brick
      ["#e8dec5", "#b9ad92", "#d2c9b2", "#8f866f", "#8a8577"], // Portland stone
      ["#f4f0e5", "#c9c3b3", "#9aa0a7", "#6a7076", "#8d949a"], // stucco
      ["#86b8d4", "#4f7f9e", "#bccad2", "#5a6d78", "#c9e6f5"], // glass
      ["#679297", "#3c5f66", "#9fb2b4", "#44575a", "#a5d0d2"], // dark glass
      ["#bab6ad", "#8b877e", "#a39f95", "#6e6a62", "#6f6b63"], // concrete
      ["#a69e8f", "#7f786b", "#8f887a", "#5e584e", "#6f685d"], // shed
      ["#ded4bc", "#ada38b", "#6e8a83", "#4b5654", "#7d7462"]  // church (verdigris roof)
    ],
    ground: "#d3ccbd", outside: "#a9c3c9",
    green: ["#8fbf6a", "#a3d07c", "#7aa65e", "#5f8f4a", "#a7ba6d"],
    water: "#5ea6c6", waterEdge: "#8ccae0",
    road: ["#878a91", "#93969c", "#a2a4a8", "#adafb2", "#bdbebf", "#e3dccb", "#ebe5d6", "#7a6a5a", "#857868"],
    tree: ["#4d8a3b", "#6fae52", "#6b4a2f"], lamp: null, lit: null
  };
  const NIGHT = {
    mat: DAY.mat.map(([a, b, r, e]) => [shade(a, 0.32), shade(b, 0.22), shade(r, 0.28), shade(e, 0.2), "#14182a"]),
    ground: "#232838", outside: "#0e1424",
    green: ["#1f3b2c", "#24432f", "#1b3326", "#162d21", "#24402a"],
    water: "#14304b", waterEdge: "#22476b",
    road: ["#2f3446", "#323749", "#34394b", "#373c4d", "#3a3f50", "#3b3f4c", "#3d414d", "#2a2522", "#2e2926"],
    tree: ["#163223", "#21452f", "#1c1612"], lamp: "#f2b45a", lit: ["#ffd27a", "#ffe9b0", "#f7b955", "#cfe8ff"]
  };
  function shade(hex, k) { const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; const m = (v, t) => Math.round(v * k + t * (1 - k) * 0.35); return `rgb(${m(r, 18)},${m(g, 24)},${m(b, 52)})`; }
  const ROAD_W = [16, 12, 10, 7, 4, 8, 2, 3, 3];
  const ROAD_ORDER = [6, 4, 5, 3, 2, 1, 0, 8, 7];

  /* ---------- data ---------- */
  let meta, ground, places;
  try {
    meta = await (await fetch("data/meta.json")).json();
  } catch (e) {
    const el = $("#err"); el.hidden = false;
    el.firstElementChild.innerHTML = location.protocol === "file:"
      ? "<b>Open this page through a local web server.</b><br>Browsers block loading the map data from a file. In the project folder run <code>npx serve public</code> or <code>python3 -m http.server -d public</code>, then open the address it prints."
      : "<b>No map data yet.</b><br>Run <code>node scripts/fetch.mjs</code> then <code>node scripts/build.mjs</code>, or the GitHub Action, to build <code>public/data/</code>.";
    return;
  }
  const C = meta.chunk;
  $("#built").textContent = meta.built;
  ground = await (await fetch("data/ground.json")).json();
  places = await (await fetch("data/names.json")).json().catch(() => []);
  const groundPolys = [];
  for (const [arr, isWater] of [[ground.green, false], [ground.water, true]]) for (const g of arr) groundPolys.push({ water: isWater, cls: g[0], bb: [g[1], g[2], g[3], g[4]], pts: g.slice(5) });
  groundPolys.sort((a, b) => a.water - b.water); // water on top of parks

  const chunks = meta.chunks.map(([cx, cz, has]) => ({ cx, cz, key: cx + "_" + cz, data: has ? null : { b: [], r: [], t: [] }, loading: false, maxH: has ? 60 : 4 }));

  /* ---------- camera ---------- */
  const cam = { x: meta.start.x, z: meta.start.z, zoom: meta.start.zoom, rot: meta.start.rotation };
  let night = false, W = 0, H = 0, DPR = 1;
  const P = () => (night ? NIGHT : DAY);
  const rotXZ = (x, z, r = cam.rot) => (r === 0 ? [x, z] : r === 1 ? [-z, x] : r === 2 ? [-x, -z] : [z, -x]);
  const unrotXZ = (x, z, r = cam.rot) => (r === 0 ? [x, z] : r === 1 ? [z, -x] : r === 2 ? [-x, -z] : [-z, x]);
  const iso = (x, z) => { const [rx, rz] = rotXZ(x, z); return [rx - rz, (rx + rz) / 2]; };
  function isoToWorld(ix, iy) { const rx = iy + ix / 2, rz = iy - ix / 2; return unrotXZ(rx, rz); }
  function toScreen(ix, iy) { const [cx, cy] = iso(cam.x, cam.z); return [(ix - cx) * cam.zoom + W / 2, (iy - cy) * cam.zoom + H / 2]; }
  function screenToWorld(sx, sy) { const [cx, cy] = iso(cam.x, cam.z); return isoToWorld((sx - W / 2) / cam.zoom + cx, (sy - H / 2) / cam.zoom + cy); }

  /* ---------- chunk bounds in iso space ---------- */
  function chunkIsoBounds(c, pad = 40) {
    let a = 1e9, b = 1e9, d = -1e9, e = -1e9;
    for (const [x, z] of [[c.cx * C - pad, c.cz * C - pad], [(c.cx + 1) * C + pad, c.cz * C - pad], [(c.cx + 1) * C + pad, (c.cz + 1) * C + pad], [c.cx * C - pad, (c.cz + 1) * C + pad]]) {
      const [ix, iy] = iso(x, z); if (ix < a) a = ix; if (iy < b) b = iy; if (ix > d) d = ix; if (iy > e) e = iy;
    }
    return [a, b - c.maxH * HF - 4, d, e];
  }
  const chunkDepth = (c) => { const [rx, rz] = rotXZ((c.cx + 0.5) * C, (c.cz + 0.5) * C); return rx + rz; };

  async function load(c) {
    if (c.data || c.loading) return; c.loading = true;
    try {
      const d = await (await fetch(`data/chunks/${c.key}.json`)).json();
      let m = 10; for (const b of d.b) { const top = b[0] / 2 + (b[6] || 0) / 2; if (top > m) m = top; } for (const s of d.s || []) m = Math.max(m, s[0] === 1 ? s[4] + s[3] / 2 : s[3] + 4); c.maxH = m + 8; d.s = d.s || []; c.data = d;
    } catch { c.data = { b: [], r: [], t: [] }; }
    c.loading = false; dirty = true;
  }

  /* ---------- bitmap cache ---------- */
  const cache = new Map(); let cachePx = 0;
  const cacheKey = (c, layer, L) => `${c.key}|${layer}|${L}|${cam.rot}|${night ? 1 : 0}`;
  function cacheGet(k) { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); } return v; }
  function cachePut(k, v) {
    cache.set(k, v); cachePx += v.cv.width * v.cv.height;
    for (const [kk, vv] of cache) { if (cachePx <= MAX_CACHE_PX) break; cache.delete(kk); cachePx -= vv.cv.width * vv.cv.height; }
  }

  function makeBitmap(c, layer, L) {
    const b = 2 ** -L; const [a, top, d, e] = layer === "o" ? chunkIsoBounds(c, 70) : chunkIsoBounds(c, 2);
    const w = Math.max(1, Math.ceil((d - a) * b)), h = Math.max(1, Math.ceil((e - top) * b));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const g = cv.getContext("2d");
    const T = (x, z, hgt = 0) => { const [ix, iy] = iso(x, z); return [(ix - a) * b, (iy - hgt * HF - top) * b]; };
    if (layer === "g") drawGround(g, c, T, b); else if (layer[0] === "w") drawWaves(g, c, T, b, +layer[1]); else drawObjects(g, c, T, b, L);
    return { cv, a, top, b };
  }

  /* ---------- ground layer ---------- */
  function drawGround(g, c, T, b) {
    const pal = P(); const x0 = c.cx * C, z0 = c.cz * C;
    const e = 1.5; // overlap neighbours slightly so no seams show between chunks
    g.beginPath(); [[x0 - e, z0 - e], [x0 + C + e, z0 - e], [x0 + C + e, z0 + C + e], [x0 - e, z0 + C + e]].forEach(([x, z], i) => { const [sx, sy] = T(x, z); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
    g.closePath(); g.fillStyle = pal.ground; g.fill(); g.clip();
    for (const p of groundPolys) {
      if (p.bb[2] < x0 || p.bb[0] > x0 + C || p.bb[3] < z0 || p.bb[1] > z0 + C) continue;
      g.beginPath();
      for (let i = 0; i < p.pts.length; i += 2) { const [sx, sy] = T(p.pts[i], p.pts[i + 1]); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); }
      g.closePath();
      if (p.water) { g.fillStyle = pal.water; g.fill(); g.strokeStyle = pal.waterEdge; g.lineWidth = Math.max(1, 3 * b); g.stroke(); }
      else { g.fillStyle = pal.green[p.cls] || pal.green[0]; g.fill(); }
    }
    const roads = c.data ? c.data.r : [];
    g.lineJoin = "round"; g.lineCap = "butt";
    for (const kind of ROAD_ORDER) {
      for (const r of roads) {
        if (r[0] !== kind) continue;
        g.beginPath();
        for (let i = 1; i < r.length; i += 2) { const [sx, sy] = T(x0 + r[i] / 2, z0 + r[i + 1] / 2); i > 1 ? g.lineTo(sx, sy) : g.moveTo(sx, sy); }
        g.strokeStyle = pal.road[kind]; g.lineWidth = Math.max(kind === 6 ? 0.6 : 1, ROAD_W[kind] * b); g.setLineDash([]); g.stroke();
        if (kind >= 7 && b >= 0.5) { g.strokeStyle = night ? "#4a4038" : "#a8977f"; g.lineWidth = Math.max(1, 1 * b); g.setLineDash([2 * b, 3 * b]); g.stroke(); g.setLineDash([]); }
        if (night && kind <= 2) { g.strokeStyle = pal.lamp; g.globalAlpha = 0.55; g.lineWidth = Math.max(1, 1.2 * b); g.setLineDash([1.5 * b, 9 * b]); g.stroke(); g.setLineDash([]); g.globalAlpha = 1; }
      }
    }
  }

  /* ---------- the Thames: animated water ----------
     Four pre-drawn frames per riverside chunk, cycled a few times a second like pixel-art sprites:
     wave crests that drift downstream and twinkle, and foam that crawls along the banks. */
  const waterPolys = groundPolys.filter((p) => p.water);
  const hasWater = (c) => c.hw ?? (c.hw = waterPolys.some((p) => !(p.bb[2] < c.cx * C || p.bb[0] > (c.cx + 1) * C || p.bb[3] < c.cz * C || p.bb[1] > (c.cz + 1) * C)));
  function drawWaves(g, c, T, b, f) {
    const x0 = c.cx * C, z0 = c.cz * C;
    g.beginPath(); [[x0, z0], [x0 + C, z0], [x0 + C, z0 + C], [x0, z0 + C]].forEach(([x, z], i) => { const [sx, sy] = T(x, z); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); }); g.closePath(); g.clip();
    const mine = waterPolys.filter((p) => !(p.bb[2] < x0 || p.bb[0] > x0 + C || p.bb[3] < z0 || p.bb[1] > z0 + C));
    const path = new Path2D();
    for (const p of mine) { for (let i = 0; i < p.pts.length; i += 2) { const [sx, sy] = T(p.pts[i], p.pts[i + 1]); i ? path.lineTo(sx, sy) : path.moveTo(sx, sy); } path.closePath(); }
    // foam along the banks
    g.save(); g.lineWidth = Math.max(1, 2.2 * b); g.setLineDash([3 * b, 5 * b]); g.lineDashOffset = -f * 2 * b; g.strokeStyle = night ? "rgba(140,170,210,.35)" : "rgba(235,248,255,.85)"; g.stroke(path); g.restore();
    g.clip(path);
    const step = 13, lw = Math.max(1, 1.3 * b);
    for (let x = x0; x < x0 + C; x += step) for (let z = z0; z < z0 + C; z += step) {
      const h1 = hash((x * 73 + z * 19) | 0), h2 = hash((x * 31 + z * 97 + 7) | 0); const ph = (h1 + f / 4) % 1;
      if (ph > 0.42) continue;
      const wx = x + h2 * step + f * 1.6, wz = z + h1 * step; const [sx, sy] = T(wx, wz); const len = (4 + h2 * 6) * b;
      g.fillStyle = night ? (h2 < 0.12 ? "rgba(255,200,120,.75)" : "rgba(120,160,210,.45)") : ph < 0.22 ? "#d6f0fb" : "#3f86a8";
      g.fillRect(Math.round(sx), Math.round(sy), Math.max(1, Math.round(len)), Math.max(1, Math.round(lw)));
    }
  }
  let waterFrame = 0, waterOnScreen = false;
  setInterval(() => { if (waterOnScreen) { waterFrame = (waterFrame + 1) % 4; dirty = true; } }, 240);

  /* ---------- the whale ----------
     In January 2006 a northern bottlenose whale swam up the Thames into central London.
     This one patrols the river: it surfaces, blows, dives and comes up again further along. */
  const whale = (() => {
    const rings = waterPolys.filter((p) => p.cls === 1 || Math.hypot(p.bb[2] - p.bb[0], p.bb[3] - p.bb[1]) > 2500); // the Thames (widened centreline or big water areas)
    if (!rings.length) return null;
    const inside = (x, z) => rings.some((p) => { if (x < p.bb[0] || x > p.bb[2] || z < p.bb[1] || z > p.bb[3]) return false; let c = false; const q = p.pts; for (let i = 0, j = q.length - 2; i < q.length; j = i, i += 2) { const xi = q[i], zi = q[i + 1], xj = q[j], zj = q[j + 1]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; });
    let bb = [1e9, 1e9, -1e9, -1e9]; for (const p of rings) bb = [Math.min(bb[0], p.bb[0]), Math.min(bb[1], p.bb[1]), Math.max(bb[2], p.bb[2]), Math.max(bb[3], p.bb[3])];
    const pts = []; let seed = 99; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let tries = 0; tries < 30000 && pts.length < 1400; tries++) { const x = bb[0] + rnd() * (bb[2] - bb[0]), z = bb[1] + rnd() * (bb[3] - bb[1]); if (inside(x, z)) pts.push([x, z]); }
    if (pts.length < 20) return null;
    // walk the river from its western end, always to the nearest unvisited point still in the water
    pts.sort((a, b) => a[0] - b[0]); const used = new Uint8Array(pts.length); const route = [pts[0]]; used[0] = 1; let cur = 0;
    for (;;) {
      let best = -1, bd = 700; for (let i = 0; i < pts.length; i++) { if (used[i]) continue; const d = Math.hypot(pts[i][0] - pts[cur][0], pts[i][1] - pts[cur][1]); if (d < bd && inside((pts[i][0] + pts[cur][0]) / 2, (pts[i][1] + pts[cur][1]) / 2)) { bd = d; best = i; } }
      if (best < 0) break; used[best] = 1; cur = best; route.push(pts[best]);
      for (let i = 0; i < pts.length; i++) if (!used[i] && Math.hypot(pts[i][0] - pts[cur][0], pts[i][1] - pts[cur][1]) < 90) used[i] = 1; // thin out so the path keeps moving
    }
    if (route.length < 4) return null;
    const sm = route.map((_, i) => { let x = 0, z = 0, n = 0; for (let k = -3; k <= 3; k++) { const q = route[Math.max(0, Math.min(route.length - 1, i + k))]; x += q[0]; z += q[1]; n++; } return [x / n, z / n]; });
    const cum = [0]; for (let i = 1; i < sm.length; i++) cum.push(cum[i - 1] + Math.hypot(sm[i][0] - sm[i - 1][0], sm[i][1] - sm[i - 1][1]));
    return { path: sm, cum, len: cum[cum.length - 1], t0: performance.now() - Math.random() * 3e6, x: sm[0][0], z: sm[0][1], sx: -1e9, sy: -1e9, w: 0 };
  })();
  function whaleSprites(nightMode) {
    const frames = [];
    for (const up of [true, false]) {
      const cv = document.createElement("canvas"); cv.width = 26; cv.height = 12; const g = cv.getContext("2d");
      const px = (x, y, c) => { g.fillStyle = c; g.fillRect(x, y, 1, 1); };
      const dark = nightMode ? "#1c2a35" : "#2c4657", mid = nightMode ? "#25394a" : "#3e6177", hi = nightMode ? "#3a5468" : "#79a0b6", belly = nightMode ? "#4a6070" : "#a9c0cb";
      for (let x = 6; x < 25; x++) for (let y = 2; y < 10; y++) { const dx = (x - 15.5) / 9.6, dy = (y - 5.8) / 3.1; if (dx * dx + dy * dy > 1) continue; px(x, y, y <= 3 ? hi : y >= 8 ? belly : dx * dx + dy * dy > 0.7 ? dark : mid); }
      px(12, 1, dark); px(13, 1, dark); px(13, 2, mid);                         // dorsal fin
      px(21, 5, "#ffffff"); px(21, 6, "#0c1418");                              // eye
      const tail = up ? [[5, 4], [4, 3], [3, 2], [2, 1], [4, 5], [3, 5]] : [[5, 7], [4, 8], [3, 9], [2, 10], [4, 6], [3, 6]];
      for (const [x, y] of tail) px(x, y, dark); px(5, 5, dark); px(5, 6, dark);
      frames.push(cv);
    }
    // the tail flukes, raised as it dives
    const cv = document.createElement("canvas"); cv.width = 16; cv.height = 13; const g = cv.getContext("2d");
    const c1 = nightMode ? "#1c2a35" : "#2c4657", c2 = nightMode ? "#3a5468" : "#79a0b6";
    const rows = ["0110000000000110", "0111100000011110", "0011111001111100", "0001111111111000", "0000011111100000", "0000001111000000", "0000001111000000", "0000001111000000", "0000011111100000", "0000011111100000", "0000111111110000", "0000111111110000", "0001111111111000"];
    rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === "1") { g.fillStyle = y < 3 && x % 5 === 1 ? c2 : c1; g.fillRect(x, y, 1, 1); } }));
    frames.push(cv);
    return frames;
  }
  let WSPR = { day: whaleSprites(false), night: whaleSprites(true) };
  const spray = [];
  function drawWhale(now) {
    if (!whale) return;
    const T = (now - whale.t0) / 1000, speed = 5.5; let s = (T * speed) % (2 * whale.len); const back = s > whale.len; if (back) s = 2 * whale.len - s;
    let i = 1; while (i < whale.cum.length - 1 && whale.cum[i] < s) i++;
    const a = whale.path[i - 1], b = whale.path[i], u = (s - whale.cum[i - 1]) / (whale.cum[i] - whale.cum[i - 1] || 1);
    whale.x = a[0] + (b[0] - a[0]) * u; whale.z = a[1] + (b[1] - a[1]) * u;
    const [ix, iy] = iso(whale.x, whale.z); const [sx, sy] = toScreen(ix, iy);
    const [jx, jy] = iso(b[0], b[1]), [kx, ky] = iso(a[0], a[1]); const goingRight = (back ? kx - jx : jx - kx) >= 0;
    const w = Math.max(30, 26 * cam.zoom * 1.6), h = (w * 12) / 26; whale.sx = sx; whale.sy = sy; whale.w = w;
    if (sx < -w || sx > W + w || sy < -w || sy > H + w) return;
    // a 26 s routine: swim and blow, dive tail-up, then a breach — the whole whale leaps clear and splashes back
    const cyc = T % 26; const pal = night ? WSPR.night : WSPR.day; const foam = night ? "rgba(160,190,230,.4)" : "rgba(240,250,255,.85)";
    const splash = (x, y, n, big) => { for (let k = 0; k < n; k++) spray.push({ x: x + (Math.random() - 0.5) * w * 0.5, y, vx: (Math.random() - 0.5) * (big ? 120 : 50), vy: -(big ? 90 : 50) - Math.random() * (big ? 110 : 50), life: 0.7 + Math.random() * 0.7, t: now, g: 160 }); };
    ctx.save(); ctx.imageSmoothingEnabled = false;
    // ripples where it is (always)
    const r = ((T % 1.6) / 1.6) * w * 0.7; ctx.strokeStyle = night ? "rgba(160,190,230,.35)" : "rgba(235,248,255,.7)"; ctx.lineWidth = Math.max(1, w / 40);
    ctx.beginPath(); ctx.ellipse(sx, sy + h * 0.25, r + w * 0.3, (r + w * 0.3) * 0.45, 0, 0, Math.PI * 2); ctx.stroke();
    if (cyc < 10) {
      const frame = pal[Math.floor(T * 2.2) % 2]; const bob = Math.sin(T * 2.4) * h * 0.06;
      ctx.translate(Math.round(sx), Math.round(sy - h * 0.5 + bob)); if (!goingRight) ctx.scale(-1, 1);
      ctx.drawImage(frame, 0, 0, 26, 12, -w / 2, 0, w, h); ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      // the blow: a tall puff of spray from the blowhole
      if ((cyc > 1.5 && cyc < 1.56) || (cyc > 6.5 && cyc < 6.56)) for (let k = 0; k < 22; k++) spray.push({ x: sx + (goingRight ? 0.18 : -0.18) * w, y: sy - h * 0.45, vx: (Math.random() - 0.5) * 34, vy: -80 - Math.random() * 70, life: 0.9 + Math.random() * 0.6, t: now, g: 70 });
      // wake
      ctx.strokeStyle = foam; ctx.lineWidth = Math.max(1, w / 40); ctx.beginPath(); const tx = sx + (goingRight ? -1 : 1) * w * 0.55; ctx.moveTo(tx, sy + h * 0.1); ctx.lineTo(tx + (goingRight ? -1 : 1) * w * 0.5, sy - h * 0.15); ctx.moveTo(tx, sy + h * 0.3); ctx.lineTo(tx + (goingRight ? -1 : 1) * w * 0.5, sy + h * 0.55); ctx.stroke();
    } else if (cyc < 12) {
      // dive: the back rolls under, then the flukes rise, hang and slip away
      const u = (cyc - 10) / 2; const fl = pal[2], fw = w * 0.5, fh = (fw * 13) / 16;
      const rise = u < 0.35 ? u / 0.35 : u < 0.75 ? 1 : 1 - (u - 0.75) / 0.25;
      const vis = Math.max(0, Math.round(13 * rise));
      if (vis > 0) ctx.drawImage(fl, 0, 0, 16, vis, Math.round(sx - fw / 2), Math.round(sy - fh * rise + h * 0.2), fw, (fh * vis) / 13);
      if (u > 0.4 && u < 0.43) { for (let k = 0; k < 10; k++) spray.push({ x: sx + (Math.random() - 0.5) * fw, y: sy - fh * 0.9, vx: (Math.random() - 0.5) * 20, vy: 10 + Math.random() * 20, life: 0.8, t: now, g: 120 }); } // water streaming off the tail
    } else if (cyc >= 18 && cyc < 20.2) {
      // breach: up out of the water in an arc, twisting, and back down with a big splash
      const u = (cyc - 18) / 2.2, lift = Math.sin(Math.PI * Math.min(1, u)) * w * 0.95, ang = (0.55 - u) * 1.5;
      if (!whale.sp1) { whale.sp1 = 1; splash(sx, sy, 26, false); }
      if (u > 0.93 && !whale.sp2) { whale.sp2 = 1; splash(sx + (goingRight ? 1 : -1) * w * 0.4, sy, 46, true); whale.ring = now; }
      const frame = pal[0]; ctx.translate(Math.round(sx + (goingRight ? 1 : -1) * w * 0.35 * (u - 0.5)), Math.round(sy - lift)); if (!goingRight) ctx.scale(-1, 1); ctx.rotate(-ang);
      ctx.drawImage(frame, -w / 2, -h / 2, w, h); ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    } else if (cyc > 21) { whale.sp1 = whale.sp2 = 0; }
    if (whale.ring && now - whale.ring < 1600) { const k = (now - whale.ring) / 1600; ctx.strokeStyle = night ? `rgba(160,190,230,${0.5 * (1 - k)})` : `rgba(255,255,255,${0.9 * (1 - k)})`; ctx.lineWidth = Math.max(1, w / 30); for (const m of [1, 0.6]) { const rr = w * (0.3 + k * 1.1) * m; ctx.beginPath(); ctx.ellipse(sx, sy, rr, rr * 0.45, 0, 0, 7); ctx.stroke(); } }
    for (let k = spray.length - 1; k >= 0; k--) { const p = spray[k]; const dt = (now - p.t) / 1000; if (dt > p.life) { spray.splice(k, 1); continue; } ctx.fillStyle = `rgba(255,255,255,${1 - dt / p.life})`; const ps = Math.max(2, w / 18); ctx.fillRect(Math.round(p.x + p.vx * dt), Math.round(p.y + p.vy * dt + (p.g || 60) * dt * dt), ps, ps); }
    ctx.restore();
  }

  /* ---------- objects layer ---------- */
  function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296; }
  function drawObjects(g, c, T, b, L) {
    if (!c.data) return;
    const pal = P(); const x0 = c.cx * C, z0 = c.cz * C;
    const items = [];
    for (const rec of c.data.b) {
      // [height×2, material, roof, base×2, wall colour, roof colour, roof height×2, n, …outline, (n, …hole)…]
      let o = 7; const rings = [];
      while (o < rec.length) { const n = rec[o++]; const r = new Array(n); for (let i = 0; i < n; i++) r[i] = [x0 + rec[o + i * 2] / 2, z0 + rec[o + i * 2 + 1] / 2]; o += n * 2; rings.push(r); }
      const pts = rings[0], n = pts.length; let mx = 0, mz = 0; for (const p of pts) { mx += p[0]; mz += p[1]; } mx /= n; mz /= n; const [rx, rz] = rotXZ(mx, mz);
      // nearest point to the viewer decides depth, so long buildings sort sensibly; raised parts draw after what they sit on
      let dmax = -1e9; for (const p of pts) { const [a, bb] = rotXZ(p[0], p[1]); if (a + bb > dmax) dmax = a + bb; }
      const base = rec[3] / 2;
      items.push({ k: (rx + rz) * 0.5 + dmax * 0.5 + base * 0.04, t: 0, h: rec[0] / 2, cls: rec[1], roof: rec[2], base, wall: rec[4], rcol: rec[5], roofH: rec[6] / 2, pts, holes: rings.slice(1), mx, mz, id: (rec[8] * 7919 + rec[9] * 104729 + c.cx * 31 + c.cz * 17) | 0 });
    }
    for (const sp of c.data.s || []) { const x = x0 + sp[1] / 2, z = z0 + sp[2] / 2; const [rx, rz] = rotXZ(x, z); items.push({ k: rx + rz + 30, t: 2, sp, x, z }); }
    const tr = c.data.t;
    if (L <= 3) for (let i = 0; i < tr.length; i += 2) { const x = x0 + tr[i] / 2, z = z0 + tr[i + 1] / 2; const [rx, rz] = rotXZ(x, z); items.push({ k: rx + rz, t: 1, x, z, id: i }); }
    // anything sitting on top of another piece (a drum on a nave, a lantern on a dome) draws after it
    const raised = items.filter((it) => it.t === 0 && it.base > 0);
    if (raised.length) for (const it of raised.sort((p, q) => p.base - q.base)) for (const o of items) {
      if (o === it || o.t !== 0 || o.base >= it.base || o.h > it.base + 0.5 && o.base > 0 && o.h > it.h) continue;
      if (Math.abs(o.mx - it.mx) > 80 || Math.abs(o.mz - it.mz) > 80) continue;
      if (inPoly(it.mx, it.mz, o.pts) && o.k >= it.k) it.k = o.k + 0.01;
    }
    items.sort((p, q) => p.k - q.k);
    const px = Math.max(1, b);
    for (const it of items) {
      if (it.t === 1) { drawTree(g, it, T, b, pal); continue; }
      if (it.t === 2) { drawSpecial(g, it, T, b, pal); continue; }
      drawBuilding(g, it, T, b, px, pal, L);
    }
    if (L <= 1) crispen(g);
  }

  function drawTree(g, it, T, b, pal) {
    const [sx, sy] = T(it.x, it.z); const s = Math.max(1, b);
    g.fillStyle = pal.tree[2]; g.fillRect(Math.round(sx - s / 2), Math.round(sy - 3 * b), s, Math.max(1, 3 * b));
    const r = Math.max(1.2, 3.4 * b);
    g.fillStyle = pal.tree[0]; g.beginPath(); g.arc(sx, sy - 5.5 * b, r, 0, 7); g.fill();
    if (b >= 0.5) { g.fillStyle = pal.tree[1]; g.beginPath(); g.arc(sx - r * 0.35, sy - 5.5 * b - r * 0.35, r * 0.45, 0, 7); g.fill(); }
  }

  // Real colours from OSM (building:colour / roof:colour) become a little palette of their own.
  const hex = (n) => "#" + n.toString(16).padStart(6, "0");
  const dark = (n, k) => { const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return "#" + [r, g, b].map((v) => Math.round(v * k).toString(16).padStart(2, "0")).join(""); };
  const colCache = new Map();
  function colours(it, pal) {
    const base = pal.mat[it.cls] || pal.mat[0]; if (it.wall < 0 && it.rcol < 0) return base;
    const key = it.cls + "|" + it.wall + "|" + it.rcol + "|" + night; let c = colCache.get(key); if (c) return c;
    const w = it.wall >= 0 ? [hex(it.wall), dark(it.wall, 0.74)] : [base[0], base[1]], r = it.rcol >= 0 ? [hex(it.rcol), dark(it.rcol, 0.7)] : [base[2], base[3]];
    c = night ? [shade(w[0], 0.32), shade(w[1], 0.22), shade(r[0], 0.28), shade(r[1], 0.2), base[4]] : [w[0], w[1], r[0], r[1], base[4]];
    colCache.set(key, c); return c;
  }
  function wallsOf(pts, R, outward) {
    const n = pts.length; let A = 0; for (let i = 0, j = n - 1; i < n; j = i++) A += R[j][0] * R[i][1] - R[i][0] * R[j][1];
    const sgn = (A > 0 ? 1 : -1) * (outward ? 1 : -1); const out = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n; const dx = R[j][0] - R[i][0], dz = R[j][1] - R[i][1];
      const nx = dz * sgn, nz = -dx * sgn; // normal pointing out of the walls' material
      if (nx + nz <= 0) continue;
      const len = Math.hypot(dx, dz); if (len < 0.01) continue;
      out.push([i, j, (nx - nz) / (len * Math.SQRT2), len]); // -1 left-facing … +1 right-facing
    }
    return out;
  }
  function drawBuilding(g, it, T, b, px, pal, L) {
    const { pts, h, base = 0 } = it; const n = pts.length; const col = colours(it, pal);
    const rings = [pts, ...(it.holes || [])];
    const wallShade = (t) => (t > 0.25 ? col[1] : t < -0.25 ? col[0] : mix(col[0], col[1], (t + 1) / 2));
    const all = [];
    rings.forEach((ring, ri) => { const R = ring.map((p) => rotXZ(p[0], p[1])); for (const w of wallsOf(ring, R, ri === 0)) all.push([ring, ...w]); });
    if (it.holes && it.holes.length) all.sort((p, q) => { const d = (r, i, j) => { const a = rotXZ((r[i][0] + r[j][0]) / 2, (r[i][1] + r[j][1]) / 2); return a[0] + a[1]; }; return d(p[0], p[1], p[2]) - d(q[0], q[1], q[2]); });
    for (const [ring, i, j, t] of all) {
      const a0 = T(ring[i][0], ring[i][1], base), a1 = T(ring[j][0], ring[j][1], base), b1 = T(ring[j][0], ring[j][1], h), b0 = T(ring[i][0], ring[i][1], h);
      g.beginPath(); g.moveTo(a0[0], a0[1]); g.lineTo(a1[0], a1[1]); g.lineTo(b1[0], b1[1]); g.lineTo(b0[0], b0[1]); g.closePath();
      g.fillStyle = wallShade(t); g.fill();
    }
    // windows: one dashed row per floor
    if (h - base >= 6 && b >= 0.24 && it.cls !== 7) {
      const floor = it.cls === 4 || it.cls === 5 ? 3.6 : 3.3;
      g.lineWidth = Math.max(1, 1.3 * b); const dash = Math.max(1, 1.6 * b); g.setLineDash([dash, dash]);
      for (const [ring, i, j, , len] of all) {
        if (len < 3) continue;
        const ax = ring[i][0] + (ring[j][0] - ring[i][0]) * 0.08, az = ring[i][1] + (ring[j][1] - ring[i][1]) * 0.08;
        const bx = ring[i][0] + (ring[j][0] - ring[i][0]) * 0.92, bz = ring[i][1] + (ring[j][1] - ring[i][1]) * 0.92;
        let row = 0;
        for (let y = base + 2.2; y < h - 1.2; y += floor, row++) {
          if (night) { const r = hash(it.id * 131 + row * 17 + i); if (r < 0.45) continue; g.strokeStyle = pal.lit[(r * 997 | 0) % pal.lit.length]; }
          else g.strokeStyle = col[4];
          const [p1x, p1y] = T(ax, az, y), [p2x, p2y] = T(bx, bz, y);
          g.beginPath(); g.moveTo(p1x, p1y); g.lineTo(p2x, p2y); g.stroke();
        }
      }
      g.setLineDash([]);
    }
    // roof (courtyards are cut out of it)
    const Rf = pts.map((p) => T(p[0], p[1], h));
    g.beginPath(); for (const ring of rings) { ring.forEach((p, i) => { const [x, y] = T(p[0], p[1], h); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); }
    g.fillStyle = col[2]; g.fill("evenodd"); g.strokeStyle = col[3]; g.lineWidth = px * (L === 0 ? 1 : 0.8); g.stroke();
    if (it.roof === 3) {
      // pyramid or spire: faces up to an apex, the ones turned towards the light drawn lighter
      const rh = it.roofH > 0 ? it.roofH : Math.min(12, Math.sqrt(Math.abs(area2(pts))) * 0.5);
      const ap = T(it.mx, it.mz, h + rh); const R = pts.map((p) => rotXZ(p[0], p[1]));
      const faces = []; let A = 0; for (let i = 0, j = n - 1; i < n; j = i++) A += R[j][0] * R[i][1] - R[i][0] * R[j][1]; const sgn = A > 0 ? 1 : -1;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; const dx = R[j][0] - R[i][0], dz = R[j][1] - R[i][1], len = Math.hypot(dx, dz) || 1; const nx = (dz * sgn) / len, nz = (-dx * sgn) / len; faces.push([i, j, nx + nz, (nx - nz) / Math.SQRT2]); }
      faces.sort((p, q) => p[2] - q[2]);
      for (const [i, j, front, side] of faces) { g.beginPath(); g.moveTo(Rf[i][0], Rf[i][1]); g.lineTo(Rf[j][0], Rf[j][1]); g.lineTo(ap[0], ap[1]); g.closePath(); g.fillStyle = front <= 0 ? col[3] : side > 0.2 ? mix(col[2], col[3], 0.55) : side < -0.2 ? mix(col[2], "#ffffff", 0.12) : col[2]; g.fill(); }
    } else if (it.roof === 1 && b >= 0.24 && n >= 4) {
      // pitched: a ridge along the longest side, raised to the roof's height
      let best = 0, bl = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; const l = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]); if (l > bl) { bl = l; best = i; } }
      const j = (best + 1) % n; const ux = (pts[j][0] - pts[best][0]) / bl, uz = (pts[j][1] - pts[best][1]) / bl;
      let span = 0; for (const p of pts) { const d = Math.abs((p[0] - it.mx) * -uz + (p[1] - it.mz) * ux); if (d > span) span = d; }
      const half = bl * 0.42, rh = it.roofH > 0 ? it.roofH : Math.min(4, span * 0.55);
      const [ax, ay] = T(it.mx - ux * half, it.mz - uz * half, h + rh), [bx, by] = T(it.mx + ux * half, it.mz + uz * half, h + rh);
      if (rh > 4.5) { // a big roof (a church, a hall): fill both slopes
        for (const s of [-1, 1]) { const e1 = T(it.mx - ux * bl * 0.5 + -uz * span * s, it.mz - uz * bl * 0.5 + ux * span * s, h), e2 = T(it.mx + ux * bl * 0.5 + -uz * span * s, it.mz + uz * bl * 0.5 + ux * span * s, h);
          g.beginPath(); g.moveTo(e1[0], e1[1]); g.lineTo(e2[0], e2[1]); g.lineTo(bx, by); g.lineTo(ax, ay); g.closePath(); g.fillStyle = s > 0 ? col[2] : mix(col[2], col[3], 0.5); g.fill(); }
      }
      g.strokeStyle = col[3]; g.lineWidth = Math.max(1, 1.2 * b); g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    } else if (it.roof === 2) {
      const r = Math.sqrt(Math.abs(area2(pts)) / Math.PI) * 0.95; const [cx, cy] = T(it.mx, it.mz, h); const dh = (it.roofH > 0 ? it.roofH : r) * HF * b;
      const rx = r * Math.SQRT2 * b, ry = r * Math.SQRT2 * 0.5 * b;
      const dome = new Path2D(); dome.ellipse(cx, cy, rx, ry, 0, 0, Math.PI); dome.ellipse(cx, cy, rx, dh, 0, Math.PI, Math.PI * 2); dome.closePath();
      g.fillStyle = col[2]; g.fill(dome);
      g.save(); g.clip(dome); g.fillStyle = mix(col[2], "#000000", 0.2); g.fillRect(cx + rx * 0.25, cy - dh - 2, rx, dh + ry + 4); g.fillStyle = mix(col[2], "#000000", 0.1); g.fillRect(cx - rx * 0.15, cy - dh - 2, rx * 0.4, dh + ry + 4);
      g.fillStyle = mix(col[2], "#ffffff", 0.3); g.beginPath(); g.ellipse(cx - rx * 0.45, cy - dh * 0.55, rx * 0.2, Math.max(1, dh * 0.25), -0.5, 0, 7); g.fill();
      g.strokeStyle = mix(col[2], "#000000", 0.25); g.lineWidth = Math.max(1, 0.6 * b); for (const f of [-0.6, -0.2, 0.2, 0.6]) { g.beginPath(); g.ellipse(cx, cy, Math.abs(rx * f), dh, 0, f < 0 ? Math.PI * 1.5 : Math.PI, f < 0 ? Math.PI * 2 : Math.PI * 1.5, f < 0); g.stroke(); } g.restore();
    }
    if (night && h > 60) { // aircraft warning light on tall towers
      let top = Rf[0]; for (const p of Rf) if (p[1] < top[1]) top = p; g.fillStyle = "#ff3b3b"; g.fillRect(Math.round(top[0]), Math.round(top[1] - 2 * b - (it.roof === 3 ? (it.roofH || 0) * b : 0)), Math.max(1, 1.5 * b), Math.max(1, 1.5 * b));
    }
  }
  function inPoly(x, z, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; }
  function area2(p) { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return a / 2; }
  // The London Eye and the columns (Nelson's, the Monument)
  function drawSpecial(g, it, T, b, pal) {
    const sp = it.sp; const lw = (w) => Math.max(1, w * b);
    if (sp[0] === 1) {
      const [, , , D, hub, bearing] = sp; const R = D / 2, br = (bearing * Math.PI) / 180, ux = Math.sin(br), uz = -Math.cos(br), ax = -uz, az = ux; // rim direction and axle
      const P = (a, rr = R) => T(it.x + ux * Math.sin(a) * rr, it.z + uz * Math.sin(a) * rr, hub + Math.cos(a) * rr);
      const steel = night ? "#7f8fb0" : "#e9eef2", dk = night ? "#4a5670" : "#9aa5ae";
      // the A-frame leg leaning back from the hub
      g.strokeStyle = dk; g.lineWidth = lw(1.6);
      for (const s of [-1, 1]) { const f = T(it.x + ax * 32 + ux * 14 * s, it.z + az * 32 + uz * 14 * s, 0), hb = T(it.x, it.z, hub); g.beginPath(); g.moveTo(f[0], f[1]); g.lineTo(hb[0], hb[1]); g.stroke(); }
      // spokes
      g.strokeStyle = night ? "rgba(127,143,176,.55)" : "rgba(160,170,180,.75)"; g.lineWidth = lw(0.5); const hb = T(it.x, it.z, hub);
      for (let k = 0; k < 32; k++) { const p = P((k / 32) * 6.2832); g.beginPath(); g.moveTo(hb[0], hb[1]); g.lineTo(p[0], p[1]); g.stroke(); }
      // rim
      g.strokeStyle = steel; g.lineWidth = lw(1.4); g.beginPath(); for (let k = 0; k <= 96; k++) { const p = P((k / 96) * 6.2832); k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); } g.stroke();
      g.strokeStyle = dk; g.lineWidth = lw(0.7); g.beginPath(); for (let k = 0; k <= 96; k++) { const p = P((k / 96) * 6.2832, R - 3); k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); } g.stroke();
      // 32 glass capsules
      for (let k = 0; k < 32; k++) { const p = P((k / 32) * 6.2832, R + 2.2); g.fillStyle = night ? (k % 3 ? "#ffd27a" : "#cfe8ff") : "#bfe2f2"; const s = Math.max(1.5, 3.2 * b); g.fillRect(Math.round(p[0] - s / 2), Math.round(p[1] - s / 2), Math.ceil(s), Math.ceil(s * 0.8)); }
      g.fillStyle = dk; g.beginPath(); g.arc(hb[0], hb[1], Math.max(1.5, 3 * b), 0, 7); g.fill();
    } else if (sp[0] === 2) {
      const [, , , hh, r] = sp; const a = T(it.x, it.z, 0), t = T(it.x, it.z, hh), m = pal.mat[2];
      const w = Math.max(1.5, r * Math.SQRT2 * b);
      g.fillStyle = m[1]; g.fillRect(Math.round(a[0] - w), Math.round(t[1]), Math.ceil(w), Math.ceil(a[1] - t[1]));
      g.fillStyle = m[0]; g.fillRect(Math.round(a[0]), Math.round(t[1]), Math.ceil(w), Math.ceil(a[1] - t[1]));
      g.fillStyle = m[2]; g.fillRect(Math.round(a[0] - w * 1.6), Math.round(a[1] - 5 * b), Math.ceil(w * 3.2), Math.ceil(5 * b)); // plinth
      g.fillStyle = sp[3] > 55 ? "#d9a441" : m[3]; g.beginPath(); g.arc(t[0], t[1] - 2 * b, Math.max(1, r * 0.7 * b), 0, 7); g.fill(); // the Monument's gilded urn, Nelson on top
    }
  }
  function mix(a, bcol, t) {
    const p = (h) => h.startsWith("#") ? [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] : h.match(/\d+/g).map(Number);
    const A = p(a), B = p(bcol); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",")})`;
  }
  // Hard alpha edges: no half-transparent anti-aliasing, so the bitmap reads as pixel art.
  function crispen(g) {
    const { width: w, height: h } = g.canvas; if (w * h > 4e6) return;
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] > 110 ? 255 : 0;
    g.putImageData(img, 0, 0);
  }

  /* ---------- frame ---------- */
  let dirty = true, pending = 0;
  const status = $("#status");
  function resize() { DPR = Math.min(2, devicePixelRatio || 1); W = innerWidth; H = innerHeight; canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR); dirty = true; }
  addEventListener("resize", resize); resize();

  function frame() {
    requestAnimationFrame(frame);
    if (fly) stepFly();
    if (!dirty) return;
    dirty = false;
    const t0 = performance.now();
    const pal = P();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = pal.outside; ctx.fillRect(0, 0, W, H);
    const [cx, cy] = iso(cam.x, cam.z);
    const vx0 = cx - W / 2 / cam.zoom, vx1 = cx + W / 2 / cam.zoom, vy0 = cy - H / 2 / cam.zoom, vy1 = cy + H / 2 / cam.zoom;
    const L = Math.max(0, Math.min(6, Math.floor(Math.log2(1 / (cam.zoom * DPR)) + 0.0001)));
    const vis = [];
    for (const c of chunks) { const [a, b, d, e] = chunkIsoBounds(c, 70); if (d < vx0 || a > vx1 || e < vy0 || b > vy1) continue; vis.push(c); }
    vis.sort((p, q) => chunkDepth(p) - chunkDepth(q));
    // load nearest chunks first
    const byDist = vis.slice().sort((p, q) => Math.hypot((p.cx + 0.5) * C - cam.x, (p.cz + 0.5) * C - cam.z) - Math.hypot((q.cx + 0.5) * C - cam.x, (q.cz + 0.5) * C - cam.z));
    let inflight = chunks.filter((c) => c.loading).length;
    for (const c of byDist) { if (inflight >= 16) break; if (!c.data && !c.loading) { load(c); inflight++; } }
    pending = 0;
    const budget = 14;
    waterOnScreen = false;
    for (const layer of ["g", "w", "o"]) {
      for (const c of vis) {
        if (!c.data && !(layer === "g" && L >= 3)) { if (layer === "o") pending++; continue; } // far out, the ground doesn't need the chunk's roads
        let k = cacheKey(c, layer, L);
        if (layer === "w") { if (L >= 4 || !hasWater(c)) continue; waterOnScreen = true; k = cacheKey(c, "w" + waterFrame, L); const wb = cacheGet(k) || (performance.now() - t0 < budget * 2 ? (cachePut(k, makeBitmap(c, "w" + waterFrame, L)), cache.get(k)) : null); if (wb) { const sx = (wb.a - cx) * cam.zoom + W / 2, sy = (wb.top - cy) * cam.zoom + H / 2; const sc = cam.zoom / wb.b; ctx.drawImage(wb.cv, Math.round(sx * DPR) / DPR, Math.round(sy * DPR) / DPR, wb.cv.width * sc, wb.cv.height * sc); } continue; }
        let bm = cacheGet(k);
        if (!bm && performance.now() - t0 < budget) { bm = makeBitmap(c, layer, L); cachePut(k, bm); }
        if (!bm) { pending++; for (const dl of [1, -1, 2, -2, 3]) { const alt = cache.get(cacheKey(c, layer, L + dl)); if (alt) { bm = alt; break; } } }
        if (!bm) continue;
        const sx = (bm.a - cx) * cam.zoom + W / 2, sy = (bm.top - cy) * cam.zoom + H / 2;
        const s = cam.zoom / bm.b;
        const grow = layer === "g" ? 1 / DPR : 0; // ground tiles overlap by a pixel so no seams show
        ctx.drawImage(bm.cv, Math.round(sx * DPR) / DPR, Math.round(sy * DPR) / DPR, bm.cv.width * s + grow, bm.cv.height * s + grow);
      }
    }
    drawWhale(performance.now()); // drawn last so towers on the bank never hide it
    if (whale && whale.sx > -200 && whale.sx < W + 200 && whale.sy > -200 && whale.sy < H + 200) dirty = true; // keep animating while the whale is in view
    if (pending) { dirty = true; status.hidden = false; status.textContent = `Laying bricks… ${Math.max(1, Math.round(100 * (1 - pending / Math.max(1, vis.length))))}%`; }
    else status.hidden = true;
  }
  requestAnimationFrame(frame);

  /* ---------- interaction ---------- */
  const pointers = new Map(); let pinch = null;
  canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); canvas.classList.add("drag"); fly = null; if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: cam.zoom }; } });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2 && pinch) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (pinch.z * d) / pinch.d / cam.zoom); return; }
    pan(e.clientX - prev[0], e.clientY - prev[1]);
  });
  const up = (e) => { if (whale && pointers.size === 1 && Math.hypot(e.clientX - whale.sx, e.clientY - whale.sy) < whale.w * 0.7) whaleToast();
    pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) { canvas.classList.remove("drag"); saveHash(); } };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); fly = null; zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))); saveHashSoon(); }, { passive: false });
  function pan(dx, dy) { const [ix, iy] = iso(cam.x, cam.z); const [x, z] = isoToWorld(ix - dx / cam.zoom, iy - dy / cam.zoom); cam.x = x; cam.z = z; clampCam(); dirty = true; }
  function zoomAt(sx, sy, f) {
    const before = screenToWorld(sx, sy); cam.zoom = Math.min(ZMAX, Math.max(ZMIN, cam.zoom * f));
    const after = screenToWorld(sx, sy); cam.x += before[0] - after[0]; cam.z += before[1] - after[1]; clampCam(); dirty = true;
  }
  function clampCam() { const [a, b, c, d] = meta.bounds; cam.x = Math.min(c, Math.max(a, cam.x)); cam.z = Math.min(d, Math.max(b, cam.z)); }
  $("#zin").addEventListener("click", () => { zoomAt(W / 2, H / 2, 2); saveHash(); });
  $("#zout").addEventListener("click", () => { zoomAt(W / 2, H / 2, 0.5); saveHash(); });
  $("#rot").addEventListener("click", rotate);
  $("#night").addEventListener("click", toggleNight);
  function rotate() { cam.rot = (cam.rot + 1) % 4; dirty = true; saveHash(); }
  function toggleNight() { night = !night; document.documentElement.classList.toggle("night", night); $("#night").setAttribute("aria-pressed", night); dirty = true; }
  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key;
    if (k === "r" || k === "R") rotate(); else if (k === "n" || k === "N") toggleNight();
    else if (k === "+" || k === "=") zoomAt(W / 2, H / 2, 1.5); else if (k === "-" || k === "_") zoomAt(W / 2, H / 2, 1 / 1.5);
    else if (k.startsWith("Arrow")) { const s = 80; pan(k === "ArrowLeft" ? s : k === "ArrowRight" ? -s : 0, k === "ArrowUp" ? s : k === "ArrowDown" ? -s : 0); }
    else if (k === "/") { e.preventDefault(); $("#q").focus(); }
  });

  let toastT; function whaleToast() { const el = $("#toast"); if (!el) return; el.hidden = false; el.innerHTML = "<b>You found the Thames whale.</b> In January 2006 a real northern bottlenose whale swam up the river into central London, past the Houses of Parliament."; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 7000); }

  /* ---------- fly-to ---------- */
  let fly = null;
  function flyTo(x, z, zoom) { fly = { x0: cam.x, z0: cam.z, zm0: cam.zoom, x, z, zoom, t0: performance.now(), dur: matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 1400 }; }
  function stepFly() {
    const f = fly; const u = Math.min(1, (performance.now() - f.t0) / f.dur); const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
    cam.x = f.x0 + (f.x - f.x0) * e; cam.z = f.z0 + (f.z - f.z0) * e;
    const dist = Math.hypot(f.x - f.x0, f.z - f.z0); const out = Math.min(1, 300 / (dist + 1)); // pull back on long hops
    const zl = Math.log(f.zm0) + (Math.log(f.zoom) - Math.log(f.zm0)) * e; cam.zoom = Math.exp(zl) * (1 - Math.sin(e * Math.PI) * (1 - Math.max(out, 0.25)));
    dirty = true; if (u >= 1) { fly = null; saveHash(); }
  }

  /* ---------- landmarks & search ---------- */
  const marks = $("#marks");
  if (whale) { const b = document.createElement("button"); b.type = "button"; b.textContent = "🐋 Find the whale"; b.addEventListener("click", () => flyTo(whale.x, whale.z, 2.5)); marks.appendChild(b); }
  for (const [name, x, z] of meta.landmarks) { const b = document.createElement("button"); b.type = "button"; b.textContent = name; b.addEventListener("click", () => flyTo(x, z, 1.5)); marks.appendChild(b); }
  const all = meta.landmarks.map((l) => [...l, "landmark"]).concat(places.map((p) => [...p, ""]));
  const q = $("#q"), res = $("#results"); let sel = 0, rows = [];
  function renderResults() {
    const s = q.value.trim().toLowerCase(); if (!s) { res.hidden = true; return; }
    rows = all.filter((p) => p[0].toLowerCase().includes(s)).sort((a, b) => a[0].toLowerCase().indexOf(s) - b[0].toLowerCase().indexOf(s) || (b[3] ? 1 : 0) - (a[3] ? 1 : 0)).slice(0, 8);
    sel = 0; res.hidden = false;
    res.innerHTML = rows.length ? rows.map((r, i) => `<li><button type="button" data-i="${i}" aria-selected="${i === sel}">${esc(r[0])}<small>${r[3]}</small></button></li>`).join("") : `<li style="padding:7px 12px;opacity:.7">No place called “${esc(q.value)}” on the map.</li>`;
    res.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => go(rows[+b.dataset.i])));
  }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function go(r) { if (!r) return; flyTo(r[1], r[2], 1.5); res.hidden = true; q.blur(); }
  q.addEventListener("input", renderResults);
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go(rows[sel]);
    else if (e.key === "Escape") { q.value = ""; res.hidden = true; q.blur(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, Math.min(rows.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1))); res.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-selected", i === sel)); }
  });

  /* ---------- shareable location in the URL ---------- */
  function saveHash() {
    const lat = meta.lat0 - cam.z / meta.my, lng = meta.lng0 + cam.x / meta.mx;
    history.replaceState(null, "", `#${lat.toFixed(5)},${lng.toFixed(5)},${cam.zoom.toFixed(2)},${cam.rot}`);
  }
  let hashT; function saveHashSoon() { clearTimeout(hashT); hashT = setTimeout(saveHash, 400); }
  const m = location.hash.slice(1).split(",").map(Number);
  if (m.length >= 3 && m.every(Number.isFinite)) { cam.z = -(m[0] - meta.lat0) * meta.my; cam.x = (m[1] - meta.lng0) * meta.mx; cam.zoom = Math.min(ZMAX, Math.max(ZMIN, m[2])); if (m[3] >= 0 && m[3] < 4) cam.rot = m[3] | 0; clampCam(); }
})();
