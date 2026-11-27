// S31: el modo de color elegido (Alt+1..4) es el canal y manda sobre todo, incluido el
// color personalizado. «Propio» existe para ver esa marca manual; fuera de ese modo,
// «Supervisor» tiene que dar supervisor y «Zona» tiene que dar zona.
// Remate e intermedio conservan su tono propio sólo en «Zona», donde no son una zona.
//
// El chequeo es de comportamiento: extrae `getPointColor` y la expresión de color del
// estilo real del mapa, y las evalúa con features y catálogos falsos.
// Correr contra una versión anterior tiene que dar ROJO.
//
//   node tools/harness/color-by-check.mjs build-versions/centrality_v13.6.0
//
// exit 0 todo verde · exit 1 alguna falla · exit 2 no se pudo leer el fuente
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("uso: node tools/harness/color-by-check.mjs <build-versions/centrality_vX>");
  process.exit(2);
}
const file = path.join(dir, "src", "app.js");
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

// Igual que sliceBalanced, pero para una expresión: corta en el `;` de profundidad 0.
function sliceExpr(source, start) {
  let depth = 0;
  let out = "";
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) return out.trim();
    out += ch;
  }
  return null;
}

// --- getPointColor ---------------------------------------------------------
const gpAnchor = src.indexOf("const getPointColor = (f) => {");
if (gpAnchor < 0) {
  console.error("ROJO: no se encontró `const getPointColor = (f) => {`.");
  process.exit(1);
}
const gpBody = sliceBalanced(src, src.indexOf("{", gpAnchor), "{", "}");
if (!gpBody) {
  console.error("ROJO: el cuerpo de getPointColor no está balanceado.");
  process.exit(1);
}
const gpExpr = `(f) => ${gpBody}`;
const getPointColor = new Function(
  "state", "isHex", "UNASSIGNED_ZONE_COLOR", "OPENING_COLOR",
  "getPointZoneIds", "HIGH_CONTRAST_PALETTE", "getSupId",
  `return (${gpExpr});`
);

// --- expresión de color del estilo del mapa -------------------------------
const colAnchor = src.indexOf("const color = ");
if (colAnchor < 0) {
  console.error("ROJO: no se encontró `const color = ` en la función de estilo.");
  process.exit(1);
}
const colExpr = sliceExpr(src, colAnchor + "const color = ".length);
if (!colExpr) {
  console.error("ROJO: no se pudo extraer la expresión de color.");
  process.exit(1);
}
const styleColor = new Function(
  "state", "isRemate", "isIntermedio", "getPointColor", "f",
  `return (${colExpr});`
);

// --- arnes falsos ---------------------------------------------------------
const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const UNASSIGNED = "#94A3B8";
const OPENING = "#DC2626";
const PALETTE = ["#111111", "#222222", "#333333"];
const SUP_CC = "#F97316";
const EST_EJEC = "#16A34A";
const ZONA_D = "#B91C1C";
const CUSTOM_VERDE = "#22C55E";

const makeState = (colorBy) => ({
  colorBy,
  supervisors: new Map([
    ["default", { id: "default", initials: "—", color: UNASSIGNED }],
    ["cc", { id: "cc", initials: "CC", color: SUP_CC }]
  ]),
  statuses: new Map([["ejecutado", { id: "ejecutado", name: "Ejecutado", color: EST_EJEC }]]),
  zones: new Map([["D", { id: "D", color: ZONA_D }]])
});
const getSupId = (f) => f.get("supId") || "default";
const getPointZoneIds = (f) => f.get("zonas") || [];

const feature = (props) => ({ get: (k) => props[k] });
const regularCC = feature({ supId: "cc", estadoEjec: "ejecutado", zonas: ["D"] });
const ccConCustom = feature({ supId: "cc", estadoEjec: "ejecutado", zonas: ["D"], colorPersonalizado: CUSTOM_VERDE });
const apertura = feature({ supId: "cc", tipo: "APERTURA", zonas: ["D"] });

const gp = (st, f) =>
  getPointColor(st, isHex, UNASSIGNED, OPENING, getPointZoneIds, PALETTE, getSupId)(f);

const pass = [];
const fail = [];
const check = (name, got, want) => {
  (got === want ? pass : fail).push(`${name} → esperado ${want}, obtenido ${got}`);
};
const run = (name, fn, want) => {
  let got;
  try {
    got = fn();
  } catch (err) {
    got = `ERROR: ${err.message}`;
  }
  check(name, got, want);
};

// Canal de color: manda el modo, no la marca manual.
run("supervisor: un punto CC con color propio igual sale naranja de CC",
  () => gp(makeState("supervisor"), ccConCustom), SUP_CC);
run("supervisor: un punto CC sin color propio sale naranja de CC",
  () => gp(makeState("supervisor"), regularCC), SUP_CC);
run("estado: un punto con color propio sale con el color de su estado",
  () => gp(makeState("estado"), ccConCustom), EST_EJEC);
run("zone: un punto con color propio sale con el color de su zona",
  () => gp(makeState("zone"), ccConCustom), ZONA_D);
run("propio: la marca manual es la única fuente",
  () => gp(makeState("propio"), ccConCustom), CUSTOM_VERDE);
run("propio: sin marca manual el punto queda sin asignar",
  () => gp(makeState("propio"), regularCC), UNASSIGNED);
run("supervisor: una apertura conserva el color de apertura",
  () => gp(makeState("supervisor"), apertura), OPENING);

// Forma del punto: no secuestra el color fuera de «Zona».
const estilo = (colorBy, isRemate, isIntermedio) =>
  styleColor(makeState(colorBy), isRemate, isIntermedio, () => SUP_CC, regularCC);
run("supervisor: un remate sale con el color del supervisor", () => estilo("supervisor", true, false), SUP_CC);
run("supervisor: un intermedio sale con el color del supervisor", () => estilo("supervisor", false, true), SUP_CC);
run("zone: el remate conserva el violeta propio", () => estilo("zone", true, false), "#7C3AED");
run("zone: el intermedio conserva el gris propio", () => estilo("zone", false, true), "#64748B");
run("zone: un poste normal toma el color del canal", () => estilo("zone", false, false), SUP_CC);

console.log(JSON.stringify({ check: "color-by S31", build: dir, pass, fail }, null, 2));
process.exit(fail.length ? 1 : 0);
