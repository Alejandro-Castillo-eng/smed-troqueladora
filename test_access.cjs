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
  return { login: hidden('loginScreen'), analyst: hidden('appMain'), nav: hidden('appNav'), operator: hidden('operatorMain'),
    account: element('#accountName').textContent, analystSignedIn: run('analystSignedIn') };
}

test('el analista ve las opciones actuales y no el panel del operario', () => {
  assert.deepEqual(screens({ username: 'usuario', role: 'analista' }),
    { login: true, analyst: false, nav: false, operator: true, account: 'Analista · usuario', analystSignedIn: true });
});

test('el operario ve solo su panel, sin medición, historial, análisis ni configuración', () => {
  assert.deepEqual(screens({ username: 'operario', role: 'operario' }),
    { login: true, analyst: true, nav: true, operator: false, account: 'Operario · operario', analystSignedIn: false });
});

test('sin sesión solo se muestra el inicio de sesión', () => {
  assert.deepEqual(screens(null), { login: false, analyst: true, nav: true, operator: true, account: '', analystSignedIn: false });
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
  await api('/api/auth/logout', 'POST', {});
  await api('/api/auth/login', 'POST', { username: 'usuario', password: 'artefacto' });
  assert.equal((await api('/api/auth/status')).user.role, 'analista');
  assert.equal((await api('/api/records')).records.length, 1);
});
