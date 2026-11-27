/**
 * Tolerant parser for GNAT structure sheets (section 23).
 *
 * Why tolerant: the endpoint answers full HTML with tags interleaved inside the
 * labels themselves, and accents arrive entity-encoded. Normalising once and
 * then matching plain strings keeps the rules readable and testable.
 *
 * Why bornes: the neighbour rows read `Borne #1 de F258214`. The old engine
 * looked for `A - B` cable pairs and found nothing, because the only dash in
 * the sheet belongs to the feeder name (`Los Sauces - Lumaco [S9]`), which must
 * never be read as a pole pair.
 *
 * A bare pole answers a ~397-byte sheet with none of these labels. That case is
 * not an error: it is a pole without a structure sheet, and it is reported as
 * such instead of being guessed.
 */

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', deg: '°', ordm: 'º', ordf: 'ª',
};

/** Strip tags, decode entities, collapse whitespace. */
export function normalize(html) {
  const stripped = String(html ?? '').replace(/<[^>]*>/g, ' ');
  const decoded = stripped.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    }
    const hit = ENTITIES[body] ?? ENTITIES[body.toLowerCase()];
    return hit === undefined ? ' ' : hit;
  });
  return decoded.replace(/\s+/g, ' ').trim();
}

const BORNE = /Borne\s*#\s*(\d+)\s*de\s+([A-Za-z]{0,3}\d{4,})/g;

/** Neighbour bornes. Deduplicated, order preserved, never invented. */
export function parseNeighbours(html) {
  const text = normalize(html);
  const neighbours = [];
  const seen = new Set();
  BORNE.lastIndex = 0;
  let match = BORNE.exec(text);
  while (match) {
    const borne = Number(match[1]);
    const code = match[2].toUpperCase();
    const key = `${borne}:${code}`;
    if (!seen.has(key)) {
      seen.add(key);
      neighbours.push({ borne, code });
    }
    match = BORNE.exec(text);
  }
  return { neighbours };
}

/**
 * Operating state. Anything unreadable stays `unknown`: an unread switch must
 * never be reported as closed, because that would claim a line is live.
 */
export function parseOperatingState(html) {
  const text = normalize(html);
  const start = text.search(/Estado operativo/i);
  if (start < 0) return { state: 'unknown', raw: null, basis: 'none' };
  const segment = text.slice(start, start + 160);

  const label = /normalmente\s+(abierto|cerrado)\s*(?:\(\s*(NA|NC)\s*\))?/i.exec(segment);
  if (label) {
    const state = label[1].toLowerCase() === 'abierto' ? 'open' : 'closed';
    return { state, raw: label[0].replace(/\s+/g, ' ').trim(), basis: 'label' };
  }
  const abbr = /\(\s*(NA|NC)\s*\)/.exec(segment);
  if (abbr) {
    return {
      state: abbr[1].toUpperCase() === 'NA' ? 'open' : 'closed',
      raw: abbr[0],
      basis: 'label',
    };
  }
  return { state: 'unknown', raw: null, basis: 'none' };
}

const phaseState = (word) => {
  const value = String(word ?? '').toLowerCase();
  if (value.startsWith('cerr')) return 'closed';
  if (value.startsWith('abier')) return 'open';
  return 'unknown';
};

/** Per-phase state, `Real` (actual) and `Normal` (nominal) snapshots. */
export function parsePhases(html) {
  const text = normalize(html);
  const start = text.search(/Comportamiento de red/i);
  if (start < 0) return { real: null, normal: null };
  const segment = text.slice(start, start + 400);

  const block = (name) => {
    const index = segment.search(new RegExp(name, 'i'));
    if (index < 0) return null;
    const slice = segment.slice(index, index + 200);
    const match = /R:\s*([a-záéíóú]+)\s+S:\s*([a-záéíóú]+)\s+T:\s*([a-záéíóú]+)/i.exec(slice);
    if (!match) return null;
    return { R: phaseState(match[1]), S: phaseState(match[2]), T: phaseState(match[3]) };
  };

  return { real: block('Real'), normal: block('Normal') };
}

/** Circuit voltage. `13,2 kV` (comma decimal) and `13.2 kV` both read as 13.2. */
export function parseVoltage(html) {
  const text = normalize(html);
  const match = /Tensi[oó]n del circuito:\s*([\d.,]+)\s*kV/i.exec(text);
  if (!match) return null;
  const raw = match[1];
  const value = raw.includes(',')
    ? Number(raw.replace(/\./g, '').replace(',', '.'))
    : Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Feeder name. Keeps its dash: it is a name, not a pole pair. */
export function parseFeeder(html) {
  const text = normalize(html);
  const start = text.search(/Jerarqu[ií]a de red/i);
  if (start < 0) return null;
  const slice = text.slice(start, start + 200);
  const label = /\[([A-Za-z0-9]{1,12})\]/.exec(slice);
  if (!label) return null;
  const name = slice
    .slice(0, label.index)
    .replace(/^.*?Jerarqu[ií]a de red\s*/i, '')
    .replace(/^\s*(Real|Normal)\s+/i, '')
    .trim();
  if (!name) return null;
  return `${name} [${label[1]}]`;
}

export function parseSheet(html) {
  const text = normalize(html);
  const neighbours = parseNeighbours(html).neighbours;
  const voltageKv = parseVoltage(html);
  const feeder = parseFeeder(html);
  return {
    // Derived from what the sheet actually carries, not from one literal label:
    // tags can split a label in the middle, and a bare pole carries none of it.
    hasStructure:
      neighbours.length > 0 || voltageKv !== null || feeder !== null || /Vec\s*inos/i.test(text),
    neighbours,
    state: parseOperatingState(html),
    voltageKv,
    feeder,
    phases: parsePhases(html),
  };
}
