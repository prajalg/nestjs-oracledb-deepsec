const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

for (const scenario of ['query', 'login']) {
  test(`UI renders original ${scenario} diagnostics as text`, async () => {
    const elements = new Map();
    const get = id => {
      if (!elements.has(id)) elements.set(id, { dataset: {}, handlers: {},
        addEventListener(event, handler) { this.handlers[event] = handler; } });
      return elements.get(id);
    };
    const diagnostic = { code: scenario === 'query' ? 'NJS-198' : 'invalid_client',
      message: 'AADSTS7000222: expired <script>fixture</script>' };
    let poll;
    let failed = false;
    const context = vm.createContext({
      document: { getElementById: get },
      setTimeout: callback => { poll = callback; }, clearTimeout() {},
      fetch: async path => {
        if (path === '/api/health') return { ok: true, json: async () => ({ query: 'SELECT 1 FROM dual' }) };
        if (path === '/api/query') return { ok: false, status: 503, json: async () => diagnostic };
        if (path === '/deepsec/auth/start') return { ok: true, json: async () => ({ verificationUri: 'https://example.test', userCode: 'fixture' }) };
        return { ok: true, json: async () => failed ? { state: 'failed', error: diagnostic } : { state: 'authenticated' } };
      },
    });
    vm.runInContext(readFileSync(require.resolve('../public/app.js'), 'utf8'), context);
    await new Promise(resolve => setImmediate(resolve));
    if (scenario === 'query') await get('run').handlers.click();
    else {
      await get('login').handlers.click();
      failed = true;
      await poll();
    }
    assert.equal(get('error').hidden, false);
    assert.equal(get('error').textContent, `${diagnostic.code}: ${diagnostic.message}`);
    assert.equal(get('error').innerHTML, undefined, 'provider text is never inserted as HTML');
  });
}
