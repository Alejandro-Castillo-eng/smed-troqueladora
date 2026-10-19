const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');
const vm = require('node:vm');

// Ejecutar el script real sin servicios ni temporizadores. El navegador se valida aparte.
module.exports = function app({ storage = new Map(), clock } = {}) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', addEventListener() {} });
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setInterval() {}, setTimeout() {}, clearTimeout() {}, AbortController,
    fetch: () => new Promise(() => {}), structuredClone, crypto: webcrypto,
    ...(clock ? { Date: class extends Date { static now() { return clock.now; } } } : {}),
  });
  const html = readFileSync(`${__dirname}/../index.html`, 'utf8');
  vm.runInContext(html.match(/<script>\s*([\s\S]*?)<\/script>/)[1], context);
  const run = code => JSON.parse(JSON.stringify(vm.runInContext(code, context)) ?? 'null');
  return { context, element, run, storage };
};
