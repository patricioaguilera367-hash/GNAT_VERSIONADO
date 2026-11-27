#!/usr/bin/env node
// Reescribe el "Índice de versiones" del README de GNAT_VERSIONADO a partir de los
// tags reales del repositorio.
//
// Por qué existe: el índice se mantenía a mano y quedó congelado en v13.0.6 mientras
// se publicaban trece versiones más. Un índice que miente es peor que no tenerlo: el
// archivo histórico se lee por ese índice. Regenerarlo desde los tags hace imposible
// que vuelva a desincronizarse.
//
// Uso: node tools/index-versions.mjs [--push]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const doPush = process.argv.includes('--push');
const cloneDir = process.env.GNAT_VERSIONADO_DIR || path.join(os.homedir(), 'Desktop', 'Proyectos', 'GNAT_VERSIONADO');

if (!fs.existsSync(path.join(cloneDir, '.git'))) {
  console.error(`no hay clon en ${cloneDir}`);
  process.exit(3);
}

const git = (...rest) => execFileSync('git', rest, { cwd: cloneDir, encoding: 'utf8' }).trim();

// Notas que los tags no pueden explicar por sí solos.
const NOTES = {
  'v10.1': 'el directorio dice 10.1 pero el manifest declara 10.2.0; el tag sigue al directorio',
  'v10.4': 'el directorio dice 10.4 pero el manifest declara 10.3.0; el tag sigue al directorio',
};

const versionKey = (tag) =>
  tag.replace(/^v/, '').split('.').map(n => Number(n) || 0);

const tags = git('tag', '-l')
  .split('\n')
  .map(t => t.trim())
  .filter(Boolean)
  .sort((a, b) => {
    const ka = versionKey(a);
    const kb = versionKey(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (ka[i] || 0) - (kb[i] || 0);
      if (d !== 0) return d;
    }
    return a.localeCompare(b);
  });

const rows = [];
for (const tag of tags) {
  let manifestVersion = '—';
  try {
    const manifest = JSON.parse(git('show', `${tag}:extension/manifest.json`));
    manifestVersion = manifest.version || '—';
  } catch {
    // un tag sin manifest se indexa igual: el hueco queda visible
  }
  const date = git('log', '-1', '--format=%ad', '--date=format:%Y-%m-%d %H:%M', tag);
  const files = git('ls-tree', '-r', '--name-only', tag, '--', 'extension').split('\n').filter(Boolean).length;
  const notes = [];
  if (NOTES[tag]) notes.push(NOTES[tag]);
  const tagged = tag.replace(/^v/, '');
  if (manifestVersion !== '—' && manifestVersion !== tagged) {
    notes.push(`el tag dice ${tagged} y el manifest declara ${manifestVersion}`);
  }
  rows.push(`| \`${tag}\` | ${date} | ${manifestVersion} | ${files} | ${notes.join('; ')} |`);
}

const readmePath = path.join(cloneDir, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const startMarker = '| Tag | Fecha | Manifest | Archivos | Nota |';
const startIndex = readme.indexOf(startMarker);
if (startIndex < 0) {
  console.error('no se encontró la tabla de índice en el README (falta el encabezado)');
  process.exit(3);
}
// El bloque de tabla termina en la primera línea que ya no empieza con "|".
const lines = readme.split('\n');
const headerLine = lines.findIndex(l => l.startsWith(startMarker));
let endLine = headerLine;
while (endLine + 1 < lines.length && lines[endLine + 1].startsWith('|')) endLine++;

const table = [
  startMarker,
  '| --- | --- | --- | --- | --- |',
  ...rows,
];
const rebuilt = [...lines.slice(0, headerLine), ...table, ...lines.slice(endLine + 1)].join('\n');

if (rebuilt === readme) {
  console.log(`el índice ya está al día (${rows.length} versiones)`);
  process.exit(0);
}

fs.writeFileSync(readmePath, rebuilt, 'utf8');
console.log(`índice reescrito con ${rows.length} versiones (antes ${headerLine >= 0 ? endLine - headerLine - 1 : 0} filas)`);
console.log(`últimas: ${rows.slice(-3).join('\n         ')}`);

git('add', 'README.md');
git('commit', '--quiet', '-m', `docs(README): el indice sale de los tags, ${rows.length} versiones indexadas`);
console.log('commit del índice creado');
if (doPush) {
  git('push', '--quiet', 'origin', 'HEAD');
  console.log('índice publicado');
} else {
  console.log('sin push. Para publicar: git -C "' + cloneDir + '" push origin HEAD');
}
