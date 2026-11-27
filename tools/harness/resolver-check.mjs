#!/usr/bin/env node
// Verificador estático del resolvedor de GNAT (specs S7, S8, S12, S13, S15).
//
// Por qué estático: el resolvedor real necesita sesión de GNAT y llamadas de red.
// Lo que sí se puede fijar sin red es que el archivo **contenga** la regla y que el
// patrón de código se comporte distinto frente a un id interno y frente a un código.
// Uso: node resolver-check.mjs <ruta al build>
// Sale 0 si pasa, 1 si falla.

import fs from 'node:fs';
import path from 'node:path';

const buildDir = process.argv[2];
if (!buildDir) {
  console.error('uso: node resolver-check.mjs <ruta al build>');
  process.exit(3);
}

const file = path.join(buildDir, 'src', 'app.js');
const src = fs.readFileSync(file, 'utf8');
const fails = [];
const ok = [];

const check = (name, condition, detail) => {
  if (condition) ok.push(name);
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

// S12: un código de GNAT empieza con letra; un id interno numérico no es un código.
const codeRe = /const CODE_AT_START = (\/.*?\/[a-z]*);/.exec(src);
check('CODE_AT_START encontrado', Boolean(codeRe));
if (codeRe) {
  // eslint-disable-next-line no-eval
  const re = eval(codeRe[1]);
  check(
    'S12: id interno 3985557 no es código de poste',
    re.test('3985557 Desconectador') === false,
    'el patrón sigue aceptando tokens numéricos'
  );
  check(
    'S12: F130408 sí es código de poste',
    re.test('F130408 Poste') === true,
    'el patrón dejó de aceptar códigos válidos'
  );
}

// S7: el código de la S/E no puede caer en el campo de poste.
check(
  'S7: import no usa sseeCode como código de poste',
  !/codigo:\s*codigo\s*\|\|\s*sseeCode\s*\|\|/.test(src),
  'sigue el fallback codigo || sseeCode en la importación'
);

// S11: el aviso poste<->S/E no debe marcar el punto como inconsistencia.
check(
  'S11: el aviso poste-S/E ya no entra en notes (mismatch)',
  !/notes\.push\(`Poste \$\{code\} y S\/E/.test(src),
  'el aviso sigue empujando a notes, que marca mismatch'
);
check(
  'S11: existe una lista de avisos informativos',
  /const infoNotes = \[\];/.test(src)
);

// S8/S13: entre varios objetos con el mismo código, elegir el cercano.
check(
  'S8: el resolvedor compara todos los candidatos resueltos',
  /resolvedEntries\.push\(entry\)/.test(src),
  'sigue devolviendo el primer candidato con geometría'
);
check(
  'S13: ordena por distancia al punto editado',
  /resolvedEntries\.sort\(\(a, b\) => haversineMeters\(nearLL/.test(src),
  'no ordena por cercanía'
);
check(
  'S13: la S/E se resuelve con la coordenada del punto',
  /preferSsee: true, nearLonLat:/.test(src),
  'la S/E se resuelve sin referencia geográfica'
);

// S15: el código de poste y el de S/E son dos nombres igual de válidos del mismo
// punto. Se extrae el predicado puro y se le pasan candidatos con distancias
// conocidas: tiene que ganar el que coincide con la coordenada, sea poste o S/E.
const pickSrc = /function pickCoordCandidate\(candidates, enteredLL, meters\) \{([\s\S]*?)\n  \}/.exec(src);
check('S15: existe un predicado único que elige entre poste y S/E', Boolean(pickSrc));
if (pickSrc) {
  // eslint-disable-next-line no-new-func
  const pickCoordCandidate = new Function(
    `return function pickCoordCandidate(candidates, enteredLL, meters) {${pickSrc[1]}\n  }`
  )();
  const meters = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) * 111000;
  const pole = { label: 'poste', hit: { code: 'F130408', lonlat: [-70.5, -33.5] } };
  const ssee = { label: 'S/E', hit: { code: 'F12810', lonlat: [-70.51, -33.5] } }; // ~1.110 m del poste

  const atPole = pickCoordCandidate([pole, ssee], [-70.5, -33.5], meters);
  check(
    'S15: con la coordenada del poste gana el poste y se descarta la S/E',
    atPole?.label === 'poste',
    `eligió ${atPole?.label}`
  );
  const atSsee = pickCoordCandidate([pole, ssee], [-70.51, -33.5], meters);
  check(
    'S15: con la coordenada de la S/E gana la S/E (antes se descartaba siempre)',
    atSsee?.label === 'S/E',
    `eligió ${atSsee?.label}`
  );
  check('S15: sin coordenada no hay candidato que medir', pickCoordCandidate([pole, ssee], null, meters) === null);
}
check(
  'S15: ya no se afirma que el código de la S/E no corresponde a un poste',
  !/ese código no corresponde a un poste/.test(src)
);
check(
  'S15: cuando ninguno coincide, el aviso nombra las dos distancias',
  /no coincide con GNAT: \$\{measured\}/.test(src),
  'el aviso no permite descartar cuál de los dos nombres falla'
);

console.log(JSON.stringify({ build: buildDir, ok: fails.length === 0, pass: ok, fail: fails }, null, 2));
process.exit(fails.length ? 1 : 0);
