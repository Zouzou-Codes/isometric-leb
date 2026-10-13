// Hand-checked facts about London's landmarks, used where OpenStreetMap is missing detail.
//
// OpenStreetMap is always preferred: an override only applies when the building found at that
// point has no height of its own in OSM, and the extra pieces (domes, chimneys, towers) are only
// added when OSM has no 3D "building:part" shapes for that building already.
//
// h: height to the main roof (m) · roof: flat | gabled | dome | pyramid · roofH: height of the roof itself
// mat: stone | glass | glass2 | concrete | redbrick | stockbrick | stucco | church
// add: extra pieces, each placed relative to the building:
//   { circle: [lat, lng, radius], base, h, roof, roofH, mat }        a round tower, drum or dome
//   { corners: inset (0–0.5), radius, h, mat }                        four chimneys at the corners
//   { towers: [[lat, lng], …], size, h, roof, roofH, mat }            square towers
//   { slab: [[lat, lng], [lat, lng]], width, base, h, mat }           a walkway between two points

export const OVERRIDES = [
  // the City cluster
  { name: "The Shard", at: [51.50451, -0.08649], h: 24, roof: "pyramid", roofH: 286, mat: "glass" },
  { name: "30 St Mary Axe (the Gherkin)", at: [51.51448, -0.08033], h: 150, roof: "dome", roofH: 30, mat: "glass2" },
  { name: "20 Fenchurch Street (Walkie-Talkie)", at: [51.51127, -0.08341], h: 160, mat: "glass" },
  { name: "The Leadenhall Building (Cheesegrater)", at: [51.5137, -0.08218], h: 225, mat: "glass" },
  { name: "22 Bishopsgate", at: [51.51463, -0.0828], h: 278, mat: "glass" },
  { name: "Heron Tower", at: [51.51623, -0.08068], h: 202, mat: "glass2" },
  { name: "Tower 42", at: [51.51518, -0.08389], h: 183, mat: "glass2" },
  { name: "Lloyd's building", at: [51.5129, -0.08218], h: 95, mat: "concrete" },
  { name: "Broadgate Tower", at: [51.52083, -0.07917], h: 164, mat: "glass" },
  { name: "Centre Point", at: [51.516, -0.1302], h: 117, mat: "concrete" },
  { name: "One Blackfriars", at: [51.5078, -0.1037], h: 170, mat: "glass" },
  { name: "St George Wharf Tower", at: [51.486, -0.1256], h: 181, mat: "glass" },
  { name: "BT Tower", at: [51.52152, -0.13891], h: 177, mat: "glass2" },
  // Canary Wharf
  { name: "One Canada Square", at: [51.50493, -0.01953], h: 222, roof: "pyramid", roofH: 13, mat: "stone" },
  { name: "8 Canada Square", at: [51.50513, -0.01725], h: 200, mat: "glass" },
  { name: "25 Canada Square", at: [51.50444, -0.01688], h: 200, mat: "glass" },
  // Westminster
  { name: "Elizabeth Tower (Big Ben)", at: [51.50073, -0.12463], h: 72, roof: "pyramid", roofH: 24, mat: "stone" },
  { name: "Victoria Tower", at: [51.49844, -0.12503], h: 98, mat: "stone" },
  { name: "Westminster Abbey", at: [51.49929, -0.12731], h: 31, roof: "gabled", roofH: 8, mat: "church" },
  { name: "Buckingham Palace", at: [51.5014, -0.14189], h: 24, mat: "stone" },
  // the City and the South Bank
  { name: "St Paul's Cathedral", at: [51.51381, -0.09838], h: 30, roof: "gabled", roofH: 6, mat: "stone",
    add: [{ circle: [51.51381, -0.09838, 17], base: 0, h: 72, mat: "stone" }, { circle: [51.51381, -0.09838, 15], base: 72, h: 80, roof: "dome", roofH: 20, mat: "church" }, { circle: [51.51381, -0.09838, 3], base: 96, h: 105, roof: "pyramid", roofH: 6, mat: "stone" }] },
  { name: "Tate Modern", at: [51.50758, -0.09936], h: 35, mat: "redbrick", add: [{ circle: [51.50775, -0.09936, 6], base: 0, h: 99, mat: "redbrick" }] },
  { name: "Tower of London (White Tower)", at: [51.50812, -0.07597], h: 27, mat: "stone",
    add: [{ corners: 0.08, radius: 3, h: 34, roof: "dome", roofH: 3, mat: "stone" }] },
  { name: "Battersea Power Station", at: [51.48183, -0.14476], h: 50, mat: "redbrick", add: [{ corners: 0.1, radius: 4.5, h: 103, mat: "stucco" }] },
  { name: "Natural History Museum", at: [51.49672, -0.17639], h: 30, roof: "gabled", roofH: 6, mat: "stockbrick" },
  { name: "British Museum", at: [51.51939, -0.12698], h: 25, mat: "stone" }
];

// Structures that aren't buildings, drawn specially.
export const SPECIALS = [
  // London Eye: 120 m wheel, 135 m to the top, its rim running along the river bank
  { type: "wheel", name: "London Eye", at: [51.50330, -0.11955], diameter: 120, hub: 75, bearing: 20 },
  { type: "column", name: "Nelson's Column", at: [51.50773, -0.12803], h: 52, r: 2.6 },
  { type: "column", name: "The Monument", at: [51.51013, -0.08594], h: 62, r: 3.2 },
  // Tower Bridge: two stone towers and the high-level walkways between them
  { type: "towerbridge", name: "Tower Bridge", north: [51.50578, -0.07538], south: [51.50522, -0.07537] }
];
