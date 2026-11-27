// R6.2 — Backup homónimo. El nombre del archivo de backup tiene que derivar de un
// identificador estable del proyecto, no de su nombre, para que dos proyectos con el
// mismo nombre no pisen el mismo archivo.
//
// El chequeo extrae `backupFileName` del fuente real y lo evalúa con dos proyectos
// de igual nombre; no reimplementa la lógica.
//
//   node tools/harness/backup-filename-check.mjs [src/app.js]
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

const anchor = src.indexOf("function backupFileName(");
if (anchor < 0) {
  console.error("ROJO: no se encontró `function backupFileName(` en el fuente.");
  process.exit(1);
}
const body = sliceBalanced(src, src.indexOf("{", anchor), "{", "}");
if (!body) {
  console.error("ROJO: el cuerpo de backupFileName no está balanceado.");
  process.exit(1);
}
const backupFileName = new Function(`return ((project) => ${body});`)();

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
const notEq = (name, fn, avoid) => {
  let got;
  try {
    got = fn();
  } catch (err) {
    got = `ERROR: ${err.message}`;
  }
  (got !== avoid ? pass : fail).push(`${name} → se esperaba distinto de ${JSON.stringify(avoid)}, obtenido ${JSON.stringify(got)}`);
};

run("un proyecto sin id cae al nombre por defecto",
  () => backupFileName({ id: "", name: "Igual" }),
  "proyecto.json");

notEq("dos proyectos homónimos no comparten archivo",
  () => backupFileName({ id: "A", name: "Igual" }),
  backupFileName({ id: "B", name: "Igual" }));

run("el mismo id da el mismo archivo aunque cambie el nombre",
  () => backupFileName({ id: "estable-1", name: "Uno" }) === backupFileName({ id: "estable-1", name: "Otro" }),
  true);

run("el id se normaliza con el mismo criterio de nombre seguro",
  () => backupFileName({ id: "proj 1/2", name: "x" }),
  "proj_1_2.json");

console.log(JSON.stringify({ check: "r6.2 backup filename", file, pass, fail }, null, 2));
process.exit(fail.length ? 1 : 0);
