const assert = require('node:assert/strict');
const { test } = require('node:test');
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

test('sin sesión primero se elige el rol y luego aparecen sus credenciales', () => {
  const { context, element, run } = app();
  context.renderDraft = () => {};
  vm.runInContext(`backendState = { configured: true, user: null, databaseId: 'test' }; renderAccess()`, context);
  assert.equal(element('#roleChoice').hidden, false);
  assert.equal(element('#loginGrid').hidden, true);
  vm.runInContext(`chooseLoginRole('operario')`, context);
  assert.equal(run('loginRole'), 'operario');
  assert.equal(element('#roleChoice').hidden, true);
  assert.equal(element('#loginGrid').hidden, false);
  assert.equal(element('#loginRolePill').textContent, 'Operario');
  assert.equal(element('#loginIntro').textContent, 'Ingresa con tu usuario de operario.');
  element('#backToRoles').onclick();
  assert.equal(run('loginRole'), null);
  assert.equal(element('#roleChoice').hidden, false);
});
