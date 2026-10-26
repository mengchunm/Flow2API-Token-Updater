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

function background(tabs, sendMessage, config = {}, overrides = {}) {
  const state = { config };
  let injections = 0;
  const created = [];
  const context = vm.createContext({ URL, console, AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 500 ? 0 : ms), clearTimeout,
    fetch: overrides.fetch || (async () => { throw new Error('offline'); }), chrome: {
    runtime: { id: 'extension', onMessage: { addListener() {} } },
    tabs: { query: async () => tabs, sendMessage,
      get: async id => ({ ...(tabs.find(tab => tab.id === id) || created.find(tab => tab.id === id)), status: 'complete', url: 'https://flow.google.com/projects' }),
      create: async details => { const tab = { id: 100 + created.length, windowId: 10, ...details }; created.push(tab); return tab; }
    },
    scripting: { executeScript: async details => {
      if (details.func) return [{result: {accounts: [], clicked: false}}];
      assert.equal(details.files[0], 'flow-session.js');
      injections++;
    } },
    permissions: { contains: async () => true },
    storage: { local: { get: async () => state, set: async value => Object.assign(state, value) } },
    alarms: { clear: async () => {}, create: async () => {} }
  } });
  vm.runInContext(source('background.js'), context);
  return { run: code => vm.runInContext(code, context), state, created, injections: () => injections };
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
  const empty = background([], async () => ({ signed_in: true, email: 'user@example.com' }));
  const opened = await empty.run('discoverAccounts()');
  assert.equal(opened.openedFlow, true);
  assert.equal(empty.created.filter(tab => tab.url.includes('flow.google.com/projects')).length, 1);
  assert.equal(opened.accounts[0].email, 'user@example.com');
  const bg = background([{ id: 1 }, { id: 2 }], async id => {
    if (id === 1) return { signed_in: false, email: '' };
    throw new Error('Access denied');
  });
  const result = await bg.run('discoverAccounts()');
  assert.equal(result.accounts.length, 0);
  assert.equal(result.unreadableTabs, 2);
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
  const config = vm.runInContext('selectedEmail = "user@example.com"; selectedAccountBinding = { sourceTabId: 12, sourceWindowId: 34 }; getFormConfig()', context);
  assert.equal(config.sourceTabId, 12);
  assert.equal(config.sourceWindowId, 34);
  assert.equal(config.tabId, undefined);
});


test('Google account list is parsed, normalized and deduplicated without auth fields', () => {
  const bg = background([], async () => {});
  const result = bg.run(`parseGoogleAccounts(JSON.stringify(['gaia.l.a.r', [
    ['gaia.l.a', 1, 'Name', 'One@Example.com', 'secret'],
    ['gaia.l.a', 2, 'Name', 'one@example.com'],
    ['gaia.l.a', 3, 'Name', 'two@example.com'],
    ['unknown', 4, 'Name', 'bad@example.com']]]))`);
  assert.deepEqual(Array.from(result), ['one@example.com', 'two@example.com']);
});

test('discovery combines Google candidates with verified Flow identity', async () => {
  const bg = background([{ id: 1, windowId: 10 }], async () => ({ signed_in: true, email: 'one@example.com' }), {}, {
    fetch: async () => ({ ok: true, text: async () => JSON.stringify(['gaia.l.a.r', [
      ['gaia.l.a', 1, 'One', 'one@example.com'], ['gaia.l.a', 2, 'Two', 'two@example.com']]]) })
  });
  const result = await bg.run('discoverAccounts()');
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts[0].verified, true);
  assert.equal(result.accounts[1].verified, false);
  assert.equal(bg.state.accountDiscovery.accounts.length, 2);
});

test('selecting another account opens authuser URL and verifies actual identity', async () => {
  const bg = background([{ id: 1, windowId: 10 }], async id => ({ signed_in: true,
    email: id === 1 ? 'one@example.com' : 'two@example.com' }));
  const result = await bg.run('selectAccount("two@example.com")');
  assert.equal(result.email, 'two@example.com');
  assert.equal(new URL(bg.created[0].url).searchParams.get('authuser'), 'two@example.com');
  assert.equal(bg.created[0].active, false);
});

test('selecting an account rejects Google falling back to the default account', async () => {
  const bg = background([], async () => ({ signed_in: true, email: 'one@example.com' }));
  await assert.rejects(bg.run('selectAccount("two@example.com")'), /未切换/);
});

test('simultaneous discovery requests share the same task and opening', async () => {
  const bg = background([], async () => ({ signed_in: true, email: 'one@example.com' }));
  await bg.run('Promise.all([discoverAccounts(), discoverAccounts()])');
  assert.equal(bg.created.filter(tab => tab.url.includes('flow.google.com/projects')).length, 1);
});

test('popup only binds the selected account after Flow confirms its identity', async () => {
  const elements = { loginAccount: { value: 'one@example.com' }, accountSelect: { value: '' } };
  const context = vm.createContext({ URL, setTimeout, clearTimeout, document: {
    addEventListener() {}, getElementById: id => elements[id]
  }, chrome: { runtime: { sendMessage(request, callback) {
    callback({ success: true, account: { email: request.email, tabId: 100, windowId: 10 } });
  } } } });
  vm.runInContext(source('popup.js'), context);
  await vm.runInContext('chooseAccount("two@example.com")', context);
  assert.equal(vm.runInContext('selectedEmail', context), 'two@example.com');
  assert.equal(vm.runInContext('selectedAccountBinding.sourceTabId', context), 100);
  vm.runInContext('chrome.runtime.sendMessage = (request, callback) => callback({success: false, error: "login required"})', context);
  await assert.rejects(vm.runInContext('chooseAccount("three@example.com")', context), /login required/);
  assert.equal(vm.runInContext('selectedAccountBinding', context), null);
  assert.equal(vm.runInContext('selectedEmail', context), 'two@example.com');
});


test('AccountChooser reads only account attributes and clicks only the requested account', () => {
  const bg = background([], async () => {});
  const inspect = bg.run('inspectAccountChooser.toString()');
  let clicked = '';
  const row = email => ({ getAttribute: key => key === 'data-identifier' ? email : null,
    closest: () => ({ click: () => { clicked = email; } }) });
  const context = vm.createContext({ location: { origin: 'https://accounts.google.com', pathname: '/AccountChooser' },
    document: { querySelectorAll: () => [row('one@example.com'), row('two@example.com'), row('invalid')] } });
  vm.runInContext(`const inspect = ${inspect}`, context);
  assert.equal(vm.runInContext('inspect().accounts.length', context), 2);
  assert.equal(clicked, '');
  assert.equal(vm.runInContext('inspect("two@example.com").clicked', context), true);
  assert.equal(clicked, 'two@example.com');
  assert.equal(vm.runInContext('inspect("absent@example.com").clicked', context), false);
});

test('batch extraction is sequential and preserves individual failures', async () => {
  const bg = background([], async () => {}, { apiUrl: 'https://example.com/api/plugin/update-token', connectionToken: 'test' });
  bg.run(`globalThis.calls = [];
    discoverAccounts = async () => ({ accounts: [{email:'one@example.com'}, {email:'two@example.com'}, {email:'three@example.com'}] });
    executeSync = async email => { calls.push(email); if (email === 'two@example.com') throw new Error('identity mismatch'); return {success:true, message:'updated'}; };`);
  const result = await bg.run('executeBatchSync()');
  assert.equal(result.success, false);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[1].success, false);
  assert.equal(result.results[2].success, true);
  assert.equal(bg.state.batchSync.running, false);
  assert.equal(bg.state.batchSync.completed, 3);
  assert.deepEqual(Array.from(bg.run('calls')), ['one@example.com', 'two@example.com', 'three@example.com']);
});

test('background discovery refreshes dropdown from one to two accounts without switching selection', () => {
  const select = { value: 'one@example.com', options: [],
    set innerHTML(value) { this.options = []; },
    appendChild(option) { this.options.push(option); } };
  const elements = { accountSelect: select, loginAccount: { value: 'one@example.com' }, accountCount: { textContent: '' } };
  const context = vm.createContext({ URL, setTimeout, clearTimeout, document: {
    addEventListener() {}, getElementById: id => elements[id], createElement: () => ({})
  } });
  vm.runInContext(source('popup.js'), context);
  vm.runInContext(`selectedEmail = 'one@example.com'; selectedAccountBinding = {sourceTabId: 12, sourceWindowId: 10};
    renderAccounts({accounts:[{email:'one@example.com',verified:true}]});`, context);
  assert.equal(select.options.length, 1);
  vm.runInContext(`handleStorageChanges({accountDiscovery:{newValue:{accounts:[
    {email:'one@example.com',verified:true},{email:'two@example.com',verified:false}]}}}, 'local')`, context);
  assert.equal(select.options.length, 2);
  assert.equal(select.options[1].value, 'two@example.com');
  assert.equal(select.value, 'one@example.com');
  assert.match(elements.accountCount.textContent, /2 个账号/);
  assert.equal(vm.runInContext('selectedAccountBinding.sourceTabId', context), 12);
  vm.runInContext(`handleStorageChanges({accountDiscovery:{newValue:{accounts:[]}}}, 'sync')`, context);
  assert.equal(select.options.length, 2);
});

test('modern Google v3 accountchooser supports email attributes and indexed account rows', () => {
  const bg = background([], async () => {});
  const inspect = bg.run('inspectAccountChooser.toString()');
  const row = (attrs, textContent = '') => ({ textContent, getAttribute: key => attrs[key] || null, closest: () => null });
  const context = vm.createContext({ location: { origin: 'https://accounts.google.com', pathname: '/v3/signin/accountchooser' },
    document: { querySelectorAll: () => [
      row({'data-email-address':'One@Example.com'}),
      row({'data-authuser':'1'}, 'Account Two two@example.com'),
      row({'data-authuser':'2'}, 'two@example.com other@example.com')
    ] } });
  vm.runInContext(`const inspect = ${inspect}`, context);
  const result = vm.runInContext('inspect()', context);
  assert.equal(result.page, 'chooser');
  assert.deepEqual(Array.from(result.accounts), ['one@example.com', 'two@example.com']);
});

test('chooser discovery waits for a second account rendered after the first', async () => {
  const bg = background([], async () => {});
  bg.run(`globalThis.reads = 0; readChooser = async () => ({ page:'chooser', entries:2,
    accounts: ++reads < 3 ? ['one@example.com'] : ['one@example.com','two@example.com'] });`);
  const result = await bg.run('discoverChooserAccounts()');
  assert.deepEqual(Array.from(result.emails), ['one@example.com','two@example.com']);
  assert.ok(bg.run('reads') >= 3);
});

test('all-account configuration supports no manually entered email and saves scheduling options', async () => {
  const bg = background([], async () => {});
  bg.run('globalThis.period = null; chrome.alarms.create = async (name, options) => { period = options.periodInMinutes; }');
  const saved = await bg.run(`saveConfiguration({apiUrl:'https://example.com', connectionToken:'test',
    loginAccount:'', syncMode:'all', refreshInterval:15, autoSync:true})`);
  assert.equal(saved.loginAccount, '');
  assert.equal(saved.syncMode, 'all');
  assert.equal(saved.refreshInterval, 15);
  assert.equal(bg.run('period'), 15);
  await bg.run(`saveConfiguration({apiUrl:'https://example.com', connectionToken:'test',
    syncMode:'all', refreshInterval:30, autoSync:false})`);
  bg.run('period = null');
  await bg.run('restoreAlarm()');
  assert.equal(bg.run('period'), null);
  await assert.rejects(bg.run(`saveConfiguration({apiUrl:'https://example.com',connectionToken:'test',syncMode:'single'})`), /填写邮箱/);
});

test('scheduled sync follows saved scope and concurrent triggers share one task', async () => {
  const bg = background([], async () => {}, {syncMode:'all'});
  bg.run(`globalThis.batchCalls = 0; globalThis.singleCalls = 0;
    executeBatchSync = async () => { batchCalls++; return {success:true,message:'batch'}; };
    executeSync = async () => { singleCalls++; return {success:true,message:'single'}; };`);
  await bg.run('Promise.all([syncNow(), syncNow()])');
  assert.equal(bg.run('batchCalls'), 1);
  assert.equal(bg.run('singleCalls'), 0);
  bg.state.config.syncMode = 'single';
  await bg.run('syncNow()');
  assert.equal(bg.run('singleCalls'), 1);
});
