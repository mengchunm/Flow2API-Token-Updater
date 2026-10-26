const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const root = join(__dirname, '..');
const source = name => readFileSync(join(root, name), 'utf8');

function page(scripts) {
  const listeners = [];
  const context = vm.createContext({
    document: { scripts: scripts.map(textContent => ({ textContent })) },
    chrome: { runtime: { id: 'extension', onMessage: { addListener: fn => listeners.push(fn) } } }
  });
  vm.runInContext(source('flow-session.js'), context);
  return { context, listeners, request(action, sender = 'extension') {
    let result;
    listeners[0]({ action }, { id: sender }, value => { result = value; });
    return result;
  } };
}

function background(tabs, sendMessage, config = {}) {
  const state = { config };
  let injections = 0;
  const context = vm.createContext({ URL, console, setTimeout, clearTimeout, chrome: {
    runtime: { id: 'extension', onMessage: { addListener() {} } },
    tabs: { query: async () => tabs, sendMessage },
    scripting: { executeScript: async details => {
      assert.equal(details.files[0], 'flow-session.js');
      injections++;
    } },
    permissions: { contains: async () => true },
    storage: { local: { get: async () => state, set: async value => Object.assign(state, value) } },
    alarms: { clear: async () => {}, create: async () => {} }
  } });
  vm.runInContext(source('background.js'), context);
  return { run: code => vm.runInContext(code, context), state, injections: () => injections };
}

test('scan returns the actual page account and rejects other senders', () => {
  const p = page(['window.WIZ_global_data = {"oPEP7c":"User@Example.com","SNlM0e":"private"};']);
  const result = p.request('gflow-discover-account');
  assert.equal(result.signed_in, true);
  assert.equal(result.email, 'user@example.com');
  assert.equal(Object.keys(result).length, 2); // Discovery never returns auth fields.
  assert.equal(p.request('gflow-discover-account', 'other-extension'), undefined);
});

test('signed-out pages and repeated script injection are handled', () => {
  const p = page(['window.WIZ_global_data = {};']);
  assert.equal(p.request('gflow-discover-account').signed_in, false);
  assert.equal(p.request('gflow-discover-account').email, '');
  vm.runInContext(source('flow-session.js'), p.context);
  assert.equal(p.listeners.length, 1);
});

test('scan recovers a missing page script and removes duplicate accounts', async () => {
  const calls = new Map();
  const bg = background([{ id: 1, windowId: 10 }, { id: 2, windowId: 10 }], async id => {
    calls.set(id, (calls.get(id) || 0) + 1);
    if (id === 1 && calls.get(id) === 1) throw new Error('Receiving end does not exist');
    return { signed_in: true, email: 'user@example.com' };
  });
  const result = await bg.run('discoverAccounts()');
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, 'user@example.com');
  assert.equal(result.scannedTabs, 2);
  assert.equal(bg.injections(), 1);
});

test('scan recovers an old script that ignores discovery messages', async () => {
  let attempts = 0;
  const bg = background([{ id: 1, windowId: 10 }], async () =>
    ++attempts === 1 ? undefined : { signed_in: true, email: 'user@example.com' });
  assert.equal((await bg.run('discoverAccounts()')).accounts.length, 1);
  assert.equal(bg.injections(), 1);
});

test('scan distinguishes no tabs, signed-out pages and unreadable pages', async () => {
  const empty = background([], async () => {});
  assert.equal((await empty.run('discoverAccounts()')).scannedTabs, 0);
  const bg = background([{ id: 1 }, { id: 2 }], async id => {
    if (id === 1) return { signed_in: false, email: '' };
    throw new Error('Access denied');
  });
  const result = await bg.run('discoverAccounts()');
  assert.equal(result.accounts.length, 0);
  assert.equal(result.signedOutTabs, 1);
  assert.equal(result.unreadableTabs, 1);
});

test('page binding survives save/load and can be cleared for manual input', async () => {
  const bg = background([], async () => {});
  const saved = await bg.run(`saveConfiguration({ apiUrl: 'https://example.com/api/plugin/update-token',
    connectionToken: 'test-token', loginAccount: 'user@example.com', sourceTabId: 12, sourceWindowId: 34 })`);
  assert.equal(saved.sourceTabId, 12);
  assert.equal(saved.sourceWindowId, 34);
  const cleared = await bg.run(`saveConfiguration({ apiUrl: 'https://example.com/api/plugin/update-token',
    connectionToken: 'test-token', loginAccount: 'other@example.com', sourceTabId: null, sourceWindowId: null })`);
  assert.equal(cleared.sourceTabId, null);
  assert.equal(cleared.sourceWindowId, null);
});

test('popup sends selected tab binding using the backend field names', () => {
  const values = { apiUrl: 'https://example.com', connectionToken: 'test-token', loginAccount: 'user@example.com', refreshInterval: '60' };
  const context = vm.createContext({ URL, setTimeout, clearTimeout, document: {
    addEventListener() {}, getElementById: id => ({ value: values[id] })
  } });
  vm.runInContext(source('popup.js'), context);
  const config = vm.runInContext('selectedAccountBinding = { sourceTabId: 12, sourceWindowId: 34 }; getFormConfig()', context);
  assert.equal(config.sourceTabId, 12);
  assert.equal(config.sourceWindowId, 34);
  assert.equal(config.tabId, undefined);
});
