#!/usr/bin/env node
// Anonimiza códigos de poste y coordenadas reales en los archivos del repositorio.
//
// Por qué una herramienta y no ediciones a mano: el repositorio público tiene 59 códigos
// distintos repartidos en 220 apariciones y 36 archivos, incluidos los escenarios grabados del
// arnés y el propio producto. Editarlos a mano es frágil y no queda verificable; una función
// determinista sí, porque el mismo código produce siempre el mismo reemplazo en todos los
// archivos, y dos corridas seguidas dan el mismo resultado.
//
// La FORMA se preserva (misma cantidad de letras y de dígitos) porque hay tests y nombres de
// archivo que dependen de ella. Las coordenadas se desplazan con un offset constante, que
// conserva distancias y ángulos dentro de un mismo escenario.
//
// Uso:
//   node tools/anonymize.mjs <archivo...>            informa sin escribir
//   node tools/anonymize.mjs <archivo...> --write    reescribe
//
// Sólo procesa texto. Ignora binarios y archivos mayores a 2 MB.

import fs from "node:fs";
import path from "node:path";

// Un código de poste empieza en un límite de palabra y no va precedido por `#` ni por otro
// carácter de palabra. Sin esa exclusión, un color como `#F97316` matchea el patrón y el
// anonimizador destruye la paleta: ese falso positivo costó una corrida completa.
export const CODE = /(?<![\w#])F([A-Z]{0,3})(\d{3,})\b/g;
export const COORD = /-?\d{2,3}\.\d{6,}/g;
export const OFFSET_LON = 10;
export const OFFSET_LAT = 5;
const MAX_BYTES = 2 * 1024 * 1024;

/** djb2: determinista y suficiente para repartir, no para criptografía. */
export function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h;
}

function digitsOf(n) {
  return String(n).padStart(6, "0").slice(-6);
}

/** Mismo código -> mismo reemplazo, preservando la cantidad de dígitos del original.
 *  La `F` inicial es parte del código y se repone: sin ella el resultado parece un rol.
 */
export function syntheticCode(prefix, digits) {
  const h = hash(`${prefix}${digits}`);
  return `F${prefix}${digitsOf(h % 1000000).slice(-digits.length)}`;
}

export function shiftedCoord(literal) {
  const value = Number(literal);
  const delta = value < -60 ? OFFSET_LON : OFFSET_LAT;
  const decimals = (literal.split(".")[1] || "").length;
  return (value + delta).toFixed(decimals);
}

/**
 * Anonimiza un texto. `seen` acumula código original -> reemplazo para poder informarlo.
 * Los códigos son idempotentes: un reemplazo ya sintético no vuelve a matchear el patrón.
 * Las coordenadas NO lo son: sin estado no se puede distinguir una ya desplazada, así que
 * aplicar dos veces desplaza dos veces. Correr siempre sobre el texto original.
 * @returns {{ text: string, codes: number, coords: number }}
 */
export function anonymizeText(text, seen = new Map()) {
  let codes = 0;
  let coords = 0;
  const out = text
    .replace(CODE, (match, prefix, digits) => {
      const synthetic = syntheticCode(prefix, digits);
      seen.set(match, synthetic);
      codes++;
      return synthetic;
    })
    .replace(COORD, (match) => {
      coords++;
      return shiftedCoord(match);
    });
  return { text: out, codes, coords };
}

function main(argv) {
  const write = argv.includes("--write");
  const paths = argv.filter((a) => a !== "--write");
  if (!paths.length) {
    console.error("uso: node tools/anonymize.mjs <archivo...> [--write]");
    return 3;
  }

  const seen = new Map();
  const perFile = [];
  for (const rel of paths) {
    let stat;
    try {
      stat = fs.statSync(rel);
    } catch {
      console.error(`  no existe: ${rel}`);
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    const before = fs.readFileSync(rel, "utf8");
    if (before.includes("\u0000")) continue;
    const result = anonymizeText(before, seen);
    if (result.codes || result.coords) {
      perFile.push({ rel, ...result });
      if (write) fs.writeFileSync(rel, result.text);
    }
  }

  const totalCodes = perFile.reduce((n, f) => n + f.codes, 0);
  const totalCoords = perFile.reduce((n, f) => n + f.coords, 0);
  console.log(`${write ? "REESCRITO" : "SIMULACIÓN"}: ${perFile.length} archivos, ${totalCodes} códigos, ${totalCoords} coordenadas, ${seen.size} códigos distintos`);
  for (const f of perFile.sort((a, b) => b.codes - a.codes).slice(0, 40)) {
    console.log(`  ${String(f.codes).padStart(3)} códigos ${String(f.coords).padStart(3)} coords  ${path.normalize(f.rel)}`);
  }
  if (!write) console.log("nada se escribió; agregá --write para aplicar");
  return 0;
}

// Sólo ejecuta cuando se lo invoca como script; el test importa las funciones puras.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(main(process.argv.slice(2)));
}
