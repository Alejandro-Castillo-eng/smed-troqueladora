const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// Ejecuta el adaptador de GitHub Pages con un fetch simulado para revisar qué función de Supabase llama.
function adapter(reply) {
  const calls = [], storage = new Map();
  const context = vm.createContext({
    window: {}, AbortController, setTimeout, clearTimeout,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    fetch: async (url, options) => {
      const name = url.split('/').pop(), body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ name, body, apikey: options?.headers?.apikey });
      const [status, value] = name === 'simulated-records.json' ? [200, [{ id: 'SIM-001' }]] : reply(name, body);
      return { ok: status < 400, status, json: async () => value };
    },
  });
  vm.runInContext(readFileSync(`${__dirname}/scripts/supabase-adapter.js`, 'utf8'), context);
  return { api: context.window.smedPagesAPI, calls, storage };
}

test('inicia sesión, guarda el token y lo envía en cada llamada', async () => {
  const { api, calls, storage } = adapter(name => name === 'smed_login'
    ? [200, { token: 'abc', user: { username: 'operario', role: 'operario' } }] : [200, { ok: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(await api('/api/auth/login', 'POST', { username: 'operario', password: 'x', role: 'operario' }))),
    { user: { username: 'operario', role: 'operario' } });
  assert.deepEqual(calls[0].body, { p_username: 'operario', p_password: 'x', p_role: 'operario' });
  assert.match(calls[0].apikey, /^sb_publishable_/);
  await api('/api/records', 'POST', { id: 'R1' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { name: 'smed_save_record', body: { p_token: 'abc', p_record: { id: 'R1' } }, apikey: calls[0].apikey });
  await api('/api/auth/logout', 'POST', {});
  assert.equal(calls[2].name, 'smed_logout');
  assert.equal(storage.size, 0);
});

test('cada ruta de la aplicación llama a su función', async () => {
  const { api, calls } = adapter(() => [200, []]);
  await api('/api/config');
  await api('/api/config', 'POST', { meta: 30 });
  await api('/api/records');
  await api('/api/records/import', 'POST', { records: [] });
  await api('/api/records/seed', 'POST', {});
  await api('/api/records/A%2FB', 'DELETE', {});
  assert.deepEqual(calls.map(c => c.name), ['smed_get_config', 'smed_set_config', 'smed_list_records',
    'smed_import_records', 'simulated-records.json', 'smed_seed_records', 'smed_delete_record']);
  assert.deepEqual(calls.at(-2).body.p_records, [{ id: 'SIM-001' }]);
  assert.equal(calls.at(-1).body.p_id, 'A/B');
});

test('muestra los mensajes de error del servidor', async () => {
  const { api } = adapter(name => name === 'smed_login'
    ? [200, { error: 'Usuario o contraseña incorrectos.' }]
    : [400, { message: 'Esta sección es solo para el analista.' }]);
  await assert.rejects(api('/api/auth/login', 'POST', { username: 'a', password: 'b' }), /incorrectos/);
  await assert.rejects(api('/api/records'), /solo para el analista/);
});

test('una sesión vencida se olvida en este equipo', async () => {
  const { api, storage } = adapter(() => [200, { configured: true, user: null }]);
  storage.set('smed.supabase.session.v1', 'viejo');
  assert.equal((await api('/api/auth/status')).user, null);
  assert.equal(storage.size, 0);
});
