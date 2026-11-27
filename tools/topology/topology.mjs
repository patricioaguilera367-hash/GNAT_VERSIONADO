// Motor de conectividad MT. Puro: sin red, sin navegador, sin disco.
//
// CONTRATO DE ENTRADA (S2 del spec):
//   points   [{ code, lonlat: [lon, lat], numero, tipo: "PUNTO" }]
//   spans    [{ from, to, lengthM? }]
//   openings [{ code, at, state: "open" | "closed", kind? }]
//
// OJO: `lonlat` es [longitud, latitud], NO [lat, lon]. Es el orden que ya usa la
// extensión (`ol.proj.fromLonLat([pair[0], pair[1]])` en centrality_v10.js).

/**
 * Construye el grafo de adyacencia y marca los nodos que cortan el recorrido.
 * Una apertura sin `state` se asume `open` (S6): en el dominio, una "apertura" es un
 * corte, así que la ausencia de dato no puede significar "cerrada".
 */
export function buildGraph(network) {
  const points = new Map();
  for (const point of network.points ?? []) points.set(point.code, point);

  const adjacency = new Map();
  const addNode = (code) => {
    if (!adjacency.has(code)) adjacency.set(code, new Set());
  };
  for (const code of points.keys()) addNode(code);

  for (const span of network.spans ?? []) {
    if (!span || !span.from || !span.to || span.from === span.to) continue;
    addNode(span.from);
    addNode(span.to);
    adjacency.get(span.from).add(span.to);
    adjacency.get(span.to).add(span.from);
  }

  const blocked = new Set();
  for (const opening of network.openings ?? []) {
    if (!opening || !opening.at) continue;
    if (opening.state === 'closed') continue;
    blocked.add(opening.at);
  }

  return { points, adjacency, blocked, source: network.source };
}

function orderByNumero(codes, points) {
  return [...codes].sort((a, b) => {
    const na = Number(points.get(a)?.numero);
    const nb = Number(points.get(b)?.numero);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  });
}

/** Camina desde `start` expandiendo sólo nodos que no estén en `stop`. */
function walk(start, adjacency, stop) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    // Un nodo bloqueado es frontera: se alcanza, pero no se expande (S3).
    if (stop.has(node)) continue;
    for (const next of adjacency.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** Componentes conexas ignorando aperturas: la topología sola, testeable aparte (S4). */
export function components(graph) {
  const seen = new Set();
  const out = [];
  for (const start of graph.adjacency.keys()) {
    if (seen.has(start)) continue;
    const reached = walk(start, graph.adjacency, new Set());
    for (const code of reached) seen.add(code);
    out.push(orderByNumero(reached, graph.points));
  }
  return out;
}

/**
 * Nodos alcanzables desde la fuente sin atravesar aperturas abiertas (S3).
 * Los nodos frontera (donde está la apertura) cuentan como alcanzados: el corte se
 * abre en ese punto, así que el poste del equipo queda del lado energizado.
 */
export function energizedFrom(graph, network) {
  const source = (network ?? {}).source ?? graph.source;
  if (!source || !graph.adjacency.has(source)) return [];
  if (graph.blocked.has(source)) return [source];
  return orderByNumero(walk(source, graph.adjacency, graph.blocked), graph.points);
}

/**
 * Rutas desconectadas: los conjuntos de nodos que no se alcanzan desde la fuente,
 * agrupados por conectividad entre ellos (S3). Devuelve los códigos en orden de `numero`.
 */
export function disconnectedRoutes(network) {
  const graph = buildGraph(network);
  const energized = new Set(energizedFrom(graph, network));
  const orphans = new Set([...graph.adjacency.keys()].filter((code) => !energized.has(code)));

  const seen = new Set();
  const routes = [];
  for (const start of [...orphans].sort()) {
    if (seen.has(start)) continue;
    const reached = walk(start, graph.adjacency, new Set());
    const group = [...reached].filter((code) => orphans.has(code));
    for (const code of group) seen.add(code);
    routes.push({ codes: orderByNumero(group, graph.points) });
  }
  return routes;
}
