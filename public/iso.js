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
      let m = 10; for (const b of d.b) if (b[0] / 2 > m) m = b[0] / 2; c.maxH = m + 8; c.data = d;
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
    const b = 2 ** -L; const [a, top, d, e] = layer === "g" ? chunkIsoBounds(c, 2) : chunkIsoBounds(c, 40);
    const w = Math.max(1, Math.ceil((d - a) * b)), h = Math.max(1, Math.ceil((e - top) * b));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const g = cv.getContext("2d");
    const T = (x, z, hgt = 0) => { const [ix, iy] = iso(x, z); return [(ix - a) * b, (iy - hgt * HF - top) * b]; };
    if (layer === "g") drawGround(g, c, T, b); else drawObjects(g, c, T, b, L);
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

  /* ---------- objects layer ---------- */
  function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296; }
  function drawObjects(g, c, T, b, L) {
    if (!c.data) return;
    const pal = P(); const x0 = c.cx * C, z0 = c.cz * C;
    const items = [];
    for (const rec of c.data.b) {
      const n = (rec.length - 3) / 2; const pts = new Array(n); let mx = 0, mz = 0;
      for (let i = 0; i < n; i++) { const x = x0 + rec[3 + i * 2] / 2, z = z0 + rec[4 + i * 2] / 2; pts[i] = [x, z]; mx += x; mz += z; }
      mx /= n; mz /= n; const [rx, rz] = rotXZ(mx, mz);
      // nearest point to the viewer decides depth, so long buildings sort sensibly
      let dmax = -1e9; for (const p of pts) { const [a, bb] = rotXZ(p[0], p[1]); if (a + bb > dmax) dmax = a + bb; }
      items.push({ k: (rx + rz) * 0.5 + dmax * 0.5, t: 0, h: rec[0] / 2, cls: rec[1], roof: rec[2], pts, mx, mz, id: (rec[3] * 7919 + rec[4] * 104729 + c.cx * 31 + c.cz * 17) | 0 });
    }
    const tr = c.data.t;
    if (L <= 3) for (let i = 0; i < tr.length; i += 2) { const x = x0 + tr[i] / 2, z = z0 + tr[i + 1] / 2; const [rx, rz] = rotXZ(x, z); items.push({ k: rx + rz, t: 1, x, z, id: i }); }
    items.sort((p, q) => p.k - q.k);
    const px = Math.max(1, b);
    for (const it of items) {
      if (it.t === 1) { drawTree(g, it, T, b, pal); continue; }
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

  function drawBuilding(g, it, T, b, px, pal, L) {
    const { pts, h } = it; const n = pts.length; const col = pal.mat[it.cls] || pal.mat[0];
    // winding in rotated space
    const R = pts.map((p) => rotXZ(p[0], p[1]));
    let A = 0; for (let i = 0, j = n - 1; i < n; j = i++) A += R[j][0] * R[i][1] - R[i][0] * R[j][1];
    const sgn = A > 0 ? 1 : -1;
    const G = pts.map((p) => T(p[0], p[1], 0)), Rf = pts.map((p) => T(p[0], p[1], h));
    const walls = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n; const dx = R[j][0] - R[i][0], dz = R[j][1] - R[i][1];
      const nx = dz * sgn, nz = -dx * sgn; // outward normal
      if (nx + nz <= 0) continue;
      const len = Math.hypot(dx, dz); if (len < 0.01) continue;
      const t = (nx - nz) / (len * Math.SQRT2); // -1 left-facing … +1 right-facing
      walls.push([i, j, t, len]);
    }
    for (const [i, j, t] of walls) {
      g.beginPath(); g.moveTo(G[i][0], G[i][1]); g.lineTo(G[j][0], G[j][1]); g.lineTo(Rf[j][0], Rf[j][1]); g.lineTo(Rf[i][0], Rf[i][1]); g.closePath();
      g.fillStyle = t > 0.25 ? col[1] : t < -0.25 ? col[0] : mix(col[0], col[1], (t + 1) / 2); g.fill();
    }
    // windows: one dashed row per floor
    if (h >= 7 && b >= 0.24 && it.cls !== 7) {
      const floor = it.cls === 4 || it.cls === 5 ? 3.6 : 3.3;
      g.lineWidth = Math.max(1, 1.3 * b); const dash = Math.max(1, 1.6 * b); g.setLineDash([dash, dash]);
      for (const [i, j, , len] of walls) {
        if (len < 3) continue;
        const ax = pts[i][0] + (pts[j][0] - pts[i][0]) * 0.08, az = pts[i][1] + (pts[j][1] - pts[i][1]) * 0.08;
        const bx = pts[i][0] + (pts[j][0] - pts[i][0]) * 0.92, bz = pts[i][1] + (pts[j][1] - pts[i][1]) * 0.92;
        let row = 0;
        for (let y = 2.2; y < h - 1.2; y += floor, row++) {
          if (night) { const r = hash(it.id * 131 + row * 17 + i); if (r < 0.45) continue; g.strokeStyle = pal.lit[(r * 997 | 0) % pal.lit.length]; }
          else g.strokeStyle = col[4];
          const [p1x, p1y] = T(ax, az, y), [p2x, p2y] = T(bx, bz, y);
          g.beginPath(); g.moveTo(p1x, p1y); g.lineTo(p2x, p2y); g.stroke();
        }
      }
      g.setLineDash([]);
    }
    // roof
    g.beginPath(); for (let i = 0; i < n; i++) i ? g.lineTo(Rf[i][0], Rf[i][1]) : g.moveTo(Rf[i][0], Rf[i][1]); g.closePath();
    g.fillStyle = col[2]; g.fill(); g.strokeStyle = col[3]; g.lineWidth = px * (L === 0 ? 1 : 0.8); g.stroke();
    if (it.roof === 1 && b >= 0.24 && n >= 4) {
      // pitched: a ridge along the longest side, raised a little
      let best = 0, bl = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; const l = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]); if (l > bl) { bl = l; best = i; } }
      const j = (best + 1) % n; const ux = (pts[j][0] - pts[best][0]) / bl, uz = (pts[j][1] - pts[best][1]) / bl;
      let span = 0; for (const p of pts) { const d = Math.abs((p[0] - it.mx) * -uz + (p[1] - it.mz) * ux); if (d > span) span = d; }
      const half = bl * 0.42, rh = Math.min(4, span * 0.55);
      const [ax, ay] = T(it.mx - ux * half, it.mz - uz * half, h + rh), [bx, by] = T(it.mx + ux * half, it.mz + uz * half, h + rh);
      g.strokeStyle = col[3]; g.lineWidth = Math.max(1, 1.2 * b); g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    } else if (it.roof === 2) {
      let ar = 0; for (let i = 0, j = n - 1; i < n; j = i++) ar += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
      const r = Math.sqrt(Math.abs(ar / 2) / Math.PI) * 0.75; const [cx, cy] = T(it.mx, it.mz, h);
      g.fillStyle = col[2]; g.beginPath(); g.ellipse(cx, cy, r * Math.SQRT2 * b, r * Math.SQRT2 * 0.5 * b, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(cx, cy, r * Math.SQRT2 * b, r * 1.25 * b, 0, Math.PI, Math.PI * 2); g.fill();
      g.fillStyle = mix(col[2], "#ffffff", 0.35); g.beginPath(); g.ellipse(cx - r * 0.4 * b, cy - r * 0.7 * b, r * 0.35 * b, r * 0.3 * b, 0, 0, 7); g.fill();
    }
    if (night && h > 60) { // aircraft warning light on tall towers
      let top = Rf[0]; for (const p of Rf) if (p[1] < top[1]) top = p; g.fillStyle = "#ff3b3b"; g.fillRect(Math.round(top[0]), Math.round(top[1] - 2 * b), Math.max(1, 1.5 * b), Math.max(1, 1.5 * b));
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
    for (const c of chunks) { const [a, b, d, e] = chunkIsoBounds(c, 40); if (d < vx0 || a > vx1 || e < vy0 || b > vy1) continue; vis.push(c); }
    vis.sort((p, q) => chunkDepth(p) - chunkDepth(q));
    // load nearest chunks first
    const byDist = vis.slice().sort((p, q) => Math.hypot((p.cx + 0.5) * C - cam.x, (p.cz + 0.5) * C - cam.z) - Math.hypot((q.cx + 0.5) * C - cam.x, (q.cz + 0.5) * C - cam.z));
    let inflight = chunks.filter((c) => c.loading).length;
    for (const c of byDist) { if (inflight >= 8) break; if (!c.data && !c.loading) { load(c); inflight++; } }
    pending = 0;
    const budget = 14;
    for (const layer of ["g", "o"]) {
      for (const c of vis) {
        if (!c.data) { pending++; continue; }
        const k = cacheKey(c, layer, L);
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
    if (pending) { dirty = true; status.hidden = false; status.textContent = `Laying bricks… ${pending} left`; }
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
  const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) { canvas.classList.remove("drag"); saveHash(); } };
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
