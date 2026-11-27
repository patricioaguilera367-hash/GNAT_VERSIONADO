// Minimal Chrome DevTools Protocol client: no dependencies, uses Node's built-in WebSocket.
// Launches a Chromium-based browser with an isolated persistent profile, so a session
// established once by a human is reused by every later run.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpError extends Error {}

const BROWSER_CANDIDATES = [
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

/** First Chromium-based browser found on this machine, or undefined. */
export function detectBrowser() {
  return BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

class Connection {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Set();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id);
        if (!waiter) return;
        this.#pending.delete(message.id);
        if (message.error) waiter.reject(new CdpError(`${waiter.method}: ${message.error.message}`));
        else waiter.resolve(message.result);
        return;
      }
      for (const handler of this.#handlers) handler(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new CdpError(`${method}: timed out after 30s`));
      }, 30_000);
    });
  }

  on(handler) {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
  }
}

/** True when the browser no longer holds the profile's DevTools port file. */
async function portFileReleased(portFile) {
  if (!fs.existsSync(portFile)) return true;
  try {
    fs.rmSync(portFile, { force: true });
    return true;
  } catch (error) {
    if (error.code === 'EBUSY' || error.code === 'EPERM') return false;
    throw error;
  }
}

/** Remove a stale DevTools port file, tolerating Windows file locks. */
async function clearPortFile(portFile) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await portFileReleased(portFile)) return;
    await sleep(200);
  }
  throw new CdpError(
    `the profile is still locked (${portFile}); close any browser using it and retry`,
  );
}

/**
 * Launch the browser with an isolated profile and connect to its DevTools endpoint.
 * `--remote-debugging-port=0` lets the browser pick a free port and write it, together
 * with the WebSocket path, into `<profileDir>/DevToolsActivePort`.
 */
export async function launch({ browserPath, profileDir, extensionDir, headless = true, ignoreCertificateErrors = false, extraArgs = [] }) {
  const executable = browserPath ?? detectBrowser();
  if (!executable) throw new CdpError('no Chromium-based browser found; set browserPath in config.json');

  fs.mkdirSync(profileDir, { recursive: true });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  await clearPortFile(portFile);

  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--allow-insecure-localhost',
    '--enable-unsafe-extension-debugging',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
  ];
  if (extensionDir) {
    args.push(`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`);
  }
  if (ignoreCertificateErrors) args.push('--ignore-certificate-errors');
  if (headless) args.push('--headless=new');
  args.push(...extraArgs, 'about:blank');

  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const stderr = [];
  child.stderr.on('data', (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 40) stderr.shift();
  });

  const deadline = Date.now() + 30_000;
  let port;
  let wsPath;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new CdpError(`browser exited with code ${child.exitCode}: ${stderr.join('').slice(-800)}`);
    }
    if (fs.existsSync(portFile)) {
      try {
        const [rawPort, rawPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
        if (rawPort && rawPath) {
          port = Number(rawPort);
          wsPath = rawPath.trim();
          break;
        }
      } catch (error) {
        // Windows puede dejar el archivo bloqueado mientras el navegador lo escribe.
        if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
      }
    }
    await sleep(100);
  }
  if (!port || !wsPath) {
    child.kill();
    throw new CdpError(`browser did not expose DevTools within 30s: ${stderr.join('').slice(-800)}`);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new CdpError('DevTools WebSocket failed to open')), { once: true });
  });

  const connection = new Connection(ws);
  return {
    connection,
    port,
    pid: child.pid,
    async close() {
      try {
        await connection.send('Browser.close');
      } catch {
        // browser may already be gone
      }
      connection.close();
      // Windows keeps the profile locked while any child process is still alive, and a
      // forced kill can abort the cookie flush that makes a login survive. Wait long
      // enough for a graceful exit before falling back to killing the tree.
      const gone = Date.now() + 15_000;
      while (child.exitCode === null && Date.now() < gone) await sleep(100);
      if (child.exitCode === null) child.kill();
      const released = Date.now() + 10_000;
      while (Date.now() < released && !(await portFileReleased(portFile))) await sleep(100);
    },
  };
}

/** Open a new tab, attach a flat session, and optionally navigate. */
export async function newPage(connection, url) {
  // An unclean exit can leave dozens of restored tabs in the profile, and the harness
  // only ever wants one. Close whatever came back before creating our own.
  const { targetInfos } = await connection.send('Target.getTargets');
  for (const target of targetInfos) {
    if (target.type !== 'page') continue;
    try {
      await connection.send('Target.closeTarget', { targetId: target.targetId });
    } catch {
      // closing a restored tab can race with its own teardown
    }
  }
  const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
  await connection.send('Page.enable', {}, sessionId);
  await connection.send('Runtime.enable', {}, sessionId);
  if (url) await navigate(connection, sessionId, url);
  return { targetId, sessionId };
}

export async function navigate(connection, sessionId, url) {
  const loaded = new Promise((resolve) => {
    const off = connection.on((message) => {
      if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') {
        off();
        resolve();
      }
    });
    setTimeout(() => {
      off();
      resolve();
    }, 20_000);
  });
  await connection.send('Page.navigate', { url }, sessionId);
  await loaded;
}

/**
 * Evaluate a snippet as an async function body. The snippet must `return` what it wants
 * to observe: `return document.querySelector('#mapa') !== null`.
 */
export async function evaluate(connection, sessionId, snippet) {
  const response = await connection.send(
    'Runtime.evaluate',
    {
      expression: `(async () => { ${snippet} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    sessionId,
  );
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
    throw new CdpError(`page threw: ${description}`);
  }
  return response.result.value;
}

/** The extension's MV3 service worker target, if the extension is loaded and awake. */
export async function extensionServiceWorker(connection) {
  const { targetInfos } = await connection.send('Target.getTargets');
  return targetInfos.find(
    (target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'),
  );
}

/**
 * Evaluate a snippet inside a child frame whose URL matches `frameUrlPattern`.
 * The app loads the map in an iframe, so the main frame cannot see its DOM.
 * An isolated world keeps the harness out of the page's own JS globals.
 */
export async function evaluateInFrame(connection, sessionId, frameUrlPattern, snippet) {
  const { frameTree } = await connection.send('Page.getFrameTree', {}, sessionId);
  const pattern = new RegExp(frameUrlPattern);
  const find = (node) => {
    if (node.frame.url && pattern.test(node.frame.url)) return node.frame;
    for (const child of node.childFrames ?? []) {
      const found = find(child);
      if (found) return found;
    }
    return undefined;
  };
  const frame = find(frameTree);
  if (!frame) throw new CdpError(`no frame matches ${frameUrlPattern}`);
  const { executionContextId } = await connection.send(
    'Page.createIsolatedWorld',
    { frameId: frame.id, worldName: 'gnat-harness' },
    sessionId,
  );
  const response = await connection.send(
    'Runtime.evaluate',
    {
      expression: `(async () => { ${snippet} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      contextId: executionContextId,
    },
    sessionId,
  );
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
    throw new CdpError(`frame threw: ${description}`);
  }
  return response.result.value;
}

/** Attach to the extension service worker and evaluate a snippet inside it. */
export async function evaluateInServiceWorker(connection, snippet) {
  const worker = await extensionServiceWorker(connection);
  if (!worker) throw new CdpError('extension service worker target not found (is the extension loaded?)');
  const { sessionId } = await connection.send('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  });
  await connection.send('Runtime.enable', {}, sessionId);
  return evaluate(connection, sessionId, snippet);
}

/**
 * Chromium drops cookies without an expiry when the browser closes, so a PHP session
 * (`PHPSESSID`) never survives a restart by itself. Re-stamping those cookies with a
 * far-future expiry makes them persist locally; the server sees no difference, because
 * the cookie value and attributes are unchanged.
 *
 * This is a deliberate tradeoff: the session token now lives on disk for `days`.
 */
export async function persistSessionCookies(connection, days) {
  const { cookies } = await connection.send('Storage.getCookies');
  const sessionCookies = cookies.filter((cookie) => cookie.session === true);
  if (sessionCookies.length === 0) return { persisted: 0, total: cookies.length };
  const expires = Math.floor(Date.now() / 1000) + days * 86_400;
  const stamped = cookies.map((cookie) => {
    const { session, ...rest } = cookie;
    return session === true ? { ...rest, expires, session: false } : rest;
  });
  await connection.send('Storage.setCookies', { cookies: stamped });
  return { persisted: sessionCookies.length, total: cookies.length, expires };
}

/**
 * Kill only the browser processes that belong to this harness profile. A plain
 * "kill all brave.exe" would take down the user's own browser, so the filter is the
 * profile path itself, which every process we spawn carries in its command line.
 */
export function cleanupStaleBrowsers(profileDir) {
  const escaped = profileDir.replace(/'/g, "''");
  const script = [
    `$p = '${escaped}';`,
    "Get-CimInstance Win32_Process -Filter \"name='brave.exe' or name='msedge.exe' or name='chrome.exe'\"",
    '| Where-Object { $_.CommandLine -and $_.CommandLine.Contains($p) }',
    '| ForEach-Object { $_.ProcessId }',
  ].join(' ');
  const listed = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  const pids = (listed.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
  for (const pid of pids) {
    spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], {
      windowsHide: true,
    });
  }
  return { killed: pids.length, pids };
}
