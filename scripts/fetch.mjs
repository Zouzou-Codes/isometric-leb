// Downloads OpenStreetMap data for the area in config.json from the Overpass API.
// The area is split into a grid of cells so each request stays small.
// Already-downloaded cells are skipped, so you can stop and rerun at any time.
//
//   node scripts/fetch.mjs
//
// Output: cache/raw/<row>_<col>.json (raw Overpass JSON)

import { readFile, writeFile, mkdir, access } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../config.json", import.meta.url)));
const OUT = new URL("../cache/raw/", import.meta.url);
await mkdir(OUT, { recursive: true });

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function query(s, w, n, e) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:240];
(
  way["building"](${b});
  way["natural"="water"](${b});
  relation["natural"="water"](${b});
  way["waterway"="riverbank"](${b});
  relation["waterway"="riverbank"](${b});
  way["leisure"~"^(park|garden|common|pitch|playground|nature_reserve)$"](${b});
  relation["leisure"~"^(park|garden|common)$"](${b});
  way["landuse"~"^(grass|recreation_ground|cemetery|forest|meadow|village_green|allotments)$"](${b});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|pedestrian|living_street|service)$"](${b});
  way["railway"~"^(rail|light_rail|subway)$"]["tunnel"!="yes"](${b});
);
out tags geom;`;
}

async function fetchCell(q, label) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "isometric-london (github.com/arikhanacademic-cpu)" },
        body: "data=" + encodeURIComponent(q)
      });
      if (res.ok) {
        const text = await res.text();
        const json = JSON.parse(text);
        if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
        return text;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const wait = Math.min(120, 10 * 2 ** attempt);
      console.warn(`  ${label}: ${err.message} from ${new URL(url).host}, retrying in ${wait}s`);
      await sleep(wait * 1000);
    }
  }
  throw new Error(`gave up after 10 attempts`);
}

const { south, west, north, east } = config.bbox;
const dLat = config.cellDegrees.lat, dLng = config.cellDegrees.lng;
const rows = Math.ceil((north - south) / dLat), cols = Math.ceil((east - west) / dLng);
console.log(`Fetching ${rows * cols} cells (${rows} × ${cols}) for ${config.name}`);

// One pass over a list of cells. Cells that still fail after all retries are returned
// instead of stopping the run, so one busy server can't throw away the rest.
async function pass(cells) {
  const failed = [];
  for (const [r, c] of cells) {
    const file = new URL(`${r}_${c}.json`, OUT);
    const label = `cell ${r}_${c}`;
    try { await access(file); done++; continue; } catch {}
    const s = south + r * dLat, w = west + c * dLng;
    const n = Math.min(north, s + dLat), e = Math.min(east, w + dLng);
    const t0 = Date.now();
    try {
      const text = await fetchCell(query(s, w, n, e), label);
      await writeFile(file, text);
      done++;
      console.log(`  ${label} ✓ ${(text.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s  (${done}/${rows * cols})`);
    } catch (err) {
      console.warn(`  ${label} ✗ ${err.message}, will try again at the end`);
      failed.push([r, c]);
    }
    await sleep(3000); // be polite to the public Overpass servers
  }
  return failed;
}

let done = 0;
const all = [];
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) all.push([r, c]);
let failed = await pass(all);
for (let round = 1; failed.length && round <= 2; round++) {
  console.log(`Retrying ${failed.length} cell(s) after a 2 minute pause (round ${round}/2)…`);
  await sleep(120000);
  done -= 0;
  failed = await pass(failed);
}
if (failed.length) {
  console.error(`${failed.length} cell(s) still missing: ${failed.map(([r, c]) => r + "_" + c).join(", ")}.`);
  console.error("Everything else is saved. Run again later and only the missing cells will be downloaded.");
  process.exit(1);
}
// River centrelines for the whole area in one small request. Some stretches of the Thames
// have no water area in OpenStreetMap, so the build widens the centreline into a river.
const riversFile = new URL("rivers.json", OUT);
try { await access(riversFile); } catch {
  const b = `${south},${west},${north},${east}`;
  const text = await fetchCell(`[out:json][timeout:180];\n(\n  way["waterway"="river"](${b});\n  way["water"="river"](${b});\n  relation["water"="river"](${b});\n);\nout tags geom;`, "rivers");
  await writeFile(riversFile, text); console.log("  rivers ✓");
}
console.log("All cells downloaded. Next: node scripts/build.mjs");
