const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const app = require('./tests/app.cjs');

const activity = (name, minutes, extra = {}) => ({ name, minutes, type: 'Actividad', status: 'Registrada', ...extra });
const record = (entries, extra = {}) => ({ fecha: '2026-10-19', origen: 'Planta', entries, ...extra });
function rows(records) {
  const { context, run } = app();
  context.records = records;
  return run('excelRows(records)');
}

test('una fila por medición, fecha primero, actividades numeradas y repeticiones sumadas', () => {
  const result = rows([record([
    activity('Preparar', 2), activity('Preparar', 0.5, { type: 'Repetición' }),
    activity('Ajustar', 0), activity('Espera', 3, { type: 'Incidencia' }),
  ])]);
  assert.deepEqual(result[0], ['Fecha', '1. Preparar (min)', '2. Ajustar (min)', 'Hora de inicio', 'Hora de fin', 'Origen', 'Parada total (min)']);
  assert.deepEqual(result[1], ['2026-10-19', 2.5, 0, '—', '—', 'Planta', 5.5]);
});

test('une planes diferentes por nombre aunque cambien el orden y los identificadores', () => {
  const result = rows([
    record([activity('Preparar', 2, { activityId: 'A' }), activity('Ajustar', 4, { activityId: 'B' })]),
    record([activity(' ajustar ', 5, { activityId: 'X' }), activity('PREPARAR', 3, { activityId: 'Y' }), activity('Probar', 1)], { fecha: '2026-10-18' }),
  ]);
  assert.deepEqual(result[0].slice(0, 4), ['Fecha', '1. Preparar (min)', '2. Ajustar (min)', '3. Probar (min)']);
  assert.deepEqual(result[1].slice(0, 4), ['2026-10-19', 2, 4, 'No se registró']);
  assert.deepEqual(result[2].slice(0, 4), ['2026-10-18', 3, 5, 1]);
});

test('incluye actividades del plan sin entrada y distingue omisiones de tiempos cero', () => {
  const result = rows([record([
    activity('Preparar', 0.7, { status: 'Omitida' }),
    activity('Ajustar', 0),
    activity('Repetir', 0.4, { status: 'Omitida' }),
    activity('Repetir', 1.2, { type: 'Repetición' }),
  ], { plan: [{ name: 'Preparar' }, { name: 'Ajustar' }, { name: 'Probar' }, { name: 'Repetir' }] })]);
  assert.deepEqual(result[1].slice(1, 5), ['No se registró', 0, 'No se registró', 1.2]);
});

test('admite registros del prototipo anterior y un historial vacío', () => {
  const result = rows([{ fecha: '2026-09-30', origen: 'Piloto', t: Array.from({ length: 15 }, (_, i) => i), exc: 2 }]);
  assert.equal(result.length, 2);
  assert.equal(result[0][1], '1. Despejar zona de trabajo (min)');
  assert.deepEqual(result[1].slice(1, 14), Array.from({ length: 13 }, (_, i) => i + 2));
  assert.deepEqual(rows([]), [['Fecha', 'Hora de inicio', 'Hora de fin', 'Origen', 'Parada total (min)']]);
});

test('el botón Excel exporta todos los orígenes y conserva el detalle', () => {
  const { context, element } = app();
  context.records = [record([activity('Preparar', 2)], { id: 'A' }), record([activity('Solo simulado', 4)], { id: 'B', origen: 'Simulado', fecha: '2026-10-18' })];
  vm.runInContext('REG = records', context);
  let saved;
  const XLSX = {
    utils: {
      book_new: () => ({}),
      aoa_to_sheet: rows => ({ rows: JSON.parse(JSON.stringify(rows)) }),
      book_append_sheet: (book, sheet, name) => { book[name] = sheet; },
    },
    writeFile: (book, name) => { saved = { book, name }; },
  };
  context.XLSX = context.window.XLSX = XLSX;
  element('#xlsx').onclick();
  assert.equal(saved.name, 'Mediciones_SMED.xlsx');
  assert.equal(saved.book.Mediciones.rows.length, 3);
  assert.equal(saved.book.Mediciones.rows[0][1], '1. Preparar (min)');
  assert.equal(saved.book.Mediciones.rows[1][1], 2);
  assert.deepEqual(saved.book.Mediciones.rows[2].slice(0, 3), ['2026-10-18', 'No se registró', 4]);
  assert.deepEqual(saved.book.Detalle.rows[0], ['Fecha', 'Hora de inicio', 'Hora de fin', 'Parada (min)', 'Medición', 'Actividades omitidas', 'Registrado por']);
  assert.deepEqual(saved.book.Detalle.rows.slice(1).map(row => row[0]), ['2026-10-19', '2026-10-18']);
});

test('la hoja Detalle reproduce la tabla del historial', () => {
  const { context, run } = app();
  context.records = [
    record([activity('Preparar', 0.0655), activity('Ajustar', 0.01451667), activity('Probar', 0, { status: 'Omitida' }), activity('Aprobar', 0, { status: 'Omitida' })], { horaInicio: '23:39:57', horaFin: '23:40:02' }),
    record([activity('Preparar', 20), activity('Ajustar', 33.666)], { fecha: '2026-10-11', horaInicio: '14:11:00', horaFin: '15:04:40', _registradoPor: { username: 'operario', role: 'operario' } }),
  ];
  assert.deepEqual(run('historyExportRows(records)').slice(1), [
    ['2026-10-19', '23:39:57', '23:40:02', 0.08, 'Con omisiones', 2, '—'],
    ['2026-10-11', '14:11:00', '15:04:40', 53.67, 'Completa', 0, 'Operario · operario'],
  ]);
});

test('una medición de solo parada total no crea columnas de actividad ni entra al Pareto', () => {
  const { context, run } = app();
  const total = record([activity('Cambio de setup completo', 31.5)], { soloTotal: true, plan: [{ id: 'TOTAL', name: 'Cambio de setup completo' }], _registradoPor: { username: 'operario', role: 'operario' } });
  context.records = [record([activity('Preparar', 2), activity('Ajustar', 4)]), total];
  const result = run('excelRows(records)');
  assert.deepEqual(result[0], ['Fecha', '1. Preparar (min)', '2. Ajustar (min)', 'Hora de inicio', 'Hora de fin', 'Origen', 'Parada total (min)']);
  assert.deepEqual(result[2].slice(1, 3), ['No se registró', 'No se registró']);
  assert.equal(result[2].at(-1), 31.5);
  assert.deepEqual(run('activityStats(records).map(s => s.name)'), ['Ajustar', 'Preparar']);
  assert.deepEqual(run('historyExportRows(records)')[2].slice(4), ['Solo parada total', 0, 'Operario · operario']);
});
