const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

// Cargar el script real de la aplicación sin iniciar servicios ni temporizadores.
function app() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', addEventListener() {} });
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    setInterval() {}, setTimeout() {}, clearTimeout() {}, AbortController,
    fetch: () => new Promise(() => {}),
  });
  const html = readFileSync(`${__dirname}/index.html`, 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context);
  return { context, element, run: code => JSON.parse(JSON.stringify(vm.runInContext(code, context))) };
}

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
  assert.equal(saved.book.Detalle.rows[1][0], 'A');
  assert.equal(saved.book.Detalle.rows[2][0], 'B');
});
