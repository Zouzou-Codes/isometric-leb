// Hand-built 3D models of London's landmarks, drawn by iso.js with the same pixel-art shading
// as the rest of the city.
//
// Each model is a list of flat polygons in local metres: x = east, y = up, z = south, with the
// origin on the ground at the landmark's anchor point (set in config.json, or snapped to the
// matching OpenStreetMap building by scripts/build.mjs). iso.js rotates, lights, depth-sorts
// and paints them. Proportions come from published heights and footprints.
"use strict";
(function () {
  /* ---------- colours ---------- */
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const K = {
    gold: hex("#d8bd84"), goldDark: hex("#a98d58"), gilt: hex("#d9b23f"), anston: hex("#dcc591"),
    portland: hex("#ebe5d6"), portlandDark: hex("#c9c1ae"), lead: hex("#8c959b"), leadDark: hex("#6c757b"),
    slate: hex("#5a6672"), slateDark: hex("#434d57"), iron: hex("#3f4650"), white: hex("#f2f0ea"), offwhite: hex("#e6e2d8"),
    glass: hex("#9ec0d2"), glassDark: hex("#5f8296"), glassTeal: hex("#4f7f8c"), glassDeep: hex("#3b5d6c"), steel: hex("#cdd3d7"),
    stock: hex("#cdb07c"), redbrick: hex("#a5563f"), darkbrick: hex("#7a4433"), terracotta: hex("#cfac7c"), tcBlue: hex("#8f9aa6"),
    concrete: hex("#b7b2a8"), concreteDark: hex("#8b867c"), dark: hex("#2e3035"), window: hex("#3c4148"), windowStone: hex("#5a5650"),
    bronze: hex("#6b5a43"), green: hex("#6f9a86"), blue: hex("#86b0d0"), blueDark: hex("#5b86ad"), yellow: hex("#e8c536"),
    red: hex("#c8102e"), navy: hex("#012169"), clock: hex("#f3ecd4"), water: hex("#5aa3d6"), gravel: hex("#cfc6b2")
  };

  /* ---------- builder ---------- */
  function B() { this.p = []; }
  const P = B.prototype;
  // polygon: pts [[x,y,z]…], c colour, o options {two: double-sided, flat: unlit, glow: night colour}
  P.poly = function (pts, c, o) { this.p.push({ v: pts, c, two: o?.two, flat: o?.flat, glow: o?.glow }); return this; };
  P.line = function (a, b, c, w = 0.6, o) { this.p.push({ v: [a, b], c, w, n: o?.n, dash: o?.dash, glow: o?.glow }); return this; };
  P.quad = function (a, b, c2, d, c, o) { return this.poly([a, b, c2, d], c, o); };
  // axis-aligned box; top colour optional
  P.box = function (cx, cz, w, d, y0, y1, c, top) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    this.poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], c); // south
    this.poly([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], c); // north
    this.poly([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], c); // east
    this.poly([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], c); // west
    this.poly([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], top || c);
    return this;
  };
  // vertical prism from a footprint [[x,z]…] (any winding)
  P.prism = function (fp, y0, y1, c, top) {
    let a = 0; for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) a += fp[j][0] * fp[i][1] - fp[i][0] * fp[j][1];
    const f = a > 0 ? fp : fp.slice().reverse();
    for (let i = 0; i < f.length; i++) { const p = f[i], q = f[(i + 1) % f.length]; this.poly([[q[0], y0, q[1]], [p[0], y0, p[1]], [p[0], y1, p[1]], [q[0], y1, q[1]]], c); }
    this.poly(f.map(([x, z]) => [x, y1, z]).reverse(), top || c);
    return this;
  };
  // frustum / pyramid from a w×d rectangle at y0 to a w1×d1 rectangle at y1
  P.frustum = function (cx, cz, w, d, w1, d1, y0, y1, c, top) {
    const r = (W, D, y) => [[cx - W / 2, y, cz + D / 2], [cx + W / 2, y, cz + D / 2], [cx + W / 2, y, cz - D / 2], [cx - W / 2, y, cz - D / 2]];
    const a = r(w, d, y0), b = r(w1, d1, y1);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; if (w1 < 0.01 && d1 < 0.01) this.poly([a[i], a[j], b[i]], c); else this.poly([a[i], a[j], b[j], b[i]], c); }
    if (w1 > 0.01) this.poly(b.slice(), top || c);
    return this;
  };
  // surface of revolution: prof = [[y, r, colour?]…] bottom to top; sx/sz stretch for ellipses
  P.lathe = function (cx, cz, prof, c, seg = 16, o = {}) {
    const sx = o.sx || 1, sz = o.sz || 1, a0 = o.a0 || 0;
    for (let k = 0; k < prof.length - 1; k++) {
      const [y0, r0] = prof[k], [y1, r1] = prof[k + 1]; const col = prof[k][2] || c;
      for (let s = 0; s < seg; s++) {
        const t0 = a0 + (s / seg) * Math.PI * 2, t1 = a0 + ((s + 1) / seg) * Math.PI * 2;
        const P0 = [cx + Math.cos(t0) * r0 * sx, y0, cz + Math.sin(t0) * r0 * sz], P1 = [cx + Math.cos(t1) * r0 * sx, y0, cz + Math.sin(t1) * r0 * sz];
        const Q0 = [cx + Math.cos(t0) * r1 * sx, y1, cz + Math.sin(t0) * r1 * sz], Q1 = [cx + Math.cos(t1) * r1 * sx, y1, cz + Math.sin(t1) * r1 * sz];
        const cc = o.pattern ? o.pattern(s, k, col) : col;
        if (r1 < 0.01) this.poly([P1, P0, Q0], cc); else if (r0 < 0.01) this.poly([P1, Q0, Q1], cc); else this.poly([P1, P0, Q0, Q1], cc);
      }
    }
    const [yt, rt] = prof[prof.length - 1];
    if (rt > 0.01 && !o.open) { const cap = []; for (let s = seg; s > 0; s--) { const t = a0 + (s / seg) * Math.PI * 2; cap.push([cx + Math.cos(t) * rt * sx, yt, cz + Math.sin(t) * rt * sz]); } this.poly(cap, o.top || prof[prof.length - 1][2] || c); }
    return this;
  };
  P.cyl = function (cx, cz, r, y0, y1, c, seg = 12, top) { return this.lathe(cx, cz, [[y0, r], [y1, r]], c, seg, { top }); };
  P.dome = function (cx, cz, r, y0, h, c, seg = 16, rings = 5, o = {}) {
    const prof = []; for (let i = 0; i <= rings; i++) { const a = (i / rings) * Math.PI / 2; prof.push([y0 + Math.sin(a) * h, Math.cos(a) * r]); }
    return this.lathe(cx, cz, prof, c, seg, o);
  };
  // pitched roof over an axis-aligned w×d rectangle; axis "x" or "z" is the ridge direction
  P.gable = function (cx, cz, w, d, y0, rise, axis, roof, end) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, yt = y0 + rise;
    if (axis === "x") {
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, yt, cz], [x0, yt, cz], roof); this.quad([x1, y0, z0], [x0, y0, z0], [x0, yt, cz], [x1, yt, cz], roof);
      this.poly([[x1, y0, z1], [x1, y0, z0], [x1, yt, cz]], end); this.poly([[x0, y0, z0], [x0, y0, z1], [x0, yt, cz]], end);
    } else {
      this.quad([x1, y0, z1], [x1, y0, z0], [cx, yt, z0], [cx, yt, z1], roof); this.quad([x0, y0, z0], [x0, y0, z1], [cx, yt, z1], [cx, yt, z0], roof);
      this.poly([[x0, y0, z1], [x1, y0, z1], [cx, yt, z1]], end); this.poly([[x1, y0, z0], [x0, y0, z0], [cx, yt, z0]], end);
    }
    return this;
  };
  // barrel vault over w×d, ridge along axis
  P.vault = function (cx, cz, w, d, y0, rise, axis, c, end, seg = 8, ribs) {
    const half = (axis === "x" ? d : w) / 2, len = (axis === "x" ? w : d) / 2;
    const pt = (u, t) => { const a = Math.PI * t; const off = -Math.cos(a) * half, y = y0 + Math.sin(a) * rise; return axis === "x" ? [cx + u, y, cz + off] : [cx + off, y, cz + u]; };
    for (let s = 0; s < seg; s++) { const t0 = s / seg, t1 = (s + 1) / seg; this.quad(pt(-len, t0), pt(len, t0), pt(len, t1), pt(-len, t1), c, { two: true }); }
    const capA = [], capB = []; for (let s = 0; s <= seg; s++) { capA.push(pt(len, s / seg)); capB.push(pt(-len, s / seg)); }
    this.poly(capA, end, { two: true }); this.poly(capB.reverse(), end, { two: true });
    if (ribs) for (let u = -len; u <= len + 0.01; u += ribs) for (let s = 0; s < seg; s++) this.line(pt(u, s / seg), pt(u, (s + 1) / seg), K.blueDark, 0.5);
    return this;
  };
  // rows of windows on a vertical face from a to b (ground points) — dashed lines
  P.windows = function (a, b, n, y0, y1, step, c, o = {}) {
    for (let y = y0; y <= y1 + 0.01; y += step) this.line([a[0], y, a[1]], [b[0], y, b[1]], c, o.h || 1.4, { n, dash: o.dash || [1.2, 1.6], glow: o.glow ?? true });
    return this;
  };
  // vertical lines (pilasters, mullions) on a face
  P.ribs = function (a, b, n, y0, y1, step, c, w = 0.5) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const cnt = Math.max(1, Math.round(L / step));
    for (let i = 1; i < cnt; i++) { const t = i / cnt; const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t; this.line([x, y0, z], [x, y1, z], c, w, { n }); }
    return this;
  };
  // windows on all four faces of a box
  P.boxWindows = function (cx, cz, w, d, y0, y1, step, c, o = {}) {
    const x0 = cx - w / 2 - 0.15, x1 = cx + w / 2 + 0.15, z0 = cz - d / 2 - 0.15, z1 = cz + d / 2 + 0.15;
    this.windows([x0 + 1, z1], [x1 - 1, z1], [0, 0, 1], y0, y1, step, c, o); this.windows([x1, z1 - 1], [x1, z0 + 1], [1, 0, 0], y0, y1, step, c, o);
    this.windows([x1 - 1, z0], [x0 + 1, z0], [0, 0, -1], y0, y1, step, c, o); this.windows([x0, z0 + 1], [x0, z1 - 1], [-1, 0, 0], y0, y1, step, c, o);
    return this;
  };
  P.boxRibs = function (cx, cz, w, d, y0, y1, step, c, wd) {
    const x0 = cx - w / 2 - 0.15, x1 = cx + w / 2 + 0.15, z0 = cz - d / 2 - 0.15, z1 = cz + d / 2 + 0.15;
    this.ribs([x0, z1], [x1, z1], [0, 0, 1], y0, y1, step, c, wd); this.ribs([x1, z1], [x1, z0], [1, 0, 0], y0, y1, step, c, wd);
    this.ribs([x1, z0], [x0, z0], [0, 0, -1], y0, y1, step, c, wd); this.ribs([x0, z0], [x0, z1], [-1, 0, 0], y0, y1, step, c, wd);
    return this;
  };
  // clock face on the side of a box: centre, outward axis ("x+", "z-"…)
  P.clock = function (cx, y, cz, r, axis, rim = K.gilt) {
    const pts = (rad, off) => { const out = []; for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; const u = Math.cos(a) * rad, v = Math.sin(a) * rad;
      out.push(axis[0] === "x" ? [cx + off, y + v, cz + u * (axis[1] === "+" ? -1 : 1)] : [cx + u * (axis[1] === "+" ? 1 : -1), y + v, cz + off]); } return out; };
    const s = axis[1] === "+" ? 1 : -1;
    this.poly(pts(r * 1.2, 0.15 * s), rim, { flat: true, n: true }); this.poly(pts(r, 0.3 * s), K.clock, { flat: true, glow: hex("#ffe9a8") });
    const c0 = axis[0] === "x" ? [cx + 0.45 * s, y, cz] : [cx, y, cz + 0.45 * s];
    this.line(c0, axis[0] === "x" ? [c0[0], y + r * 0.7, c0[2]] : [c0[0], y + r * 0.7, c0[2]], K.dark, 0.35);
    this.line(c0, axis[0] === "x" ? [c0[0], y, c0[2] + r * 0.5 * s] : [c0[0] + r * 0.5 * s, y, c0[2]], K.dark, 0.35);
    return this;
  };
  P.flag = function (x, y, z, w, h, cols) { this.line([x, y - 9, z], [x, y + h, z], K.offwhite, 0.25); cols.forEach((c, i) => this.poly([[x, y + h - (i * h) / cols.length, z], [x + w, y + h - (i * h) / cols.length, z + 0.3], [x + w, y + h - ((i + 1) * h) / cols.length, z + 0.3], [x, y + h - ((i + 1) * h) / cols.length, z]], c, { two: true, flat: true })); return this; };

  /* ---------- the models ---------- */
  const M = {};

  // Elizabeth Tower (Big Ben): 96 m, 12 m square shaft, clock faces at 55 m, cast-iron spire.
  M.elizabeth_tower = (b) => {
    b.box(0, 0, 12, 12, 0, 55, K.anston);
    b.boxRibs(0, 0, 12, 12, 2, 54, 2.4, K.goldDark, 0.45);
    b.boxWindows(0, 0, 12, 12, 8, 50, 6, K.windowStone, { dash: [0.8, 2.2], h: 1.6 });
    b.box(0, 0, 14, 14, 54, 56, K.goldDark);
    b.box(0, 0, 13.5, 13.5, 56, 65, K.anston);
    for (const ax of ["x+", "x-", "z+", "z-"]) { const o = ax[1] === "+" ? 6.75 : -6.75; ax[0] === "x" ? b.clock(o, 60.5, 0, 3.4, ax) : b.clock(0, 60.5, o, 3.4, ax); }
    b.box(0, 0, 12, 12, 65, 72, K.anston); b.boxRibs(0, 0, 12, 12, 66, 71.5, 2, K.iron, 1.2);
    for (const [px, pz] of [[-6, -6], [6, -6], [6, 6], [-6, 6]]) b.frustum(px, pz, 1.8, 1.8, 0, 0, 72, 80, K.gilt);
    b.frustum(0, 0, 11, 11, 5, 5, 72, 86, K.slate); b.boxRibs(0, 0, 9, 9, 73, 84, 1.8, K.gilt, 0.4);
    b.frustum(0, 0, 5, 5, 0, 0, 86, 96, K.slateDark); b.line([0, 92, 0], [0, 97.5, 0], K.gilt, 0.7);
  };
  // Victoria Tower: 98.5 m, 23 m square, with corner turrets and the flag.
  M.victoria_tower = (b) => {
    b.box(0, 0, 22, 22, 0, 76, K.anston); b.boxRibs(0, 0, 22, 22, 4, 75, 2.6, K.goldDark, 0.5);
    b.boxWindows(0, 0, 22, 22, 10, 70, 7, K.windowStone, { dash: [1, 2.2], h: 2.2 });
    for (const [px, pz] of [[-11, -11], [11, -11], [11, 11], [-11, 11]]) { b.cyl(px, pz, 2.4, 0, 82, K.anston, 8); b.frustum(px, pz, 4, 4, 0, 0, 82, 90, K.gilt); }
    b.frustum(0, 0, 20, 20, 12, 12, 76, 80, K.slate);
    b.flag(0, 89, 0, 9, 5, [K.red, K.white, K.navy]);
  };
  // Central Tower of the Palace of Westminster: octagonal lantern and spire, 91 m.
  M.central_tower = (b) => {
    b.cyl(0, 0, 9, 0, 58, K.anston, 8); b.windows([-8.3, 9.2], [8.3, 9.2], [0, 0, 1], 40, 52, 6, K.windowStone, { dash: [0.8, 1.6], h: 4 });
    b.lathe(0, 0, [[58, 9], [91, 0]], K.goldDark, 8);
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; b.frustum(Math.cos(a) * 9, Math.sin(a) * 9, 1.4, 1.4, 0, 0, 56, 66, K.gilt); }
  };
  // Westminster Abbey: nave and choir, transepts, west towers (69 m), Lady Chapel.
  M.westminster_abbey = (b) => {
    const st = K.portlandDark, wall = hex("#d8ccad");
    b.box(-10, 0, 104, 22, 0, 31, wall); b.gable(-10, 0, 104, 22, 31, 9, "x", K.lead, wall);
    b.box(-10, -14.5, 104, 7, 0, 16, st); b.box(-10, 14.5, 104, 7, 0, 16, st);
    b.ribs([-62, 18.2], [42, 18.2], [0, 0, 1], 0, 16, 6.5, K.goldDark, 1);
    b.windows([-60, 11.2], [40, 11.2], [0, 0, 1], 22, 22, 1, K.windowStone, { dash: [2.4, 4], h: 9 });
    b.box(4, 0, 24, 82, 0, 31, wall); b.gable(4, 0, 24, 82, 31, 9, "z", K.lead, wall);
    b.windows([-7, 41.2], [15, 41.2], [0, 0, 1], 20, 20, 1, K.windowStone, { dash: [2, 2.5], h: 12 });
    b.box(4, 0, 15, 15, 31, 41, wall); b.frustum(4, 0, 15, 15, 6, 6, 41, 44, K.lead);
    b.box(52, 0, 22, 26, 0, 24, wall); b.frustum(52, 0, 22, 26, 16, 20, 24, 26, K.lead);
    for (let x = 42; x <= 62; x += 5) for (const z of [-13.5, 13.5]) b.frustum(x, z, 1.4, 1.4, 0, 0, 24, 30, wall);
    for (const z of [-9, 9]) { b.box(-66, z, 11, 11, 0, 64, wall); b.boxRibs(-66, z, 11, 11, 4, 63, 2.6, K.goldDark, 0.4); b.boxWindows(-66, z, 11, 11, 30, 56, 9, K.windowStone, { dash: [1, 2], h: 4 }); for (const [dx, dz] of [[-5, -5], [5, -5], [5, 5], [-5, 5]]) b.frustum(-66 + dx, z + dz, 1.6, 1.6, 0, 0, 64, 69, wall); }
    b.box(-63, 0, 6, 8, 0, 34, wall); b.poly([[-66.2, 4, 4.1], [-66.2, 4, -4.1], [-66.2, 28, -4.1], [-66.2, 28, 4.1]].map(([x, y, z]) => [x, y, z]), K.windowStone, { flat: true });
  };
  // London Eye: 120 m wheel (135 m to the top), 32 capsules, A-frame on the land side.
  M.london_eye = (b) => {
    const R = 60, H = 75, rim = K.white;
    const at = (a, r, x = 0) => [x, H + Math.sin(a) * r, Math.cos(a) * r];
    for (let i = 0; i < 64; i++) { const a0 = (i / 64) * Math.PI * 2, a1 = ((i + 1) / 64) * Math.PI * 2; for (const x of [-2.5, 2.5]) b.line(at(a0, R, x), at(a1, R, x), rim, 1.1); b.line(at(a0, R - 3, 0), at(a1, R - 3, 0), K.offwhite, 0.6); }
    for (let i = 0; i < 32; i++) { const a = (i / 32) * Math.PI * 2; b.line([0, H, 0], at(a, R - 3, 0), K.portlandDark, 0.3); if (i % 2 === 0) b.line(at(a, R, -2.5), at(a + 0.1, R, 2.5), K.offwhite, 0.4); }
    for (let i = 0; i < 32; i++) { const a = (i / 32) * Math.PI * 2 + 0.05; const [, y, z] = at(a, R + 2.2); b.box(0, z, 6.5, 3.2, y - 1.7, y + 1.7, K.glass, K.white); }
    b.box(0, 0, 5, 5, H - 2.5, H + 2.5, K.portlandDark);
    for (const z of [-22, 22]) b.line([2, H, 0], [48, 0, z], K.white, 1.6);
    b.line([48, 0, -22], [48, 0, 22], K.white, 1); b.line([3, H, 0], [70, 0, 0], K.offwhite, 0.4);
    b.box(-4, 0, 14, 34, 0, 2.5, K.concrete);
  };
  // Nelson's Column: 52 m with the lions and fountains.
  M.nelsons_column = (b) => {
    b.box(0, 0, 11, 11, 0, 2, K.portlandDark); b.box(0, 0, 8, 8, 2, 11, hex("#bdb6a7"));
    for (const [ax, o] of [["x", 4.05], ["x", -4.05], ["z", 4.05], ["z", -4.05]]) { const n = ax === "x" ? [Math.sign(o), 0, 0] : [0, 0, Math.sign(o)]; ax === "x" ? b.line([o, 6.5, -2.5], [o, 6.5, 2.5], K.bronze, 3.2, { n }) : b.line([-2.5, 6.5, o], [2.5, 6.5, o], K.bronze, 3.2, { n }); }
    b.lathe(0, 0, [[11, 2.4], [13, 2.1], [46, 1.8], [47, 2.6], [48.5, 2.6]], hex("#cfc8b8"), 10, { pattern: (s, k, c) => (k === 2 ? (s % 2 ? c : hex("#bcb5a4")) : k === 3 ? K.bronze : c) });
    b.lathe(0, 0, [[48.5, 1.1], [52, 0.9], [53.2, 0.5], [53.6, 0]], K.bronze, 8);
    for (const [px, pz] of [[-9, -9], [9, -9], [9, 9], [-9, 9]]) { const dx = Math.sign(px) * 2; b.box(px, pz, 5, 5, 0, 2.2, K.portlandDark); b.box(px + (Math.abs(px) > 0 ? 0 : 0), pz, 2.4, 4.6, 2.2, 4.2, K.bronze); b.box(px, pz + Math.sign(pz) * 2, 2, 1.6, 2.2, 5.2, K.bronze); void dx; }
    for (const x of [-24, 24]) { b.cyl(x, -26, 8, 0, 1, K.portland, 14, K.water); b.cyl(x, -26, 1, 1, 4, K.portland, 8); b.line([x, 4, -26], [x, 9, -26], K.white, 1.4); }
  };
  // Buckingham Palace: 108 m east front in Portland stone around a quadrangle.
  M.buckingham_palace = (b) => {
    const st = K.portland, roof = hex("#a6aaa3");
    b.box(52, 0, 18, 110, 0, 24, st, roof); b.box(63, 0, 4, 26, 0, 26, st, roof); b.gable(63, 0, 4, 26, 26, 4, "z", st, st);
    for (const z of [-48, 48]) b.box(62, z, 3, 14, 0, 25, st, roof);
    b.ribs([61.2, 55], [61.2, -55], [1, 0, 0], 4, 23, 3.2, K.portlandDark, 0.6);
    b.windows([61.2, 54], [61.2, 14], [1, 0, 0], 6, 18, 6, K.windowStone, { dash: [1.4, 1.8], h: 2.6 });
    b.windows([61.2, -14], [61.2, -54], [1, 0, 0], 6, 18, 6, K.windowStone, { dash: [1.4, 1.8], h: 2.6 });
    b.windows([65.2, 12], [65.2, -12], [1, 0, 0], 6, 18, 6, K.windowStone, { dash: [1.4, 1.8], h: 2.6 });
    b.box(0, -48, 86, 14, 0, 22, st, roof); b.box(0, 48, 86, 14, 0, 22, st, roof);
    b.windows([-42, 55.2], [42, 55.2], [0, 0, 1], 6, 16, 5, K.windowStone, { dash: [1.4, 2], h: 2.4 });
    b.box(-52, 0, 18, 126, 0, 24, st, roof); b.cyl(-61, 0, 12, 0, 22, st, 14, roof);
    b.windows([-61.2, 62], [-61.2, 14], [-1, 0, 0], 6, 18, 6, K.windowStone, { dash: [1.4, 1.8], h: 2.6 });
    b.box(0, 0, 86, 82, 0, 0.3, K.gravel);
    b.flag(54, 33, 0, 7, 4, [K.red, K.white, K.navy]);
  };
  // Victoria Memorial in front of the palace: white marble, gilded Victory.
  M.victoria_memorial = (b) => {
    b.cyl(0, 0, 17, 0, 1.4, K.white, 20); b.cyl(0, 0, 11, 1.4, 3, K.offwhite, 16);
    b.box(0, 0, 8, 8, 3, 15, K.white); b.box(0, 0, 4.5, 4.5, 15, 20, K.offwhite);
    b.lathe(0, 0, [[20, 1.3], [23, 0.8], [24.5, 0]], K.gilt, 8); b.line([-1.8, 22.5, 0], [1.8, 24.2, 0], K.gilt, 0.6);
    for (const [x, z] of [[-6, 0], [6, 0], [0, -6], [0, 6]]) b.box(x, z, 2, 2, 3, 6.5, K.bronze);
  };
  // British Museum: the Great Court glass roof and the round Reading Room.
  M.british_museum = (b) => {
    const y = 26, W = 92, D = 70;
    const roofY = (x, z) => y + 4 * (1 - Math.min(1, Math.hypot(x / (W / 2), z / (D / 2))));
    const n = 8; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x0 = -W / 2 + (W * i) / n, x1 = -W / 2 + (W * (i + 1)) / n, z0 = -D / 2 + (D * j) / n, z1 = -D / 2 + (D * (j + 1)) / n;
      if (Math.hypot((x0 + x1) / 2, (z0 + z1) / 2) < 21) continue;
      b.quad([x0, roofY(x0, z1), z1], [x1, roofY(x1, z1), z1], [x1, roofY(x1, z0), z0], [x0, roofY(x0, z0), z0], hex("#c9dde6"), { two: true });
      b.line([x0, roofY(x0, z1), z1], [x1, roofY(x1, z0), z0], K.offwhite, 0.25); b.line([x1, roofY(x1, z1), z1], [x0, roofY(x0, z0), z0], K.offwhite, 0.25);
    }
    b.cyl(0, 0, 21, 0, 30, K.portland, 24); b.dome(0, 0, 21, 30, 7, hex("#93a1aa"), 24, 3); b.cyl(0, 0, 4, 37, 38.5, K.glass, 10);
  };
  // BT Tower: 177 m concrete shaft, antenna galleries and the LED band.
  M.bt_tower = (b) => {
    const c = K.concrete, g = K.glassDark, d = K.dark;
    b.lathe(0, 0, [[0, 9.5, c], [12, 8, c], [104, 8, g], [108, 9.5, d], [112, 9.5, c], [114, 9, d], [118, 9, c], [120, 9, d], [124, 9, c], [126, 9, d], [130, 9, c], [133, 9, g], [148, 9, hex("#3b6fd1")], [152, 9, g], [160, 7, c], [163, 4, c], [177, 2.5]], c, 16,
      { pattern: (s, k, col) => (col === g && s % 2 ? hex("#7f9fb4") : col) });
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; b.cyl(Math.cos(a) * 10, Math.sin(a) * 10, 2.2, 113, 117, K.offwhite, 8); }
    b.line([0, 177, 0], [0, 189, 0], K.offwhite, 0.6);
  };
  // King's Cross: twin yellow-brick train sheds and the clock tower.
  M.kings_cross = (b) => {
    for (const x of [-17, 17]) { b.box(x, -10, 32, 240, 0, 9, K.stock); b.vault(x, -10, 32, 240, 9, 14, "z", hex("#b8c4c9"), K.stock, 10, 12); }
    b.box(0, 113, 76, 8, 0, 23, K.stock);
    for (const x of [-17, 17]) { const pts = []; for (let i = 0; i <= 10; i++) { const a = Math.PI * (i / 10); pts.push([x - Math.cos(a) * 13, 6 + Math.sin(a) * 13, 117.2]); } pts.push([x + 13, 3, 117.2], [x - 13, 3, 117.2]); b.poly(pts, hex("#4d555c"), { flat: true, glow: hex("#ffd27a") }); b.ribs([x - 12, 117.3], [x + 12, 117.3], [0, 0, 1], 4, 18, 3, K.offwhite, 0.4); }
    b.box(0, 113, 7, 7, 23, 38, K.stock); b.frustum(0, 113, 7, 7, 0, 0, 38, 43, K.slate); b.clock(0, 33, 116.6, 2, "z+");
    b.dome(-52, -20, 30, 0, 18, hex("#dfe2df"), 16, 4, {});
  };
  // St Pancras: Barlow's single-span train shed (74 m) behind the Midland Grand.
  M.st_pancras = (b) => {
    b.box(0, 10, 76, 210, 0, 8, K.redbrick); b.vault(0, 10, 76, 210, 8, 30, "z", hex("#9cb6c6"), K.redbrick, 12, 10);
    b.box(-6, 128, 104, 22, 0, 26, K.redbrick); b.gable(-6, 128, 104, 22, 26, 9, "x", K.slate, K.redbrick);
    b.windows([-56, 139.2], [44, 139.2], [0, 0, 1], 5, 21, 4, K.window, { dash: [1.2, 1.4], h: 2 });
    for (const x of [-56, -30, 18]) { b.box(x, 128, 8, 8, 26, 40, K.redbrick); b.frustum(x, 128, 8, 8, 0, 0, 40, 50, K.slate); }
  };
  // St Pancras clock tower: 82 m Gothic, red brick and stone.
  M.st_pancras_clock = (b) => {
    b.box(0, 0, 10, 10, 0, 56, K.redbrick); b.boxRibs(0, 0, 10, 10, 0, 56, 3.2, K.portlandDark, 0.6);
    b.boxWindows(0, 0, 10, 10, 6, 40, 6, K.window, { dash: [0.9, 1.8], h: 2.2 });
    for (const ax of ["x+", "x-", "z+", "z-"]) { const o = ax[1] === "+" ? 5 : -5; ax[0] === "x" ? b.clock(o, 49, 0, 2.6, ax) : b.clock(0, 49, o, 2.6, ax); }
    b.frustum(0, 0, 10, 10, 0, 0, 56, 80, K.slate); for (const [dx, dz] of [[-5, -5], [5, -5], [5, 5], [-5, 5]]) b.frustum(dx, dz, 1.6, 1.6, 0, 0, 56, 63, K.portland);
    b.line([0, 80, 0], [0, 83, 0], K.gilt, 0.5);
  };
  // St Paul's Cathedral: Wren's dome (111 m to the cross), nave, transepts and west towers.
  M.st_pauls = (b) => {
    const st = K.portland, roof = K.lead;
    b.box(-50, 0, 64, 34, 0, 29, st); b.gable(-50, 0, 64, 34, 29, 6, "x", roof, st);
    b.box(42, 0, 48, 34, 0, 29, st); b.gable(42, 0, 48, 34, 29, 6, "x", roof, st); b.cyl(66, 0, 13, 0, 25, st, 12); b.dome(66, 0, 13, 25, 5, roof, 12, 3);
    b.box(0, 0, 36, 86, 0, 29, st); b.gable(0, 0, 36, 86, 29, 6, "z", roof, st);
    for (const z of [-43, 43]) b.cyl(0, z, 9, 0, 24, st, 10);
    b.box(0, 0, 36, 36, 0, 31, st, roof);
    b.ribs([-82, 17.2], [18, 17.2], [0, 0, 1], 1, 28, 3.4, K.portlandDark, 0.6); b.ribs([-18, 43.2], [18, 43.2], [0, 0, 1], 1, 28, 3.4, K.portlandDark, 0.6); b.ribs([18, 17.2], [66, 17.2], [0, 0, 1], 1, 28, 3.4, K.portlandDark, 0.6);
    b.windows([-80, 17.3], [-20, 17.3], [0, 0, 1], 8, 20, 12, K.windowStone, { dash: [1.6, 3.2], h: 4.5 });
    b.windows([20, 17.3], [64, 17.3], [0, 0, 1], 8, 20, 12, K.windowStone, { dash: [1.6, 3.2], h: 4.5 });
    for (const z of [-14, 14]) { b.box(-80, z, 11, 11, 0, 44, st); b.boxRibs(-80, z, 11, 11, 2, 43, 2.2, K.portlandDark, 0.5); b.cyl(-80, z, 4.2, 44, 56, st, 10); b.dome(-80, z, 4.2, 56, 6, roof, 10, 3); b.lathe(-80, z, [[62, 0.9], [65, 0.6], [67, 0]], K.gilt, 6); }
    b.box(-85, 0, 5, 24, 0, 27, st); b.ribs([-87.6, 12], [-87.6, -12], [-1, 0, 0], 0, 27, 2.6, K.portlandDark, 1.1); b.gable(-85, 0, 5, 24, 27, 6, "z", st, st);
    b.lathe(0, 0, [[31, 21], [52, 21]], st, 24, { pattern: (s, k, c) => (s % 2 ? c : K.portlandDark), open: true });
    b.cyl(0, 0, 18, 31, 54, st, 24); b.cyl(0, 0, 21.8, 52, 53.5, st, 24);
    b.cyl(0, 0, 16.5, 53.5, 61, st, 24);
    b.lathe(0, 0, [[61, 16.5], [69, 15.2], [76, 12], [81, 7.5], [84, 3.6]], roof, 24, { pattern: (s, k, c) => (s % 3 === 0 ? K.leadDark : c) });
    b.cyl(0, 0, 3.6, 84, 95, st, 10); b.dome(0, 0, 3.6, 95, 3.5, roof, 10, 3);
    b.lathe(0, 0, [[98.5, 0.6], [100.5, 1.6], [102.5, 0.6], [104, 0.3], [109.5, 0.3], [111, 0]], K.gilt, 8);
    b.line([-1.8, 107.5, 0], [1.8, 107.5, 0], K.gilt, 0.4);
  };
  // Tate Modern: Bankside Power Station (200 m long, 99 m chimney) with the light beam.
  M.tate_modern = (b) => {
    const br = hex("#7c4f3c");
    b.box(0, 0, 200, 46, 0, 34, br); b.boxRibs(0, 0, 200, 46, 0, 33, 6, hex("#6a4232"), 1.2);
    b.boxWindows(0, 0, 200, 46, 16, 16, 100, K.window, { dash: [0.8, 5.2], h: 22, glow: false });
    b.box(0, 0, 190, 20, 34, 40, hex("#d9e4e3"));
    b.box(0, -16, 10, 10, 0, 99, br); b.boxRibs(0, -16, 10, 10, 30, 98, 1.6, hex("#6a4232"), 0.5); b.box(0, -16, 11, 11, 97, 99, hex("#5a382b"));
    b.frustum(25, 62, 64, 44, 34, 24, 0, 64, hex("#8e6450")); b.windows([-7, 84.3], [57, 84.3], [0, 0, 1], 4, 60, 3.2, hex("#6c4a3b"), { dash: [0.5, 0.7], h: 0.8, glow: false });
  };
  // The Monument: 61 m Doric column with its gilded flaming urn.
  M.monument = (b) => {
    b.box(0, 0, 6.5, 6.5, 0, 12, K.portland); b.lathe(0, 0, [[12, 2.6], [50, 2.1]], K.portland, 12, { pattern: (s, k, c) => (s % 2 ? c : K.portlandDark), open: true });
    b.box(0, 0, 5, 5, 50, 51.5, K.dark); b.cyl(0, 0, 1.6, 51.5, 56, K.portland, 10);
    b.lathe(0, 0, [[56, 1.2], [57.5, 2], [59.5, 1.6], [61.5, 0]], K.gilt, 10);
  };
  // 30 St Mary Axe (the Gherkin): 180 m, 41 floors, spiralling dark glass bands.
  M.gherkin = (b) => {
    const prof = [[0, 24.5], [12, 26.5], [28, 27.8], [46, 28.4], [64, 28], [84, 26.6], [104, 24.2], [122, 20.8], [138, 16.8], [152, 12.6], [164, 8.4], [172, 5], [178, 2], [180.5, 0]];
    b.lathe(0, 0, prof, K.glassTeal, 28, { pattern: (s, k) => { const band = (s + k * 1.1) % 7; return band < 2.2 ? K.glassDeep : band < 2.8 ? hex("#6f97a6") : K.glassTeal; } });
    b.lathe(0, 0, [[0, 25], [5, 25]], K.dark, 28, { open: true });
  };
  // The Leadenhall Building (the Cheesegrater): 225 m wedge sloping towards St Paul's.
  M.cheesegrater = (b) => {
    const H = 225, g = hex("#a6c0cf"), e = 24, w0 = -24, wt = 14, d = 22;
    const fp = [[w0, 28], [e, 0], [e, H], [wt, H]];
    b.quad([e, 0, d], [e, 0, -d], [e, H, -d], [e, H, d], g); b.quad([w0, 28, -d], [w0, 28, d], [wt, H, d], [wt, H, -d], hex("#c2d6e0"));
    for (const z of [d, -d]) { const s = z > 0 ? 1 : -1; const pts = [[w0, 28, z], [e, 0, z], [e, H, z], [wt, H, z]]; b.poly(s > 0 ? pts : pts.slice().reverse(), hex("#8fb0c2")); }
    b.quad([wt, H, d], [e, H, d], [e, H, -d], [wt, H, -d], K.steel);
    b.box(-4, 0, 50, 2 * d, 0, 28, K.dark);
    for (const z of [d + 0.3, -d - 0.3]) { const n = [0, 0, Math.sign(z)]; for (let y = 28; y < H; y += 28) { const x0 = w0 + (wt - w0) * ((y - 28) / (H - 28)), x1 = w0 + (wt - w0) * ((Math.min(H, y + 28) - 28) / (H - 28)); b.line([x0, y, z], [e, Math.min(H, y + 28), z], K.yellow, 0.8, { n }); b.line([e, y, z], [x1, Math.min(H, y + 28), z], K.yellow, 0.8, { n }); } }
    void fp;
  };
  // 20 Fenchurch Street (the Walkie-Talkie): 160 m, widening towards the Sky Garden.
  M.walkie_talkie = (b) => {
    const secs = [[0, 30, 19], [40, 30, 20], [80, 30, 23], [115, 30, 26], [140, 30, 28], [155, 30, 29]];
    const g = hex("#91aebf");
    for (let i = 0; i < secs.length - 1; i++) {
      const [y0, hw0, hd0] = secs[i], [y1, hw1, hd1] = secs[i + 1];
      b.quad([-hw0, y0, hd0], [hw0, y0, hd0], [hw1, y1, hd1], [-hw1, y1, hd1], g); b.quad([hw0, y0, -hd0], [-hw0, y0, -hd0], [-hw1, y1, -hd1], [hw1, y1, -hd1], g);
      b.quad([hw0, y0, hd0], [hw0, y0, -hd0], [hw1, y1, -hd1], [hw1, y1, hd1], hex("#7f9daf")); b.quad([-hw0, y0, -hd0], [-hw0, y0, hd0], [-hw1, y1, hd1], [-hw1, y1, -hd1], hex("#7f9daf"));
      for (let x = -27; x <= 27; x += 3.5) { b.line([x, y0, hd0 + 0.2], [x, y1, hd1 + 0.2], K.offwhite, 0.25, { n: [0, 0, 1] }); }
    }
    b.quad([-30, 155, 29], [30, 155, 29], [30, 162, -29], [-30, 162, -29], hex("#d4e6ec"));
    b.poly([[30, 155, 29], [30, 155, -29], [30, 162, -29]], hex("#a9c6d3")); b.poly([[-30, 155, -29], [-30, 155, 29], [-30, 162, -29]], hex("#a9c6d3"));
    b.quad([30, 155, -29], [-30, 155, -29], [-30, 162, -29], [30, 162, -29], hex("#7f9daf"));
  };
  // The Shard: 310 m pyramid of glass shards.
  M.shard = (b) => {
    const H = 306, g = hex("#aac6d6"), g2 = hex("#93b2c4");
    const base = [[-27, 27], [27, 27], [27, -27], [-27, -27]], top = [[-3.5, 3.5], [3.5, 3.5], [3.5, -3.5], [-3.5, -3.5]];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; b.quad([base[i][0], 0, base[i][1]], [base[j][0], 0, base[j][1]], [top[j][0], H - 12, top[j][1]], [top[i][0], H - 12, top[i][1]], i % 2 ? g : g2); }
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; const mx = (base[i][0] + base[j][0]) / 2, mz = (base[i][1] + base[j][1]) / 2; const n = [Math.sign(mx) || 0, 0.2, Math.sign(mz) || 0];
      b.line([mx * 0.98 + (i % 2 ? 3 : -3), 0, mz * 0.98 + (i % 2 ? -3 : 3)], [mx * 0.13, H - 12, mz * 0.13], hex("#6f8fa2"), 0.6, { n });
      for (let y = 14; y < H - 20; y += 14) { const s = 1 - y / (H - 12) * 0.87; b.line([base[i][0] * s, y, base[i][1] * s], [base[j][0] * s, y, base[j][1] * s], hex("#c4dae5"), 0.3, { n }); } }
    for (const [x, z, t] of [[-3.5, 3.5, 310], [3.5, -3.5, 306], [3.5, 3.5, 300], [-3.5, -3.5, 303]]) b.poly([[x * 1.2, H - 14, z * 1.2], [x * 0.2, H - 14, z * 1.2], [x * 0.4, t, z * 0.4]], hex("#d6e6ee"), { two: true });
  };
  // Tower Bridge: two 65 m towers, high walkways, bascules and suspension spans.
  M.tower_bridge = (b) => {
    const st = hex("#d4cbb6"), sl = hex("#5d6d80"), bl = hex("#8db7d6"), wh = K.white, road = hex("#5d6066");
    for (const z of [-38, 38]) {
      b.box(0, z, 30, 26, -1, 6, K.portlandDark);
      b.box(0, z, 18, 16, 6, 55, st); b.boxRibs(0, z, 18, 16, 8, 54, 3, K.portlandDark, 0.5); b.boxWindows(0, z, 18, 16, 16, 50, 7, K.windowStone, { dash: [1, 2.4], h: 2.6 });
      for (const [dx, dz] of [[-9, -8], [9, -8], [9, 8], [-9, 8]]) { b.cyl(dx, z + dz, 2.3, 6, 60, st, 8); b.frustum(dx, z + dz, 3.6, 3.6, 0, 0, 60, 67, sl); b.line([dx, 67, z + dz], [dx, 69, z + dz], K.gilt, 0.4); }
      b.frustum(0, z, 18, 16, 0, 0, 55, 66, sl);
      const zs = Math.sign(z), face = z - zs * 8.15; b.poly([[-5, 6, face], [5, 6, face], [5, 15, face], [0, 18, face], [-5, 15, face]].map((p) => p), K.dark, { flat: true, two: true });
    }
    for (const x of [-6, 6]) { b.box(x, 0, 3, 60, 42, 46, bl); b.ribs([x - 1.6, -30], [x - 1.6, 30], [-1, 0, 0], 42, 46, 2.5, wh, 0.35); b.ribs([x + 1.6, 30], [x + 1.6, -30], [1, 0, 0], 42, 46, 2.5, wh, 0.35); }
    b.box(0, 0, 18, 60, 8, 10, bl, road); b.line([-9.1, 9, -30], [-9.1, 9, 30], wh, 0.6); b.line([9.1, 9, 30], [9.1, 9, -30], wh, 0.6);
    for (const s of [-1, 1]) {
      b.box(0, s * 88, 18, 76, 8, 10, bl, road);
      b.box(0, s * 128, 14, 10, 0, 22, st); b.frustum(0, s * 128, 14, 10, 0, 0, 22, 28, sl);
      for (const x of [-8.5, 8.5]) { const pts = [[x, 40, s * 47], [x, 26, s * 62], [x, 16, s * 80], [x, 13, s * 98], [x, 18, s * 115], [x, 22, s * 123]]; for (let i = 0; i < pts.length - 1; i++) b.line(pts[i], pts[i + 1], bl, 1.3); for (let i = 1; i < pts.length - 1; i++) b.line(pts[i], [x, 10, pts[i][2]], wh, 0.3); }
    }
  };
  // The White Tower (Tower of London): 36 × 32 m keep, 27 m, four corner turrets with cupolas.
  M.white_tower = (b) => {
    const st = hex("#e6ddc7"), lead = hex("#7f8b91");
    b.box(0, 0, 36, 32, 0, 27, st); b.boxRibs(0, 0, 36, 32, 0, 27, 6, K.portlandDark, 0.9);
    b.boxWindows(0, 0, 36, 32, 9, 21, 6, K.windowStone, { dash: [1, 4], h: 2.4 });
    b.line([-18.2, 27.6, 16.2], [18.2, 27.6, 16.2], st, 1.4, { dash: [1, 1], n: [0, 0, 1] }); b.line([18.2, 27.6, 16.2], [18.2, 27.6, -16.2], st, 1.4, { dash: [1, 1], n: [1, 0, 0] });
    for (const [dx, dz, round] of [[-18, -16, 0], [18, -16, 1], [18, 16, 0], [-18, 16, 0]]) {
      if (round) b.cyl(dx, dz, 4.5, 0, 32, st, 12); else b.box(dx, dz, 7, 7, 0, 32, st);
      b.lathe(dx, dz, [[32, 3.2], [34, 4.2], [36, 3.4], [38, 1.4], [39.5, 0]], lead, 10); b.line([dx, 39.5, dz], [dx, 42, dz], K.gilt, 0.35);
    }
  };
  // One Canada Square: 235 m stainless-steel tower with its pyramid roof.
  M.one_canada_square = (b) => {
    const s = hex("#c3cbd0");
    b.box(0, 0, 50, 50, 0, 201, s); b.boxRibs(0, 0, 50, 50, 0, 200, 1.6, hex("#9aa4ab"), 0.3);
    b.boxWindows(0, 0, 50, 50, 3, 198, 4, hex("#6f7d87"), { dash: [50, 0.01], h: 0.6 });
    b.frustum(0, 0, 50, 50, 2, 2, 201, 235, hex("#b7bfc4"));
    b.line([0, 235, 0], [0, 237, 0], K.white, 0.8, { glow: hex("#ffffff") });
  };
  // The O2: 365 m fabric dome on twelve 100 m yellow masts.
  M.o2 = (b) => {
    const R = 182;
    const prof = [[0, R], [10, R], [16, R * 0.97], [28, R * 0.85], [38, R * 0.68], [46, R * 0.46], [51, R * 0.22], [52, R * 0.08]];
    b.lathe(0, 0, prof, hex("#ebe8df"), 36, { pattern: (s, k, c) => (k === 0 ? hex("#cfcbc0") : s % 3 === 0 ? hex("#dcd8ce") : c), top: K.dark });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.13; const r = 108; const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = 40; b.line([x, y - 8, z], [x * 1.08, 100, z * 1.08], K.yellow, 1.6);
      for (const k of [-0.25, 0.25]) b.line([x * 1.08, 98, z * 1.08], [Math.cos(a + k) * 150, 22, Math.sin(a + k) * 150], hex("#d8d4c8"), 0.25);
      b.line([x * 1.08, 98, z * 1.08], [Math.cos(a) * 60, 50, Math.sin(a) * 60], hex("#d8d4c8"), 0.25);
    }
  };
  // Battersea Power Station: brick cathedral of power with four 103 m white chimneys.
  M.battersea = (b) => {
    const br = hex("#94553f"), brd = hex("#7a4433"), wh = hex("#f2efe7");
    b.box(0, 0, 56, 166, 0, 51, br, hex("#5b5f63")); b.boxRibs(0, 0, 56, 166, 0, 50, 4, brd, 0.9);
    for (const x of [-56, 56]) { b.box(x, 0, 56, 156, 0, 34, br, hex("#5b5f63")); b.boxRibs(x, 0, 56, 156, 0, 33, 4, brd, 0.9); b.boxWindows(x, 0, 56, 156, 18, 18, 100, K.window, { dash: [1.4, 6.6], h: 18, glow: false }); }
    for (const [x, z] of [[-27, -79], [27, -79], [27, 79], [-27, 79]]) {
      b.box(x, z, 11, 11, 51, 58, wh);
      b.lathe(x, z, [[58, 4.6], [98, 3.9], [100, 4.1], [103, 4.1]], wh, 14, { pattern: (s, k, c) => (k === 2 ? K.dark : s % 2 ? c : hex("#dcd8ce")) });
    }
  };
  // Royal Albert Hall: 83 × 72 m elliptical drum in red brick with the terracotta frieze.
  M.royal_albert_hall = (b) => {
    const o = { sx: 36 / 41.5, sz: 1 };
    b.lathe(0, 0, [[0, 41.5, hex("#a8583d")], [21, 41.5, hex("#cfae7f")], [24, 41.5, hex("#a8583d")], [26.5, 40, hex("#9aa8ae")], [34, 31], [39, 18], [41.5, 6, K.glass], [43, 4]], hex("#9aa8ae"), 32, o);
    b.lathe(0, 0, [[4, 41.7], [19, 41.7]], hex("#a8583d"), 32, { ...o, open: true, pattern: (s, k, c) => (s % 2 ? K.window : c) });
    b.box(0, 43, 18, 10, 0, 20, hex("#a8583d")); b.gable(0, 43, 18, 10, 20, 4, "z", K.slate, hex("#a8583d"));
  };
  // Natural History Museum: Waterhouse's terracotta cathedral of nature.
  M.nhm = (b) => {
    const t = K.terracotta, bl = K.tcBlue, sl = K.slate;
    b.box(0, 0, 206, 20, 0, 22, t); b.gable(0, 0, 206, 20, 22, 6, "x", sl, t);
    for (let y = 3; y < 22; y += 3.2) b.line([-103, y, 10.2], [103, y, 10.2], bl, 0.6, { n: [0, 0, 1] });
    b.windows([-100, 10.3], [100, 10.3], [0, 0, 1], 6, 18, 6, K.window, { dash: [1.2, 2.4], h: 2.6 });
    b.box(0, 2, 36, 26, 0, 26, t); b.gable(0, 2, 36, 26, 26, 7, "z", sl, t);
    const arch = []; for (let i = 0; i <= 8; i++) { const a = Math.PI * (i / 8); arch.push([-Math.cos(a) * 6, 4 + Math.sin(a) * 6, 15.3]); } arch.push([6, 0, 15.3], [-6, 0, 15.3]); b.poly(arch, K.dark, { flat: true });
    for (const x of [-13, 13]) { b.box(x, 8, 8, 8, 0, 48, t); b.boxRibs(x, 8, 8, 8, 0, 48, 2, bl, 0.4); b.frustum(x, 8, 8, 8, 0, 0, 48, 60, sl); }
    for (const x of [-95, 95]) { b.box(x, 0, 20, 26, 0, 30, t); b.frustum(x, 0, 20, 26, 0, 0, 30, 41, sl); }
    b.box(0, -50, 34, 80, 0, 26, t); b.gable(0, -50, 34, 80, 26, 10, "z", hex("#8fa6b2"), t);
    for (const x of [-58, 58]) b.box(x, -40, 70, 60, 0, 16, t, hex("#7c858c"));
  };
  // The O2's neighbours and the rest of London come from OpenStreetMap.

  /* ---------- registry ---------- */
  // Split big quads and long lines so the painter's sort works locally.
  function subdivide(polys, S = 10) {
    const out = [];
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (const p of polys) {
      if (p.w) {
        const [a, b] = p.v; const n = Math.min(24, Math.ceil(dist(a, b) / (S * 1.5)));
        if (n <= 1 || p.dash) { out.push(p); continue; }
        for (let i = 0; i < n; i++) out.push({ ...p, v: [lerp(a, b, i / n), lerp(a, b, (i + 1) / n)] });
        continue;
      }
      if (p.v.length !== 4 || p.flat) { out.push(p); continue; }
      const [A, Bq, Cq, D] = p.v; const nu = Math.min(16, Math.ceil(Math.max(dist(A, Bq), dist(D, Cq)) / S)), nv = Math.min(16, Math.ceil(Math.max(dist(A, D), dist(Bq, Cq)) / S));
      if (nu * nv <= 1) { out.push(p); continue; }
      const at = (u, v) => lerp(lerp(A, Bq, u), lerp(D, Cq, u), v);
      for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) out.push({ ...p, v: [at(i / nu, j / nv), at((i + 1) / nu, j / nv), at((i + 1) / nu, (j + 1) / nv), at(i / nu, (j + 1) / nv)] });
    }
    return out;
  }
  const cache = new Map();
  function get(id) {
    if (cache.has(id)) return cache.get(id);
    const f = M[id]; if (!f) { cache.set(id, null); return null; }
    const b = new B(); f(b);
    b.p = subdivide(b.p);
    let maxH = 0, rad = 0; for (const p of b.p) for (const v of p.v) { if (v[1] > maxH) maxH = v[1]; const r = Math.hypot(v[0], v[2]); if (r > rad) rad = r; }
    const m = { polys: b.p, maxH, rad };
    cache.set(id, m); return m;
  }
  window.ISO_MODELS = { get, ids: Object.keys(M) };
})();
