(() => {
  "use strict";

  const HIGH_CONTRAST_PALETTE = [
    "#00C853", // T - Zona de trabajo
    "#FF6D00", // F - Punto de faenas / CC
    "#DC2626", // D - Zona desconectada
    "#2979FF", // TL
    "#00BFA5", // JB
    "#D500F9",
    "#FFD600",
    "#00E5FF",
    "#15803D", // RD
    "#4F46E5",
    "#F97316",
    "#06B6D4"
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

  function haversineMeters(a, b) {
    const R = 6371000;
    const dLat = (b[1] - a[1]) * Math.PI / 180;
    const dLon = (b[0] - a[0]) * Math.PI / 180;
    const la1 = a[1] * Math.PI / 180, la2 = b[1] * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function extractLatLonFromLine(line) {
    const gmap = /@(-?\d+\.\d+),(-?\d+\.\d+)|[?&](?:q|ll)=(-?\d+\.\d+),(-?\d+\.\d+)|!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(line);
    if (gmap) {
      const lat = Number(gmap[1] || gmap[3] || gmap[5]);
      const lon = Number(gmap[2] || gmap[4] || gmap[6]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lon, lat];
    }
    const nums = [...String(line || "").matchAll(/(-?\d{2}[.,]\d{3,9})/g)].map(m => Number(m[1].replace(",", ".")));
    if (nums.length >= 2) {
      const [a, b] = nums;
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180 && Math.abs(b) > Math.abs(a)) return [b, a];
      if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return [a, b];
    }
    return null;
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
    const headerRegex = /^(n[°ºo]?|num|numero|c[oó]d|codigo|poste|lat|lon|long|estado|obs|zona|terreno|ct|s\/?e|ssee)/i;
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
      if (!colRoles.includes("codigo")) colRoles.push("codigo");
      else colRoles.push("obs");
    }
    return { rows: normRows, hasHeader, colRoles };
  }

  window.__C_CATALOGS = {
    HIGH_CONTRAST_PALETTE,
    DEFAULT_SUPERVISORS,
    LEGACY_COLOR_TO_SUP,
    PROTECTION_TYPES,
    EPT_TYPES,
    EQUIPMENT_TYPES,
    mapProtectionFromText,
    haversineMeters,
    extractLatLonFromLine,
    extractPointFromGeoJsonFeature,
    parseSmartTableText
  };
})();
