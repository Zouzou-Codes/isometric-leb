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
  for (let attempt = 0; attempt < 8; attempt++) {
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
      const wait = Math.min(90, 10 * 2 ** attempt);
      console.warn(`  ${label}: ${err.message} from ${new URL(url).host}, retrying in ${wait}s`);
      await sleep(wait * 1000);
    }
  }
  throw new Error(`Gave up on ${label} after 8 attempts`);
}

const { south, west, north, east } = config.bbox;
const dLat = config.cellDegrees.lat, dLng = config.cellDegrees.lng;
const rows = Math.ceil((north - south) / dLat), cols = Math.ceil((east - west) / dLng);
console.log(`Fetching ${rows * cols} cells (${rows} × ${cols}) for ${config.name}`);

let done = 0;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const file = new URL(`${r}_${c}.json`, OUT);
    const label = `cell ${r}_${c}`;
    try { await access(file); done++; continue; } catch {}
    const s = south + r * dLat, w = west + c * dLng;
    const n = Math.min(north, s + dLat), e = Math.min(east, w + dLng);
    const t0 = Date.now();
    const text = await fetchCell(query(s, w, n, e), label);
    await writeFile(file, text);
    done++;
    console.log(`  ${label} ✓ ${(text.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s  (${done}/${rows * cols})`);
    await sleep(3000); // be polite to the public Overpass servers
  }
}
console.log("All cells downloaded. Next: node scripts/build.mjs");
