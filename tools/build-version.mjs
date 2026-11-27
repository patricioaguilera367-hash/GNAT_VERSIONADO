#!/usr/bin/env node
// Materializa un build de la extensión a partir de src/, la fuente única de trabajo.
//
// Por qué existe: hasta ahora cada versión se creaba copiando a mano el directorio de la
// anterior, así que build-versions/ era a la vez salida y única copia del producto — 284 KB
// de app.js por versión y ni un commit que los respalde. Ahora src/ está versionado y este
// script produce el build.
//
// El contrato no cambia: un directorio por versión y una versión construida no se reescribe.
// Si el destino ya existe, se aborta en lugar de sobrescribirlo.
//
// Uso:
//   node tools/build-version.mjs 13.7.0
//   node tools/build-version.mjs 13.7.0 --out .tmp-build-check   (verificación)

import fs from 'node:fs';
import path from 'node:path';

import { findProductionData } from './data-guard.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

const args = process.argv.slice(2);
const version = args[0];
const outFlag = args.indexOf('--out');
const outDir = outFlag >= 0
  ? path.resolve(ROOT, args[outFlag + 1] || '')
  : path.join(ROOT, 'build-versions', `centrality_v${version}`);

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('uso: node tools/build-version.mjs <major.minor.patch> [--out <dir>]');
  process.exit(3);
}
if (outFlag >= 0 && !args[outFlag + 1]) {
  console.error('--out necesita un directorio');
  process.exit(3);
}
if (!fs.existsSync(SRC)) {
  console.error(`no existe la fuente: ${SRC}`);
  process.exit(3);
}
if (fs.existsSync(outDir)) {
  console.error(`ABORTADO: ${path.relative(ROOT, outDir)} ya existe.`);
  console.error('Una versión construida no se reescribe: creá un directorio nuevo con otra versión.');
  process.exit(1);
}

// Regla de materialización, en un solo lugar: background.js vive en la raíz del build
// porque el manifest lo declara ahí; el resto de los .js van a src/.
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
if (!files.includes('background.js')) {
  console.error('la fuente no tiene src/background.js');
  process.exit(3);
}

const templatePath = path.join(SRC, 'manifest.template.json');
let manifestText;
try {
  manifestText = fs.readFileSync(templatePath, 'utf8').split('{{VERSION}}').join(version);
} catch (err) {
  console.error(`no se pudo leer ${templatePath}: ${err.message}`);
  process.exit(3);
}

// Validar antes de escribir: un manifest inválido deja una extensión que no carga.
let manifest;
try {
  manifest = JSON.parse(manifestText);
} catch (err) {
  console.error(`el manifest renderizado no es JSON válido: ${err.message}`);
  process.exit(3);
}
if (manifest.version !== version) {
  console.error(`el manifest renderizado dice ${manifest.version}, se pidió ${version}`);
  process.exit(3);
}

fs.mkdirSync(path.join(outDir, 'src'), { recursive: true });
for (const name of files) {
  const target = name === 'background.js'
    ? path.join(outDir, name)
    : path.join(outDir, 'src', name);
  // Un build reproducible tiene que coincidir byte a byte con lo que guarda git: se escribe
  // siempre con LF, sin importar el core.autocrlf del clon donde corre el build.
  fs.writeFileSync(target, fs.readFileSync(path.join(SRC, name), 'utf8').replace(/\r\n/g, '\n'));
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// La guarda corre sobre el build recién escrito, no sobre la fuente: lo que se publica
// es el build, y es el build lo que no puede contener datos de producción.
const violations = findProductionData(outDir);
if (violations.length) {
  fs.rmSync(outDir, { recursive: true, force: true });
  console.error('ABORTADO: el build contiene datos de producción o binarios:');
  for (const v of violations) console.error(`  ${v.rel} — ${v.why}`);
  process.exit(1);
}

console.log(`v${version} → ${path.relative(ROOT, outDir)} (${files.length + 1} archivos)`);
