const assert = require('node:assert/strict');
const { test } = require('node:test');
const app = require('./tests/app.cjs');

function measurement(options = {}) {
  const clock = options.clock ?? { now: Date.UTC(2026, 9, 19, 15) };
  const instance = app({ ...options, clock });
  // La lógica y la persistencia son reales; la presentación se comprueba con Chromium.
  instance.context.renderResult = () => {};
  instance.context.renderRun = () => {};
  instance.context.stage = () => {};
  return { ...instance, clock };
}
function prepare(instance) {
  instance.run(`RUN = {
    ...fresh(false), phase: 2,
    data: { measurementDate: '2026-10-19', measurementTime: '09:00' },
    plan: ['A', 'B', 'C', 'D'].map(id => ({ id, name: 'Actividad ' + id })),
    start: Date.now() - 120000, activityStart: Date.now() - 60000,
    activityAccum: 0.5, idx: 1,
    entries: [{ id: 'previous', activityId: 'A', name: 'Actividad A', type: 'Actividad', status: 'Registrada', minutes: 0.5, audit: [] }]
  }`);
}
const copy = value => JSON.parse(JSON.stringify(value));

test('terminar ahora guarda el tiempo actual y omite únicamente las actividades pendientes', async () => {
  const state = measurement(); prepare(state);
  let record;
  state.context.saveRecord = async value => { record = copy(value); };
  await state.context.finishEarly();
  assert.equal(record.end, state.clock.now);
  assert.equal(record.measuredTotal, 2);
  assert.deepEqual(record.entries.map(e => [e.activityId, e.minutes, e.status]), [
    ['A', 0.5, 'Registrada'], ['B', 1.5, 'Registrada'], ['C', 0, 'Omitida'], ['D', 0, 'Omitida'],
  ]);
  assert.equal(record.entries[0].id, 'previous');
  assert.equal(record.plan.length, 4);
  assert.equal(state.run('RUN.phase'), 1);
  assert.equal(state.run('RUN.entries.length'), 0);
});

test('terminar durante una incidencia conserva ambos tiempos sin contarlos dos veces', async () => {
  const state = measurement(); prepare(state);
  state.run(`RUN.start = Date.now() - 105000; RUN.activityAccum = 0.25;
    RUN.incident = { name: 'Espera', note: 'Falta de material', start: Date.now() - 30000 }`);
  let record;
  state.context.saveRecord = async value => { record = copy(value); };
  await state.context.finishEarly();
  const incident = record.entries.find(e => e.type === 'Incidencia');
  assert.equal(incident.minutes, 0.5);
  assert.equal(incident.note, 'Falta de material');
  assert.equal(record.entries.find(e => e.activityId === 'B').minutes, 0.75);
  assert.equal(record.entries.reduce((sum, entry) => sum + entry.minutes, 0), 1.75);
  assert.equal(record.measuredTotal, 1.75);
});

test('en la última actividad conserva las repeticiones y no crea omisiones', async () => {
  const state = measurement(); prepare(state);
  state.run(`RUN.idx = 3; RUN.activityAccum = 0; RUN.activityStart = Date.now() - 30000; RUN.repeat = true;
    RUN.entries = RUN.plan.map((a, i) => ({ id: 'original-' + i, activityId: a.id, name: a.name,
      type: 'Actividad', status: 'Registrada', minutes: i === 3 ? 0.75 : 0.25, audit: [] }))`);
  let record;
  state.context.saveRecord = async value => { record = copy(value); };
  await state.context.finishEarly();
  assert.equal(record.entries.length, 5);
  assert.equal(record.entries.at(-1).type, 'Repetición');
  assert.equal(record.entries.at(-1).minutes, 0.5);
  assert(record.entries.every(e => e.status === 'Registrada'));
  assert.equal(record.entries.reduce((sum, e) => sum + e.minutes, 0), record.measuredTotal);
});

test('un fallo conserva la hora de fin, permite reintentar tras recargar y evita entradas duplicadas', async () => {
  const state = measurement(); prepare(state);
  let original;
  state.context.saveRecord = async value => { original = copy(value); throw new Error('Sin conexión'); };
  await state.context.finishEarly();
  assert.equal(state.run('RUN.phase'), 2);
  assert.equal(state.run('RUN.pendingRecord.end'), state.clock.now);
  state.clock.now += 600000;
  state.context.tick();
  assert.equal(state.element('#totClock').textContent, '02:00');
  assert.equal(state.element('#stepClock').textContent, '01:30');
  state.context.advance();
  assert.equal(state.run('RUN.entries.length'), 4);
  assert.equal(state.element('#skip').disabled, true);
  const restored = measurement({ storage: state.storage, clock: state.clock });
  let retried;
  restored.context.saveRecord = async value => { retried = copy(value); };
  await restored.context.finishEarly();
  assert.deepEqual(retried, original);
  assert.equal(restored.run('RUN.phase'), 1);
});

test('doble clic y atajos durante el guardado no duplican la medición', async () => {
  const state = measurement(); prepare(state);
  let release, calls = 0;
  state.context.saveRecord = async () => { calls++; await new Promise(resolve => { release = resolve; }); };
  const saving = state.context.finishEarly();
  await state.context.finishEarly();
  state.context.advance();
  assert.equal(calls, 1);
  assert.equal(state.run('RUN.entries.length'), 4);
  for (const id of ['next', 'finishNow', 'cancel', 'repeat', 'skip']) assert.equal(state.element('#' + id).disabled, true);
  release(); await saving;
  assert.equal(state.run('RUN.phase'), 1);
});

test('la finalización habitual con el botón siguiente sigue guardando una sola actividad', async () => {
  const state = measurement(); prepare(state);
  state.run(`RUN.plan = RUN.plan.slice(0, 1); RUN.idx = 0; RUN.entries = [];
    RUN.start = Date.now() - 60000; RUN.activityStart = RUN.start; RUN.activityAccum = 0`);
  let record;
  state.context.saveRecord = async value => { record = copy(value); };
  await state.context.advance();
  assert.equal(record.entries.length, 1);
  assert.equal(record.entries[0].minutes, 1);
  assert.equal(record.entries[0].status, 'Registrada');
  assert.equal(state.run('RUN.phase'), 1);
});

const FULL_KIT = `Object.fromEntries(KIT.flatMap(g => g.items.map(([id]) => [id, true])))`;
function ready(state, user) {
  state.context.renderRun = () => {};
  for (const id of ['measurementDate', 'measurementTime']) state.element('#' + id).reportValidity = () => true;
  if (user) state.run(`backendState = { configured: true, user: ${JSON.stringify(user)} }`);
}

test('el kit tiene la revisión de la orden (4) y el kit del siguiente pedido (6)', () => {
  const state = measurement();
  assert.deepEqual(state.run('KIT.map(g => [g.key, g.step, g.items.length])'), [
    ['orden', 'Paso 1 · Revisión de la orden (checklist)', 4], ['kit', 'Paso 2 · Kit del siguiente pedido', 6]]);
  assert.equal(state.run('kitSummary().total'), 10);
});

test('«ver pasos» funciona sin el kit completo y la parada se inicia registrando lo que faltaba', async () => {
  const state = measurement(); ready(state);
  state.context.ask = () => { throw new Error('no debe preguntar'); };
  state.run(`RUN.kit = { 'orden-codigo': true }; renderKitCount()`);
  assert.equal(state.element('#kitCount').textContent, '1 de 10 listos');
  assert.equal(state.element('#nextSteps').hidden, true);
  state.element('#kitDone').onclick();
  assert.equal(state.element('#nextSteps').hidden, false);
  state.run(`RUN.kit['orden-codigo'] = false; renderKitCount()`);
  assert.equal(state.element('#nextSteps').hidden, false);
  state.element('#start').onclick();
  assert.equal(state.run('RUN.phase'), 2);
  let record;
  state.context.saveRecord = async value => { record = copy(value); };
  await state.context.finishEarly();
  assert.deepEqual([record.kit.listos, record.kit.total, record.kit.faltantes.length], [0, 10, 10]);
  assert(record.kit.grupos[1].faltantes.includes('Herramientas de ajuste (llaves y calibrador)'));
});

test('el pedido conocido completa sus datos y el cronómetro externo va del pedido al checklist completo', () => {
  const state = measurement(); ready(state);
  state.element('#orderInput').value = '249';
  state.element('#orderInput').oninput();
  assert.match(state.element('#orderInfo').innerHTML, /Pizzería Napoli/);
  state.element('#orderInput').value = ' p0249 ';
  state.element('#orderInput').onchange();
  assert.equal(state.run('RUN.order'), 'P-0249');
  assert.equal(state.element('#orderInput').value, 'P-0249');
  for (const text of ['Pizzería Napoli', 'BASE DE TORTA #30 - LOGO PIZZERÍA NAPOLI IMPRESO', '1,150 und', '30 × 30 cm', 'TQ-30', 'Código de troquel'])
    assert(state.element('#orderInfo').innerHTML.includes(text), text);
  assert.equal(state.run('RUN.extStart'), state.clock.now);
  state.clock.now += 3 * 60000;
  state.run(`RUN.kit = ${FULL_KIT}; updateExternalClock(); renderKitCount()`);
  assert.equal(state.run('RUN.extEnd'), state.clock.now);
  assert.equal(state.element('#extClock').textContent, '03:00');
  state.clock.now += 60000;
  assert.equal(state.element('#extClock').textContent, '03:00');
  state.element('#orderInput').value = '12345';
  state.element('#orderInput').onchange();
  assert.equal(state.run('RUN.order'), '12345');
  assert.match(state.element('#orderInfo').textContent, /No hay datos registrados para el pedido 12345/);
});

test('la medición guarda el kit, el pedido y la preparación externa', async () => {
  const state = measurement(); ready(state, { username: 'usuario', role: 'analista' });
  state.element('#orderInput').value = 'P-0249';
  state.element('#orderInput').onchange();
  state.clock.now += 5 * 60000;
  state.run(`RUN.kit = ${FULL_KIT}; updateExternalClock()`);
  state.element('#start').onclick();
  assert.equal(state.run('RUN.phase'), 2);
  assert.equal(state.run('RUN.withKit'), true);
  assert.equal(state.run('RUN.soloTotal'), false);
  let record;
  state.context.saveRecord = async value => { record = copy(value); };
  await state.context.finishEarly();
  assert.deepEqual([record.kit.listos, record.kit.total, record.kit.faltantes.length], [10, 10, 0]);
  assert.deepEqual(record.kit.grupos.map(g => [g.key, g.listos, g.total]), [['orden', 4, 4], ['kit', 6, 6]]);
  assert.equal(record.external, 5);
  assert.deepEqual(record.pedido, { numero: 'P-0249', cliente: 'Pizzería Napoli', producto: 'BASE DE TORTA #30 - LOGO PIZZERÍA NAPOLI IMPRESO', cantidad: '1,150 und', medida: '30 × 30 cm', troquel: 'TQ-30' });
  assert.deepEqual(state.run('RUN.kit'), {});
  assert.equal(state.run('RUN.order'), null);
});

test('el operario solo inicia y termina: una actividad con la parada total', async () => {
  const state = measurement(); ready(state, { username: 'operario', role: 'operario' });
  state.run(`RUN.kit = ${FULL_KIT}; RUN.plan = [{ id: 'X', name: 'Actividad cambiada por otra persona' }]`);
  state.element('#start').onclick();
  assert.equal(state.run('RUN.phase'), 2);
  assert.equal(state.run('RUN.withKit'), true);
  assert.deepEqual(state.run('RUN.plan'), [{ id: 'TOTAL', name: 'Cambio de setup completo' }]);
  let record;
  state.context.saveRecord = async value => { record = copy(value); };
  state.clock.now += 12.5 * 60000;
  await state.context.advance();
  assert.equal(record.soloTotal, true);
  assert.equal(record.entries.length, 1);
  assert.equal(record.entries[0].minutes, 12.5);
  assert.equal(record.measuredTotal, 12.5);
  assert.equal(record.kit.listos, 10);
  assert.equal(record.pedido, undefined);
  assert.equal(state.run('RUN.phase'), 1);
});
