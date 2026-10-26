const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const app = require('./tests/app.cjs');

function screens(user) {
  const { context, run, element } = app();
  context.sessionStorage = { getItem: () => 'true', setItem() {}, removeItem() {} };
  context.renderDraft = () => {};
  context.stage = () => {};
  vm.runInContext(`backendState = ${JSON.stringify({ configured: true, user, databaseId: 'test' })}; renderAccess()`, context);
  const hidden = id => element('#' + id).hidden;
  return { login: hidden('loginScreen'), app: hidden('appMain'), nav: hidden('appNav'),
    account: element('#accountName').textContent, views: run(`['nuevo', 'hist', 'dash', 'conf'].filter(canView)`),
    operatorMode: element('#appMain').classList.contains('operator-mode') };
}

test('el analista conserva todas las secciones', () => {
  assert.deepEqual(screens({ username: 'usuario', role: 'analista' }),
    { login: true, app: false, nav: false, account: 'Analista · usuario', views: ['nuevo', 'hist', 'dash', 'conf'], operatorMode: false });
});

test('el operario solo tiene la sección Nuevo setup, sin la lista de actividades al medir', () => {
  assert.deepEqual(screens({ username: 'operario', role: 'operario' }),
    { login: true, app: false, nav: false, account: 'Operario · operario', views: ['nuevo'], operatorMode: true });
});

test('sin sesión solo se muestra el inicio de sesión', () => {
  assert.deepEqual(screens(null), { login: false, app: true, nav: true, account: '', views: [], operatorMode: false });
});

test('la versión de GitHub Pages admite ambos usuarios y reserva los registros al analista', async () => {
  const session = new Map(), local = new Map();
  const context = vm.createContext({
    window: {}, structuredClone,
    sessionStorage: { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, v), removeItem: k => session.delete(k) },
    localStorage: { getItem: k => local.get(k) ?? null, setItem: (k, v) => local.set(k, v) },
    fetch: async () => ({ ok: true, json: async () => [{ id: 'SIM-001', origen: 'Simulado' }] }),
  });
  vm.runInContext(readFileSync(`${__dirname}/scripts/pages-adapter.js`, 'utf8'), context);
  const api = context.window.smedPagesAPI;
  await assert.rejects(api('/api/auth/login', 'POST', { username: 'operario', password: 'artefacto' }), /incorrectos/);
  await assert.rejects(api('/api/auth/login', 'POST', { username: 'constructor', password: 'x' }), /incorrectos/);
  const operator = await api('/api/auth/login', 'POST', { username: 'operario', password: 'troqueladora' });
  assert.deepEqual({ ...operator.user }, { username: 'operario', role: 'operario' });
  await assert.rejects(api('/api/records'), /solo para el analista/);
  await assert.rejects(api('/api/config', 'POST', { meta: 10 }), /solo para el analista/);
  assert.equal((await api('/api/config')).meta, 33.6);
  const entries = [{ name: 'Preparar', minutes: 2 }];
  assert.equal((await api('/api/records', 'POST', { id: 'OP-1', origen: 'Planta', entries })).id, 'OP-1');
  assert.equal((await api('/api/records', 'POST', { id: 'OP-1', origen: 'Planta', entries: [{ name: 'Preparar', minutes: 3 }], _version: 1 }))._version, 2);
  await assert.rejects(api('/api/records', 'POST', { id: 'SIM-001', origen: 'Planta', entries, _version: 1 }), /propias mediciones/);
  await api('/api/auth/logout', 'POST', {});
  await api('/api/auth/login', 'POST', { username: 'usuario', password: 'artefacto' });
  assert.equal((await api('/api/auth/status')).user.role, 'analista');
  const records = (await api('/api/records')).records;
  assert.equal(records.length, 2);
  assert.deepEqual({ ...records.find(r => r.id === 'OP-1')._registradoPor }, { username: 'operario', role: 'operario' });
  assert.equal(records.find(r => r.id === 'SIM-001')._registradoPor, null);
});
