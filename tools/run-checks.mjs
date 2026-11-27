#!/usr/bin/env node
// Corre todos los chequeos del proyecto con un solo comando y un solo código de salida.
//
// Por qué: hasta ahora cada chequeo se corría a mano y se leía a ojo, así que "verde" dependía
// de que alguien se acordara de los seis comandos y de interpretar cada salida. Un proyecto sin
// un comando único de validación no puede tener CI: no hay nada que CI pueda repetir.
//
// Uso:
//   node tools/run-checks.mjs                 chequeos que no necesitan build
//   node tools/run-checks.mjs --build 13.6.1  además construye y verifica ese build
//
// exit 0 todo verde · exit 1 algo falló
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const buildFlag = args.indexOf("--build");
const version = buildFlag >= 0 ? args[buildFlag + 1] : null;

// La lista vive en un solo lugar: agregar un chequeo es agregar una línea acá.
const SUITES = [
  { name: "adapter selftest", cmd: ["tools/gnat-adapter/gnat-adapter.selftest.mjs"] },
  { name: "probe selftest", cmd: ["tools/gnat-probe/probe.selftest.mjs"] },
  { name: "anonymize", cmd: ["--test", "tools/anonymize.test.mjs"] },
  { name: "data-guard", cmd: ["--test", "tools/data-guard.test.mjs"] },
  { name: "harness core", cmd: ["--test", "tools/harness/enumerate-core.test.mjs"] },
  { name: "topology", cmd: ["--test", "tools/topology/topology.test.mjs"] },
  { name: "neighbours", cmd: ["--test", "tools/topology/neighbours.test.mjs"] }
];

const run = (label, argv) => {
  try {
    execFileSync(process.execPath, argv, { cwd: ROOT, stdio: "pipe", timeout: 300000 });
    console.log(`  ok    ${label}`);
    return true;
  } catch (err) {
    const output = `${err.stdout || ""}${err.stderr || ""}`.toString().trim().split("\n").slice(-8).join("\n");
    console.log(`  FALLA ${label}`);
    if (output) console.log(output.replace(/^/gm, "        "));
    return false;
  }
};

const results = [];
console.log("chequeos sin build");
for (const suite of SUITES) results.push(run(suite.name, suite.cmd));

if (version) {
  // El directorio NO se crea acá: build-version.mjs aborta si el destino existe, justamente
  // porque una versión construida no se reescribe. Se reserva un nombre único y se lo deja
  // crear al que sabe construirlo.
  const outDir = path.join(os.tmpdir(), `run-checks-${process.pid}-${Date.now()}`);
  console.log(`chequeos sobre el build v${version}`);
  try {
    const built = run("build-version", ["tools/build-version.mjs", version, "--out", outDir]);
    results.push(built);
    if (built) {
      for (const check of ["table-align-check", "resolver-check", "color-by-check"]) {
        results.push(run(check, [`tools/harness/${check}.mjs`, outDir]));
      }
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
} else {
  console.log("(sin --build: no se verifican los chequeos del arnés, que necesitan un build)");
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} suites verdes`);
process.exit(failed ? 1 : 0);
