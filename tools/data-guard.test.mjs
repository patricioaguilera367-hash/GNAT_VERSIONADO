// Tests del guard de datos. Cada caso construye un build falso en un directorio temporal
// propio y lo borra al terminar.
//
//   node --test tools/data-guard.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findProductionData } from "./data-guard.mjs";

function withBuild(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "data-guard-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      if (rel.endsWith("/")) {
        fs.mkdirSync(full, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return findProductionData(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CLEAN_BUILD = {
  "manifest.json": '{"manifest_version":3,"version":"13.6.0"}',
  "background.js": "chrome.runtime.onMessage.addListener(() => {});",
  "src/app.js": "const DRAWER = 348;",
  "src/icon.png": "PNG"
};

test("un build con la forma esperada no tiene violaciones", () => {
  assert.deepEqual(withBuild(CLEAN_BUILD), []);
});

test("el nombre que el guard anterior no veía: v2 pt-263781.json", () => {
  // Regresión del defecto auditado: el patrón viejo exigía el nombre al inicio.
  assert.equal(/^pt-\d+\.json$/i.test("v2 pt-263781.json"), false, "el patrón viejo no lo veía");
  const found = withBuild({ ...CLEAN_BUILD, "v2 pt-263781.json": "{}" });
  assert.equal(found.length, 1);
  assert.match(found[0].why, /preset de producción/);
});

test("el nombre canónico tampoco pasa", () => {
  const found = withBuild({ ...CLEAN_BUILD, "pt-263781.json": "{}" });
  assert.equal(found.length, 1);
});

test("un preset renombrado se detecta por contenido", () => {
  const found = withBuild({
    ...CLEAN_BUILD,
    "src/datos.js": 'const P = { lon: -62.094406189, lat: -33.739195167 };'
  });
  assert.equal(found.length, 1);
  assert.match(found[0].why, /coordenada con 9 decimales/);
});

test("un JSON que no es el manifest se rechaza aunque su nombre sea inocente", () => {
  const found = withBuild({ ...CLEAN_BUILD, "src/datos.json": "{}" });
  assert.equal(found.length, 1);
  assert.match(found[0].why, /no es el manifest/);
});

test("un comprimido se rechaza", () => {
  const found = withBuild({ ...CLEAN_BUILD, "entrega.zip": "PK" });
  assert.equal(found.length, 1);
  assert.match(found[0].why, /comprimido/);
});

test("una carpeta Context se rechaza en cualquier nivel", () => {
  const found = withBuild({ ...CLEAN_BUILD, "src/Context/nota.txt": "x" });
  // Dos violaciones distintas y ambas ciertas: la carpeta de contexto y la extensión
  // del archivo que la habita. El guard no se queda con la primera que encuentra.
  assert.equal(found.length, 2);
  assert.ok(found.some((f) => /Context/.test(f.why)), "nombra la carpeta");
  assert.ok(found.some((f) => /extensión no permitida/.test(f.why)), "nombra la extensión");
});

test("una extensión fuera de la lista se rechaza", () => {
  const found = withBuild({ ...CLEAN_BUILD, "src/puntos.geojson": "[]" });
  assert.equal(found.length, 1);
  assert.match(found[0].why, /extensión no permitida/);
});

test("números cortos y tensiones no se confunden con coordenadas", () => {
  const found = withBuild({
    ...CLEAN_BUILD,
    "src/tension.js": "const KV = 13.2; const R = 0.15; const Z = 1.000001;"
  });
  assert.deepEqual(found, []);
});

test("las violaciones salen ordenadas y estables", () => {
  const found = withBuild({ ...CLEAN_BUILD, "b.zip": "PK", "a pt-1.json": "{}" });
  assert.deepEqual(found.map((f) => f.rel), ["a pt-1.json", "b.zip"]);
});
