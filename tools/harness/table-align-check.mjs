#!/usr/bin/env node
// Verifica que la tabla tenga el encabezado sobre su propia columna (spec S16/S1).
//
// Dos capas, porque son dos pruebas distintas:
//   1. Invariantes del código y del CSS: los mecanismos que producían el desalineado.
//   2. Geometría real: se arma la tabla con el CSS del propio build y con su lista de
//      columnas, se abre en el navegador y se comparan los rectángulos de cada th con
//      los de su td.
//
// Contra 13.1.8 y anteriores la lista de columnas no existe: se reconstruye desde los
// makeSortableTh(...) del propio archivo y se aplica el border-left de 3 px que el
// cuerpo llevaba y el encabezado no. Así el mismo verificador corre contra la versión
// vieja (tiene que fallar) y contra la nueva (tiene que pasar).
//
// Uso: node table-align-check.mjs <ruta al build>
// Sale 0 si pasa, 1 si falla.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, newPage, evaluate } from './cdp.mjs';

const buildDir = process.argv[2];
if (!buildDir) {
  console.error('uso: node table-align-check.mjs <ruta al build>');
  process.exit(3);
}

const appSrc = fs.readFileSync(path.join(buildDir, 'src', 'app.js'), 'utf8');
const stylesSrc = fs.readFileSync(path.join(buildDir, 'src', 'styles.js'), 'utf8');

const fails = [];
const ok = [];
const check = (name, condition, detail) => {
  if (condition) ok.push(name);
  else fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

// El CSS vive en un IIFE que asigna a window: se evalúa con un window vacío.
const fakeWindow = {};
new Function('window', stylesSrc)(fakeWindow);
const css = fakeWindow.__C_STYLES;
check('el build expone su hoja de estilos', typeof css === 'string' && css.length > 1000);

// 1. Invariantes del CSS: el encabezado tiene que recortar igual que el cuerpo.
const ruleOf = (selector) => {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i) + 1);
};
const thRule = ruleOf('thead th');
const tdRule = ruleOf('tbody td');
check('S1: la regla tbody td existe para comparar', tdRule.length > 0);
check(
  'S1: el encabezado no parte la etiqueta en dos líneas',
  /white-space:\s*nowrap/.test(thRule),
  'thead th no declara nowrap y la etiqueta se parte o se desborda'
);
check(
  'S1: el encabezado recorta con puntos suspensivos como el cuerpo',
  /text-overflow:\s*ellipsis/.test(thRule) && /overflow:\s*hidden/.test(thRule),
  'thead th no recorta como tbody td'
);
check(
  'S1: la flecha de orden tiene su propio ancho',
  /\.sort-arrow\s*\{/.test(css),
  'la flecha va pegada a la etiqueta y la corre al ordenar'
);

// 2. Invariantes del código: una sola definición de columnas.
const colsMatch = /const TABLE_COLUMNS = (\[[\s\S]*?\n  \]);/.exec(appSrc);
let columns = null;
let legacy = false;
if (colsMatch) {
  // eslint-disable-next-line no-new-func
  columns = new Function(`return ${colsMatch[1]}`)();
  check('S2: la lista de columnas es la única fuente de verdad', Array.isArray(columns) && columns.length >= 4);
  check(
    'S1: ninguna etiqueta de encabezado se escribe a mano',
    !/makeSortableTh\(/.test(appSrc),
    'siguen los makeSortableTh sueltos con su propio ancho'
  );
  check(
    'S1: el cuerpo arma sus celdas en el orden de la lista',
    /cellById\[col\.id\]/.test(appSrc),
    'el cuerpo sigue agregando las celdas por su cuenta'
  );
  check(
    'S1: ningún colspan cuenta columnas a mano',
    !/colSpan = multiSup \?/.test(appSrc),
    'queda el literal multiSup ? 5 : 4'
  );
} else {
  legacy = true;
  const parsed = [...appSrc.matchAll(/makeSortableTh\("(\w+)", "([^"]*)"(?:, "(\d+px)")?\)/g)]
    .map(m => ({ id: m[1], label: m[2], width: m[3] || '' }));
  columns = [{ id: 'check', label: '', width: '28px' }, ...parsed];
  ok.push(`(baseline histórico) lista reconstruida desde el archivo: ${columns.map(c => c.id).join(', ')}`);
}
check(
  'S1: el color del punto no desplaza el contenido del cuerpo',
  !/tr\.style\.borderLeft/.test(appSrc),
  'el border-left del <tr> corre 3 px el cuerpo respecto del encabezado'
);

// 2b. El chip inline del código y las columnas ocultas (S17).
check(
  'S17: varias zonas se acomodan en vez de comprimirse',
  /\.zone-pill-wrap\s*\{/.test(css),
  'falta el contenedor que envuelve los chips de zona'
);
check(
  'S17: el chip de zona no se achica',
  /\.zone-pill\s*\{[\s\S]{0,400}?flex:\s*0 0 auto/.test(css),
  '.zone-pill no declara flex: 0 0 auto'
);
check(
  'S17: los chips inline del poste conservan su ancho',
  /\.prot-badge,\s*\.remate-badge,\s*\.eq-badge\s*\{[\s\S]{0,160}?flex:\s*0 0 auto/.test(css),
  'sin flex: 0 0 auto la celda angosta recorta el chip'
);
check(
  'S1: lo que se trunca es el código, no el chip',
  /codeSpan\.style\.textOverflow = "ellipsis"/.test(appSrc),
  'el código no tiene ellipsis, así que cede el chip'
);
check(
  'S17: la celda de zona ya no corta la lista',
  !/zids\.slice\(0, 3\)/.test(appSrc),
  'sigue el tope de tres zonas'
);
if (colsMatch) {
  const hiddenDefaults = columns.filter(c => c.hiddenByDefault);
  check(
    'S17: hay columnas ocultas por defecto que se pueden agregar',
    hiddenDefaults.length >= 4,
    `sólo ${hiddenDefaults.length} columnas arrancan ocultas`
  );
  check(
    'S17: lo oculto por defecto se decide en un solo lugar',
    /const defaultHiddenColumns = \(\) =>/.test(appSrc)
  );
}

// 2c. El panel de columnas aplica, no se cierra, y el orden es dato del proyecto (S18).
check(
  'S18: la tabla respeta las columnas ocultas',
  /&&\s*!state\.hiddenColumns\.has\(c\.id\)/.test(appSrc),
  'falta el filtro de columnas ocultas: la tabla renderiza todas y la única elástica colapsa a 0'
);
check(
  'S18: el orden de columnas es dato del proyecto',
  /const orderedTableColumns = \(\) =>/.test(appSrc) && /state\.columnOrder/.test(appSrc)
);
const popoverSrc = (() => {
  const a = appSrc.indexOf('function openColumnsVisibilityPopover');
  const b = appSrc.indexOf('function openZonesVisibilityPopover');
  return a < 0 || b < 0 ? '' : appSrc.slice(a, b);
})();
check('S18: el panel de columnas existe y se puede leer', popoverSrc.length > 200);
check(
  'S18: elegir una columna no cierra el panel',
  popoverSrc.length > 0 && !/refreshAll\(\)/.test(popoverSrc),
  'el panel se reabre desde su propio manejador y termina cerrado'
);
check(
  'S18: las columnas se pueden reordenar',
  /\[state\.columnOrder\[i\], state\.columnOrder\[j\]\] = \[state\.columnOrder\[j\], state\.columnOrder\[i\]\]/.test(popoverSrc),
  'no hay forma de intercambiar dos columnas'
);

// 2d. Pintar el área y filtrar puntos son dos ejes distintos (S14).
const areaSrc = /function isZoneAreaPainted\(([^)]*)\) \{([\s\S]*?)\n  \}/.exec(appSrc);
check('S14: existe un predicado propio para el área pintada', Boolean(areaSrc));
check(
  'S14: el predicado del área no consulta el filtro de puntos',
  Boolean(areaSrc) && !/hiddenZones/.test(areaSrc[1] + areaSrc[2]),
  'el área sigue leyendo el mismo conjunto que el filtro de puntos'
);
if (areaSrc) {
  // eslint-disable-next-line no-new-func
  const isZoneAreaPainted = new Function(`return function isZoneAreaPainted(${areaSrc[1]}) {${areaSrc[2]}\n  }`)();
  const areas = new Set(['D']);
  check('S14: con la capa de polígonos apagada no se pinta nada', isZoneAreaPainted(false, areas, 'T') === false);
  check('S14: una zona con el área apagada no se pinta', isZoneAreaPainted(true, areas, 'D') === false);
  check('S14: una zona con el área encendida se pinta', isZoneAreaPainted(true, areas, 'T') === true);
}
check(
  'S14: el dibujo de polígonos consulta el conjunto del área',
  /isZoneAreaPainted\(state\.showHulls, state\.hiddenZoneAreas, z\.id\)/.test(appSrc)
);
const areaAt = appSrc.indexOf('mkToggle("Área"');
const pointsAt = appSrc.indexOf('mkToggle("Puntos"');
const areaToggleSrc = areaAt < 0 ? '' : appSrc.slice(areaAt, areaAt + 300);
const pointsToggleSrc = pointsAt < 0 ? '' : appSrc.slice(pointsAt, pointsAt + 300);
check('S14: cada zona tiene una casilla etiquetada para el área', areaAt > 0);
check('S14: cada zona tiene una casilla etiquetada para los puntos', pointsAt > 0);
check(
  'S14: la casilla del área no filtra puntos',
  areaToggleSrc.length > 50 && /hiddenZoneAreas/.test(areaToggleSrc) && !/hiddenZones/.test(areaToggleSrc),
  'la casilla del área sigue tocando el filtro de puntos'
);
check(
  'S14: la casilla de puntos no apaga el área',
  pointsToggleSrc.length > 50 && /hiddenZones/.test(pointsToggleSrc) && !/hiddenZoneAreas/.test(pointsToggleSrc),
  'la casilla de puntos sigue tocando el relleno'
);
check(
  'S14: el encabezado del panel de zonas manda sobre el área, no sobre los puntos',
  /querySelectorAll\("input\[data-zone-area\]"\)/.test(appSrc) && /hiddenZoneAreas\.add\(b\.dataset\.zoneArea\)/.test(appSrc),
  'el tri-state del encabezado todavía filtra puntos'
);

// 2e. El panel de capas está jerarquizado por tipo y en orden de apilado (S15).
// La cascada reemplazó a los grupos plegables: el mecanismo de escala ahora es el
// submenú, así que lo que se verifica es que las categorías sigan en orden de apilado
// y que lo poco usado viva adentro de una categoría y no en la lista principal.
const vistaAt = appSrc.indexOf('btnVista.onclick');
const vistaSrc = vistaAt < 0 ? '' : appSrc.slice(vistaAt, vistaAt + 6500);
const groupOrder = [
  'label: "Aspecto del punto"',
  'label: "Red"',
  'label: "Zonas"',
  'label: "Base"'
].map(n => vistaSrc.indexOf(n));
check(
  'S15: el panel de capas agrupa por tipo de cosa',
  vistaSrc.length > 500 && vistaSrc.includes('Pines de postes') && groupOrder.every(i => i > 0),
  `posiciones de grupo: ${groupOrder.join(', ')}`
);
check(
  'S15: los grupos siguen el orden de apilado (lo de arriba primero, la base al final)',
  groupOrder.every((p, i) => i === 0 || p > groupOrder[i - 1]),
  `posiciones de grupo: ${groupOrder.join(', ')}`
);
check(
  'S15: lo que se toca poco vive en un submenú, no en la lista principal',
  ((vistaSrc.match(/items: \[/g) || []).length + (vistaSrc.match(/OPTIONS\.map\(/g) || []).length) >= 5,
  'las categorías no tienen submenú y la lista principal volvió a crecer'
);
check(
  'S15: no quedó el título genérico «Capas del mapa» con todo mezclado',
  !/"Capas del mapa", pop/.test(appSrc),
  'la lista sigue plana bajo un solo título'
);

// 2f. La selección es siempre un subconjunto de lo visible (S20).
const rawSel = (appSrc.match(/\[\.\.\.state\.selected\]/g) || []).length;
check(
  'S20: ninguna acción lee la selección cruda',
  rawSel === 0,
  `${rawSel} usos de [...state.selected] fuera de los helpers`
);
check(
  'S20: el invariante se aplica en el único lugar que repinta la tabla',
  /function renderTable\(\) \{\s*\n\s*pruneSelection\(\);/.test(appSrc),
  'renderTable no poda la selección'
);
check(
  'S20: hay un solo punto de poda y un solo lector',
  /function pruneSelection\(\)/.test(appSrc) && /function selectedVisibleIndices\(\)/.test(appSrc),
  'faltan los helpers de selección'
);

// 2g. Menú en cascada y aspecto del punto (S21).
check(
  'S21: «Vista» usa el menú en cascada',
  /btnVista\.onclick = \(\) => \{\s*\n\s*openCascade\(btnVista/.test(appSrc),
  'sigue con la lista plana'
);
check(
  'S21: la marca distingue radio (uno solo) de casilla (varios)',
  /it\.kind === "radio"[\s\S]{0,140}it\.kind === "check"/.test(appSrc),
  'no hay distinción visual entre excluyente y acumulativo'
);
check(
  'S21: el modo de color se escribe y tiene los cuatro valores',
  /function setColorBy\(mode\)/.test(appSrc)
    && /const COLOR_BY_OPTIONS = \[/.test(appSrc)
    && ['"zone"', '"supervisor"', '"estado"', '"propio"'].every(v => appSrc.includes(`{ id: ${v},`)),
  'colorBy sigue sin control o le faltan modos'
);
const labelBlock = appSrc.slice(appSrc.indexOf('const labelStr'), appSrc.indexOf('const openRad'));
check(
  'S21: el rótulo del mapa ya no depende del rol',
  labelBlock.length > 40 && !/rolPT/.test(labelBlock),
  'la etiqueta sigue leyendo rolPT'
);
check(
  'S21: el texto del mapa tiene cuatro modos explícitos',
  ['"codigo"', '"ssee"', '"numeroCodigo"'].every(v => appSrc.includes(`state.labelContent === ${v}`)),
  'faltan modos de texto'
);

check(
  'S21: abrir otro panel desde la cascada deja el ancla en el botón destino',
  !/closePopover\(\); btnZonas\.click\(\);/.test(appSrc)
    && /popoverAnchor = btnZonas; btnZonas\.click\(\);/.test(appSrc),
  'el panel abierto queda anclado a un nodo desprendido y el próximo clic reabre en vez de cerrar'
);

// 2h. Autofiltro por columna tipo Excel (S22).
check(
  'S22: hay un solo predicado de filtros de columna',
  (appSrc.match(/function matchesColumnFilters/g) || []).length === 1,
  'no hay un único predicado de filtros de columna'
);
check(
  'S22: getFilteredPoints pasa por ese predicado',
  /if \(!matchesColumnFilters\(f\)\) return false;/.test(appSrc),
  'el filtro de columna no está en el camino de getFilteredPoints'
);
check(
  'S22: el estado del filtro por columna existe',
  /columnFilters: new Map\(\)/.test(appSrc),
  'no hay state.columnFilters'
);
const popAt = appSrc.indexOf('function openColumnFilterPopover');
const popSrc = popAt < 0 ? '' : appSrc.slice(popAt, popAt + 5200);
check(
  'S22: el popover trae buscador, «Seleccionar todo», «Añadir al filtro actual» y Aplicar',
  ['Buscar valor', 'Seleccionar todo', 'Añadir al filtro actual', '"Aplicar"'].every(t => popSrc.includes(t)),
  'faltan piezas del popover de Excel'
);
check(
  'S22: los chips se resumen desde el mismo estado',
  /for \(const \[colId, filter\] of state\.columnFilters\)/.test(appSrc),
  'los chips no leen state.columnFilters'
);
check(
  'S22: el filtro se abre desde la flecha del encabezado y con clic derecho',
  /openColumnFilterPopover\(bFilter, col\)/.test(appSrc) && /th\.oncontextmenu = \(ev\) => \{ ev\.preventDefault\(\); openColumnFilterPopover\(th, col\)/.test(appSrc),
  'falta la flecha o el clic derecho del encabezado'
);

// 2i. Atajos de la familia de aspecto (S23).
check(
  'S23: hay una sola guardia de campo de texto',
  (appSrc.match(/const isTypingTarget = /g) || []).length === 1
    && /const inInput = isTypingTarget\(doc\.activeElement\) \|\| isTypingTarget\(ev\.target\)/.test(appSrc),
  'la guardia de teclado no está unificada'
);
check(
  'S23: Alt+dígito conmuta las dos familias',
  /COLOR_BY_OPTIONS\[n - 1\]\.id/.test(appSrc) && /LABEL_CONTENT_OPTIONS\[n - 1\]\.id/.test(appSrc),
  'no hay atajos Alt+dígito'
);
check(
  'S23: el cambio de aspecto se anuncia con un toast',
  /showToast\(`Color por: \$\{/.test(appSrc) && /showToast\(`Texto en el mapa: \$\{/.test(appSrc),
  'cambiar con Alt no dice qué se activó'
);
check(
  'S23: los atajos respetan el foco en un campo de texto',
  /if \(\(ev\.altKey && !ev\.ctrlKey && !ev\.metaKey\) && !inInput\)/.test(appSrc),
  'los atajos se disparan aunque el foco esté en un input'
);
check(
  'S23: el menú muestra el atajo de cada valor',
  (appSrc.match(/hint: "Alt/g) || []).length >= 8,
  'el menú no documenta los atajos'
);

// 2j. Seleccionar no mueve el mapa (S24).
check(
  'S24: el clic de fila ya no arrastra la vista',
  !/tr\.onclick = \(\) => navigateTo\(idx\)/.test(appSrc),
  'el clic sigue llamando a navigateTo'
);
check(
  'S24: clic reemplaza y Ctrl/Shift componen la selección',
  /ev\.shiftKey && extendTo\(idx\)/.test(appSrc) && /ev\.ctrlKey \|\| ev\.metaKey/.test(appSrc),
  'falta la semántica de hoja de cálculo en el clic de fila'
);
check(
  'S24: hay ancla de rango para Shift',
  /lastTouchedIdx: -1/.test(appSrc),
  'no existe state.lastTouchedIdx'
);
check(
  'S24: centrar sigue existiendo como acción deliberada',
  (appSrc.match(/navigateTo\(/g) || []).length >= 4,
  'se perdió el centrado explícito junto con el clic'
);

check(
  'S22: el filtro activo se marca en el encabezado, no sólo en el chip',
  /th\.classList\.add\("col-filtered"\)/.test(appSrc) && /\? "▼" : "▾"/.test(appSrc),
  'el encabezado no muestra que está filtrado'
);
check(
  'S1: el encabezado de la columna numérica dice N° y no Rol/N°',
  !/label: "Rol\/N°"/.test(appSrc),
  'el rótulo sigue diciendo Rol/N°'
);

// 2k. Vista compacta y tabla redimensionable (S25).
check(
  'S25: existe el modo compacto',
  /compactTable: false/.test(appSrc),
  'no hay state.compactTable'
);
check(
  'S25: en compacto sólo quedan las columnas que identifican el punto',
  /if \(state\.compactTable\) \{[\s\S]{0,240}c\.id === "codigo"/.test(appSrc),
  'la vista compacta no filtra columnas'
);
check(
  'S25: el tirador ensancha el panel creciendo hacia la izquierda',
  /"table-grip"/.test(appSrc) && /startW \+ \(startX - e2\.clientX\)/.test(appSrc),
  'el tirador no ensancha el panel hacia la izquierda'
);
check(
  'S25: el doble clic del tirador conmuta la vista compacta',
  /tableGrip\.ondblclick/.test(appSrc),
  'el tirador no tiene doble clic'
);
check(
  'S25: la nube del renglón conserva lo que salió de las columnas',
  /if \(state\.compactTable\) tr\.title = compactSummary\(f\)/.test(appSrc)
    && /const compactSummary = /.test(appSrc),
  'la vista compacta pierde información'
);

check(
  'S25: en compacto el ancho sobrante se llena con el resumen',
  /table\.style\.width = state\.compactTable \? "100%" : ""/.test(appSrc)
    && /sum\.className = "compact-summary"/.test(appSrc),
  'el modo compacto deja un hueco vacío al ensanchar el panel'
);
check(
  'S25: el resumen del renglón y el de la celda son el mismo texto',
  (appSrc.match(/compactSummary\(f\)/g) || []).length >= 2 && /const compactSummary = /.test(appSrc),
  'el resumen está duplicado en dos lugares'
);
check(
  'S25: el ancho del panel se recuerda y se clampa al viewport',
  /state\.drawerWidth = drawer\.getBoundingClientRect\(\)\.width/.test(appSrc)
    && /Math\.min\(state\.drawerWidth, Math\.max\(260, w\.innerWidth - 40\)\)/.test(appSrc),
  'el ancho no se recuerda o no se adapta al achicar la ventana'
);

// 3. Geometría real.
// La tabla arranca con las columnas ocultas por defecto escondidas: se mide lo que el
// usuario ve. La segunda pasada revela todas para probar que se reacomoda sola (S17).
// S19: piso de ancho de la tabla, para que sumar columnas desplace en vez de aplastar.
const minWidthSrc = /const CODE_COLUMN_MIN = (\d+);[\s\S]{0,220}?const tableMinWidth = (\(cols\) =>[\s\S]*?);/.exec(appSrc);
let tableMinWidth = null;
if (minWidthSrc) {
  // eslint-disable-next-line no-new-func
  tableMinWidth = new Function(`const CODE_COLUMN_MIN = ${minWidthSrc[1]}; return ${minWidthSrc[2]};`)();
}
check(
  'S19: la tabla declara un piso de ancho',
  typeof tableMinWidth === 'function',
  'sin piso, cada columna nueva comprime la columna elástica hasta "F…"'
);

const visibleColumns = legacy ? columns : columns.filter(c => !c.hiddenByDefault);
const fixture = JSON.stringify({
  css,
  columns: visibleColumns,
  allColumns: columns,
  width: 520,
  minWidth: tableMinWidth ? tableMinWidth(visibleColumns) : null,
  legacy
});
const html = `<!doctype html><meta charset="utf-8"><title>tabla</title>
<body style="margin:0">
<script>window.__FIXTURE = ${fixture};</script>
</body>`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabla-align-'));
const pagePath = path.join(tmpDir, 'fixture.html');
fs.writeFileSync(pagePath, html, 'utf8');

const snippet = `
  const { css, columns, legacy, width, minWidth } = window.__FIXTURE;
  const root = document.createElement('div');
  root.style.position = 'fixed';
  root.style.left = '0';
  root.style.top = '0';
  root.style.width = width + 'px';
  root.style.height = '400px';
  document.body.appendChild(root);
  const sr = root.attachShadow({ mode: 'open' });
  const st = document.createElement('style');
  st.textContent = css;
  sr.appendChild(st);
  const box = document.createElement('div');
  box.className = 'table-wrap';
  box.style.height = '300px';
  sr.appendChild(box);
  const table = document.createElement('table');
  if (minWidth) table.style.minWidth = minWidth + 'px';
  const cg = document.createElement('colgroup');
  for (const c of columns) {
    const e = document.createElement('col');
    if (c.width) e.style.width = c.width;
    cg.appendChild(e);
  }
  table.appendChild(cg);
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    if (c.id === 'check') {
      const i = document.createElement('input');
      i.type = 'checkbox';
      th.appendChild(i);
    } else if (legacy) {
      // Antes la flecha iba pegada al texto de la etiqueta.
      th.textContent = c.label + ' \\u25B4';
    } else {
      th.appendChild(document.createTextNode(c.label));
      const a = document.createElement('span');
      a.className = 'sort-arrow';
      a.textContent = '\\u25B4';
      th.appendChild(a);
    }
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const tr = document.createElement('tr');
  if (legacy) tr.style.borderLeft = '3px solid #DC2626';
  for (const c of columns) {
    const td = document.createElement('td');
    if (c.id === 'check') {
      const i = document.createElement('input');
      i.type = 'checkbox';
      td.appendChild(i);
    } else if (c.id === 'numero') {
      td.className = 'num-cell';
      td.textContent = '63';
    } else if (c.id === 'codigo') {
      const s = document.createElement('span');
      s.className = 'code-mono';
      s.textContent = 'F163075';
      td.appendChild(s);
    } else if (c.id === 'zona') {
      const p = document.createElement('span');
      p.className = 'zone-pill';
      p.textContent = 'D';
      td.appendChild(p);
    } else if (c.id === 'sup') {
      const b = document.createElement('span');
      b.className = 'sup-badge';
      b.textContent = 'TL';
      td.appendChild(b);
    }
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
  table.appendChild(tbody);
  box.appendChild(table);
  const ths = [...sr.querySelectorAll('thead th')];
  const tds = [...sr.querySelectorAll('tbody td')];
  if (ths.length !== columns.length || tds.length !== columns.length) {
    return { error: 'la fila no tiene una celda por columna', ths: ths.length, tds: tds.length, columns: columns.length };
  }
  return {
    overflowX: box.scrollWidth > box.clientWidth + 1,
    tableWidth: Math.round(table.getBoundingClientRect().width),
    cells: ths.map((th, i) => {
      const r = th.getBoundingClientRect();
      const d = tds[i].getBoundingClientRect();
      return {
        label: th.textContent.trim(),
        thLeft: Math.round(r.left * 10) / 10,
        thWidth: Math.round(r.width * 10) / 10,
        tdLeft: Math.round(d.left * 10) / 10,
        tdWidth: Math.round(d.width * 10) / 10,
        // Para la columna de casillas lo que importa es que la casilla entre entera;
        // el recorte de texto sólo se mide sobre etiquetas.
        clipped: (() => {
          const input = th.querySelector('input');
          if (input) return input.getBoundingClientRect().right > r.right - 1;
          return th.scrollWidth > th.clientWidth + 1;
        })(),
        // Líneas reales del contenido: se cuentan las alturas distintas de los
        // rectángulos del texto, no la altura de la celda (que incluye padding).
        lines: (() => {
          const range = document.createRange();
          range.selectNodeContents(th);
          const rects = [...range.getClientRects()].filter(r => r.width > 0);
          return new Set(rects.map(r => Math.round(r.top))).size;
        })()
      };
    })
  };
`;

const narrowSnippet = `
  const { css } = window.__FIXTURE;
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:400px';
  document.body.appendChild(root);
  const sr = root.attachShadow({ mode: 'open' });
  const st = document.createElement('style');
  st.textContent = css;
  sr.appendChild(st);
  const box = document.createElement('div');
  box.className = 'table-wrap';
  sr.appendChild(box);
  const table = document.createElement('table');
  const cg = document.createElement('colgroup');
  for (const w of ['30px', '64px', '', '96px', '48px']) {
    const c = document.createElement('col');
    if (w) c.style.width = w;
    cg.appendChild(c);
  }
  table.appendChild(cg);
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const l of ['', 'Rol/N°', 'Código', 'Zona', 'Sup.']) {
    const th = document.createElement('th');
    th.textContent = l;
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const blank = () => document.createElement('td');
  const codeCell = (html) => {
    const td = document.createElement('td');
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;align-items:center;gap:4px;min-width:0';
    d.innerHTML = html;
    td.appendChild(d);
    return td;
  };
  const tr1 = document.createElement('tr');
  tr1.appendChild(blank());
  const n1 = blank(); n1.className = 'num-cell'; n1.textContent = '1'; tr1.appendChild(n1);
  const tdCode = codeCell('<span class="code-mono" style="font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">F195678</span><span class="prot-badge">DF XS</span>');
  tr1.appendChild(tdCode);
  const z1 = blank(); z1.textContent = '—'; tr1.appendChild(z1);
  const s1 = blank(); s1.textContent = 'TL'; tr1.appendChild(s1);
  tbody.appendChild(tr1);
  const tr2 = document.createElement('tr');
  tr2.appendChild(blank());
  const n2 = blank(); n2.className = 'num-cell'; n2.textContent = '2'; tr2.appendChild(n2);
  tr2.appendChild(codeCell('<span class="code-mono" style="font-weight:600">F195679</span>'));
  const tdZ = blank();
  const wrap = document.createElement('div');
  wrap.className = 'zone-pill-wrap';
  for (const [id, col] of [['D', '#DC2626'], ['T', '#00C853'], ['F', '#FF6D00']]) {
    const p = document.createElement('span');
    p.className = 'zone-pill';
    p.style.background = col;
    p.style.color = '#0F172A';
    p.style.border = '1px solid ' + col;
    p.textContent = id;
    wrap.appendChild(p);
  }
  tdZ.appendChild(wrap);
  tr2.appendChild(tdZ);
  const s2 = blank(); s2.textContent = 'TL'; tr2.appendChild(s2);
  tbody.appendChild(tr2);
  table.appendChild(tbody);
  box.appendChild(table);
  const badge = tdCode.querySelector('.prot-badge');
  const code = tdCode.querySelector('.code-mono');
  const pills = [...tdZ.querySelectorAll('.zone-pill')];
  const tdR = tdCode.getBoundingClientRect();
  const bR = badge.getBoundingClientRect();
  return {
    tableWidth: Math.round(table.getBoundingClientRect().width),
    codeCellWidth: Math.round(tdR.width),
    badgeWidth: Math.round(bR.width * 10) / 10,
    badgeFlexShrink: getComputedStyle(badge).flexShrink,
    badgeOverflows: bR.right > tdR.right - 1,
    codeTruncated: code.scrollWidth > code.clientWidth + 1,
    pillCount: pills.length,
    pillWidths: pills.map(p => Math.round(p.getBoundingClientRect().width * 10) / 10)
  };
`;

const configPath = path.join(import.meta.dirname, 'config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};

let browser = null;
try {
  browser = await launch({
    browserPath: config.browserPath,
    profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tabla-profile-')),
    headless: true,
  });
  const { sessionId } = await newPage(browser.connection, `file:///${pagePath.replace(/\\/g, '/')}`);
  const measurePass = async (label) => {
    const measured = await evaluate(browser.connection, sessionId, snippet);
    if (measured?.error) {
      fails.push(`geometría (${label}): ${measured.error} (th=${measured.ths} td=${measured.tds} columnas=${measured.columns})`);
      return;
    }
    const misaligned = measured.cells.filter(
      c => Math.abs(c.thLeft - c.tdLeft) > 0.5 || Math.abs(c.thWidth - c.tdWidth) > 0.5
    );
    check(
      `S1: cada celda cae exactamente bajo su encabezado (${label})`,
      misaligned.length === 0,
      misaligned.map(c => `${c.label || "(casilla)"} th@${c.thLeft}/${c.thWidth} vs td@${c.tdLeft}/${c.tdWidth}`).join('; ')
    );
    const clipped = measured.cells.filter(c => c.clipped || c.lines > 1);
    check(
      `S1: ninguna etiqueta de encabezado se recorta ni se parte (${label})`,
      clipped.length === 0,
      clipped.map(c => `${c.label}${c.lines > 1 ? ` (${c.lines} líneas)` : ' (recortada)'}`).join('; ')
    );
    ok.push(`geometría (${label}) en ${measured.cells.length} columnas: ${measured.cells.map(c => `${c.label || '☐'}=${c.thWidth}`).join(' ')} — desplaza=${measured.overflowX}`);
    return measured;
  };
  await measurePass('columnas por defecto');
  // El caso reportado: el drawer angosto con todas las columnas reveladas.
  await evaluate(browser.connection, sessionId, `window.__FIXTURE.columns = window.__FIXTURE.allColumns; window.__FIXTURE.width = 360; window.__FIXTURE.minWidth = ${tableMinWidth ? tableMinWidth(columns) : 'null'};`);
  const allMeasured = await measurePass('todas las columnas');
  const codeCell = (allMeasured?.cells || []).find(c => /digo/i.test(c.label));
  check(
    'S19: al revelar columnas el código conserva su piso legible',
    (codeCell?.thWidth || 0) >= 140,
    `Código quedó en ${codeCell?.thWidth ?? '?'}px`
  );
  check(
    'S19: la tabla se desplaza en vez de comprimir',
    allMeasured?.overflowX === true,
    'no hay desplazamiento horizontal: la tabla se comprimió'
  );
  // S18: el orden guardado manda sobre la tabla, no la lista del código.
  await evaluate(browser.connection, sessionId, 'window.__FIXTURE.columns = [...window.__FIXTURE.allColumns].reverse(); window.__FIXTURE.width = 900;');
  const reordered = await evaluate(browser.connection, sessionId, snippet);
  const labels = (reordered?.cells || []).map(c => c.label.trim());
  check(
    'S18: la tabla sigue el orden guardado de las columnas',
    labels.length > 1 && labels[0].startsWith('COCI_3F') && labels[labels.length - 1] === '',
    `orden obtenido: ${labels.join(' | ') || '(vacío)'}`
  );
    const narrow = await evaluate(browser.connection, sessionId, narrowSnippet);
    if (narrow) {
      check(
        'S17: el chip inline conserva su ancho en una celda angosta',
        narrow.badgeFlexShrink === '0',
        `flex-shrink del chip = ${narrow.badgeFlexShrink} (tiene que ser 0)`
      );
      check(
        'S17: el chip inline entra entero en la celda',
        !narrow.badgeOverflows && narrow.badgeWidth >= 20,
        `chip de ${narrow.badgeWidth}px en celda de ${narrow.codeCellWidth}px, desborda=${narrow.badgeOverflows}`
      );
      check(
        'S17: con la celda angosta se trunca el código',
        narrow.codeTruncated,
        'el código entero sigue entrando: la prueba no mide lo que cree'
      );
      ok.push(
        `celda angosta: tabla ${narrow.tableWidth}px, código ${narrow.codeCellWidth}px, chip ${narrow.badgeWidth}px, ${narrow.pillCount} zonas de ${narrow.pillWidths.join('/')}px`
      );
    }
} catch (err) {
  fails.push(`geometría: no se pudo medir en el navegador — ${err?.message || err}`);
} finally {
  try { await browser?.close?.(); } catch { /* cierre best-effort */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ build: buildDir, ok: fails.length === 0, pass: ok, fail: fails }, null, 2));
process.exit(fails.length ? 1 : 0);
