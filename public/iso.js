// Isometric London — a pixel-art city renderer drawn entirely with the Canvas 2D API.
//
// How it works
//  1. The city is split into 500 m chunks (built by scripts/build.mjs).
//  2. Each visible chunk is painted once into off-screen bitmaps: ground (land use, parks,
//     water, roads, shadows), a water mask, bridges and piers, and objects (buildings,
//     landmarks, trees). Bitmaps are cached per level of detail, rotation and day/night,
//     so panning only copies pixels.
//  3. Buildings are extruded footprints with windows per floor, real pitched and hipped
//     roofs, chimneys and roof plant. Landmarks are hand-built models (landmarks.js).
//  4. Water gets an animated pixel-wave overlay every frame, and a whale swims the Thames.
"use strict";
(async function () {
  const $ = (s) => document.querySelector(s);
  const canvas = $("#map"), ctx = canvas.getContext("2d");
  const HF = 1.0;                 // screen pixels per metre of height (relative to ground scale)
  const MAX_CACHE_PX = 90e6;
  const ZMIN = 1 / 48, ZMAX = 4;
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- colour helpers ---------- */
  const hexA = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const intA = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const cs = (a) => `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`;
  const mixA = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const mulA = (a, f) => [Math.min(255, a[0] * f), Math.min(255, a[1] * f), Math.min(255, a[2] * f)];
  // night: darken and push towards blue
  const nightA = (a, k = 0.3) => [a[0] * k + 14, a[1] * k + 18, a[2] * k + 40];

  /* ---------- palettes ---------- */
  // per material: [lit wall, shaded wall, roof, roof edge, window, trim]
  const MAT_DAY = [
    ["#a9634c", "#7e4838", "#5e6168", "#43464d", "#3a3335", "#d9d0c0"], // 0 red brick
    ["#c7aa7c", "#977d55", "#5e6168", "#43464d", "#3f3933", "#e6dcc6"], // 1 London stock brick
    ["#e2dbca", "#b0a794", "#bdb6a6", "#8d867a", "#57534d", "#f2ede2"], // 2 Portland stone
    ["#eee9de", "#c1bbad", "#8e9399", "#676c72", "#4f555b", "#ffffff"], // 3 stucco
    ["#93b6c8", "#5f8397", "#aab7bd", "#5b6c76", "#365466", "#d6e6ee"], // 4 glass
    ["#66868e", "#435d65", "#8e9c9f", "#465659", "#263a41", "#a9c4c8"], // 5 dark glass
    ["#b6b1a7", "#89847a", "#a39e94", "#6e6a62", "#48453f", "#cfcac0"], // 6 concrete
    ["#a39a8a", "#7b7466", "#8b8577", "#5e584e", "#5e584e", "#b8b0a0"], // 7 shed
    ["#d9cfb8", "#a99f88", "#5c6670", "#414a53", "#4b463e", "#ece5d3"], // 8 church
    ["#d8c193", "#a99063", "#6f7a76", "#4e5754", "#5c4c35", "#ead9b2"], // 9 gothic
    ["#cfab7d", "#a0805a", "#626a72", "#454c53", "#4a4038", "#9aa4ae"], // 10 terracotta
    ["#aaa69d", "#7e7a72", "#97938b", "#66625b", "#38362f", "#c9c5bb"], // 11 brutalist concrete
    ["#b9c0c5", "#89929a", "#a6adb2", "#6d757b", "#4c5760", "#d8dee2"]  // 12 metal
  ].map((m) => m.map(hexA));
  const WIN = [ // floor height, window width, bay, window height, style
    [3.2, 1.1, 2.6, 1.6, 0], [3.2, 1.1, 2.6, 1.6, 0], [3.8, 1.3, 3.0, 2.0, 0], [3.3, 1.2, 2.8, 1.8, 0],
    [3.6, 1.35, 1.6, 2.3, 1], [3.6, 1.35, 1.6, 2.3, 1], [3.3, 1.6, 2.6, 1.4, 0], null,
    [7.0, 1.2, 4.0, 4.5, 0], [6.0, 1.1, 3.4, 3.8, 0], [3.6, 1.2, 3.0, 2.0, 0], [3.0, 2.6, 3.0, 1.1, 2], [4.0, 3.4, 4.0, 1.0, 1]
  ];
  const GROUND_DAY = {
    base: "#d5cfc1", outside: "#a9c3c9",
    0: "#8fbe69", 1: "#7bb35c", 2: "#8fb47a", 3: "#6c9c53", 4: "#a3b66c", 5: "#9fc47d",
    10: "#ccd0b8", 11: "#d3cec4", 12: "#c8c3b9", 13: "#b8b0a1", 14: "#c9b595", 15: "#9c9ea2", 16: "#e3dccf", 17: "#e3d6aa", 18: "#d8d1bf", 19: "#c3b99f",
    30: "#4f98d2", 31: "#d5cfc1", 40: "#9c8667", 41: "#aaa59b",
    waterEdge: "#86c3ea", wave: "#9fd5f5", waveDark: "#3f84bf",
    road: ["#6c6e74", "#76787e", "#7f8186", "#8a8c90", "#9a9b9e", "#e6dfd2"], kerb: "#ece6da",
    rail: "#a39a8b", railLine: "#5e5248", tree: ["#3f6f34", "#5b8f43", "#7fae58", "#5a4330"], shadow: 0.2
  };
  const GROUND_NIGHT = {};
  for (const [k, v] of Object.entries(GROUND_DAY)) GROUND_NIGHT[k] = typeof v === "string" ? cs(nightA(hexA(v), k === "30" ? 0.32 : 0.27)) : Array.isArray(v) ? v.map((x) => cs(nightA(hexA(x), 0.27))) : v;
  Object.assign(GROUND_NIGHT, { outside: "#0e1424", waterEdge: "#2b5a86", wave: "#4f86b8", waveDark: "#0f2a45", kerb: "#3b4050", shadow: 0, lamp: "#f2b45a", lit: ["#ffd27a", "#ffe9b0", "#f7b955", "#cfe8ff", "#ffc56b"] });
  const ROAD_W = [17, 13, 11, 8, 4.5, 7];
  const ROAD_ORDER = [5, 4, 3, 2, 1, 0];

  /* ---------- data ---------- */
  let meta, places;
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
  places = await (await fetch("data/names.json")).json().catch(() => []);
  const MODELS = window.ISO_MODELS || { get: () => null };
  const modelIds = meta.models || [];

  const chunks = meta.chunks.map(([cx, cz, has]) => ({ cx, cz, key: cx + "_" + cz, data: has ? null : { b: [], g: [], r: [], t: [], m: [] }, loading: false, maxH: has ? 60 : 4, pad: 40, water: false, bridges: false }));

  /* ---------- camera ---------- */
  const cam = { x: meta.start.x, z: meta.start.z, zoom: meta.start.zoom, rot: meta.start.rotation };
  let night = false, W = 0, H = 0, DPR = 1;
  const G = () => (night ? GROUND_NIGHT : GROUND_DAY);
  const rotXZ = (x, z, r = cam.rot) => (r === 0 ? [x, z] : r === 1 ? [-z, x] : r === 2 ? [-x, -z] : [z, -x]);
  const unrotXZ = (x, z, r = cam.rot) => (r === 0 ? [x, z] : r === 1 ? [z, -x] : r === 2 ? [-x, -z] : [-z, x]);
  const iso = (x, z) => { const [rx, rz] = rotXZ(x, z); return [rx - rz, (rx + rz) / 2]; };
  function isoToWorld(ix, iy) { const rx = iy + ix / 2, rz = iy - ix / 2; return unrotXZ(rx, rz); }
  function toScreen(ix, iy) { const [cx, cy] = iso(cam.x, cam.z); return [(ix - cx) * cam.zoom + W / 2, (iy - cy) * cam.zoom + H / 2]; }
  function screenToWorld(sx, sy) { const [cx, cy] = iso(cam.x, cam.z); return isoToWorld((sx - W / 2) / cam.zoom + cx, (sy - H / 2) / cam.zoom + cy); }

  function chunkIsoBounds(c, pad = c.pad) {
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
      d.g = d.g || []; d.m = d.m || [];
      let m = 10; for (const b of d.b) if (b[0] / 2 > m) m = b[0] / 2;
      for (const [mi] of d.m) { const md = MODELS.get(modelIds[mi]); if (md) { m = Math.max(m, md.maxH); c.pad = Math.max(c.pad, md.rad + 30); } }
      c.maxH = m + 10; c.data = d;
      c.water = d.g.some((g) => (g[0] & 127) === 30) || d.r.some((r) => (r[0] & 31) === 9);
      c.bridges = d.g.some((g) => (g[0] & 127) >= 40) || d.r.some((r) => r[0] & 32);
    } catch { c.data = { b: [], g: [], r: [], t: [], m: [] }; }
    c.loading = false; dirty = true;
  }

  /* ---------- bitmap cache ---------- */
  const cache = new Map(); let cachePx = 0; const STATS = {};
  const cacheKey = (c, layer, L) => `${c.key}|${layer}|${L}|${cam.rot}|${night ? 1 : 0}`;
  function cacheGet(k) { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); } return v; }
  function cachePut(k, v) {
    cache.set(k, v); cachePx += v.cv.width * v.cv.height;
    for (const [kk, vv] of cache) { if (cachePx <= MAX_CACHE_PX) break; cache.delete(kk); cachePx -= vv.cv.width * vv.cv.height; }
  }
  function makeBitmap(c, layer, L) {
    const b = 2 ** -L; const [a, top, d, e] = layer === "o" ? chunkIsoBounds(c) : chunkIsoBounds(c, 6);
    const tTop = layer === "o" ? top : top + c.maxH * HF; // flat layers need no headroom
    const w = Math.max(1, Math.ceil((d - a) * b)), h = Math.max(1, Math.ceil((e - tTop) * b));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const g = cv.getContext("2d");
    const T = (x, z, hgt = 0) => { const [ix, iy] = iso(x, z); return [(ix - a) * b, (iy - hgt * HF - tTop) * b]; };
    const ctxInfo = { a, top: tTop, b, L, c }; const tm = performance.now();
    if (layer === "g") drawGround(g, c, T, ctxInfo);
    else if (layer === "w") drawWaterMask(g, c, T, ctxInfo);
    else if (layer === "x") drawBridges(g, c, T, ctxInfo);
    else drawObjects(g, c, T, ctxInfo);
    STATS[layer] = (STATS[layer] || 0) + performance.now() - tm;
    return { cv, a, top: tTop, b };
  }

  /* ---------- small drawing helpers ---------- */
  function pathFlat(g, T, rec, x0, z0, start = 1) {
    g.beginPath();
    for (let i = start; i < rec.length; i += 2) { const [sx, sy] = T(x0 + rec[i] / 2, z0 + rec[i + 1] / 2); i > start ? g.lineTo(sx, sy) : g.moveTo(sx, sy); }
    g.closePath();
  }
  // ground record: [class, x,z…] or, with holes, [class + 128, n, x,z…, n, x,z…]
  function groundPath(g, T, rec, x0, z0) {
    if (!(rec[0] & 128)) return pathFlat(g, T, rec, x0, z0);
    g.beginPath(); let o = 1;
    while (o < rec.length) { const n = rec[o++]; for (let i = 0; i < n; i++) { const [sx, sy] = T(x0 + rec[o + i * 2] / 2, z0 + rec[o + i * 2 + 1] / 2); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); } g.closePath(); o += n * 2; }
  }
  function pathLine(g, T, rec, x0, z0) {
    g.beginPath();
    for (let i = 1; i < rec.length; i += 2) { const [sx, sy] = T(x0 + rec[i] / 2, z0 + rec[i + 1] / 2); i > 1 ? g.lineTo(sx, sy) : g.moveTo(sx, sy); }
  }
  // world-anchored pattern so tiles line up across chunks
  const patCache = new Map();
  function pattern(g, kind, info) {
    const key = kind + "|" + info.L + "|" + (night ? 1 : 0);
    let tile = patCache.get(key);
    if (!tile) {
      const s = info.b; const pal = G();
      const size = Math.max(4, Math.round(16 * s)); tile = document.createElement("canvas"); tile.width = tile.height = size;
      const t = tile.getContext("2d");
      if (kind === "grass") { t.fillStyle = "rgba(40,70,20,0.13)"; for (let i = 0; i < 6; i++) t.fillRect(((i * 7) % 16) * s, ((i * 11 + 3) % 16) * s, Math.max(1, s), Math.max(1, s)); t.fillStyle = "rgba(255,255,220,0.12)"; for (let i = 0; i < 4; i++) t.fillRect(((i * 5 + 9) % 16) * s, ((i * 13 + 1) % 16) * s, Math.max(1, s), Math.max(1, s)); }
      else if (kind === "stripes") { t.fillStyle = "rgba(255,255,255,0.12)"; t.fillRect(0, 0, size, size / 2); }
      else if (kind === "parking") { t.strokeStyle = night ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.55)"; t.lineWidth = Math.max(1, s * 0.6); for (let x = 0; x < 16; x += 4) { t.beginPath(); t.moveTo(x * s, 2 * s); t.lineTo(x * s, 7 * s); t.moveTo(x * s, 9 * s); t.lineTo(x * s, 14 * s); t.stroke(); } }
      else if (kind === "gravel") { t.fillStyle = "rgba(60,50,40,0.18)"; for (let i = 0; i < 10; i++) t.fillRect(((i * 7) % 16) * s, ((i * 3 + i * i) % 16) * s, Math.max(1, s), Math.max(1, s)); }
      else if (kind === "wood") { t.fillStyle = "rgba(20,50,15,0.25)"; for (let i = 0; i < 5; i++) { t.beginPath(); t.arc(((i * 7) % 16) * s, ((i * 5 + 4) % 16) * s, 2.2 * s, 0, 7); t.fill(); } }
      void pal; patCache.set(key, tile);
    }
    const p = g.createPattern(tile, "repeat");
    const m = new DOMMatrix().translate((-info.a * info.b) % tile.width, (-info.top * info.b) % tile.height);
    p.setTransform(m);
    return p;
  }

  /* ---------- ground layer ---------- */
  function drawGround(g, c, T, info) {
    const pal = G(); const x0 = c.cx * C, z0 = c.cz * C; const b = info.b;
    const e = 1.5;
    g.beginPath(); [[x0 - e, z0 - e], [x0 + C + e, z0 - e], [x0 + C + e, z0 + C + e], [x0 - e, z0 + C + e]].forEach(([x, z], i) => { const [sx, sy] = T(x, z); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
    g.closePath(); g.fillStyle = pal.base; g.fill(); g.clip();
    const d = c.data;
    for (const rec of d.g) {
      const k = rec[0] & 127; if (k >= 40) continue;
      groundPath(g, T, rec, x0, z0);
      g.fillStyle = pal[k] || pal.base; g.fill("evenodd");
      if (info.L <= 2 && !night) {
        const pat = k === 0 || k === 5 || k === 2 ? "grass" : k === 1 ? "stripes" : k === 15 ? "parking" : k === 13 || k === 14 ? "gravel" : k === 3 ? "wood" : null;
        if (pat) { g.fillStyle = pattern(g, pat, info); g.fill("evenodd"); }
      }
      if (k === 30) { g.strokeStyle = pal.waterEdge; g.lineWidth = Math.max(1, 2.5 * b); g.stroke(); }
    }
    // roads, rails and canals (bridges are drawn in their own layer, above the water)
    g.lineJoin = "round"; g.lineCap = "round";
    for (const r of d.r) { if ((r[0] & 31) !== 9 || r[0] & 32) continue; pathLine(g, T, r, x0, z0); g.strokeStyle = pal[30]; g.lineWidth = Math.max(1, 13 * b); g.stroke(); }
    for (const r of d.r) { const k = r[0] & 31; if (k !== 7 && k !== 8 || r[0] & 32) continue; pathLine(g, T, r, x0, z0); g.strokeStyle = pal.rail; g.lineWidth = Math.max(1, (k === 7 ? 7 : 5) * b); g.stroke(); }
    for (const pass of [0, 1]) for (const kind of ROAD_ORDER) for (const r of d.r) {
      if (r[0] !== kind) continue;
      pathLine(g, T, r, x0, z0);
      if (pass === 0) { if (kind === 5) continue; g.strokeStyle = pal.kerb; g.lineWidth = Math.max(1, (ROAD_W[kind] + 3) * b); g.stroke(); }
      else { g.strokeStyle = pal.road[kind]; g.lineWidth = Math.max(kind >= 4 ? 0.7 : 1, ROAD_W[kind] * b); g.stroke(); }
    }
    if (info.L === 0) {
      g.lineCap = "butt";
      for (const r of d.r) {
        const k = r[0] & 31; if (r[0] & 32) continue;
        if (k <= 2) { pathLine(g, T, r, x0, z0); g.strokeStyle = night ? "rgba(255,240,200,0.18)" : "rgba(255,255,255,0.55)"; g.lineWidth = 0.8; g.setLineDash([3, 4]); g.stroke(); g.setLineDash([]); }
        if (k === 7 || k === 8) { pathLine(g, T, r, x0, z0); g.strokeStyle = pal.railLine; g.lineWidth = 2.2; g.setLineDash([0.8, 1.2]); g.stroke(); g.setLineDash([]); }
        if (night && k <= 2) { pathLine(g, T, r, x0, z0); g.strokeStyle = pal.lamp; g.globalAlpha = 0.6; g.lineWidth = 1.4; g.setLineDash([1.2, 10]); g.stroke(); g.setLineDash([]); g.globalAlpha = 1; }
      }
      g.lineCap = "round";
    }
    // soft building and tree shadows (sun from the upper left)
    if (pal.shadow > 0 && info.L <= 4) {
      const sh = document.createElement("canvas"); sh.width = g.canvas.width; sh.height = g.canvas.height; const s = sh.getContext("2d"); s.fillStyle = "#000";
      const [svx, svz] = unrotXZ(0.9, -0.15);
      for (const rec of d.b) {
        const h = rec[0] / 2, minH = rec[1] / 2; if (minH > 2) continue; const len = Math.min(150, h * 0.5);
        const vx = svx * len, vz = svz * len; let o = 9; const n = rec[o];
        const P = []; for (let i = 0; i < n; i++) P.push([x0 + rec[o + 1 + i * 2] / 2, z0 + rec[o + 2 + i * 2] / 2]);
        s.beginPath();
        for (let i = 0; i < n; i++) { const p = P[i], q = P[(i + 1) % n]; const a1 = T(p[0], p[1]), a2 = T(q[0], q[1]), a3 = T(q[0] + vx, q[1] + vz), a4 = T(p[0] + vx, p[1] + vz); s.moveTo(a1[0], a1[1]); s.lineTo(a2[0], a2[1]); s.lineTo(a3[0], a3[1]); s.lineTo(a4[0], a4[1]); s.closePath(); }
        s.fill("nonzero");
      }
      for (const [mi, mx, mz] of d.m) { const md = MODELS.get(modelIds[mi]); if (!md) continue; const x = x0 + mx / 2, z = z0 + mz / 2; const r = Math.min(md.rad, 40), len = Math.min(160, md.maxH * 0.5); const [ax, ay] = T(x, z), [bx, by] = T(x + svx * len, z + svz * len); s.lineWidth = r * b; s.lineCap = "round"; s.strokeStyle = "#000"; s.beginPath(); s.moveTo(ax, ay); s.lineTo(bx, by); s.stroke(); }
      if (info.L <= 2) for (let i = 0; i < d.t.length; i += 2) { const [sx, sy] = T(x0 + d.t[i] / 2 + svx * 3, z0 + d.t[i + 1] / 2 + svz * 3); s.beginPath(); s.ellipse(sx, sy, 3.4 * b, 1.8 * b, 0, 0, 7); s.fill(); }
      g.globalAlpha = pal.shadow; g.drawImage(sh, 0, 0); g.globalAlpha = 1;
    }
  }
  function drawWaterMask(g, c, T, info) {
    const x0 = c.cx * C, z0 = c.cz * C; g.fillStyle = "#fff"; g.strokeStyle = "#fff"; g.lineJoin = "round"; g.lineCap = "round";
    for (const rec of c.data.g) { if ((rec[0] & 127) !== 30) continue; groundPath(g, T, rec, x0, z0); g.fill("evenodd"); }
    for (const r of c.data.r) { if ((r[0] & 31) !== 9 || r[0] & 32) continue; pathLine(g, T, r, x0, z0); g.lineWidth = Math.max(1, 12 * info.b); g.stroke(); }
  }
  function drawBridges(g, c, T, info) {
    const pal = G(); const x0 = c.cx * C, z0 = c.cz * C; const b = info.b; const d = c.data;
    g.lineJoin = "round";
    for (const rec of d.g) {
      const k = rec[0] & 127; if (k < 40) continue;
      g.save(); g.translate(0, 2.5 * b); groundPath(g, T, rec, x0, z0); g.fillStyle = night ? "#10151f" : "rgba(30,40,55,0.35)"; g.fill("evenodd"); g.restore();
      groundPath(g, T, rec, x0, z0); g.fillStyle = pal[k]; g.fill("evenodd"); g.strokeStyle = night ? "#2a2f3c" : "#6d6658"; g.lineWidth = Math.max(1, b); g.stroke();
    }
    for (const r of d.r) {
      if (!(r[0] & 32)) continue; const k = r[0] & 31;
      const w = k === 7 || k === 8 ? 8 : k === 9 ? 12 : ROAD_W[k] ?? 6;
      g.lineCap = "butt";
      g.save(); g.translate(0, 3 * b); pathLine(g, T, r, x0, z0); g.strokeStyle = night ? "#0d1220" : "rgba(25,35,50,0.4)"; g.lineWidth = Math.max(1, (w + 4) * b); g.stroke(); g.restore();
      pathLine(g, T, r, x0, z0); g.strokeStyle = night ? "#3a3f4e" : "#8e8a82"; g.lineWidth = Math.max(1, (w + 4) * b); g.stroke();
      pathLine(g, T, r, x0, z0); g.strokeStyle = k === 7 || k === 8 ? pal.rail : k === 9 ? pal[30] : pal.road[k] || pal.road[3]; g.lineWidth = Math.max(1, w * b); g.stroke();
      if (info.L === 0 && k <= 2) { pathLine(g, T, r, x0, z0); g.strokeStyle = night ? "rgba(255,240,200,0.2)" : "rgba(255,255,255,0.5)"; g.lineWidth = 0.8; g.setLineDash([3, 4]); g.stroke(); g.setLineDash([]); }
      if (night && info.L <= 1) { pathLine(g, T, r, x0, z0); g.strokeStyle = pal.lamp; g.lineWidth = 1.4; g.setLineDash([1.2, 9]); g.stroke(); g.setLineDash([]); }
    }
  }

  /* ---------- 3D polygons (landmarks, roofs, roof plant) ---------- */
  // Shading by rotated normal: tops brightest, left faces lit, right faces in shade.
  function shadeF(nx, ny, nz) { const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l; return 0.8 + 0.2 * ny + 0.14 * nz - 0.1 * nx; }
  // polys: {v: [[x,y,z]…] world, c: rgb, two, flat, glow, w (line width m), n, dash}
  function drawPolys(g, T, polys, b, seed = 0) {
    const items = [];
    for (const p of polys) {
      const R = p.v.map(([x, y, z]) => { const [rx, rz] = rotXZ(x, z); return [rx, y, rz]; });
      let dsum = 0; for (const v of R) dsum += v[0] + v[1] + v[2]; const depth = dsum / R.length;
      if (p.w) {
        if (p.n) { const [nx, nz] = rotXZ(p.n[0], p.n[2]); if (nx + p.n[1] + nz <= 0.01) continue; }
        items.push({ p, R, depth: depth + 0.05, line: true }); continue;
      }
      let nx = 0, ny = 0, nz = 0; for (let i = 0; i < R.length; i++) { const a = R[i], c = R[(i + 1) % R.length]; nx += (a[1] - c[1]) * (a[2] + c[2]); ny += (a[2] - c[2]) * (a[0] + c[0]); nz += (a[0] - c[0]) * (a[1] + c[1]); }
      const facing = nx + ny + nz;
      if (facing <= 0 && !p.two && !p.flat) continue;
      if (facing <= 0) { nx = -nx; ny = -ny; nz = -nz; }
      items.push({ p, R, depth, f: p.flat ? 1 : shadeF(nx, ny, nz) });
    }
    items.sort((a, q) => a.depth - q.depth);
    let k = seed;
    for (const it of items) {
      const p = it.p;
      let col;
      if (night) { const lit = p.glow && (p.glow !== true || hash(++k * 7 + seed) > 0.4); col = lit ? (Array.isArray(p.glow) ? p.glow : hexA(GROUND_NIGHT.lit[(hash(k * 13) * 5) | 0])) : nightA(mulA(p.c, it.f || 1), 0.3); }
      else col = it.f ? mulA(p.c, it.f) : p.c;
      g.beginPath();
      p.v.forEach(([x, y, z], i) => { const [sx, sy] = T(x, z, y); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); });
      if (it.line) {
        const [ax, ay] = T(p.v[0][0], p.v[0][2], p.v[0][1]), [bx, by] = T(p.v[1][0], p.v[1][2], p.v[1][1]);
        g.strokeStyle = cs(col); g.lineWidth = Math.max(1, p.w * b * 1.2);
        if (p.dash) { const L3 = Math.hypot(p.v[1][0] - p.v[0][0], p.v[1][1] - p.v[0][1], p.v[1][2] - p.v[0][2]) || 1; const ppm = Math.hypot(bx - ax, by - ay) / L3; if (p.dash[0] * ppm >= 0.7) g.setLineDash([p.dash[0] * ppm, p.dash[1] * ppm]); else { g.globalAlpha = 0.5; } }
        g.lineCap = "butt"; g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      } else { g.closePath(); g.fillStyle = cs(col); g.fill(); }
    }
  }
  function boxPolys(x, z, w, d, y0, y1, c, ang = 0, top) {
    const co = Math.cos(ang), si = Math.sin(ang);
    const P = (u, v) => [x + u * co - v * si, z + u * si + v * co];
    const cr = [P(-w / 2, d / 2), P(w / 2, d / 2), P(w / 2, -d / 2), P(-w / 2, -d / 2)];
    const out = [];
    for (let i = 0; i < 4; i++) { const p = cr[i], q = cr[(i + 1) % 4]; out.push({ v: [[p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]]], c }); }
    out.push({ v: cr.map(([px, pz]) => [px, y1, pz]), c: top || c });
    return out;
  }

  /* ---------- objects layer ---------- */
  function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296; }
  function decode(rec, x0, z0) {
    const it = { h: rec[0] / 2, minH: rec[1] / 2, cls: rec[2], roof: rec[3], roofH: rec[4] / 2, wall: rec[5], roofc: rec[6], part: rec[7], rings: [] };
    let o = 9; for (let k = 0; k < rec[8]; k++) { const n = rec[o++]; const r = new Array(n); for (let i = 0; i < n; i++) r[i] = [x0 + rec[o + i * 2] / 2, z0 + rec[o + i * 2 + 1] / 2]; o += n * 2; it.rings.push(r); }
    return it;
  }
  function drawObjects(g, c, T, info) {
    if (!c.data) return;
    const x0 = c.cx * C, z0 = c.cz * C; const b = info.b, L = info.L;
    const items = [];
    for (const rec of c.data.b) {
      const it = decode(rec, x0, z0); const pts = it.rings[0]; const n = pts.length;
      let mx = 0, mz = 0; for (const p of pts) { mx += p[0]; mz += p[1]; } mx /= n; mz /= n; it.mx = mx; it.mz = mz;
      const [rx, rz] = rotXZ(mx, mz);
      let dmax = -1e9; for (const p of pts) { const [a, bb] = rotXZ(p[0], p[1]); if (a + bb > dmax) dmax = a + bb; }
      it.k = (rx + rz) * 0.5 + dmax * 0.5 + it.minH * 0.02; it.t = 0;
      it.id = (rec[9 + 1] * 7919 + rec[9 + 2] * 104729 + c.cx * 31 + c.cz * 17) | 0;
      items.push(it);
    }
    for (const [mi, mx, mz, r10] of c.data.m) { const x = x0 + mx / 2, z = z0 + mz / 2; const [rx, rz] = rotXZ(x, z); items.push({ t: 2, x, z, rot: r10 / 10, id: modelIds[mi], k: rx + rz + 6 }); }
    const tr = c.data.t;
    if (L <= 3) for (let i = 0; i < tr.length; i += 2) { const x = x0 + tr[i] / 2, z = z0 + tr[i + 1] / 2; const [rx, rz] = rotXZ(x, z); items.push({ k: rx + rz, t: 1, x, z, id: i * 31 + c.cx * 7 + c.cz }); }
    items.sort((p, q) => p.k - q.k);
    for (const it of items) {
      if (it.t === 1) drawTree(g, it, T, b);
      else if (it.t === 2) drawModel(g, it, T, b);
      else drawBuilding(g, it, T, b, L);
    }
    if (L <= 1) crispen(g);
  }

  function drawTree(g, it, T, b) {
    const pal = G(); const [sx, sy] = T(it.x, it.z); const s = 0.75 + hash(it.id) * 0.6;
    g.fillStyle = pal.tree[3]; g.fillRect(Math.round(sx - Math.max(1, b) / 2), Math.round(sy - 3.5 * b * s), Math.max(1, b), Math.max(1, 3.5 * b * s));
    const r = Math.max(1.1, 3.6 * b * s), cy = sy - 6 * b * s;
    g.fillStyle = pal.tree[0]; g.beginPath(); g.arc(sx, cy, r, 0, 7); g.fill();
    if (b >= 0.5) {
      g.beginPath(); g.arc(sx - r * 0.55, cy + r * 0.2, r * 0.7, 0, 7); g.arc(sx + r * 0.5, cy + r * 0.25, r * 0.65, 0, 7); g.fill();
      g.fillStyle = pal.tree[1]; g.beginPath(); g.arc(sx - r * 0.25, cy - r * 0.25, r * 0.6, 0, 7); g.fill();
      g.fillStyle = pal.tree[2]; g.beginPath(); g.arc(sx - r * 0.4, cy - r * 0.45, r * 0.28, 0, 7); g.fill();
    }
  }

  function drawModel(g, it, T, b) {
    const md = MODELS.get(it.id); if (!md) return;
    const th = it.rot * Math.PI / 180, co = Math.cos(th), si = Math.sin(th);
    if (!md.world || md.wkey !== it.x + "," + it.z + "," + it.rot) {
      md.world = md.polys.map((p) => ({ ...p, v: p.v.map(([x, y, z]) => [it.x + x * co - z * si, y, it.z + x * si + z * co]), n: p.n ? [p.n[0] * co - p.n[2] * si, p.n[1], p.n[0] * si + p.n[2] * co] : undefined }));
      md.wkey = it.x + "," + it.z + "," + it.rot;
    }
    drawPolys(g, T, md.world, b, it.x | 0);
  }

  function matColours(it) {
    const base = MAT_DAY[it.cls] || MAT_DAY[0];
    let lit = base[0], shade = base[1], roof = base[2], edge = base[3];
    if (it.wall >= 0) { const w = intA(it.wall); lit = mixA(lit, w, 0.65); shade = mixA(shade, mulA(w, 0.75), 0.65); }
    if (it.roofc >= 0) { const r = intA(it.roofc); roof = mixA(roof, r, 0.7); edge = mulA(roof, 0.75); }
    return { lit, shade, roof, edge, win: base[4], trim: base[5] };
  }
  const nc = (a) => (night ? nightA(a) : a);

  function drawBuilding(g, it, T, b, L) {
    const { rings, h, minH } = it; const pts = rings[0];
    const col = matColours(it);
    const pitched = [1, 3, 4, 6, 8].includes(it.roof) && it.roofH > 0.4 && rings.length === 1;
    const domed = (it.roof === 2 || it.roof === 7) && it.roofH > 0.4;
    const wallTop = pitched || domed ? h - it.roofH : h;
    // winding of the outer ring in rotated space; holes use the opposite winding already
    const R0 = pts.map((p) => rotXZ(p[0], p[1]));
    let A = 0; for (let i = 0, n = R0.length, j = n - 1; i < n; j = i++) A += R0[j][0] * R0[i][1] - R0[i][0] * R0[j][1];
    const sgn = A > 0 ? 1 : -1;
    const walls = [];
    for (const ring of rings) {
      const n = ring.length; const R = ring.map((p) => rotXZ(p[0], p[1]));
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n; const dx = R[j][0] - R[i][0], dz = R[j][1] - R[i][1];
        const nx = dz * sgn, nz = -dx * sgn;
        if (nx + nz <= 0) continue;
        const len = Math.hypot(dx, dz); if (len < 0.05) continue;
        walls.push({ p: ring[i], q: ring[j], t: (nx - nz) / (len * Math.SQRT2), len, d: R[i][0] + R[i][1] + R[j][0] + R[j][1] });
      }
    }
    walls.sort((a, q) => a.d - q.d);
    const winSpec = WIN[it.cls]; const shop = (it.cls <= 3 || it.cls === 10) && h > 8 && minH < 1 && hash(it.id * 3) < 0.38;
    for (const w of walls) {
      const G0 = T(w.p[0], w.p[1], minH), G1 = T(w.q[0], w.q[1], minH), R1 = T(w.q[0], w.q[1], wallTop), R2 = T(w.p[0], w.p[1], wallTop);
      g.beginPath(); g.moveTo(G0[0], G0[1]); g.lineTo(G1[0], G1[1]); g.lineTo(R1[0], R1[1]); g.lineTo(R2[0], R2[1]); g.closePath();
      const wc = w.t > 0.25 ? col.shade : w.t < -0.25 ? col.lit : mixA(col.lit, col.shade, (w.t + 1) / 2);
      g.fillStyle = cs(nc(wc)); g.fill();
      // windows: one dashed row per floor, sized in metres along the wall
      if (winSpec && wallTop - minH >= 5 && b >= 0.24 && w.len >= 2.5) {
        const [fh, ww, bay, wh, style] = winSpec;
        const ppm = Math.hypot(G1[0] - G0[0], G1[1] - G0[1]) / w.len;
        const ax = w.p[0] + (w.q[0] - w.p[0]) * (0.6 / w.len), az = w.p[1] + (w.q[1] - w.p[1]) * (0.6 / w.len);
        const bx = w.q[0] - (w.q[0] - w.p[0]) * (0.6 / w.len), bz = w.q[1] - (w.q[1] - w.p[1]) * (0.6 / w.len);
        const tiny = bay * ppm < 2.2;
        g.lineWidth = Math.max(1, wh * b * (tiny ? 0.6 : 1)); g.lineCap = "butt";
        const winC = mixA(col.win, wc, w.t > 0 ? 0.08 : 0);
        if (!tiny) g.setLineDash(style === 1 ? [Math.max(1, (bay - 0.18) * ppm), Math.max(0.5, 0.18 * ppm)] : [Math.max(1, ww * ppm), Math.max(1, (bay - ww) * ppm)]);
        const start = minH + (shop ? 4.2 : 1.4) + wh / 2; let row = 0;
        if (style === 1 && !night) { g.strokeStyle = cs(mixA(winC, col.trim, 0.25)); }
        for (let y = start; y < wallTop - 0.9; y += fh, row++) {
          if (L >= 2 && row % 2) continue;
          if (night) { const r = hash(it.id * 131 + row * 17 + (w.d | 0)); if (r < 0.42) continue; g.strokeStyle = GROUND_NIGHT.lit[(r * 997 | 0) % GROUND_NIGHT.lit.length]; g.lineDashOffset = (r * 13) % 6; }
          else if (style !== 1) g.strokeStyle = cs(tiny ? mixA(winC, wc, 0.45) : winC);
          const [p1x, p1y] = T(ax, az, y), [p2x, p2y] = T(bx, bz, y);
          g.beginPath(); g.moveTo(p1x, p1y); g.lineTo(p2x, p2y); g.stroke();
          if (style === 2 && !tiny && !night) { const [q1x, q1y] = T(ax, az, y - wh * 0.9), [q2x, q2y] = T(bx, bz, y - wh * 0.9); g.save(); g.setLineDash([]); g.strokeStyle = cs(col.trim); g.lineWidth = Math.max(1, 0.5 * b); g.beginPath(); g.moveTo(q1x, q1y); g.lineTo(q2x, q2y); g.stroke(); g.restore(); }
        }
        g.setLineDash([]); g.lineDashOffset = 0;
        if (shop && L <= 1) {
          const sc = ["#1f3d2e", "#5b1a1a", "#1d2b44", "#2a2a2a", "#6a4a1f", "#7a1f2b"][(hash(it.id) * 6) | 0];
          const [s1x, s1y] = T(ax, az, minH + 1.6), [s2x, s2y] = T(bx, bz, minH + 1.6);
          g.strokeStyle = night ? "#e9c27a" : cs(mixA(col.win, [30, 30, 30], 0.3)); g.lineWidth = Math.max(1, 2.6 * b); g.beginPath(); g.moveTo(s1x, s1y); g.lineTo(s2x, s2y); g.stroke();
          const [f1x, f1y] = T(ax, az, minH + 3.4), [f2x, f2y] = T(bx, bz, minH + 3.4);
          g.strokeStyle = night ? cs(nightA(hexA(sc), 0.6)) : sc; g.lineWidth = Math.max(1, 0.9 * b); g.beginPath(); g.moveTo(f1x, f1y); g.lineTo(f2x, f2y); g.stroke();
        }
      }
      // cornice
      if (!pitched && wallTop - minH > 8 && b >= 0.5 && it.cls !== 4 && it.cls !== 5) { g.strokeStyle = cs(nc(w.t > 0.25 ? mulA(col.trim, 0.82) : col.trim)); g.lineWidth = Math.max(1, 0.7 * b); g.beginPath(); g.moveTo(R2[0], R2[1] + 0.5 * b); g.lineTo(R1[0], R1[1] + 0.5 * b); g.stroke(); }
    }
    // roof
    if (pitched) { drawPitched(g, it, T, b, col, wallTop); }
    else {
      g.beginPath();
      for (const ring of rings) { ring.forEach((p, i) => { const [sx, sy] = T(p[0], p[1], wallTop); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); }); g.closePath(); }
      g.fillStyle = cs(nc(col.roof)); g.fill("evenodd"); g.strokeStyle = cs(nc(col.edge)); g.lineWidth = Math.max(1, b * (L === 0 ? 1 : 0.8)); g.stroke();
      if (it.roof === 5 && b >= 0.24) drawPitched(g, { ...it, roof: 1 }, T, b, col, h - Math.min(2, it.roofH));
      // roof plant: lift cores, AC units, water tanks
      if (L <= 1 && h > 9 && it.cls !== 7 && !domed) roofPlant(g, it, T, b, col);
    }
    if (domed) drawDome(g, it, T, b, col, wallTop);
    if (night && h > 60) {
      let top = T(pts[0][0], pts[0][1], h); for (const p of pts) { const s = T(p[0], p[1], h); if (s[1] < top[1]) top = s; }
      g.fillStyle = "#ff3b3b"; g.fillRect(Math.round(top[0]), Math.round(top[1] - 2 * b), Math.max(1, 1.5 * b), Math.max(1, 1.5 * b));
    }
  }

  function roofPlant(g, it, T, b, col) {
    const pts = it.rings[0]; let area = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); area = Math.abs(area / 2);
    if (area < 90) return;
    const n = Math.min(7, 1 + Math.floor(area / 260)); const polys = [];
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    const inside = (x, z) => { let c = false; for (const r of it.rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
    // edge angle for aligning boxes
    let bl = 0, ang = 0; for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; const l = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]); if (l > bl) { bl = l; ang = Math.atan2(pts[j][1] - pts[i][1], pts[j][0] - pts[i][0]); } }
    const plant = [mulA(col.roof, 1.18), [170, 172, 170], [140, 144, 146]];
    for (let k = 0; k < n * 2 && polys.length < n * 5; k++) {
      const r1 = hash(it.id * 97 + k * 13), r2 = hash(it.id * 61 + k * 29), r3 = hash(it.id * 17 + k * 7);
      const x = x0 + (x1 - x0) * (0.15 + r1 * 0.7), z = z0 + (z1 - z0) * (0.15 + r2 * 0.7);
      if (!inside(x, z)) continue;
      const big = k === 0 && it.h > 20; const w = big ? 4 + r3 * 4 : 1.5 + r3 * 2.5, d = big ? 3 + r1 * 3 : 1.2 + r2 * 2, hh = big ? 3 : 1 + r3 * 1.4;
      polys.push(...boxPolys(x, z, w, d, it.h, it.h + hh, plant[k % 3], ang));
    }
    drawPolys(g, T, polys, b, it.id);
  }

  // Pitched roofs: every eave edge slopes up to the nearest point on a ridge line.
  function drawPitched(g, it, T, b, col, wallTop) {
    const pts = it.rings[0]; const n = pts.length; const top = it.h;
    let bl = 0, best = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; const l = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]); if (l > bl) { bl = l; best = i; } }
    const j0 = (best + 1) % n; const ux = (pts[j0][0] - pts[best][0]) / bl, uz = (pts[j0][1] - pts[best][1]) / bl;
    let s0 = 1e9, s1 = -1e9, w0 = 1e9, w1 = -1e9; for (const [x, z] of pts) { const s = x * ux + z * uz, w = -x * uz + z * ux; s0 = Math.min(s0, s); s1 = Math.max(s1, s); w0 = Math.min(w0, w); w1 = Math.max(w1, w); }
    const wm = (w0 + w1) / 2, half = (w1 - w0) / 2;
    let a0 = s0, a1 = s1;
    if (it.roof === 3 || it.roof === 6) { a0 = Math.min((s0 + s1) / 2, s0 + half * 0.9); a1 = Math.max((s0 + s1) / 2, s1 - half * 0.9); }
    if (it.roof === 4 || it.roof === 2 || it.roof === 7) { a0 = a1 = (s0 + s1) / 2; }
    const at = (s) => [s * ux - wm * uz, s * uz + wm * ux];
    const polys = [];
    const roofC = it.roofc >= 0 ? col.roof : col.roof;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      const sp = Math.max(a0, Math.min(a1, p[0] * ux + p[1] * uz)), sq = Math.max(a0, Math.min(a1, q[0] * ux + q[1] * uz));
      const rp = at(sp), rq = at(sq);
      const v = Math.abs(sp - sq) < 0.05 ? [[p[0], wallTop, p[1]], [q[0], wallTop, q[1]], [rq[0], top, rq[1]]] : [[p[0], wallTop, p[1]], [q[0], wallTop, q[1]], [rq[0], top, rq[1]], [rp[0], top, rp[1]]];
      // vertical gable ends take the wall colour
      const vert = Math.abs(sp - sq) < 0.05 && it.roof === 1 && Math.abs((p[0] * ux + p[1] * uz) - (q[0] * ux + q[1] * uz)) < half * 0.6;
      polys.push({ v, c: vert ? col.lit : roofC });
    }
    drawPolys(g, T, polys, b, it.id);
    // ridge highlight and chimneys on brick terraces
    if (b >= 0.5 && a1 - a0 > 1) { const [r1x, r1y] = T(...at(a0), top), [r2x, r2y] = T(...at(a1), top); g.strokeStyle = cs(nc(col.edge)); g.lineWidth = Math.max(1, 0.5 * b); g.beginPath(); g.moveTo(r1x, r1y); g.lineTo(r2x, r2y); g.stroke(); }
    if (b >= 0.5 && it.cls <= 3 && hash(it.id * 5) < 0.8) {
      const ch = [];
      for (const s of [a0 + 0.6, a1 - 0.6]) { if (a1 - a0 < 3 && s !== a0 + 0.6) continue; const [x, z] = at(s); ch.push(...boxPolys(x, z, 0.9, 1.8, top - 0.6, top + 1.4, it.cls === 0 ? [140, 74, 56] : [170, 140, 100], Math.atan2(uz, ux))); }
      drawPolys(g, T, ch, b, it.id);
    }
  }
  function drawDome(g, it, T, b, col, wallTop) {
    const pts = it.rings[0]; let mx = 0, mz = 0; for (const p of pts) { mx += p[0]; mz += p[1]; } mx /= pts.length; mz /= pts.length;
    let r = 1e9; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; const d = Math.abs((q[0] - p[0]) * (p[1] - mz) - (p[0] - mx) * (q[1] - p[1])) / L; r = Math.min(r, d); }
    r = Math.max(1, r * 0.95); const hgt = Math.max(1, it.h - wallTop); const polys = []; const seg = 14, rings = 4;
    for (let k = 0; k < rings; k++) {
      const a0 = (k / rings) * Math.PI / 2, a1 = ((k + 1) / rings) * Math.PI / 2; const y0 = wallTop + Math.sin(a0) * hgt, y1 = wallTop + Math.sin(a1) * hgt; const r0 = Math.cos(a0) * r * (it.roof === 7 && k === 1 ? 1.15 : 1), r1 = Math.cos(a1) * r;
      for (let s = 0; s < seg; s++) { const t0 = (s / seg) * Math.PI * 2, t1 = ((s + 1) / seg) * Math.PI * 2;
        const v = [[mx + Math.cos(t1) * r0, y0, mz + Math.sin(t1) * r0], [mx + Math.cos(t0) * r0, y0, mz + Math.sin(t0) * r0], [mx + Math.cos(t0) * r1, y1, mz + Math.sin(t0) * r1]];
        if (r1 > 0.05) v.push([mx + Math.cos(t1) * r1, y1, mz + Math.sin(t1) * r1]);
        polys.push({ v, c: col.roof }); }
    }
    drawPolys(g, T, polys, b, it.id);
  }
  // Hard alpha edges: no half-transparent anti-aliasing, so the bitmap reads as pixel art.
  function crispen(g) {
    const { width: w, height: h } = g.canvas; if (w * h > 5e6) return;
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] > 110 ? 255 : 0;
    g.putImageData(img, 0, 0);
  }

  /* ---------- water animation ---------- */
  const fx = document.createElement("canvas"), fxc = fx.getContext("2d");
  const waveTiles = [];
  function buildWaveTiles() {
    waveTiles.length = 0;
    for (let f = 0; f < 4; f++) {
      const t = document.createElement("canvas"); t.width = 64; t.height = 32; const g = t.getContext("2d");
      const marks = [[4, 5], [22, 3], [40, 9], [54, 4], [12, 17], [30, 21], [48, 18], [6, 27], [36, 28], [58, 25]];
      marks.forEach(([x, y], i) => {
        const ph = (f + i) % 4; const xx = (x + f * 2) % 64;
        if (ph === 3) return;
        g.fillStyle = G().wave; const w = ph === 1 ? 6 : 4;
        g.fillRect(xx, y, w, 1); g.fillRect(xx + 1, y - 1, w - 2, 1);
        g.fillStyle = G().waveDark; g.fillRect(xx + 1, y + 1, w - 1, 1);
      });
      waveTiles.push(t);
    }
  }

  /* ---------- the whale ---------- */
  const route = (meta.whale || []).map(([x, z]) => [x, z]);
  const seg = []; let routeLen = 0;
  for (let i = 0; i < route.length - 1; i++) { const l = Math.hypot(route[i + 1][0] - route[i][0], route[i + 1][1] - route[i][1]); seg.push(l); routeLen += l; }
  function routeAt(s) {
    s = Math.max(0, Math.min(routeLen - 0.01, s));
    for (let i = 0; i < seg.length; i++) { if (s <= seg[i]) { const t = s / seg[i]; const a = route[i], b = route[i + 1]; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; } s -= seg[i]; }
    return route[route.length - 1];
  }
  // start the whale near the opening view
  let whaleS0 = 0; { let bd = 1e18; for (let s = 0; s < routeLen; s += 25) { const [x, z] = routeAt(s); const d = Math.hypot(x - meta.start.x, z - meta.start.z); if (d < bd) { bd = d; whaleS0 = s; } } }
  const WHALE_SPEED = 7; // metres per second
  const t0Whale = performance.now();
  function whaleState(now) {
    if (!routeLen) return null;
    const t = REDUCED ? 0 : (now - t0Whale) / 1000;
    const span = routeLen * 2; let u = (whaleS0 + t * WHALE_SPEED) % span; const dir = u < routeLen ? 1 : -1; const s = dir > 0 ? u : span - u;
    const [x, z] = routeAt(s), [x2, z2] = routeAt(s + dir * 6);
    return { x, z, hx: x2 - x, hz: z2 - z, t };
  }
  // 34 × 15 pixel sprite, facing right; frame 0–3 flicks the tail
  const WHALE = [
    "..................................",
    "..................................",
    "..................................",
    "..................................",
    "...............bbbbbbbbb..........",
    ".............bbBBBBBBBBBbb........",
    "...........bbBBBBBBBBBBBBBbb......",
    "..T.....bbbBBBBBBBBBBBBBBBBBb.....",
    ".TTT..bbBBBBBBBBBBBBBBBBBBBBBb....",
    "TTTTbbBBBBBBBBBBBBBBBBBBBBBeBBb...",
    "TTTbBBBBBBBBBBBBBBBBBBBBBBBBBBBb..",
    ".TT.bbWWWWWWWWWWWWWWWWWWWWWBBBBb..",
    "..T...bWWWWWWWWWWWWWWWWWWWWWWBb...",
    ".......wwwwwwwwwwwwwwwwwwwwww.....",
    "..................................",
  ];
  const whaleCanvas = document.createElement("canvas"); whaleCanvas.width = 34; whaleCanvas.height = 24;
  function paintWhale(frame, spout, sink) {
    const g = whaleCanvas.getContext("2d"); g.clearRect(0, 0, 34, 24);
    const pal = night ? { b: "#1f3550", B: "#2b4a6e", W: "#5f7a92", e: "#0a0f18", T: "#24405f", w: "#4f86b8", s: "#9fc7e6", h: "#3b5f87" }
                      : { b: "#2f4f72", B: "#4f77a3", W: "#c9d8e4", e: "#10161f", T: "#3c6189", w: "#9fd5f5", s: "#ffffff", h: "#8fb3d6" };
    const OFF = 8, water = 13 - sink;
    WHALE.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const ch = row[x]; if (ch === "." || ch === "w") continue;
      let yy = y; if (ch === "T" && x < 3) yy += [0, -1, 0, 1][frame];
      if (yy >= water) continue;
      g.fillStyle = pal[ch] || pal.B; g.fillRect(x, yy + OFF, 1, 1); } });
    if (sink < 5) { g.fillStyle = pal.h; for (let x = 14; x < 24; x++) g.fillRect(x, 6 + OFF, 1, 1); }
    g.fillStyle = pal.w; for (let x = 3; x < 32; x += 3) g.fillRect((x + frame) % 34, water + OFF, 2, 1);
    if (sink >= 10) { g.fillRect(12, water + OFF - 1, 1, 1); g.fillRect(20, water + OFF - 1, 1, 1); }
    if (spout > 0) {
      g.fillStyle = pal.s; const top = Math.round(8 * spout); const bx = 23, by = 4 + OFF;
      for (let k = 0; k < top; k++) { g.fillRect(bx, by - k, 1, 1); if (k > top - 3) { g.fillRect(bx - (top - k), by - k, 1, 1); g.fillRect(bx + (top - k), by - k, 1, 1); } }
    }
  }
  function drawWhale(now) {
    const st = whaleState(now); if (!st || cam.zoom < 0.18) return;
    const [ix, iy] = iso(st.x, st.z); const [sx, sy] = toScreen(ix, iy);
    if (sx < -200 || sx > W + 200 || sy < -200 || sy > H + 200) return;
    const [hx1, hy1] = iso(st.x + st.hx, st.z + st.hz); const right = hx1 - ix >= 0;
    const cyc = REDUCED ? 5 : st.t % 60; const frame = REDUCED ? 0 : Math.floor(st.t * 4) % 4;
    let sink = 0; if (cyc > 50 && cyc < 52.5) sink = Math.round((cyc - 50) / 2.5 * 10); else if (cyc >= 52.5 && cyc < 57) sink = 11; else if (cyc >= 57) sink = Math.round((60 - cyc) / 3 * 10);
    const sp = [3, 13, 23, 33, 43].map((t0) => cyc - t0).find((d) => d >= 0 && d < 1.6); const spout = sp != null ? Math.sin((sp / 1.6) * Math.PI) : 0;
    paintWhale(frame, spout, sink);
    const scale = Math.max(1, (46 / 34) * cam.zoom); const w = 34 * scale, h = 24 * scale;
    ctx.save(); ctx.imageSmoothingEnabled = false;
    ctx.translate(Math.round(sx), Math.round(sy));
    // wake behind the whale
    if (sink < 11 && !REDUCED) { ctx.fillStyle = night ? "rgba(140,190,230,0.35)" : "rgba(255,255,255,0.7)"; for (let k = 1; k < 6; k++) { const off = (right ? -1 : 1) * (w * 0.45 + k * 4 * scale); ctx.fillRect(Math.round(off), Math.round(-k * 0.8 * scale), Math.max(1, scale), Math.max(1, scale)); ctx.fillRect(Math.round(off), Math.round(k * 0.8 * scale + 2 * scale), Math.max(1, scale), Math.max(1, scale)); } }
    if (!right) ctx.scale(-1, 1);
    ctx.drawImage(whaleCanvas, Math.round(-w / 2), Math.round(-h * 0.7), Math.round(w), Math.round(h));
    ctx.restore();
  }
  function whaleOnScreen(now) {
    const st = whaleState(now); if (!st) return false;
    const [sx, sy] = toScreen(...iso(st.x, st.z)); return sx > -100 && sx < W + 100 && sy > -100 && sy < H + 100 && cam.zoom >= 0.18;
  }

  /* ---------- frame ---------- */
  let dirty = true, pending = 0, lastAnim = 0;
  const status = $("#status");
  function resize() { DPR = Math.min(2, devicePixelRatio || 1); W = innerWidth; H = innerHeight; canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR); fx.width = canvas.width; fx.height = canvas.height; dirty = true; }
  addEventListener("resize", resize); resize();
  buildWaveTiles();

  function frame(now) {
    requestAnimationFrame(frame);
    if (fly) stepFly();
    const animate = !REDUCED && now - lastAnim > 66 && (waterVisible || whaleOnScreen(now));
    if (!dirty && !animate) return;
    if (animate) lastAnim = now;
    dirty = false;
    const t0 = performance.now();
    const pal = G();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = pal.outside; ctx.fillRect(0, 0, W, H);
    const [cx, cy] = iso(cam.x, cam.z);
    const vx0 = cx - W / 2 / cam.zoom, vx1 = cx + W / 2 / cam.zoom, vy0 = cy - H / 2 / cam.zoom, vy1 = cy + H / 2 / cam.zoom;
    const L = Math.max(0, Math.min(6, Math.floor(Math.log2(1 / (cam.zoom * DPR)) + 0.0001)));
    const vis = [];
    for (const c of chunks) { const [a, b, d, e] = chunkIsoBounds(c); if (d < vx0 || a > vx1 || e < vy0 || b > vy1) continue; vis.push(c); }
    vis.sort((p, q) => chunkDepth(p) - chunkDepth(q));
    const byDist = vis.slice().sort((p, q) => Math.hypot((p.cx + 0.5) * C - cam.x, (p.cz + 0.5) * C - cam.z) - Math.hypot((q.cx + 0.5) * C - cam.x, (q.cz + 0.5) * C - cam.z));
    let inflight = chunks.filter((c) => c.loading).length;
    for (const c of byDist) { if (inflight >= 8) break; if (!c.data && !c.loading) { load(c); inflight++; } }
    pending = 0;
    // build missing bitmaps first (nearest chunks first), within a time budget
    const tb = performance.now(); const budget = 28;
    const need = (c) => ["g", c.water ? "w" : null, c.bridges ? "x" : null, "o"].filter(Boolean);
    outer: for (const c of byDist) {
      if (!c.data) continue;
      for (const layer of need(c)) { const k = cacheKey(c, layer, L); if (cache.has(k)) continue; if (performance.now() - tb > budget) break outer; cachePut(k, makeBitmap(c, layer, L)); }
    }
    const blit = (target, c, layer) => {
      const k = cacheKey(c, layer, L);
      let bm = cacheGet(k);
      if (!bm) { pending++; for (const dl of [1, -1, 2, -2, 3]) { const alt = cache.get(cacheKey(c, layer, L + dl)); if (alt) { bm = alt; break; } } }
      if (!bm) return;
      const sx = (bm.a - cx) * cam.zoom + W / 2, sy = (bm.top - cy) * cam.zoom + H / 2;
      const s = cam.zoom / bm.b;
      const grow = layer === "g" ? 1 / DPR : 0;
      target.drawImage(bm.cv, Math.round(sx * DPR) / DPR, Math.round(sy * DPR) / DPR, bm.cv.width * s + grow, bm.cv.height * s + grow);
    };
    for (const c of vis) { if (!c.data) { pending++; continue; } blit(ctx, c, "g"); }
    // animated waves, masked to the water
    waterVisible = vis.some((c) => c.data && c.water);
    if (waterVisible && cam.zoom >= 0.2) {
      fxc.setTransform(DPR, 0, 0, DPR, 0, 0); fxc.globalCompositeOperation = "source-over"; fxc.clearRect(0, 0, W, H); fxc.imageSmoothingEnabled = false;
      for (const c of vis) if (c.data && c.water) blit(fxc, c, "w");
      fxc.globalCompositeOperation = "source-in";
      const fr = REDUCED ? 0 : Math.floor(now / 260) % 4; const tile = waveTiles[fr];
      const p = fxc.createPattern(tile, "repeat"); const drift = REDUCED ? 0 : (now / 1000) * 3;
      p.setTransform(new DOMMatrix().translate((-cx * cam.zoom + W / 2) + drift * cam.zoom, (-cy * cam.zoom + H / 2)).scale(cam.zoom));
      fxc.fillStyle = p; fxc.fillRect(0, 0, W, H);
      fxc.globalCompositeOperation = "source-over";
      ctx.globalAlpha = Math.min(1, (cam.zoom - 0.2) / 0.3); ctx.drawImage(fx, 0, 0, W, H); ctx.globalAlpha = 1;
    }
    drawWhale(now);
    for (const c of vis) if (c.data && c.bridges) blit(ctx, c, "x");
    for (const c of vis) if (c.data) blit(ctx, c, "o");
    if (pending) { dirty = true; status.hidden = false; status.textContent = `Laying bricks… ${pending} left`; }
    else status.hidden = true;
  }
  let waterVisible = false;
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
  function toggleNight() { night = !night; document.documentElement.classList.toggle("night", night); $("#night").setAttribute("aria-pressed", night); patCache.clear(); buildWaveTiles(); dirty = true; }
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
  function flyTo(x, z, zoom) { fly = { x0: cam.x, z0: cam.z, zm0: cam.zoom, x, z, zoom, t0: performance.now(), dur: REDUCED ? 1 : 1400 }; }
  function stepFly() {
    const f = fly; const u = Math.min(1, (performance.now() - f.t0) / f.dur); const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
    const tx = typeof f.x === "function" ? f.x() : [f.x, f.z];
    cam.x = f.x0 + (tx[0] - f.x0) * e; cam.z = f.z0 + (tx[1] - f.z0) * e;
    const dist = Math.hypot(tx[0] - f.x0, tx[1] - f.z0); const out = Math.min(1, 300 / (dist + 1));
    const zl = Math.log(f.zm0) + (Math.log(f.zoom) - Math.log(f.zm0)) * e; cam.zoom = Math.exp(zl) * (1 - Math.sin(e * Math.PI) * (1 - Math.max(out, 0.25)));
    dirty = true; if (u >= 1) { fly = null; saveHash(); }
  }

  /* ---------- landmarks & search ---------- */
  const marks = $("#marks");
  for (const [name, x, z] of meta.landmarks) { const b = document.createElement("button"); b.type = "button"; b.textContent = name; b.addEventListener("click", () => flyTo(x, z, 1.5)); marks.appendChild(b); }
  if (routeLen) { const b = document.createElement("button"); b.type = "button"; b.className = "whale"; b.textContent = "Find the whale"; b.addEventListener("click", () => { const st = whaleState(performance.now() + 1400); flyTo(st.x, st.z, 2.5); }); marks.appendChild(b); }
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
  window.__iso = { STATS: () => STATS, cam, setDirty: () => { dirty = true; }, flyTo, get pending() { return pending; } };
})();
