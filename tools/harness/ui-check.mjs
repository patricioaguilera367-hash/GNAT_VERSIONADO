#!/usr/bin/env node
// Verifica la UI de la extensión sin el clic del humano.
//
// Por qué existe: la extensión se inyecta con `activeTab`, así que un clic real
// es el único camino por el background. Pero app.js no usa ninguna API de
// chrome (0 usos de `chrome.`): sólo DOM, OpenLayers y el mapa del iframe. Por
// eso se puede inyectar el mismo código por CDP y probar la UI de verdad, en
// headless, en vez de pedirle al humano que mire.
//
// Uso: node ui-check.mjs [ruta-al-build]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupStaleBrowsers, detectBrowser, evaluate, launch, newPage } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const buildDir = process.argv[2] ?? config.extensionDir;
const profileDir = config.profileDir ?? path.join(process.env.LOCALAPPDATA ?? '', 'gnat-harness', 'profile');

const OPEN_MAP = `
const findNode = (rx) => [...document.querySelectorAll('.x-tree-node-text')].find((el) => rx.test(el.textContent.trim()));
const apps = findNode(/^aplicaciones$/i);
if (apps) {
  let c = apps;
  for (let i = 0; i < 6 && c; i += 1) { if (c.querySelector && c.querySelector('.x-tree-expander')) break; c = c.parentElement; }
  const ex = c ? c.querySelector('.x-tree-expander') : null;
  (ex || apps).click();
  await new Promise((r) => setTimeout(r, 2000));
}
const mapa = findNode(/^mapas?$/i);
if (!mapa) return { error: 'no Mapas' };
mapa.click();
await new Promise((r) => setTimeout(r, 9000));
return { ready: Boolean(document.querySelector('iframe#content')) };
`;

const CHECK = `
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// La UI se monta en el documento del iframe del mapa, no en el de arriba.
const frame = document.querySelector('iframe#content');
const doc = frame ? frame.contentDocument : null;
const hostTop = document.getElementById('centrality-v10-host');
const hostFrame = doc ? doc.getElementById('centrality-v10-host') : null;
if (!hostTop && !hostFrame) return { ok: false, error: 'sin shadow host en ningun documento' };
const host = hostFrame || hostTop;
if (!host.shadowRoot) return { ok: false, error: 'host sin shadowRoot' };
const sh = host.shadowRoot;
if (!sh.querySelector('.topbar')) return { ok: false, error: 'sin topbar', hijos: sh.childNodes.length };

const chips = [...sh.querySelectorAll('button.chip')];
const labels = chips.map((c) => (c.textContent || '').trim());
const zona = chips.find((c) => /zonas/i.test(c.textContent || ''));
const sup = chips.find((c) => /supervisor/i.test(c.textContent || ''));
const est = chips.find((c) => /estados/i.test(c.textContent || ''));
const pops = () => sh.querySelectorAll('.popover').length;
const out = {
  ok: true,
  chips: labels.map((l) => l.replace(/[A-Za-zÁÉÍÓÚÑáéíóúñ]/g, 'a')),
  hayChipSupervisor: Boolean(sup),
  hayChipZonas: Boolean(zona),
  hayChipEstados: Boolean(est),
};

const toggle = async (chip) => {
  if (!chip) return null;
  const before = pops();
  chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
  await wait(60);
  chip.click();
  await wait(320);
  const after = pops();
  return { before, after };
};

if (zona) {
  out.zonasToggle1 = await toggle(zona);
  out.zonasToggle2 = await toggle(zona);
}
if (sup) {
  const t = await toggle(sup);
  out.supToggle = t;
  out.supFilas = sh.querySelectorAll('input[data-sup-id]').length;
  out.supTriState = Boolean(sh.querySelector('.popover input[type=checkbox]'));
  if (zona) { zona.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true })); await wait(40); zona.click(); await wait(200); }
}
if (est) {
  const t = await toggle(est);
  out.estToggle = t;
  out.estFilas = sh.querySelectorAll('input[data-status-id]').length;
}

// Fase 2: flujo de proyecto nuevo. Si el modal no aparece, ese es el bug.
const frameWin = frame ? frame.contentWindow : null;
const api = window.__centralityV10 || (frameWin && frameWin.__centralityV10) || null;
out.apiEn = window.__centralityV10 ? 'top' : (frameWin && frameWin.__centralityV10 ? 'frame' : 'ninguno');
try {
  if (api && typeof api.openRecent === 'function') {
    api.openRecent();
    await wait(600);
    const modales = [...sh.querySelectorAll('[class*=modal], [class*=Modal], [class*=dialog]')];
    const botones = [...sh.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean);
    out.modalProyecto = {
      modales: modales.length,
      visible: modales.some((m) => m.offsetParent !== null || m.getBoundingClientRect().height > 0),
      botonesClave: botones.filter((t) => /nuevo|crear|abrir|reciente|guardar/i.test(t)).map((t) => t.replace(/[A-Za-zÁÉÍÓÚÑáéíóúñ]/g, 'a')),
    };
  } else {
    out.modalProyecto = { error: 'sin api.openRecent' };
  }
} catch (error) {
  out.modalProyecto = { error: String(error.message ?? error).slice(0, 200) };
}
// Fase 3: el panel no debe tapar el desplegable del buscador nativo.
try {
  const nativeInput = (frameWin ? frameWin.document : document).querySelector('input[placeholder*="Buscar" i], input[placeholder*="Search" i]');
  const drawerEl = sh.querySelector('.drawer');
  if (nativeInput && drawerEl) {
    const topAntes = Math.round(drawerEl.getBoundingClientRect().top);
    nativeInput.focus();
    nativeInput.value = 'F37873';
    nativeInput.dispatchEvent(new Event('input', { bubbles: true }));
    nativeInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '6' }));
    await wait(4200);
    const lists = [...(frameWin ? frameWin.document : document).querySelectorAll('.x-boundlist')];
    const bottoms = lists.map((l) => Math.round(l.getBoundingClientRect().bottom)).filter((b) => b > 0);
    const topDespues = Math.round(drawerEl.getBoundingClientRect().top);
    out.buscadorNativo = {
      desplegables: lists.length,
      bottomMax: bottoms.length ? Math.max(...bottoms) : 0,
      drawerTopAntes: topAntes,
      drawerTopDespues: topDespues,
      noTapa: bottoms.length ? topDespues >= Math.max(...bottoms) : null,
    };
  } else {
    out.buscadorNativo = { error: 'sin input nativo o sin drawer', input: Boolean(nativeInput), drawer: Boolean(drawerEl) };
  }
} catch (error) {
  out.buscadorNativo = { error: String(error.message ?? error).slice(0, 200) };
}

// Fase 4: "Empezar en mapa vacío" tiene que crear un proyecto, no sólo cerrar.
try {
  if (api && typeof api.openRecent === 'function') {
    api.openRecent();
    await wait(500);
    const btn = [...sh.querySelectorAll('button')].find((b) => /mapa vac/i.test(b.textContent || ''));
    if (!btn) {
      out.proyectoVacio = { error: 'sin boton de mapa vacio' };
    } else {
      const nombreAntes = (sh.querySelector('input.proj-name, input[name=projName], .proj-name input') || {}).value || null;
      btn.click();
      await wait(900);
      const modal = sh.querySelector('.modal-backdrop');
      const nombreDespues = (sh.querySelector('input.proj-name, input[name=projName], .proj-name input') || {}).value || null;
      out.proyectoVacio = {
        modalOculto: modal ? modal.classList.contains('hidden') : 'sin modal',
        filas: sh.querySelectorAll('.table-wrap tbody tr').length,
        nombreAntes,
        nombreDespues,
        nombreCambio: nombreAntes !== nombreDespues,
      };
    }
  }
} catch (error) {
  out.proyectoVacio = { error: String(error.message ?? error).slice(0, 200) };
}

// Fase 5: el wizard debe reconocer la columna de supervisor, con o sin tildes.
try {
  const CAT = window.__C_CATALOGS;
  const TAB = String.fromCharCode(9);
  const NL = String.fromCharCode(10);
  const casos = [
    ['Supervisor', 'titulo normal'],
    ['SUPERVISOR', 'mayusculas'],
    ['Responsable', 'otro nombre'],
    ['Supervisión', 'con tilde'],
  ];
  out.rolesSupervisor = casos.map(([head, nombre]) => {
    const text = [head, 'Código', 'Estado', 'Latitud', 'Longitud'].join(TAB) + NL +
      ['Tomás Lemunao', 'F16969', 'Ejecutado', '-37,5294', '-72,8672'].join(TAB);
    const p = CAT.parseSmartTableText(text);
    return { caso: nombre, supervisorEn: p.colRoles.indexOf('supervisor'), roles: p.colRoles };
  });
  out.fold = 'sin foldText';
} catch (error) {
  out.rolesSupervisor = { error: String(error.message ?? error).slice(0, 200) };
}
try {
  const CAT2 = window.__C_CATALOGS;
  if (typeof CAT2.foldText === 'function') {
    out.fold = [CAT2.foldText('Tomás Lemunao'), CAT2.foldText('SUPERVISOR'), CAT2.foldText('Supervisión')];
  }
} catch (error) {
  out.fold = String(error.message ?? error).slice(0, 120);
}

// Fase 6: el indicador tiene que decir DONDE guarda, no solo que guardo.
try {
  const badge = sh.querySelector('.save-badge');
  out.saveBadge = badge
    ? { texto: (badge.textContent || '').trim(), titulo: (badge.title || '').slice(0, 120) }
    : { error: 'sin save-badge' };
} catch (error) {
  out.saveBadge = { error: String(error.message ?? error).slice(0, 160) };
}

// Fase 7: U1 — un clic fuera cierra la ventana (política única de capas).
try {
  if (api && typeof api.openRecent === 'function') {
    api.openRecent();
    await wait(600);
    const abierto = Boolean(sh.querySelector('.modal-backdrop:not(.hidden)'));
    const fuera = (doc && doc.body ? doc.body : document.body);
    const popAntes = sh.querySelectorAll('.popover').length;
    fuera.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    await wait(350);
    const trasUno = !sh.querySelector('.modal-backdrop:not(.hidden)');
    if (!trasUno) {
      fuera.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
      await wait(350);
    }
    const cerrado = !sh.querySelector('.modal-backdrop:not(.hidden)');
    out.cierreFueraModal = { abierto, popoversAntes: popAntes, cerroConUnClic: trasUno, cerrado, ok: abierto && cerrado };
  } else {
    out.cierreFueraModal = { error: 'sin api' };
  }
} catch (error) {
  out.cierreFueraModal = { error: String(error.message ?? error).slice(0, 160) };
}

// Fase 8: U6 — foco al abrir la ventana y de vuelta al cerrar.
try {
  if (api && typeof api.openRecent === 'function') {
    const ancla = sh.querySelector('.topbar .chip, .topbar button');
    if (ancla) { try { ancla.focus(); } catch (_) {} }
    const antes = sh.activeElement || null;
    api.openRecent();
    await wait(700);
    const card = sh.querySelector('.modal-card');
    const activo = sh.activeElement || null;
    const dentro = Boolean(card) && (activo === card || card.contains(activo));
    doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(400);
    const tras = sh.activeElement || null;
    const volvio = antes ? tras === antes : null;
    out.focoModal = {
      dentro,
      volvio,
      activo: activo ? activo.tagName : null,
      modalCerrado: !sh.querySelector('.modal-backdrop:not(.hidden)'),
      focoDespues: tras ? tras.tagName + '.' + String(tras.className || '').split(' ')[0] : null,
      ancla: antes ? antes.tagName + '.' + String(antes.className || '').split(' ')[0] : null,
      anclaSigueConectada: antes ? antes.isConnected : null,
    };
  } else {
    out.focoModal = { error: 'sin api' };
  }
} catch (error) {
  out.focoModal = { error: String(error.message ?? error).slice(0, 160) };
}

// Fase 9: filtro por supervisor (iniciales, nombre y sin tildes) y orden por columna.
try {
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);
  const btn = (rx) => [...sh.querySelectorAll('button')].find((b) => rx.test(b.textContent || ''));
  const filas = () => [...sh.querySelectorAll('.table-wrap tbody tr')].filter((tr) => tr.querySelector('td')).length;
  const buscador = () => sh.querySelector('input[placeholder*="Filtrar" i]');
  const buscar = async (txt) => {
    const inp = buscador();
    if (!inp) return -1;
    inp.value = txt;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(400);
    return filas();
  };

  const arch = btn(/^Archivo$/i) || sh.querySelector('.topbar .chip');
  if (arch) { arch.click(); await wait(400); }
  const paste = btn(/Pegar tabla|c[oó]digos desde Excel/i);
  if (!paste) throw new Error('sin opcion Pegar tabla');
  paste.click();
  await wait(700);
  const ta = sh.querySelector('.modal-card textarea');
  if (!ta) throw new Error('sin textarea del wizard');
  ta.value = [
    ['N°', 'Código', 'Supervisor', 'Estado'].join(TAB),
    ['1', 'F393607', 'Tomás Lemunao', 'Ejecutado'].join(TAB),
    ['2', 'F393608', 'Cesar Castro', 'Pendiente'].join(TAB),
    ['3', 'F393609', 'Rodrigo Díaz', 'Pendiente'].join(TAB),
  ].join(NL);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(600);
  const add = btn(/Agregar a tabla/i);
  if (!add) throw new Error('sin boton Agregar a tabla');
  add.click();
  await wait(1600);

  out.filtro = {
    cargadas: filas(),
    cc: await buscar('cc'),
    tl: await buscar('tl'),
    rd: await buscar('rd'),
    cesar: await buscar('cesar'),
    tomas: await buscar('tomas'),
    nombreCompleto: await buscar('cesar castro'),
  };

  await buscar('');
  const thCodigo = [...sh.querySelectorAll('.table-wrap thead th')].find((t) => /C[oó]digo/i.test(t.textContent || ''));
  const thSup = [...sh.querySelectorAll('.table-wrap thead th')].find((t) => /^Sup\.?$/i.test((t.textContent || '').trim()));
  const primero = () => { const tr = sh.querySelector('.table-wrap tbody tr'); return tr ? (tr.textContent || '').slice(0, 24) : null; };
  const orden = { antes: primero(), thSupExiste: Boolean(thSup) };
  if (thCodigo) { thCodigo.click(); await wait(400); orden.codigoAsc = primero(); thCodigo.click(); await wait(400); orden.codigoDesc = primero(); }
  if (thSup) { thSup.click(); await wait(400); orden.supAsc = primero(); }
  out.orden = orden;
} catch (error) {
  out.filtro = { error: String(error.message ?? error).slice(0, 200) };
}

return out;
`;

const browser = await launch({
  browserPath: config.browserPath ?? detectBrowser(),
  profileDir,
  headless: config.headless ?? true,
  ignoreCertificateErrors: config.ignoreCertificateErrors ?? false,
});

let exitCode = 0;
try {
  const page = await newPage(browser.connection, config.startUrl);
  for (let i = 0; i < 60; i += 1) {
    const ready = await evaluate(browser.connection, page.sessionId, "return Boolean(document.querySelector('#app-header'))");
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const opened = await evaluate(browser.connection, page.sessionId, OPEN_MAP);
  if (!opened?.ready) throw new Error(`el mapa no abrió: ${JSON.stringify(opened)}`);

  // La lista de archivos sale del propio build: si se renombra o se parte un
  // módulo, esto se entera solo y no queda una lista hardcodeada desactualizada.
  let files;
  try {
    const background = fs.readFileSync(path.join(buildDir, 'background.js'), 'utf8');
    const match = background.match(/files:\s*\[([^\]]*)\]/);
    files = match ? [...match[1].matchAll(/"([^"]+\.js)"/g)].map((m) => m[1]) : null;
  } catch (_) {
    files = null;
  }
  if (!files || !files.length) files = ['src/icons.js', 'src/tokens.js', 'src/catalogs.js', 'src/app.js'];
  const injected = [];
  for (const file of files) {
    const code = fs.readFileSync(path.join(buildDir, file), 'utf8');
    try {
      const value = await evaluate(browser.connection, page.sessionId, code);
      injected.push({ file, ok: true, value: value === undefined ? null : String(value).slice(0, 120) });
    } catch (error) {
      // Un throw acá es el bug: la UI no llega a montarse.
      injected.push({ file, ok: false, error: String(error.message ?? error).slice(0, 400) });
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 800));

  const result = await evaluate(browser.connection, page.sessionId, CHECK);
  console.log(JSON.stringify({ build: buildDir, injected, ...result }, null, 2));
  if (!result?.ok) exitCode = 1;
  if (result?.zonasToggle1?.after !== 1) exitCode = 1;
  if (result?.zonasToggle2?.after !== 0) exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ build: buildDir, ok: false, error: String(error.message ?? error) }, null, 2));
  exitCode = 1;
} finally {
  try { browser.close?.(); } catch {}
  cleanupStaleBrowsers(profileDir);
}

process.exit(exitCode);
