/**
 * Tests for the structure-sheet parser.
 *
 * The fixture deliberately splits labels across tags and entity-encodes the
 * accents, because the real sheet does exactly that. A parser tested against
 * clean text would prove nothing about the HTML it actually receives.
 *
 * All codes and names here are synthetic.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalize,
  parseFeeder,
  parseNeighbours,
  parseOperatingState,
  parsePhases,
  parseSheet,
  parseVoltage,
} from './neighbours.mjs';

const sheet = ({ bornes = ['F258214', 'F258215'], state = 'normalmente cerrado (NC)', voltage = 'Tensi&oacute;n del circuito: 13,2 kV', feeder = 'Real Los Sauces - Lumaco [S9]', phases = true } = {}) => `
<div class="x-panel"><span>13,2 kV</span><a href="#">Resaltar todos</a></div>
<div class="sect"><b>Vec</b>inos</div>
<table class="grid"><thead><tr><th>Id</th><th>Tipo</th><th>Id de negocio</th><th>Navegaci&oacute;n</th></tr></thead>
<tbody>
${bornes.map((code, index) => `<tr><td>Borne <b>#${index + 1}</b> de <span>${code}</span></td><td>Borne</td><td></td><td>- ir / zoom / resaltar (+)</td></tr>`).join('\n')}
</tbody></table>
<div class="sect">Estado <b>operativo</b>: ${state}</div>
${phases ? `<div class="sect">Comportamiento de red por fase</div>
<div><span>Real</span> (desde 09/08/2024 14:10:00 -04) R: cerrado S: cerrado T: abierto</div>
<div><span>Normal</span> (desde 14/04/2024 14:00:00 -04) R: cerrado S: cerrado T: cerrado</div>` : ''}
<div class="sect">Jerarqu&iacute;a de red</div>
<div>${feeder}</div>
<div>${voltage}</div>
`;

test('normalizes tags and entity-encoded accents', () => {
  const text = normalize('<b>Jerarqu&iacute;a</b> de&nbsp;red');
  assert.equal(text, 'Jerarquía de red');
});

test('reads both bornes of a device', () => {
  const { neighbours } = parseNeighbours(sheet());
  assert.deepEqual(neighbours, [
    { borne: 1, code: 'F258214' },
    { borne: 2, code: 'F258215' },
  ]);
});

test('reads a single borne without inventing a second', () => {
  const { neighbours } = parseNeighbours(sheet({ bornes: ['F258222'] }));
  assert.equal(neighbours.length, 1);
  assert.equal(neighbours[0].code, 'F258222');
});

test('a bare pole sheet has no structure and no neighbours', () => {
  const bare = '<div class="empty">397 bytes of nothing</div>';
  const parsed = parseSheet(bare);
  assert.equal(parsed.hasStructure, false);
  assert.deepEqual(parsed.neighbours, []);
  assert.equal(parsed.state.state, 'unknown');
});

test('an open device reads as open', () => {
  const result = parseOperatingState(sheet({ state: 'normalmente abierto (NA)' }));
  assert.equal(result.state, 'open');
  assert.equal(result.basis, 'label');
  assert.match(result.raw, /normalmente abierto/);
});

test('a closed device reads as closed', () => {
  assert.equal(parseOperatingState(sheet()).state, 'closed');
});

test('a missing state stays unknown, never closed', () => {
  const result = parseOperatingState('<div>sin estado</div>');
  assert.equal(result.state, 'unknown');
  assert.equal(result.basis, 'none');
  assert.equal(result.raw, null);
});

test('voltage reads comma and dot decimals alike', () => {
  assert.equal(parseVoltage('Tensi&oacute;n del circuito: 13,2 kV'), 13.2);
  assert.equal(parseVoltage('Tension del circuito: 13.2 kV'), 13.2);
  assert.equal(parseVoltage('Tension del circuito: 23 kV'), 23);
});

test('the feeder keeps its dash and is not read as a pole pair', () => {
  const html = sheet();
  assert.equal(parseFeeder(html), 'Los Sauces - Lumaco [S9]');
  const codes = parseNeighbours(html).neighbours.map((neighbour) => neighbour.code);
  assert.equal(codes.includes('SAUCES'), false);
});

test('per-phase state is read for both snapshots', () => {
  const { real, normal } = parsePhases(sheet());
  assert.deepEqual(real, { R: 'closed', S: 'closed', T: 'open' });
  assert.deepEqual(normal, { R: 'closed', S: 'closed', T: 'closed' });
});

test('a sheet with no phases reports null rather than a guess', () => {
  const { real, normal } = parsePhases(sheet({ phases: false }));
  assert.equal(real, null);
  assert.equal(normal, null);
});

test('the full sheet composes the parts', () => {
  const parsed = parseSheet(sheet());
  assert.equal(parsed.hasStructure, true);
  assert.equal(parsed.neighbours.length, 2);
  assert.equal(parsed.state.state, 'closed');
  assert.equal(parsed.voltageKv, 13.2);
  assert.equal(parsed.feeder, 'Los Sauces - Lumaco [S9]');
  assert.equal(parsed.phases.real.T, 'open');
});
