// R6.4 — Geometría nula. `getZoneRingLonLat` no puede desreferenciar un feature sin
// geometría: un feature con `geometry: null` se saltea y, si no quedan al menos 3
// puntos, la zona devuelve vacío en vez de lanzar.
//
// El chequeo extrae `getZoneRingLonLat` del fuente real y lo evalúa con features falsos;
// no reimplementa la lógica.
//
//   node tools/harness/null-geometry-check.mjs [src/app.js]
//
// exit 0 verde · exit 1 rojo · exit 2 no se pudo leer el fuente
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2] || path.join("src", "app.js");
let src;
try {
  src = fs.readFileSync(file, "utf8");
} catch (err) {
  console.error(`no se pudo leer ${file}: ${err.message}`);
  process.exit(2);
}

// Corta desde `start` balanceando `open`/`close`; devuelve el texto completo inclusive.
function sliceBalanced(source, start, open, close) {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

const anchor = src.indexOf("function getZoneRingLonLat(");
if (anchor < 0) {
  console.error("ROJO: no se encontró `function getZoneRingLonLat(` en el fuente.");
  process.exit(1);
}
const body = sliceBalanced(src, src.indexOf("{", anchor), "{", "}");
if (!body) {
  console.error("ROJO: el cuerpo de getZoneRingLonLat no está balanceado.");
  process.exit(1);
}
const getZoneRingLonLat = new Function(
  "state", "map", "ol", "getPointZoneIds", "convexHullLonLat",
  `return ((zoneId) => ${body});`
);

// --- arnes falsos ---------------------------------------------------------
const geom = (coords) => ({ getCoordinates: () => coords });
const feat = (zones, g) => ({ zones, getGeometry: () => g });
const proj = {};
const fakeMap = { getView: () => ({ getProjection: () => proj }) };
const fakeOl = { proj: { toLonLat: (xy) => xy } };
const getPointZoneIds = (f) => f.zones || [];
const convexHullLonLat = (pts) => pts;

const make = (zones, points) => ({
  zones: new Map(zones.map(([id, z]) => [id, z])),
  points
});

const pass = [];
const fail = [];
const run = (name, fn, want) => {
  let got;
  try {
    got = fn();
  } catch (err) {
    got = `ERROR: ${err.message}`;
  }
  const ok = JSON.stringify(got) === JSON.stringify(want);
  (ok ? pass : fail).push(`${name} → esperado ${JSON.stringify(want)}, obtenido ${JSON.stringify(got)}`);
};

const evalRing = (state) =>
  getZoneRingLonLat(state, fakeMap, fakeOl, getPointZoneIds, convexHullLonLat)("D");

run("un feature sin geometría devuelve vacío en vez de lanzar",
  () => evalRing(make([["D", { id: "D", customRing: null }]], [feat(["D"], null)])),
  null);

run("tres features con geometría siguen formando el anillo",
  () => evalRing(make([["D", { id: "D", customRing: null }]], [
    feat(["D"], geom([1, 2])), feat(["D"], geom([3, 4])), feat(["D"], geom([5, 6]))
  ])),
  [[1, 2], [3, 4], [5, 6]]);

run("un feature sin geometría entre válidos se ignora sin lanzar",
  () => evalRing(make([["D", { id: "D", customRing: null }]], [
    feat(["D"], geom([1, 2])), feat(["D"], null), feat(["D"], geom([3, 4])), feat(["D"], geom([5, 6]))
  ])),
  [[1, 2], [3, 4], [5, 6]]);

console.log(JSON.stringify({ check: "r6.4 null geometry", file, pass, fail }, null, 2));
process.exit(fail.length ? 1 : 0);
