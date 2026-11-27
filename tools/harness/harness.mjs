#!/usr/bin/env node
// GNAT harness: proves the extension against a real browser instead of asking a human
// to describe what they saw. Zero dependencies. See README.md for the workflow.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CdpError,
  detectBrowser,
  evaluate,
  evaluateInServiceWorker,
  extensionServiceWorker,
  evaluateInFrame,
  launch,
  navigate,
  newPage,
  persistSessionCookies,
  cleanupStaleBrowsers,
} from './cdp.mjs';

import { absorb, newState, next, summarize } from './enumerate-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// La raíz del repo, para resolver rutas de config que son relativas al proyecto.
const REPO_ROOT = path.resolve(HERE, "..", "..");
const LOCAL_ROOT = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'gnat-harness');
const DEFAULT_PROFILE = path.join(LOCAL_ROOT, 'profile');
const ARTIFACTS_DIR = path.join(LOCAL_ROOT, 'artifacts');
const CONFIG_PATH = path.join(HERE, 'config.json');

const EXIT = { ok: 0, failed: 1, sessionExpired: 2, config: 3 };
const sessionExpired = (detail) => `SESSION_EXPIRED: ${detail}`;

/** A missing or unusable configuration value: never a test failure. */
class ConfigError extends Error {}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    throw new ConfigError(`config.json is not valid JSON: ${error.message}`);
  }
}

function launchOptions(config) {
  return {
    browserPath: config.browserPath ?? detectBrowser(),
    profileDir: config.profileDir ?? DEFAULT_PROFILE,
    // El navegador resuelve `--load-extension` contra SU propio directorio, no contra el
    // cwd: una ruta relativa termina buscando la extensión dentro de Program Files.
    // Se absolutiza acá, contra la raíz del repo, para que config.json pueda seguir
    // usando rutas relativas al proyecto.
    extensionDir: config.extensionDir ? path.resolve(REPO_ROOT, config.extensionDir) : undefined,
    headless: config.headless ?? true,
    ignoreCertificateErrors: config.ignoreCertificateErrors ?? false,
  };
}

function requireConfigValue(config, key) {
  const value = key.split('.').reduce((node, part) => node?.[part], config);
  if (!value) {
    throw new ConfigError(`missing config value "${key}"; copy config.example.json to config.json and fill it`);
  }
  return value;
}

function writeArtifact(name, payload) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(ARTIFACTS_DIR, `${stamp}-${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

/** Classify the page: is the session alive, or is this a login wall? */
async function authState(connection, sessionId, selectors) {
  const check = async (selector) => {
    if (!selector) return undefined;
    return evaluate(connection, sessionId, `return document.querySelector(${JSON.stringify(selector)}) !== null`);
  };
  const loggedIn = await check(selectors?.loggedIn);
  const login = await check(selectors?.login);
  if (loggedIn === true) return { state: 'logged-in', loggedIn, login };
  if (login === true) return { state: 'login', loggedIn, login };
  return { state: 'unknown', loggedIn, login };
}

async function withBrowser(config, fn, { headless } = {}) {
  const options = launchOptions(config);
  if (!options.browserPath) throw new ConfigError('no browser found; set browserPath in config.json');
  if (headless !== undefined) options.headless = headless;
  const browser = await launch(options);
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/** Wait until the app's loading mask is gone: shell pages render after `load`. */async function settle(connection, sessionId, selectors, timeoutMs = 20_000) {
  if (!selectors?.loading) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await evaluate(
      connection,
      sessionId,
      `return document.querySelector(${JSON.stringify(selectors.loading)}) !== null`,
    );
    if (!present) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Re-stamp session cookies so the login survives closing the browser. */
async function reportSessionPersistence(connection, config) {
  const days = config.sessionRetentionDays ?? 7;
  const result = await persistSessionCookies(connection, days);
  if (result.persisted === 0) {
    console.log('Las cookies ya eran persistentes: no hubo nada que re-sellar.');
  } else {
    console.log(
      `Re-selladas ${result.persisted} cookie(s) de sesión con vencimiento a ${days} día(s) para que sobrevivan al cierre.`,
    );
  }
}

/**
 * Registra el tráfico de red que la propia página genera. Sirve para responder una
 * pregunta concreta: ¿el mapa trae la red en bloque o pide poste por poste?
 * No se guardan valores: sólo formas (nombres de campo y cantidades).
 */
async function startNetworkCapture(connection, sessionId) {
  await connection.send('Network.enable', { maxPostDataSize: 4096 }, sessionId);
  const responses = [];
  const off = connection.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method !== 'Network.responseReceived') return;
    const { requestId, response, type } = message.params;
    responses.push({
      requestId,
      url: response.url,
      status: response.status,
      mimeType: response.mimeType,
      type,
      bytes: response.encodedDataLength ?? 0,
    });
  });
  return { responses, stop: off };
}

/** Forma de un JSON: claves y largos de arreglo, nunca valores. */
function shapeOf(value, depth = 0) {
  if (Array.isArray(value)) {
    const head = value[0];
    return {
      arrayLength: value.length,
      itemKeys: head && typeof head === 'object' && !Array.isArray(head) ? Object.keys(head).slice(0, 14) : null,
      itemShape: depth < 1 && head && typeof head === 'object' ? shapeOf(head, depth + 1) : null,
    };
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    const arrays = keys
      .filter((key) => Array.isArray(value[key]))
      .map((key) => ({ key, ...shapeOf(value[key], depth + 1) }));
    return { keys: keys.slice(0, 16), arrays: arrays.slice(0, 8) };
  }
  return { scalar: typeof value };
}

async function summarizeCapture(connection, sessionId, capture, options) {
  const byPath = new Map();
  for (const response of capture.responses) {
    let path = response.url;
    try {
      const parsed = new URL(response.url);
      path = `${parsed.pathname}`;
    } catch {
      // urls no parseables (data:, blob:) se dejan tal cual
    }
    const entry = byPath.get(path) ?? { path, count: 0, bytes: 0, statuses: new Set(), types: new Set() };
    entry.count += 1;
    entry.bytes += response.bytes;
    entry.statuses.add(response.status);
    entry.types.add(response.type);
    byPath.set(path, entry);
  }

  const paths = [...byPath.values()]
    .map((entry) => ({
      path: entry.path,
      count: entry.count,
      bytes: entry.bytes,
      statuses: [...entry.statuses],
      types: [...entry.types],
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const interest = new RegExp(options.filter ?? '\\.(json|php)|/api/', 'i');
  const candidates = capture.responses
    .filter((response) => interest.test(response.url))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, options.inspectBodies ?? 6);

  const inspected = [];
  for (const candidate of candidates) {
    try {
      const { body, base64Encoded } = await connection.send(
        'Network.getResponseBody',
        { requestId: candidate.requestId },
        sessionId,
      );
      if (base64Encoded) {
        inspected.push({ url: candidate.url, bytes: candidate.bytes, note: 'cuerpo binario' });
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        inspected.push({ url: candidate.url, bytes: candidate.bytes, note: 'no es JSON', head: body.slice(0, 80).replace(/[A-Za-z0-9]/g, '.') });
        continue;
      }
      inspected.push({ url: candidate.url, bytes: candidate.bytes, charsetLength: body.length, shape: shapeOf(parsed) });
    } catch (error) {
      inspected.push({ url: candidate.url, bytes: candidate.bytes, note: `sin cuerpo: ${error.message}` });
    }
  }

  return {
    totalResponses: capture.responses.length,
    totalBytes: capture.responses.reduce((sum, response) => sum + response.bytes, 0),
    paths: paths.slice(0, 20),
    urlSamples: [...new Set(capture.responses.filter((response) => interest.test(response.url)).map((response) => response.url))]
      .slice(0, 10)
      .map((url) => url.slice(0, 220)),
    inspected,
  };
}

async function waitForTruthy(connection, sessionId, snippet, timeoutMs = 15_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(connection, sessionId, snippet);
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

function pressEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function cmdLogin(config) {
  const startUrl = requireConfigValue(config, 'startUrl');
  const profileDir = config.profileDir ?? DEFAULT_PROFILE;
  console.log(`Perfil:  ${profileDir}`);
  console.log(`Sitio:   ${startUrl}`);
  if (!process.stdin.isTTY) {
    throw new ConfigError('--login needs an interactive terminal: run it from a real console');
  }
  console.log('Se abre el navegador. Iniciá sesión a mano y después volvé acá y apretá Enter.');

  const browser = await launch({ ...launchOptions(config), headless: false });
  try {
    const page = await newPage(browser.connection, startUrl);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await pressEnter(`\nIniciá sesión en la ventana y apretá Enter (intento ${attempt}/2)... `);
      // Verify in the same window, before closing: the session must be observed here,
      // not guessed by relaunching later.
      await navigate(browser.connection, page.sessionId, startUrl);
      await settle(browser.connection, page.sessionId, config.selectors);
      const auth = await authState(browser.connection, page.sessionId, config.selectors);
      const probe = await evaluate(browser.connection, page.sessionId, PROBE_SNIPPET);
      const artifact = writeArtifact('login', { attempt, auth, probe });
      console.log(`Estado detectado: ${auth.state}  ->  ${artifact}`);

      if (auth.state === 'logged-in') {
        await reportSessionPersistence(browser.connection, config);
        console.log('Sesión observada y guardada en el perfil.');
        return EXIT.ok;
      }
      if (auth.state === 'login') {
        console.log('Todavía aparece el formulario de login. Si ya te logueaste, puede haber un segundo paso sin completar.');
        continue;
      }
      console.log('No aparece el formulario de login: la sesión probablemente tomó, pero falta "selectors.loggedIn".');
      await reportSessionPersistence(browser.connection, config);
      console.log(`El artefacto trae el DOM de después del login: ${artifact}`);
      return EXIT.ok;
    }
    return EXIT.config;
  } finally {
    await browser.close();
  }
}

async function cmdCheckAuth(config) {
  const startUrl = requireConfigValue(config, 'startUrl');
  const result = await withBrowser(config, async (browser) => {
    const page = await newPage(browser.connection, startUrl);
    await settle(browser.connection, page.sessionId, config.selectors);
    const auth = await authState(browser.connection, page.sessionId, config.selectors);
    const worker = await extensionServiceWorker(browser.connection);
    const title = await evaluate(browser.connection, page.sessionId, 'return document.title');
    return { ...auth, url: startUrl, title, extensionServiceWorker: worker?.url ?? null };
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.state === 'login') {
    console.error(sessionExpired('el sitio muestra el formulario de login; corré --login'));
    return EXIT.sessionExpired;
  }
  if (result.state === 'unknown') {
    console.error('No se pudo clasificar la página: revisá "selectors.loggedIn" y "selectors.login".');
    return EXIT.config;
  }
  if (!result.extensionServiceWorker) {
    console.error('La sesión está bien pero el service worker de la extensión no aparece: revisá extensionDir.');
    return EXIT.config;
  }
  return EXIT.ok;
}

async function cmdRun(config, scenarioPath) {
  if (!scenarioPath) throw new CdpError('usage: node harness.mjs --run <scenario.json>');
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const startUrl = scenario.startUrl ?? requireConfigValue(config, 'startUrl');
  const selectors = scenario.selectors ?? config.selectors;

  const outcome = await withBrowser(config, async (browser) => {
    const page = await newPage(browser.connection, startUrl);
    await settle(browser.connection, page.sessionId, selectors);
    const auth = await authState(browser.connection, page.sessionId, selectors);
    if (auth.state === 'login') return { status: 'session-expired', steps: [], auth };
    if (auth.state === 'unknown') return { status: 'unclassified', steps: [], auth };

    const capture = scenario.captureNetwork
      ? await startNetworkCapture(browser.connection, page.sessionId)
      : undefined;

    const steps = [];
    for (const [index, step] of (scenario.steps ?? []).entries()) {
      const record = { index, ...step };
      try {
        if (step.navigate) {
          await navigate(browser.connection, page.sessionId, step.navigate);
          record.result = true;
        } else if (step.waitFor) {
          record.result = await waitForTruthy(browser.connection, page.sessionId, step.waitFor, step.timeoutMs);
          record.ok = Boolean(record.result);
        } else if (step.eval) {
          record.result = await evaluate(browser.connection, page.sessionId, step.eval);
          record.ok = record.result !== false && record.result !== null;
        } else if (step.click) {
          record.result = await evaluate(
            browser.connection,
            page.sessionId,
            `const el = document.querySelector(${JSON.stringify(step.click)});
             if (!el) return null;
             el.click();
             return true;`,
          );
          record.ok = record.result === true;
        } else if (step.inFrame) {
          record.result = await evaluateInFrame(
            browser.connection,
            page.sessionId,
            step.frame ?? '.*',
            step.inFrame,
          );
          record.ok = record.result !== false && record.result !== null;
        } else if (step.evalInServiceWorker) {
          record.result = await evaluateInServiceWorker(browser.connection, step.evalInServiceWorker);
          record.ok = record.result !== false && record.result !== null;
        } else {
          record.ok = false;
          record.error = 'step needs one of: navigate, waitFor, click, eval, inFrame, evalInServiceWorker';
        }
      } catch (error) {
        record.ok = false;
        record.error = String(error.message ?? error);
      }
      steps.push(record);
      if (record.ok === false) break;
    }

    const worker = await extensionServiceWorker(browser.connection);
    const pages = (await browser.connection.send('Target.getTargets')).targetInfos
      .filter((target) => target.type === 'page')
      .map((target) => target.url);
    let network;
    if (capture) {
      capture.stop();
      network = await summarizeCapture(browser.connection, page.sessionId, capture, scenario.captureNetwork);
    }
    return {
      status: 'ran',
      startUrl,
      auth,
      extensionServiceWorker: worker?.url ?? null,
      pages,
      network,
      steps,
      passed: steps.filter((step) => step.ok).length,
      failed: steps.filter((step) => step.ok === false).length,
    };
  });

  const artifact = writeArtifact('run', outcome);
  console.log(JSON.stringify({ ...outcome, artifact }, null, 2));
  if (outcome.status === 'session-expired') {
    console.error(sessionExpired('el sitio muestra el formulario de login; corré --login'));
    return EXIT.sessionExpired;
  }
  if (outcome.status !== 'ran' || outcome.failed > 0) return EXIT.failed;
  return EXIT.ok;
}

async function cmdSelftest() {
  const fixtures = path.join(HERE, 'fixtures');
  const profileDir = path.join(LOCAL_ROOT, 'selftest-profile');
  const browserPath = detectBrowser();
  if (!browserPath) throw new ConfigError('no browser found for selftest');

  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
  };

  const browser = await launch({ browserPath, profileDir, headless: true });
  try {
    const page = await newPage(browser.connection, pathToFileURL(path.join(fixtures, 'login.html')).href);
    const loginPage = await authState(browser.connection, page.sessionId, {
      loggedIn: '#mapa',
      login: 'form#login',
    });
    record('login wall is classified as login', loginPage.state === 'login', loginPage);

    await navigate(browser.connection, page.sessionId, pathToFileURL(path.join(fixtures, 'map.html')).href);
    const mapPage = await authState(browser.connection, page.sessionId, {
      loggedIn: '#mapa',
      login: 'form#login',
    });
    record('logged-in page is classified as logged-in', mapPage.state === 'logged-in', mapPage);

    const promised = await evaluate(
      browser.connection,
      page.sessionId,
      'await new Promise((resolve) => setTimeout(() => resolve(42), 30)); return 42',
    );
    record('await inside a snippet resolves', promised === 42, promised);

    const dom = await evaluate(
      browser.connection,
      page.sessionId,
      "return document.querySelector('#mapa').getAttribute('data-poles')",
    );
    record('dom reads return values', dom === '3', dom);

    let threw = false;
    try {
      await evaluate(browser.connection, page.sessionId, "throw new Error('boom')");
    } catch {
      threw = true;
    }
    record('a throwing snippet surfaces as an error', threw);

    const waited = await waitForTruthy(
      browser.connection,
      page.sessionId,
      'return document.querySelector("#mapa").dataset.ready === "yes"',
      5000,
    );
    record('waitFor polls until truthy', waited === true, waited);
  } finally {
    await browser.close();
  }

  const failures = checks.filter((check) => !check.ok).length;
  const artifact = writeArtifact('selftest', { browserPath, checks, failures });
  console.log(`\n${checks.length - failures}/${checks.length} checks ok  ->  ${artifact}`);
  return failures === 0 ? EXIT.ok : EXIT.failed;
}

const PROBE_SNIPPET = `
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  const textNodes = [...document.querySelectorAll('div, span, a, button, li, td, label')]
    .filter((el) => el.children.length === 0 && el.textContent && el.textContent.trim())
    .map((el) => ({
      text: el.textContent.trim().slice(0, 40),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: String(el.className || '').slice(0, 70),
    }))
    .filter((item) => item.text.length <= 40 && /map|naveg|planif|circuito|central/i.test(item.text))
    .slice(0, 40);
  const mapCandidates = [...document.querySelectorAll('canvas, svg, .ol-viewport, .leaflet-container, [id*="map"], [id*="Map"], [class*="map"], [class*="Map"]')]
    .slice(0, 20)
    .map((el) => ({ tag: el.tagName.toLowerCase(), id: el.id || null, cls: String(el.className || '').slice(0, 70) }));
  const describeInput = (el) => ({
    tag: el.tagName.toLowerCase(), type: el.type ?? null, id: el.id || null,
    name: el.name || null, placeholder: el.placeholder || null,
  });
  return {
    url: location.href,
    title: document.title,
    textNodes,
    mapCandidates,
    readyState: document.readyState,
    hasPasswordField: Boolean(document.querySelector('input[type=password]')),
    forms: [...document.forms].map((form) => ({
      id: form.id || null,
      name: form.name || null,
      action: form.getAttribute('action'),
      method: form.getAttribute('method'),
      inputs: [...form.querySelectorAll('input, select, textarea')].map(describeInput),
      buttons: [...form.querySelectorAll('button, input[type=submit]')].map((b) => text(b)),
    })),
    passwordInputs: [...document.querySelectorAll('input[type=password]')].map(describeInput),
    interesting: [...document.querySelectorAll('a, button, [role=menuitem], li')]
      .map((el) => ({ tag: el.tagName.toLowerCase(), id: el.id || null, text: text(el), href: el.getAttribute('href') }))
      .filter((item) => item.text && /map|naveg|planific|centrality|centralidad/i.test(item.text))
      .slice(0, 25),
    ids: [...document.querySelectorAll('[id]')].map((el) => el.id).slice(0, 50),
  };
`;

async function cmdCleanup(config) {
  const profileDir = config.profileDir ?? DEFAULT_PROFILE;
  const result = cleanupStaleBrowsers(profileDir);
  console.log(JSON.stringify({ profileDir, ...result }, null, 2));
  return EXIT.ok;
}

async function cmdProbe(config, url) {
  const target = url ?? requireConfigValue(config, 'startUrl');
  const result = await withBrowser(config, async (browser) => {
    const page = await newPage(browser.connection, target);
    await settle(browser.connection, page.sessionId, config.selectors);
    const info = await evaluate(browser.connection, page.sessionId, PROBE_SNIPPET);
    const worker = await extensionServiceWorker(browser.connection);
    return { requestedUrl: target, ...info, extensionServiceWorker: worker?.url ?? null };
  });
  const artifact = writeArtifact('probe', result);
  console.log(JSON.stringify({ ...result, artifact }, null, 2));
  return EXIT.ok;
}

const OPEN_MAP_SNIPPET = `
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
await new Promise((r) => setTimeout(r, 10000));
return { ready: Boolean(document.querySelector('#content')) };
`;

/** One `textual_search` per prefix, inside the map frame that owns `Acs`. */
const searchBatchSnippet = (prefixes) => `
const w = document.querySelector('#content').contentWindow;
if (!w) return { error: 'missing #content frame' };
const vp = w.webMap_.getViewportParams ? w.webMap_.getViewportParams() : {};
const ask = (prefix) => new Promise((resolve) => {
  let done = false;
  const finish = (value) => { if (!done) { done = true; resolve(value); } };
  const timer = setTimeout(() => finish(null), 8000);
  try {
    w.Acs.request({
      url: 'svc_wmc.php',
      params: Object.assign({ action: 'textual_search', query: prefix, page: 1, start: 0, limit: 100 }, vp),
      success: (r) => { clearTimeout(timer); finish(Array.isArray(r) ? r : (r.rows || r.data || [])); },
      failure: () => { clearTimeout(timer); finish(null); },
    });
  } catch (error) { clearTimeout(timer); finish(null); }
});
const codeOf = (display) => {
  const text = String(display || '').trim();
  let end = 0;
  while (end < text.length) {
    const ch = text[end];
    const alnum = (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
    if (!alnum) break;
    end += 1;
  }
  return text.slice(0, end).toUpperCase();
};
const out = {};
for (const prefix of ${JSON.stringify(prefixes)}) {
  const rows = await ask(prefix);
  out[prefix] = rows === null ? null : rows.map((row) => ({ id: row.object_id, code: codeOf(row.display) }));
}
return out;
`;

/** Bulk geometry: one call per chunk of object ids. */
const geometrySnippet = (ids) => `
const w = document.querySelector('#content').contentWindow;
if (!w) return null;
const vp = w.webMap_.getViewportParams ? w.webMap_.getViewportParams() : {};
const ids = ${JSON.stringify(ids)}.map((value) => (/^\\d+$/.test(value) ? Number(value) : value));
const payload = await new Promise((resolve) => {
  let done = false;
  const finish = (value) => { if (!done) { done = true; resolve(value); } };
  const timer = setTimeout(() => finish(null), 25000);
  try {
    w.Acs.request({
      url: 'svc_wmc.php',
      params: Object.assign({ action: 'get_objects_geojson', object_ids: w.Ext.encode(ids) }, vp),
      success: (r) => { clearTimeout(timer); finish(r); },
      failure: () => { clearTimeout(timer); finish(null); },
    });
  } catch (error) { clearTimeout(timer); finish(null); }
});
if (!payload) return null;
const feats = payload.type === 'Feature' ? [payload] : (payload.features || []);
return feats.map((f) => ({
  id: f.id === undefined || f.id === null ? null : String(f.id),
  lon: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[0] : null,
  lat: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[1] : null,
}));
`;

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current || !current.startsWith('--')) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) flags[current.slice(2)] = true;
    else { flags[current.slice(2)] = value; i += 1; }
  }
  return flags;
}

async function cmdEnumerate(config, seed, args = []) {
  if (!seed) throw new CdpError('usage: node harness.mjs --enumerate <prefix> [--max-queries N] [--max-length N] [--batch N]');
  const flags = parseFlags(args);
  const maxQueries = Number(flags['max-queries'] ?? 400);
  const maxLength = Number(flags['max-length'] ?? 8);
  const batch = Math.max(1, Number(flags.batch ?? 6));
  const chunk = Math.max(1, Number(flags.chunk ?? 150));
  const startUrl = requireConfigValue(config, 'startUrl');
  const selectors = config.selectors;

  const outcome = await withBrowser(config, async (browser) => {
    const page = await newPage(browser.connection, startUrl);
    await settle(browser.connection, page.sessionId, selectors);
    const auth = await authState(browser.connection, page.sessionId, selectors);
    if (auth.state === 'login') return { status: 'session-expired', detail: sessionExpired('enumerate needs a live session; run --login') };

    const opened = await evaluate(browser.connection, page.sessionId, OPEN_MAP_SNIPPET);
    if (!opened || opened.error) return { status: 'failed', error: opened?.error ?? 'map did not open' };

    const state = newState({ seed, maxLength, maxQueries });
    const codeOfId = new Map();
    const retried = new Set();
    const failures = [];

    for (;;) {
      const prefixes = [];
      for (let i = 0; i < batch; i += 1) {
        const prefix = next(state);
        if (prefix === null) break;
        prefixes.push(prefix);
      }
      if (prefixes.length === 0) break;

      const result = await evaluate(browser.connection, page.sessionId, searchBatchSnippet(prefixes));
      if (!result || result.error) {
        for (const prefix of prefixes) { state.asked.delete(prefix); state.queries -= 1; state.queue.push(prefix); }
        failures.push(...prefixes);
        if (failures.length > 20) break;
        continue;
      }

      for (const prefix of prefixes) {
        const rows = result[prefix];
        if (rows === null || rows === undefined) {
          if (!retried.has(prefix)) {
            retried.add(prefix);
            state.asked.delete(prefix);
            state.queries -= 1;
            state.queue.push(prefix);
            continue;
          }
          failures.push(prefix);
          state.truncated.push(prefix);
          absorb(state, prefix, []);
          continue;
        }
        for (const row of rows) if (row.id && row.code) codeOfId.set(String(row.id), row.code);
        absorb(state, prefix, rows.map((row) => row.code).filter(Boolean));
      }
    }

    const ids = [...codeOfId.keys()];
    const points = [];
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      const feats = await evaluate(browser.connection, page.sessionId, geometrySnippet(slice));
      if (Array.isArray(feats)) for (const feat of feats) if (feat && feat.lon !== null && feat.lat !== null) points.push(feat);
    }

    const objects = points.map((point) => ({
      id: point.id,
      code: point.id === null ? null : codeOfId.get(point.id) ?? null,
      lon: point.lon,
      lat: point.lat,
    }));

    return {
      status: 'ran',
      seed,
      summary: summarize(state),
      idsSearched: ids.length,
      points: objects.length,
      pointsWithCode: objects.filter((o) => o.code).length,
      failures,
      objects,
    };
  });

  const artifact = writeArtifact(`enumerate-${seed}`, outcome);
  const { objects = [], ...rest } = outcome;
  console.log(JSON.stringify({ ...rest, objects: objects.length, artifact }, null, 2));
  if (outcome.status === 'session-expired') return EXIT.sessionExpired;
  return outcome.status === 'ran' ? EXIT.ok : EXIT.failed;
}

function usage() {
  console.log(`GNAT harness

  node harness.mjs --login              abre el navegador para iniciar sesión una vez
  node harness.mjs --check-auth         verifica si la sesión guardada sirve
  node harness.mjs --probe [url]        inspecciona el DOM de una página (formularios, ids, navegación)
  node harness.mjs --cleanup            mata sólo los navegadores que usan este perfil
  node harness.mjs --run <file.json>    ejecuta un escenario y escribe un artefacto
  node harness.mjs --enumerate <pref>   enumera codigos y coordenadas por arbol de prefijos
  node harness.mjs --selftest           prueba la plomería contra fixtures locales

Salidas: 0 ok | 1 falló un paso | 2 SESSION_EXPIRED | 3 falta configuración`);
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  switch (command) {
    case '--login':
      return cmdLogin(loadConfig());
    case '--check-auth':
      return cmdCheckAuth(loadConfig());
    case '--probe':
      return cmdProbe(loadConfig(), argument);
    case '--cleanup':
      return cmdCleanup(loadConfig());
    case '--run':
      return cmdRun(loadConfig(), argument);
    case '--enumerate':
      return cmdEnumerate(loadConfig(), argument, process.argv.slice(4));
    case '--selftest':
      return cmdSelftest();
    default:
      usage();
      return command === undefined ? EXIT.ok : EXIT.config;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`ERROR: ${error.message ?? error}`);
    process.exit(error instanceof ConfigError ? EXIT.config : EXIT.failed);
  });
