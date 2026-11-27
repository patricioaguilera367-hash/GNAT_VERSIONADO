// R6.3 — Drain duplicado. Existe un único owner del drain: una cola con un drain en
// curso (`running`) o en pausa no puede arrancar otra corrida. Cancelar y reencolar no
// abre un segundo drain porque el owner lo libera sólo la corrida que lo tomó, no el
// botón de cancelar.
//
// El chequeo extrae `canStartDrain` del fuente real y lo evalúa con estados de cola;
// no reimplementa la lógica.
//
//   node tools/harness/drain-owner-check.mjs [src/app.js]
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

const anchor = src.indexOf("function canStartDrain(");
if (anchor < 0) {
  console.error("ROJO: no se encontró `function canStartDrain(` en el fuente.");
  process.exit(1);
}
const body = sliceBalanced(src, src.indexOf("{", anchor), "{", "}");
if (!body) {
  console.error("ROJO: el cuerpo de canStartDrain no está balanceado.");
  process.exit(1);
}
const canStartDrain = new Function(`return ((q) => ${body});`)();

const pass = [];
const fail = [];
const run = (name, fn, want) => {
  let got;
  try {
    got = fn();
  } catch (err) {
    got = `ERROR: ${err.message}`;
  }
  (got === want ? pass : fail).push(`${name} → esperado ${JSON.stringify(want)}, obtenido ${JSON.stringify(got)}`);
};

run("cola libre puede arrancar",
  () => canStartDrain({ running: false, paused: false }), true);
run("cola con un drain en curso no arranca otro (un único owner)",
  () => canStartDrain({ running: true, paused: false }), false);
run("cola en pausa no arranca",
  () => canStartDrain({ running: false, paused: true }), false);
run("sin cola no arranca",
  () => canStartDrain(null), false);

console.log(JSON.stringify({ check: "r6.3 drain owner", file, pass, fail }, null, 2));
process.exit(fail.length ? 1 : 0);
