/**
 * Tests for the prefix-tree enumeration.
 *
 * The fake search behaves like the real endpoint: prefix match, hard cap at
 * SEARCH_LIMIT, no paging. The assertion that matters is completeness — every
 * code in the fake universe must be found exactly once — because that is what
 * the endpoint's cap would silently break.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SEARCH_LIMIT, absorb, newState, next, summarize } from './enumerate-core.mjs';

const universeOf = (prefix, count) =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(4, '0')}`);

const fakeSearch = (universe) => (prefix) =>
  universe.filter((code) => code.startsWith(prefix)).slice(0, SEARCH_LIMIT);

const run = (seed, universe, options = {}) => {
  const state = newState({ seed, maxLength: 8, ...options });
  const lookup = fakeSearch(universe);
  let prefix = next(state);
  while (prefix !== null) {
    absorb(state, prefix, lookup(prefix));
    prefix = next(state);
  }
  return state;
};

test('finds every code when the widest prefix is saturated', () => {
  const universe = universeOf('F7448', 120);
  const state = run('F7448', universe);

  assert.equal(state.found.size, universe.length);
  assert.equal(state.truncated.length, 0);
  assert.deepEqual([...state.found].sort(), [...universe].sort());
});

test('stops immediately when the seed prefix is already short', () => {
  const universe = universeOf('F7448', 3);
  const state = run('F7448', universe);

  assert.equal(state.queries, 1);
  assert.equal(state.found.size, 3);
  assert.equal(state.stopped, 'queue-empty');
  assert.equal(summarize(state).complete, true);
});

test('a prefix with exactly the cap is drilled, not trusted', () => {
  const universe = universeOf('F627', SEARCH_LIMIT + 5);
  const state = run('F627', universe);

  assert.equal(state.found.size, universe.length);
  assert.equal(state.saturated.get('F627'), true);
});

test('a saturated prefix at maxLength is reported as truncated, never as complete', () => {
  const universe = universeOf('F7448', 200);
  const state = run('F7448', universe, { maxLength: 5 });
  const summary = summarize(state);

  assert.equal(summary.complete, false);
  assert.equal(summary.truncatedPrefixes, 1);
  assert.ok(state.found.size < universe.length);
});

test('respects the query budget instead of looping forever', () => {
  const universe = universeOf('F7448', 400);
  const state = run('F7448', universe, { maxQueries: 3 });

  assert.equal(state.queries, 3);
  assert.equal(state.stopped, 'max-queries');
  assert.equal(summarize(state).complete, false);
});

test('never asks the same prefix twice', () => {
  const universe = universeOf('F7448', 120);
  const state = run('F7448', universe);

  assert.equal(state.asked.size, state.queries);
});
