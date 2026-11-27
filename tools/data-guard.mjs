// Guarda de datos de producción para un build antes de publicarlo.
//
// Vive aparte del publicador por una razón concreta: un control que sólo se puede ejecutar
// produciendo el efecto que controla no se puede probar. `findProductionData` es una función
// pura sobre un directorio; el publicador sólo decide qué hacer con su resultado.
//
// Qué cambió respecto de la versión anterior, y por qué:
//   - El nombre se mira normalizado. `/^pt-\d+\.json$/i` no veía `v2 pt-263781.json`, que es
//     exactamente el tipo de nombre que este repositorio ya produce.
//   - Se mira el contenido. Un preset renombrado a `datos.json` pasaba cualquier lista negra
//     de nombres; las coordenadas de más de 5 decimales no tienen otro motivo para estar ahí.
//   - Se usan listas permitidas. Un build tiene una forma conocida; enumerar lo prohibido
//     deja entrar todo lo que nadie previó.
import fs from "node:fs";
import path from "node:path";

/** Extensiones que un build de la extensión puede contener legítimamente. */
export const ALLOWED_EXTENSIONS = new Set([".js", ".json", ".html", ".css", ".png", ".svg", ".woff2"]);

/** Único JSON que un build puede contener. */
export const ALLOWED_JSON = new Set(["manifest.json"]);

/** Contenedores que nunca van a un repo público. */
const ARCHIVE_EXTENSIONS = new Set([".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz"]);

/** Nombre de preset de producción en cualquier posición y con separadores variables. */
const PRESET_NAME = /pt[-_ ]?\d{4,}/i;

/** Coordenada geográfica: 2 o 3 dígitos enteros y 6 o más decimales. */
const COORDINATE = /-?\d{2,3}\.\d{6,}/;

/** Archivos mayores que esto no se escanean por contenido; igual se revisan por nombre. */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([".js", ".json", ".html", ".css"]);

/**
 * Recorre `dir` y devuelve las violaciones encontradas, ordenadas y estables.
 * No lanza por archivos ilegibles: los reporta como violación para no dejar pasar nada.
 * @param {string} dir
 * @returns {{ rel: string, why: string }[]}
 */
export function findProductionData(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      found.push({ rel: path.relative(dir, current), why: `no se pudo leer el directorio: ${err.code}` });
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        if (/^context$/i.test(entry.name)) {
          found.push({ rel, why: "carpeta Context con datos reales de red" });
        }
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();

      if (PRESET_NAME.test(entry.name)) {
        found.push({ rel, why: "nombre con patrón de preset de producción (pt-<n>)" });
        continue;
      }
      if (ARCHIVE_EXTENSIONS.has(ext)) {
        found.push({ rel, why: `contenedor comprimido (${ext})` });
        continue;
      }
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        found.push({ rel, why: `extensión no permitida (${ext || "sin extensión"})` });
        continue;
      }
      if (ext === ".json" && !ALLOWED_JSON.has(entry.name)) {
        found.push({ rel, why: "JSON que no es el manifest del build" });
        continue;
      }
      if (TEXT_EXTENSIONS.has(ext)) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch (err) {
          found.push({ rel, why: `no se pudo medir el archivo: ${err.code}` });
          continue;
        }
        if (stat.size > MAX_SCAN_BYTES) continue;
        let text;
        try {
          text = fs.readFileSync(full, "utf8");
        } catch (err) {
          found.push({ rel, why: `no se pudo leer el archivo: ${err.code}` });
          continue;
        }
        const hit = text.match(COORDINATE);
        if (hit) {
          found.push({ rel, why: `coordenada con ${(hit[0].split(".")[1] || "").length} decimales` });
        }
      }
    }
  };
  walk(dir);
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}
