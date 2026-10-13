# Isometric London

A giant isometric pixel-art map of central London, roughly Zones 1–2. Every building, road, park and stretch of the Thames is drawn in code from OpenStreetMap data, with no AI-generated images and no map tiles.

Inspired by [isometric.nyc](https://cannoneyed.com/isometric-nyc/).

![Preview, rendered from the built-in test neighbourhood](docs/preview-sample.png)

## Features

- Pan, zoom and pinch over hundreds of thousands of buildings, streamed in 500 m chunks
- Rotate the city in 90° steps to see around tall buildings (`R`)
- Day and night modes, with lit windows, street lamps and aircraft lights on towers (`N`)
- Search for named places, or jump to landmarks like the Shard, St Paul's and Canary Wharf
- Shareable links: the URL keeps your position, zoom and rotation

- **True 3D landmarks.** Buildings drawn with OpenStreetMap's 3D `building:part` shapes, so St Paul's has its drum and dome and towers keep their stepped tops, plus courtyard blocks (Somerset House, the British Museum) with open courtyards.
- **Real colours** from `building:colour` and `roof:colour`, and pyramid, spire, dome and gabled roofs from `roof:shape`.
- **Landmark fixes** (`scripts/landmarks.mjs`): hand-checked heights for the Shard, the Gherkin, Big Ben, One Canada Square and two dozen others, used only where OSM has no height. Plus the London Eye, Tower Bridge's towers and walkways, Nelson's Column and the Monument.
- **The Thames whale** surfaces and blows, dives tail-up, and breaches clear of the water with a splash.

## How it works

**1. Fetch** (`scripts/fetch.mjs`)
Splits the area in `config.json` into a grid and downloads buildings, water, parks, roads and railways from the [Overpass API](https://overpass-api.de). The download can be resumed and retries with backoff across mirror servers.

**2. Build** (`scripts/build.mjs`)
- Projects coordinates to local metres.
- Joins multipolygon relations (like the Thames) into rings.
- Simplifies shapes with Douglas–Peucker.
- Estimates each building's height from its `height` or `building:levels` tags, or from its type when those are missing.
- Assigns each building a material: red brick, London stock brick, Portland stone, stucco, glass, concrete or church.
- Scatters trees through parks.
- Writes compact JSON chunks, using 0.5 m integer coordinates.

**3. Render** (`public/iso.js`)
A Canvas 2D renderer with no dependencies:
- Extrudes building footprints into 2:1 isometric blocks.
- Culls walls facing away from the viewer and shades the rest by direction.
- Draws a row of windows for each floor, plus pitched roofs and domes.
- Depth-sorts everything with the painter's algorithm.

Each chunk is painted once into off-screen bitmaps:
- They are cached per level of detail, rotation and day/night mode, using an LRU memory budget.
- Panning only copies pixels.
- Zooming out swaps to lower-resolution bitmaps.
- Edges are hard-thresholded so the result reads as pixel art.

## Run it locally

You need Node 18 or newer.

```bash
npm run sample   # builds a small fake neighbourhood, which takes seconds
npm run serve    # then open http://localhost:8000
```

To build the real London map:

```bash
rm -rf cache/raw          # remove the sample
npm run fetch             # downloads about 28 areas of OpenStreetMap data, 15–30 min
npm run build
npm run serve
```

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. Go to **Actions → Build and deploy map → Run workflow**.

The workflow downloads the data, builds the chunks and publishes the site. The download is cached between runs.

## Map another city

Change `bbox`, `start` and `landmarks` in `config.json`, then rerun fetch and build. The building palette is tuned for London, but the rest of the code works for any city.

## Credits

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), under the ODbL.
- Inspired by [isometric.nyc](https://cannoneyed.com/isometric-nyc/).
- Built by Ari Khan. Code under the MIT licence.
