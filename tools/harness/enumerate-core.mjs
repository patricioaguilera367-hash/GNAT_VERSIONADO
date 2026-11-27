/**
 * Prefix-tree enumeration over GNAT's `textual_search`.
 *
 * Why a prefix tree: the endpoint returns at most SEARCH_LIMIT rows per query
 * and ignores paging (`start` returns the same page). A prefix that comes back
 * saturated may have more rows behind it, so it gets drilled one character
 * deeper; a prefix that comes back short is complete and its subtree is pruned.
 * The tree closes itself: it never needs to know how many codes exist.
 *
 * Pure logic only: no network, no DOM. The caller supplies what each prefix
 * returned.
 */

/** Rows per query. The endpoint caps here and paging does not exist. */
export const SEARCH_LIMIT = 40;

export const DIGITS = '0123456789';

export function newState({ seed, maxLength = 9, maxQueries = 5000, alphabet = DIGITS } = {}) {
  if (!seed) throw new Error('seed prefix is required');
  return {
    seed,
    alphabet,
    maxLength,
    maxQueries,
    queue: [seed],
    asked: new Set(),
    found: new Set(),
    saturated: new Map(),
    truncated: [],
    queries: 0,
    stopped: null,
  };
}

/** Next prefix to query, or null when the tree is closed. */
export function next(state) {
  if (state.queries >= state.maxQueries) {
    state.stopped = 'max-queries';
    return null;
  }
  while (state.queue.length > 0) {
    const prefix = state.queue.shift();
    if (state.asked.has(prefix)) continue;
    state.asked.add(prefix);
    state.queries += 1;
    return prefix;
  }
  state.stopped = 'queue-empty';
  return null;
}

/**
 * Record what one prefix returned.
 *
 * Saturated means "the endpoint may be hiding rows behind the cap". At
 * maxLength a saturated prefix cannot be drilled further, so it is reported as
 * truncated instead of being silently trusted as complete.
 */
export function absorb(state, prefix, codes) {
  for (const code of codes) state.found.add(code);
  const saturated = codes.length >= SEARCH_LIMIT;
  state.saturated.set(prefix, saturated);

  if (!saturated) return { saturated, drilled: false, truncated: false };
  if (prefix.length >= state.maxLength) {
    state.truncated.push(prefix);
    return { saturated, drilled: false, truncated: true };
  }
  for (const digit of state.alphabet) state.queue.push(prefix + digit);
  return { saturated, drilled: true, truncated: false };
}

export function summarize(state) {
  return {
    seed: state.seed,
    queries: state.queries,
    codes: state.found.size,
    saturatedPrefixes: [...state.saturated.values()].filter(Boolean).length,
    truncatedPrefixes: state.truncated.length,
    stopped: state.stopped,
    complete: state.stopped === 'queue-empty' && state.truncated.length === 0,
  };
}
