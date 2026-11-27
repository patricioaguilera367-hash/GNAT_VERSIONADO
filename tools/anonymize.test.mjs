// Tests de la anonimización. Cada caso existe por un defecto real observado al aplicarla
// sobre el repositorio, no por completitud.
//
//   node --test tools/anonymize.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { anonymizeText, syntheticCode } from "./anonymize.mjs";

test("un color hexadecimal no es un código de poste", () => {
  // Falso positivo que destruyó la paleta en una corrida: #F97316 matcheaba el patrón.
  const source = 'const OPENING = "#F97316"; const OTRO = "#DC2626";';
  assert.equal(anonymizeText(source).text, source);
});

test("un código de poste real sí se reemplaza y conserva la forma", () => {
  const { text, codes } = anonymizeText("const C = 'F562769';");
  assert.equal(codes, 1);
  assert.match(text, /'F\d{6}'/, "la forma es una F y seis dígitos");
  assert.ok(!text.includes("F562769"), "el original desaparece");
});

test("un código con prefijo de letras conserva el prefijo y la longitud", () => {
  const { text } = anonymizeText("FAG1674");
  assert.match(text, /^FAG\d{4}$/);
});

test("el mismo código da el mismo reemplazo en dos archivos distintos", () => {
  // La coherencia entre un test y su fixture depende de esto.
  const a = anonymizeText("F562769").text;
  const b = anonymizeText("ver F562769 otra vez").text;
  assert.ok(b.includes(a), `esperaba ${a} dentro de ${b}`);
});

test("una coordenada se desplaza y conserva los decimales", () => {
  // Semilla sintética. La longitud tiene que quedar por debajo de -60 porque el desplazamiento
  // se elige por magnitud, no por nombre: `-100` es longitud y `-20` es latitud. Los decimales
  // se conservan y el offset es +10 de longitud y +5 de latitud. Un punto de la red real no
  // tiene nada que hacer acá, ni siquiera como entrada.
  const { text, coords } = anonymizeText("lon: -100.123456789, lat: -20.987654321");
  assert.equal(coords, 2);
  assert.ok(text.includes("-90.123456789"), "longitud desplazada");
  assert.ok(text.includes("-15.987654321"), "latitud desplazada");
});

test("un sintético conserva la forma, así que la herramienta se corre una sola vez", () => {
  // Límite real: si el reemplazo mantiene la forma F + dígitos, es indistinguible de un
  // código original y una segunda corrida lo vuelve a anonimizar. El test fija ese límite:
  // se corre sobre el árbol limpio, no dos veces sobre el ya procesado.
  const once = anonymizeText("F562769").text;
  const twice = anonymizeText(once);
  assert.equal(twice.codes, 1, "vuelve a matchear: no es idempotente en códigos");
  assert.notEqual(twice.text, once);
});

test("las coordenadas no son idempotentes por diseño, y eso está documentado", () => {
  // Sin estado no se distingue una coordenada ya desplazada; el test fija el límite en vez
  // de prometer algo que la función no puede cumplir.
  const once = anonymizeText("-100.123456789").text;
  const twice = anonymizeText(once).text;
  assert.notEqual(twice, once);
});

test("un identificador numérico no se toca", () => {
  const source = "const id = 3985557; const rol = 130408;";
  assert.equal(anonymizeText(source).text, source);
});

test("syntheticCode es determinista y no depende del orden de llamadas", () => {
  assert.equal(syntheticCode("", "562769"), syntheticCode("", "562769"));
  assert.notEqual(syntheticCode("", "562769"), syntheticCode("", "562770"));
  assert.match(syntheticCode("", "562769"), /^F\d{6}$/);
});
