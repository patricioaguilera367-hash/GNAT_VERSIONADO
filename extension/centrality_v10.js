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

  // =========================================================================
  // 1. CONSTANTES, PALETA DE ALTO CONTRASTE Y DIRECTORIO DE SUPERVISORES
  // =========================================================================
  const HIGH_CONTRAST_PALETTE = [
    "#00C853", // Verde neón (T - Zona de trabajo)
    "#FF6D00", // Naranjo intenso (F - Punto de faenas / CC)
    "#DC2626", // Rojo intenso (D - Zona desconectada)
    "#2979FF", // Azul eléctrico (TL)
    "#00BFA5", // Verde turquesa claro (JB)
    "#D500F9", // Magenta vivo
    "#FFD600", // Amarillo alto contraste
    "#00E5FF", // Cian eléctrico
    "#15803D", // Verde oscuro (RD)
    "#4F46E5", // Índigo
    "#F97316", // Ámbar vivo
    "#06B6D4"  // Turquesa medio
  ];

  const DEFAULT_SUPERVISORS = [
    { id: "default", initials: "—", name: "Sin asignar", color: "#64748B", isDefault: true },
    { id: "CC", initials: "CC", name: "César Castro", color: "#FF6D00" },
    { id: "TL", initials: "TL", name: "Tomás Lemunao", color: "#2979FF" },
    { id: "RD", initials: "RD", name: "Ricardo Díaz", color: "#15803D" },
    { id: "JB", initials: "JB", name: "Jorge Burgos", color: "#00BFA5" }
  ];

  const LEGACY_COLOR_TO_SUP = {
    "Naranjo": "CC",
    "Azul": "TL",
    "Verde": "RD",
    "Turquesa": "JB",
    "Sin asignar": "default"
  };

  const PROTECTION_TYPES = [
    { id: "", label: "— Ninguna —", short: "", level: "" },
    { id: "DF_XS", label: "Desconectador Fusible XS (S/E MT)", short: "DF XS", level: "MT" },
    { id: "DDFF", label: "Desconectador Fusible Línea (DDFF)", short: "DDFF", level: "MT" },
    { id: "DBC", label: "Desconectador Bajo Carga (DBC)", short: "DBC", level: "MT" },
    { id: "DC", label: "Desconectador Cuchilla (DC / DDCC)", short: "DC", level: "MT" },
    { id: "RC", label: "Reconectador (RC)", short: "RC", level: "MT" },
    { id: "SECC", label: "Seccionador / Pole Top (MT)", short: "Secc", level: "MT" },
    { id: "INT_MT", label: "Interruptor MT", short: "Int MT", level: "MT" },
    { id: "FUS_BT", label: "Fusible / Apertura BT", short: "Ap BT", level: "BT" },
    { id: "SECC_BT", label: "Seccionador BT", short: "Secc BT", level: "BT" }
  ];
  const EPT_TYPES = ["", "EPT MT", "EPT BT", "EPT BT y MT"];
  const EQUIPMENT_TYPES = ["", "DF", "DBC", "DC", "Pole Top", "Reconectador", "Seccionador", "EPT BT y MT", "EPT MT", "EPT BT"];
  function mapProtectionFromText(txt) {
    const s = String(txt || "").toLowerCase();
    if (!s) return "";
    if (/reconectador|\brc\b/.test(s)) return "RC";
    if (/bajo carga|\bdbc\b/.test(s)) return "DBC";
    if (/cuchill|\bddcc\b|\bdc\b/.test(s)) return "DC";
    if (/pole\s*top|seccionador/.test(s)) return /bt|baja/.test(s) ? "SECC_BT" : "SECC";
    if (/interruptor/.test(s)) return "INT_MT";
    if (/bt|baja tensi/.test(s)) return "FUS_BT";
    if (/xs|subestaci|ssee|trafo/.test(s)) return "DF_XS";
    if (/fusible|desconectador|\bddff\b|\bdf\b/.test(s)) return "DDFF";
    return "";
  }
  const OPENING_COLOR = "#DC2626";
  const UNASSIGNED_ZONE_COLOR = "#475569";
  const UMBRAL_ETIQUETA = 25;

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
    // Opciones de visualización en mapa
    colorBy: "zone",        // "zone" | "supervisor"
    hidePoles: false,       // Ocultar pines de postes para editar polígonos cómodamente
    showHulls: true,        // Polígonos D / T / F
    showSpans: true,        // Vectores de tramos MT (A->B)
    showRoute: false,       // Línea secuencial 1->2->3
    showLinks: false,       // Rayos punteados desactivados por defecto (usar tramos MT reales)
    labelMode: "cerca",     // "cerca" | "siempre" | "ninguna"
    labelContent: "numero", // "numero" | "completo"
    mtbtDetail: 0,          // 0 | 1 | 2
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
    updateSaveIndicator(backedUp ? "✓ Guardado (PC + Local)" : "✓ Guardado");
  }

  // =========================================================================
  // 5. MOTOR GNAT DMS (svc_wmc.php + Caché + Grafo MT A->B + Aperturas/Remates)
  // =========================================================================
  const CODE_AT_START = /^([A-Z]{0,3}\d{3,12})\b/i;
  // Permite nodos de hasta 12 dígitos (ej. 467251498) y sufijos descriptivos
  const SPAN_PAIR_REGEX = /^([A-Z]{0,3}\d{3,12})\s*[-–]\s*([A-Z]{0,3}\d{3,12})\b/i;
  const COCI_3F_REGEX = /<td>\s*(\d+(?:\.\d+)?)\s*<\/td>\s*<td>\s*\d+(?:\.\d+)?\s*<\/td>\s*<td>\s*\d+(?:\.\d+)?\s*<\/td>\s*<td>\s*\d+(?:\.\d+)?\s*<\/td>/i;
  const REAL_STATE_REGEX = /<b>\s*Real:\s*<\/b>\s*([^<]+)/i;
  // Equipos de maniobra EN SERIE con línea MT (siempre cortan el grafo)
  const LINE_OPENING_REGEX = /\b(reconectador|seccionador|seccional|cuchill[ao]|interruptor|pole\s*top|bajo\s+carga|sin\s+carga|desconectador\s+(?:bajo\s+carga|sin\s+carga|tripolar|monopolar|en\s+aire|de\s+l[ií]nea|a[eé]reo)|\bddcc\b|\bdbc\b|\bdc\b|\brc\d*\b)/i;
  // Fusibles (pueden ser de arranque MT o de protección de transformador/SSEE)
  const FUSE_DEVICE_REGEX = /\b(desconectador\s+fusible|fusible|\bddff\b|\bdf\b)\b/i;
  const OPENING_DEVICE_REGEX = /\b(desconectador|fusible|seccionador|seccional|reconectador|cuchill[ao]|interruptor|pole\s*top|\bddff\b|\bddcc\b|\bdf\b|\bdbc\b|\bdc\b|\brc\d*\b)/i;
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

  function extractPointFromGeoJsonFeature(feat) {
    const g = feat?.geometry;
    const c = g?.coordinates;
    if (!g || !Array.isArray(c) || !c.length) return null;
    if (g.type === "Point" && c.length >= 2) return [Number(c[0]), Number(c[1])];
    if (g.type === "MultiPoint" && Array.isArray(c[0]) && c[0].length >= 2) return [Number(c[0][0]), Number(c[0][1])];
    if (g.type === "LineString" && c.length >= 2) {
      const mid = c[Math.floor(c.length / 2)];
      if (Array.isArray(mid) && mid.length >= 2) return [Number(mid[0]), Number(mid[1])];
    }
    if (g.type === "Polygon" && Array.isArray(c[0]) && c[0].length) {
      const ring = c[0];
      const lon = ring.reduce((s, p) => s + Number(p[0]), 0) / ring.length;
      const lat = ring.reduce((s, p) => s + Number(p[1]), 0) / ring.length;
      if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
    }
    return null;
  }

  async function resolveCodeInGnat(rawCode, useCache = true, preferOpening = false) {
    const queries = buildCandidateSearchQueries(rawCode);
    for (const q of queries) {
      if (useCache) {
        const cacheKey = preferOpening ? `OP:${q}` : q;
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

      // Si es APERTURA, priorizar el equipo de maniobra cortando la línea (ej. DC POLE TOP); si no, priorizar Poste/SSEE
      candidates.sort((a, b) => {
        const score = (d) => preferOpening
          ? (OPENING_DEVICE_REGEX.test(d) && !POLE_CLASS_REGEX.test(d) ? 4 : POLE_CLASS_REGEX.test(d) ? 2 : SSEE_CLASS_REGEX.test(d) ? 1 : 0)
          : (POLE_CLASS_REGEX.test(d) ? 3 : SSEE_CLASS_REGEX.test(d) ? 2 : OPENING_DEVICE_REGEX.test(d) ? 1 : 0);
        return score(b.display || "") - score(a.display || "");
      });

      for (const cand of candidates) {
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
                code: preferOpening ? `OP:${q}` : q,
                rawCode: q,
                lonlat: pt,
                extraCoords: [],
                display: String(cand.display || q),
                objectId: Number(cand.object_id),
                surrogateId: Number(cand.surrogate_in_map_id || id),
                isOpeningDevice: OPENING_DEVICE_REGEX.test(cand.display) && !POLE_CLASS_REGEX.test(cand.display),
                isSsee: SSEE_CLASS_REGEX.test(cand.display),
                devices: devicesOnCode,
                spans: spansFromSearch
              };
              await dbPutGnatCache(entry);
              entry.code = q;
              return entry;
            }
          } catch (_) {}
        }
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

  function haversineMeters(a, b) {
    const R = 6371000;
    const dLat = (b[1] - a[1]) * Math.PI / 180;
    const dLon = (b[0] - a[0]) * Math.PI / 180;
    const la1 = a[1] * Math.PI / 180, la2 = b[1] * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
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
  styleEl.textContent = `
    :host {
      --bg-surface: rgba(255, 255, 255, 0.97);
      --bg-muted: #F1F5F9;
      --bg-hover: #E2E8F0;
      --border: #CBD5E1;
      --border-strong: #94A3B8;
      --text-primary: #0F172A;
      --text-secondary: #475569;
      --accent: #1D4ED8;
      --accent-soft: #DBEAFE;
      --danger: #DC2626;
      --danger-soft: #FEE2E2;
      --success: #15803D;
      --success-soft: #DCFCE7;
      --radius: 8px;
      --shadow: 0 4px 18px rgba(15, 23, 42, 0.12);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      font-size: 13px;
      color: var(--text-primary);
    }
    * { box-sizing: border-box; }
    button, input, select, textarea { font: inherit; color: inherit; }
    button {
      cursor: pointer;
      border: 1px solid transparent;
      background: transparent;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 9px;
      transition: background 120ms ease, border-color 120ms ease;
    }
    button:hover:not(:disabled) { background: var(--bg-muted); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    button.btn-primary {
      background: var(--accent);
      color: #fff;
      font-weight: 600;
    }
    button.btn-primary:hover:not(:disabled) { background: #1E40AF; }
    button.btn-outline {
      background: #fff;
      border-color: var(--border);
    }
    button.btn-outline:hover:not(:disabled) { background: var(--bg-muted); border-color: var(--border-strong); }
    button.btn-danger {
      background: var(--danger-soft);
      color: var(--danger);
      font-weight: 600;
    }
    button.active-pill {
      background: var(--accent-soft);
      color: var(--accent);
      border-color: #93C5FD;
      font-weight: 600;
    }
    .icon-btn { padding: 5px 7px; justify-content: center; }

    /* TOPBAR (anclada dinámicamente al canvas del mapa GNAT, sin solapar paneles izquierdos) */
    .topbar {
      pointer-events: auto;
      position: fixed;
      top: 8px;
      left: 56px;
      width: auto;
      max-width: calc(100vw - 360px);
      min-height: 38px;
      height: auto;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 4px 6px;
      padding: 4px 8px;
      background: rgba(255, 255, 255, 0.95);
      border: 1px solid #CBD5E1;
      border-radius: 9px;
      box-shadow: 0 3px 12px rgba(15, 23, 42, 0.11);
      backdrop-filter: blur(8px);
    }
    .topbar::-webkit-scrollbar { display: none; }
    .topbar button { padding: 4px 8px; font-size: 12px; white-space: nowrap; flex-shrink: 0; }
    .topbar-left, .topbar-right { display: flex; align-items: center; gap: 5px; min-width: 0; flex-shrink: 0; }
    .divider { width: 1px; height: 20px; background: var(--border); margin: 0 2px; flex-shrink: 0; }
    .proj-name {
      font-weight: 600;
      font-size: 12px;
      border: 1px solid transparent;
      border-radius: 5px;
      padding: 2px 5px;
      max-width: 145px;
      background: transparent;
      text-overflow: ellipsis;
    }
    .proj-name:hover { border-color: var(--border); background: #fff; }
    .proj-name:focus { outline: none; border-color: var(--accent); background: #fff; }
    .save-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 99px;
      background: var(--success-soft);
      color: var(--success);
      white-space: nowrap;
    }
    .save-badge.dirty { background: #FEF3C7; color: #92400E; }

    /* DOCK */
    .dock {
      pointer-events: auto;
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 5px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
    }
    .dock button { border-radius: 999px; padding: 6px 12px; font-size: 12px; font-weight: 600; }
    .dock button.active { background: var(--text-primary); color: #fff; }

    /* DRAWER */
    .drawer {
      pointer-events: auto;
      position: fixed;
      top: 54px;
      right: 10px;
      bottom: 12px;
      width: 348px;
      max-width: calc(100vw - 20px);
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .drawer.hidden { display: none !important; }
    .drawer-head {
      padding: 10px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: #fff;
    }
    .search-row { display: flex; align-items: center; gap: 5px; }
    .search-box {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 5px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 7px;
      background: #F8FAFC;
    }
    .search-box:focus-within { border-color: var(--accent); background: #fff; }
    .search-box input { border: none; outline: none; background: transparent; width: 100%; font-size: 12px; }
    .pin-f {
      font-size: 11px;
      font-weight: 800;
      padding: 4px 7px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #fff;
      color: var(--text-secondary);
    }
    .pin-f.on { background: #1E293B; color: #fff; border-color: #1E293B; }
    .stepper {
      display: flex;
      align-items: center;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #fff;
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      font-weight: 600;
    }
    .stepper button { padding: 4px 5px; border-radius: 4px; }
    .stepper span { padding: 0 4px; color: var(--text-secondary); white-space: nowrap; }

    .filter-chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .chip {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 99px;
      border: 1px solid var(--border);
      background: #fff;
      color: var(--text-secondary);
      gap: 5px;
    }
    .chip:hover { background: var(--bg-muted); color: var(--text-primary); }
    .chip.on { background: var(--text-primary); color: #fff; border-color: var(--text-primary); }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }

    /* TABLE */
    .table-wrap { flex: 1; overflow: auto; background: #fff; outline: none; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #F8FAFC;
      border-bottom: 1px solid var(--border);
      padding: 7px 6px;
      text-align: left;
      font-size: 11px;
      font-weight: 700;
      color: var(--text-secondary);
      text-transform: uppercase;
    }
    tbody tr { border-bottom: 1px solid #F1F5F9; cursor: pointer; }
    tbody tr:hover { background: #F8FAFC; }
    tbody tr.focused { background: #DBEAFE !important; }
    tbody tr.selected { background: #F0F9FF; }
    tbody tr.linked-highlight { background: #FEF2F2; }
    tbody td { padding: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
    .num-cell { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-secondary); }
    .eq-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      background: #FEE2E2;
      color: #991B1B;
      margin-left: 4px;
    }
    .remate-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      background: #EDE9FE;
      color: #6D28D9;
      margin-left: 4px;
    }
    @keyframes gnatSpin { to { transform: rotate(360deg); } }
    .sync-spin {
      display: inline-block; width: 11px; height: 11px; border: 2px solid #CBD5E1;
      border-top-color: #2563EB; border-radius: 50%; animation: gnatSpin 0.7s linear infinite;
      margin-right: 4px; vertical-align: -2px; flex-shrink: 0;
    }
    .sync-cancel {
      border: none; background: transparent; color: #94A3B8; cursor: pointer;
      font-size: 12px; padding: 0 3px; line-height: 1; margin-left: 3px;
    }
    .sync-cancel:hover { color: #DC2626; }
    .status-dot {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      margin-right: 5px; vertical-align: middle; flex-shrink: 0;
    }
    .search-missing-note {
      font-size: 11px; color: #DC2626; background: #FEF2F2; border: 1px solid #FECACA;
      border-radius: 6px; padding: 4px 7px; display: flex; align-items: center;
      justify-content: space-between; gap: 6px; line-height: 1.3;
    }
    .preview-wrap {
      max-height: 170px; overflow: auto; border: 1px solid var(--border);
      border-radius: 8px; background: #F8FAFC;
    }
    .preview-table { width: 100%; border-collapse: collapse; font-size: 11px; }
    .preview-table th, .preview-table td {
      padding: 4px 6px; border-bottom: 1px solid #E2E8F0; border-right: 1px solid #E2E8F0;
      text-align: left; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis;
    }
    .preview-table th { background: #EEF2FF; position: sticky; top: 0; }
    .preview-table select {
      font-size: 11px; padding: 2px 4px; border: 1px solid #94A3B8; border-radius: 4px;
      background: #fff; font-weight: 600; width: 100%;
    }
    .modal-body > *, .meta-card, .form-grid, .obs-list { flex-shrink: 0; }
    .obs-list {
      min-height: 68px; max-height: 150px; overflow-y: auto; border: 1px solid var(--border);
      border-radius: 7px; padding: 6px; background: #F8FAFC; display: flex;
      flex-direction: column; gap: 5px;
    }
    .search-missing-note.hidden, .sync-queue-bar.hidden { display: none !important; }
    .recent-swatches { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0; }
    .color-ref-dot {
      display: inline-block; width: 7px; height: 7px; border-radius: 50%;
      margin-left: 4px; vertical-align: middle; border: 1px solid rgba(15,23,42,0.2);
    }
    .obs-item {
      background: #fff; border: 1px solid #E2E8F0; border-radius: 5px; padding: 5px 7px; font-size: 11px;
    }
    .obs-date { font-size: 10px; color: #64748B; font-weight: 600; margin-bottom: 2px; }
    .sync-queue-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 6px;
      padding: 4px 10px; background: #EFF6FF; border-bottom: 1px solid #BFDBFE;
      font-size: 11px; color: #1E40AF; min-height: 28px;
    }
    .sync-queue-bar button {
      width: 24px; height: 22px; padding: 0; justify-content: center; font-size: 12px; border-radius: 5px;
      border: 1px solid #93C5FD; background: #fff; color: #1E40AF; cursor: pointer; font-weight: 700;
    }
    .sync-queue-bar button:hover { background: #DBEAFE; }
    .meta-card {
      background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px;
      padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
    }
    .meta-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      font-size: 11px; font-weight: 700; color: #334155;
    }
    .meta-grid {
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px;
    }
    .meta-kv {
      background: #fff; border: 1px solid #E2E8F0; border-radius: 6px; padding: 5px 7px;
    }
    .meta-k { font-size: 10px; color: #64748B; text-transform: uppercase; letter-spacing: 0.02em; }
    .meta-v { font-size: 12px; font-weight: 600; color: #0F172A; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta-alert {
      font-size: 11px; color: #B45309; background: #FFFBEB; border: 1px solid #FDE68A;
      border-radius: 6px; padding: 5px 8px; display: flex; align-items: center; justify-content: space-between; gap: 6px;
    }
    .prot-badge {
      display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 5px;
      border-radius: 4px; margin-left: 4px; background: #FEF2F2; color: #B91C1C; border: 1px solid #FECACA;
    }
    .prot-badge.bt { background: #FEF3C7; color: #92400E; border-color: #FDE68A; }
    .sel-mini-pill {
      display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 5px;
      border-radius: 99px; background: #DBEAFE; color: #1D4ED8; margin-left: 4px;
    }
    .inter-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 4px;
      background: #F1F5F9;
      color: #64748B;
      margin-left: 4px;
    }
    .ssee-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 4px;
      background: #FEF3C7;
      color: #92400E;
      margin-left: 4px;
    }
    .link-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      background: #F1F5F9;
      color: #475569;
      margin-left: 4px;
    }
    .zone-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 99px;
      font-size: 11px;
      font-weight: 700;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sup-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 20px;
      border-radius: 5px;
      font-size: 10px;
      font-weight: 700;
    }

    /* CONTEXTUAL BOTTOM BAR */
    .ctx-bar {
      padding: 8px 10px;
      background: #0F172A;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 5px;
      flex-wrap: wrap;
    }
    .ctx-bar.hidden { display: none; }
    .ctx-bar button {
      color: #fff;
      background: rgba(255,255,255,0.14);
      font-size: 11px;
      font-weight: 600;
      padding: 5px 7px;
    }
    .ctx-bar button:hover { background: rgba(255,255,255,0.24); }
    .ctx-bar button.ctx-accent { background: var(--accent); }
    .ctx-bar button.ctx-danger { background: var(--danger); }

    /* POPOVER */
    .popover {
      pointer-events: auto;
      position: fixed;
      min-width: 260px;
      max-width: 360px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
      padding: 8px;
      z-index: 20;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .pop-title { font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; padding: 4px 6px 2px; }
    .pop-item { width: 100%; justify-content: flex-start; padding: 6px 8px; font-size: 12px; border-radius: 6px; }
    .pop-sep { height: 1px; background: var(--border); margin: 4px 0; }
    .palette-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; padding: 6px; }
    .swatch { width: 22px; height: 22px; border-radius: 6px; border: 2px solid rgba(0,0,0,0.14); cursor: pointer; padding: 0; flex-shrink: 0; }
    .inline-input-row { display: flex; gap: 4px; padding: 3px; align-items: center; }
    .inline-input-row input { flex: 1; border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; font-size: 12px; min-width: 0; }

    /* MODAL */
    .modal-backdrop {
      pointer-events: auto;
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.45);
      display: grid;
      place-items: center;
      z-index: 30;
    }
    .modal-backdrop.hidden { display: none; }
    .modal-card {
      width: min(600px, 94vw);
      max-height: 86vh;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .modal-head { padding: 14px 18px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .modal-head h2 { margin: 0; font-size: 16px; }
    .modal-body { padding: 16px 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
    .dropzone { border: 2px dashed var(--border-strong); border-radius: 10px; padding: 20px; text-align: center; background: #F8FAFC; cursor: pointer; }
    .dropzone.drag { border-color: var(--accent); background: var(--accent-soft); }
    .recent-item { display: flex; align-items: center; justify-content: space-between; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
    .recent-item:hover { background: #F8FAFC; border-color: var(--border-strong); }
    .form-grid { display: grid; grid-template-columns: 115px 1fr; gap: 8px 10px; align-items: center; font-size: 12px; }
    .form-grid input, .form-grid select { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; width: 100%; }

    /* MODE BANNER & TOAST */
    .mode-banner {
      pointer-events: auto;
      position: fixed;
      top: 64px;
      left: 50%;
      transform: translateX(-50%);
      background: #0F172A;
      color: #fff;
      padding: 7px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      box-shadow: var(--shadow);
      display: flex;
      align-items: center;
      gap: 10px;
      z-index: 25;
    }
    .mode-banner.hidden { display: none; }
    .toast {
      pointer-events: none;
      position: fixed;
      bottom: 72px;
      left: 50%;
      transform: translateX(-50%);
      background: #1E293B;
      color: #fff;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      box-shadow: var(--shadow);
      z-index: 40;
      opacity: 0;
      transition: opacity 160ms ease;
    }
    .toast.show { opacity: 1; }
    .toast.err { background: #991B1B; }
    .pin-form {
      pointer-events: auto;
      position: fixed;
      width: 280px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
      box-shadow: var(--shadow);
      z-index: 28;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .pin-form input, .pin-form select { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; width: 100%; }
    .fab {
      pointer-events: auto;
      position: fixed;
      top: 10px;
      right: 10px;
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      justify-content: center;
      font-size: 18px;
      font-weight: 700;
    }
    .fab.hidden { display: none; }
  `;
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

  const btnArchivo = el("button", "btn-outline", "📁 Archivo ▾", topLeft);
  btnArchivo.title = "Proyectos recientes, importar KMZ/JSON/Preset PT o exportar CSV";

  const btnQuickSave = el("button", "btn-outline icon-btn", "💾", topLeft);
  btnQuickSave.title = "Guardar copia del proyecto (.json)";
  btnQuickSave.onclick = () => downloadJSON();

  const projNameInput = el("input", "proj-name", null, topLeft);
  projNameInput.type = "text";
  projNameInput.value = state.projectName;
  projNameInput.title = "Nombre del proyecto (clic para renombrar)";
  projNameInput.addEventListener("change", () => {
    state.projectName = projNameInput.value.trim() || "Proyecto sin título";
    projNameInput.value = state.projectName;
    markDirty();
  });

  const saveBadge = el("span", "save-badge", "Sin datos", topLeft);
  el("div", "divider", null, topLeft);

  const btnZonas = el("button", "btn-outline", "Zonas D/T/F ▾", topLeft);
  btnZonas.title = "Generar, editar o dibujar polígonos de Zona Desconectada (D), Zona de Trabajo (T) y Punto de Faenas (F)";

  const btnAnalyzeMt = el("button", "btn-primary", "⚡ Analizar Red MT", topLeft);
  btnAnalyzeMt.title = "Recorre los tramos MT desde los postes seleccionados (o Zona T), dibuja vectores A→B y detecta aperturas cercanas y remates aguas abajo";

  const btnVista = el("button", "btn-outline", "Vista ▾", topLeft);
  btnVista.title = "Mostrar/ocultar postes, polígonos, tramos MT, etiquetas y detalle WMTS";

  const btnHerramientas = el("button", "btn-outline", "Herramientas ▾", topLeft);
  btnHerramientas.title = "Buscar/pegar lista de códigos en GNAT, equipo de supervisores y demo Atlas PDF";

  const btnHidePoles = el("button", "btn-outline", "👁 Postes", topRight);
  btnHidePoles.title = "Ocultar o mostrar pines de postes para editar polígonos cómodamente";
  btnHidePoles.onclick = () => {
    state.hidePoles = !state.hidePoles;
    btnHidePoles.classList.toggle("active-pill", state.hidePoles);
    btnHidePoles.textContent = state.hidePoles ? "🚫 Postes ocultos" : "👁 Postes";
    rebuildOverlayLayers();
  };

  const btnFitAll = el("button", "btn-outline icon-btn", "⛶", topRight);
  btnFitAll.title = "Encuadrar todos los elementos visibles";
  btnFitAll.onclick = () => {
    const vis = getFilteredPoints().map(f => state.points.indexOf(f));
    if (vis.length) fitPoints(vis);
  };

  const btnToggleDrawer = el("button", "active-pill", "☰ Tabla", topRight);
  const btnCollapse = el("button", "btn-outline icon-btn", "—", topRight);
  const btnClose = el("button", "btn-outline icon-btn", "×", topRight);

  // DOCK INFERIOR
  const dock = el("div", "dock");
  const btnModeNav = el("button", "active", "↖ Navegar", dock);
  const btnModeBox = el("button", "", "⬚ Seleccionar área", dock);
  const btnModeAdd = el("button", "", "+ Agregar en mapa", dock);
  const btnModePoly = el("button", "", "✏️ Editar polígono", dock);
  btnModePoly.title = "Arrastrar vértices de polígonos D/T/F (oculta o ignora pines de postes al arrastrar)";

  // CAJÓN LATERAL
  const drawer = el("aside", "drawer");
  const drawerHead = el("div", "drawer-head", null, drawer);
  const searchRow = el("div", "search-row", null, drawerHead);

  const searchBox = el("div", "search-box", null, searchRow);
  el("span", "", "🔍", searchBox);
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
    saveBadge.textContent = txt;
    saveBadge.classList.toggle("dirty", state.dirty);
  }

  let toastTimer = null;
  function showToast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.className = "toast show" + (isError ? " err" : "");
    w.clearTimeout(toastTimer);
    toastTimer = w.setTimeout(() => toastEl.classList.remove("show"), 3600);
  }

  function closePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
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

    topbar.style.left = `${leftPx}px`;
    topbar.style.width = "auto";
    topbar.style.maxWidth = `${maxBarW}px`;
    topbar.style.top = `${topPx}px`;

    drawer.style.top = `${topPx + 46}px`;
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
      const t = tok.toLocaleLowerCase("es");
      const tF = state.autoPrefixF && /^\d+$/.test(t) ? "f" + t : t;
      const code = getPointCode(f).toLocaleLowerCase("es");
      const ter = String(f.get("codigoTerreno") || "").toLocaleLowerCase("es");
      const num = String(f.get("numero") || "").toLocaleLowerCase("es");
      const rol = String(f.get("rolPT") || "").toLocaleLowerCase("es");
      const zids = getPointZoneIds(f).join(" ").toLocaleLowerCase("es");
      const eq = String(f.get("tipoEquipo") || "").toLocaleLowerCase("es");
      const st = (state.statuses.get(f.get("estadoEjec") || "pendiente")?.name || "").toLocaleLowerCase("es");
      if (isMultiToken) {
        return code === t || code === tF || code.includes(t) || (ter && (ter === t || ter.includes(t))) || num === t || rol === t;
      }
      const haystack = `${num} ${code} ${ter} ${zids} ${eq} ${rol} ${st}`;
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

    const style = new ol.style.Style({
      image: isOpening
        ? new ol.style.RegularShape({
            points: 4,
            radius: isFocused ? 14 : (isSelected || isLinkedPeer) ? 12 : 10,
            radius2: 0,
            angle: Math.PI / 4,
            stroke: new ol.style.Stroke({
              color: isSelected ? "#1D4ED8" : color,
              width: isFocused || isLinkedPeer ? 5 : 4
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
    cache.set(key, style);
    return style;
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
      for (const z of state.zones.values()) {
        if (state.filterZones.size > 0 && !state.filterZones.has(z.id)) continue;
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
        const sf = new ol.Feature({ geometry: new ol.geom.LineString(mapCoords) });
        sf.setStyle([
          new ol.style.Style({
            stroke: new ol.style.Stroke({ color: "rgba(255,255,255,0.85)", width: 6.5, lineCap: "round", lineJoin: "round" })
          }),
          new ol.style.Style({
            stroke: new ol.style.Stroke({ color: "#DC2626", width: 3.8, lineCap: "round", lineJoin: "round" }),
            text: state.labelMode === "siempre" ? new ol.style.Text({
              text: sp.display || `${sp.from}-${sp.to}`,
              font: "600 10px Arial",
              fill: new ol.style.Fill({ color: "#991B1B" }),
              stroke: new ol.style.Stroke({ color: "#FFFFFF", width: 3 })
            }) : undefined
          })
        ]);
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

  btnAnalyzeMt.onclick = runMtNetworkDiscovery;

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
      state.hiddenStatuses.clear();
      state.filterSups.clear();
      refreshAll();
    });

    makeChip("Postes", state.filterTypes.has("PUNTO"), () => toggleTypeChip("PUNTO"));
    makeChip("Aperturas ✕", state.filterTypes.has("APERTURA"), () => toggleTypeChip("APERTURA"), OPENING_COLOR);

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
    const visibleZones = Math.max(0, totalZones - state.hiddenZones.size);
    const zChipLabel = state.hiddenZones.size > 0 ? `Zonas (${visibleZones}/${totalZones}) ▾` : "Zonas ▾";
    const cZones = makeChip(zChipLabel, state.hiddenZones.size > 0, (ev) => {
      openZonesVisibilityPopover(ev.currentTarget);
    }, null, "Mostrar u ocultar zonas individuales");
    cZones.style.fontWeight = "600";

    // Desplegable compacto de visibilidad de Estados
    const totalSt = state.statuses.size;
    const visSt = Math.max(0, totalSt - state.hiddenStatuses.size);
    const stChipLabel = state.hiddenStatuses.size > 0 ? `Estados (${visSt}/${totalSt}) ▾` : "Estados ▾";
    const cSt = makeChip(stChipLabel, state.hiddenStatuses.size > 0, (ev) => {
      openStatusesVisibilityPopover(ev.currentTarget);
    }, null, "Filtrar por estado de ejecución o crear nuevos estados");
    cSt.style.fontWeight = "600";
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
    // Actualizar etiqueta dinámica de Analizar Red MT para dejar claro su alcance
    const hasFilter = state.filterTypes.size > 0 || state.hiddenZones.size > 0 || state.hiddenStatuses.size > 0 || Boolean(state.search.trim());
    if (state.selected.size > 0) {
      btnAnalyzeMt.textContent = `⚡ Analizar MT (${state.selected.size} sel.)`;
    } else if (hasFilter && visible.length > 0) {
      btnAnalyzeMt.textContent = `⚡ Analizar MT (${visible.length} vis.)`;
    } else {
      btnAnalyzeMt.textContent = "⚡ Analizar Red MT";
    }
    const multiSup = isMultiSupActive();
    const focusedFeat = state.points[state.focused];
    const linkedPeerSet = new Set(
      focusedFeat
        ? (focusedFeat.get("tipo") === "APERTURA"
            ? getLinkedPostesForOpening(focusedFeat)
            : getLinkedOpeningsForPoste(focusedFeat))
        : []
    );

    thead.replaceChildren();
    const trh = el("tr", "", null, thead);
    const thCheck = el("th", "", null, trh);
    thCheck.style.width = "28px";
    const checkAll = el("input", "", null, thCheck);
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

    const makeSortableTh = (key, label, width = "") => {
      const arrow = state.sortBy === key ? (state.sortDir === "asc" ? " ▴" : " ▾") : "";
      const th = el("th", "", label + arrow, trh);
      if (width) th.style.width = width;
      th.style.cursor = "pointer";
      th.style.userSelect = "none";
      th.title = "Clic para ordenar ascendente / descendente";
      th.onclick = () => {
        if (state.sortBy === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        else { state.sortBy = key; state.sortDir = "asc"; }
        renderTable();
      };
      return th;
    };
    makeSortableTh("numero", "Rol/N°", "54px");
    makeSortableTh("codigo", "Código");
    makeSortableTh("zona", "D / T / F", "88px");
    if (multiSup) {
      const thS = el("th", "", "Sup.", trh);
      thS.style.width = "40px";
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
      const na = Number(a.get("numero")) || 0;
      const nb = Number(b.get("numero")) || 0;
      if (na !== nb) return (na - nb) * mul;
      return String(a.get("rolPT") || "").localeCompare(String(b.get("rolPT") || ""), "es", { numeric: true }) * mul;
    });
    const frag = doc.createDocumentFragment();
    for (const f of sortedVisible) {
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
      tr.style.borderLeft = `3px solid ${pColor}`;

      const tdCb = doc.createElement("td");
      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.checked = isSel;
      cb.onclick = (ev) => ev.stopPropagation();
      cb.onchange = () => {
        if (cb.checked) state.selected.add(idx);
        else state.selected.delete(idx);
        renderTable();
        rebuildOverlayLayers();
      };
      tdCb.appendChild(cb);
      tr.appendChild(tdCb);

      const tdN = doc.createElement("td");
      tdN.className = "num-cell";
      tdN.textContent = String(f.get("rolPT") || f.get("numero"));
      tr.appendChild(tdN);

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
      const codeSpan = doc.createElement("span");
      codeSpan.textContent = (isAp ? "✕ " : "") + getPointCode(f);
      if (isAp) codeSpan.style.color = OPENING_COLOR;
      codeSpan.style.fontWeight = "600";
      tdCode.appendChild(codeSpan);
      if (syncSt === "loading") {
        const bStop = doc.createElement("button");
        bStop.className = "sync-cancel";
        bStop.textContent = "×";
        bStop.title = "Cancelar búsqueda de este código";
        bStop.onclick = (ev) => {
          ev.stopPropagation();
          f.set("syncStatus", "cancelled");
          renderTable();
        };
        tdCode.appendChild(bStop);
      }
      const obsArr = Array.isArray(f.get("observaciones")) ? f.get("observaciones") : [];
      if (obsArr.length > 0) {
        const ob = doc.createElement("span");
        ob.className = "inter-badge";
        ob.textContent = `📝${obsArr.length}`;
        ob.title = obsArr[obsArr.length - 1].text;
        tdCode.appendChild(ob);
      }

      const protObj = PROTECTION_TYPES.find(p => p.id && p.id === f.get("proteccionTipo"));
      if (protObj) {
        const pb = doc.createElement("span");
        pb.className = "prot-badge" + (protObj.level === "BT" ? " bt" : "");
        pb.textContent = protObj.short;
        pb.title = protObj.label;
        tdCode.appendChild(pb);
      }
      const eqType = String(f.get("tipoEquipo") || "").trim();
      const eptTxt = String(f.get("eptTipo") || "").trim();
      if (eptTxt) {
        const eq = doc.createElement("span");
        eq.className = "eq-badge";
        eq.textContent = eptTxt;
        tdCode.appendChild(eq);
      } else if (eqType && !protObj) {
        const eq = doc.createElement("span");
        eq.className = "eq-badge";
        eq.textContent = eqType;
        tdCode.appendChild(eq);
      }
      if (f.get("esRemate")) {
        const rb = doc.createElement("span");
        rb.className = "remate-badge";
        rb.textContent = "▲ Remate";
        tdCode.appendChild(rb);
      } else if (f.get("esIntermedio") && !f.get("rolPT")) {
        const ib = doc.createElement("span");
        ib.className = "inter-badge";
        ib.textContent = "Intermedio";
        tdCode.appendChild(ib);
      }
      const custCol = String(f.get("colorPersonalizado") || "").trim();
      if (isHex(custCol)) {
        const cd = doc.createElement("span");
        cd.className = "color-ref-dot";
        cd.style.background = custCol;
        cd.title = `Color propio: ${custCol}`;
        tdCode.appendChild(cd);
      }
      const sseeTxt = String(f.get("sseeCode") || "").trim();
      if (sseeTxt && !eqType.includes(sseeTxt)) {
        const sb = doc.createElement("span");
        sb.className = "ssee-badge";
        sb.textContent = sseeTxt;
        tdCode.appendChild(sb);
      }
      tdCode.title = `${getPointCode(f)} ${f.get("accionPT") ? "· " + f.get("accionPT") : ""}`;
      tr.appendChild(tdCode);

      const tdZ = doc.createElement("td");
      const zids = getPointZoneIds(f);
      if (zids.length) {
        for (const zid of zids.slice(0, 3)) {
          const z = state.zones.get(zid);
          const pill = doc.createElement("span");
          pill.className = "zone-pill";
          pill.style.marginRight = "2px";
          const c = z?.color || HIGH_CONTRAST_PALETTE[0];
          pill.style.background = hexToRgba(c, 0.16);
          pill.style.color = "#0F172A";
          pill.style.border = `1px solid ${c}`;
          pill.textContent = zid;
          pill.title = z?.name || zid;
          tdZ.appendChild(pill);
        }
      } else {
        tdZ.textContent = "—";
        tdZ.style.color = "#94A3B8";
      }
      tr.appendChild(tdZ);

      if (multiSup) {
        const tdS = doc.createElement("td");
        const sup = state.supervisors.get(getSupId(f)) || DEFAULT_SUPERVISORS[0];
        const b = doc.createElement("span");
        b.className = "sup-badge";
        b.style.background = sup.color;
        b.style.color = contrastText(sup.color);
        b.textContent = sup.initials;
        tdS.appendChild(b);
        tr.appendChild(tdS);
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
        tdBar.colSpan = multiSup ? 5 : 4;
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
    for (const idx of indices) {
      const f = state.points[idx];
      if (f) f.set("estadoEjec", statusId);
    }
    markDirty();
    refreshAll();
    showToast(`Estado "${state.statuses.get(statusId).name}" asignado a ${indices.length} elemento(s).`);
  }

  function openZonesVisibilityPopover(anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      pop.style.minWidth = "250px";
      const topRow = el("div", "", null, pop);
      topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:2px 6px 6px;";
      el("span", "pop-title", "Visibilidad de Zonas", topRow).style.padding = "0";
      const bAll = el("button", "btn-outline", "Todas", topRow);
      bAll.style.cssText = "padding:2px 6px;font-size:10px;";
      bAll.onclick = () => { state.hiddenZones.clear(); refreshAll(); openZonesVisibilityPopover(anchorEl); };

      const listWrap = el("div", "", null, pop);
      listWrap.style.cssText = "max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;";

      const addRow = (id, label, color) => {
        const row = el("div", "", null, listWrap);
        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 6px;border-radius:6px;";
        const lbl = el("label", "", null, row);
        lbl.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;flex:1;min-width:0;";
        const cb = el("input", "", null, lbl);
        cb.type = "checkbox";
        cb.checked = !state.hiddenZones.has(id);
        cb.onchange = () => {
          if (cb.checked) state.hiddenZones.delete(id);
          else state.hiddenZones.add(id);
          refreshAll();
        };
        if (color) {
          const d = el("span", "dot", null, lbl);
          d.style.background = color;
        }
        const sp = el("span", "", label, lbl);
        sp.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        const bSolo = el("button", "btn-outline", "Solo", row);
        bSolo.style.cssText = "padding:1px 6px;font-size:10px;";
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
    const r = anchorEl.getBoundingClientRect();
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      pop.style.minWidth = "240px";
      const topRow = el("div", "", null, pop);
      topRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:2px 6px 6px;";
      el("span", "pop-title", "Estados de ejecución", topRow).style.padding = "0";
      const bAll = el("button", "btn-outline", "Todos", topRow);
      bAll.style.cssText = "padding:2px 6px;font-size:10px;";
      bAll.onclick = () => { state.hiddenStatuses.clear(); refreshAll(); openStatusesVisibilityPopover(anchorEl); };

      for (const st of state.statuses.values()) {
        const row = el("label", "pop-item", null, pop);
        row.style.cursor = "pointer";
        const cb = el("input", "", null, row);
        cb.type = "checkbox";
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
  btnArchivo.onclick = () => {
    const r = btnArchivo.getBoundingClientRect();
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      const bRec = el("button", "pop-item", "🏠 Proyectos recientes / Nuevo en blanco", pop);
      bRec.onclick = () => { closePopover(); openStartModal(); };

      const bImp = el("button", "pop-item", "📂 Abrir / Importar (KMZ, JSON, Preset PT, CSV)...", pop);
      bImp.onclick = () => { closePopover(); hiddenFileInput.click(); };

      el("div", "pop-sep", null, pop);
      const bSaveCopy = el("button", "pop-item", "💾 Guardar como (.json en PC)", pop);
      bSaveCopy.onclick = () => { closePopover(); downloadJSON(); };

      const bExpKmz = el("button", "pop-item", "🌍 Exportar mapa completo (.kmz)", pop);
      bExpKmz.disabled = state.points.length === 0 && state.spans.length === 0;
      bExpKmz.onclick = () => { closePopover(); downloadKMZ(); };

      const bExpCsv = el("button", "pop-item", "📊 Exportar tabla (.csv)", pop);
      bExpCsv.disabled = state.points.length === 0;
      bExpCsv.onclick = () => { closePopover(); downloadCSV(); };

      if (typeof w.showDirectoryPicker === "function") {
        el("div", "pop-sep", null, pop);
        const label = !state.backupDirHandle
          ? "📁 Carpeta autoguardado (OneDrive / PC)..."
          : state.backupDirPerm === "granted"
            ? `📁 Carpeta activa: ${state.backupDirHandle.name} ✓ (cambiar)`
            : `⚠️ Reautorizar carpeta: ${state.backupDirHandle.name}`;
        const bDir = el("button", "pop-item", label, pop);
        bDir.onclick = async () => {
          closePopover();
          try {
            if (state.backupDirHandle && state.backupDirPerm !== "granted") {
              const p = await state.backupDirHandle.requestPermission({ mode: "readwrite" });
              state.backupDirPerm = p;
              if (p === "granted") {
                await autosaveNow();
                showToast(`Carpeta "${state.backupDirHandle.name}" reconectada.`);
                return;
              }
            }
            const handle = await w.showDirectoryPicker({ mode: "readwrite", startIn: "documents" });
            state.backupDirHandle = handle;
            state.backupDirPerm = "granted";
            await dbSaveSetting("backupDirHandle", handle);
            await autosaveNow();
            showToast(`Carpeta "${handle.name}" vinculada.`);
          } catch (_) {}
        };
      }
    });
  };

  btnZonas.onclick = () => {
    const r = btnZonas.getBoundingClientRect();
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      el("div", "pop-title", "Zonas (D: Desconectada · T: Trabajo · F: Faenas)", pop);
      for (const z of state.zones.values()) {
        const row = el("div", "inline-input-row", null, pop);
        const colorBtn = el("button", "swatch", "", row);
        colorBtn.style.background = z.color;
        colorBtn.title = "Cambiar color";
        colorBtn.onclick = () => openColorPickerPopover(colorBtn, z.color, (newColor) => {
          z.color = newColor;
          styleCache = new WeakMap();
          markDirty();
          refreshAll();
        });

        const nameInp = el("input", "", null, row);
        nameInp.type = "text";
        nameInp.value = z.name || z.id;
        nameInp.onchange = () => {
          z.name = nameInp.value.trim() || z.id;
          markDirty();
          refreshAll();
        };

        const bAutoPoly = el("button", "btn-outline icon-btn", "🔄", row);
        bAutoPoly.title = `Autogenerar polígono de "${z.name}" envolviendo sus puntos`;
        bAutoPoly.onclick = () => { closePopover(); generateZonePolygonFromPoints(z.id); };

        const bEditPoly = el("button", "btn-outline icon-btn", "✏️", row);
        bEditPoly.title = `Editar vértices del polígono "${z.name}"`;
        bEditPoly.onclick = () => { closePopover(); startPolygonEditMode(z.id); };

        const bDrawPoly = el("button", "btn-outline icon-btn", "🖊", row);
        bDrawPoly.title = `Dibujar polígono nuevo a mano para "${z.name}"`;
        bDrawPoly.onclick = () => { closePopover(); startPolygonDrawMode(z.id); };

        if (!["D", "T", "F"].includes(z.id)) {
          const bDelZ = el("button", "btn-outline icon-btn", "🗑", row);
          bDelZ.title = `Eliminar zona "${z.id}"`;
          bDelZ.style.color = "var(--danger)";
          bDelZ.onclick = () => { deleteZone(z.id); btnZonas.click(); };
        }
      }

      el("div", "pop-sep", null, pop);
      const newRow = el("div", "inline-input-row", null, pop);
      const inpNew = el("input", "", null, newRow);
      inpNew.placeholder = "Crear otra zona (ej. Tramo 2)...";
      const bAdd = el("button", "btn-primary", "+ Crear", newRow);
      bAdd.onclick = () => {
        const val = inpNew.value.trim();
        if (!val) return;
        createZone(val);
        btnZonas.click();
      };

      el("div", "pop-sep", null, pop);
      const bAutoAll = el("button", "pop-item", "⚡ Autogenerar polígonos D, T y F desde sus puntos", pop);
      bAutoAll.onclick = () => {
        closePopover();
        for (const z of state.zones.values()) {
          const pts = state.points.filter(f => getPointZoneIds(f).includes(z.id));
          if (pts.length >= 3) generateZonePolygonFromPoints(z.id);
        }
      };
    });
  };

  btnVista.onclick = () => {
    const r = btnVista.getBoundingClientRect();
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      el("div", "pop-title", "Capas visuales", pop);
      const bPoles = el("button", "pop-item", (!state.hidePoles ? "☑ " : "☐ ") + "Mostrar pines de postes (desmarca para editar polígonos)", pop);
      bPoles.onclick = () => { btnHidePoles.click(); closePopover(); };

      const bHulls = el("button", "pop-item", (state.showHulls ? "☑ " : "☐ ") + "Polígonos de zonas (D / T / F)", pop);
      bHulls.onclick = () => { state.showHulls = !state.showHulls; rebuildOverlayLayers(); closePopover(); };

      const bSpans = el("button", "pop-item", (state.showSpans ? "☑ " : "☐ ") + "Vectores de tramos MT (A→B)", pop);
      bSpans.onclick = () => { state.showSpans = !state.showSpans; rebuildOverlayLayers(); closePopover(); };

      const bRoute = el("button", "pop-item", (state.showRoute ? "☑ " : "☐ ") + "Línea secuencial de ruta (1→2→3)", pop);
      bRoute.onclick = () => { state.showRoute = !state.showRoute; rebuildOverlayLayers(); closePopover(); };

      const bLinks = el("button", "pop-item", (state.showLinks ? "☑ " : "☐ ") + "Rayos a aperturas vinculadas al enfocar", pop);
      bLinks.onclick = () => { state.showLinks = !state.showLinks; rebuildOverlayLayers(); closePopover(); };

      el("div", "pop-sep", null, pop);
      el("div", "pop-title", "Etiquetas", pop);
      for (const [val, lbl] of [["cerca", "Al acercar zoom"], ["siempre", "Siempre visibles"], ["ninguna", "Ocultar etiquetas"]]) {
        const b = el("button", "pop-item", (state.labelMode === val ? "● " : "○ ") + lbl, pop);
        b.onclick = () => { state.labelMode = val; styleCache = new WeakMap(); rebuildOverlayLayers(); closePopover(); };
      }
      const bTxt = el("button", "pop-item", state.labelContent === "numero" ? "Texto: Rol/N° (clic para Rol/N° + Código)" : "Texto: Rol/N° + Código", pop);
      bTxt.onclick = () => {
        state.labelContent = state.labelContent === "numero" ? "completo" : "numero";
        styleCache = new WeakMap();
        rebuildOverlayLayers();
        closePopover();
      };

      el("div", "pop-sep", null, pop);
      el("div", "pop-title", "Detalle red MT/BT (WMTS)", pop);
      const mtRow = el("div", "", null, pop);
      mtRow.style.cssText = "display:flex;gap:4px;padding:4px;";
      for (const lvl of [0, 1, 2]) {
        const b = el("button", state.mtbtDetail === lvl ? "active-pill" : "btn-outline", lvl === 0 ? "Original" : `+${lvl}`, mtRow);
        b.style.flex = "1";
        b.style.justifyContent = "center";
        b.onclick = () => { setMtBtDetail(lvl); closePopover(); };
      }
    });
  };

  btnHerramientas.onclick = () => {
    const r = btnHerramientas.getBoundingClientRect();
    showPopoverAt(r.left, r.bottom + 6, (pop) => {
      const bPaste = el("button", "pop-item", "📋 Buscar / agregar lista de códigos o tabla en GNAT...", pop);
      bPaste.onclick = () => { closePopover(); openPasteCodesModal(); };

      const bTeam = el("button", "pop-item", "👥 Equipo / Supervisores (CC, TL, RD, JB)...", pop);
      bTeam.onclick = () => { closePopover(); openSupervisorsModal(); };

      const bClearSpans = el("button", "pop-item", "🧹 Limpiar vectores MT trazados", pop);
      bClearSpans.onclick = () => {
        closePopover();
        state.spans = [];
        state.graphNodes = [];
        markDirty();
        rebuildOverlayLayers();
      };

      el("div", "pop-sep", null, pop);
      const bPdf = el("button", "pop-item", "🖨 Exportar plano PDF (Demo)...", pop);
      bPdf.onclick = () => { closePopover(); openAtlasPdfModal(); };
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
          if (!visible.has(f)) return;
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
    inpCode.addEventListener("input", () => { userTyped = true; });

    // Autocompletar código y coordenada exacta desde GNAT bajo el clic
    (async () => {
      try {
        const info = await inspectPoleNeighborhoodInGnat("", snappedLonLat);
        const foundCode = info.detectedPoleCode || info.devices[0]?.code || "";
        if (info.sseeList[0]) detectedSsee = `SSEE ${info.sseeList[0]}`;
        if (foundCode) {
          if (!userTyped) inpCode.value = foundCode;
          const exact = await resolveCodeInGnat(foundCode, true);
          if (exact?.lonlat) snappedLonLat = exact.lonlat;
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
        bloques: [selZone.value],
        sseeCode: detectedSsee
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
  }

  async function openStartModal() {
    modalBackdrop.replaceChildren();
    modalBackdrop.classList.remove("hidden");
    const card = el("div", "modal-card", null, modalBackdrop);
    const head = el("div", "modal-head", null, card);
    el("h2", "", "Centrality · Planificación D / T / F", head);
    const bBlank = el("button", "btn-primary", "Empezar en mapa vacío", head);
    bBlank.onclick = closeModal;

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
    el("h2", "", `Detalles · ${getPointCode(f)}`, head);
    const bClose = el("button", "btn-outline", "×", head);
    bClose.onclick = closeModal;

    const body = el("div", "modal-body", null, card);

    // 1. Ficha ordenada de Metadata GNAT
    const metaCard = el("div", "meta-card", null, body);
    const renderMetaCard = () => {
      metaCard.replaceChildren();
      const gm = f.get("gnatMeta") || {};
      const st = f.get("syncStatus") || "ok";
      const note = String(f.get("syncNote") || "");
      const mHead = el("div", "meta-head", null, metaCard);
      const badgeTxt = st === "loading" ? "⏳ Sincronizando con GNAT..."
        : st === "mismatch" ? "⚠️ Inconsistencia detectada"
        : st === "not_found" ? "⚠️ No encontrado en GNAT"
        : gm.syncedAt ? `✓ Metadata GNAT (${gm.syncedAt})`
        : "Metadata GNAT (pendiente)";
      const lbl = el("span", "", badgeTxt, mHead);
      lbl.style.color = (st === "mismatch" || st === "not_found") ? "#B45309" : gm.syncedAt ? "#15803D" : "#475569";

      const bVerify = el("button", "btn-outline", "🔄 Verificar en GNAT", mHead);
      bVerify.style.cssText = "padding:2px 8px;font-size:11px;";
      bVerify.onclick = async () => {
        bVerify.disabled = true;
        await syncSinglePointWithGnat(f, true);
        bVerify.disabled = false;
        renderMetaCard();
        if (f.get("sseeCode") && !inpSsee.value.trim()) inpSsee.value = String(f.get("sseeCode")).replace(/^SSEE\s+/i, "");
        if (f.get("proteccionTipo") && !selProt.value) selProt.value = f.get("proteccionTipo");
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

      if (note) {
        const alertBox = el("div", "meta-alert", null, metaCard);
        el("span", "", note, alertBox);
        if (Array.isArray(gm.gnatLonLat) && gm.gnatLonLat.length === 2) {
          const bSnap = el("button", "btn-outline", "Usar coord. GNAT", alertBox);
          bSnap.style.cssText = "padding:2px 7px;font-size:10px;white-space:nowrap;";
          bSnap.onclick = () => {
            const proj = map.getView().getProjection();
            f.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(gm.gnatLonLat, proj)));
            gm.distMeters = 0;
            f.set("gnatMeta", gm);
            f.set("syncNote", "");
            f.set("syncStatus", "ok");
            ensureVectorLayer();
            markDirty();
            refreshAll();
            renderMetaCard();
            showToast("Coordenada ajustada al poste real en GNAT.");
          };
        }
      }
    };
    renderMetaCard();

    // 2. Identificación y Operación (Protección separada de EPT + S/E + Terreno)
    const grid = el("div", "form-grid", null, body);

    el("label", "", "N° / Rol PT:", grid);
    const numRow = el("div", "", null, grid);
    numRow.style.cssText = "display:flex;gap:6px;";
    const inpNum = el("input", "", null, numRow);
    inpNum.type = "number";
    inpNum.style.width = "76px";
    inpNum.value = String(f.get("numero") || "");
    const inpRol = el("input", "", null, numRow);
    inpRol.style.flex = "1";
    inpRol.placeholder = "Rol opcional (ej. T1, F1)";
    inpRol.value = String(f.get("rolPT") || "");

    el("label", "", "Código Poste (GNAT):", grid);
    const inpCode = el("input", "", null, grid);
    inpCode.value = getPointCode(f);

    el("label", "", "Cód. Subestación (S/E):", grid);
    const inpSsee = el("input", "", null, grid);
    inpSsee.placeholder = "Ej. F75219 (asume DF XS al sincronizar)";
    inpSsee.value = String(f.get("sseeCode") || "").replace(/^SSEE\s+/i, "");

    el("label", "", "Código en terreno:", grid);
    const inpTer = el("input", "", null, grid);
    inpTer.placeholder = "Opcional (buscable desde el filtro principal)";
    inpTer.value = String(f.get("codigoTerreno") || "");

    el("label", "", "Estado:", grid);
    const selSt = el("select", "", null, grid);
    for (const st of state.statuses.values()) {
      const o = el("option", "", st.name, selSt);
      o.value = st.id;
    }
    selSt.value = String(f.get("estadoEjec") || "pendiente");

    el("label", "", "Categoría:", grid);
    const selKind = el("select", "", null, grid);
    [["PUNTO", "Poste / Punto"], ["APERTURA", "Apertura (✕ roja)"]].forEach(([v, t]) => {
      const o = el("option", "", t, selKind); o.value = v;
    });
    selKind.value = f.get("tipo") || "PUNTO";

    el("label", "", "Protección / Apertura:", grid);
    const selProt = el("select", "", null, grid);
    PROTECTION_TYPES.forEach(p => {
      const o = el("option", "", p.label, selProt); o.value = p.id;
    });
    selProt.value = String(f.get("proteccionTipo") || "");

    el("label", "", "Puesta a Tierra (EPT):", grid);
    const selEpt = el("select", "", null, grid);
    EPT_TYPES.forEach(t => {
      const o = el("option", "", t || "— Ninguna —", selEpt); o.value = t;
    });
    selEpt.value = String(f.get("eptTipo") || "");

    el("label", "", "Acción a ejecutar:", grid);
    const inpAccion = el("input", "", null, grid);
    inpAccion.value = String(f.get("accionPT") || "");

    // 3. Bitácora de observaciones con fecha y hora automática
    const obsTitle = el("div", "", "Observaciones (fecha y hora automática):", body);
    obsTitle.style.cssText = "font-size:12px;font-weight:700;color:#334155;margin-top:2px;";
    const obsList = el("div", "obs-list", null, body);
    const localObs = Array.isArray(f.get("observaciones")) ? f.get("observaciones").map(x => ({ ...x })) : [];
    const renderObs = () => {
      obsList.replaceChildren();
      if (!localObs.length) {
        el("div", "", "Sin observaciones registradas.", obsList).style.cssText = "font-size:11px;color:#94A3B8;padding:4px;";
        return;
      }
      for (const o of [...localObs].reverse()) {
        const it = el("div", "obs-item", null, obsList);
        el("div", "obs-date", o.at || "", it);
        el("div", "", o.text || "", it);
      }
    };
    renderObs();

    const addObsRow = el("div", "inline-input-row", null, body);
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
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:6px;";
    const bCancel = el("button", "btn-outline", "Cancelar", footer);
    bCancel.onclick = closeModal;
    const bSave = el("button", "btn-primary", "Guardar", footer);
    bSave.onclick = () => {
      pushObs();
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
      if ((chosenProt && chosenProt !== prevProt) || (sseeClean && `SSEE ${sseeClean}` !== prevSsee)) {
        enqueueGnatMetadataSync([f], true);
      }
    };
  }

  // Extrae coordenadas desde texto libre, fila de Excel o link de Google Maps
  function extractLatLonFromLine(line) {
    const gmap = /@(-?\d+\.\d+),(-?\d+\.\d+)|[?&](?:q|ll)=(-?\d+\.\d+),(-?\d+\.\d+)|!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(line);
    if (gmap) {
      const lat = Number(gmap[1] || gmap[3] || gmap[5]);
      const lon = Number(gmap[2] || gmap[4] || gmap[6]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lon, lat];
    }
    const nums = [...line.matchAll(/(-?\d{2}[.,]\d{3,9})/g)].map(m => Number(m[1].replace(",", ".")));
    if (nums.length >= 2) {
      const [a, b] = nums;
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180 && Math.abs(b) > Math.abs(a)) return [b, a];
      if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return [a, b];
    }
    return null;
  }

  function parseSmartTableText(rawText) {
    const lines = String(rawText || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { rows: [], hasHeader: false, colRoles: [] };
    const hasTabs = lines.some(l => l.includes("\t"));
    const hasSemi = !hasTabs && lines.some(l => l.includes(";"));
    const splitLine = (l) => {
      if (hasTabs) return l.split("\t").map(s => s.trim());
      if (hasSemi) return l.split(";").map(s => s.trim());
      return l.split(/\s{2,}|,/).map(s => s.trim()).filter(Boolean);
    };
    const matrix = lines.map(splitLine);
    const maxCols = Math.max(1, ...matrix.map(r => r.length));
    const normRows = matrix.map(r => {
      const copy = [...r];
      while (copy.length < maxCols) copy.push("");
      return copy;
    });

    const first = normRows[0];
    const headerRegex = /^(n[°ºo]?|num|numero|c[oó]d|codigo|poste|lat|lon|long|estado|obs|zona|terreno|ct)/i;
    const hasHeader = normRows.length >= 2 && first.some(c => headerRegex.test(c)) && !first.some(c => /^-?\d{2}[.,]\d{3,9}$/.test(c));
    const dataRows = hasHeader ? normRows.slice(1) : normRows;

    const parseCoordNum = (v) => {
      const s = String(v || "").trim().replace(",", ".");
      if (!/^-?\d{1,3}\.\d{3,9}$/.test(s)) return null;
      return Number(s);
    };

    const colRoles = [];
    for (let c = 0; c < maxCols; c++) {
      const h = (hasHeader ? first[c] : "").toLowerCase();
      const sample = dataRows.slice(0, 12).map(r => r[c]).filter(Boolean);
      if (/^n[°ºo]?$|num/i.test(h)) { colRoles.push("numero"); continue; }
      if (/lat/i.test(h)) { colRoles.push("lat"); continue; }
      if (/lon/i.test(h)) { colRoles.push("lon"); continue; }
      if (/s\/?e\b|ssee|subestaci|\bsed\b|trafo/i.test(h)) { colRoles.push("sseeCode"); continue; }
      if (/terreno|\bct\b/i.test(h)) { colRoles.push("codigoTerreno"); continue; }
      if (/estado/i.test(h)) { colRoles.push("estado"); continue; }
      if (/obs|nota/i.test(h)) { colRoles.push("obs"); continue; }
      if (/cod|poste|equipo/i.test(h)) { colRoles.push("codigo"); continue; }

      // Heurística por contenido
      const coordNums = sample.map(parseCoordNum).filter(n => n !== null);
      if (coordNums.length >= Math.max(1, Math.ceil(sample.length * 0.6))) {
        const avgAbs = coordNums.reduce((a, b) => a + Math.abs(b), 0) / coordNums.length;
        colRoles.push(avgAbs > 60 ? "lon" : "lat");
        continue;
      }
      if (maxCols >= 2 && sample.length && sample.every(v => /^\d{1,4}$/.test(v))) {
        colRoles.push("numero");
        continue;
      }
      if (!colRoles.includes("codigo")) {
        colRoles.push("codigo");
      } else {
        colRoles.push("obs");
      }
    }
    return { rows: normRows, hasHeader, colRoles };
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
      : `⏳ GNAT · ${q.done}/${q.total}`;
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
      // 1. Búsqueda DIRECTA por código (si es APERTURA prioriza el equipo cortando la línea)
      const hitPole = (code && code !== "SIN CÓDIGO") ? await resolveCodeInGnat(code, true, isApPoint) : null;
      if (f.get("syncStatus") === "cancelled") return false;
      const hitSsee = (sseeRaw && sseeRaw !== code) ? await resolveCodeInGnat(sseeRaw, true, false) : null;
      if (f.get("syncStatus") === "cancelled") return false;

      const primaryHit = hitPole || hitSsee;

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

      // Validar consistencia Poste <-> S/E cuando ambos vienen declarados
      if (hitPole?.lonlat && hitSsee?.lonlat) {
        const dBoth = haversineMeters(hitPole.lonlat, hitSsee.lonlat);
        if (dBoth > 40) {
          notes.push(`Poste ${code} y S/E ${sseeRaw} están a ${Math.round(dBoth)} m en GNAT — verificar.`);
        }
      }

      // Validar contra coordenada Excel: <= 150 m -> auto-snap exacto a GNAT; > 150 m -> inconsistencia sin mover el pin
      let distMeters = 0;
      if (existingLL) {
        distMeters = haversineMeters(existingLL, primaryHit.lonlat);
        if (distMeters <= 150) {
          f.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(primaryHit.lonlat, proj)));
          snappedToGnat = true;
        } else {
          notes.push(`GNAT ubica ${primaryHit.code} a ${Math.round(distMeters)} m de tu coord. Excel — verificar.`);
        }
      } else {
        f.setGeometry(new ol.geom.Point(ol.proj.fromLonLat(primaryHit.lonlat, proj)));
        snappedToGnat = true;
      }

      // 2. Rescatar metadata técnica (S/E, COCI_3F kA, protecciones reales) en la coordenada exacta del poste en GNAT
      const probeLL = (snappedToGnat || !existingLL) ? primaryHit.lonlat : existingLL;
      const nb = await inspectPoleNeighborhoodInGnat(primaryHit.code, probeLL, [], true);
      if (f.get("syncStatus") === "cancelled") return snappedToGnat;

      const foundSsee = (nb.sseeList[0] || sseeRaw || "").toUpperCase();
      const foundDev = nb.devices[0] || primaryHit.devices?.[0] || null;
      if (foundSsee && !f.get("sseeCode")) f.set("sseeCode", `SSEE ${foundSsee}`);

      // Reconciliación automática S/E <-> Poste: si el usuario cargó el código de la S/E como código principal,
      // moverlo a Cód. S/E y promover el código real del poste (ej. F59430 -> Poste F628190 + SSEE F59430 + DF XS)
      const realPole = (nb.detectedPoleCode || "").toUpperCase();
      if (foundSsee && code === foundSsee && realPole && realPole !== code) {
        f.set("sseeCode", `SSEE ${foundSsee}`);
        f.set("codigo", realPole);
        if (!f.get("proteccionTipo")) f.set("proteccionTipo", "DF_XS");
      }

      const detectedProt = foundSsee
        ? "DF_XS"
        : (foundDev ? mapProtectionFromText(`${foundDev.type || ""} ${foundDev.display || ""}`) : "");

      const userProt = String(f.get("proteccionTipo") || "");
      if (!userProt && detectedProt) {
        f.set("proteccionTipo", detectedProt);
        if (["RC", "DBC", "DC", "DDFF", "SECC", "INT_MT"].includes(detectedProt) && !foundSsee) {
          f.set("tipo", "APERTURA");
        }
      } else if (userProt && !detectedProt && userProt !== "DF_XS" && !userProt.endsWith("_BT")) {
        notes.push(`Declaraste ${PROTECTION_TYPES.find(p => p.id === userProt)?.short || userProt}, pero GNAT no reporta equipo de apertura aquí — verificar.`);
      }

      f.set("gnatMeta", {
        poleCode: nb.detectedPoleCode || primaryHit.code,
        display: primaryHit.display || primaryHit.code,
        sseeCode: foundSsee ? `SSEE ${foundSsee}` : "",
        coci3f: nb.coci3f,
        deviceDisplay: foundDev ? `${foundDev.type || foundDev.display}${foundDev.realState ? " · " + foundDev.realState : ""}` : (foundSsee ? "Desconectador Fusible XS (S/E)" : ""),
        gnatLonLat: primaryHit.lonlat,
        distMeters: snappedToGnat ? 0 : distMeters,
        syncedAt: new Date().toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })
      });
      f.set("syncNote", notes.join(" "));
      f.set("syncStatus", notes.length ? "mismatch" : "ok");
      return snappedToGnat;
    } catch (_) {
      if (f.get("syncStatus") === "loading") f.set("syncStatus", prevStatus === "ok" ? "ok" : "not_found");
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
        let numero = null, codigo = "", sseeCode = "", codigoTerreno = "", lat = null, lon = null, obsText = "", stName = "";
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
          const matchSt = [...state.statuses.values()].find(s => s.name.toLowerCase() === stName.toLowerCase());
          if (matchSt) estadoEjec = matchSt.id;
        }
        const obsArr = obsText ? [{ text: obsText, at: new Date().toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" }) }] : [];

        const feat = upsertPointOnMap({
          codigo: codigo || sseeCode || codigoTerreno,
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
        if (targetSup !== "default") feat.set("supervisorId", targetSup);
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
  const originalGrids = new Map();
  (function scanLayers(col) {
    for (const layer of col?.getArray?.() || []) {
      const name = layer.get?.("title") || layer.get?.("name");
      if (MTBT_LAYERS.has(name)) {
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
        const max = Number.isFinite(this.getMaxZoom?.()) ? this.getMaxZoom() : z + 2;
        return Math.min(max, z + state.mtbtDetail);
      };
    }
    mtbtSources.forEach(s => s.changed?.());
    map.render?.();
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
      const hit = await resolveCodeInGnat(q, true);
      if (hit?.lonlat) {
        const feat = upsertPointOnMap({
          codigo: hit.code,
          lonlat: hit.lonlat,
          tipo: hit.isOpeningDevice ? "APERTURA" : "PUNTO",
          bloqueId: "T",
          bloques: ["T"]
        });
        searchInput.value = "";
        state.search = "";
        ensureVectorLayer();
        markDirty();
        refreshAll();
        navigateTo(state.points.indexOf(feat));
        showToast(`Agregado desde GNAT: ${hit.code}`);
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
  doc.addEventListener("mousedown", (ev) => {
    if (activePopover && !ev.composedPath().includes(activePopover)) closePopover();
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
