#!/usr/bin/env node
// Publica un build de build-versions/ como commit + tag en GNAT_VERSIONADO.
//
// Por qué vive acá y no en %LOCALAPPDATA%/Temp: la versión anterior de este paso
// era un script descartable fuera del repo, y cuando se borró el Temp dejaron de
// publicarse las versiones. El versionado es parte del proyecto, no scratch.
//
// Uso:
//   node tools/publish-version.mjs 13.0.7 "fix(ui): toggle de popover, chip supervisor, tri-state"
//   node tools/publish-version.mjs 13.0.7 "..." --no-push
//
// No hace push salvo que se lo pidas explícitamente con --push.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findProductionData } from './data-guard.mjs';

const REPO_URL = 'https://github.com/patricioaguilera367-hash/GNAT_VERSIONADO.git';
const ROOT = path.resolve(import.meta.dirname, '..');

const args = process.argv.slice(2);
const version = args[0];
const message = args[1];
const doPush = args.includes('--push');

if (!version || !message) {
  console.error('uso: node tools/publish-version.mjs <version> "<mensaje>" [--push]');
  process.exit(3);
}

const buildDir = path.join(ROOT, 'build-versions', `centrality_v${version}`);
if (!fs.existsSync(buildDir)) {
  console.error(`no existe el build: ${buildDir}`);
  process.exit(3);
}

// Guarda dura: datos de producción nunca entran a un repo público. La lógica vive en
// tools/data-guard.mjs para poder probarla sin ejecutar este script.
const violations = findProductionData(buildDir);
if (violations.length) {
  console.error('ABORTADO: el build contiene datos de producción o binarios:');
  for (const v of violations.slice(0, 10)) console.error(`  ${v.rel} — ${v.why}`);
  if (violations.length > 10) console.error(`  … y ${violations.length - 10} más`);
  process.exit(1);
}

// R4: el tag, la carpeta y el manifest tienen que decir lo mismo. Publicar con una
// versión que no coincide produce un tag que no representa lo que carga el navegador.
let manifestVersion;
try {
  manifestVersion = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest.json'), 'utf8')).version;
} catch (err) {
  console.error(`ABORTADO: no se pudo leer el manifest del build: ${err.message}`);
  process.exit(1);
}
if (manifestVersion !== version) {
  console.error(`ABORTADO: se pide publicar ${version} pero el build dice ${manifestVersion}.`);
  process.exit(1);
}

// El clon publicado vive junto a los demas proyectos, no en un directorio temporal:
// perder el clon o el script es lo que hizo que el historial se detuviera en v13.0.6.
const cloneDir = process.env.GNAT_VERSIONADO_DIR || path.join(os.homedir(), 'Desktop', 'Proyectos', 'GNAT_VERSIONADO');
fs.mkdirSync(path.dirname(cloneDir), { recursive: true });

const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

if (!fs.existsSync(path.join(cloneDir, '.git'))) {
  console.log(`clonando ${REPO_URL}`);
  execFileSync('git', ['clone', '--quiet', REPO_URL, cloneDir], { stdio: ['ignore', 'pipe', 'pipe'] });
} else {
  console.log('actualizando el clon existente');
  git(cloneDir, 'fetch', '--quiet', '--tags', 'origin');
  // Nunca descartar commits locales sin push. Un `reset --hard origin/main` acá
  // borró las publicaciones de 13.0.7 y 13.0.8 y dejó sus tags apuntando a
  // commits huérfanos: el contenido quedó aplastado en un solo commit.
  const ahead = Number(git(cloneDir, 'rev-list', '--count', 'origin/main..HEAD') || '0');
  if (ahead === 0) {
    git(cloneDir, 'checkout', '--quiet', 'main');
    git(cloneDir, 'reset', '--quiet', '--hard', 'origin/main');
  } else {
    console.log(`el clon tiene ${ahead} commit(s) local(es) sin push: se conservan y el nuevo va encima`);
  }
}

const tag = `v${version}`;
const existing = git(cloneDir, 'tag', '-l', tag);
if (existing) {
  console.error(`ABORTADO: el tag ${tag} ya existe en GNAT_VERSIONADO. Una versión publicada no se reescribe.`);
  process.exit(1);
}

const target = path.join(cloneDir, 'extension');
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(buildDir, target, { recursive: true });

git(cloneDir, 'add', '-A');
const staged = git(cloneDir, 'status', '--porcelain');
if (!staged) {
  console.error('ABORTADO: no hay cambios que publicar (el build es idéntico al publicado).');
  process.exit(1);
}

git(cloneDir, 'commit', '--quiet', '-m', message);
git(cloneDir, 'tag', '-a', tag, '-m', `Centrality Local ${version}`);
console.log(`commit + tag ${tag} creados en ${cloneDir}`);

if (doPush) {
  git(cloneDir, 'push', '--quiet', 'origin', 'HEAD', '--tags');
  console.log(`publicado: ${tag}`);
} else {
  console.log('sin push. Para publicar:');
  console.log(`  git -C "${cloneDir}" push origin HEAD --tags`);
}
