// R6.1 — Autoguardado silencioso. El manejador de resultado del guardado tiene que
// dejar el badge en un estado de error visible con su motivo ante un fallo, y un
// guardado posterior exitoso tiene que limpiarlo (no dejar el error pegado).
//
// El chequeo extrae `handleAutosaveResult` del fuente real y lo evalúa con un
// rechazo simulado; no reimplementa la lógica.
//
//   node tools/harness/autosave-check.mjs [src/app.js]
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

const anchor = src.indexOf("function handleAutosaveResult(");
if (anchor < 0) {
  console.error("ROJO: no se encontró `function handleAutosaveResult(` en el fuente.");
  process.exit(1);
}
const body = sliceBalanced(src, src.indexOf("{", anchor), "{", "}");
if (!body) {
  console.error("ROJO: el cuerpo de handleAutosaveResult no está balanceado.");
  process.exit(1);
}

const seen = [];
const updateSaveIndicator = (txt) => seen.push(txt);
const makeHandler = new Function("updateSaveIndicator", `return ((result) => ${body});`);
const handleAutosaveResult = makeHandler(updateSaveIndicator);

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

run("fallo de guardado deja el badge en error con su motivo",
  () => { seen.length = 0; handleAutosaveResult({ ok: false, error: "QuotaExceededError" }); return seen[seen.length - 1]; },
  "Error al guardar: QuotaExceededError");

run("un guardado exitoso posterior limpia el error",
  () => { seen.length = 0; handleAutosaveResult({ ok: false, error: "QuotaExceededError" }); handleAutosaveResult({ ok: true, label: "Guardado · solo navegador" }); return seen[seen.length - 1]; },
  "Guardado · solo navegador");

run("fallo sin mensaje usa un motivo genérico",
  () => { seen.length = 0; handleAutosaveResult({ ok: false }); return seen[seen.length - 1]; },
  "Error al guardar: error desconocido");

console.log(JSON.stringify({ check: "r6.1 autosave", file, pass, fail }, null, 2));
process.exit(fail.length ? 1 : 0);
