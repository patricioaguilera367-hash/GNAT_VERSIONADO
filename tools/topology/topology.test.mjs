import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph, components, energizedFrom, disconnectedRoutes } from './topology.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/red-sintetica.json', import.meta.url), 'utf8'));

/** La misma red, con la apertura en P2 en el estado pedido (o sin `state`). */
const conApertura = (state) => ({
  ...fixture,
  openings: [state === undefined ? { code: 'A1', at: 'P2' } : { code: 'A1', at: 'P2', state }],
});

test('components ignora aperturas y devuelve la topologia sola', () => {
  const graph = buildGraph(fixture);
  assert.deepEqual(components(graph), [['SUB1', 'P1', 'P2', 'P3', 'P4'], ['P5']]);
});

test('una apertura abierta corta el recorrido en su poste', () => {
  const network = conApertura('open');
  const graph = buildGraph(network);
  assert.deepEqual(energizedFrom(graph, network), ['SUB1', 'P1', 'P2']);
});

test('lo que queda del otro lado del corte forma la ruta desconectada', () => {
  const routes = disconnectedRoutes(conApertura('open'));
  assert.deepEqual(routes.map((route) => route.codes), [['P3', 'P4'], ['P5']]);
});

test('con la apertura cerrada la red queda entera hasta el final del tramo', () => {
  const network = conApertura('closed');
  const graph = buildGraph(network);
  assert.deepEqual(energizedFrom(graph, network), ['SUB1', 'P1', 'P2', 'P3', 'P4']);
  assert.deepEqual(disconnectedRoutes(network).map((route) => route.codes), [['P5']]);
});

test('P4 solo es alcanzable atravesando la apertura cerrada', () => {
  const abierta = energizedFrom(buildGraph(conApertura('open')), conApertura('open'));
  const cerrada = energizedFrom(buildGraph(conApertura('closed')), conApertura('closed'));
  assert.equal(abierta.includes('P4'), false);
  assert.equal(cerrada.includes('P4'), true);
});

test('una apertura sin state se asume abierta (S6)', () => {
  const network = conApertura(undefined);
  const graph = buildGraph(network);
  assert.deepEqual([...graph.blocked], ['P2']);
  assert.deepEqual(energizedFrom(graph, network), ['SUB1', 'P1', 'P2']);
});

test('un poste aislado sin tramos es su propia ruta desconectada', () => {
  const routes = disconnectedRoutes(conApertura('closed'));
  assert.deepEqual(routes, [{ codes: ['P5'] }]);
});

test('sin fuente declarada no hay nada energizado y todo queda desconectado', () => {
  const sinFuente = { ...conApertura('closed'), source: undefined };
  const graph = buildGraph(sinFuente);
  assert.deepEqual(energizedFrom(graph, sinFuente), []);
  assert.equal(disconnectedRoutes(sinFuente).length, 2);
});

test('una fuente que no existe en la red no rompe el motor', () => {
  const red = { ...conApertura('closed'), source: 'NO-EXISTE' };
  assert.deepEqual(energizedFrom(buildGraph(red), red), []);
});
