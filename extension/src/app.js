/*
 * CENTRALITY LOCAL V10.2 (INTEGRATED GNAT DMS & D/T/F POLYGON ENGINE)
 * - 3 zonas espaciales: Barra superior + Dock inferior + Cajón lateral de tabla
 * - Motor GNAT integrado (svc_wmc.php): búsqueda con pin [F], caché de catálogo en IndexedDB,
 *   auto-descubrimiento de tramos MT (A->B), aperturas cercanas y remates aguas abajo
 * - Generación y edición independiente de polígonos para D (Zona desconectada), T (Zona de trabajo) y F (Punto de faenas)
 * - Editor de vértices nativo (arrastrar vértices, insertar punto medio, borrar con clic derecho, dibujar nuevo)
 *   con toggle para ocultar pines de postes y autoguardado real en IndexedDB y JSON
 */
(() => {
  "use strict";

  const frame = document.querySelector("iframe#content");
  if (!frame) {
    console.error("Centrality V10: Abre primero el módulo Mapas de Centrality.");
    return;
  }

  let w, map, ol, doc;
  try {
    w = frame.contentWindow;
    map = w.webMap_?.map;
    ol = w.ol;
    doc = w.document;
  } catch (e) {
    console.error("Centrality V10: No es posible acceder al mapa de Centrality:", e);
    return;
  }

  if (!map || !ol?.layer?.Vector || !ol?.source?.Vector || !ol?.format?.KML ||
      !ol?.Feature || !ol?.geom?.Point || !ol?.style?.Style || !ol?.style?.Circle ||
      !ol?.style?.Text || !ol?.style?.Fill || !ol?.style?.Stroke || !ol?.style?.RegularShape) {
    console.error("Centrality V10: OpenLayers no expone los componentes requeridos.");
    return;
  }

  // Migración en caliente si viene de una sesión previa en memoria
  const prevPoints = [];
  const prevZones = [];
  try {
    if (typeof w.__superponerKMZ?.getPuntos === "function") {
      for (const f of w.__superponerKMZ.getPuntos() || []) {
        const g = f.getGeometry?.();
        if (g?.getType?.() === "Point") {
          prevPoints.push({
            xy: g.getCoordinates().slice(0, 2),
            id: f.get("id"),
            numero: f.get("numero"),
            tipo: f.get("tipo") || "PUNTO",
            codigo: f.get("codigo"),
            bloqueId: f.get("bloqueId") || "",
            bloques: f.get("bloques") || [],
            aperturasIds: f.get("aperturasIds") || [],
            bloque: f.get("bloque") || "Sin asignar",
            tipoEquipo: f.get("tipoEquipo") || "",
            colorPersonalizado: f.get("colorPersonalizado") || ""
          });
        }
      }
    }
    if (typeof w.__superponerKMZ?.getBloques === "function") {
      prevZones.push(...(w.__superponerKMZ.getBloques() || []));
    }
  } catch (_) {}

  // Cerrar instancias previas limpiamente
  try { w.__centralityV10?.destroy?.(); } catch (_) {}
  try { w.__centralityToolsV1?.destroy?.(); } catch (_) {}
  try { w.__superponerKMZ?.cerrar?.(); } catch (_) {}
  try { w.__pruebaDetalleCentrality?.cerrar?.(); } catch (_) {}
  try { w.__centralityAtlasPDF?.destruir?.(); } catch (_) {}

  const ICONS = window.__C_ICONS || { svg: () => "", setIconBtn: (d, b, i, l) => { b.textContent = l || ""; return b; } };
  const CAT = window.__C_CATALOGS;
  const {
    HIGH_CONTRAST_PALETTE, DEFAULT_SUPERVISORS, LEGACY_COLOR_TO_SUP,
    PROTECTION_TYPES, EPT_TYPES, EQUIPMENT_TYPES,
    mapProtectionFromText, haversineMeters, extractLatLonFromLine,
    extractPointFromGeoJsonFeature, parseSmartTableText
  } = CAT;
  const iconHtml = (name, size = 14) => ICONS.svg(name, size);
  const setBtn = (btn, iconName, label = "", size = 14, chev = false) => ICONS.setIconBtn(doc, btn, iconName, label, size, chev);
  // =========================================================================
  // 1. CONSTANTES (IMPORTADAS DESDE src/catalogs.js)
  // =========================================================================
  const OPENING_COLOR = "#DC2626";
  const UNASSIGNED_ZONE_COLOR = "#475569";
  const UMBRAL_ETIQUETA = 25;
  // Tolerancia para decir "esta coordenada es este punto": 150 m cubre el redondeo de
  // la planilla y sigue distinguiendo dos postes distintos.
  const COORD_MATCH_METERS = 150;
  // S16: una sola definición de columnas. El <colgroup>, el encabezado y cada fila
  // salen de esta lista, así el ancho de una columna no se declara dos veces y no
  // puede diferir entre encabezado y cuerpo.
  // S17: un código de poste tiene mucha información asociada, así que las columnas que
  // la revelan vienen ocultas por defecto y se encienden desde el chip «Columnas».
  // `hiddenByDefault` es el único lugar donde se decide qué arranca oculto.
  const TABLE_COLUMNS = [
    { id: "check", label: "", width: "30px" },
    { id: "numero", label: "Rol/N°", width: "60px", sortKey: "numero" },
    { id: "codigo", label: "Código", width: "", sortKey: "codigo" },
    { id: "zona", label: "Zona", width: "88px", sortKey: "zona" },
    { id: "sup", label: "Sup.", width: "46px", sortKey: "sup", requiresMultiSup: true },
    { id: "estado", label: "Estado", width: "112px", sortKey: "estado", hiddenByDefault: true },
    { id: "equipo", label: "Equipo", width: "132px", sortKey: "equipo", hiddenByDefault: true },
    { id: "dist", label: "Dist.", width: "68px", sortKey: "dist", hiddenByDefault: true },
    { id: "coci", label: "COCI_3F", width: "84px", sortKey: "coci", hiddenByDefault: true }
  ];
  const defaultHiddenColumns = () => TABLE_COLUMNS.filter(c => c.hiddenByDefault).map(c => c.id);
  // S19: la tabla no comprime una columna por debajo de lo legible. Si al revelar
  // columnas el ancho no alcanza, la tabla se ensancha y la barra desplaza: la columna
  // elástica (Código) conserva su piso en vez de quedar en "F…" o desaparecer.
  const CODE_COLUMN_MIN = 140;
  const tableMinWidth = (cols) =>
    cols.reduce((n, c) => n + (parseInt(c.width, 10) || 0), 0) + CODE_COLUMN_MIN;
  // S18: el orden de las columnas es dato del proyecto, no del código. Una columna que
  // la lista guardada no conoce (recién agregada) entra al final en vez de desaparecer.
  const orderedTableColumns = () => {
    const byId = new Map(TABLE_COLUMNS.map(c => [c.id, c]));
    const seen = new Set();
    const out = [];
    for (const id of state.columnOrder) {
      const c = byId.get(id);
      if (c && !seen.has(id)) {
        out.push(c);
        seen.add(id);
      }
    }
    for (const c of TABLE_COLUMNS) if (!seen.has(c.id)) out.push(c);
    return out;
  };

  // =========================================================================
  // 2. ESTADO DE LA APLICACIÓN
  // =========================================================================
  const state = {
    projectId: "proj-" + Date.now(),
    projectName: "Proyecto sin título",
    dirty: false,
    points: [],             // Array<ol.Feature> (postes y aperturas)
    spans: [],              // Array<{ id, from, to, coords: [[lon,lat],[lon,lat]], display, voltage }> (vectores MT A->B)
    graphNodes: [],         // Array<{ code, lonlat, coci3f, sseeCode }> (postes intermedios solo visuales, sin ensuciar la tabla)
    zones: new Map([
      ["D", { id: "D", name: "Zona desconectada (D)", color: "#DC2626", customRing: null }],
      ["T", { id: "T", name: "Zona de trabajo (T)", color: "#00C853", customRing: null }],
      ["F", { id: "F", name: "Punto de faenas (F)", color: "#FF6D00", customRing: null }]
    ]),
    supervisors: new Map(DEFAULT_SUPERVISORS.map(s => [s.id, { ...s }])),
    multiSupervisorEnabled: false,
    hiddenColumns: new Set(defaultHiddenColumns()),
    columnOrder: TABLE_COLUMNS.map(c => c.id),
    autoPrefixF: true,      // Pin [F] activo por defecto para Frontel
    selected: new Set(),    // Set<number> (indices in state.points)
    focused: -1,            // index in state.points
    cursorMode: "nav",      // "nav" | "box" | "add" | "link-opening" | "place-missing" | "edit-poly" | "draw-poly"
    editingZoneId: null,    // ID de la zona cuyo polígono se está editando o dibujando
    drawingCoords: [],      // vértices temporales al dibujar polígono nuevo
    pendingLinkIndices: [], // indices waiting to be linked to clicked/created opening
    pendingMissingCodes: [],// queue of missing codes to place on map click by click
    drawerOpen: true,
    collapsed: false,
    // Filtros dinámicos combinables
    search: "",
    filterTypes: new Set(), // combinable: "PUNTO", "APERTURA", "REMATE" (vacío = todos)
    filterZones: new Set(), // legacy
    hiddenZones: new Set(), // visibilidad por exclusión (vacío = todas visibles; "__NONE__" = sin zona)
    // S14: conjunto aparte para el relleno. Antes el polígono leía `hiddenZones`, así que
    // ocultar una zona se llevaba puestos los puntos y no había forma de ver los puntos
    // sin el área pintada.
    hiddenZoneAreas: new Set(),
    hiddenStatuses: new Set(),
    statuses: new Map([
      ["pendiente", { id: "pendiente", name: "Pendiente", color: "#64748B" }],
      ["en_ejecucion", { id: "en_ejecucion", name: "En ejecución", color: "#2563EB" }],
      ["ejecutado", { id: "ejecutado", name: "Ejecutado", color: "#16A34A" }],
      ["no_aplica", { id: "no_aplica", name: "No aplica ejecutar", color: "#D97706" }]
    ]),
    filterSups: new Set(),  // empty = all
    lastSearchMissing: [],  // códigos pegados en el buscador que no están en la tabla
    recentColors: ["#00C853", "#FF6D00", "#DC2626", "#2979FF"],
    syncQueue: { running: false, paused: false, cancelled: false, total: 0, done: 0, items: [] },
    showIntermediosInTable: false,
    selectedIntermedios: new Set(),
    sortBy: "numero",
    sortDir: "asc",
    lastCheckedPos: -1,
    undoStack: [],
    // Opciones de visualización en mapa
    colorBy: "zone",        // "zone" | "supervisor"
    hidePoles: false,       // Ocultar pines de postes para editar polígonos cómodamente
    showHulls: true,        // Polígonos D / T / F
    showSpans: true,        // Vectores de tramos MT (A->B)
    showRoute: false,       // Línea secuencial 1->2->3
    showLinks: false,       // Rayos punteados desactivados por defecto (usar tramos MT reales)
    labelMode: "cerca",     // "cerca" | "siempre" | "ninguna"
    labelContent: "numero", // "numero" | "completo"
    mtbtDetail: 0,          // 0 | 1 | 2 | 3
    highlightNetwork: false,
    backupDirHandle: null,
    backupDirPerm: "prompt"
  };

  let styleCache = new WeakMap();
  let vectorLayer = null;
  let hullLayer = null;
  let spanLayer = null;
  let routeLayer = null;
  let linkLayer = null;
  let dragBoxInteraction = null;
  let addPointDropCoord = null;
  let activePopover = null;
  let autosaveTimer = null;
  let draggingVertex = null; // { zoneId, vertexIdx, isMidpoint }

  // =========================================================================
  // 3. UTILIDADES Y HELPERS
  // =========================================================================
  const isHex = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

  const contrastText = (hex) => {
    if (!isHex(hex)) return "#FFFFFF";
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? "#0F172A" : "#FFFFFF";
  };

  const hexToRgba = (hex, alpha) => {
    if (!isHex(hex)) return `rgba(71,85,105,${alpha})`;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  };

  const getPointCode = (f) => {
    const raw = String(f.get("codigo") || "Sin código").trim();
    const num = String(f.get("numero") || "");
    const pref = new RegExp("^" + num + "(?:\\s*[-–—·.:#/]\\s*|\\s+)");
    return raw.replace(pref, "").trim() || raw;
  };

  const getPointZoneIds = (f) => {
    const explicit = Array.isArray(f.get("bloques")) ? f.get("bloques") : [];
    const primary = String(f.get("bloqueId") || "").trim();
    const all = [...new Set([primary, ...explicit].filter(Boolean))];
    if (f.get("tipo") === "APERTURA") {
      const apId = String(f.get("id"));
      const derived = state.points
        .filter(p => p.get("tipo") !== "APERTURA" && p.get("bloqueId") && (p.get("aperturasIds") || []).includes(apId))
        .map(p => String(p.get("bloqueId")));
      return [...new Set([...all, ...derived].filter(Boolean))];
    }
    return all;
  };

  const getLinkedOpeningsForPoste = (f) => {
    if (!f || f.get("tipo") === "APERTURA") return [];
    const directIds = new Set(Array.isArray(f.get("aperturasIds")) ? f.get("aperturasIds").map(String) : []);
    const zIds = getPointZoneIds(f);
    return state.points.filter(p => {
      if (p.get("tipo") !== "APERTURA") return false;
      if (directIds.has(String(p.get("id"))) || directIds.has(getPointCode(p))) return true;
      const apZones = Array.isArray(p.get("bloques")) ? p.get("bloques") : [];
      return zIds.some(z => apZones.includes(z));
    });
  };

  const getLinkedPostesForOpening = (apFeat) => {
    if (!apFeat || apFeat.get("tipo") !== "APERTURA") return [];
    const apId = String(apFeat.get("id"));
    const apCode = getPointCode(apFeat);
    const apZones = new Set(Array.isArray(apFeat.get("bloques")) ? apFeat.get("bloques") : []);
    return state.points.filter(p => {
      if (p.get("tipo") === "APERTURA") return false;
      const refs = Array.isArray(p.get("aperturasIds")) ? p.get("aperturasIds") : [];
      if (refs.includes(apId) || refs.includes(apCode)) return true;
      return getPointZoneIds(p).some(z => apZones.has(z));
    });
  };

  const getSupId = (f) => {
    const raw = String(f.get("supervisorId") || f.get("bloque") || "default").trim();
    if (state.supervisors.has(raw)) return raw;
    if (LEGACY_COLOR_TO_SUP[raw]) return LEGACY_COLOR_TO_SUP[raw];
    for (const s of state.supervisors.values()) {
      if (s.initials.toUpperCase() === raw.toUpperCase() || s.name.toLowerCase() === raw.toLowerCase()) {
        return s.id;
      }
    }
    return "default";
  };

  const isMultiSupActive = () => {
    if (state.multiSupervisorEnabled) return true;
    const used = new Set();
    for (const f of state.points) {
      const sid = getSupId(f);
      if (sid !== "default") used.add(sid);
      if (used.size > 1) return true;
    }
    return false;
  };

  const getPointColor = (f) => {
    const custom = f.get("colorPersonalizado");
    if (isHex(custom)) return custom;
    if (f.get("tipo") === "APERTURA") return OPENING_COLOR;
    if (state.colorBy === "supervisor" && isMultiSupActive()) {
      const sup = state.supervisors.get(getSupId(f));
      return sup ? sup.color : UNASSIGNED_ZONE_COLOR;
    }
    const zids = getPointZoneIds(f);
    // Prioridad visual: F (Faena) > T (Trabajo) > D (Desconectada) > otras zonas
    const priority = ["F", "T", "D"];
    for (const pid of priority) {
      if (zids.includes(pid) && state.zones.has(pid)) return state.zones.get(pid).color;
    }
    if (zids.length && state.zones.has(zids[0])) {
      return state.zones.get(zids[0]).color || HIGH_CONTRAST_PALETTE[0];
    }
    return UNASSIGNED_ZONE_COLOR;
  };

  const nextHighContrastColor = (usedColors) => {
    for (const c of HIGH_CONTRAST_PALETTE) {
      if (!usedColors.has(c.toUpperCase())) return c;
    }
    return HIGH_CONTRAST_PALETTE[usedColors.size % HIGH_CONTRAST_PALETTE.length];
  };

  const autoAssignHighContrastZones = () => {
    let i = 0;
    for (const z of state.zones.values()) {
      if (z.id === "D") { z.color = "#DC2626"; continue; }
      if (z.id === "T") { z.color = "#00C853"; continue; }
      if (z.id === "F") { z.color = "#FF6D00"; continue; }
      z.color = HIGH_CONTRAST_PALETTE[i % HIGH_CONTRAST_PALETTE.length];
      i++;
    }
    styleCache = new WeakMap();
    refreshAll();
    markDirty();
    showToast("Paleta automática de alto contraste aplicada a las zonas.");
  };

  // =========================================================================
  // 4. ALMACENAMIENTO LOCAL (IndexedDB: Proyectos + Catálogo GNAT Persistente)
  // =========================================================================
  const DB_NAME = "CentralityLocalV10";
  const DB_VERSION = 2;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = w.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("projects")) {
          db.createObjectStore("projects", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("gnat_catalog")) {
          db.createObjectStore("gnat_catalog", { keyPath: "code" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetGnatCache(code) {
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        const tx = db.transaction("gnat_catalog", "readonly");
        const req = tx.objectStore("gnat_catalog").get(String(code).toUpperCase());
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }

  async function dbPutGnatCache(entry) {
    if (!entry?.code) return;
    try {
      const db = await openDB();
      await new Promise((resolve) => {
        const tx = db.transaction("gnat_catalog", "readwrite");
        tx.objectStore("gnat_catalog").put({ ...entry, code: String(entry.code).toUpperCase(), fetchedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch (_) {}
  }

  async function dbPutProject(proj) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").put(proj);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbListProjects() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("projects", "readonly");
      const req = tx.objectStore("projects").getAll();
      req.onsuccess = () => {
        const arr = (req.result || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(arr);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDeleteProject(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbSaveSetting(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbGetSetting(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readonly");
      const req = tx.objectStore("settings").get(key);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async function restoreBackupFolderHandle() {
    try {
      const handle = await dbGetSetting("backupDirHandle");
      if (handle && typeof handle.queryPermission === "function") {
        state.backupDirHandle = handle;
        state.backupDirPerm = await handle.queryPermission({ mode: "readwrite" });
      }
    } catch (_) {}
  }

  function serializeProjectPayload() {
    const registros = state.points.map(f => {
      const [longitud, latitud] = f.getGeometry() ? ol.proj.toLonLat(f.getGeometry().getCoordinates(), map.getView().getProjection()) : [0, 0];
      const sid = getSupId(f);
      const legacySup = sid === "CC" ? "Naranjo" : sid === "TL" ? "Azul" : sid === "RD" ? "Verde" : "Sin asignar";
      return {
        id: String(f.get("id")),
        numero: Number(f.get("numero")),
        tipo: f.get("tipo") || "PUNTO",
        codigo: String(f.get("codigo") || ""),
        longitud,
        latitud,
        supervisorColor: legacySup,
        supervisorId: sid,
        bloqueId: String(f.get("bloqueId") || ""),
        bloques: Array.isArray(f.get("bloques")) ? f.get("bloques") : [],
        aperturasIds: Array.isArray(f.get("aperturasIds")) ? f.get("aperturasIds") : [],
        tipoEquipo: String(f.get("tipoEquipo") || ""),
        rolPT: String(f.get("rolPT") || ""),
        accionPT: String(f.get("accionPT") || ""),
        esRemate: Boolean(f.get("esRemate")),
        esIntermedio: Boolean(f.get("esIntermedio")),
        sseeCode: f.get("sseeCode") || "",
        codigoTerreno: String(f.get("codigoTerreno") || ""),
        estadoEjec: String(f.get("estadoEjec") || "pendiente"),
        proteccionTipo: String(f.get("proteccionTipo") || ""),
        eptTipo: String(f.get("eptTipo") || ""),
        gnatMeta: f.get("gnatMeta") || null,
        syncNote: String(f.get("syncNote") || ""),
        observaciones: Array.isArray(f.get("observaciones")) ? f.get("observaciones") : [],
        colorPersonalizado: String(f.get("colorPersonalizado") || "")
      };
    });
    return {
      version: 6,
      formato: "CentralityLocal",
      id: state.projectId,
      nombre: state.projectName,
      updatedAt: Date.now(),
      multiSupervisorEnabled: state.multiSupervisorEnabled,
      hiddenColumns: [...state.hiddenColumns],
      columnOrder: [...state.columnOrder],
      supervisors: [...state.supervisors.values()],
      statuses: [...state.statuses.values()],
      bloques: [...state.zones.values()].map(z => ({
        id: z.id,
        nombre: z.name,
        color: z.color,
        customRing: Array.isArray(z.customRing) ? z.customRing : null
      })),
      spans: state.spans,
      graphNodes: state.graphNodes,
      registros
    };
  }

  function pushUndoSnapshot(label = "Cambio") {
    try {
      const snap = serializeProjectPayload();
      state.undoStack.push({ label, snap });
      const UNDO_LIMIT = 200;
      if (state.undoStack.length > UNDO_LIMIT) {
        // El origen nunca se descarta: se tiene que poder volver hasta el principio.
        const origin = state.undoStack[0];
        state.undoStack = [origin, ...state.undoStack.slice(1 - UNDO_LIMIT)];
      }
    } catch (_) {}
  }

  function performUndo() {
    if (!state.undoStack.length) {
      showToast("No hay acciones recientes para deshacer.");
      return;
    }
    const last = state.undoStack.pop();
    loadProjectData(last.snap);
    showToast(`Deshecho: ${last.label}`);
  }

  function markDirty() {
    state.dirty = true;
    updateSaveIndicator("Guardando...");
    w.clearTimeout(autosaveTimer);
    autosaveTimer = w.setTimeout(() => {
      autosaveNow().catch(err => console.warn("Autosave error:", err));
    }, 450);
  }

  async function writeToBackupFolder(payload) {
    if (!state.backupDirHandle) return false;
    try {
      const perm = await state.backupDirHandle.queryPermission({ mode: "readwrite" });
      state.backupDirPerm = perm;
      if (perm !== "granted") return false;
      const safeName = state.projectName.replace(/[^a-zA-Z0-9._-]+/g, "_") || "proyecto";
      const fh = await state.backupDirHandle.getFileHandle(safeName + ".json", { create: true });
      const writable = await fh.createWritable();
      await writable.write(JSON.stringify(payload, null, 2));
      await writable.close();
      return true;
    } catch (_) {
      return false;
    }
  }

  async function autosaveNow() {
    const hasAnyData = state.points.length > 0 || [...state.zones.values()].some(z => Array.isArray(z.customRing) && z.customRing.length >= 3);
    if (!hasAnyData) {
      state.dirty = false;
      updateSaveIndicator("Sin datos");
      return;
    }
    const payload = serializeProjectPayload();
    await dbPutProject({
      id: state.projectId,
      name: state.projectName,
      updatedAt: payload.updatedAt,
      pointCount: payload.registros.length,
      zoneCount: payload.bloques.length,
      payload
    });
    const backedUp = await writeToBackupFolder(payload);
    state.dirty = false;
    updateSaveIndicator(backedUp ? `Guardado en ${state.backupDirHandle.name}` : "Guardado · solo navegador");
  }

  // =========================================================================
  // 5. MOTOR GNAT DMS (svc_wmc.php + Caché + Grafo MT A->B + Aperturas/Remates)
  // =========================================================================
  // Un código de GNAT empieza con letra. Sin esta guarda, un id interno numérico
  // (3985557) se parsea como código de poste y se muestra como tal (S12).
  const CODE_AT_START = /^([A-Z]{1,3}\d{3,12})\b/i;
  // Permite nodos de hasta 12 dígitos (ej. 467251498) y sufijos descriptivos
  const SPAN_PAIR_REGEX = /^([A-Z]{0,3}\d{3,12})\s*[-–]\s*([A-Z]{0,3}\d{3,12})\b/i;
  const COCI_3F_REGEX = /<td>\s*(\d+(?:\.\d+)?)\s*<\/td>\s*<td>\s*\d+(?:\.\d+)?\s*<\/td>\s*<td>\s*\d+(?:\.\d+)?\s*<\/td>\s*<td>\s*\d+(?:\.\d+)?\s*<\/td>/i;
  const REAL_STATE_REGEX = /<b>\s*Real:\s*<\/b>\s*([^<]+)/i;
  // Equipos de maniobra EN SERIE con línea MT (siempre cortan el grafo)
  const LINE_OPENING_REGEX = /\b(reconectador|seccionador|seccional|cuchill[ao]|interruptor|pole\s*top|bajo\s+carga|sin\s+carga|desconectador\s+(?:bajo\s+carga|sin\s+carga|tripolar|monopolar|en\s+aire|de\s+l[ií]nea|a[eé]reo)|\bddcc\b|\bdbc\b|\bdc\b|\brec\b|\brc\d*\b)/i;
  // Fusibles (pueden ser de arranque MT o de protección de transformador/SSEE)
  const FUSE_DEVICE_REGEX = /\b(desconectador\s+fusible|fusible|\bddff\b|\bdf\b)\b/i;
  const OPENING_DEVICE_REGEX = /\b(desconectador|fusible|seccionador|seccional|reconectador|cuchill[ao]|interruptor|pole\s*top|\bddff\b|\bddcc\b|\bdf\b|\bdbc\b|\bdc\b|\brec\b|\brc\d*\b)/i;
  const SSEE_CLASS_REGEX = /\b(subestaci[oó]n|ssee|transformador|\bsed\b)\b/i;
  const SSEE_BRACKET_TAG = /\[\s*F?\d{4,}\s*\]/i;
  const POLE_CLASS_REGEX = /\b(poste|soporte|apoyo|retenci[oó]n|ensamblado|estructura|torre|c\.a\.)\b/i;
  const EXCLUDE_NON_POLE_REGEX = /\b(medidor|punto de consumo|cliente|acometida|luminaria)\b/i;
  const BT_AP_SPAN_REGEX = /\b(tramo a[eé]reo ap|alumbrado|\bbt\b|baja tensi[oó]n|preensamblado\s+1x)\b/i;

  function gnatRequest(url, params, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!w.Acs?.request || !w.webMap_?.getViewportParams) {
        return reject(new Error("Sesión GNAT no disponible."));
      }
      let settled = false;
      const timer = w.setTimeout(() => {
        if (!settled) { settled = true; reject(new Error("Timeout GNAT")); }
      }, timeoutMs);
      try {
        w.Acs.request({
          url,
          params,
          success: (res) => {
            if (!settled) { settled = true; w.clearTimeout(timer); resolve(res?.data ?? res); }
          },
          failure: () => {
            if (!settled) { settled = true; w.clearTimeout(timer); reject(new Error("Fallo en consulta GNAT")); }
          }
        });
      } catch (e) {
        if (!settled) { settled = true; w.clearTimeout(timer); reject(e); }
      }
    });
  }

  function buildCandidateSearchQueries(rawCode) {
    const clean = String(rawCode || "").trim().toUpperCase().replace(/^Poste\s*N?[°º]?\s*/i, "");
    if (!clean) return [];
    if (!state.autoPrefixF) return [clean];
    if (/^\d+$/.test(clean)) return ["F" + clean, clean];
    if (/^F\d+$/.test(clean)) return [clean, "F" + clean, clean.slice(1)];
    return [clean, "F" + clean];
  }

  function parseSpanPair(display, typeStr = "", descStr = "") {
    const text = String(display || "").trim();
    const m = SPAN_PAIR_REGEX.exec(text);
    if (!m) return null;
    const a = m[1].toUpperCase();
    const b = m[2].toUpperCase();
    if (a === b) return null;
    const meta = `${text} ${typeStr} ${descStr}`;
    const isBtOrAp = BT_AP_SPAN_REGEX.test(meta) && !/\bMT\b|media tensi[oó]n/i.test(meta);
    return { from: a, to: b, voltage: isBtOrAp ? "bt" : "mt", display: `${a} - ${b}`, rawDisplay: text };
  }

  async function resolveCodeInGnat(rawCode, useCache = true, preferOpening = false, opts = {}) {
    const queries = buildCandidateSearchQueries(rawCode);
    const prefProt = String(opts?.preferredProt || "").toUpperCase();
    const nearLL = Array.isArray(opts?.nearLonLat) && opts.nearLonLat.length === 2 ? opts.nearLonLat : null;
    for (const q of queries) {
      if (useCache && !nearLL && !opts?.returnAllDevices) {
        const cacheKey = opts?.preferSsee ? `SE:${q}` : preferOpening ? `OP:${prefProt || "ANY"}:${q}` : q;
        const cached = await dbGetGnatCache(cacheKey);
        if (cached && Array.isArray(cached.lonlat) && cached.lonlat.length === 2) {
          return cached;
        }
      }
    }

    const wm = w.webMap_;
    const tried = new Set();
    for (const q of queries) {
      if (!q || tried.has(q)) continue;
      tried.add(q);
      let rows = [];
      try {
        const res = await gnatRequest("svc_wmc.php", w.Ext.apply({
          action: "textual_search",
          query: q,
          page: 1,
          start: 0,
          limit: 50
        }, wm.getViewportParams()));
        rows = Array.isArray(res) ? res : (Array.isArray(res?.rows) ? res.rows : []);
      } catch (_) { rows = []; }
      if (!rows.length) continue;

      const spansFromSearch = [];
      const exactMatches = [];
      const fallbackMatches = [];
      const devicesOnCode = [];
      const qEsc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const wordRe = new RegExp(`(^|[^A-Z0-9])${qEsc}([^A-Z0-9]|$)`, "i");

      for (const r of rows) {
        const disp = String(r?.display || "").trim();
        const span = parseSpanPair(disp);
        if (span && (span.from === q || span.to === q)) {
          spansFromSearch.push({ ...span, id: Number(r.surrogate_in_map_id || r.object_id) });
          continue;
        }
        if (EXCLUDE_NON_POLE_REGEX.test(disp)) continue;
        const m = CODE_AT_START.exec(disp);
        const token = m ? m[1].toUpperCase() : "";
        const isExactStart = token === q;
        const isWordHit = !isExactStart && wordRe.test(disp);
        if (!isExactStart && !isWordHit) continue;

        if (OPENING_DEVICE_REGEX.test(disp)) {
          devicesOnCode.push({
            objectId: Number(r.object_id),
            surrogateId: Number(r.surrogate_in_map_id || r.object_id),
            display: disp
          });
        }
        if (isExactStart) exactMatches.push(r);
        else fallbackMatches.push(r);
      }

      const candidates = exactMatches.length ? exactMatches : fallbackMatches;
      if (!candidates.length) continue;

      const openingCands = candidates.filter(c => OPENING_DEVICE_REGEX.test(c.display || "") && !POLE_CLASS_REGEX.test(c.display || ""));
      // Si es APERTURA (o se pidió desambiguar) y existen varios equipos con el mismo código (ej. FAL5870: DBC + RC + DF),
      // consultar sus geometrías en 1 solo lote para elegir por tipo declarado o por cercanía al clic/coordenada.
      if ((preferOpening || opts?.returnAllDevices) && openingCands.length > 1) {
        const idPairs = openingCands.map(c => ({ cand: c, id: Number(c.surrogate_in_map_id || c.object_id) })).filter(x => Number.isFinite(x.id) && x.id > 0);
        const resolvedDevs = [];
        for (const item of idPairs.slice(0, 6)) {
          try {
            const geo = await gnatRequest("svc_wmc.php", w.Ext.apply({
              action: "get_objects_geojson",
              object_ids: w.Ext.encode([item.id])
            }, wm.getViewportParams()));
            const feat = Array.isArray(geo?.features) ? geo.features[0] : (geo?.geometry ? geo : null);
            const pt = extractPointFromGeoJsonFeature(feat);
            if (!pt) continue;
            const disp = String(item.cand.display || q);
            resolvedDevs.push({
              code: q,
              lonlat: pt,
              display: disp,
              protId: mapProtectionFromText(disp),
              objectId: Number(item.cand.object_id),
              surrogateId: item.id,
              isOpeningDevice: true,
              isSsee: SSEE_CLASS_REGEX.test(disp),
              devices: devicesOnCode,
              spans: spansFromSearch
            });
          } catch (_) {}
        }

        if (resolvedDevs.length) {
          const lockedId = Number(opts?.lockedDeviceId || 0);
          let picked = lockedId ? (resolvedDevs.find(d => d.surrogateId === lockedId || d.objectId === lockedId) || null) : null;
          if (!picked && prefProt) {
            picked = resolvedDevs.find(d => d.protId === prefProt) || null;
          }
          if (!picked && nearLL) {
            const byDist = [...resolvedDevs].sort((a, b) => haversineMeters(nearLL, a.lonlat) - haversineMeters(nearLL, b.lonlat));
            picked = byDist[0];
          }
          if (!picked) picked = resolvedDevs[0];
          picked.allDevices = resolvedDevs;
          return picked;
        }
      }

      // Si es APERTURA, priorizar el equipo que calce con prefProt o cualquier equipo de maniobra; si no, Poste/SSEE
      candidates.sort((a, b) => {
        const score = (d) => {
          if (preferOpening) {
            if (prefProt && mapProtectionFromText(d) === prefProt) return 6;
            return OPENING_DEVICE_REGEX.test(d) && !POLE_CLASS_REGEX.test(d) ? 4 : POLE_CLASS_REGEX.test(d) ? 2 : SSEE_CLASS_REGEX.test(d) ? 1 : 0;
          }
          if (opts?.preferSsee) {
            return SSEE_CLASS_REGEX.test(d) ? 5 : OPENING_DEVICE_REGEX.test(d) ? 2 : POLE_CLASS_REGEX.test(d) ? 1 : 0;
          }
          return POLE_CLASS_REGEX.test(d) ? 3 : SSEE_CLASS_REGEX.test(d) ? 2 : OPENING_DEVICE_REGEX.test(d) ? 1 : 0;
        };
        return score(b.display || "") - score(a.display || "");
      });

      const resolvedEntries = [];
      for (const cand of candidates) {
        if (resolvedEntries.length >= 4) break;
        const idsToTry = [...new Set([Number(cand.surrogate_in_map_id), Number(cand.object_id)].filter(n => Number.isFinite(n) && n > 0))];
        for (const id of idsToTry) {
          try {
            const geo = await gnatRequest("svc_wmc.php", w.Ext.apply({
              action: "get_objects_geojson",
              object_ids: w.Ext.encode([id])
            }, wm.getViewportParams()));
            const feat = Array.isArray(geo?.features) ? geo.features[0] : (geo?.geometry ? geo : null);
            const pt = extractPointFromGeoJsonFeature(feat);
            if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
              const entry = {
                code: opts?.preferSsee ? `SE:${q}` : preferOpening ? `OP:${prefProt || "ANY"}:${q}` : q,
                rawCode: q,
                lonlat: pt,
                extraCoords: [],
                display: String(cand.display || q),
                protId: mapProtectionFromText(cand.display || ""),
                objectId: Number(cand.object_id),
                surrogateId: Number(cand.surrogate_in_map_id || id),
                isOpeningDevice: OPENING_DEVICE_REGEX.test(cand.display) && !POLE_CLASS_REGEX.test(cand.display),
                isSsee: SSEE_CLASS_REGEX.test(cand.display),
                devices: devicesOnCode,
                spans: spansFromSearch
              };
              await dbPutGnatCache(entry);
              entry.code = q;
              resolvedEntries.push(entry);
              break;
            }
          } catch (_) {}
        }
      }
      if (resolvedEntries.length) {
        // Un mismo código identifica VARIOS objetos. Se elige el más cercano al punto
        // que se está editando, no el primero que devuelve la búsqueda: una S/E con el
        // mismo código a 2 km no le gana a la que está al lado del poste (S8/S13).
        if (nearLL && resolvedEntries.length > 1) {
          resolvedEntries.sort((a, b) => haversineMeters(nearLL, a.lonlat) - haversineMeters(nearLL, b.lonlat));
        }
        return resolvedEntries[0];
      }
    }
    return null;
  }

  async function fetchSpanGeometriesBatch(spanIds) {
    const out = new Map();
    const ids = [...new Set(spanIds.map(Number).filter(n => Number.isFinite(n) && n > 0))];
    if (!ids.length) return out;
    const wm = w.webMap_;
    // Consultar en lotes de hasta 60 IDs por request (~0.6s por lote)
    for (let i = 0; i < ids.length; i += 60) {
      const chunk = ids.slice(i, i + 60);
      try {
        const geo = await gnatRequest("svc_wmc.php", w.Ext.apply({
          action: "get_objects_geojson",
          object_ids: w.Ext.encode(chunk)
        }, wm.getViewportParams()), 12000);
        const feats = Array.isArray(geo?.features) ? geo.features : (geo?.geometry ? [geo] : []);
        for (let fi = 0; fi < feats.length; fi++) {
          const ft = feats[fi];
          const g = ft?.geometry;
          let line = null;
          if (g?.type === "LineString" && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
            line = g.coordinates.map(c => [Number(c[0]), Number(c[1])]);
          } else if (g?.type === "MultiLineString" && Array.isArray(g.coordinates) && g.coordinates[0]?.length >= 2) {
            line = g.coordinates[0].map(c => [Number(c[0]), Number(c[1])]);
          }
          if (!line) continue;
          const fid = Number(ft.id || ft.properties?.object_id || ft.properties?.surrogate_in_map_id || chunk[fi] || 0);
          if (fid > 0) {
            out.set(fid, { coords: line, start: line[0], end: line[line.length - 1] });
          }
        }
      } catch (_) {}
    }
    return out;
  }

  // Descubre tramos MT, SSEE, COCI_3F y aparatos de línea en una punta de cable (1 request + caché IndexedDB v5)
  async function inspectPoleNeighborhoodInGnat(code, lonlat, extraCoords = [], useCache = true) {
    const cacheKey = `v8:${Number(lonlat[0]).toFixed(5)},${Number(lonlat[1]).toFixed(5)}`;
    if (useCache) {
      const cached = await dbGetGnatCache(cacheKey);
      if (cached && Array.isArray(cached.spans)) return cached;
    }

    const wm = w.webMap_;
    const spans = [];
    const lineDevices = [];
    const sseeList = [];
    let detectedPoleCode = "";
    let coci3f = null;
    const normCode = String(code || "").trim().toUpperCase();

    const probePoints = [lonlat, ...(Array.isArray(extraCoords) ? extraCoords.slice(0, 1) : [])];
    const queryPoint = async (pt, upp) => {
      try {
        const params = w.Ext.apply({
          action: "get_objects_info_for_point",
          lonlat: w.Ext.encode({ lon: Number(pt[0]), lat: Number(pt[1]) })
        }, wm.getViewportParams());
        params.scale = 250;
        params.units_per_pixel = upp;
        const res = await gnatRequest("svc_wmc.php", params);
        return Array.isArray(res) ? res : [];
      } catch (_) { return []; }
    };

    let allItems = [];
    for (const pt of probePoints) {
      const res = await queryPoint(pt, 3.2);
      allItems.push(...res);
    }

    const parseItems = (items) => {
      let hasSseeHere = sseeList.length > 0;
      for (const it of items) {
        const disp = String(it.display || "").trim();
        const desc = String(it.description || "");
        const fullText = `${disp} ${it.type || ""} ${desc}`;
        if (coci3f === null) {
          const cm = COCI_3F_REGEX.exec(desc);
          if (cm) coci3f = Number(cm[1]);
        }
        if (SSEE_CLASS_REGEX.test(fullText)) {
          hasSseeHere = true;
          const sm = CODE_AT_START.exec(disp);
          const sseeCode = sm ? sm[1].toUpperCase() : disp;
          if (sseeCode && !sseeList.includes(sseeCode)) sseeList.push(sseeCode);
        }
        if (POLE_CLASS_REGEX.test(fullText) && !EXCLUDE_NON_POLE_REGEX.test(fullText)) {
          const pm = CODE_AT_START.exec(disp);
          if (pm) {
            const candCode = pm[1].toUpperCase();
            // Priorizar siempre códigos alfanuméricos de poste (ej. FAB6532, F723319) sobre IDs numéricos puros
            const candHasAlpha = /^[A-Z]/.test(candCode);
            const curHasAlpha = /^[A-Z]/.test(detectedPoleCode);
            if (!detectedPoleCode || (candHasAlpha && !curHasAlpha)) {
              detectedPoleCode = candCode;
            }
          }
        }
      }

      for (const it of items) {
        const disp = String(it.display || "").trim();
        const desc = String(it.description || "");
        const fullText = `${disp} ${it.type || ""} ${desc}`;
        const sp = parseSpanPair(disp, it.type, desc);
        if (sp && sp.voltage === "mt") {
          if (!spans.some(x => x.display === sp.display)) {
            spans.push({ ...sp, id: Number(it.id) });
          }
          continue;
        }
        const isLineOp = LINE_OPENING_REGEX.test(fullText);
        const isFuse = FUSE_DEVICE_REGEX.test(fullText);
        const isTrafoFuse = isFuse && (SSEE_BRACKET_TAG.test(disp) || hasSseeHere);
        if (isLineOp || (isFuse && !isTrafoFuse)) {
          const m = CODE_AT_START.exec(disp);
          const devCode = m ? m[1].toUpperCase() : (normCode || detectedPoleCode);
          const realM = REAL_STATE_REGEX.exec(desc);
          if (!lineDevices.some(d => d.id === Number(it.id))) {
            lineDevices.push({
              id: Number(it.id),
              code: devCode,
              type: String(it.type || "Equipo de apertura MT"),
              display: disp || devCode,
              isLineSeries: isLineOp,
              realState: realM ? realM[1].trim() : ""
            });
          }
        }
      }
    };

    parseItems(allItems);
    const hasFuseOrSseeHere = sseeList.length > 0 || allItems.some(it => FUSE_DEVICE_REGEX.test(`${it.display || ""} ${it.type || ""}`));
    const hasAlphaPole = /^[A-Z]/.test(detectedPoleCode);
    if (spans.length <= 1 || !hasAlphaPole || (hasFuseOrSseeHere && spans.length < 3)) {
      const wider = await queryPoint(lonlat, 7.0);
      parseItems(wider);
    }
    const result = { code: cacheKey, spans, devices: lineDevices, sseeList, detectedPoleCode, coci3f };
    if (useCache && (spans.length > 0 || detectedPoleCode || lineDevices.length > 0)) {
      await dbPutGnatCache(result);
    }
    return result;
  }

  // =========================================================================
  // 6. SHELL DOM AISLADO (SHADOW DOM) + ESTILOS DESIGN SYSTEM
  // =========================================================================
  const host = doc.createElement("div");
  host.id = "centrality-v10-host";
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
  doc.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = doc.createElement("style");
  styleEl.textContent = window.__C_STYLES || "";
  shadow.appendChild(styleEl);

  const root = doc.createElement("div");
  shadow.appendChild(root);

  const el = (tag, cls, text, parent = root) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  };

  // =========================================================================
  // 7. CONSTRUCCIÓN DE LA INTERFAZ (3 ZONAS)
  // =========================================================================
  const topbar = el("header", "topbar");
  const topLeft = el("div", "topbar-left", null, topbar);
  const topRight = el("div", "topbar-right", null, topbar);

  const btnArchivo = el("button", "btn-outline", "", topLeft);
  setBtn(btnArchivo, "folder", "Archivo", 14, true);
  btnArchivo.title = "Proyectos, importar tabla Excel/KMZ/CSV, exportar y carpeta de respaldo";

  const projNameInput = el("input", "proj-name", null, topLeft);
  projNameInput.type = "text";
  projNameInput.value = state.projectName;
  projNameInput.title = "Nombre del proyecto (clic para renombrar)";
  projNameInput.addEventListener("change", () => {
    state.projectName = projNameInput.value.trim() || "Proyecto sin título";
    projNameInput.value = state.projectName;
    markDirty();
  });

  const saveBadge = el("span", "save-badge", "", topLeft);
  saveBadge.innerHTML = '<span class="save-dot"></span><span>Sin datos</span>';
  saveBadge.title = "Autoguardado: solo en este navegador (IndexedDB); no se escribe ningun archivo en disco.";
  saveBadge.onclick = () => autosaveNow();
  el("div", "divider", null, topLeft);

  const btnZonas = el("button", "btn-outline", "", topLeft);
  setBtn(btnZonas, "layers", "Zonas", 14, true);
  btnZonas.title = "Administrar zonas (D / T / F / personalizadas) y sus polígonos";

  const btnVista = el("button", "btn-outline", "", topLeft);
  setBtn(btnVista, "eye", "Vista", 14, true);
  btnVista.title = "Capas visuales, pines de postes (H), etiquetas y detalle WMTS (+1/+2/+3)";

  const btnRedMt = el("button", "btn-outline", "", topLeft);
  setBtn(btnRedMt, "zap", "Red MT", 14, true);
  btnRedMt.title = "Analizar red MT, sincronizar seleccionados con GNAT o limpiar tramos";
  const btnAnalyzeMt = btnRedMt; // alias de compatibilidad

  const toggleHidePoles = () => {
    state.hidePoles = !state.hidePoles;
    rebuildOverlayLayers();
    showToast(state.hidePoles ? "Pines de postes ocultos (pulsa H para mostrar)." : "Pines de postes visibles.");
  };

  const btnFitAll = el("button", "btn-outline icon-btn", "", topRight);
  setBtn(btnFitAll, "maximize", "", 14);
  btnFitAll.title = "Encuadrar elementos visibles";
  btnFitAll.setAttribute("aria-label", "Encuadrar elementos visibles");
  btnFitAll.onclick = () => {
    const vis = getFilteredPoints().map(f => state.points.indexOf(f));
    if (vis.length) fitPoints(vis);
  };

  const btnToggleDrawer = el("button", "active-pill", "", topRight);
  setBtn(btnToggleDrawer, "table", "Tabla", 14);
  const btnCollapse = el("button", "btn-outline icon-btn", "", topRight);
  setBtn(btnCollapse, "minus", "", 14);
  btnCollapse.setAttribute("aria-label", "Minimizar panel");
  const btnClose = el("button", "btn-outline icon-btn", "", topRight);
  setBtn(btnClose, "x", "", 14);
  btnClose.setAttribute("aria-label", "Cerrar Centrality Local");

  // DOCK INFERIOR
  const dock = el("div", "dock");
  const btnModeNav = el("button", "active", "", dock);
  setBtn(btnModeNav, "cursor", "Navegar", 13);
  const btnModeBox = el("button", "", "", dock);
  setBtn(btnModeBox, "boxSelect", "Área", 13);
  const btnModeAdd = el("button", "", "", dock);
  setBtn(btnModeAdd, "plus", "Agregar", 13);
  const btnModePoly = el("button", "", "", dock);
  setBtn(btnModePoly, "polygon", "Polígono", 13);
  btnModePoly.title = "Arrastrar vértices de polígonos D/T/F (oculta o ignora pines de postes al arrastrar)";

  // CAJÓN LATERAL
  const drawer = el("aside", "drawer");
  const drawerHead = el("div", "drawer-head", null, drawer);
  const searchRow = el("div", "search-row", null, drawerHead);

  const searchBox = el("div", "search-box", null, searchRow);
  const sIco = el("span", "", "", searchBox); sIco.innerHTML = iconHtml("search", 14); sIco.style.color = "#64748B";
  const searchInput = el("input", "", null, searchBox);
  searchInput.type = "search";
  searchInput.placeholder = "Filtrar, pegar columna Excel o Enter (GNAT)...";
  searchInput.title = "Filtra por código GNAT o terreno, pega varios códigos desde Excel, o presiona Enter para buscar en GNAT";
  searchInput.addEventListener("paste", (ev) => {
    const txt = ev.clipboardData?.getData("text") || "";
    if (/[\r\n\t]/.test(txt)) {
      ev.preventDefault();
      const cleaned = txt.split(/[\r\n\t]+/).map(s => s.trim()).filter(Boolean).join(" ");
      searchInput.value = cleaned;
      state.search = cleaned;
      refreshAll();
    }
  });

  const btnPinF = el("button", "pin-f on", "F", searchRow);
  btnPinF.title = "Autocompletar prefijo 'F' (Frontel) en búsquedas de postes (activo)";
  btnPinF.onclick = () => {
    state.autoPrefixF = !state.autoPrefixF;
    btnPinF.classList.toggle("on", state.autoPrefixF);
    showToast(state.autoPrefixF ? "Prefijo automático 'F' (Frontel) activado." : "Prefijo automático 'F' desactivado.");
  };

  const stepper = el("div", "stepper", null, searchRow);
  const btnPrev = el("button", "", "◀", stepper);
  const stepLabel = el("span", "", "0/0", stepper);
  const btnNext = el("button", "", "▶", stepper);

  const searchMissingNote = el("div", "search-missing-note hidden", null, drawerHead);
  const filterChips = el("div", "filter-chips", null, drawerHead);
  const syncQueueBar = el("div", "sync-queue-bar hidden", null, drawer);
  const tableWrap = el("div", "table-wrap", null, drawer);
  tableWrap.tabIndex = 0;
  const table = el("table", "", null, tableWrap);
  const colgroup = el("colgroup", "", null, table);
  const thead = el("thead", "", null, table);
  const tbody = el("tbody", "", null, table);
  const ctxBar = el("div", "ctx-bar hidden", null, drawer);

  const modeBanner = el("div", "mode-banner hidden");
  const modeBannerText = el("span", "", "", modeBanner);
  const modeBannerAction = el("button", "", "Terminar (Esc)", modeBanner);
  modeBannerAction.style.cssText = "background:rgba(255,255,255,0.22);color:#fff;padding:3px 9px;font-size:11px;";

  const toastEl = el("div", "toast");
  const modalBackdrop = el("div", "modal-backdrop hidden");
  const fab = el("button", "fab hidden", "☰");

  const hiddenFileInput = el("input", "", null, root);
  hiddenFileInput.type = "file";
  hiddenFileInput.accept = ".kmz,.kml,.json,.csv";
  hiddenFileInput.style.display = "none";

  function updateSaveIndicator(txt) {
    const clean = String(txt || "").replace(/^✓\s*/, "");
    saveBadge.innerHTML = `<span class="save-dot"></span><span>${clean}</span>`;
    saveBadge.classList.toggle("dirty", state.dirty);
    // Que se vea DONDE guarda, no solo que guardo.
    const destino = state.backupDirHandle
      ? `carpeta "${state.backupDirHandle.name}" (${state.projectName}.json) y en este navegador`
      : "solo en este navegador (IndexedDB); no se escribe ningun archivo en disco";
    saveBadge.title = `Autoguardado: ${destino}. Clic para guardar ahora.`;
  }

  let toastTimer = null;
  function showToast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.className = "toast show" + (isError ? " err" : "");
    w.clearTimeout(toastTimer);
    toastTimer = w.setTimeout(() => toastEl.classList.remove("show"), 3600);
  }

  var activePopoverPos = null;
  var popoverAnchor = null;      // lo setea el llamador justo antes de abrir
  var activePopoverAnchor = null;
  var popoverKey = null;         // clave estable de categoría ('zones', 'supervisors', ...)
  var activePopoverKey = null;
  var lastMouseDownTarget = null; // disparador del click en curso, capturado antes del popover

  function closePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
    activePopoverPos = null;
    activePopoverAnchor = null;
    activePopoverKey = null;
  }

  function syncLayoutToMapViewport() {
    if (!viewportEl) return;
    const rect = viewportEl.getBoundingClientRect();
    if (!rect || rect.width < 120 || rect.height < 120) return;
    const pad = 8;
    const leftPx = Math.max(pad, Math.round(rect.left) + pad);
    const rightGap = Math.max(pad, Math.round(w.innerWidth - rect.right) + pad);
    const topPx = Math.max(pad, Math.round(rect.top) + pad);
    // Detectar el buscador nativo de GNAT arriba a la derecha para no superponerlo nunca
    let gnatSearchLeft = rect.right - 295;
    try {
      const searchInputs = w.document.querySelectorAll('input[placeholder*="Buscar" i], input[placeholder*="Search" i]');
      for (const inp of searchInputs) {
        const sr = inp.getBoundingClientRect();
        if (sr && sr.width > 80 && sr.top >= rect.top - 10 && sr.top <= rect.top + 80 && sr.left > rect.left + 200) {
          // Subir al contenedor redondeado del buscador si existe
          const box = inp.closest('.x-form-trigger-wrap, .x-field, .x-box-inner') || inp;
          const br = box.getBoundingClientRect();
          gnatSearchLeft = Math.min(gnatSearchLeft, Math.round((br?.left || sr.left) - 14));
        }
      }
    } catch (_) {}
    const maxBarW = Math.max(280, Math.round(gnatSearchLeft - leftPx));

    // El desplegable del buscador nativo (ExtJS) crece hacia abajo y quedaba
    // tapado por el panel. Si está abierto, el panel arranca debajo suyo: se
    // desplaza y se achica, en vez de esconder los resultados de GNAT.
    let gnatDropBottom = 0;
    try {
      for (const bl of w.document.querySelectorAll('.x-boundlist')) {
        const br = bl.getBoundingClientRect();
        if (br.height > 40 && br.width > 120 && br.top < rect.top + 320 && br.right > rect.left + 200) {
          gnatDropBottom = Math.max(gnatDropBottom, Math.round(br.bottom));
        }
      }
    } catch (_) {}

    topbar.style.left = `${leftPx}px`;
    topbar.style.width = "auto";
    topbar.style.maxWidth = `${maxBarW}px`;
    topbar.style.top = `${topPx}px`;

    drawer.style.top = `${Math.max(topPx + 46, gnatDropBottom > 0 ? gnatDropBottom + 8 : 0)}px`;
    drawer.style.right = `${rightGap}px`;
    drawer.style.bottom = `${Math.max(12, Math.round(w.innerHeight - rect.bottom) + 12)}px`;

    const drawerW = (state.drawerOpen && !state.collapsed) ? 358 : 0;
    const freeLeft = rect.left + pad;
    const freeRight = Math.max(freeLeft + 260, rect.right - drawerW - pad);
    const centerX = Math.round((freeLeft + freeRight) / 2);
    dock.style.left = `${centerX}px`;
    dock.style.bottom = `${Math.max(14, Math.round(w.innerHeight - rect.bottom) + 14)}px`;
    modeBanner.style.left = `${centerX}px`;
    modeBanner.style.top = `${topPx + 46}px`;
    toastEl.style.left = `${centerX}px`;
  }

  try {
    const ro = new w.ResizeObserver(() => syncLayoutToMapViewport());
    if (viewportEl) ro.observe(viewportEl);
    ro.observe(doc.body);
    map.on?.("change:size", syncLayoutToMapViewport);
  } catch (_) {}
  w.addEventListener("resize", syncLayoutToMapViewport);
  w.setInterval(syncLayoutToMapViewport, 900);
  w.setTimeout(syncLayoutToMapViewport, 80);

  // =========================================================================
  // 8. CAPAS OPENLAYERS: PUNTOS, VECTORES MT (A->B), POLÍGONOS EDITABLES D/T/F
  // =========================================================================
  function getFilteredPoints() {
    const rawQ = state.search.trim();
    const tokens = rawQ ? rawQ.split(/[\s,;|\t\r\n]+/).map(s => s.trim()).filter(Boolean) : [];
    const isMultiToken = tokens.length >= 2;
    const matchedTokens = new Set();

    const matchesToken = (f, tok) => {
      // Un solo predicado para uno o varios términos. Antes el caso multi-palabra
      // ignoraba supervisor, estado y zona, y el de una palabra no incluía las
      // iniciales: "cesar castro" y "cc" no encontraban nada. Se compara sin tildes
      // ni mayúsculas, así "tomas" encuentra a "Tomás" y "cesar" a "César".
      const fold = (v) => CAT.foldText(v);
      const t = fold(tok);
      if (!t) return true;
      const tF = state.autoPrefixF && /^\d+$/.test(t) ? "f" + t : t;
      const supId = getSupId(f);
      const supObj = state.supervisors.get(supId) || {};
      const haystack = [
        f.get("numero"),
        getPointCode(f),
        f.get("codigoTerreno"),
        getPointZoneIds(f).join(" "),
        f.get("tipoEquipo"),
        f.get("rolPT"),
        state.statuses.get(f.get("estadoEjec") || "pendiente")?.name,
        supObj.name,
        supObj.initials,
        supId
      ].map(fold).join(" ");
      return haystack.includes(t) || (tF !== t && haystack.includes(tF));
    };

    const out = state.points.filter(f => {
      if (state.filterTypes.size > 0) {
        const isAp = (f.get("tipo") || "PUNTO") === "APERTURA";
        const isRem = Boolean(f.get("esRemate"));
        const isPoste = !isAp && !isRem;
        const ok = (state.filterTypes.has("APERTURA") && isAp)
          || (state.filterTypes.has("REMATE") && isRem)
          || (state.filterTypes.has("PUNTO") && (isPoste || isRem));
        if (!ok) return false;
      }
      // Visibilidad de Zonas (por exclusión: todas visibles salvo las que están en hiddenZones)
      if (state.hiddenZones.size > 0) {
        const zids = getPointZoneIds(f);
        if (zids.length === 0) {
          if (state.hiddenZones.has("__NONE__")) return false;
        } else {
          if (zids.every(z => state.hiddenZones.has(z))) return false;
        }
      }
      // Visibilidad de Estados
      if (state.hiddenStatuses.size > 0) {
        const stId = String(f.get("estadoEjec") || "pendiente");
        if (state.hiddenStatuses.has(stId)) return false;
      }
      if (state.filterSups.size > 0 && !state.filterSups.has(getSupId(f))) return false;
      if (tokens.length > 0) {
        let anyHit = false;
        for (const tok of tokens) {
          if (matchesToken(f, tok)) {
            matchedTokens.add(tok.toUpperCase());
            anyHit = true;
          }
        }
        if (!anyHit) return false;
      }
      return true;
    });

    state.lastSearchMissing = isMultiToken
      ? [...new Set(tokens.map(t => t.toUpperCase()).filter(t => !matchedTokens.has(t)))]
      : [];
    return out;
  }

  function pointStyleFn(f, resolution) {
    if (state.hidePoles) return null;
    const visibleSet = pointStyleFn._visibleSet;
    if (visibleSet && !visibleSet.has(f)) return null;

    const idx = state.points.indexOf(f);
    const isOpening = f.get("tipo") === "APERTURA";
    const isRemate = Boolean(f.get("esRemate"));
    const isIntermedio = Boolean(f.get("esIntermedio")) && !isOpening && !isRemate && !f.get("rolPT");
    const isFocused = state.focused === idx;
    const isSelected = state.selected.has(idx);
    const isLinkedPeer = pointStyleFn._linkedSet?.has(f) || false;
    const color = isRemate ? "#7C3AED" : isIntermedio ? "#64748B" : getPointColor(f);
    const rolPT = String(f.get("rolPT") || "").trim();
    const showText = isIntermedio
      ? (isFocused || isSelected)
      : (state.labelMode === "siempre" || isFocused || isLinkedPeer || isRemate ||
         (state.labelMode === "cerca" && resolution < UMBRAL_ETIQUETA));
    const key = `${color}|${isOpening}|${isRemate}|${isIntermedio}|${isFocused}|${isSelected}|${isLinkedPeer}|${showText}|${state.labelContent}|${rolPT}`;

    let cache = styleCache.get(f);
    if (!cache) {
      cache = new Map();
      styleCache.set(f, cache);
    }
    if (cache.has(key)) return cache.get(key);

    let labelStr = isRemate
      ? `▲ ${getPointCode(f)}`
      : state.labelContent === "completo"
        ? `${rolPT || f.get("numero")} · ${getPointCode(f)}`
        : String(rolPT || f.get("numero"));

    const openRad = isFocused ? 14 : (isSelected || isLinkedPeer) ? 12 : 10;
    const openW = isFocused || isLinkedPeer ? 5 : 4;
    const mainStyle = new ol.style.Style({
      image: isOpening
        ? new ol.style.RegularShape({
            points: 4,
            radius: openRad,
            radius2: 0,
            angle: Math.PI / 4,
            stroke: new ol.style.Stroke({
              color,
              width: openW
            })
          })
        : isRemate
          ? new ol.style.RegularShape({
              points: 3,
              radius: isFocused ? 11 : 9,
              fill: new ol.style.Fill({ color }),
              stroke: new ol.style.Stroke({ color: "#FFFFFF", width: 2.5 })
            })
          : new ol.style.Circle({
              radius: isFocused ? 10.5 : (isSelected || isLinkedPeer) ? 9 : isIntermedio ? 4.5 : 7,
              fill: new ol.style.Fill({ color }),
              stroke: new ol.style.Stroke({
                color: isSelected ? "#1D4ED8" : isFocused ? "#0F172A" : isLinkedPeer ? "#DC2626" : "#FFFFFF",
                width: isSelected || isFocused || isLinkedPeer ? 3 : isIntermedio ? 1.5 : 2
              })
            }),
      text: showText ? new ol.style.Text({
        text: labelStr,
        font: "700 12px Arial,sans-serif",
        offsetY: isFocused ? -22 : -18,
        fill: new ol.style.Fill({ color: "#FFFFFF" }),
        stroke: new ol.style.Stroke({ color: "#0F172A", width: 3.5 })
      }) : undefined,
      zIndex: isFocused ? 100 : isLinkedPeer ? 80 : isSelected ? 50 : 10
    });
    const finalStyle = (isOpening && isSelected)
      ? [
          new ol.style.Style({
            image: new ol.style.RegularShape({
              points: 4,
              radius: openRad + 2,
              radius2: 0,
              angle: Math.PI / 4,
              stroke: new ol.style.Stroke({ color: "#1D4ED8", width: openW + 4.5 })
            })
          }),
          mainStyle
        ]
      : mainStyle;
    cache.set(key, finalStyle);
    return finalStyle;
  }

  function convexHullLonLat(lonLatPairs) {
    if (lonLatPairs.length < 3) return lonLatPairs.slice();
    const pts = lonLatPairs.slice().sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    // Expandir un pequeño margen visual (~14 metros) alrededor de los postes para que el polígono envuelva limpio
    if (lower.length + upper.length >= 3) {
      const ring = lower.concat(upper);
      const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      return ring.map(p => {
        const dx = p[0] - cx, dy = p[1] - cy;
        const dist = Math.hypot(dx, dy) || 1;
        return [Number((p[0] + (dx / dist) * 0.00014).toFixed(7)), Number((p[1] + (dy / dist) * 0.00012).toFixed(7))];
      });
    }
    return lower.concat(upper);
  }

  function getZoneRingLonLat(zoneId) {
    const z = state.zones.get(zoneId);
    if (!z) return null;
    if (Array.isArray(z.customRing) && z.customRing.length >= 3) {
      return z.customRing;
    }
    const proj = map.getView().getProjection();
    const zPts = state.points
      .filter(f => getPointZoneIds(f).includes(zoneId))
      .map(f => ol.proj.toLonLat(f.getGeometry().getCoordinates(), proj));
    if (zPts.length < 3) return null;
    return convexHullLonLat(zPts);
  }

  function generateZonePolygonFromPoints(zoneId) {
    const z = state.zones.get(zoneId);
    if (!z) return false;
    const proj = map.getView().getProjection();
    const zPts = state.points
      .filter(f => getPointZoneIds(f).includes(zoneId))
      .map(f => ol.proj.toLonLat(f.getGeometry().getCoordinates(), proj));
    if (zoneId === "D" && Array.isArray(state.graphNodes)) {
      for (const gn of state.graphNodes) {
        if (Array.isArray(gn.lonlat) && gn.lonlat.length === 2) zPts.push(gn.lonlat);
      }
    }
    if (zPts.length < 3) {
      showToast(`La zona "${z.name}" necesita al menos 3 puntos para autogenerar polígono (o dibújalo a mano).`, true);
      return false;
    }
    z.customRing = convexHullLonLat(zPts);
    markDirty();
    rebuildOverlayLayers();
    showToast(`Polígono de "${z.name}" generado y listo para editar.`);
    return true;
  }

  // S14: pintar el área y filtrar los puntos son dos decisiones distintas. `hiddenZones`
  // decide qué puntos pasan; `hiddenZoneAreas` decide qué relleno se pinta. Puro a
  // propósito: recibe sólo lo que necesita, y no puede ver el filtro de puntos.
  function isZoneAreaPainted(showHulls, hiddenAreas, zoneId) {
    return Boolean(showHulls) && !hiddenAreas.has(zoneId);
  }

  function rebuildOverlayLayers() {
    const visible = getFilteredPoints();
    pointStyleFn._visibleSet = new Set(visible);
    const proj = map.getView().getProjection();

    const focusedFeat = state.points[state.focused];
    const linkedPeers = focusedFeat
      ? (focusedFeat.get("tipo") === "APERTURA"
          ? getLinkedPostesForOpening(focusedFeat)
          : getLinkedOpeningsForPoste(focusedFeat))
      : [];
    pointStyleFn._linkedSet = new Set(linkedPeers);

    if (hullLayer) { map.removeLayer(hullLayer); hullLayer = null; }
    if (spanLayer) { map.removeLayer(spanLayer); spanLayer = null; }
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    if (linkLayer) { map.removeLayer(linkLayer); linkLayer = null; }

    // 1. Polígonos D / T / F + Vértices de edición nativos
    if (state.showHulls && ol.geom?.Polygon) {
      const hullFeatures = [];
      // Una zona se dibuja sólo si no está oculta y, cuando tiene puntos, si al
      // menos uno sobrevive a los filtros: ocultar las ejecutadas tiene que
      // ocultar también el polígono de su zona, no sólo los pines.
      const zonesWithPoints = new Set();
      const zonesVisible = new Set();
      for (const f of state.points) for (const zid of getPointZoneIds(f)) zonesWithPoints.add(zid);
      for (const f of visible) for (const zid of getPointZoneIds(f)) zonesVisible.add(zid);
      for (const z of state.zones.values()) {
        if (state.filterZones.size > 0 && !state.filterZones.has(z.id)) continue;
        if (state.hiddenZones.has(z.id)) continue;
        // El área apagada sólo apaga el relleno: los puntos de la zona siguen ahí.
        if (!isZoneAreaPainted(state.showHulls, state.hiddenZoneAreas, z.id)) continue;
        if (zonesWithPoints.has(z.id) && !zonesVisible.has(z.id)) continue;
        const ringLonLat = getZoneRingLonLat(z.id);
        if (!ringLonLat || ringLonLat.length < 3) continue;

        const mapRing = ringLonLat.map(pt => ol.proj.fromLonLat([Number(pt[0]), Number(pt[1])], proj));
        mapRing.push(mapRing[0]);
        const hf = new ol.Feature({ geometry: new ol.geom.Polygon([mapRing]), zoneId: z.id });

        const isEditingThis = (state.cursorMode === "edit-poly") && (!state.editingZoneId || state.editingZoneId === z.id);
        const styles = [
          new ol.style.Style({
            fill: new ol.style.Fill({ color: hexToRgba(z.color, isEditingThis ? 0.18 : 0.12) }),
            stroke: new ol.style.Stroke({
              color: z.color,
              width: isEditingThis ? 3 : 2.2,
              lineDash: z.id === "D" ? [8, 5] : undefined
            }),
            text: new ol.style.Text({
              text: z.name || z.id,
              font: "700 13px Arial,sans-serif",
              fill: new ol.style.Fill({ color: z.color }),
              stroke: new ol.style.Stroke({ color: "#FFFFFF", width: 4 })
            })
          })
        ];

        // Dibujar manillas de vértices blancos y puntos medios azules cuando estamos editando polígonos
        if (isEditingThis) {
          for (let i = 0; i < mapRing.length - 1; i++) {
            const curr = mapRing[i];
            const next = mapRing[i + 1];
            const vStyle = new ol.style.Style({
              geometry: new ol.geom.Point(curr),
              image: new ol.style.Circle({
                radius: 7,
                fill: new ol.style.Fill({ color: "#FFFFFF" }),
                stroke: new ol.style.Stroke({ color: z.color, width: 3 })
              }),
              zIndex: 200
            });
            styles.push(vStyle);

            // Punto medio para insertar un nuevo vértice arrastrando
            const mid = [(curr[0] + next[0]) / 2, (curr[1] + next[1]) / 2];
            const mStyle = new ol.style.Style({
              geometry: new ol.geom.Point(mid),
              image: new ol.style.Circle({
                radius: 4.5,
                fill: new ol.style.Fill({ color: z.color }),
                stroke: new ol.style.Stroke({ color: "#FFFFFF", width: 1.5 })
              }),
              zIndex: 190
            });
            styles.push(mStyle);
          }
        }

        hf.setStyle(styles);
        hullFeatures.push(hf);
      }

      // Si está dibujando un polígono nuevo, mostrar vista previa
      if (state.cursorMode === "draw-poly" && state.drawingCoords.length > 0) {
        const z = state.zones.get(state.editingZoneId) || { color: "#1D4ED8" };
        const ptsMap = state.drawingCoords.map(c => ol.proj.fromLonLat(c, proj));
        if (ptsMap.length >= 2 && ol.geom?.LineString) {
          const lf = new ol.Feature({ geometry: new ol.geom.LineString([...ptsMap, ptsMap[0]]) });
          lf.setStyle(new ol.style.Style({
            stroke: new ol.style.Stroke({ color: z.color, width: 2.5, lineDash: [5, 5] })
          }));
          hullFeatures.push(lf);
        }
        for (const pm of ptsMap) {
          const pf = new ol.Feature({ geometry: new ol.geom.Point(pm) });
          pf.setStyle(new ol.style.Style({
            image: new ol.style.Circle({
              radius: 6,
              fill: new ol.style.Fill({ color: "#FFFFFF" }),
              stroke: new ol.style.Stroke({ color: z.color, width: 3 })
            })
          }));
          hullFeatures.push(pf);
        }
      }

      if (hullFeatures.length) {
        hullLayer = new ol.layer.Vector({
          source: new ol.source.Vector({ features: hullFeatures }),
          zIndex: 99996
        });
        map.addLayer(hullLayer);
      }
    }

    // 2. Vectores de tramos MT (A->B) descubiertos en GNAT
    if (state.showSpans && state.spans.length > 0 && ol.geom?.LineString) {
      const spanFeats = [];
      for (const sp of state.spans) {
        if (!Array.isArray(sp.coords) || sp.coords.length < 2) continue;
        const mapCoords = sp.coords.map(c => ol.proj.fromLonLat([Number(c[0]), Number(c[1])], proj));
        const sf = new ol.Feature({ geometry: new ol.geom.LineString(mapCoords), spanLabel: sp.display || `${sp.from}-${sp.to}` });
        sf.setStyle((feat, res) => {
          const wide = res > 15 ? 1.55 : res > 6 ? 1.25 : 1.0;
          return [
            new ol.style.Style({
              stroke: new ol.style.Stroke({ color: "rgba(255,255,255,0.9)", width: 6.5 * wide, lineCap: "round", lineJoin: "round" })
            }),
            new ol.style.Style({
              stroke: new ol.style.Stroke({ color: "#DC2626", width: 3.8 * wide, lineCap: "round", lineJoin: "round" }),
              text: state.labelMode === "siempre" ? new ol.style.Text({
                text: feat.get("spanLabel"),
                font: "600 10px Arial",
                fill: new ol.style.Fill({ color: "#991B1B" }),
                stroke: new ol.style.Stroke({ color: "#FFFFFF", width: 3 })
              }) : undefined
            })
          ];
        });
        spanFeats.push(sf);
      }
      if (!state.hidePoles && Array.isArray(state.graphNodes)) {
        const ptCodes = new Set(state.points.map(p => getPointCode(p).toUpperCase()));
        for (const gn of state.graphNodes) {
          if (!Array.isArray(gn.lonlat) || ptCodes.has(gn.code)) continue;
          const nf = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat(gn.lonlat, proj)) });
          nf.setStyle(new ol.style.Style({
            image: new ol.style.Circle({
              radius: 2.6,
              fill: new ol.style.Fill({ color: "#475569" }),
              stroke: new ol.style.Stroke({ color: "#FFFFFF", width: 1 })
            })
          }));
          spanFeats.push(nf);
        }
      }
      if (spanFeats.length) {
        spanLayer = new ol.layer.Vector({
          source: new ol.source.Vector({ features: spanFeats }),
          zIndex: 99997
        });
        map.addLayer(spanLayer);
      }
    }

    // 3. Línea secuencial de ruta (1->2->3)
    if (state.showRoute && ol.geom?.LineString) {
      const routePts = visible
        .filter(f => (f.get("tipo") || "PUNTO") === "PUNTO")
        .slice()
        .sort((a, b) => Number(a.get("numero")) - Number(b.get("numero")));
      if (routePts.length >= 2) {
        const coords = routePts.map(f => f.getGeometry().getCoordinates().slice(0, 2));
        const rf = new ol.Feature({ geometry: new ol.geom.LineString(coords) });
        rf.setStyle(new ol.style.Style({
          stroke: new ol.style.Stroke({ color: "#1D4ED8", width: 2.5, lineDash: [8, 6] })
        }));
        routeLayer = new ol.layer.Vector({
          source: new ol.source.Vector({ features: [rf] }),
          zIndex: 99998
        });
        map.addLayer(routeLayer);
      }
    }

    // 4. Rayos entre poste enfocado y sus aperturas vinculadas
    if (state.showLinks && focusedFeat && linkedPeers.length > 0 && ol.geom?.LineString) {
      const origin = focusedFeat.getGeometry().getCoordinates().slice(0, 2);
      const linkFeats = linkedPeers.map(peer => {
        const dest = peer.getGeometry().getCoordinates().slice(0, 2);
        const lf = new ol.Feature({ geometry: new ol.geom.LineString([origin, dest]) });
        lf.setStyle(new ol.style.Style({
          stroke: new ol.style.Stroke({ color: OPENING_COLOR, width: 2.2, lineDash: [4, 4] })
        }));
        return lf;
      });
      linkLayer = new ol.layer.Vector({
        source: new ol.source.Vector({ features: linkFeats }),
        zIndex: 99999
      });
      map.addLayer(linkLayer);
    }

    if (vectorLayer) vectorLayer.changed();
  }

  function ensureVectorLayer() {
    if (vectorLayer) map.removeLayer(vectorLayer);
    vectorLayer = new ol.layer.Vector({
      source: new ol.source.Vector({ features: state.points }),
      zIndex: 100000,
      style: pointStyleFn
    });
    map.addLayer(vectorLayer);
  }

  function navigateTo(index) {
    const f = state.points[index];
    if (!f) return;
    state.focused = index;
    const view = map.getView();
    const zoom = Math.max(Number.isFinite(view.getZoom()) ? view.getZoom() : 0, 17.5);
    const xy = f.getGeometry().getCoordinates();
    const res = view.getResolutionForZoom?.(zoom);
    const drawerRightOffset = state.drawerOpen && !state.collapsed ? 188 : 0;
    const center = Number.isFinite(res) && drawerRightOffset
      ? [xy[0] + drawerRightOffset * res, xy[1]]
      : xy;
    view.animate({ center, zoom, duration: 250 });
    renderTable();
    rebuildOverlayLayers();
    tbody.querySelector(`tr[data-idx="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function fitPoints(indices) {
    const coords = indices.map(i => state.points[i]?.getGeometry().getCoordinates()).filter(Boolean);
    if (!coords.length) return;
    if (coords.length === 1) { navigateTo(indices[0]); return; }
    const xs = coords.map(c => c[0]), ys = coords.map(c => c[1]);
    const padRight = state.drawerOpen && !state.collapsed ? 395 : 40;
    map.getView().fit([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], {
      size: map.getSize(),
      padding: [70, padRight, 70, 40],
      maxZoom: 17.5,
      duration: 280
    });
  }

  // =========================================================================
  // 9. ALGORITMO INTERACTIVO DE RED MT: TRAMOS A->B, APERTURAS Y REMATES
  // =========================================================================
  function upsertPointOnMap({ codigo, codigoTerreno = "", numero = null, lonlat = null, tipo = "PUNTO", bloqueId = "D", bloques = ["D"], tipoEquipo = "", proteccionTipo = "", eptTipo = "", rolPT = "", accionPT = "", esRemate = false, esIntermedio = false, sseeCode = "", estadoEjec = "pendiente", observaciones = null, syncStatus = "ok", syncNote = "", gnatMeta = null }) {
    const cleanCode = String(codigo || "").trim().toUpperCase();
    const cleanTer = String(codigoTerreno || "").trim().toUpperCase();
    const proj = map.getView().getProjection();
    const hasCoords = Array.isArray(lonlat) && lonlat.length === 2 && Number.isFinite(lonlat[0]) && Number.isFinite(lonlat[1]);

    const cleanSsee = String(sseeCode || "").replace(/^SSEE\s+/i, "").trim().toUpperCase();
    // Antiduplicados: asociar por código GNAT, código en terreno, código S/E, o cercanía <= 5 m del mismo tipo
    let existing = state.points.find(f => {
      if ((f.get("tipo") || "PUNTO") !== tipo) return false;
      const fc = getPointCode(f).toUpperCase();
      const ft = String(f.get("codigoTerreno") || "").toUpperCase();
      const fs = String(f.get("sseeCode") || "").replace(/^SSEE\s+/i, "").trim().toUpperCase();
      if (cleanCode && cleanCode !== "SIN CÓDIGO" && (fc === cleanCode || (ft && ft === cleanCode) || (fs && fs === cleanCode))) return true;
      if (cleanSsee && (fc === cleanSsee || (fs && fs === cleanSsee))) return true;
      if (cleanTer && (fc === cleanTer || (ft && ft === cleanTer))) return true;
      if (hasCoords && f.getGeometry()) {
        const fll = ol.proj.toLonLat(f.getGeometry().getCoordinates(), proj);
        if (Number.isFinite(fll[0]) && Number.isFinite(fll[1]) && haversineMeters(fll, lonlat) <= 5) return true;
      }
      return false;
    });

    if (existing) {
      if (hasCoords) existing.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(lonlat, proj)));
      if (cleanCode && cleanCode !== "SIN CÓDIGO" && getPointCode(existing) === "Sin código") existing.set("codigo", cleanCode);
      if (cleanTer && !existing.get("codigoTerreno")) existing.set("codigoTerreno", cleanTer);
      if (Number.isFinite(Number(numero)) && Number(numero) > 0) existing.set("numero", Number(numero));
      if (tipoEquipo && !existing.get("tipoEquipo")) existing.set("tipoEquipo", tipoEquipo);
      if (esRemate) { existing.set("esRemate", true); existing.set("esIntermedio", false); }
      if (sseeCode && !existing.get("sseeCode")) existing.set("sseeCode", sseeCode);
      const effProt = proteccionTipo || mapProtectionFromText(tipoEquipo) || (sseeCode ? "DF_XS" : "");
      if (effProt && !existing.get("proteccionTipo")) existing.set("proteccionTipo", effProt);
      if (eptTipo && !existing.get("eptTipo")) existing.set("eptTipo", eptTipo);
      if (gnatMeta) existing.set("gnatMeta", gnatMeta);
      if (syncNote !== undefined && syncNote !== "") existing.set("syncNote", syncNote);
      if (estadoEjec && estadoEjec !== "pendiente") existing.set("estadoEjec", estadoEjec);
      if (Array.isArray(observaciones) && observaciones.length) {
        const curObs = Array.isArray(existing.get("observaciones")) ? existing.get("observaciones") : [];
        existing.set("observaciones", [...curObs, ...observaciones]);
      }
      if (syncStatus) existing.set("syncStatus", syncStatus);
      if (bloqueId && !existing.get("bloqueId")) existing.set("bloqueId", bloqueId);
      const curBloques = Array.isArray(existing.get("bloques")) ? existing.get("bloques") : [];
      const cleanBloques = (bloques || []).filter(Boolean);
      if (cleanBloques.length) existing.set("bloques", [...new Set([...curBloques, ...cleanBloques])]);
      return existing;
    }

    const nextNum = Number.isFinite(Number(numero)) && Number(numero) > 0
      ? Number(numero)
      : 1 + Math.max(0, ...state.points.map(p => Number(p.get("numero")) || 0));
    const initGeom = hasCoords ? new ol.geom.Point(ol.proj.fromLonLat(lonlat, proj)) : null;
    const feat = new ol.Feature({
      geometry: initGeom,
      id: `${tipo === "APERTURA" ? "ap" : "p"}-${cleanCode || nextNum}-${Date.now()}-${Math.floor(Math.random()*999)}`,
      numero: nextNum,
      tipo,
      codigo: cleanCode || "Sin código",
      codigoTerreno: cleanTer,
      bloqueId: bloqueId || "",
      bloques: (bloques || []).filter(Boolean),
      aperturasIds: [],
      supervisorId: "default",
      tipoEquipo,
      rolPT,
      accionPT,
      esRemate,
      esIntermedio,
      sseeCode,
      proteccionTipo: proteccionTipo || mapProtectionFromText(tipoEquipo) || (sseeCode ? "DF_XS" : ""),
      eptTipo: eptTipo || (/ept/i.test(tipoEquipo || "") ? tipoEquipo : ""),
      gnatMeta: gnatMeta || null,
      syncNote: syncNote || "",
      estadoEjec: estadoEjec || "pendiente",
      observaciones: Array.isArray(observaciones) ? observaciones : [],
      syncStatus: syncStatus || (hasCoords ? "ok" : "loading")
    });
    state.points.push(feat);
    return feat;
  }

  async function runMtNetworkDiscovery() {
    // 1. Determinar postes semilla (Seleccionados > Zona T > Zona F > Todos los postes)
    const proj = map.getView().getProjection();
    let seedFeats = [...state.selected].map(i => state.points[i]).filter(f => f && f.getGeometry());
    const nonApSel = seedFeats.filter(f => f.get("tipo") !== "APERTURA");
    if (nonApSel.length) seedFeats = nonApSel;
    const hasFilter = state.filterTypes.size > 0 || state.hiddenZones.size > 0 || state.hiddenStatuses.size > 0 || Boolean(state.search.trim());
    if (!seedFeats.length && hasFilter) {
      seedFeats = getFilteredPoints().filter(f => f.getGeometry() && f.get("tipo") !== "APERTURA");
    }
    if (!seedFeats.length) {
      seedFeats = state.points.filter(f => f.getGeometry() && f.get("tipo") !== "APERTURA" && (getPointZoneIds(f).includes("T") || getPointZoneIds(f).includes("F")));
    }
    if (!seedFeats.length) {
      seedFeats = state.points.filter(f => f.get("tipo") !== "APERTURA");
    }
    if (!seedFeats.length && state.points.length) {
      seedFeats = [...state.points];
    }
    if (!seedFeats.length) {
      showToast("Agrega o selecciona al menos un poste en el mapa para analizar la red MT.", true);
      return;
    }

    const knownOpenings = new Set(
      state.points.filter(f => f.get("tipo") === "APERTURA").map(f => getPointCode(f).toUpperCase())
    );
    const seedCodes = new Set(seedFeats.map(f => getPointCode(f).toUpperCase()));

    const visitedNodes = []; // Array<{ id, lonlat, code }>
    const findNearNode = (lonlat, maxM = 6) => visitedNodes.find(n => haversineMeters(n.lonlat, lonlat) <= maxM) || null;

    const queue = [];
    for (const f of seedFeats) {
      const c = getPointCode(f).toUpperCase();
      let ll = ol.proj.toLonLat(f.getGeometry().getCoordinates(), proj);
      if (!findNearNode(ll, 4)) {
        const nodeId = `N_${ll[0].toFixed(5)}_${ll[1].toFixed(5)}`;
        visitedNodes.push({ id: nodeId, lonlat: ll, code: c });
        queue.push({ id: nodeId, lonlat: ll, hintCode: c, hops: 0, isSeed: true, prevCoci: null });
      }
    }

    const discoveredOpenings = [];
    const discoveredRemates = [];
    const discoveredSpans = new Map(state.spans.map(s => [s.display, s]));
    const spanGeoCache = new Map();
    const graphNodeMap = new Map(state.graphNodes.map(n => [n.code, n]));
    const adjacency = new Map(); // nodeId -> Set<nodeId>
    const nodeMeta = new Map();  // nodeId -> { code, lonlat, sseeCode, coci3f, isOpening, isSeed }
    const boundaryNodeIds = new Set();
    const MAX_HOPS = 300;
    const MAX_NODES = 400;
    let cancelled = false;

    const addEdge = (idA, idB) => {
      if (!idA || !idB || idA === idB) return;
      if (!adjacency.has(idA)) adjacency.set(idA, new Set());
      if (!adjacency.has(idB)) adjacency.set(idB, new Set());
      adjacency.get(idA).add(idB);
      adjacency.get(idB).add(idA);
    };

    const getOrCreateNodeAt = (lonlat, hintCode = "") => {
      const near = findNearNode(lonlat, 6);
      if (near) {
        if (hintCode && !near.code) near.code = hintCode;
        return near;
      }
      const id = `N_${lonlat[0].toFixed(5)}_${lonlat[1].toFixed(5)}`;
      const node = { id, lonlat, code: hintCode };
      visitedNodes.push(node);
      return node;
    };

    setCursorMode("nav", "⚡ Analizando red MT por puntas de cable... (Esc para detener)");
    modeBannerAction.onclick = () => { cancelled = true; setCursorMode("nav"); };

    try {
      while (queue.length > 0 && visitedNodes.length <= MAX_NODES && !cancelled) {
        const cur = queue.shift();
        const labelNow = cur.hintCode || cur.id;
        modeBannerText.textContent = `⚡ Red MT: ${labelNow} (${nodeMeta.size} nodos · ${discoveredSpans.size} tramos · ${discoveredOpenings.length} aperturas)...`;

        let neighborhood = await inspectPoleNeighborhoodInGnat(cur.hintCode, cur.lonlat, [], true);
        if (cur.isSeed && neighborhood.spans.length === 0 && cur.hintCode && !cur.hintCode.startsWith("N_") && cur.hintCode !== "SIN CÓDIGO") {
          const snapped = await resolveCodeInGnat(cur.hintCode, true);
          if (snapped?.lonlat) {
            cur.lonlat = snapped.lonlat;
            neighborhood = await inspectPoleNeighborhoodInGnat(cur.hintCode, cur.lonlat, snapped.extraCoords || [], true);
          }
        }
        // Incluir tanto equipos en serie (Reconectador, Seccionador, Pole Top, DDCC) como Desconectadores Fusibles de arranque MT (ya filtrados sin fusibles de SSEE)
        const lineDevicesHere = neighborhood.devices;
        const rawDevCode = (lineDevicesHere[0]?.code || "").toUpperCase();
        // Priorizar código real del poste (alfanumérico) o del equipo de apertura (ej. FF4840, FA4434) antes que IDs numéricos del tramo
        const pickCode = () => {
          const cands = [neighborhood.detectedPoleCode, rawDevCode, cur.hintCode].map(x => String(x || "").trim().toUpperCase()).filter(Boolean);
          const alpha = cands.find(x => /^[A-Z]/.test(x) && !x.startsWith("N_"));
          return alpha || cands[0] || cur.id;
        };
        let nodeCode = pickCode();
        const sseeTag = neighborhood.sseeList[0] ? `SSEE ${neighborhood.sseeList[0]}` : "";

        // Verificar si coincide con una apertura ya declarada en el PT (por código o cercanía real <= 12m, sin cortar el poste anterior)
        const nearExistingOpening = state.points.find(f => {
          if (f.get("tipo") !== "APERTURA") return false;
          const fc = getPointCode(f).toUpperCase();
          if (fc === nodeCode || (rawDevCode && fc === rawDevCode)) return true;
          const fll = ol.proj.toLonLat(f.getGeometry().getCoordinates(), proj);
          return haversineMeters(fll, cur.lonlat) <= 12;
        });
        if (nearExistingOpening) {
          nodeCode = getPointCode(nearExistingOpening).toUpperCase();
        }

        const isDeclaredOpening = knownOpenings.has(nodeCode) || Boolean(nearExistingOpening);
        const isPhysicallyOpen = lineDevicesHere.some(d => /abiert/i.test(d.realState || ""));
        const curCoci = neighborhood.coci3f;
        const goingDownstream = cur.prevCoci !== null && curCoci !== null && (curCoci < cur.prevCoci - 0.0005);
        // Si vamos aguas abajo (COCI_3F baja) y el equipo está cerrado y no fue fijado manualmente como apertura del PT,
        // queda sin energía al abrir aguas arriba -> continuar hasta encontrar los remates finales.
        const isOpening = isDeclaredOpening || isPhysicallyOpen || (lineDevicesHere.length > 0 && !goingDownstream);

        nodeMeta.set(cur.id, {
          code: nodeCode,
          lonlat: cur.lonlat,
          sseeCode: sseeTag,
          coci3f: neighborhood.coci3f,
          isOpening,
          isSeed: cur.isSeed || seedCodes.has(nodeCode)
        });
        graphNodeMap.set(nodeCode, { code: nodeCode, lonlat: cur.lonlat, coci3f: neighborhood.coci3f, sseeCode: sseeTag });

        const existingPt = state.points.find(f => getPointCode(f).toUpperCase() === nodeCode);
        if (existingPt && sseeTag && !existingPt.get("sseeCode")) existingPt.set("sseeCode", sseeTag);

        if (isOpening) {
          boundaryNodeIds.add(cur.id);
          const eqName = lineDevicesHere[0]?.type || lineDevicesHere[0]?.display || "Apertura MT";
          const realSt = lineDevicesHere[0]?.realState ? ` (${lineDevicesHere[0].realState})` : "";
          if (nearExistingOpening) {
            if (eqName && !nearExistingOpening.get("tipoEquipo")) nearExistingOpening.set("tipoEquipo", eqName);
          } else {
            upsertPointOnMap({
              codigo: nodeCode,
              lonlat: cur.lonlat,
              tipo: "APERTURA",
              bloqueId: "D",
              bloques: ["D"],
              tipoEquipo: eqName
            });
          }
          if (!discoveredOpenings.some(x => x.code === nodeCode)) {
            discoveredOpenings.push({ code: nodeCode, equipo: `${eqName}${realSt}`, lonlat: cur.lonlat });
          }
          if (!cur.isSeed) {
            rebuildOverlayLayers();
            continue;
          }
        }

        // Pedir en 1 solo lote las geometrías LineString reales de los tramos que tocan este punto
        const missingIds = neighborhood.spans.map(s => s.id).filter(id => id > 0 && !spanGeoCache.has(id));
        if (missingIds.length) {
          const fetched = await fetchSpanGeometriesBatch(missingIds);
          for (const [fid, gdata] of fetched.entries()) spanGeoCache.set(fid, gdata);
        }

        for (const sp of neighborhood.spans) {
          const geo = spanGeoCache.get(sp.id);
          if (!geo) continue;

          // Guardar polilínea completa del tramo MT (sigue la curva real de GNAT)
          const key = [sp.from, sp.to].sort().join(" - ");
          discoveredSpans.set(key, {
            id: sp.id,
            from: sp.from,
            to: sp.to,
            display: `${sp.from} - ${sp.to}`,
            voltage: "mt",
            coords: geo.coords
          });

          // Determinar hacia qué punta(s) del cable saltar
          const dStart = haversineMeters(cur.lonlat, geo.start);
          const dEnd = haversineMeters(cur.lonlat, geo.end);
          const nextEndpoints = [];
          if (dStart > 6 && dEnd > 6) {
            // Semilla ligeramente desplazada del cable: explorar ambas puntas del tramo
            nextEndpoints.push(geo.start, geo.end);
          } else {
            nextEndpoints.push(dStart >= dEnd ? geo.start : geo.end);
          }

          for (const nextLL of nextEndpoints) {
            const otherHint = sp.from === nodeCode ? sp.to : sp.to === nodeCode ? sp.from : "";
            const existed = Boolean(findNearNode(nextLL, 6));
            const nbNode = getOrCreateNodeAt(nextLL, otherHint);
            addEdge(cur.id, nbNode.id);

            if (!existed && cur.hops < MAX_HOPS && visitedNodes.length <= MAX_NODES) {
              if (otherHint && knownOpenings.has(otherHint)) {
                boundaryNodeIds.add(nbNode.id);
                nodeMeta.set(nbNode.id, { code: otherHint, lonlat: nextLL, sseeCode: "", coci3f: null, isOpening: true, isSeed: false });
                upsertPointOnMap({ codigo: otherHint, lonlat: nextLL, tipo: "APERTURA", bloqueId: "D", bloques: ["D"], tipoEquipo: "Apertura MT (PT)" });
                if (!discoveredOpenings.some(x => x.code === otherHint)) {
                  discoveredOpenings.push({ code: otherHint, equipo: "Apertura MT (PT)", lonlat: nextLL });
                }
              } else {
                queue.push({ id: nbNode.id, lonlat: nextLL, hintCode: otherHint, hops: cur.hops + 1, isSeed: false, prevCoci: curCoci !== null ? curCoci : cur.prevCoci });
              }
            }
          }
        }

        state.spans = [...discoveredSpans.values()];
        state.graphNodes = [...graphNodeMap.values()];
        rebuildOverlayLayers();
      }

      // Detectar remates MT reales sobre el grafo de puntas (grado === 1 real, sin ser apertura ni semilla ni pendiente)
      const pendingIds = new Set(queue.map(q => q.id));
      for (const [nid, nbSet] of adjacency.entries()) {
        if (nbSet.size === 1 && !boundaryNodeIds.has(nid) && !pendingIds.has(nid)) {
          const meta = nodeMeta.get(nid);
          if (!meta || meta.isOpening || meta.isSeed) continue;
          upsertPointOnMap({
            codigo: meta.code,
            lonlat: meta.lonlat,
            tipo: "PUNTO",
            bloqueId: "D",
            bloques: ["D"],
            esRemate: true,
            sseeCode: meta.sseeCode || ""
          });
          if (!discoveredRemates.includes(meta.code)) discoveredRemates.push(meta.code);
        }
      }
    } finally {
      setCursorMode("nav");
    }

    const zoneD = state.zones.get("D");
    if (zoneD && (!Array.isArray(zoneD.customRing) || zoneD.customRing.length < 3)) {
      generateZonePolygonFromPoints("D");
    }
    const zoneT = state.zones.get("T");
    if (zoneT && (!Array.isArray(zoneT.customRing) || zoneT.customRing.length < 3)) {
      const tPts = state.points.filter(f => getPointZoneIds(f).includes("T"));
      if (tPts.length >= 3) generateZonePolygonFromPoints("T");
    }

    markDirty();
    refreshAll();
    openMtDiscoverySummaryModal({
      visitedCount: nodeMeta.size,
      spanCount: state.spans.length,
      openings: discoveredOpenings,
      remates: discoveredRemates,
      openQueue: queue.map(q => q.hintCode || q.id)
    });
  }



  function openMtDiscoverySummaryModal(summary) {
    modalBackdrop.replaceChildren();
    modalBackdrop.classList.remove("hidden");
    const card = el("div", "modal-card", null, modalBackdrop);
    const head = el("div", "modal-head", null, card);
    el("h2", "", "Resultado de Análisis MT (Tramos, Aperturas y Remates)", head);
    const bClose = el("button", "btn-outline", "Cerrar", head);
    bClose.onclick = closeModal;

    const body = el("div", "modal-body", null, card);
    const isClosed = summary.openings.length > 0 && summary.openQueue.length === 0;
    const banner = el("div", "", null, body);
    banner.style.cssText = `padding:10px 12px;border-radius:8px;font-weight:700;background:${isClosed ? "#DCFCE7" : "#FEF3C7"};color:${isClosed ? "#15803D" : "#92400E"};`;
    banner.textContent = isClosed
      ? `✓ Zona MT delimitada: ${summary.openings.length} apertura(s) y ${summary.remates.length} remate(s) cierran el tramo.`
      : `⚠️ Análisis parcial / para revisión del supervisor (${summary.openings.length} apertura(s) · ${summary.openQueue.length} rama(s) por verificar).`;

    el("div", "", `Postes MT trazados: ${summary.visitedCount} · Vectores A→B dibujados: ${summary.spanCount}`, body).style.fontSize = "12px";

    if (summary.openings.length) {
      el("div", "pop-title", "Aperturas detectadas / confirmadas (✕)", body);
      for (const op of summary.openings) {
        const row = el("div", "recent-item", null, body);
        el("strong", "", `✕ ${op.code}`, row).style.color = OPENING_COLOR;
        el("span", "", op.equipo, row).style.cssText = "font-size:12px;color:var(--text-secondary);";
      }
    }

    if (summary.remates.length) {
      el("div", "pop-title", "Remates aguas abajo detectados (▲)", body);
      el("div", "", summary.remates.join(", "), body).style.cssText = "font-size:12px;font-weight:600;color:#1E40AF;";
    }

    if (summary.openQueue.length) {
      el("div", "pop-title", "Ramas pendientes de cierre manual", body);
      el("div", "", summary.openQueue.join(", "), body).style.cssText = "font-size:12px;color:#92400E;";
    }

    const footer = el("div", "", null, body);
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:6px;";
    const bEditPoly = el("button", "btn-outline", "✏️ Ajustar polígono D en mapa", footer);
    bEditPoly.onclick = () => {
      closeModal();
      startPolygonEditMode("D");
    };
    const bOk = el("button", "btn-primary", "Aceptar", footer);
    bOk.onclick = closeModal;
  }

  // =========================================================================
  // 10. EDITOR NATIVO DE POLÍGONOS (D / T / F) CON AUTOGUARDADO REAL
  // =========================================================================
  function startPolygonEditMode(zoneId = null) {
    state.editingZoneId = zoneId;
    if (zoneId) {
      const ring = getZoneRingLonLat(zoneId);
      const z = state.zones.get(zoneId);
      if (z && (!z.customRing || z.customRing.length < 3) && ring && ring.length >= 3) {
        z.customRing = ring.map(p => [p[0], p[1]]);
      }
    }
    setCursorMode(
      "edit-poly",
      `✏️ Editando polígono ${zoneId || "D/T/F"} · Arrastra círculos blancos · Arrastra punto medio para añadir · Clic derecho en vértice para borrar`
    );
    rebuildOverlayLayers();
  }

  function startPolygonDrawMode(zoneId) {
    state.editingZoneId = zoneId;
    state.drawingCoords = [];
    const z = state.zones.get(zoneId);
    setCursorMode(
      "draw-poly",
      `🖊 Dibujando polígono "${z?.name || zoneId}" · Haz clic en el mapa para marcar cada esquina (mín. 3) y pulsa Terminar`
    );
    rebuildOverlayLayers();
  }

  function finishPolygonDrawMode() {
    if (state.cursorMode === "draw-poly" && state.editingZoneId) {
      const z = state.zones.get(state.editingZoneId);
      if (z && state.drawingCoords.length >= 3) {
        z.customRing = state.drawingCoords.slice();
        markDirty();
        showToast(`Polígono "${z.name}" guardado. Puedes ajustar sus vértices.`);
      }
    }
    state.drawingCoords = [];
    state.editingZoneId = null;
    setCursorMode("nav");
    rebuildOverlayLayers();
  }

  // Hit-test sobre vértices y puntos medios de los polígonos en píxeles de pantalla
  function findPolygonVertexAtPixel(pixel) {
    const proj = map.getView().getProjection();
    for (const z of state.zones.values()) {
      if (state.editingZoneId && state.editingZoneId !== z.id) continue;
      const ring = getZoneRingLonLat(z.id);
      if (!ring || ring.length < 3) continue;
      // 1. Revisar vértices principales
      for (let i = 0; i < ring.length; i++) {
        const px = map.getPixelFromCoordinate(ol.proj.fromLonLat(ring[i], proj));
        if (px && Math.hypot(px[0] - pixel[0], px[1] - pixel[1]) <= 13) {
          return { zoneId: z.id, vertexIdx: i, isMidpoint: false };
        }
      }
      // 2. Revisar puntos medios de aristas (para insertar nuevo vértice)
      for (let i = 0; i < ring.length; i++) {
        const next = ring[(i + 1) % ring.length];
        const midLonLat = [(ring[i][0] + next[0]) / 2, (ring[i][1] + next[1]) / 2];
        const px = map.getPixelFromCoordinate(ol.proj.fromLonLat(midLonLat, proj));
        if (px && Math.hypot(px[0] - pixel[0], px[1] - pixel[1]) <= 11) {
          return { zoneId: z.id, vertexIdx: i + 1, isMidpoint: true, midLonLat };
        }
      }
    }
    return null;
  }

  const viewportEl = map.getViewport?.();
  if (viewportEl) {
    const blockGnatDuringPoly = (ev) => {
      if (state.cursorMode !== "edit-poly" && state.cursorMode !== "draw-poly") return;
      ev.stopPropagation();
      ev.stopImmediatePropagation?.();
      if (ev.type === "contextmenu" || ev.type === "dblclick") ev.preventDefault();
    };
    for (const evName of ["mousedown", "mouseup", "click", "dblclick", "contextmenu"]) {
      viewportEl.addEventListener(evName, blockGnatDuringPoly, true);
    }

    viewportEl.addEventListener("pointerdown", (ev) => {
      if (state.cursorMode !== "edit-poly" || ev.button !== 0) return;
      const pixel = map.getEventPixel(ev);
      const hit = findPolygonVertexAtPixel(pixel);
      if (!hit) return;
      ev.stopPropagation();
      ev.preventDefault();
      const z = state.zones.get(hit.zoneId);
      if (!z.customRing) z.customRing = getZoneRingLonLat(hit.zoneId).map(p => [p[0], p[1]]);
      if (hit.isMidpoint) {
        z.customRing.splice(hit.vertexIdx, 0, [hit.midLonLat[0], hit.midLonLat[1]]);
      }
      pushUndoSnapshot("Editar polígono");
      draggingVertex = { zoneId: hit.zoneId, vertexIdx: hit.vertexIdx };
      rebuildOverlayLayers();
    }, true);

    viewportEl.addEventListener("pointermove", (ev) => {
      if (!draggingVertex) return;
      ev.stopPropagation();
      ev.preventDefault();
      const pixel = map.getEventPixel(ev);
      const coord = map.getCoordinateFromPixel(pixel);
      if (!coord) return;
      const [lon, lat] = ol.proj.toLonLat(coord, map.getView().getProjection());
      const z = state.zones.get(draggingVertex.zoneId);
      if (z && Array.isArray(z.customRing) && z.customRing[draggingVertex.vertexIdx]) {
        z.customRing[draggingVertex.vertexIdx] = [Number(lon.toFixed(7)), Number(lat.toFixed(7))];
        rebuildOverlayLayers();
      }
    }, true);

    w.addEventListener("pointerup", () => {
      if (draggingVertex) {
        draggingVertex = null;
        markDirty();
        showToast("Polígono actualizado y guardado.");
      }
    }, true);
  }

  // =========================================================================
  // 11. RENDER DE TABLA, CHIPS DINÁMICOS Y BARRA CONTEXTUAL
  // =========================================================================
  function renderFilterChips() {
    filterChips.replaceChildren();
    const makeChip = (label, isOn, onClick, dotColor = null, title = "") => {
      const c = el("button", "chip" + (isOn ? " on" : ""), null, filterChips);
      if (title) c.title = title;
      if (dotColor) {
        const d = el("span", "dot", null, c);
        d.style.background = dotColor;
      }
      el("span", "", label, c);
      c.onclick = onClick;
      return c;
    };

    const toggleTypeChip = (t) => {
      if (state.filterTypes.has(t)) state.filterTypes.delete(t);
      else state.filterTypes.add(t);
      refreshAll();
    };
    const hasAnyFilter = state.filterTypes.size > 0 || state.hiddenZones.size > 0 || state.hiddenStatuses.size > 0 || state.filterSups.size > 0;
    makeChip("Todos", !hasAnyFilter, () => {
      state.filterTypes.clear();
      state.hiddenZones.clear();
      state.hiddenZoneAreas.clear();
      state.hiddenStatuses.clear();
      state.filterSups.clear();
      refreshAll();
    });

    makeChip("Postes", state.filterTypes.has("PUNTO"), () => toggleTypeChip("PUNTO"));
    makeChip("Aperturas ✕", state.filterTypes.has("APERTURA"), () => toggleTypeChip("APERTURA"), OPENING_COLOR);

    // Un chip por categoría, como Zonas y Estados: el patrón de la app.
    const supAll = [...new Set(state.points.map(f => getSupId(f)))];
    if (supAll.length > 1) {
      const supVis = Math.max(0, supAll.length - state.filterSups.size);
      const supLabel = state.filterSups.size > 0
        ? `Supervisor (${supVis}/${supAll.length}) ▾`
        : "Supervisor ▾";
      const cSup = makeChip(supLabel, state.filterSups.size > 0, (ev) => {
        openSupervisorsVisibilityPopover(ev.currentTarget);
      }, null, "Filtrar por supervisor");
      cSup.style.fontWeight = "600";
    }

    const remateCount = state.points.filter(f => f.get("esRemate")).length;
    if (remateCount > 0 || state.filterTypes.has("REMATE")) {
      makeChip(`▲ Remates (${remateCount})`, state.filterTypes.has("REMATE"), () => toggleTypeChip("REMATE"), "#7C3AED", "Combinable con otros filtros");
    }

    if (Array.isArray(state.graphNodes) && state.graphNodes.length > 0) {
      const ptSet = new Set(state.points.map(p => getPointCode(p).toUpperCase()));
      const interCount = state.graphNodes.filter(g => !ptSet.has(g.code)).length;
      if (interCount > 0) {
        makeChip(`Interm. (${interCount})`, state.showIntermediosInTable, () => {
          state.showIntermediosInTable = !state.showIntermediosInTable;
          refreshAll();
        }, "#64748B", "Mostrar u ocultar los postes grises intermedios en la tabla");
      }
    }

    // Desplegable compacto de visibilidad de Zonas (desmarcas 1 para ocultarla)
    const totalZones = state.zones.size + 1; // + Sin zona
    // El chip cuenta áreas, que es el eje que la palabra «zona» describe. Los puntos
    // de cada zona tienen su propia casilla etiquetada en el popover.
    const visibleZones = Math.max(0, totalZones - state.hiddenZoneAreas.size);
    const zChipLabel = state.hiddenZoneAreas.size > 0 ? `Zonas (${visibleZones}/${totalZones}) ▾` : "Zonas ▾";
    const cZones = makeChip(zChipLabel, state.hiddenZoneAreas.size > 0, (ev) => {
      openZonesVisibilityPopover(ev.currentTarget);
    }, null, "Mostrar u ocultar el área pintada de cada zona");
    cZones.style.fontWeight = "600";

    // Desplegable compacto de visibilidad de Estados
    const totalSt = state.statuses.size;
    const visSt = Math.max(0, totalSt - state.hiddenStatuses.size);
    const stChipLabel = state.hiddenStatuses.size > 0 ? `Estados (${visSt}/${totalSt}) ▾` : "Estados ▾";
    const cSt = makeChip(stChipLabel, state.hiddenStatuses.size > 0, (ev) => {
      openStatusesVisibilityPopover(ev.currentTarget);
    }, null, "Filtrar por estado de ejecución o crear nuevos estados");
    cSt.style.fontWeight = "600";

    // S17: el código de poste trae mucha información asociada; acá se elige cuál se
    // revela en la tabla. Un solo chip por categoría, el mismo patrón de la app.
    const hiddenColCount = TABLE_COLUMNS.filter(c => state.hiddenColumns.has(c.id)).length;
    const cCols = makeChip(
      "Columnas ▾",
      hiddenColCount > 0,
      (ev) => { openColumnsVisibilityPopover(ev.currentTarget); },
      null,
      "Mostrar u ocultar columnas de la tabla"
    );
    cCols.style.fontWeight = "600";
  }

  function renderTable() {
    const visible = getFilteredPoints();
    // Mostrar notita roja compacta si hubo códigos pegados en el buscador que no existen en la tabla
    if (state.lastSearchMissing.length > 0 && state.search.trim()) {
      searchMissingNote.classList.remove("hidden");
      searchMissingNote.replaceChildren();
      const shown = state.lastSearchMissing.slice(0, 6).join(", ") + (state.lastSearchMissing.length > 6 ? ` (+${state.lastSearchMissing.length - 6})` : "");
      el("span", "", `No encontrados (${state.lastSearchMissing.length}): ${shown}`, searchMissingNote);
      const bClr = el("button", "sync-cancel", "×", searchMissingNote);
      bClr.title = "Limpiar búsqueda";
      bClr.onclick = () => { searchInput.value = ""; state.search = ""; state.lastSearchMissing = []; refreshAll(); };
    } else {
      searchMissingNote.replaceChildren();
      searchMissingNote.classList.add("hidden");
    }
    const hasFilter = state.filterTypes.size > 0 || state.hiddenZones.size > 0 || state.hiddenStatuses.size > 0 || Boolean(state.search.trim());
    const mtLbl = state.selected.size > 0
      ? `Red MT (${state.selected.size})`
      : (hasFilter && visible.length > 0 ? `Red MT (${visible.length})` : "Red MT");
    setBtn(btnRedMt, "zap", mtLbl, 14, true);
    const multiSup = isMultiSupActive();
    const focusedFeat = state.points[state.focused];
    const linkedPeerSet = new Set(
      focusedFeat
        ? (focusedFeat.get("tipo") === "APERTURA"
            ? getLinkedPostesForOpening(focusedFeat)
            : getLinkedOpeningsForPoste(focusedFeat))
        : []
    );

    // S18: el orden del proyecto manda, y lo que está oculto no se renderiza. Sin este
    // filtro las nueve columnas sumaban más ancho que la tabla y la única elástica
    // (Código) colapsaba a 0 px, que se veía como "borraste el código del poste".
    const columns = orderedTableColumns().filter(c => (!c.requiresMultiSup || multiSup) && !state.hiddenColumns.has(c.id));
    // El piso de ancho se calcula con las columnas visibles: sumar una columna ensancha
    // la tabla y aparece el desplazamiento horizontal, en vez de aplastar el código.
    table.style.minWidth = `${tableMinWidth(columns)}px`;
    // El ancho vive en la lista: con table-layout:fixed el <colgroup> manda para el
    // encabezado y para el cuerpo por igual, así no hay dos verdades sobre el ancho.
    colgroup.replaceChildren();
    for (const col of columns) {
      const c = doc.createElement("col");
      if (col.width) c.style.width = col.width;
      colgroup.appendChild(c);
    }
    thead.replaceChildren();
    const trh = el("tr", "", null, thead);
    let checkAll = null;
    for (const col of columns) {
      const th = el("th", "", null, trh);
      if (col.id === "check") {
        checkAll = el("input", "", null, th);
        continue;
      }
      if (col.label) th.appendChild(doc.createTextNode(col.label));
      // La flecha ocupa su lugar siempre: si apareciera sólo al ordenar, la etiqueta
      // se correría de su columna al cambiar de criterio.
      const arrow = el("span", "sort-arrow", "", th);
      if (!col.sortKey) continue;
      arrow.textContent = state.sortBy === col.sortKey ? (state.sortDir === "asc" ? "▴" : "▾") : "";
      th.style.cursor = "pointer";
      th.style.userSelect = "none";
      th.title = "Clic para ordenar ascendente / descendente";
      th.onclick = () => {
        if (state.sortBy === col.sortKey) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        else { state.sortBy = col.sortKey; state.sortDir = "asc"; }
        renderTable();
      };
    }
    if (checkAll) {
      checkAll.type = "checkbox";
      checkAll.checked = visible.length > 0 && visible.every(f => state.selected.has(state.points.indexOf(f)));
      checkAll.indeterminate = !checkAll.checked && visible.some(f => state.selected.has(state.points.indexOf(f)));
      checkAll.onchange = () => {
        for (const f of visible) {
          const idx = state.points.indexOf(f);
          if (checkAll.checked) state.selected.add(idx);
          else state.selected.delete(idx);
        }
        renderTable();
        rebuildOverlayLayers();
      };
    }

    const sortedVisible = [...visible].sort((a, b) => {
      const mul = state.sortDir === "asc" ? 1 : -1;
      if (state.sortBy === "codigo") {
        return getPointCode(a).localeCompare(getPointCode(b), "es", { numeric: true, sensitivity: "base" }) * mul;
      }
      if (state.sortBy === "zona") {
        const za = getPointZoneIds(a).join(",") || "zzz";
        const zb = getPointZoneIds(b).join(",") || "zzz";
        return za.localeCompare(zb, "es", { numeric: true, sensitivity: "base" }) * mul;
      }
      if (state.sortBy === "sup") {
        const sa = CAT.foldText(state.supervisors.get(getSupId(a))?.name || "");
        const sb = CAT.foldText(state.supervisors.get(getSupId(b))?.name || "");
        return sa.localeCompare(sb, "es", { numeric: true }) * mul;
      }
      if (state.sortBy === "estado") {
        const ea = state.statuses.get(a.get("estadoEjec") || "pendiente")?.name || "";
        const eb = state.statuses.get(b.get("estadoEjec") || "pendiente")?.name || "";
        return ea.localeCompare(eb, "es", { numeric: true, sensitivity: "base" }) * mul;
      }
      if (state.sortBy === "equipo") {
        const da = String(a.get("gnatMeta")?.deviceDisplay || "");
        const db = String(b.get("gnatMeta")?.deviceDisplay || "");
        return da.localeCompare(db, "es", { numeric: true, sensitivity: "base" }) * mul;
      }
      if (state.sortBy === "dist") {
        // -1 = sin dato, así los puntos sin medir quedan juntos en un extremo.
        const qa = Number(a.get("gnatMeta")?.distMeters ?? -1);
        const qb = Number(b.get("gnatMeta")?.distMeters ?? -1);
        return (qa - qb) * mul;
      }
      if (state.sortBy === "coci") {
        const ca = String(a.get("gnatMeta")?.coci3f || "");
        const cb = String(b.get("gnatMeta")?.coci3f || "");
        return ca.localeCompare(cb, "es", { numeric: true, sensitivity: "base" }) * mul;
      }
      const na = Number(a.get("numero")) || 0;
      const nb = Number(b.get("numero")) || 0;
      if (na !== nb) return (na - nb) * mul;
      return String(a.get("rolPT") || "").localeCompare(String(b.get("rolPT") || ""), "es", { numeric: true }) * mul;
    });
    const frag = doc.createDocumentFragment();
    if (state.points.length === 0) {
      const trEmpty = doc.createElement("tr");
      const tdEmpty = doc.createElement("td");
      tdEmpty.colSpan = columns.length;
      const box = el("div", "empty-state", null, tdEmpty);
      el("div", "empty-state-title", "Sin puntos en este proyecto", box);
      el("div", "empty-state-sub", "Pega una tabla directo desde Excel o importa un KMZ, JSON o CSV para comenzar.", box);
      const actRow = el("div", "empty-state-actions", null, box);
      const bImpTbl = el("button", "btn-primary", "", actRow);
      setBtn(bImpTbl, "filePlus", "Pegar tabla Excel", 13);
      bImpTbl.onclick = () => openPasteCodesModal();
      const bImpFile = el("button", "btn-outline", "", actRow);
      setBtn(bImpFile, "upload", "Abrir archivo", 13);
      bImpFile.onclick = () => hiddenFileInput.click();
      trEmpty.appendChild(tdEmpty);
      frag.appendChild(trEmpty);
    }
    for (let rowPos = 0; rowPos < sortedVisible.length; rowPos++) {
      const f = sortedVisible[rowPos];
      const idx = state.points.indexOf(f);
      const isSel = state.selected.has(idx);
      const isFoc = state.focused === idx;
      const isLinked = linkedPeerSet.has(f);
      const tr = doc.createElement("tr");
      tr.dataset.idx = String(idx);
      if (isSel) tr.classList.add("selected");
      if (isFoc) tr.classList.add("focused");
      else if (isLinked) tr.classList.add("linked-highlight");

      const pColor = getPointColor(f);

      const tdCb = doc.createElement("td");
      // El color del punto va como sombra interior de la primera celda: un border-left
      // en el <tr> corría 3 px todo el contenido del cuerpo respecto del encabezado,
      // que no lleva ese borde. Mismo acento visual, sin desplazar nada.
      tdCb.style.boxShadow = `inset 3px 0 0 ${pColor}`;
      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.checked = isSel;
      cb.onclick = (ev) => {
        ev.stopPropagation();
        if (ev.shiftKey && state.lastCheckedPos >= 0 && state.lastCheckedPos < sortedVisible.length) {
          const lo = Math.min(state.lastCheckedPos, rowPos);
          const hi = Math.max(state.lastCheckedPos, rowPos);
          for (let k = lo; k <= hi; k++) {
            const kIdx = state.points.indexOf(sortedVisible[k]);
            if (cb.checked) state.selected.add(kIdx);
            else state.selected.delete(kIdx);
          }
          renderTable();
          rebuildOverlayLayers();
          return;
        }
        state.lastCheckedPos = rowPos;
      };
      cb.onchange = () => {
        if (cb.checked) state.selected.add(idx);
        else state.selected.delete(idx);
        state.lastCheckedPos = rowPos;
        renderTable();
        rebuildOverlayLayers();
      };
      tdCb.appendChild(cb);

      const tdN = doc.createElement("td");
      tdN.className = "num-cell";
      tdN.textContent = String(f.get("rolPT") || f.get("numero"));

      const tdCode = doc.createElement("td");
      const isAp = f.get("tipo") === "APERTURA";
      const syncSt = f.get("syncStatus") || "ok";
      const stObj = state.statuses.get(f.get("estadoEjec") || "pendiente");
      if (syncSt === "loading") {
        const sp = doc.createElement("span");
        sp.className = "sync-spin";
        sp.title = "Buscando en GNAT...";
        tdCode.appendChild(sp);
      } else if (syncSt === "not_found" || syncSt === "mismatch") {
        const nf = doc.createElement("span");
        nf.textContent = "⚠️ ";
        nf.title = f.get("syncNote") || "Inconsistencia o no encontrado en GNAT (abrir Detalles para revisar)";
        tdCode.appendChild(nf);
      } else if (stObj) {
        const sd = doc.createElement("span");
        sd.className = "status-dot";
        sd.style.background = stObj.color;
        sd.title = `Estado: ${stObj.name}`;
        tdCode.appendChild(sd);
      }
      const mainLine = doc.createElement("div");
      mainLine.style.cssText = "display:flex;align-items:center;gap:4px;min-width:0;";
      while (tdCode.firstChild) mainLine.appendChild(tdCode.firstChild);

      const codeSpan = doc.createElement("span");
      codeSpan.className = "code-mono";
      codeSpan.textContent = (isAp ? "✕ " : "") + getPointCode(f);
      if (isAp) codeSpan.style.color = OPENING_COLOR;
      codeSpan.style.fontWeight = "600";
      // El chip de características conserva su tamaño y lo que se recorta es el código:
      // es el chip inline lo que da la lectura orgánica de la fila, no la tabla.
      codeSpan.style.minWidth = "0";
      codeSpan.style.overflow = "hidden";
      codeSpan.style.textOverflow = "ellipsis";
      codeSpan.style.whiteSpace = "nowrap";
      mainLine.appendChild(codeSpan);

      if (syncSt === "loading") {
        const bStop = doc.createElement("button");
        bStop.className = "sync-cancel";
        bStop.textContent = "×";
        bStop.title = "Cancelar búsqueda de este código";
        bStop.onclick = (ev) => { ev.stopPropagation(); f.set("syncStatus", "cancelled"); renderTable(); };
        mainLine.appendChild(bStop);
      }

      // Máximo 1 chip principal en la línea del código (Remate > Protección > EPT)
      const protObj = PROTECTION_TYPES.find(p => p.id && p.id === f.get("proteccionTipo"));
      const eptTxt = String(f.get("eptTipo") || "").trim();
      const eqType = String(f.get("tipoEquipo") || "").trim();
      if (f.get("esRemate")) {
        const rb = doc.createElement("span");
        rb.className = "remate-badge";
        rb.textContent = "Remate";
        mainLine.appendChild(rb);
      } else if (protObj) {
        const pb = doc.createElement("span");
        pb.className = "prot-badge" + (protObj.level === "BT" ? " bt" : "");
        pb.textContent = protObj.short;
        pb.title = protObj.label;
        mainLine.appendChild(pb);
      } else if (eptTxt || eqType) {
        const eq = doc.createElement("span");
        eq.className = "eq-badge";
        eq.textContent = eptTxt || eqType;
        mainLine.appendChild(eq);
      }
      tdCode.appendChild(mainLine);

      // Sub-línea discreta para metadata secundaria (S/E, observaciones, color propio) sin truncar en "..."
      const sseeTxt = String(f.get("sseeCode") || "").trim();
      const obsArr = Array.isArray(f.get("observaciones")) ? f.get("observaciones") : [];
      const custCol = String(f.get("colorPersonalizado") || "").trim();
      if (sseeTxt || obsArr.length > 0 || isHex(custCol)) {
        const sub = doc.createElement("div");
        sub.className = "meta-sub-row";
        if (sseeTxt) {
          const sEl = doc.createElement("span");
          sEl.className = "code-mono";
          sEl.style.fontSize = "10px";
          sEl.textContent = sseeTxt;
          sub.appendChild(sEl);
        }
        if (obsArr.length > 0) {
          const oEl = doc.createElement("span");
          oEl.textContent = `${obsArr.length} obs.`;
          oEl.title = obsArr[obsArr.length - 1].text;
          sub.appendChild(oEl);
        }
        if (isHex(custCol)) {
          const cd = doc.createElement("span");
          cd.className = "color-ref-dot";
          cd.style.background = custCol;
          cd.title = `Color propio: ${custCol}`;
          sub.appendChild(cd);
        }
        tdCode.appendChild(sub);
      }
      tdCode.title = `${getPointCode(f)} ${f.get("accionPT") ? "· " + f.get("accionPT") : ""}`;

      const tdZ = doc.createElement("td");
      const zids = getPointZoneIds(f);
      if (zids.length) {
        // Todas las zonas, sin tope. Van en un contenedor que envuelve: en una celda
        // angosta el chip se comprimía hasta quedar en su borde y se veía como dos
        // arcos sueltos, que era lo que el chip viejo mostraba.
        const zWrap = doc.createElement("div");
        zWrap.className = "zone-pill-wrap";
        for (const zid of zids) {
          const z = state.zones.get(zid);
          const pill = doc.createElement("span");
          pill.className = "zone-pill";
          const c = z?.color || HIGH_CONTRAST_PALETTE[0];
          pill.style.background = hexToRgba(c, 0.16);
          pill.style.color = "#0F172A";
          pill.style.border = `1px solid ${c}`;
          pill.textContent = zid;
          pill.title = z?.name || zid;
          zWrap.appendChild(pill);
        }
        tdZ.appendChild(zWrap);
      } else {
        tdZ.textContent = "—";
        tdZ.style.color = "#94A3B8";
      }

      let tdS = null;
      if (multiSup) {
        tdS = doc.createElement("td");
        const sup = state.supervisors.get(getSupId(f)) || DEFAULT_SUPERVISORS[0];
        const b = doc.createElement("span");
        b.className = "sup-badge";
        b.style.background = sup.color;
        b.style.color = contrastText(sup.color);
        b.textContent = sup.initials;
        tdS.appendChild(b);
      }

      // Columnas opcionales: revelan la información que el código de poste ya trae
      // asociada. No reemplazan al chip inline del código, lo complementan (S17).
      const showCol = (id) => columns.some(c => c.id === id);

      let tdEstado = null;
      if (showCol("estado")) {
        tdEstado = doc.createElement("td");
        const stx = state.statuses.get(f.get("estadoEjec") || "pendiente");
        if (stx) {
          const d = doc.createElement("span");
          d.className = "status-dot";
          d.style.background = stx.color;
          tdEstado.appendChild(d);
          const t = doc.createElement("span");
          t.textContent = stx.name;
          tdEstado.appendChild(t);
        } else {
          tdEstado.textContent = "—";
        }
      }

      let tdEquipo = null;
      if (showCol("equipo")) {
        tdEquipo = doc.createElement("td");
        tdEquipo.textContent = String(f.get("gnatMeta")?.deviceDisplay || "—");
      }

      let tdDist = null;
      if (showCol("dist")) {
        tdDist = doc.createElement("td");
        tdDist.className = "num-cell";
        const dm = f.get("gnatMeta")?.distMeters;
        tdDist.textContent = Number.isFinite(dm) ? `${Math.round(dm)} m` : "—";
      }

      let tdCoci = null;
      if (showCol("coci")) {
        tdCoci = doc.createElement("td");
        tdCoci.className = "num-cell";
        tdCoci.textContent = String(f.get("gnatMeta")?.coci3f || "—");
      }

      // Las celdas entran en el orden de la lista de columnas: el encabezado y la fila
      // no pueden separarse porque los dos leen la misma definición (S16).
      const cellById = { check: tdCb, numero: tdN, codigo: tdCode, zona: tdZ, sup: tdS, estado: tdEstado, equipo: tdEquipo, dist: tdDist, coci: tdCoci };
      for (const col of columns) {
        const cell = cellById[col.id];
        if (cell) tr.appendChild(cell);
      }

      tr.onclick = () => navigateTo(idx);
      tr.ondblclick = (ev) => { ev.stopPropagation(); openEditPointModal(idx); };
      tr.oncontextmenu = (ev) => {
        ev.preventDefault();
        if (!state.selected.has(idx)) {
          state.selected.clear();
          state.selected.add(idx);
          renderTable();
          rebuildOverlayLayers();
        }
        openContextMenu(ev.clientX, ev.clientY, idx);
      };
      frag.appendChild(tr);
    }
    if (state.showIntermediosInTable && Array.isArray(state.graphNodes) && state.graphNodes.length > 0) {
      const ptSet = new Set(state.points.map(p => getPointCode(p).toUpperCase()));
      const q = state.search.trim().toLocaleLowerCase("es");
      const interNodes = state.graphNodes.filter(gn => !ptSet.has(gn.code) && (!q || gn.code.toLocaleLowerCase("es").includes(q) || (gn.sseeCode || "").toLocaleLowerCase("es").includes(q)));
      if (interNodes.length > 0) {
        const trBar = doc.createElement("tr");
        trBar.style.background = "#EEF2FF";
        const tdBar = doc.createElement("td");
        tdBar.colSpan = columns.length;
        tdBar.style.cssText = "padding:4px 8px;font-size:11px;";
        const barWrap = el("div", "", null, tdBar);
        barWrap.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;";
        const allInterSel = interNodes.every(gn => state.selectedIntermedios.has(gn.code));
        const bSelAllInter = el("button", "btn-outline", allInterSel ? "Desmarcar intermedios" : `Marcar ${interNodes.length} intermedios`, barWrap);
        bSelAllInter.style.cssText = "padding:2px 6px;font-size:10px;white-space:nowrap;";
        bSelAllInter.onclick = (ev) => {
          ev.stopPropagation();
          if (allInterSel) interNodes.forEach(gn => state.selectedIntermedios.delete(gn.code));
          else interNodes.forEach(gn => state.selectedIntermedios.add(gn.code));
          renderTable();
        };
        const selInterCount = interNodes.filter(gn => state.selectedIntermedios.has(gn.code)).length;
        if (selInterCount > 0) {
          const bProm = el("button", "btn-primary", `+ Agregar ${selInterCount} al PT`, barWrap);
          bProm.style.cssText = "padding:2px 8px;font-size:10px;";
          bProm.onclick = (ev) => {
            ev.stopPropagation();
            for (const gn of interNodes) {
              if (!state.selectedIntermedios.has(gn.code)) continue;
              upsertPointOnMap({ codigo: gn.code, lonlat: gn.lonlat, tipo: "PUNTO", bloqueId: "D", bloques: ["D"], esIntermedio: true, sseeCode: gn.sseeCode || "" });
              state.selectedIntermedios.delete(gn.code);
            }
            markDirty();
            refreshAll();
            showToast(`${selInterCount} poste(s) intermedio(s) agregados a la tabla del PT.`);
          };
        }
        trBar.appendChild(tdBar);
        frag.appendChild(trBar);
      }
      for (let gi = 0; gi < interNodes.length; gi++) {
        const gn = interNodes[gi];
        const tr = doc.createElement("tr");
        tr.style.background = state.selectedIntermedios.has(gn.code) ? "#E0E7FF" : "#F8FAFC";
        const tdCb = doc.createElement("td");
        const cbI = doc.createElement("input");
        cbI.type = "checkbox";
        cbI.checked = state.selectedIntermedios.has(gn.code);
        cbI.onclick = (ev) => ev.stopPropagation();
        cbI.onchange = () => {
          if (cbI.checked) state.selectedIntermedios.add(gn.code);
          else state.selectedIntermedios.delete(gn.code);
          renderTable();
        };
        tdCb.appendChild(cbI);
        tr.appendChild(tdCb);

        const tdN = doc.createElement("td");
        tdN.className = "num-cell";
        tdN.textContent = `G${gi + 1}`;
        tr.appendChild(tdN);

        const tdCode = doc.createElement("td");
        const sp = doc.createElement("span");
        sp.textContent = gn.code;
        sp.style.fontWeight = "600";
        sp.style.color = "#475569";
        tdCode.appendChild(sp);
        const ib = doc.createElement("span");
        ib.className = "inter-badge";
        ib.textContent = "Intermedio";
        tdCode.appendChild(ib);
        if (gn.sseeCode) {
          const sb = doc.createElement("span");
          sb.className = "ssee-badge";
          sb.textContent = gn.sseeCode;
          tdCode.appendChild(sb);
        }
        tr.appendChild(tdCode);

        const tdZ = doc.createElement("td");
        tdZ.textContent = gn.coci3f ? `${gn.coci3f} kA` : "MT";
        tdZ.style.fontSize = "11px";
        tdZ.style.color = "#64748B";
        tr.appendChild(tdZ);

        if (multiSup) {
          const tdS = doc.createElement("td");
          tr.appendChild(tdS);
        }
        tr.onclick = () => {
          const view = map.getView();
          const xy = ol.proj.fromLonLat(gn.lonlat, view.getProjection());
          view.animate({ center: xy, zoom: Math.max(view.getZoom() || 0, 18), duration: 220 });
        };
        frag.appendChild(tr);
      }
    }
    tbody.replaceChildren(frag);

    const pos = visible.findIndex(f => state.points.indexOf(f) === state.focused);
    stepLabel.textContent = visible.length ? `${pos >= 0 ? pos + 1 : 0}/${visible.length}` : "0/0";
    btnPrev.disabled = btnNext.disabled = visible.length === 0;
    renderContextActionBar();
  }

  function renderContextActionBar() {
    ctxBar.replaceChildren();
    if (state.selected.size === 0) {
      ctxBar.classList.add("hidden");
      return;
    }
    ctxBar.classList.remove("hidden");
    el("span", "", `${state.selected.size} sel.`, ctxBar).style.fontWeight = "700";

    const btnZone = el("button", "ctx-accent", "Zonas ▾", ctxBar);
    btnZone.onclick = (ev) => openAssignZonePopover(ev.currentTarget);

    const btnSt = el("button", "", "Estado ▾", ctxBar);
    btnSt.onclick = (ev) => openAssignStatusPopover(ev.currentTarget);

    const btnLink = el("button", "", "Vincular ✕", ctxBar);
    btnLink.onclick = () => startLinkOpeningMode([...state.selected]);

    const btnMore = el("button", "", "Más ▾", ctxBar);
    btnMore.onclick = (ev) => {
      const r = ev.currentTarget.getBoundingClientRect();
      openSelectionMorePopover(r.left, r.top - 8);
    };

    const btnClear = el("button", "", "×", ctxBar);
    btnClear.onclick = () => { state.selected.clear(); refreshAll(); };
  }

  function refreshAll() {
    renderFilterChips();
    renderTable();
    rebuildOverlayLayers();
  }

  // =========================================================================
  // 12. ASIGNACIÓN DE ZONAS, COLORES, SUPERVISORES Y POPOVERS
  // =========================================================================
  function assignZoneToIndices(indices, zoneId, additive = true) {
    if (!indices.length) return;
    pushUndoSnapshot("Cambio de zona");
    for (const idx of indices) {
      const f = state.points[idx];
      if (!f) continue;
      if (!zoneId) {
        f.set("bloqueId", "");
        f.set("bloques", []);
      } else {
        const cur = Array.isArray(f.get("bloques")) ? f.get("bloques") : [];
        const next = additive ? [...new Set([...cur, zoneId])] : [zoneId];
        f.set("bloqueId", zoneId);
        f.set("bloques", next);
      }
    }
    styleCache = new WeakMap();
    markDirty();
    refreshAll();
    showToast(zoneId ? `Asignados ${indices.length} elemento(s) a ${state.zones.get(zoneId)?.name || zoneId}.` : "Zona quitada.");
  }

  function assignCustomColorToIndices(indices, hexColor) {
    for (const idx of indices) {
      const f = state.points[idx];
      if (f) f.set("colorPersonalizado", hexColor || "");
    }
    styleCache = new WeakMap();
    markDirty();
    refreshAll();
  }

  function assignSupervisorToIndices(indices, supId) {
    if (supId !== "default") state.multiSupervisorEnabled = true;
    for (const idx of indices) {
      const f = state.points[idx];
      if (f) f.set("supervisorId", supId);
    }
    styleCache = new WeakMap();
    markDirty();
    refreshAll();
  }

  function deleteIndices(indices) {
    if (!indices.length) return;
    if (indices.length > 1 && !w.confirm(`¿Eliminar ${indices.length} elementos seleccionados? (Puedes revertir con Ctrl+Z)`)) return;
    pushUndoSnapshot(`Eliminar ${indices.length} elemento(s)`);
    const toRemove = new Set(indices);
    state.points = state.points.filter((_, i) => !toRemove.has(i));
    state.selected.clear();
    state.focused = -1;
    ensureVectorLayer();
    markDirty();
    refreshAll();
    showToast(`Eliminados ${indices.length} elemento(s).`);
  }

  function createZone(name, color) {
    const raw = String(name || "").trim();
    const shortClean = raw.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    let id = "";
    if (shortClean && shortClean.length <= 6 && !state.zones.has(shortClean)) {
      id = shortClean;
    } else {
      let n = state.zones.size + 1;
      while (state.zones.has("Z" + n)) n++;
      id = "Z" + n;
    }
    const used = new Set([...state.zones.values()].map(z => z.color.toUpperCase()));
    const chosenColor = isHex(color) ? color : nextHighContrastColor(used);
    state.zones.set(id, { id, name: raw || id, color: chosenColor, customRing: null });
    markDirty();
    refreshAll();
    return id;
  }

  function deleteZone(zoneId) {
    if (["D", "T", "F"].includes(zoneId)) {
      showToast("Las zonas base D, T y F no se eliminan.", true);
      return;
    }
    state.zones.delete(zoneId);
    state.hiddenZones.delete(zoneId);
    for (const f of state.points) {
      const cur = Array.isArray(f.get("bloques")) ? f.get("bloques").filter(z => z !== zoneId) : [];
      f.set("bloques", cur);
      if (f.get("bloqueId") === zoneId) f.set("bloqueId", cur[0] || "");
    }
    styleCache = new WeakMap();
    markDirty();
    refreshAll();
    showToast(`Zona "${zoneId}" eliminada.`);
  }

  function createStatus(name, color) {
    const raw = String(name || "").trim();
    if (!raw) return null;
    const baseId = raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || ("st_" + Date.now());
    let id = baseId;
    let k = 2;
    while (state.statuses.has(id)) id = `${baseId}_${k++}`;
    const used = new Set([...state.statuses.values()].map(s => s.color.toUpperCase()));
    const chosenColor = isHex(color) ? color : nextHighContrastColor(used);
    state.statuses.set(id, { id, name: raw, color: chosenColor });
    markDirty();
    refreshAll();
    return id;
  }

  function assignStatusToIndices(indices, statusId) {
    if (!indices.length || !state.statuses.has(statusId)) return;
    pushUndoSnapshot("Cambio de estado");
    for (const idx of indices) {
      const f = state.points[idx];
      if (f) f.set("estadoEjec", statusId);
    }
    markDirty();
    refreshAll();
    showToast(`Estado "${state.statuses.get(statusId).name}" asignado a ${indices.length} elemento(s).`);
  }

  function openSupervisorsVisibilityPopover(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    popoverAnchor = anchorEl;
    popoverKey = "supervisors";
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      pop.style.minWidth = "250px";
      const supIds = [...new Set(state.points.map(f => getSupId(f)))];
      const hiddenSup = supIds.filter((sid) => state.filterSups.has(sid)).length;
      const topRow = el("div", "", null, pop);
      topRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 6px 6px;";
      const allCb = el("input", "", null, topRow);
      allCb.type = "checkbox";
      allCb.checked = hiddenSup === 0;
      allCb.indeterminate = hiddenSup > 0 && hiddenSup < supIds.length;
      allCb.title = "Marcar o desmarcar todos los supervisores";
      allCb.onchange = () => {
        const boxes = [...pop.querySelectorAll("input[data-sup-id]")];
        for (const b of boxes) {
          if (allCb.checked) state.filterSups.delete(b.dataset.supId);
          else state.filterSups.add(b.dataset.supId);
          b.checked = allCb.checked;
        }
        refreshAll();
      };
      el("span", "pop-title", "Visibilidad por Supervisor", topRow).style.padding = "0";

      const wrap = el("div", "", null, pop);
      wrap.style.cssText = "max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;";
      for (const sid of supIds) {
        const sup = state.supervisors.get(sid);
        const label = sid === "default" ? "Sin supervisor" : ((sup && sup.name) || sid);
        const row = el("div", "", null, wrap);
        row.style.cssText = "display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;";
        const lbl = el("label", "", null, row);
        lbl.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;flex:1;min-width:0;";
        const cb = el("input", "", null, lbl);
        cb.type = "checkbox";
        cb.dataset.supId = sid;
        cb.checked = !state.filterSups.has(sid);
        cb.onchange = () => {
          if (cb.checked) state.filterSups.delete(sid);
          else state.filterSups.add(sid);
          refreshAll();
        };
        const dot = el("span", "dot", null, lbl);
        dot.style.background = (sup && sup.color) || "#94a3b8";
        const count = state.points.filter(f => getSupId(f) === sid).length;
        el("span", "", `${label} (${count})`, lbl).style.cssText =
          "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      }
    });
  }

  function openColumnsVisibilityPopover(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    popoverAnchor = anchorEl;
    popoverKey = "columns";
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      pop.style.minWidth = "240px";
      const optionalIds = TABLE_COLUMNS.filter(c => c.id !== "check" && (!c.requiresMultiSup || isMultiSupActive())).map(c => c.id);
      const topRow = el("div", "", null, pop);
      topRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 6px 6px;";
      // Un solo checkbox en el encabezado, como la cabecera de Excel.
      const allCb = el("input", "", null, topRow);
      allCb.type = "checkbox";
      allCb.title = "Marcar o desmarcar todas las columnas";
      const ttl = el("span", "", "Columnas visibles", topRow);
      ttl.style.cssText = "font-weight:700;font-size:11px;text-transform:uppercase;color:#475569;";
      const list = el("div", "", null, pop);
      list.style.cssText = "display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;";

      // El panel no se cierra ni se reconstruye al tocar una casilla: se aplica y se
      // repinta la lista acá mismo. Reabrir el popover desde su propio manejador
      // perdía el ancla (los chips se re-renderizan) y el panel terminaba cerrado.
      const paint = () => {
        const hiddenN = optionalIds.filter(id => state.hiddenColumns.has(id)).length;
        allCb.checked = hiddenN === 0;
        allCb.indeterminate = hiddenN > 0 && hiddenN < optionalIds.length;
        list.replaceChildren();
        const order = orderedTableColumns().filter(c => optionalIds.includes(c.id));
        for (const c of order) {
          const row = el("div", "", null, list);
          row.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:5px;";
          const cb = el("input", "", null, row);
          cb.type = "checkbox";
          cb.id = `col-cb-${c.id}`;
          cb.checked = !state.hiddenColumns.has(c.id);
          cb.onchange = () => {
            if (cb.checked) state.hiddenColumns.delete(c.id);
            else state.hiddenColumns.add(c.id);
            apply();
          };
          const lbl = el("label", "", null, row);
          lbl.htmlFor = cb.id;
          lbl.style.cssText = "flex:1;cursor:pointer;display:flex;align-items:center;gap:6px;";
          el("span", "", c.label || c.id, lbl);
          // S18: reordenar. Mueve la columna dentro del orden guardado del proyecto.
          const canMove = (delta) => {
            const i = state.columnOrder.indexOf(c.id);
            const j = i + delta;
            return i >= 0 && j >= 0 && j < state.columnOrder.length && state.columnOrder[j] !== "check";
          };
          const mkMove = (text, delta, title) => {
            const b = el("button", "", text, row);
            b.type = "button";
            b.title = title;
            b.style.cssText = "padding:0 4px;font-size:10px;line-height:14px;border:1px solid #CBD5E1;background:#fff;border-radius:4px;cursor:pointer;";
            b.disabled = !canMove(delta);
            b.onclick = (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              if (!canMove(delta)) return;
              const i = state.columnOrder.indexOf(c.id);
              const j = i + delta;
              [state.columnOrder[i], state.columnOrder[j]] = [state.columnOrder[j], state.columnOrder[i]];
              markDirty();
              renderTable();
              paint();
            };
          };
          mkMove("\u25B2", -1, "Mover a la izquierda");
          mkMove("\u25BC", 1, "Mover a la derecha");
        }
      };

      const apply = () => {
        // Una tabla sin ninguna columna no es un estado válido: siempre queda una.
        if (optionalIds.every(id => state.hiddenColumns.has(id))) {
          const first = optionalIds.find(id => id !== "codigo") || optionalIds[0];
          state.hiddenColumns.delete(first);
        }
        markDirty();
        renderTable();
        paint();
      };

      allCb.onchange = () => {
        for (const id of optionalIds) {
          if (allCb.checked) state.hiddenColumns.delete(id);
          else state.hiddenColumns.add(id);
        }
        apply();
      };
      paint();
    }, true);
  }

  function openZonesVisibilityPopover(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    popoverAnchor = anchorEl;
    popoverKey = "zones";
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      pop.style.minWidth = "250px";
      const allZ = [...state.zones.keys()];
      const hiddenArea = allZ.filter((id) => state.hiddenZoneAreas.has(id)).length;
      const topRow = el("div", "", null, pop);
      topRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 6px 6px;";
      // Un solo checkbox en el encabezado, como la cabecera de Excel, y manda sobre el
      // ÁREA: es el eje que la palabra «zona» describe. Los puntos tienen su casilla
      // por fila, y ninguna de las dos mueve a la otra.
      const allCb = el("input", "", null, topRow);
      allCb.type = "checkbox";
      allCb.checked = hiddenArea === 0;
      allCb.indeterminate = hiddenArea > 0 && hiddenArea < allZ.length;
      allCb.title = "Pintar o no pintar el área de todas las zonas (los puntos no cambian)";
      allCb.onchange = () => {
        const boxes = [...pop.querySelectorAll("input[data-zone-area]")];
        for (const b of boxes) {
          if (allCb.checked) state.hiddenZoneAreas.delete(b.dataset.zoneArea);
          else state.hiddenZoneAreas.add(b.dataset.zoneArea);
          b.checked = allCb.checked;
        }
        markDirty();
        renderFilterChips();
        rebuildOverlayLayers();
      };
      el("span", "pop-title", "Área y puntos por zona", topRow).style.padding = "0";

      const listWrap = el("div", "", null, pop);
      listWrap.style.cssText = "max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;";

      const addRow = (id, label, color) => {
        const row = el("div", "", null, listWrap);
        row.style.cssText = "display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;";
        const lbl = el("label", "", null, row);
        lbl.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;flex:1;min-width:0;";
        if (color) {
          const d = el("span", "dot", null, lbl);
          d.style.background = color;
        }
        const count = state.points.filter(f => getPointZoneIds(f).includes(id)).length;
        const sp = el("span", "", count ? `${label} (${count})` : label, lbl);
        sp.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

        // S14: dos ejes con nombre, no un ícono. «Área» pinta o no pinta el relleno;
        // «Puntos» decide si los puntos de la zona pasan los filtros. Ninguno mueve al otro.
        const mkToggle = (text, isOn, title, onFlip) => {
          const l = el("label", "", null, row);
          l.style.cssText = "display:flex;align-items:center;gap:3px;font-size:10px;color:#475569;cursor:pointer;white-space:nowrap;";
          const box = el("input", "", null, l);
          box.type = "checkbox";
          box.checked = isOn;
          box.title = title;
          box.onchange = () => onFlip(box.checked);
          el("span", "", text, l);
          return box;
        };

        const cbArea = mkToggle("Área", !state.hiddenZoneAreas.has(id), `Pintar el área de ${label} (los puntos no cambian)`, (on) => {
          if (on) state.hiddenZoneAreas.delete(id);
          else state.hiddenZoneAreas.add(id);
          markDirty();
          renderFilterChips();
          rebuildOverlayLayers();
        });
        cbArea.dataset.zoneArea = id;

        mkToggle("Puntos", !state.hiddenZones.has(id), `Mostrar los puntos de ${label}`, (on) => {
          if (on) state.hiddenZones.delete(id);
          else state.hiddenZones.add(id);
          refreshAll();
        });

        const bSolo = el("button", "btn-outline", "Solo", row);
        bSolo.style.cssText = "padding:1px 6px;font-size:10px;";
        bSolo.title = "Mostrar los puntos de esta zona y filtrar los de las demás";
        bSolo.onclick = () => {
          state.hiddenZones.clear();
          for (const oz of state.zones.keys()) if (oz !== id) state.hiddenZones.add(oz);
          if (id !== "__NONE__") state.hiddenZones.add("__NONE__");
          refreshAll();
          openZonesVisibilityPopover(anchorEl);
        };
      };

      for (const z of state.zones.values()) {
        const lbl = z.name && z.name !== z.id ? `${z.id} · ${z.name}` : z.id;
        addRow(z.id, lbl, z.color);
      }
      addRow("__NONE__", "Sin zona", "#94A3B8");
    });
  }

  function openStatusesVisibilityPopover(anchorEl) {
    popoverKey = "statuses";
    const r = anchorEl.getBoundingClientRect();
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      pop.style.minWidth = "240px";
      const stIds = [...state.statuses.keys()];
      const hiddenSt = stIds.filter((id) => state.hiddenStatuses.has(id)).length;
      const topRow = el("div", "", null, pop);
      topRow.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 6px 6px;";
      const allCb = el("input", "", null, topRow);
      allCb.type = "checkbox";
      allCb.checked = hiddenSt === 0;
      allCb.indeterminate = hiddenSt > 0 && hiddenSt < stIds.length;
      allCb.title = "Marcar o desmarcar todos los estados";
      allCb.onchange = () => {
        const boxes = [...pop.querySelectorAll("input[data-status-id]")];
        for (const b of boxes) {
          if (allCb.checked) state.hiddenStatuses.delete(b.dataset.statusId);
          else state.hiddenStatuses.add(b.dataset.statusId);
          b.checked = allCb.checked;
        }
        refreshAll();
      };
      el("span", "pop-title", "Estados de ejecución", topRow).style.padding = "0";

      for (const st of state.statuses.values()) {
        const row = el("label", "pop-item", null, pop);
        row.style.cursor = "pointer";
        const cb = el("input", "", null, row);
        cb.type = "checkbox";
        cb.dataset.statusId = st.id;
        cb.checked = !state.hiddenStatuses.has(st.id);
        cb.onchange = () => {
          if (cb.checked) state.hiddenStatuses.delete(st.id);
          else state.hiddenStatuses.add(st.id);
          refreshAll();
        };
        const d = el("span", "dot", null, row);
        d.style.background = st.color;
        el("span", "", st.name, row);
      }

      el("div", "pop-sep", null, pop);
      const newRow = el("div", "inline-input-row", null, pop);
      const inpSt = el("input", "", null, newRow);
      inpSt.placeholder = "Nuevo estado...";
      const bAdd = el("button", "btn-primary", "+ Crear", newRow);
      bAdd.onclick = () => {
        if (!inpSt.value.trim()) return;
        createStatus(inpSt.value.trim());
        openStatusesVisibilityPopover(anchorEl);
      };
    });
  }

  function openAssignStatusPopover(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    showPopoverAt(r.left, r.top - 6, (pop) => {
      el("div", "pop-title", "Asignar estado a seleccionados", pop);
      for (const st of state.statuses.values()) {
        const b = el("button", "pop-item", null, pop);
        const d = el("span", "dot", null, b);
        d.style.background = st.color;
        el("span", "", st.name, b);
        b.onclick = () => { closePopover(); assignStatusToIndices([...state.selected], st.id); };
      }
      el("div", "pop-sep", null, pop);
      const newRow = el("div", "inline-input-row", null, pop);
      const inp = el("input", "", null, newRow);
      inp.placeholder = "Nuevo estado...";
      const bAdd = el("button", "btn-primary", "Crear", newRow);
      bAdd.onclick = () => {
        const sid = createStatus(inp.value.trim());
        if (!sid) return;
        closePopover();
        assignStatusToIndices([...state.selected], sid);
      };
    }, true);
  }

  function showPopoverAt(x, y, buildFn, anchorBottom = false) {
    // El ancla manda: la identidad del elemento es estable, la posición no.
    // La fila de chips se desplaza unos píxeles entre clics y el chequeo por
    // coordenadas fallaba, así que el segundo clic reabría en vez de cerrar.
    const anchor = popoverAnchor || lastMouseDownTarget;
    const key = popoverKey;
    popoverAnchor = null;
    popoverKey = null;
    // La clave de categoría es lo más estable: sobrevive a que las fichas se
    // re-rendericen y a que la barra se reposicione sola cada 900 ms.
    if (activePopover && key && activePopoverKey === key) {
      closePopover();
      return null;
    }
    if (activePopover && anchor && activePopoverAnchor === anchor) {
      closePopover();
      return null;
    }
    if (activePopover && !anchor && activePopoverPos && Math.abs(activePopoverPos.x - x) <= 4 && Math.abs(activePopoverPos.y - y) <= 4) {
      closePopover();
      return null;
    }
    closePopover();
    const pop = el("div", "popover");
    buildFn(pop);
    root.appendChild(pop);
    const rect = pop.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), w.innerWidth - rect.width - 8);
    const top = anchorBottom
      ? Math.max(8, y - rect.height)
      : Math.min(Math.max(8, y), w.innerHeight - rect.height - 8);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    activePopover = pop;
    activePopoverPos = { x, y };
    activePopoverAnchor = anchor;
    activePopoverKey = key;
    return pop;
  }

  function openAssignZonePopover(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    showPopoverAt(r.left, r.top - 6, (pop) => {
      el("div", "pop-title", "Asignar seleccionados a Zona", pop);
      for (const z of state.zones.values()) {
        const b = el("button", "pop-item", null, pop);
        const d = el("span", "dot", null, b);
        d.style.background = z.color;
        el("span", "", `${z.id} · ${z.name}`, b);
        b.onclick = () => { closePopover(); assignZoneToIndices([...state.selected], z.id, true); };
      }
      const bNone = el("button", "pop-item", "Quitar de todas las zonas", pop);
      bNone.onclick = () => { closePopover(); assignZoneToIndices([...state.selected], "", false); };

      el("div", "pop-sep", null, pop);
      const newRow = el("div", "inline-input-row", null, pop);
      const inpName = el("input", "", null, newRow);
      inpName.placeholder = "Nueva zona...";
      const bCreate = el("button", "btn-primary", "Crear", newRow);
      bCreate.onclick = () => {
        if (!inpName.value.trim()) return;
        const zid = createZone(inpName.value.trim());
        closePopover();
        assignZoneToIndices([...state.selected], zid, false);
      };
    }, true);
  }

  function openSelectionMorePopover(x, y) {
    showPopoverAt(x, y, (pop) => {
      if (state.selected.size === 1) {
        const onlyIdx = [...state.selected][0];
        const bEdit = el("button", "pop-item", "✏️ Editar código / tipo / condición...", pop);
        bEdit.onclick = () => { closePopover(); openEditPointModal(onlyIdx); };
      }
      const bFit = el("button", "pop-item", "🔍 Encuadrar selección en mapa", pop);
      bFit.onclick = () => { closePopover(); fitPoints([...state.selected]); };

      const bSyncSel = el("button", "pop-item", "🔄 Sincronizar seleccionados con GNAT", pop);
      bSyncSel.onclick = () => {
        closePopover();
        const feats = [...state.selected].map(i => state.points[i]).filter(Boolean);
        enqueueGnatMetadataSync(feats, true);
      };

      const bColor = el("button", "pop-item", "🎨 Color de referencia (opcional) ▾", pop);
      bColor.onclick = () => openColorPickerPopover(bColor, "#00C853", (c) => assignCustomColorToIndices([...state.selected], c), true, true);

      el("div", "pop-sep", null, pop);
      el("div", "pop-title", "Responsable (opcional)", pop);
      for (const s of state.supervisors.values()) {
        const b = el("button", "pop-item", null, pop);
        const d = el("span", "dot", null, b);
        d.style.background = s.color;
        el("span", "", s.id === "default" ? "Sin asignar" : `${s.initials} · ${s.name}`, b);
        b.onclick = () => { closePopover(); assignSupervisorToIndices([...state.selected], s.id); };
      }

      el("div", "pop-sep", null, pop);
      const bDel = el("button", "pop-item", "🗑 Eliminar seleccionados", pop);
      bDel.style.color = "var(--danger)";
      bDel.onclick = () => { closePopover(); deleteIndices([...state.selected]); };
    }, true);
  }

  function openContextMenu(x, y, idx) {
    showPopoverAt(x, y, (pop) => {
      const f = state.points[idx];
      el("div", "pop-title", `${f.get("rolPT") || f.get("numero")} · ${getPointCode(f)}`, pop);
      const bCenter = el("button", "pop-item", "🎯 Centrar en mapa", pop);
      bCenter.onclick = () => { closePopover(); navigateTo(idx); };

      const bEdit = el("button", "pop-item", "📋 Detalles / Propiedades y observaciones...", pop);
      bEdit.onclick = () => { closePopover(); openEditPointModal(idx); };

      const bSt = el("button", "pop-item", "🚦 Cambiar estado ▾", pop);
      bSt.onclick = () => openAssignStatusPopover(bSt);

      const bSyncOne = el("button", "pop-item", "🔄 Sincronizar / verificar en GNAT", pop);
      bSyncOne.onclick = () => { closePopover(); enqueueGnatMetadataSync([f], true); };

      const bToggleType = el("button", "pop-item", f.get("tipo") === "APERTURA" ? "🔄 Convertir en Poste normal" : "✕ Marcar como Apertura (✕)", pop);
      bToggleType.onclick = () => {
        closePopover();
        f.set("tipo", f.get("tipo") === "APERTURA" ? "PUNTO" : "APERTURA");
        styleCache = new WeakMap();
        markDirty();
        refreshAll();
      };

      const bZone = el("button", "pop-item", "🏷 Asignar a Zona (D / T / F) ▾", pop);
      bZone.onclick = () => openAssignZonePopover(bZone);

      const bColor = el("button", "pop-item", "🎨 Color de referencia ▾", pop);
      bColor.onclick = () => openColorPickerPopover(bColor, getPointColor(f), (c) => assignCustomColorToIndices([...state.selected], c), false, true);

      el("div", "pop-sep", null, pop);
      const bDel = el("button", "pop-item", "🗑 Eliminar", pop);
      bDel.style.color = "var(--danger)";
      bDel.onclick = () => { closePopover(); deleteIndices([...state.selected]); };
    });
  }

  function rememberRecentColor(hex) {
    if (!isHex(hex)) return;
    const up = hex.toUpperCase();
    state.recentColors = [up, ...state.recentColors.filter(c => c.toUpperCase() !== up)].slice(0, 6);
  }

  function openColorPickerPopover(anchorEl, currentColor, onPick, anchorAbove = false, allowReset = false) {
    const r = anchorEl.getBoundingClientRect();
    // El ancla se fija explícitamente. Sin esto, showPopoverAt cae en lastMouseDownTarget
    // —el propio botón de color— y el chequeo de toggle puede cerrar en vez de abrir.
    popoverAnchor = anchorEl;
    showPopoverAt(anchorAbove ? r.left : r.right + 6, anchorAbove ? r.top - 6 : r.top, (pop) => {
      pop.style.minWidth = "210px";
      el("div", "pop-title", "Paleta de alto contraste", pop);
      const grid = el("div", "palette-grid", null, pop);
      for (const c of HIGH_CONTRAST_PALETTE) {
        const sw = el("button", "swatch", "", grid);
        sw.style.background = c;
        if (c.toUpperCase() === String(currentColor || "").toUpperCase()) sw.style.outline = "2px solid #0F172A";
        sw.onclick = () => { rememberRecentColor(c); onPick(c); closePopover(); };
      }

      if (state.recentColors.length) {
        el("div", "pop-title", "Recientes", pop).style.marginTop = "4px";
        const rGrid = el("div", "recent-swatches", null, pop);
        for (const c of state.recentColors) {
          const sw = el("button", "swatch", "", rGrid);
          sw.style.background = c;
          sw.onclick = () => { rememberRecentColor(c); onPick(c); closePopover(); };
        }
      }

      el("div", "pop-sep", null, pop);
      const customRow = el("div", "inline-input-row", null, pop);
      const inp = el("input", "", null, customRow);
      inp.type = "color";
      inp.style.cssText = "width:34px;height:28px;padding:1px;border-radius:6px;border:1px solid var(--border);";
      inp.value = isHex(currentColor) ? currentColor : "#00C853";
      inp.oninput = () => onPick(inp.value);
      const bApply = el("button", "btn-primary", "Aplicar", customRow);
      bApply.style.cssText = "flex:1;justify-content:center;padding:4px 8px;font-size:11px;";
      bApply.onclick = () => { rememberRecentColor(inp.value); onPick(inp.value); closePopover(); };

      if (allowReset) {
        const bReset = el("button", "pop-item", "↺ Usar color de zona", pop);
        bReset.style.marginTop = "4px";
        bReset.onclick = () => { onPick(""); closePopover(); };
      }
    }, anchorAbove);
  }

  // =========================================================================
  // 13. MENÚS DE LA BARRA SUPERIOR (ARCHIVO, ZONAS D/T/F, VISTA, HERRAMIENTAS)
  // =========================================================================
  const addMenuBtn = (pop, iconName, label, onClick, opts = {}) => {
    const b = el("button", "pop-item", "", pop);
    b.innerHTML = (iconName ? iconHtml(iconName, 14) : "") + `<span>${label}</span>`;
    if (opts.disabled) b.disabled = true;
    if (opts.color) b.style.color = opts.color;
    b.onclick = onClick;
    return b;
  };

  btnArchivo.onclick = () => {
    const r = btnArchivo.getBoundingClientRect();
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      el("div", "pop-title", "Proyecto e Importación", pop);
      addMenuBtn(pop, "folder", "Proyectos recientes / Nuevo en blanco", () => { closePopover(); openStartModal(); });
      addMenuBtn(pop, "filePlus", "Pegar tabla o códigos desde Excel...", () => { closePopover(); openPasteCodesModal(); });
      addMenuBtn(pop, "upload", "Abrir archivo (KMZ, JSON, Preset PT, CSV)...", () => { closePopover(); hiddenFileInput.click(); });

      el("div", "pop-sep", null, pop);
      el("div", "pop-title", "Exportar y Respaldo", pop);
      addMenuBtn(pop, "download", "Guardar copia (.json)", () => { closePopover(); downloadJSON(); });
      addMenuBtn(pop, "download", "Exportar mapa completo (.kmz)", () => { closePopover(); downloadKMZ(); }, { disabled: state.points.length === 0 && state.spans.length === 0 });
      addMenuBtn(pop, "table", "Exportar tabla (.csv)", () => { closePopover(); downloadCSV(); }, { disabled: state.points.length === 0 });

      if (typeof w.showDirectoryPicker === "function") {
        const label = !state.backupDirHandle
          ? "Carpeta autoguardado (OneDrive / PC)..."
          : state.backupDirPerm === "granted"
            ? `Carpeta activa: ${state.backupDirHandle.name} (cambiar)`
            : `Reautorizar carpeta: ${state.backupDirHandle.name}`;
        addMenuBtn(pop, "folder", label, async () => {
          closePopover();
          try {
            if (state.backupDirHandle && state.backupDirPerm !== "granted") {
              const p = await state.backupDirHandle.requestPermission({ mode: "readwrite" });
              state.backupDirPerm = p;
              if (p === "granted") { await autosaveNow(); showToast(`Carpeta "${state.backupDirHandle.name}" reconectada.`); return; }
            }
            const handle = await w.showDirectoryPicker({ mode: "readwrite", startIn: "documents" });
            state.backupDirHandle = handle;
            state.backupDirPerm = "granted";
            await dbSaveSetting("backupDirHandle", handle);
            await autosaveNow();
            showToast(`Carpeta "${handle.name}" vinculada.`);
          } catch (_) {}
        });
      }

      el("div", "pop-sep", null, pop);
      addMenuBtn(pop, "users", "Equipo / Supervisores (CC, TL, RD, JB)...", () => { closePopover(); openSupervisorsModal(); });
      addMenuBtn(pop, "undo", `Deshacer último cambio (Ctrl+Z)${state.undoStack.length ? ` · ${state.undoStack.length}` : ""}`, () => { closePopover(); performUndo(); }, { disabled: state.undoStack.length === 0 });
    });
  };

  btnZonas.onclick = () => {
    const r = btnZonas.getBoundingClientRect();
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      el("div", "pop-title", "Zonas y Polígonos (D · T · F)", pop);
      for (const z of state.zones.values()) {
        const row = el("div", "inline-input-row", null, pop);
        const colorBtn = el("button", "swatch", "", row);
        colorBtn.style.background = z.color;
        colorBtn.title = "Cambiar color";
        colorBtn.onclick = () => openColorPickerPopover(colorBtn, z.color, (newColor) => {
          z.color = newColor; styleCache = new WeakMap(); markDirty(); refreshAll();
        });

        // Ocultar/mostrar la zona entera: pines y polígono, con el mismo set que
        // usa el filtro de puntos, para que la tabla y el mapa no se contradigan.
        const isHidden = state.hiddenZones.has(z.id);
        const bEye = el("button", "btn-outline icon-btn", "", row);
        bEye.textContent = isHidden ? "◌" : "◉";
        bEye.title = isHidden
          ? `Mostrar "${z.name}" en el mapa`
          : `Ocultar "${z.name}" del mapa (puntos y polígono)`;
        if (isHidden) bEye.style.opacity = "0.55";
        bEye.onclick = () => {
          if (state.hiddenZones.has(z.id)) state.hiddenZones.delete(z.id);
          else state.hiddenZones.add(z.id);
          markDirty(); refreshAll(); btnZonas.click();
        };

        const nameInp = el("input", "", null, row);
        nameInp.type = "text";
        nameInp.value = z.name || z.id;
        nameInp.onchange = () => { z.name = nameInp.value.trim() || z.id; markDirty(); refreshAll(); };

        const bAutoPoly = el("button", "btn-outline icon-btn", "", row);
        setBtn(bAutoPoly, "refresh", "", 13);
        bAutoPoly.title = `Autogenerar polígono de "${z.name}"`;
        bAutoPoly.onclick = () => { closePopover(); generateZonePolygonFromPoints(z.id); };

        const bEditPoly = el("button", "btn-outline icon-btn", "", row);
        setBtn(bEditPoly, "edit", "", 13);
        bEditPoly.title = `Editar vértices de "${z.name}"`;
        bEditPoly.onclick = () => { closePopover(); startPolygonEditMode(z.id); };

        const bDrawPoly = el("button", "btn-outline icon-btn", "", row);
        setBtn(bDrawPoly, "polygon", "", 13);
        bDrawPoly.title = `Dibujar polígono nuevo para "${z.name}"`;
        bDrawPoly.onclick = () => { closePopover(); startPolygonDrawMode(z.id); };

        if (!["D", "T", "F"].includes(z.id)) {
          const bDelZ = el("button", "btn-outline icon-btn", "", row);
          setBtn(bDelZ, "trash", "", 13);
          bDelZ.title = `Eliminar zona "${z.id}"`;
          bDelZ.style.color = "var(--danger)";
          bDelZ.onclick = () => { deleteZone(z.id); btnZonas.click(); };
        } else {
          const locked = el("span", "", "base", row);
          locked.title = "Zona base D/T/F: no se elimina, se oculta con el botón de visibilidad";
          locked.style.opacity = "0.6";
          locked.style.fontSize = "11px";
        }
      }

      el("div", "pop-sep", null, pop);
      const newRow = el("div", "inline-input-row", null, pop);
      const inpNew = el("input", "", null, newRow);
      inpNew.placeholder = "Nueva zona (ej. V2, Tramo 2)...";
      const bAdd = el("button", "btn-primary", "+ Crear", newRow);
      bAdd.onclick = () => { if (!inpNew.value.trim()) return; createZone(inpNew.value.trim()); btnZonas.click(); };

      el("div", "pop-sep", null, pop);
      addMenuBtn(pop, "zap", "Autogenerar polígonos desde puntos", () => {
        closePopover();
        for (const z of state.zones.values()) {
          const pts = state.points.filter(f => getPointZoneIds(f).includes(z.id));
          if (pts.length >= 3) generateZonePolygonFromPoints(z.id);
        }
      });
    });
  };

  btnVista.onclick = () => {
    const r = btnVista.getBoundingClientRect();
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      // S15: el panel se ordena por tipo de cosa y en el orden real de apilado —arriba lo
      // que se pinta encima, la base al final—, así se lee como se ve el mapa. Los grupos
      // que se tocan poco arrancan plegados para que el panel no crezca sin control.
      const group = (title, { collapsible = false, open = false } = {}) => {
        el("div", "pop-sep", null, pop);
        const head = el("div", "pop-title", null, pop);
        const body = el("div", "", null, pop);
        if (!collapsible) {
          head.textContent = title;
          return body;
        }
        const paintHead = () => {
          const visible = !body.classList.contains("hidden");
          head.textContent = `${title} ${visible ? "▾" : "▸"}`;
          head.title = visible ? "Plegar este grupo" : "Desplegar este grupo";
        };
        body.classList.toggle("hidden", !open);
        head.style.cursor = "pointer";
        head.style.userSelect = "none";
        head.onclick = () => {
          body.classList.toggle("hidden");
          paintHead();
        };
        paintHead();
        return body;
      };

      const gPoints = group("Puntos");
      addMenuBtn(gPoints, !state.hidePoles ? "check" : "", "Pines de postes (tecla H)", () => { toggleHidePoles(); closePopover(); });

      const gLabels = group("Etiquetas", { collapsible: true });
      for (const [val, lbl] of [["cerca", "Al acercar zoom"], ["siempre", "Siempre visibles"], ["ninguna", "Ocultar etiquetas"]]) {
        addMenuBtn(gLabels, state.labelMode === val ? "check" : "", lbl, () => { state.labelMode = val; styleCache = new WeakMap(); rebuildOverlayLayers(); closePopover(); });
      }
      addMenuBtn(gLabels, "sliders", state.labelContent === "numero" ? "Texto: Rol/N° (cambiar a completo)" : "Texto: Rol/N° + Código", () => {
        state.labelContent = state.labelContent === "numero" ? "completo" : "numero";
        styleCache = new WeakMap(); rebuildOverlayLayers(); closePopover();
      });

      const gNet = group("Red");
      addMenuBtn(gNet, state.showSpans ? "check" : "", "Vectores de tramos MT (A→B)", () => { state.showSpans = !state.showSpans; rebuildOverlayLayers(); closePopover(); });
      addMenuBtn(gNet, state.showRoute ? "check" : "", "Línea secuencial de ruta (1→2→3)", () => { state.showRoute = !state.showRoute; rebuildOverlayLayers(); closePopover(); });
      addMenuBtn(gNet, state.showLinks ? "check" : "", "Rayos a aperturas vinculadas", () => { state.showLinks = !state.showLinks; rebuildOverlayLayers(); closePopover(); });

      const gZones = group("Zonas");
      addMenuBtn(gZones, state.showHulls ? "check" : "", "Polígonos de zonas (D / T / F)", () => { state.showHulls = !state.showHulls; rebuildOverlayLayers(); closePopover(); });
      // El detalle por zona (área y puntos) ya vive en el chip «Zonas»: no se duplica acá.
      const zoneHint = el("div", "", "Área y puntos de cada zona: chip «Zonas»", gZones);
      zoneHint.style.cssText = "padding:0 8px 4px;font-size:10px;color:#64748B;";

      const gBase = group("Base", { collapsible: true });
      const mtRow = el("div", "", null, gBase);
      mtRow.style.cssText = "display:flex;gap:4px;padding:4px;";
      for (const lvl of [0, 1, 2, 3]) {
        const b = el("button", state.mtbtDetail === lvl ? "active-pill" : "btn-outline", lvl === 0 ? "Original" : `+${lvl}`, mtRow);
        b.style.flex = "1"; b.style.justifyContent = "center";
        b.title = lvl === 0 ? "Detalle WMTS original" : `Detalle WMTS +${lvl}`;
        b.onclick = () => { setMtBtDetail(lvl); closePopover(); };
      }
      addMenuBtn(gBase, state.highlightNetwork ? "check" : "", "Resaltar red MT/BT (alto contraste)", () => { setNetworkHighlight(!state.highlightNetwork); closePopover(); });
    });
  };

  btnRedMt.onclick = () => {
    const r = btnRedMt.getBoundingClientRect();
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      const selCount = state.selected.size;
      const scopeTxt = selCount > 0 ? `${selCount} seleccionados` : "vista / proyecto actual";
      el("div", "pop-title", "Operaciones de Red MT", pop);
      addMenuBtn(pop, "zap", `Analizar tramos, aperturas y remates (${scopeTxt})`, () => { closePopover(); runMtNetworkDiscovery(); });
      addMenuBtn(pop, "refresh", selCount > 0 ? `Sincronizar ${selCount} seleccionados con GNAT` : "Sincronizar todos los puntos con GNAT", () => {
        closePopover();
        const list = selCount > 0 ? [...state.selected].map(i => state.points[i]).filter(Boolean) : [...state.points];
        enqueueGnatMetadataSync(list, true);
      }, { disabled: state.points.length === 0 });
      el("div", "pop-sep", null, pop);
      addMenuBtn(pop, "trash", "Limpiar vectores MT trazados", () => {
        closePopover();
        state.spans = [];
        state.graphNodes = [];
        rebuildOverlayLayers();
        markDirty();
        showToast("Vectores de tramos MT limpiados.");
      }, { disabled: state.spans.length === 0 && state.graphNodes.length === 0 });
    });
  };

  // =========================================================================
  // 14. INTERACCIÓN CON EL MAPA OPENLAYERS
  // =========================================================================
  function setCursorMode(mode, bannerMsg = "") {
    state.cursorMode = mode;
    btnModeNav.classList.toggle("active", mode === "nav");
    btnModeBox.classList.toggle("active", mode === "box");
    btnModeAdd.classList.toggle("active", mode === "add" || mode === "link-opening" || mode === "place-missing");
    btnModePoly.classList.toggle("active", mode === "edit-poly" || mode === "draw-poly");

    if (viewportEl) {
      viewportEl.style.cursor = (mode === "add" || mode === "link-opening" || mode === "place-missing" || mode === "draw-poly" || mode === "box")
        ? "crosshair" : "";
    }

    if (dragBoxInteraction) {
      map.removeInteraction(dragBoxInteraction);
      dragBoxInteraction = null;
    }

    if (ol.interaction?.DragBox && mode !== "edit-poly" && mode !== "draw-poly") {
      dragBoxInteraction = new ol.interaction.DragBox({
        condition: mode === "box"
          ? () => true
          : (ol.events?.condition?.shiftKeyOnly || ((e) => e.originalEvent?.shiftKey))
      });
      dragBoxInteraction.on("boxend", () => {
        const extent = dragBoxInteraction.getGeometry().getExtent();
        const visible = new Set(getFilteredPoints());
        let added = 0;
        state.points.forEach((f, idx) => {
          if (!visible.has(f) || !f.getGeometry()) return;
          const xy = f.getGeometry().getCoordinates();
          if (xy[0] >= extent[0] && xy[0] <= extent[2] && xy[1] >= extent[1] && xy[1] <= extent[3]) {
            state.selected.add(idx);
            added++;
          }
        });
        renderTable();
        rebuildOverlayLayers();
        if (added) showToast(`${added} punto(s) seleccionado(s).`);
        if (mode === "box") setCursorMode("nav");
      });
      map.addInteraction(dragBoxInteraction);
    }

    if (bannerMsg) {
      modeBannerText.textContent = bannerMsg;
      modeBanner.classList.remove("hidden");
    } else {
      modeBanner.classList.add("hidden");
    }
  }

  function startLinkOpeningMode(indices) {
    state.pendingLinkIndices = indices;
    setCursorMode("link-opening", `Haz clic en una apertura (✕) o en un punto vacío para vincular ${indices.length} elemento(s)`);
  }

  function startPlaceMissingCodesQueue(codes) {
    state.pendingMissingCodes = [...codes];
    if (!state.pendingMissingCodes.length) return;
    setCursorMode("place-missing", `Haz clic en el mapa para ubicar "${state.pendingMissingCodes[0]}" (${state.pendingMissingCodes.length} restante(s))`);
  }

  const onMapSingleClick = (evt) => {
    closePopover();
    if (state.cursorMode === "draw-poly") {
      const [lon, lat] = ol.proj.toLonLat(evt.coordinate, map.getView().getProjection());
      state.drawingCoords.push([Number(lon.toFixed(7)), Number(lat.toFixed(7))]);
      rebuildOverlayLayers();
      return;
    }
    if (state.cursorMode === "edit-poly") {
      return;
    }
    if (state.cursorMode === "place-missing" && state.pendingMissingCodes.length > 0) {
      const code = state.pendingMissingCodes.shift();
      const [lon, lat] = ol.proj.toLonLat(evt.coordinate, map.getView().getProjection());
      const feat = upsertPointOnMap({ codigo: code, lonlat: [lon, lat], tipo: "PUNTO", bloqueId: "T", bloques: ["T"] });
      state.selected.add(state.points.indexOf(feat));
      ensureVectorLayer();
      markDirty();
      refreshAll();
      if (state.pendingMissingCodes.length > 0) {
        setCursorMode("place-missing", `Haz clic en el mapa para ubicar "${state.pendingMissingCodes[0]}" (${state.pendingMissingCodes.length} restante(s))`);
      } else {
        setCursorMode("nav");
        showToast("Todos los códigos pendientes fueron ubicados.");
      }
      return;
    }

    if (state.cursorMode === "add") {
      openDropPointPopover(evt.pixel, evt.coordinate, false);
      return;
    }

    if (state.cursorMode === "link-opening") {
      let hitOpening = null;
      map.forEachFeatureAtPixel(evt.pixel, (feat, layer) => {
        if (layer === vectorLayer && feat.get("tipo") === "APERTURA") {
          hitOpening = feat;
          return true;
        }
      });
      if (hitOpening) {
        const apId = String(hitOpening.get("id"));
        let count = 0;
        for (const idx of state.pendingLinkIndices) {
          const f = state.points[idx];
          if (f && f.get("tipo") !== "APERTURA") {
            const cur = Array.isArray(f.get("aperturasIds")) ? f.get("aperturasIds") : [];
            if (!cur.includes(apId)) f.set("aperturasIds", [...cur, apId]);
            count++;
          }
        }
        state.pendingLinkIndices = [];
        setCursorMode("nav");
        markDirty();
        refreshAll();
        showToast(`${count} poste(s) vinculados a apertura ${getPointCode(hitOpening)}.`);
      } else {
        openDropPointPopover(evt.pixel, evt.coordinate, true);
      }
      return;
    }

    if (state.hidePoles) return;
    let hitFeature = null;
    map.forEachFeatureAtPixel(evt.pixel, (feat, layer) => {
      if (layer === vectorLayer) {
        hitFeature = feat;
        return true;
      }
    });
    if (hitFeature) {
      const idx = state.points.indexOf(hitFeature);
      if (idx >= 0) {
        if (evt.originalEvent?.ctrlKey || evt.originalEvent?.metaKey) {
          if (state.selected.has(idx)) state.selected.delete(idx);
          else state.selected.add(idx);
          renderTable();
          rebuildOverlayLayers();
        } else {
          state.focused = idx;
          renderTable();
          rebuildOverlayLayers();
          tbody.querySelector(`tr[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
        }
      }
    }
  };

  const onMapContextMenu = (ev) => {
    const pixel = map.getEventPixel(ev);
    // En modo edición de polígono, clic derecho sobre un vértice lo elimina
    if (state.cursorMode === "edit-poly") {
      const vHit = findPolygonVertexAtPixel(pixel);
      if (vHit && !vHit.isMidpoint) {
        ev.preventDefault();
        const z = state.zones.get(vHit.zoneId);
        if (z?.customRing && z.customRing.length > 3) {
          z.customRing.splice(vHit.vertexIdx, 1);
          markDirty();
          rebuildOverlayLayers();
          showToast("Vértice eliminado del polígono.");
        } else {
          showToast("Un polígono requiere mínimo 3 vértices.", true);
        }
        return;
      }
    }

    if (state.hidePoles) return;
    let hit = null;
    map.forEachFeatureAtPixel(pixel, (feat, layer) => {
      if (layer === vectorLayer) {
        hit = feat;
        return true;
      }
    });
    if (!hit) return;
    ev.preventDefault();
    const idx = state.points.indexOf(hit);
    if (idx < 0) return;
    if (!state.selected.has(idx)) {
      state.selected.clear();
      state.selected.add(idx);
      renderTable();
      rebuildOverlayLayers();
    }
    openContextMenu(ev.clientX, ev.clientY, idx);
  };

  map.on("singleclick", onMapSingleClick);
  viewportEl?.addEventListener("contextmenu", onMapContextMenu);

  function openDropPointPopover(pixel, coordinate, forceOpening) {
    if (addPointDropCoord) addPointDropCoord.remove();
    const mapRect = viewportEl.getBoundingClientRect();
    const form = el("div", "pin-form");
    form.style.left = Math.min(mapRect.left + pixel[0] + 10, w.innerWidth - 295) + "px";
    form.style.top = Math.min(mapRect.top + pixel[1] + 10, w.innerHeight - 260) + "px";

    el("strong", "", forceOpening ? "Nueva apertura vinculada" : "Nuevo elemento en mapa", form);
    if (forceOpening && state.pendingLinkIndices.length) {
      const sub = el("div", "", `Se vinculará a ${state.pendingLinkIndices.length} poste(s) seleccionado(s).`, form);
      sub.style.cssText = "font-size:11px;color:#2563EB;font-weight:600;";
    }
    const inpCode = el("input", "", null, form);
    inpCode.type = "text";
    inpCode.placeholder = forceOpening ? "Código apertura (ej. FF4840)" : "Detectando poste GNAT...";

    const gnatHint = el("div", "", "Consultando poste en GNAT...", form);
    gnatHint.style.cssText = "font-size:11px;color:#475569;min-height:14px;";

    const selType = el("select", "", null, form);
    [["PUNTO", "Poste / Punto"], ["APERTURA", "Apertura (✕ roja)"]].forEach(([v, t]) => {
      const o = el("option", "", t, selType); o.value = v;
    });
    selType.value = forceOpening ? "APERTURA" : "PUNTO";
    selType.disabled = forceOpening;

    const lblZ = el("label", "", forceOpening ? "Zona de la apertura (opcional · por defecto D):" : "Zona del punto (opcional):", form);
    lblZ.style.cssText = "font-size:11px;color:#475569;font-weight:600;margin-top:2px;";
    const selZone = el("select", "", null, form);
    const optNone = el("option", "", "— Sin zona (solo vinculada)", selZone);
    optNone.value = "";
    for (const z of state.zones.values()) {
      const o = el("option", "", `${z.id} · ${z.name}`, selZone);
      o.value = z.id;
    }
    selZone.value = forceOpening ? "D" : "T";

    let userTyped = false;
    let snappedLonLat = ol.proj.toLonLat(coordinate, map.getView().getProjection());
    let detectedSsee = "";
    let detectedProtId = "";
    inpCode.addEventListener("input", () => { userTyped = true; });

    // Autocompletar código y coordenada exacta desde GNAT bajo el clic
    (async () => {
      try {
        const info = await inspectPoleNeighborhoodInGnat("", snappedLonLat);
        const foundCode = info.detectedPoleCode || info.devices[0]?.code || "";
        if (info.sseeList[0]) detectedSsee = `SSEE ${info.sseeList[0]}`;
        if (foundCode) {
          if (!userTyped) inpCode.value = foundCode;
          const isOpClick = Boolean(forceOpening || info.devices.length > 0);
          const exact = await resolveCodeInGnat(foundCode, true, isOpClick, { nearLonLat: snappedLonLat });
          if (exact?.lonlat) snappedLonLat = exact.lonlat;
          if (exact?.protId) detectedProtId = exact.protId;
          const extra = info.devices.length
            ? ` · ${info.devices[0].type}`
            : detectedSsee ? ` · ${detectedSsee}` : "";
          gnatHint.textContent = `✓ GNAT: ${foundCode}${extra}`;
          gnatHint.style.color = "#15803D";
          if (!forceOpening && info.devices.length > 0) {
            selType.value = "APERTURA";
            selZone.value = "D";
          }
        } else {
          gnatHint.textContent = "Sin poste detectado en ese punto (ingresa el código manual).";
          inpCode.placeholder = "Código poste (ej. FAG1672)";
        }
      } catch (_) {
        gnatHint.textContent = "";
        inpCode.placeholder = "Código poste (ej. FAG1672)";
      }
    })();

    const btnRow = el("div", "", null, form);
    btnRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";
    const bCancel = el("button", "btn-outline", "Cancelar", btnRow);
    const bSave = el("button", "btn-primary", "Crear", btnRow);

    const cleanup = () => {
      form.remove();
      addPointDropCoord = null;
      state.pendingLinkIndices = [];
      setCursorMode("nav");
    };

    const submit = () => {
      const code = inpCode.value.trim() || "Sin código";
      const feat = upsertPointOnMap({
        codigo: code,
        lonlat: snappedLonLat,
        tipo: selType.value,
        bloqueId: selZone.value,
        bloques: selZone.value ? [selZone.value] : [],
        sseeCode: detectedSsee,
        proteccionTipo: detectedProtId
      });
      if (forceOpening && state.pendingLinkIndices.length) {
        const newId = String(feat.get("id"));
        for (const idx of state.pendingLinkIndices) {
          const p = state.points[idx];
          if (p && p.get("tipo") !== "APERTURA") {
            const cur = Array.isArray(p.get("aperturasIds")) ? p.get("aperturasIds") : [];
            p.set("aperturasIds", [...cur, newId]);
          }
        }
      }
      ensureVectorLayer();
      markDirty();
      refreshAll();
      cleanup();
    };

    bCancel.onclick = cleanup;
    bSave.onclick = submit;
    inpCode.onkeydown = (ev) => {
      if (ev.key === "Enter") submit();
      if (ev.key === "Escape") cleanup();
    };
    addPointDropCoord = form;
    w.setTimeout(() => inpCode.focus(), 20);
  }

  btnModeNav.onclick = () => setCursorMode("nav");
  btnModeBox.onclick = () => setCursorMode("box", "Arrastra un rectángulo sobre el mapa para seleccionar puntos");
  btnModeAdd.onclick = () => setCursorMode("add", "Haz clic en el mapa para ubicar el nuevo punto");
  btnModePoly.onclick = () => {
    if (state.cursorMode === "edit-poly" || state.cursorMode === "draw-poly") {
      finishPolygonDrawMode();
    } else {
      startPolygonEditMode(null);
    }
  };
  modeBannerAction.onclick = () => {
    if (state.cursorMode === "draw-poly") finishPolygonDrawMode();
    else {
      state.pendingLinkIndices = [];
      state.pendingMissingCodes = [];
      state.editingZoneId = null;
      setCursorMode("nav");
      rebuildOverlayLayers();
    }
  };

  // =========================================================================
  // 15. CARGA DE ARCHIVOS (KMZ, JSON, PRESET PT-263781, CSV) Y PORTAPAPELES
  // =========================================================================
  async function readKmzBytes(ab) {
    const v = new DataView(ab);
    let end = -1;
    for (let i = ab.byteLength - 22; i >= Math.max(0, ab.byteLength - 65557); --i) {
      if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw Error("Índice ZIP no válido.");
    const total = v.getUint16(end + 10, true);
    let p = v.getUint32(end + 16, true);
    const list = [];
    for (let i = 0; i < total; i++) {
      const metodo = v.getUint16(p + 10, true);
      const comp = v.getUint32(p + 20, true);
      const nl = v.getUint16(p + 28, true);
      const el = v.getUint16(p + 30, true);
      const cl = v.getUint16(p + 32, true);
      const loc = v.getUint32(p + 42, true);
      const nombre = new TextDecoder().decode(new Uint8Array(ab, p + 46, nl));
      if (nombre.toLowerCase().endsWith(".kml") && !nombre.startsWith("__MACOSX/")) {
        list.push({ nombre, metodo, comp, loc });
      }
      p += 46 + nl + el + cl;
    }
    list.sort((a, b) => Number(b.nombre.toLowerCase().endsWith("doc.kml")) - Number(a.nombre.toLowerCase().endsWith("doc.kml")));
    const a = list[0];
    if (!a) throw Error("El KMZ no contiene ningún KML.");
    const inicio = a.loc + 30 + v.getUint16(a.loc + 26, true) + v.getUint16(a.loc + 28, true);
    const bytes = new Uint8Array(ab, inicio, a.comp);
    if (a.metodo === 0) return new TextDecoder().decode(bytes);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }

  function extractGeoms(g) {
    if (!g) return [];
    const t = g.getType();
    if (t === "Point") return [g.getCoordinates()];
    if (t === "MultiPoint") return g.getCoordinates();
    if (t === "GeometryCollection") return g.getGeometries().flatMap(extractGeoms);
    return [];
  }

  function loadProjectData(data) {
    state.zones.clear();
    for (const [id, def] of [
      ["D", { id: "D", name: "Zona desconectada (D)", color: "#DC2626", customRing: null }],
      ["T", { id: "T", name: "Zona de trabajo (T)", color: "#00C853", customRing: null }],
      ["F", { id: "F", name: "Punto de faenas (F)", color: "#FF6D00", customRing: null }]
    ]) {
      state.zones.set(id, def);
    }

    let idx = 0;
    for (const b of data.bloques || []) {
      const color = isHex(b.color) ? b.color : HIGH_CONTRAST_PALETTE[idx % HIGH_CONTRAST_PALETTE.length];
      state.zones.set(b.id, {
        id: b.id,
        name: b.nombre || b.id,
        color,
        customRing: Array.isArray(b.customRing) ? b.customRing : null
      });
      idx++;
    }
    // Compatibilidad con campo legacy `data.zona.outline`
    if (Array.isArray(data?.zona?.outline) && data.zona.outline.length >= 3 && state.zones.has("D")) {
      state.zones.get("D").customRing = data.zona.outline;
    }

    if (Array.isArray(data.supervisors) && data.supervisors.length) {
      state.supervisors.clear();
      for (const s of data.supervisors) {
        if (s?.id) state.supervisors.set(s.id, { ...s });
      }
    } else {
      state.supervisors = new Map(DEFAULT_SUPERVISORS.map(s => [s.id, { ...s }]));
    }
    state.multiSupervisorEnabled = Boolean(data.multiSupervisorEnabled);
    // Las columnas ocultas son preferencia del proyecto: se validan contra la lista
    // vigente para que una columna renombrada o retirada no quede como id fantasma.
    state.hiddenColumns = new Set(
      Array.isArray(data.hiddenColumns)
        ? data.hiddenColumns.filter(id => TABLE_COLUMNS.some(c => c.id === id && c.id !== "check"))
        : defaultHiddenColumns()
    );
    state.columnOrder = Array.isArray(data.columnOrder) && data.columnOrder.length
      ? (() => {
          const known = new Set(TABLE_COLUMNS.map(c => c.id));
          const kept = data.columnOrder.filter(id => known.has(id));
          for (const c of TABLE_COLUMNS) if (!kept.includes(c.id)) kept.push(c.id);
          return kept;
        })()
      : TABLE_COLUMNS.map(c => c.id);
    if (Array.isArray(data.statuses) && data.statuses.length) {
      state.statuses.clear();
      for (const st of data.statuses) {
        if (st?.id) state.statuses.set(st.id, { ...st });
      }
    }
    state.spans = Array.isArray(data.spans) ? data.spans : [];
    state.graphNodes = Array.isArray(data.graphNodes) ? data.graphNodes : [];

    const feats = (data.registros || []).map(r => {
      const sid = r.supervisorId || LEGACY_COLOR_TO_SUP[r.supervisorColor] || "default";
      const zId = String(r.bloqueId || "");
      return new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat([Number(r.longitud), Number(r.latitud)], map.getView().getProjection())),
        id: String(r.id),
        numero: Number(r.numero),
        tipo: r.tipo || "PUNTO",
        codigo: String(r.codigo || ""),
        supervisorId: sid,
        bloqueId: zId,
        bloques: Array.isArray(r.bloques) ? r.bloques : (zId ? [zId] : []),
        aperturasIds: Array.isArray(r.aperturasIds) ? r.aperturasIds : [],
        tipoEquipo: String(r.tipoEquipo || ""),
        rolPT: String(r.rolPT || r.rol || ""),
        accionPT: String(r.accionPT || ""),
        esRemate: Boolean(r.esRemate),
        esIntermedio: Boolean(r.esIntermedio),
        sseeCode: r.sseeCode || "",
        codigoTerreno: String(r.codigoTerreno || ""),
        estadoEjec: String(r.estadoEjec || "pendiente"),
        proteccionTipo: String(r.proteccionTipo || mapProtectionFromText(r.tipoEquipo) || (r.sseeCode ? "DF_XS" : "")),
        eptTipo: String(r.eptTipo || (/ept/i.test(r.tipoEquipo || "") ? r.tipoEquipo : "")),
        gnatMeta: r.gnatMeta || null,
        syncNote: String(r.syncNote || ""),
        observaciones: Array.isArray(r.observaciones) ? r.observaciones : [],
        syncStatus: r.syncNote ? "mismatch" : "ok",
        colorPersonalizado: String(r.colorPersonalizado || "")
      });
    });

    state.projectId = data.id || ("proj-" + Date.now());
    state.projectName = data.nombre || "Proyecto importado";
    projNameInput.value = state.projectName;
    state.points = feats;
    state.selected.clear();
    state.focused = -1;
    state.filterZones.clear();
    state.filterSups.clear();
    styleCache = new WeakMap();
    ensureVectorLayer();
    refreshAll();
    if (state.points.length) fitPoints(state.points.map((_, i) => i));
    autosaveNow();
  }

  // Carga directa de un archivo Preset de Permiso de Trabajo (como pt-263781.json)
  async function loadPermitPresetData(preset) {
    closeModal();
    state.projectId = "preset-" + (preset.preset || Date.now());
    state.projectName = preset.nombre || preset.preset || "Permiso PT";
    projNameInput.value = state.projectName;
    state.points = [];
    state.spans = [];
        state.graphNodes = [];
    state.selected.clear();
    state.zones.get("D").customRing = null;
    state.zones.get("T").customRing = null;
    state.zones.get("F").customRing = null;

    const roles = Array.isArray(preset.roles) ? preset.roles : [];
    setCursorMode("nav", `⏳ Resolviendo ${roles.length} referencias del PT en GNAT...`);
    let resolvedCount = 0;

    for (const r of roles) {
      const code = String(r.codigo || "").trim().toUpperCase();
      if (!code) continue;
      modeBannerText.textContent = `⏳ Resolviendo ${r.rol || ""} (${code}) en GNAT...`;
      const hit = await resolveCodeInGnat(code, true);
      if (!hit?.lonlat) continue;
      resolvedCount++;

      // Clasificación fiel al PDF del PT: D = Zona desconectada, T = Zona de trabajo, F = Punto de faenas
      const rolStr = String(r.rol || "").toUpperCase();
      const zoneId = rolStr.startsWith("F") ? "F" : rolStr.startsWith("T") ? "T" : "D";
      const isOpening = String(r.tipo || "").toLowerCase() === "apertura" || String(r.estadoPT || "").toLowerCase() === "abierto";

      upsertPointOnMap({
        codigo: hit.code || code,
        lonlat: hit.lonlat,
        tipo: isOpening ? "APERTURA" : "PUNTO",
        bloqueId: zoneId,
        bloques: [zoneId],
        tipoEquipo: r.equipo || (r.estadoPT === "Aterrizado" ? "EPT" : ""),
        rolPT: rolStr,
        accionPT: r.accion || ""
      });
      ensureVectorLayer();
      refreshAll();
    }

    setCursorMode("nav");
    if (state.points.length) {
      fitPoints(state.points.map((_, i) => i));
      // Ejecutar automáticamente el trazado de tramos MT, aperturas y remates
      await runMtNetworkDiscovery();
    } else {
      showToast(`No se pudieron resolver las coordenadas en GNAT (${resolvedCount}/${roles.length}).`, true);
    }
  }

  async function handleSmartFile(file) {
    if (!file) return;
    try {
      const ab = await file.arrayBuffer();
      const head = new Uint8Array(ab.slice(0, 4));
      const isZip = head[0] === 0x50 && head[1] === 0x4B;

      if (isZip) {
        const kmlText = await readKmzBytes(ab);
        await parseAndRouteKml(kmlText, file.name.replace(/\.(kmz|kml)$/i, ""));
        return;
      }

      const text = new TextDecoder().decode(ab).replace(/^\ufeff/, "").trim();
      if (text.startsWith("{")) {
        const data = JSON.parse(text);
        if (data?.formato === "CentralityLocal" && Array.isArray(data.registros)) {
          loadProjectData(data);
          closeModal();
          showToast(`Proyecto "${state.projectName}" abierto (${state.points.length} registros).`);
          return;
        }
        if (Array.isArray(data?.roles) || data?.permiso) {
          await loadPermitPresetData(data);
          return;
        }
      }

      if (text.includes("<kml") || text.includes("<Placemark")) {
        await parseAndRouteKml(text, file.name.replace(/\.(kmz|kml)$/i, ""));
        return;
      }

      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length >= 2 && (lines[0].includes(";") || lines[0].includes(","))) {
        const sep = lines[0].includes(";") ? ";" : ",";
        const cols = lines[0].split(sep).map(c => c.trim().replace(/^"|"$/g, "").toLowerCase());
        const lonIdx = cols.findIndex(c => c.includes("long"));
        const latIdx = cols.findIndex(c => c.includes("lat"));
        const codeIdx = cols.findIndex(c => c.includes("subest") || c.includes("cod"));
        if (lonIdx >= 0 && latIdx >= 0) {
          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(sep).map(s => s.trim().replace(/^"|"$/g, ""));
            const lon = Number(String(parts[lonIdx] || "").replace(",", "."));
            const lat = Number(String(parts[latIdx] || "").replace(",", "."));
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
            upsertPointOnMap({
              codigo: String(parts[codeIdx] || `P-${i}`),
              lonlat: [lon, lat],
              tipo: "PUNTO",
              bloqueId: "T",
              bloques: ["T"]
            });
          }
          ensureVectorLayer();
          refreshAll();
          fitPoints(state.points.map((_, i) => i));
          closeModal();
          autosaveNow();
          return;
        }
      }

      throw Error("Formato no reconocido. Usa KMZ, KML, Proyecto JSON, Preset PT o CSV.");
    } catch (e) {
      showToast("Error al abrir: " + e.message, true);
    } finally {
      hiddenFileInput.value = "";
    }
  }

  async function parseAndRouteKml(kmlText, baseName) {
    const xml = new DOMParser().parseFromString(kmlText, "application/xml");
    if (xml.querySelector("parsererror")) throw Error("El KML interno no es XML válido.");
    const fmt = new ol.format.KML({ extractStyles: false, showPointNames: false });
    const rawFeats = fmt.readFeatures(kmlText, {
      dataProjection: "EPSG:4326",
      featureProjection: map.getView().getProjection()
    });
    const proj = map.getView().getProjection();
    let count = 0;
    for (const orig of rawFeats) {
      const code = String(orig.get("name") || "").trim() || `P-${count + 1}`;
      for (const xy of extractGeoms(orig.getGeometry())) {
        if (!xy.every(Number.isFinite)) continue;
        const [lon, lat] = ol.proj.toLonLat(xy, proj);
        upsertPointOnMap({ codigo: code, lonlat: [lon, lat], tipo: "PUNTO", bloqueId: "T", bloques: ["T"] });
        count++;
      }
    }
    if (!count) throw Error("El archivo KMZ/KML no contiene puntos.");
    state.projectName = baseName || state.projectName;
    projNameInput.value = state.projectName;
    ensureVectorLayer();
    refreshAll();
    fitPoints(state.points.map((_, i) => i));
    closeModal();
    autosaveNow();
    showToast(`${count} punto(s) cargados desde KMZ.`);
  }

  hiddenFileInput.onchange = () => handleSmartFile(hiddenFileInput.files?.[0]);

  function downloadBlob(name, content, mime) {
    const url = w.URL.createObjectURL(new Blob([content], { type: mime }));
    const a = doc.createElement("a");
    a.href = url;
    a.download = name;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    w.setTimeout(() => w.URL.revokeObjectURL(url), 2000);
  }

  function crc32Bytes(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) {
      c ^= u8[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function buildSingleFileZipBlob(filename, contentBytes) {
    const nameBytes = new TextEncoder().encode(filename);
    const crc = crc32Bytes(contentBytes);
    const size = contentBytes.length;
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lfh.set(nameBytes, 30);

    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cdh.set(nameBytes, 46);

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 1, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, cdh.length, true);
    ev.setUint32(16, lfh.length + size, true);

    return new Blob([lfh, contentBytes, cdh, eocd], { type: "application/vnd.google-earth.kmz" });
  }

  function downloadKMZ() {
    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const kmlColor = (hex, alpha = "ff") => {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || "#1D4ED8"));
      return m ? `${alpha}${m[3]}${m[2]}${m[1]}`.toLowerCase() : `${alpha}d84e1d`;
    };
    const proj = map.getView().getProjection();

    let zonePlacemarks = "";
    for (const z of state.zones.values()) {
      let ring = Array.isArray(z.customRing) && z.customRing.length >= 3 ? z.customRing : null;
      if (!ring) {
        const zPts = state.points.filter(f => getPointZoneIds(f).includes(z.id)).map(f => ol.proj.toLonLat(f.getGeometry().getCoordinates(), proj));
        if (z.id === "D" && Array.isArray(state.graphNodes)) {
          for (const gn of state.graphNodes) if (Array.isArray(gn.lonlat)) zPts.push(gn.lonlat);
        }
        if (zPts.length >= 3) ring = convexHullLonLat(zPts);
      }
      if (!ring || ring.length < 3) continue;
      const closed = [...ring, ring[0]].map(c => `${c[0]},${c[1]},0`).join(" ");
      zonePlacemarks += `<Placemark><name>${esc(z.name)}</name><Style><LineStyle><color>${kmlColor(z.color, "ff")}</color><width>2.5</width></LineStyle><PolyStyle><color>${kmlColor(z.color, "33")}</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>${closed}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
    }

    let ptPlacemarks = "";
    let rematePlacemarks = "";
    for (const f of state.points) {
      const [lon, lat] = ol.proj.toLonLat(f.getGeometry().getCoordinates(), proj);
      const code = getPointCode(f);
      const rol = f.get("rolPT") ? `${f.get("rolPT")} · ` : "";
      const desc = `${f.get("tipoEquipo") || ""} ${f.get("sseeCode") || ""} ${f.get("accionPT") || ""}`.trim();
      const pm = `<Placemark><name>${esc(rol + code)}</name><description>${esc(desc)}</description><Point><coordinates>${lon},${lat},0</coordinates></Point></Placemark>`;
      if (f.get("esRemate")) rematePlacemarks += pm;
      else ptPlacemarks += pm;
    }

    let spanPlacemarks = "";
    for (const sp of state.spans) {
      if (!Array.isArray(sp.coords) || sp.coords.length < 2) continue;
      const cStr = sp.coords.map(c => `${c[0]},${c[1]},0`).join(" ");
      spanPlacemarks += `<Placemark><name>${esc(sp.display || `${sp.from}-${sp.to}`)}</name><Style><LineStyle><color>ff2626dc</color><width>3</width></LineStyle></Style><LineString><coordinates>${cStr}</coordinates></LineString></Placemark>`;
    }

    let interPlacemarks = "";
    const ptCodes = new Set(state.points.map(p => getPointCode(p).toUpperCase()));
    for (const gn of state.graphNodes) {
      if (!Array.isArray(gn.lonlat) || ptCodes.has(gn.code)) continue;
      const d = [gn.sseeCode, gn.coci3f ? `COCI 3F: ${gn.coci3f} kA` : ""].filter(Boolean).join(" · ");
      interPlacemarks += `<Placemark><name>${esc(gn.code)}</name><description>${esc(d)}</description><Point><coordinates>${gn.lonlat[0]},${gn.lonlat[1]},0</coordinates></Point></Placemark>`;
    }

    const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(state.projectName)}</name>` +
      `<Folder><name>Zonas D / T / F</name>${zonePlacemarks}</Folder>` +
      `<Folder><name>Puntos PT y Aperturas</name>${ptPlacemarks}</Folder>` +
      `<Folder><name>Remates MT</name>${rematePlacemarks}</Folder>` +
      `<Folder><name>Red MT Desconectada</name>${spanPlacemarks}</Folder>` +
      `<Folder><name>Postes Intermedios</name>${interPlacemarks}</Folder>` +
      `</Document></kml>`;

    const blob = buildSingleFileZipBlob("doc.kml", new TextEncoder().encode(kml));
    const safe = state.projectName.replace(/[^a-zA-Z0-9._-]+/g, "_") || "centrality-red-mt";
    const url = w.URL.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = url;
    a.download = safe + ".kmz";
    doc.body.appendChild(a);
    a.click();
    a.remove();
    w.setTimeout(() => w.URL.revokeObjectURL(url), 2000);
    showToast("Mapa completo exportado (.kmz).");
  }

  function downloadJSON() {
    const payload = serializeProjectPayload();
    const safe = state.projectName.replace(/[^a-zA-Z0-9._-]+/g, "_") || "centrality-proyecto";
    downloadBlob(safe + ".json", JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
    showToast("Proyecto guardado en PC (.json).");
  }

  function downloadCSV() {
    const q = (v) => {
      const s = String(v ?? "");
      return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const cociByCode = new Map((state.graphNodes || []).map(gn => [String(gn.code || "").toUpperCase(), gn]));
    const rows = [["Categoria", "Rol", "Tipo", "Numero", "Codigo", "CodigoTerreno", "Estado", "TipoEquipo", "SSEE", "COCI_3F_kA", "Longitud", "Latitud", "Zonas_DTF", "Accion", "Observaciones"]];
    const seenCodes = new Set();
    for (const f of state.points) {
      const [lon, lat] = f.getGeometry() ? ol.proj.toLonLat(f.getGeometry().getCoordinates(), map.getView().getProjection()) : ["", ""];
      const code = getPointCode(f);
      const uCode = code.toUpperCase();
      seenCodes.add(uCode);
      const gn = cociByCode.get(uCode);
      const cat = f.get("tipo") === "APERTURA" ? "Apertura" : f.get("esRemate") ? "Remate" : f.get("esIntermedio") ? "Intermedio" : "Poste PT";
      const stName = state.statuses.get(f.get("estadoEjec") || "pendiente")?.name || "Pendiente";
      const obsStr = (Array.isArray(f.get("observaciones")) ? f.get("observaciones") : []).map(o => `[${o.at}] ${o.text}`).join(" | ");
      rows.push([
        cat,
        f.get("rolPT") || "",
        f.get("tipo") || "PUNTO",
        f.get("numero"),
        code,
        f.get("codigoTerreno") || "",
        stName,
        f.get("tipoEquipo") || "",
        f.get("sseeCode") || gn?.sseeCode || "",
        gn?.coci3f ?? "",
        lon,
        lat,
        getPointZoneIds(f).join("|"),
        f.get("accionPT") || "",
        obsStr
      ]);
    }
    let gi = 1;
    for (const gn of (state.graphNodes || [])) {
      const uCode = String(gn.code || "").toUpperCase();
      if (!uCode || seenCodes.has(uCode)) continue;
      seenCodes.add(uCode);
      rows.push([
        "Intermedio",
        `G${gi++}`,
        "INTERMEDIO",
        "",
        gn.code,
        "",
        "",
        "",
        gn.sseeCode || "",
        gn.coci3f ?? "",
        gn.lonlat?.[0] ?? "",
        gn.lonlat?.[1] ?? "",
        "D",
        "",
        ""
      ]);
    }
    const safe = state.projectName.replace(/[^a-zA-Z0-9._-]+/g, "_") || "centrality-tabla";
    downloadBlob(safe + ".csv", "\ufeff" + rows.map(r => r.map(q).join(";")).join("\r\n"), "text/csv;charset=utf-8");
    showToast(`CSV exportado (${rows.length - 1} registros incl. remates e intermedios).`);
  }

  // =========================================================================
  // 16. MODALES: INICIO, EDITAR PUNTO, BUSCADOR/PEGADO GNAT, EQUIPO, DEMO PDF
  // =========================================================================
  function closeModal() {
    modalBackdrop.classList.add("hidden");
    modalBackdrop.replaceChildren();
    // U6: el foco vuelve a quien abrió la ventana.
    const back = modalReturnFocus;
    modalReturnFocus = null;
    if (back && typeof back.focus === "function") {
      try { back.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  // U6: al abrir una ventana el foco va al primer campo útil; si no hay campos,
  // a la tarjeta misma. Una sola función, ningún modal lo declara por su cuenta.
  let modalReturnFocus = null;
  function focusModalFirstField(card) {
    if (!card || card.__focused) return;
    card.__focused = true;
    const fields = [...card.querySelectorAll("input, textarea, select")]
      .filter((el) => el.type !== "hidden" && !el.disabled && el.getClientRects().length > 0);
    const target = fields[0] || card;
    if (target === card) card.tabIndex = -1;
    try { target.focus({ preventScroll: true }); } catch (_) {}
  }

  // --- Política única de capas (U1, U16) -----------------------------------
  // Un solo lugar decide cuándo y cómo se cierra una capa. Ningún botón trae su
  // propio cierre ni su propia confirmación: todo pasa por acá.
  function modalIsOpen() {
    return !modalBackdrop.classList.contains("hidden");
  }

  const modalFieldValues = (card) => [...card.querySelectorAll("input, textarea, select")]
    .map((el) => (el.type === "checkbox" ? String(el.checked) : String(el.value)));

  function snapshotModalInputs(card) {
    card.__initial = modalFieldValues(card);
  }

  function modalHasUnsavedChanges() {
    const card = modalBackdrop.querySelector(".modal-card");
    if (!card || !card.__initial) return false;
    const now = modalFieldValues(card);
    if (now.length !== card.__initial.length) return true;
    return now.some((v, i) => v !== card.__initial[i]);
  }

  // El estado inicial se toma cuando la ventana ya terminó de construirse, así
  // ningún modal tiene que acordarse de declararlo a mano.
  try {
    new w.MutationObserver(() => {
      const card = modalBackdrop.querySelector(".modal-card");
      if (!card) return;
      w.setTimeout(() => {
        if (!card.__initial) snapshotModalInputs(card);
        if (!card.__focused) {
          if (!modalReturnFocus) {
            // `root` es un div: el que sabe quién tiene el foco es el ShadowRoot.
            const inner = (shadow && shadow.activeElement) || null;
            const outer = doc.activeElement;
            modalReturnFocus = inner || (outer && outer !== doc.body && outer !== host ? outer : null);
          }
          focusModalFirstField(card);
        }
      }, 0);
    }).observe(modalBackdrop, { childList: true });
  } catch (_) {}

  // "Empezar en mapa vacío" no creaba nada: sólo cerraba el modal, así que el
  // proyecto anterior seguía cargado. Acá se arranca un proyecto nuevo de verdad,
  // reusando el mismo camino que usa el undo (serializeProjectPayload ↔ loadProjectData).
  function startBlankProject() {
    loadProjectData({
      version: 6,
      formato: "CentralityLocal",
      id: "proj-" + Date.now(),
      nombre: "Proyecto sin título",
      updatedAt: Date.now(),
      multiSupervisorEnabled: false,
      hiddenColumns: [...defaultHiddenColumns()],
      columnOrder: TABLE_COLUMNS.map(c => c.id),
      supervisors: [],
      statuses: [],
      bloques: [],
      spans: [],
      graphNodes: [],
      registros: []
    });
    state.undoStack = [];
    closeModal();
    showToast("Proyecto nuevo en blanco");
  }

  async function openStartModal() {
    modalBackdrop.replaceChildren();
    modalBackdrop.classList.remove("hidden");
    const card = el("div", "modal-card", null, modalBackdrop);
    const head = el("div", "modal-head", null, card);
    el("h2", "", "Centrality · Planificación D / T / F", head);
    const bBlank = el("button", "btn-primary", "Empezar en mapa vacío", head);
    bBlank.onclick = () => startBlankProject();

    const body = el("div", "modal-body", null, card);
    const dz = el("div", "dropzone", null, body);
    el("div", "", "📂 Arrastra aquí un KMZ, Proyecto (.json), Preset PT (ej. pt-263781.json) o CSV", dz).style.fontWeight = "700";
    el("div", "", "O haz clic para examinar archivos · También puedes cerrar y buscar códigos directo en GNAT", dz).style.cssText = "font-size:12px;color:var(--text-secondary);margin-top:4px;";
    dz.onclick = () => hiddenFileInput.click();
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("drag"); };
    dz.ondragleave = () => dz.classList.remove("drag");
    dz.ondrop = (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
      handleSmartFile(e.dataTransfer?.files?.[0]);
    };

    const recHeader = el("div", "", "Proyectos recientes (autoguardados en este navegador)", body);
    recHeader.style.cssText = "font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-top:6px;";

    const recList = el("div", "", null, body);
    recList.style.cssText = "display:flex;flex-direction:column;gap:6px;";
    try {
      const projs = await dbListProjects();
      if (!projs.length) {
        el("div", "", "Sin proyectos recientes. Usa 'Empezar en mapa vacío' o importa un archivo.", recList).style.cssText = "font-size:12px;color:var(--text-secondary);";
      } else {
        for (const p of projs.slice(0, 10)) {
          const item = el("div", "recent-item", null, recList);
          const info = el("div", "", null, item);
          el("div", "", p.name, info).style.fontWeight = "600";
          const dt = new Date(p.updatedAt || Date.now()).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
          el("div", "", `${p.pointCount || 0} puntos · ${dt}`, info).style.cssText = "font-size:11px;color:var(--text-secondary);";
          const bDel = el("button", "btn-outline icon-btn", "🗑", item);
          bDel.onclick = async (ev) => {
            ev.stopPropagation();
            await dbDeleteProject(p.id);
            openStartModal();
          };
          item.onclick = () => {
            loadProjectData(p.payload);
            closeModal();
            showToast(`Abierto: ${p.name}`);
          };
        }
      }
    } catch (_) {}
  }

  function openEditPointModal(idx) {
    const f = state.points[idx];
    if (!f) return;
    modalBackdrop.replaceChildren();
    modalBackdrop.classList.remove("hidden");
    const card = el("div", "modal-card", null, modalBackdrop);
    card.style.width = "min(560px, 95vw)";
    const head = el("div", "modal-head", null, card);
    const titleWrap = el("div", "", null, head);
    titleWrap.style.cssText = "display:flex;align-items:center;gap:8px;";
    el("h2", "code-mono", `${getPointCode(f)}`, titleWrap).style.fontSize = "15px";
    const stObjHead = state.statuses.get(f.get("estadoEjec") || "pendiente");
    if (stObjHead) {
      const sp = el("span", "inter-badge", stObjHead.name, titleWrap);
      sp.style.cssText = `background:${hexToRgba(stObjHead.color, 0.14)};color:${stObjHead.color};border:1px solid ${hexToRgba(stObjHead.color, 0.35)};`;
    }
    const bClose = el("button", "btn-outline icon-btn", "", head);
    setBtn(bClose, "x", "", 14);
    bClose.onclick = closeModal;

    const body = el("div", "modal-body", null, card);
    const localObs = Array.isArray(f.get("observaciones")) ? f.get("observaciones").map(x => ({ ...x })) : [];

    // Tabs: Propiedades | Observaciones (N)
    const tabBar = el("div", "modal-tabs", null, body);
    const tProp = el("button", "modal-tab active", "Propiedades y GNAT", tabBar);
    const tObs = el("button", "modal-tab", `Observaciones (${localObs.length})`, tabBar);

    const paneProp = el("div", "", null, body);
    paneProp.style.cssText = "display:flex;flex-direction:column;gap:10px;";
    const paneObs = el("div", "", null, body);
    paneObs.style.cssText = "display:none;flex-direction:column;gap:8px;";

    tProp.onclick = () => { tProp.classList.add("active"); tObs.classList.remove("active"); paneProp.style.display = "flex"; paneObs.style.display = "none"; };
    tObs.onclick = () => { tObs.classList.add("active"); tProp.classList.remove("active"); paneObs.style.display = "flex"; paneProp.style.display = "none"; };

    // 1. Metadata GNAT card inside Propiedades
    const metaCard = el("div", "meta-card", null, paneProp);
    let inpSsee, selProt;
    const renderMetaCard = () => {
      metaCard.replaceChildren();
      const gm = f.get("gnatMeta") || {};
      const st = f.get("syncStatus") || "ok";
      const note = String(f.get("syncNote") || "");
      const mHead = el("div", "meta-head", null, metaCard);
      const badgeTxt = st === "loading" ? "Sincronizando con GNAT..."
        : st === "mismatch" ? "Inconsistencia detectada"
        : st === "not_found" ? "No encontrado en GNAT"
        : gm.syncedAt ? `Metadata GNAT (${gm.syncedAt})`
        : "Metadata GNAT (pendiente)";
      const lbl = el("span", "", badgeTxt, mHead);
      lbl.style.color = (st === "mismatch" || st === "not_found") ? "#B45309" : gm.syncedAt ? "#15803D" : "#475569";

      const bVerify = el("button", "btn-outline", "", mHead);
      setBtn(bVerify, "refresh", "Verificar", 12);
      bVerify.style.cssText = "padding:2px 8px;font-size:11px;";
      bVerify.onclick = async () => {
        bVerify.disabled = true;
        await syncSinglePointWithGnat(f, true);
        bVerify.disabled = false;
        renderMetaCard();
        if (inpSsee && f.get("sseeCode") && !inpSsee.value.trim()) inpSsee.value = String(f.get("sseeCode")).replace(/^SSEE\s+/i, "");
        if (selProt && f.get("proteccionTipo") && !selProt.value) selProt.value = f.get("proteccionTipo");
      };

      const mGrid = el("div", "meta-grid", null, metaCard);
      const kv = (k, v) => {
        const box = el("div", "meta-kv", null, mGrid);
        el("div", "meta-k", k, box);
        const val = el("div", "meta-v", v || "—", box);
        val.title = String(v || "—");
      };
      const curLL = f.getGeometry() ? ol.proj.toLonLat(f.getGeometry().getCoordinates(), map.getView().getProjection()) : null;
      kv("S/E GNAT", gm.sseeCode || f.get("sseeCode") || "—");
      kv("COCI 3F", gm.coci3f != null ? `${gm.coci3f} kA` : "—");
      kv("Equipo GNAT", gm.deviceDisplay || gm.display || "—");
      kv("Poste GNAT", gm.poleCode || "—");
      kv("Dist. Excel↔GNAT", gm.distMeters != null ? `${Math.round(gm.distMeters)} m` : "—");
      kv("Coordenadas", curLL ? `${curLL[1].toFixed(5)}, ${curLL[0].toFixed(5)}` : "Sin ubicar");

      if (Array.isArray(gm.availableDevices) && gm.availableDevices.length > 1) {
        const devRow = el("div", "", null, metaCard);
        devRow.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding-top:2px;";
        el("span", "", "Elegir equipo en este poste:", devRow).style.cssText = "font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;";
        for (const d of gm.availableDevices) {
          const isCur = curLL && Array.isArray(d.lonlat) && haversineMeters(curLL, d.lonlat) < 3;
          const bDev = el("button", isCur ? "active-pill" : "btn-outline", d.display.replace(new RegExp("^" + getPointCode(f) + "\\s*", "i"), "").slice(0, 34), devRow);
          bDev.style.cssText = "padding:2px 7px;font-size:10.5px;";
          bDev.title = `Ubicar ✕ exactamente sobre: ${d.display}`;
          bDev.onclick = () => {
            const proj = map.getView().getProjection();
            f.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(d.lonlat, proj)));
            if (d.protId) {
              f.set("proteccionTipo", d.protId);
              if (selProt) selProt.value = d.protId;
            }
            gm.deviceDisplay = d.display;
            gm.gnatLonLat = d.lonlat;
            gm.lockedDeviceId = d.surrogateId || 0;
            gm.distMeters = 0;
            f.set("gnatMeta", gm);
            f.set("syncNote", "");
            f.set("syncStatus", "ok");
            ensureVectorLayer();
            markDirty();
            refreshAll();
            renderMetaCard();
            showToast(`✕ ubicada sobre: ${d.display}`);
          };
        }
      }

      if (note) {
        const alertBox = el("div", "meta-alert", null, metaCard);
        el("span", "", note, alertBox);
        if (Array.isArray(gm.gnatLonLat) && gm.gnatLonLat.length === 2) {
          const bSnap = el("button", "btn-outline", "Usar coord. GNAT", alertBox);
          bSnap.style.cssText = "padding:2px 7px;font-size:10px;white-space:nowrap;";
          bSnap.onclick = () => {
            const proj = map.getView().getProjection();
            f.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(gm.gnatLonLat, proj)));
            gm.distMeters = 0; f.set("gnatMeta", gm); f.set("syncNote", ""); f.set("syncStatus", "ok");
            ensureVectorLayer(); markDirty(); refreshAll(); renderMetaCard();
            showToast("Coordenada ajustada al poste real en GNAT.");
          };
        }
      }
    };
    renderMetaCard();

    // 2. Compact 2-column form grid (fits cleanly without vertical scrolling)
    const grid = el("div", "form-grid-2col", null, paneProp);
    const mkField = (label, full = false) => {
      const box = el("div", "field-stack" + (full ? " full" : ""), null, grid);
      el("label", "", label, box);
      return box;
    };

    const fCode = mkField("Código Poste (GNAT)");
    const inpCode = el("input", "code-mono", null, fCode);
    inpCode.value = getPointCode(f);

    const fNumRol = mkField("N° / Rol PT");
    const nrRow = el("div", "", null, fNumRol);
    nrRow.style.cssText = "display:flex;gap:6px;";
    const inpNum = el("input", "", null, nrRow);
    inpNum.type = "number"; inpNum.style.width = "70px"; inpNum.value = String(f.get("numero") || "");
    const inpRol = el("input", "", null, nrRow);
    inpRol.placeholder = "Ej. T1, F1"; inpRol.value = String(f.get("rolPT") || "");

    const fSsee = mkField("Cód. Subestación (S/E)");
    inpSsee = el("input", "code-mono", null, fSsee);
    inpSsee.placeholder = "Ej. F59430 (asume DF XS)";
    inpSsee.value = String(f.get("sseeCode") || "").replace(/^SSEE\s+/i, "");

    const fTer = mkField("Código en terreno");
    const inpTer = el("input", "code-mono", null, fTer);
    inpTer.placeholder = "Buscable desde el filtro";
    inpTer.value = String(f.get("codigoTerreno") || "");

    const fSt = mkField("Estado de ejecución");
    const selSt = el("select", "", null, fSt);
    for (const st of state.statuses.values()) { const o = el("option", "", st.name, selSt); o.value = st.id; }
    selSt.value = String(f.get("estadoEjec") || "pendiente");

    const fKind = mkField("Categoría");
    const selKind = el("select", "", null, fKind);
    [["PUNTO", "Poste / Punto"], ["APERTURA", "Apertura (✕)"]].forEach(([v, t]) => { const o = el("option", "", t, selKind); o.value = v; });
    selKind.value = f.get("tipo") || "PUNTO";

    const fProt = mkField("Protección / Apertura");
    selProt = el("select", "", null, fProt);
    PROTECTION_TYPES.forEach(p => { const o = el("option", "", p.label, selProt); o.value = p.id; });
    selProt.value = String(f.get("proteccionTipo") || "");

    const fEpt = mkField("Puesta a Tierra (EPT)");
    const selEpt = el("select", "", null, fEpt);
    EPT_TYPES.forEach(t => { const o = el("option", "", t || "— Ninguna —", selEpt); o.value = t; });
    selEpt.value = String(f.get("eptTipo") || "");

    const fAcc = mkField("Acción a ejecutar", true);
    const inpAccion = el("input", "", null, fAcc);
    inpAccion.placeholder = "Ej. Abrir DBC, instalar EPT BT y MT...";
    inpAccion.value = String(f.get("accionPT") || "");

    // Tab 2: Observaciones con fecha y hora automática
    const obsList = el("div", "obs-list", null, paneObs);
    obsList.style.minHeight = "180px";
    obsList.style.maxHeight = "260px";
    const renderObs = () => {
      obsList.replaceChildren();
      tObs.textContent = `Observaciones (${localObs.length})`;
      if (!localObs.length) {
        el("div", "", "Sin observaciones registradas.", obsList).style.cssText = "font-size:12px;color:#94A3B8;padding:12px;text-align:center;";
        return;
      }
      for (const o of [...localObs].reverse()) {
        const it = el("div", "obs-item", null, obsList);
        el("div", "obs-date", o.at || "", it);
        el("div", "", o.text || "", it);
      }
    };
    renderObs();

    const addObsRow = el("div", "inline-input-row", null, paneObs);
    const inpObs = el("input", "", null, addObsRow);
    inpObs.placeholder = "Escribir observación y presionar Enter...";
    const bAddObs = el("button", "btn-outline", "+ Agregar", addObsRow);
    const pushObs = () => {
      const txt = inpObs.value.trim();
      if (!txt) return;
      const stamp = new Date().toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
      localObs.push({ text: txt, at: stamp });
      inpObs.value = "";
      renderObs();
    };
    bAddObs.onclick = pushObs;
    inpObs.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); pushObs(); } };

    const footer = el("div", "", null, body);
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:4px;";
    const bCancel = el("button", "btn-outline", "Cancelar", footer);
    bCancel.onclick = closeModal;
    const bSave = el("button", "btn-primary", "Guardar cambios", footer);
    bSave.onclick = () => {
      pushObs();
      pushUndoSnapshot(`Editar ${getPointCode(f)}`);
      const prevProt = String(f.get("proteccionTipo") || "");
      const prevSsee = String(f.get("sseeCode") || "");
      if (Number(inpNum.value) > 0) f.set("numero", Number(inpNum.value));
      f.set("rolPT", inpRol.value.trim());
      f.set("codigo", inpCode.value.trim() || "Sin código");
      const sseeClean = inpSsee.value.trim().toUpperCase();
      f.set("sseeCode", sseeClean ? `SSEE ${sseeClean}` : "");
      f.set("codigoTerreno", inpTer.value.trim().toUpperCase());
      f.set("estadoEjec", selSt.value);
      f.set("tipo", selKind.value);
      const chosenProt = selProt.value || (sseeClean ? "DF_XS" : "");
      f.set("proteccionTipo", chosenProt);
      f.set("eptTipo", selEpt.value);
      f.set("tipoEquipo", selEpt.value || (PROTECTION_TYPES.find(p => p.id === chosenProt)?.short || ""));
      f.set("accionPT", inpAccion.value.trim());
      f.set("observaciones", localObs);
      styleCache = new WeakMap();
      markDirty();
      refreshAll();
      closeModal();
      if (chosenProt && chosenProt !== prevProt) {
        const gmCur = f.get("gnatMeta");
        if (gmCur && gmCur.lockedDeviceId) { gmCur.lockedDeviceId = 0; f.set("gnatMeta", gmCur); }
      }
      if ((chosenProt && chosenProt !== prevProt) || (sseeClean && `SSEE ${sseeClean}` !== prevSsee)) {
        enqueueGnatMetadataSync([f], true);
      }
    };
  }

  function renderSyncQueueBar() {
    const q = state.syncQueue;
    if (!q.running && !q.paused) {
      syncQueueBar.classList.add("hidden");
      return;
    }
    syncQueueBar.classList.remove("hidden");
    syncQueueBar.replaceChildren();
    const statusTxt = q.paused
      ? `GNAT en pausa · ${q.done}/${q.total}`
      : `GNAT · ${q.done}/${q.total}`;
    el("span", "", statusTxt, syncQueueBar).style.fontWeight = "600";
    const btns = el("div", "", null, syncQueueBar);
    btns.style.cssText = "display:flex;gap:4px;flex-shrink:0;";
    const bPause = el("button", "", q.paused ? "▶" : "⏸", btns);
    bPause.title = q.paused ? "Reanudar sincronización" : "Pausar sincronización";
    bPause.onclick = () => {
      q.paused = !q.paused;
      renderSyncQueueBar();
      if (!q.paused && !q.running) drainGnatSyncQueue();
    };
    const bCancel = el("button", "", "×", btns);
    bCancel.title = "Cancelar sincronización";
    bCancel.onclick = () => {
      q.cancelled = true;
      q.paused = false;
      q.running = false;
      for (const f of q.items) {
        if (f.get("syncStatus") === "loading") f.set("syncStatus", "cancelled");
      }
      q.items = [];
      renderSyncQueueBar();
      renderTable();
    };
  }

  // S15: el código de poste y el código de S/E son dos nombres igual de válidos del
  // mismo punto, así que la coordenada ingresada se valida contra los dos y gana el
  // que coincide. El que no coincide se descarta sin reportarlo: no es un error del
  // dato. Sólo cuando no coincide con ninguno de los dos, la coordenada es el problema.
  // Puro a propósito —recibe el medidor de distancia— porque la decisión no depende
  // del mapa ni de la red, y así se puede probar sola.
  function pickCoordCandidate(candidates, enteredLL, meters) {
    if (!enteredLL || !Array.isArray(candidates) || !candidates.length) return null;
    return candidates
      .map(c => ({ label: c.label, hit: c.hit, meters: meters(enteredLL, c.hit.lonlat) }))
      .sort((a, b) => a.meters - b.meters)[0];
  }

  async function syncSinglePointWithGnat(f, force = false) {
    if (!f) return false;
    if (!force && f.get("syncStatus") === "cancelled") return false;
    const prevStatus = f.get("syncStatus");
    f.set("syncStatus", "loading");

    const proj = map.getView().getProjection();
    const code = getPointCode(f).toUpperCase();
    const sseeRaw = String(f.get("sseeCode") || "").replace(/^SSEE\s+/i, "").trim().toUpperCase();
    const hasExistingGeom = Boolean(f.getGeometry());
    const existingLL = hasExistingGeom ? ol.proj.toLonLat(f.getGeometry().getCoordinates(), proj) : null;
    const notes = [];
    let snappedToGnat = false;

    try {
      const isApPoint = (f.get("tipo") || "PUNTO") === "APERTURA";
      const userProtPref = String(f.get("proteccionTipo") || "");
      // 1. Búsqueda DIRECTA por código (si es APERTURA prioriza tipo declarado o el equipo más cercano al clic)
      const lockedDevId = Number(f.get("gnatMeta")?.lockedDeviceId || 0);
      const hitPole = (code && code !== "SIN CÓDIGO")
        ? await resolveCodeInGnat(code, true, isApPoint, { preferredProt: userProtPref, nearLonLat: existingLL, returnAllDevices: isApPoint, lockedDeviceId: lockedDevId })
        : null;
      if (isApPoint && hitPole?.protId && !userProtPref) f.set("proteccionTipo", hitPole.protId);
      if (f.get("syncStatus") === "cancelled") return false;
      const hitSsee = (sseeRaw && sseeRaw !== code) ? await resolveCodeInGnat(sseeRaw, true, false, { preferSsee: true, nearLonLat: existingLL || hitPole?.lonlat || null }) : null;
      if (f.get("syncStatus") === "cancelled") return false;

      const primaryHit = hitPole || hitSsee;
      // Los dos nombres del punto, medidos contra la coordenada ingresada: gana el más
      // cercano. Sin coordenada ingresada no hay nada que validar y ahí se conserva la
      // regla S14: una S/E resuelta sola no mueve el pin ni se usa para medir distancia.
      const locCandidates = [
        hitPole?.lonlat ? { label: "poste", hit: hitPole } : null,
        hitSsee?.lonlat ? { label: "S/E", hit: hitSsee } : null
      ].filter(Boolean);
      const locMatch = pickCoordCandidate(locCandidates, existingLL, haversineMeters);
      const locHit = locMatch ? locMatch.hit : (hitPole || (isApPoint ? primaryHit : null));

      if (!primaryHit?.lonlat) {
        // Fallback: si no apareció por código pero tiene coordenada Excel, mirar qué hay en esa coordenada
        if (existingLL) {
          const nb = await inspectPoleNeighborhoodInGnat(code, existingLL, [], true);
          const nearPole = (nb.detectedPoleCode || "").toUpperCase();
          const nearSsee = (nb.sseeList[0] || "").toUpperCase();
          const nearDev = nb.devices[0] || null;
          notes.push(nearPole
            ? `Código ${code} no encontrado en GNAT (en esta coord. figura ${nearPole}) — verificar.`
            : `Código ${code || sseeRaw} no encontrado en GNAT.`);
          if (nearSsee && !f.get("sseeCode")) f.set("sseeCode", `SSEE ${nearSsee}`);
          if (nearSsee && !f.get("proteccionTipo")) f.set("proteccionTipo", "DF_XS");
          f.set("gnatMeta", {
            poleCode: nearPole,
            sseeCode: nearSsee ? `SSEE ${nearSsee}` : "",
            coci3f: nb.coci3f,
            deviceDisplay: nearDev ? `${nearDev.type}${nearDev.realState ? " · " + nearDev.realState : ""}` : "",
            syncedAt: new Date().toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })
          });
          f.set("syncNote", notes.join(" "));
          f.set("syncStatus", "mismatch");
        } else {
          f.set("syncNote", `Código ${code || sseeRaw} no encontrado en GNAT.`);
          f.set("syncStatus", "not_found");
        }
        return false;
      }

      let bothDistPending = null;
      if (hitPole?.lonlat && hitSsee?.lonlat) {
        const dBoth = haversineMeters(hitPole.lonlat, hitSsee.lonlat);
        if (dBoth > 40) bothDistPending = dBoth;
      }
      // Avisos que NO son una inconsistencia del punto: se muestran, pero no lo marcan en rojo.
      const infoNotes = [];

      // Validar la coordenada ingresada contra los dos nombres del punto: <= 150 m del
      // poste o de la S/E es el mismo punto, y el pin se ajusta al que coincide. Si no
      // coincide con ninguno, la coordenada es el problema y el aviso da las dos
      // distancias para poder descartar el nombre equivocado de un vistazo.
      let distMeters = 0;
      if (locMatch && locMatch.meters <= COORD_MATCH_METERS) {
        distMeters = locMatch.meters;
        f.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(locHit.lonlat, proj)));
        snappedToGnat = true;
      } else if (locMatch) {
        distMeters = locMatch.meters;
        const measured = locCandidates
          .map(c => `${c.label} ${c.hit.code} a ${Math.round(haversineMeters(existingLL, c.hit.lonlat))} m`)
          .join(" y ");
        notes.push(`Tu coord. Excel no coincide con GNAT: ${measured} — verificar la coordenada.`);
      } else if (locHit) {
        f.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(locHit.lonlat, proj)));
        snappedToGnat = true;
      } else {
        // Sólo se resolvió la S/E y no hay coordenada con la cual ubicar el punto.
        infoNotes.push(`Se ubicó la S/E ${primaryHit.code}; sin coordenada no hay dónde ubicar el punto.`);
      }

      // 2. Rescatar metadata técnica (S/E, COCI_3F kA, protecciones reales) en la coordenada exacta del poste en GNAT
      const probeLL = (snappedToGnat || !existingLL) ? (locHit?.lonlat || existingLL || primaryHit.lonlat) : existingLL;
      const nb = await inspectPoleNeighborhoodInGnat(primaryHit.code, probeLL, [], true);
      if (f.get("syncStatus") === "cancelled") return snappedToGnat;

      const sseeConfirmedHere = sseeRaw && nb.sseeList.some(x => x.toUpperCase() === sseeRaw);
      if (bothDistPending !== null && !sseeConfirmedHere) {
        // No es un error del punto: la S/E resuelta puede ser otro objeto con el mismo
        // código. Con DIST. EXCEL↔GNAT en 0 m marcarlo en rojo contradecía el dato (S11).
        infoNotes.push(`La S/E ${sseeRaw} resuelta está a ${Math.round(bothDistPending)} m del poste ${code}: puede ser otro objeto con el mismo código.`);
      }
      const foundSsee = (nb.sseeList[0] || sseeRaw || "").toUpperCase();
      const foundDev = nb.devices[0] || primaryHit.devices?.[0] || null;
      if (foundSsee && !f.get("sseeCode")) f.set("sseeCode", `SSEE ${foundSsee}`);

      // Reconciliación automática S/E <-> Poste: si el usuario cargó el código de la S/E como código principal,
      // moverlo a Cód. S/E y promover el código real del poste (ej. F59430 -> Poste F628190 + SSEE F59430 + DF XS)
      const realPole = (nb.detectedPoleCode || "").toUpperCase();
      if (foundSsee && code === foundSsee) {
        // El código cargado es el de la S/E, no el de un poste: va al campo de S/E.
        f.set("sseeCode", `SSEE ${foundSsee}`);
        if (realPole && realPole !== code) {
          f.set("codigo", realPole);
          if (!f.get("proteccionTipo")) f.set("proteccionTipo", "DF_XS");
        } else {
          // Sin un poste distinto no se repite el código de la S/E en los dos campos (S7).
          f.set("codigo", "Sin código");
          notes.push(`El código ${code} corresponde a la S/E, no a un poste: falta el código del poste — verificar.`);
        }
      }

      const hitProt = primaryHit.protId || (primaryHit.isOpeningDevice ? mapProtectionFromText(primaryHit.display || "") : "");
      const detectedProt = hitProt
        || (foundDev ? mapProtectionFromText(`${foundDev.type || ""} ${foundDev.display || ""}`) : "")
        || (foundSsee ? "DF_XS" : "");

      const userProt = String(f.get("proteccionTipo") || "");
      if (!userProt && detectedProt) {
        f.set("proteccionTipo", detectedProt);
        if (["RC", "DBC", "DC", "DDFF", "SECC", "INT_MT"].includes(detectedProt) && !foundSsee) {
          f.set("tipo", "APERTURA");
        }
      } else if (userProt && !detectedProt && !primaryHit.isOpeningDevice && userProt !== "DF_XS" && !userProt.endsWith("_BT")) {
        notes.push(`Declaraste ${PROTECTION_TYPES.find(p => p.id === userProt)?.short || userProt}, pero GNAT no reporta equipo de apertura aquí — verificar.`);
      }

      f.set("gnatMeta", {
        poleCode: (primaryHit.isSsee && !nb.detectedPoleCode) ? "" : (nb.detectedPoleCode || primaryHit.code),
        display: primaryHit.display || primaryHit.code,
        sseeCode: foundSsee ? `SSEE ${foundSsee}` : "",
        coci3f: nb.coci3f,
        deviceDisplay: foundDev ? `${foundDev.type || foundDev.display}${foundDev.realState ? " · " + foundDev.realState : ""}` : (foundSsee ? "Desconectador Fusible XS (S/E)" : ""),
        gnatLonLat: primaryHit.lonlat,
        lockedDeviceId: lockedDevId || primaryHit.surrogateId || 0,
        availableDevices: Array.isArray(primaryHit.allDevices) ? primaryHit.allDevices.map(d => ({
          display: d.display,
          protId: d.protId || mapProtectionFromText(d.display || ""),
          lonlat: d.lonlat,
          surrogateId: d.surrogateId || d.objectId || 0
        })) : [],
        distMeters: snappedToGnat ? 0 : distMeters,
        syncedAt: new Date().toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })
      });
      f.set("syncNote", [...notes, ...infoNotes].join(" "));
      f.set("syncStatus", notes.length ? "mismatch" : "ok");
      return snappedToGnat;
    } catch (err) {
      console.warn("syncSinglePointWithGnat error:", err);
      if (f.get("syncStatus") === "loading") {
        f.set("syncNote", `Error al consultar GNAT: ${err?.message || "timeout"}`);
        f.set("syncStatus", prevStatus === "ok" ? "ok" : "not_found");
      }
      return snappedToGnat;
    }
  }

  async function drainGnatSyncQueue() {
    const q = state.syncQueue;
    if (q.running || q.paused) return;
    q.running = true;
    q.cancelled = false;
    renderSyncQueueBar();

    const touchedZones = new Set();
    while (q.items.length > 0 && !q.paused && !q.cancelled) {
      const f = q.items.shift();
      if (!f || f.get("syncStatus") === "cancelled") {
        q.done++;
        renderSyncQueueBar();
        continue;
      }
      try {
        const moved = await syncSinglePointWithGnat(f, false);
        if (moved) {
          getPointZoneIds(f).forEach(z => touchedZones.add(z));
          ensureVectorLayer();
        }
      } catch (err) {
        console.warn("GNAT sync item error:", err);
      }
      q.done++;
      try {
        renderSyncQueueBar();
        renderTable();
        rebuildOverlayLayers();
      } catch (err) {
        console.warn("UI render error during sync:", err);
      }
    }

    // Reajustar automáticamente los polígonos de las zonas cuyos puntos se movieron a su poste exacto en GNAT
    for (const zid of touchedZones) {
      const z = state.zones.get(zid);
      if (z && Array.isArray(z.customRing) && z.customRing.length >= 3) {
        generateZonePolygonFromPoints(zid);
      }
    }

    q.running = false;
    if (q.items.length === 0) {
      q.paused = false;
      rebuildOverlayLayers();
      markDirty();
    }
    renderSyncQueueBar();
  }

  function enqueueGnatMetadataSync(feats, force = false) {
    const list = (feats || []).filter(Boolean);
    if (!list.length) return;
    const q = state.syncQueue;
    for (const f of list) {
      if (force) f.set("syncStatus", "loading");
      else if (f.get("syncStatus") !== "cancelled") f.set("syncStatus", "loading");
      if (!q.items.includes(f)) {
        q.items.push(f);
        q.total++;
      }
    }
    if (!q.running && !q.paused) {
      q.done = 0;
      q.total = q.items.length;
      drainGnatSyncQueue();
    } else {
      renderSyncQueueBar();
      renderTable();
    }
  }

  function openPasteCodesModal() {
    modalBackdrop.replaceChildren();
    modalBackdrop.classList.remove("hidden");
    const card = el("div", "modal-card", null, modalBackdrop);
    card.style.width = "min(640px, 95vw)";
    const head = el("div", "modal-head", null, card);
    el("h2", "", "Importar códigos o tabla desde Excel", head);
    const bClose = el("button", "btn-outline", "×", head);
    bClose.onclick = closeModal;

    const body = el("div", "modal-body", null, card);
    el("div", "", "Pega una lista de códigos o copia/pega filas directo desde Excel (con o sin coordenadas):", body).style.fontSize = "12px";
    const ta = el("textarea", "", null, body);
    ta.style.cssText = "width:100%;height:110px;border:1px solid var(--border);border-radius:8px;padding:8px;font:12px monospace;";
    ta.placeholder = "N°\tCOD POSTE\tLatitud\tLongitud\n55\tFBP0407\t-37,9159\t-72,9496";

    const optRow = el("div", "inline-input-row", null, body);
    optRow.style.justifyContent = "space-between";
    const hdrLbl = el("label", "", null, optRow);
    hdrLbl.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;";
    const chkHeader = el("input", "", null, hdrLbl);
    chkHeader.type = "checkbox";
    el("span", "", "Primera fila es encabezado", hdrLbl);

    const grpRow = el("div", "", null, body);
    grpRow.style.cssText = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;background:#F8FAFC;border:1px solid var(--border);border-radius:8px;padding:8px;";

    const mkGrp = (lblTxt) => {
      const box = el("div", "", null, grpRow);
      box.style.cssText = "display:flex;flex-direction:column;gap:3px;";
      el("span", "", lblTxt, box).style.cssText = "font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;";
      const sel = el("select", "", null, box);
      sel.style.cssText = "padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:#fff;";
      return sel;
    };

    const selTargetZone = mkGrp("Zona del lote");
    const optNoZ = el("option", "", "— Sin zona —", selTargetZone); optNoZ.value = "";
    for (const z of state.zones.values()) {
      const o = el("option", "", `${z.id} · ${z.name}`, selTargetZone); o.value = z.id;
    }
    const optNewZ = el("option", "", "+ Crear zona nueva...", selTargetZone); optNewZ.value = "__NEW__";
    selTargetZone.value = "T";

    const selTargetSup = mkGrp("Supervisor (opc.)");
    for (const s of state.supervisors.values()) {
      const o = el("option", "", s.id === "default" ? "— Sin asignar —" : `${s.initials} · ${s.name}`, selTargetSup);
      o.value = s.id;
    }

    const selTargetSt = mkGrp("Estado inicial");
    for (const st of state.statuses.values()) {
      const o = el("option", "", st.name, selTargetSt); o.value = st.id;
    }
    selTargetSt.value = "pendiente";

    const newZoneRow = el("div", "inline-input-row hidden", null, body);
    const inpNewZoneName = el("input", "", null, newZoneRow);
    inpNewZoneName.placeholder = "Nombre o ID de la nueva zona (ej. V2, Tramo Norte)...";
    const inpNewZoneCol = el("input", "", null, newZoneRow);
    inpNewZoneCol.type = "color";
    inpNewZoneCol.value = "#00C853";
    inpNewZoneCol.style.cssText = "width:36px;height:30px;padding:1px;border:1px solid var(--border);border-radius:6px;";
    selTargetZone.addEventListener("change", () => {
      newZoneRow.classList.toggle("hidden", selTargetZone.value !== "__NEW__");
    });

    const previewTitle = el("div", "", "Vista previa de columnas (puedes cambiar cualquier etiqueta):", body);
    previewTitle.style.cssText = "font-size:11px;font-weight:700;color:#475569;display:none;";
    const previewWrap = el("div", "preview-wrap hidden", null, body);

    let parsedState = { rows: [], hasHeader: false, colRoles: [] };
    let headerTouchedByUser = false;

    const ROLE_OPTIONS = [
      ["codigo", "Código Poste (GNAT)"],
      ["sseeCode", "Cód. S/E"],
      ["numero", "N°"],
      ["lat", "Latitud"],
      ["lon", "Longitud"],
      ["codigoTerreno", "Cód. terreno"],
      ["supervisor", "Supervisor"],
      ["obs", "Observación"],
      ["estado", "Estado"],
      ["ignorar", "Ignorar"]
    ];

    const renderPreview = () => {
      const parsed = parseSmartTableText(ta.value);
      if (!parsed.rows.length) {
        previewTitle.style.display = "none";
        previewWrap.classList.add("hidden");
        parsedState = parsed;
        return;
      }
      if (!headerTouchedByUser) chkHeader.checked = parsed.hasHeader;
      parsed.hasHeader = chkHeader.checked;
      parsedState = parsed;

      previewTitle.style.display = "";
      previewWrap.classList.remove("hidden");
      previewWrap.replaceChildren();

      const tbl = el("table", "preview-table", null, previewWrap);
      const th = el("thead", "", null, tbl);
      const trh = el("tr", "", null, th);
      parsed.colRoles.forEach((role, ci) => {
        const cell = el("th", "", null, trh);
        const sel = el("select", "", null, cell);
        for (const [val, txt] of ROLE_OPTIONS) {
          const o = el("option", "", txt, sel);
          o.value = val;
        }
        sel.value = role;
        sel.onchange = () => { parsedState.colRoles[ci] = sel.value; };
      });
      const tb = el("tbody", "", null, tbl);
      const sampleRows = (parsed.hasHeader ? parsed.rows.slice(1) : parsed.rows).slice(0, 4);
      for (const r of sampleRows) {
        const tr = el("tr", "", null, tb);
        for (const val of r) el("td", "", val, tr);
      }
    };

    ta.addEventListener("input", () => { headerTouchedByUser = false; renderPreview(); });
    chkHeader.addEventListener("change", () => { headerTouchedByUser = true; renderPreview(); });

    const footer = el("div", "", null, body);
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
    const bCancel = el("button", "btn-outline", "Cancelar", footer);
    bCancel.onclick = closeModal;
    const bRun = el("button", "btn-primary", "⚡ Agregar a tabla y ubicar", footer);
    bRun.onclick = () => {
      if (!parsedState.rows.length) return;
      const dataRows = parsedState.hasHeader ? parsedState.rows.slice(1) : parsedState.rows;
      const roles = parsedState.colRoles;
      let targetZ = selTargetZone.value;
      if (targetZ === "__NEW__") {
        targetZ = createZone(inpNewZoneName.value.trim() || "Nueva", inpNewZoneCol.value);
      }
      const targetSup = selTargetSup.value || "default";
      if (targetSup !== "default") state.multiSupervisorEnabled = true;
      const defaultSt = selTargetSt.value || "pendiente";
      const toResolveBg = [];
      const placedIndices = [];

      for (const row of dataRows) {
        let numero = null, codigo = "", sseeCode = "", codigoTerreno = "", lat = null, lon = null, obsText = "", stName = "", supName = "";
        row.forEach((cell, ci) => {
          const role = roles[ci];
          const val = String(cell || "").trim();
          if (!val || role === "ignorar") return;
          if (role === "numero") {
            const n = Number(val.replace(/[^\d]/g, ""));
            if (n > 0) numero = n;
          } else if (role === "codigo") {
            const pm = /^([^()]+?)\s*\(([^()]+)\)\s*$/.exec(val);
            if (pm) {
              codigo = pm[1].trim();
              if (!codigoTerreno) codigoTerreno = pm[2].trim();
            } else {
              codigo = val;
            }
          } else if (role === "sseeCode") {
            sseeCode = val.replace(/^SSEE\s+/i, "").trim().toUpperCase();
          } else if (role === "codigoTerreno") {
            codigoTerreno = val;
          } else if (role === "lat") {
            const n = Number(val.replace(",", "."));
            if (Number.isFinite(n)) lat = n;
          } else if (role === "lon") {
            const n = Number(val.replace(",", "."));
            if (Number.isFinite(n)) lon = n;
          } else if (role === "obs") {
            obsText = obsText ? `${obsText} · ${val}` : val;
          } else if (role === "estado") {
            stName = val;
          } else if (role === "supervisor") {
            supName = val;
          }
        });

        if (!codigo && !sseeCode && !codigoTerreno) continue;
        // Normalizar si lat/lon vinieran invertidos para Chile
        let lonlat = null;
        if (lat !== null && lon !== null) {
          if (Math.abs(lat) > 60 && Math.abs(lon) <= 60) lonlat = [lat, lon];
          else lonlat = [lon, lat];
        } else {
          lonlat = extractLatLonFromLine(row.join(" "));
        }

        let estadoEjec = defaultSt;
        if (stName) {
          const matchSt = [...state.statuses.values()].find(s => CAT.foldText(s.name) === CAT.foldText(stName));
          if (matchSt) estadoEjec = matchSt.id;
        }
        const obsArr = obsText ? [{ text: obsText, at: new Date().toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" }) }] : [];

        const feat = upsertPointOnMap({
          // El código de la S/E no se usa como código de poste: repetirlo en los dos
          // campos es lo que rompía la sincronización (S7). Sin poste, el punto queda
          // sin código de poste pero conserva su S/E.
          codigo: codigo || codigoTerreno,
          codigoTerreno,
          sseeCode: sseeCode ? `SSEE ${sseeCode}` : "",
          proteccionTipo: sseeCode ? "DF_XS" : "",
          numero,
          lonlat,
          tipo: "PUNTO",
          bloqueId: targetZ,
          bloques: targetZ ? [targetZ] : [],
          estadoEjec,
          observaciones: obsArr,
          syncStatus: "loading"
        });
        // El supervisor de la fila gana sobre el desplegable global. Se compara sin
        // tildes ni mayusculas, y se acepta el nombre recortado ("Tomas Lem" vs
        // "Tomas Lemunao"), que es como lo escribe la planilla a mano.
        let rowSup = targetSup;
        if (supName) {
          const folded = CAT.foldText(supName);
          const hit = [...state.supervisors.values()].find((s) => {
            const n = CAT.foldText(s.name);
            const ini = CAT.foldText(s.initials);
            if (folded === n || folded === ini) return true;
            return folded.length >= 4 && (n.startsWith(folded) || folded.startsWith(n));
          });
          if (hit) rowSup = hit.id;
          else if (LEGACY_COLOR_TO_SUP[supName]) rowSup = LEGACY_COLOR_TO_SUP[supName];
        }
        if (rowSup !== "default") {
          feat.set("supervisorId", rowSup);
          state.multiSupervisorEnabled = true;
        }
        const idx = state.points.indexOf(feat);
        if (lonlat && idx >= 0) placedIndices.push(idx);
        toResolveBg.push(feat);
      }

      closeModal();
      ensureVectorLayer();
      markDirty();
      refreshAll();
      if (placedIndices.length) fitPoints(placedIndices);
      if (toResolveBg.length) {
        showToast(`${toResolveBg.length} fila(s) cargadas · sincronizando metadata GNAT en segundo plano...`);
        enqueueGnatMetadataSync(toResolveBg, true);
      }
    };
  }

  function openSupervisorsModal() {
    modalBackdrop.replaceChildren();
    modalBackdrop.classList.remove("hidden");
    const card = el("div", "modal-card", null, modalBackdrop);
    const head = el("div", "modal-head", null, card);
    el("h2", "", "Equipo y modo multi-supervisor", head);
    const bClose = el("button", "btn-outline", "Listo", head);
    bClose.onclick = () => { closeModal(); refreshAll(); };

    const body = el("div", "modal-body", null, card);
    const chkRow = el("label", "", null, body);
    chkRow.style.cssText = "display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer;background:var(--bg-muted);padding:10px;border-radius:8px;";
    const chk = el("input", "", null, chkRow);
    chk.type = "checkbox";
    chk.checked = state.multiSupervisorEnabled;
    el("span", "", "Mostrar columna y filtros por supervisor", chkRow);
    chk.onchange = () => { state.multiSupervisorEnabled = chk.checked; markDirty(); refreshAll(); };

    for (const s of state.supervisors.values()) {
      if (s.id === "default") continue;
      const row = el("div", "inline-input-row", null, body);
      row.style.cssText = "display:flex;align-items:center;gap:8px;border:1px solid var(--border);padding:6px 8px;border-radius:8px;";
      const sw = el("button", "swatch", "", row);
      sw.style.background = s.color;
      sw.onclick = () => openColorPickerPopover(sw, s.color, (c) => {
        s.color = c;
        sw.style.background = c;
        styleCache = new WeakMap();
        markDirty();
        refreshAll();
      });
      const inpInit = el("input", "", null, row);
      inpInit.value = s.initials;
      inpInit.style.maxWidth = "52px";
      inpInit.onchange = () => { s.initials = inpInit.value.trim().slice(0, 4) || s.id; markDirty(); refreshAll(); };
      const inpName = el("input", "", null, row);
      inpName.value = s.name;
      inpName.onchange = () => { s.name = inpName.value.trim() || s.initials; markDirty(); refreshAll(); };
    }
  }

  function openAtlasPdfModal() {
    modalBackdrop.replaceChildren();
    modalBackdrop.classList.remove("hidden");
    const card = el("div", "modal-card", null, modalBackdrop);
    const head = el("div", "modal-head", null, card);
    el("h2", "", "Exportar Planos PDF (A1 / Atlas · Demo)", head);
    const bClose = el("button", "btn-outline", "Cerrar", head);
    bClose.onclick = closeModal;
    const body = el("div", "modal-body", null, card);
    el("div", "", "Vista demostrativa del módulo de impresión A1.", body).style.cssText = "font-size:12px;color:var(--text-secondary);background:var(--bg-muted);padding:10px;border-radius:8px;";
  }

  // =========================================================================
  // 17. DETALLE MT/BT (WMTS) Y EVENTOS DE TECLADO
  // =========================================================================
  const MTBT_LAYERS = new Set(["webmap.distribution.medium_voltage", "webmap.distribution.low_voltage", "webmap.infrastructure"]);
  const mtbtSources = new Set();
  const mtbtLayers = new Set();
  const originalGrids = new Map();
  (function scanLayers(col) {
    for (const layer of col?.getArray?.() || []) {
      const name = layer.get?.("title") || layer.get?.("name");
      if (MTBT_LAYERS.has(name)) {
        mtbtLayers.add(layer);
        const src = layer.getSource?.();
        const grid = src?.getTileGrid?.();
        if (grid && typeof grid.getZForResolution === "function") {
          if (!originalGrids.has(grid)) originalGrids.set(grid, grid.getZForResolution);
          mtbtSources.add(src);
        }
      }
      if (layer.getLayers) scanLayers(layer.getLayers());
    }
  })(map.getLayers());

  function setMtBtDetail(n) {
    state.mtbtDetail = Number(n) || 0;
    for (const [grid, orig] of originalGrids) {
      grid.getZForResolution = !state.mtbtDetail ? orig : function (res, dir) {
        const z = orig.call(this, res, dir);
        const max = Number.isFinite(this.getMaxZoom?.()) ? this.getMaxZoom() : z + 3;
        return Math.min(max, z + state.mtbtDetail);
      };
    }
    mtbtSources.forEach(s => s.changed?.());
    map.render?.();
  }

  function applyHighlightToLayerCanvas(ev) {
    if (!state.highlightNetwork) return;
    const ctx = ev?.context;
    if (!ctx) return;
    ctx.filter = "contrast(1.45) saturate(1.85) drop-shadow(0 0 0.7px rgba(0,0,0,0.45))";
  }
  function resetLayerCanvasFilter(ev) {
    if (ev?.context) ev.context.filter = "none";
  }
  for (const lyr of mtbtLayers) {
    lyr.on?.("prerender", applyHighlightToLayerCanvas);
    lyr.on?.("postrender", resetLayerCanvasFilter);
  }
  function setNetworkHighlight(on) {
    state.highlightNetwork = Boolean(on);
    mtbtSources.forEach(s => s.changed?.());
    map.render?.();
    showToast(state.highlightNetwork ? "Resaltado de red MT/BT activado." : "Resaltado de red MT/BT desactivado.");
  }

  // Búsqueda instantánea local + Enter para resolver el código en GNAT
  searchInput.oninput = () => {
    state.search = searchInput.value;
    if (!state.search.trim()) state.lastSearchMissing = [];
    refreshAll();
  };
  searchInput.addEventListener("search", () => {
    state.search = searchInput.value;
    if (!state.search.trim()) state.lastSearchMissing = [];
    refreshAll();
  });
  searchInput.onkeydown = async (ev) => {
    if (ev.key === "Enter" && searchInput.value.trim()) {
      const q = searchInput.value.trim();
      const vis = getFilteredPoints();
      if (vis.length > 0) {
        navigateTo(state.points.indexOf(vis[0]));
        return;
      }
      showToast(`Buscando "${q}" en GNAT...`);
      const hit = await resolveCodeInGnat(q, true, false, { returnAllDevices: true });
      const addResolvedHit = (chosen) => {
        const isOp = Boolean(chosen.isOpeningDevice);
        const feat = upsertPointOnMap({
          codigo: chosen.code,
          lonlat: chosen.lonlat,
          tipo: isOp ? "APERTURA" : "PUNTO",
          bloqueId: isOp ? "D" : "T",
          bloques: [isOp ? "D" : "T"],
          proteccionTipo: chosen.protId || ""
        });
        searchInput.value = "";
        state.search = "";
        ensureVectorLayer();
        markDirty();
        refreshAll();
        navigateTo(state.points.indexOf(feat));
        showToast(`Agregado desde GNAT: ${chosen.display || chosen.code}`);
      };
      if (hit?.allDevices && hit.allDevices.length > 1) {
        const r = searchInput.getBoundingClientRect();
        showPopoverAt(r.left, r.bottom + 6, (pop) => {
          el("div", "pop-title", `Varios equipos en ${hit.code} · Elige cuál agregar`, pop);
          for (const d of hit.allDevices) {
            const b = el("button", "pop-item", `✕ ${d.display}`, pop);
            b.onclick = () => { closePopover(); addResolvedHit(d); };
          }
        });
      } else if (hit?.lonlat) {
        addResolvedHit(hit);
      } else {
        showToast(`No se encontró "${q}" en GNAT.`, true);
      }
    }
  };

  const stepFocus = (delta) => {
    const visible = getFilteredPoints();
    if (!visible.length) return;
    const curPos = visible.findIndex(f => state.points.indexOf(f) === state.focused);
    const nextPos = curPos < 0 ? 0 : (curPos + delta + visible.length) % visible.length;
    navigateTo(state.points.indexOf(visible[nextPos]));
  };
  btnPrev.onclick = () => stepFocus(-1);
  btnNext.onclick = () => stepFocus(1);

  tableWrap.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); stepFocus(1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); stepFocus(-1); }
    else if (ev.key === "Enter" && state.focused >= 0) { ev.preventDefault(); openEditPointModal(state.focused); }
  });

  btnToggleDrawer.onclick = () => {
    state.drawerOpen = !state.drawerOpen;
    drawer.classList.toggle("hidden", !state.drawerOpen);
    btnToggleDrawer.classList.toggle("active-pill", state.drawerOpen);
    syncLayoutToMapViewport();
  };

  btnCollapse.onclick = () => {
    state.collapsed = true;
    topbar.style.display = "none";
    dock.style.display = "none";
    drawer.style.display = "none";
    fab.classList.remove("hidden");
  };

  fab.onclick = () => {
    state.collapsed = false;
    topbar.style.display = "";
    dock.style.display = "";
    drawer.style.display = "";
    fab.classList.add("hidden");
  };

  const onKeyDown = (ev) => {
    const inInput = ["INPUT", "TEXTAREA", "SELECT"].includes(doc.activeElement?.tagName);
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z" && !inInput) {
      ev.preventDefault();
      performUndo();
      return;
    }
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.toLowerCase() === "h" && !inInput) {
      toggleHidePoles();
      return;
    }
    if (ev.key === "Escape") {
      closePopover();
      if (!modalBackdrop.classList.contains("hidden")) {
        closeModal();
        return;
      }
      if (state.cursorMode !== "nav") {
        finishPolygonDrawMode();
      } else if (state.selected.size > 0) {
        state.selected.clear();
        refreshAll();
      }
    }
  };
  doc.addEventListener("keydown", onKeyDown);
  // En fase de captura, para conocer el disparador antes que nadie.
  doc.addEventListener("mousedown", (ev) => { lastMouseDownTarget = ev.target; }, true);
  doc.addEventListener("mousedown", (ev) => {
    const path = ev.composedPath();
    if (activePopover) {
      // Cerrar sólo si el clic fue realmente afuera. Si cayó sobre el disparador
      // que abrió el popover, el click del propio botón hace el toggle: cerrarlo
      // acá era justo lo que hacía que el botón reabriera en vez de cerrar.
      if (path.includes(activePopover)) return;
      if (activePopoverAnchor && path.includes(activePopoverAnchor)) return;
      closePopover();
      return;
    }
    if (modalIsOpen()) {
      const card = modalBackdrop.querySelector(".modal-card");
      if (card && path.includes(card)) return;
      // U16: no cerrar en silencio una ventana con cambios sin guardar.
      if (modalHasUnsavedChanges()) {
        showToast("Hay cambios sin guardar: usá Cancelar o Guardar.");
        return;
      }
      closeModal();
    }
  });

  function destroy() {
    w.clearTimeout(autosaveTimer);
    setCursorMode("nav");
    if (dragBoxInteraction) map.removeInteraction(dragBoxInteraction);
    map.un("singleclick", onMapSingleClick);
    viewportEl?.removeEventListener("contextmenu", onMapContextMenu);
    doc.removeEventListener("keydown", onKeyDown);
    if (vectorLayer) map.removeLayer(vectorLayer);
    if (hullLayer) map.removeLayer(hullLayer);
    if (spanLayer) map.removeLayer(spanLayer);
    if (routeLayer) map.removeLayer(routeLayer);
    if (linkLayer) map.removeLayer(linkLayer);
    setMtBtDetail(0);
    host.remove();
    if (w.__centralityV10?.destroy === destroy) delete w.__centralityV10;
  }

  btnClose.onclick = destroy;

  w.__centralityV10 = {
    destroy,
    toggle: () => state.collapsed ? fab.click() : btnCollapse.click(),
    openRecent: openStartModal
  };

  restoreBackupFolderHandle();
  setCursorMode("nav");

  if (prevPoints.length > 0) {
    state.points = prevPoints.map(p => new ol.Feature({
      geometry: new ol.geom.Point(p.xy),
      id: p.id,
      numero: p.numero,
      tipo: p.tipo,
      codigo: p.codigo,
      bloqueId: p.bloqueId || "T",
      bloques: p.bloques?.length ? p.bloques : ["T"],
      aperturasIds: p.aperturasIds,
      supervisorId: LEGACY_COLOR_TO_SUP[p.bloque] || "default",
      tipoEquipo: p.tipoEquipo,
      colorPersonalizado: p.colorPersonalizado
    }));
    ensureVectorLayer();
    refreshAll();
    autosaveNow();
  } else {
    refreshAll();
    openStartModal();
  }
})();
