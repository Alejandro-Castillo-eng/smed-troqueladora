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

test('el kit de materiales se guarda con la medición e indica lo que faltaba', async () => {
  const state = measurement(); prepare(state);
  state.run(`RUN.kit = { 'orden-codigo': true, 'kit-troquel': true, 'otro-legado': true }`);
  let record;
  state.context.saveRecord = async value => { record = copy(value); };
  await state.context.finishEarly();
  assert.equal(record.kit.listos, 2);
  assert.equal(record.kit.total, 10);
  assert.equal(record.kit.faltantes.length, 8);
  assert(record.kit.faltantes.includes('Dimensiones del empaque'));
  assert.deepEqual(state.run('RUN.kit'), {});
});

test('iniciar con el kit incompleto pide confirmación; completo inicia directamente', () => {
  const state = measurement();
  let asked = null;
  state.context.ask = (title, help, fields, action) => { asked = { title, action }; };
  state.context.renderRun = () => {};
  for (const id of ['measurementDate', 'measurementTime']) state.element('#' + id).reportValidity = () => true;
  state.element('#measurementDate').value = '2026-10-26';
  state.run(`RUN.kit = { 'orden-codigo': true }`);
  state.element('#start').onclick();
  assert.equal(asked.title, 'Kit de materiales incompleto');
  assert.equal(state.run('RUN.phase'), 1);
  asked.action();
  assert.equal(state.run('RUN.phase'), 2);
  const complete = measurement();
  complete.context.ask = () => { throw new Error('no debe preguntar'); };
  complete.context.renderRun = () => {};
  for (const id of ['measurementDate', 'measurementTime']) complete.element('#' + id).reportValidity = () => true;
  complete.run(`RUN.kit = Object.fromEntries(KIT.flatMap(g => g.items).map(([id]) => [id, true]))`);
  complete.element('#start').onclick();
  assert.equal(complete.run('RUN.phase'), 2);
});

test('el operario inicia siempre con la lista de referencia, sin editarla', () => {
  const state = measurement();
  state.context.renderRun = () => {};
  for (const id of ['measurementDate', 'measurementTime']) state.element('#' + id).reportValidity = () => true;
  state.run(`backendState = { configured: true, user: { username: 'operario', role: 'operario' } };
    RUN.kit = Object.fromEntries(KIT.flatMap(g => g.items).map(([id]) => [id, true]));
    RUN.plan = [{ id: 'X', name: 'Actividad cambiada por otra persona' }]`);
  state.element('#start').onclick();
  assert.equal(state.run('RUN.phase'), 2);
  assert.deepEqual(state.run('RUN.plan'), state.run('defaultPlan()'));
});
