// Published heights for Beirut's tall buildings, used to correct OpenStreetMap.
//
// Sources: the Council on Vertical Urbanism database (skyscrapercenter.com) where it has a confirmed
// height, otherwise Wikipedia's "List of tallest buildings in Lebanon" (heights and coordinates).
//
// Unlike the London original, these heights always win over OpenStreetMap's own tags, because
// most Beirut buildings in OSM only have an estimated floor count or nothing at all.
//
// Each entry finds its building either by a point (at: [lat, lng]) or by its OSM name (match: regex).
// A point that lands on a street falls back to the nearest large building within 40 m.
// The build log lists every entry and whether it found a building.
//
// h: height to the roof (m) · mat: stone | glass | glass2 | concrete | redbrick | stockbrick | stucco
// (in the Beirut palette, redbrick = ochre plaster, stockbrick = sandstone, stucco = white plaster)

export const OVERRIDES = [
  { name: "Sama Beirut", at: [33.8870833, 35.5102222], h: 195.2, mat: "glass" },
  { name: "Sky Gate", at: [33.8877778, 35.5175556], h: 180.4 },
  { name: "FortyFour", at: [33.880528, 35.542250], h: 172 },
  { name: "Les Domes de Sursock", at: [33.8929167, 35.5177778], h: 163.6 },
  { name: "2030", at: [33.8896389, 35.5141944], h: 155 },
  { name: "Platinum Tower", at: [33.9006944, 35.4964444], h: 153, mat: "glass" },
  { name: "Abdel Wahab 618", at: [33.8891667, 35.5158333], h: 152 },
  { name: "Marina Tower", at: [33.9017222, 35.4987500], h: 149, mat: "glass" },
  { name: "L'Elite de Sursock", match: "elite.*sursock", h: 142 },
  { name: "Burj el Murr", at: [33.8952778, 35.4965000], h: 140, mat: "concrete" },
  { name: "Place Pasteur", at: [33.8956944, 35.5138889], h: 140 },
  { name: "La Citadelle", at: [33.9020000, 35.4922778], h: 140 },
  { name: "Quasar Saifi 450", match: "quasar", h: 138.4 },
  { name: "Credit Libanais Tower", at: [33.8801667, 35.5245000], h: 133 },
  { name: "Hilton Habtoor Grand", at: [33.8693889, 35.5372222], h: 130 },
  { name: "3 Beirut", at: [33.8989722, 35.4976944], h: 126 },
  { name: "Bay Tower", at: [33.9006944, 35.4977778], h: 125 },
  { name: "Achrafieh 4748", at: [33.8784167, 35.5286944], h: 120 },
  { name: "Four Seasons Hotel", at: [33.9018889, 35.4992500], h: 120 },
  { name: "Beirut Terraces", at: [33.8997222, 35.4962500], h: 119.5 },
  { name: "Holiday Inn", at: [33.8996111, 35.4949444], h: 118, mat: "concrete" },
  { name: "Hosn 440", at: [33.8986667, 35.4935556], h: 113 },
  { name: "Beirut Tower", at: [33.9006667, 35.4973611], h: 112.2 },
  { name: "Burj Kronfol", at: [33.8786389, 35.5082778], h: 110 },
  { name: "Rizk Tower", at: [33.8871944, 35.5145556], h: 106, mat: "concrete" },
  { name: "Damac Tower", at: [33.8989722, 35.4959722], h: 102 },
  { name: "The Heights", at: [33.8885000, 35.4801111], h: 102 },
  { name: "Karam Tower", at: [33.8943611, 35.5254167], h: 102 },
  { name: "Ashrafieh Tower", at: [33.8886944, 35.5122222], h: 100 },
  { name: "Atomium 5242", at: [33.8877778, 35.5180556], h: 100 },
  { name: "Al Sahab", at: [33.8933889, 35.4744722], h: 98 },
  { name: "Carlton Residence", at: [33.8858333, 35.4763889], h: 96 },
  { name: "Horizon Tower", at: [33.9015278, 35.4853333], h: 95 },
  { name: "Al Mada Tower", at: [33.8907222, 35.4722778], h: 94 },
  { name: "Raouche View 1090", at: [33.8894722, 35.4725000], h: 94 },
  { name: "Tilal Tower", at: [33.8876667, 35.5171667], h: 91 },
  { name: "Universal Tower", at: [33.8886389, 35.4758611], h: 90 },
  { name: "Verdun Gardens", at: [33.8913889, 35.4838889], h: 90 },
  { name: "Safir Heliopolitan Hotel", at: [33.8915556, 35.4727500], h: 90 },
  { name: "Phoenicia Hotel", at: [33.9006944, 35.4945000], h: 90, mat: "stucco" },
  { name: "Manara 587", at: [33.8970833, 35.4719722], h: 88 },
  { name: "Titanium Tower", at: [33.8866667, 35.4786389], h: 87 },
  { name: "Sky Garden", at: [33.8872778, 35.4754444], h: 87 },
  { name: "Majestic Tower", at: [33.8983333, 35.4904722], h: 87 },
  { name: "Mirage Plaza", at: [33.8926944, 35.4880833], h: 87 },
  { name: "St George Tower 1 (Alpha)", at: [33.8843333, 35.5205833], h: 87 },
  { name: "St George Tower 2 (Delta)", at: [33.8848333, 35.5211667], h: 87 },
  { name: "St George Tower 3 (Omega)", at: [33.8844444, 35.5214167], h: 87 },
  { name: "Al Aidi Tower", at: [33.8933611, 35.5116667], h: 85 },
  { name: "Sursock Tower", at: [33.8926111, 35.5114444], h: 85 },
  { name: "Corniche Garden", at: [33.9017222, 35.4845278], h: 83 },
  { name: "Astoria Tower", at: [33.8947778, 35.4707222], h: 83 },
  { name: "Dreams Tower", at: [33.9012778, 35.4868056], h: 83 },
  { name: "Hilton Metropolitan Palace", at: [33.8707778, 35.5360000], h: 83 },
  { name: "Hugo 43", at: [33.8889167, 35.5077778], h: 81 },
  { name: "Ain Mreisseh Tower", at: [33.8986667, 35.4917222], h: 80 },
  // Hôtel Saint-Georges: four storeys (1932, two floors added 1946), height estimated from that
  { name: "Hotel Saint-Georges", match: "^(h[oô]tel )?(st\\.?|saint)[ -]georges?( h[oô]tel)?$", h: 18, mat: "redbrick" }
];

// No special structures (wheels, columns, bridges) for Beirut yet.
export const SPECIALS = [];
