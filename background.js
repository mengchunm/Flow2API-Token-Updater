// background.js - GFlow 登录助手后台服务


const ALARM = 'tokenRefresh';
const FLOW_URL = 'https://flow.google.com/projects';
let activeSync = null;
let activeDiscovery = null;

// 日志系统
const Logger = {
  async log(level, message, details = null) {
    const timestamp = new Date().toISOString();
    const safeDetails = sanitizeLogDetails(details);
    const logEntry = { timestamp, level, message, details: safeDetails };
    console.log(`[${level}] ${message}`, safeDetails || '');
    try {
      const { logs = [] } = await chrome.storage.local.get(['logs']);
      const updatedLogs = [logEntry, ...logs].slice(0, 100);
      await chrome.storage.local.set({ logs: updatedLogs });
    } catch (_) {}
  },
  info(msg, d) { return this.log('INFO', msg, d); },
  error(msg, d) { return this.log('ERROR', msg, d); },
  success(msg, d) { return this.log('SUCCESS', msg, d); },
  async getLogs() {
    const { logs = [] } = await chrome.storage.local.get(['logs']);
    return logs;
  },
  async clearLogs() {
    await chrome.storage.local.set({ logs: [] });
  }
};

function sanitizeLogDetails(value, key = '') {
  if (value == null) return value;
  if (/^(authorization|connectionToken|google_cookies|session_token|password|secret)$/i.test(key)) {
    return '[REDACTED]';
  }
  if (Array.isArray(value)) return value.map(item => sanitizeLogDetails(item));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitizeLogDetails(v, k)])
    );
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
      .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, email => email[0] + '***@' + email.split('@')[1])
      .replace(/((?:^|[;\s])(?:__Secure-)?(?:OSID|SID|HSID|SSID|APISID|SAPISID)=)[^;\s]+/gi, '$1[REDACTED]');
  }
  return value;
}

function safeServerDiagnostic(raw) {
  const result = {};
  if (['bootstrap', 'rpc'].includes(raw?.phase)) result.phase = raw.phase;
  if (['nzlxg', 'jHPbke'].includes(raw?.rpc)) result.rpc = raw.rpc;
  if (['redirect', 'http_auth', 'missing_metadata'].includes(raw?.reason)) result.reason = raw.reason;
  for (const key of ['http_status', 'rpc_code', 'browser_http_status', 'browser_rpc_code']) {
    if (Number.isInteger(raw?.[key]) && raw[key] >= 0 && raw[key] < 600) result[key] = raw[key];
  }
  for (const key of ['bootstrap_identity', 'xsrf_present', 'account_matches', 'browser_credit_ok', 'observed_cookie_header']) {
    if (typeof raw?.[key] === 'boolean') result[key] = raw[key];
  }
  for (const key of ['rpc_cookie_count', 'duplicate_cookie_names']) {
    if (Number.isInteger(raw?.[key]) && raw[key] >= 0 && raw[key] <= 1000) result[key] = raw[key];
  }
  return result;
}

function validateEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请输入有效的Google账号邮箱');
  return email;
}
function normalizeApiUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('连接接口仅支持 HTTP 或 HTTPS');
  if (!url.pathname || url.pathname === '/') url.pathname = '/api/plugin/update-token';
  url.hash = ''; url.search = ''; return url.toString();
}
function connectionPermission(apiUrl) { const u = new URL(apiUrl); return `${u.protocol}//${u.hostname}/*`; }
function validateConnection(value) {
  const apiUrl = normalizeApiUrl(value.apiUrl);
  const connectionToken = String(value.connectionToken || '').trim();
  if (!connectionToken) throw new Error('连接Token无效');
  return { apiUrl, connectionToken };
}

async function publicState() {
  const state = await chrome.storage.local.get(['config', 'lastSync']);
  const config = state.config || {};
  return {
    configured: Boolean(config.connectionToken),
    connectionToken: config.connectionToken || '',
    loginAccount: config.loginAccount || '',
    apiUrl: config.apiUrl || '',
    sourceTabId: config.sourceTabId ?? null,
    sourceWindowId: config.sourceWindowId ?? null,
    sourceUrl: config.sourceUrl || '',
    autoSync: config.autoSync !== false,
    syncMode: config.syncMode || 'all',
    refreshInterval: config.refreshInterval || 60,
    lastSync: state.lastSync || null
  };
}

async function restoreAlarm() {
  const { config } = await chrome.storage.local.get('config');
  await chrome.alarms.clear(ALARM);
  if (config?.connectionToken && config.autoSync !== false) {
    await chrome.alarms.create(ALARM, { periodInMinutes: config.refreshInterval || 60 });
  }
}

async function saveConfiguration(input) {
  const state = await chrome.storage.local.get('config');
  const source = input.config || input;
  const connection = validateConnection({ apiUrl: source.apiUrl || state.config?.apiUrl, connectionToken: source.connectionToken || state.config?.connectionToken });
  const syncMode = source.syncMode || 'all';
  if (!['all', 'single'].includes(syncMode)) throw new Error('同步模式无效');
  const refreshInterval = Number(source.refreshInterval ?? 60);
  if (!Number.isInteger(refreshInterval) || refreshInterval < 1 || refreshInterval > 1440) throw new Error('刷新间隔必须在1-1440分钟之间');
  const loginAccount = source.loginAccount ? validateEmail(source.loginAccount) : '';
  if (syncMode === 'single' && !loginAccount) throw new Error('单账号模式请先填写邮箱');
  const config = { ...connection, loginAccount, syncMode, refreshInterval, autoSync: source.autoSync !== false,
    sourceTabId: Number.isInteger(source.sourceTabId) ? source.sourceTabId : null,
    sourceWindowId: Number.isInteger(source.sourceWindowId) ? source.sourceWindowId : null,
    sourceUrl: loginAccount ? flowAccountUrl(loginAccount) : '' };
  if (!await chrome.permissions.contains({ origins: [connectionPermission(config.apiUrl)] })) {
    throw new Error('请授权扩展连接本机 GFlow');
  }
  await chrome.storage.local.set({ config });
  await restoreAlarm();
  await Logger.info('GFlow 连接配置已保存', { apiUrl: config.apiUrl, loginAccount: config.loginAccount });
  return publicState();
}

async function waitForTabReady(tabId, maxWaitMs = 15000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === 'complete') return tab;
    } catch (_) {
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

// 扩展重载后，已打开的页面可能没有可用的 content script。
// 仅向声明过权限的 Flow 页面注入固定脚本，不刷新用户页面。
async function sendFlowMessage(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if ((message.action === 'gflow-account-links' && Array.isArray(response?.accounts))
        || (response && typeof response.signed_in === 'boolean')
        || (message.action === 'gflow-credit-check' && typeof response?.success === 'boolean')) return response;
  } catch (_) {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ['flow-session.js'] });
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (!response) throw new Error('无法读取 Flow 页面，请刷新页面后重新扫描');
  return response;
}

function flowAccountUrl(email) {
  const url = new URL(FLOW_URL);
  url.searchParams.set('authuser', validateEmail(email));
  return url.href;
}

// Google 的账号列表接口未公开承诺结构；只读取已知邮箱字段，
// 列表仅表示候选账号，选中后必须由实际 Flow 页面确认身份。
function parseGoogleAccounts(text) {
  const payload = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, ''));
  if (!Array.isArray(payload) || !Array.isArray(payload[1])) return [];
  const emails = [];
  for (const row of payload[1]) {
    if (!Array.isArray(row) || row[0] !== 'gaia.l.a') continue;
    try { emails.push(validateEmail(row[3])); } catch (_) {}
  }
  return [...new Set(emails)];
}

const ACCOUNT_CHOOSER_URL = 'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fflow.google.com%2F';

// 此函数在 Google 账号选择页的隔离环境执行，仅读取账号条目或点击指定邮箱。
function inspectAccountChooser(targetEmail = '') {
  if (location.origin !== 'https://accounts.google.com'
      || !/(?:^|\/)accountchooser(?:\/|$)/i.test(location.pathname)) {
    return { accounts: [], clicked: false, page: 'redirected', entries: 0 };
  }
  const accounts = new Map();
  const entries = document.querySelectorAll('[data-identifier], [data-email], [data-email-address], [data-authuser], [data-profileindex]');
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const element of entries) {
    let email = ['data-identifier', 'data-email', 'data-email-address']
      .map(key => String(element.getAttribute(key) || '').trim().toLowerCase())
      .find(value => emailPattern.test(value));
    if (!email) {
      const text = String(element.textContent || '') + ' ' + String(element.getAttribute('aria-label') || '');
      const matches = [...text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)];
      const emails = [...new Set(matches.map(match => match[0].toLowerCase()))];
      if (emails.length === 1) email = emails[0];
    }
    if (!email || !emailPattern.test(email)) continue;
    if (!accounts.has(email)) accounts.set(email, element);
  }
  if (targetEmail) {
    const element = accounts.get(targetEmail);
    if (element) {
      const control = element.closest('[role="link"], [role="button"], a, button') || element;
      control.click();
      return { accounts: [...accounts.keys()], clicked: true, page: 'chooser', entries: entries.length };
    }
  }
  return { accounts: [...accounts.keys()], clicked: false, page: 'chooser', entries: entries.length };
}

async function readChooser(tabId, email = '') {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: inspectAccountChooser, args: [email] });
  return results?.[0]?.result || { accounts: [], clicked: false, page: 'unreadable', entries: 0 };
}

async function discoverChooserAccounts() {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: ACCOUNT_CHOOSER_URL, active: false });
    if (!await waitForTabReady(tab.id, 30000)) return { emails: [], status: 'timeout', entries: 0 };
    const accounts = new Set();
    let lastGrowth = Date.now();
    let lastResult;
    // 等待账号列表稳定，不能在首个账号渲染后立即关闭页面。
    for (let attempt = 0; attempt < 20; attempt++) {
      lastResult = await readChooser(tab.id);
      const before = accounts.size;
      for (const email of lastResult.accounts || []) {
        try { accounts.add(validateEmail(email)); } catch (_) {}
      }
      if (accounts.size !== before) lastGrowth = Date.now();
      if (lastResult.page === 'redirected') break;
      if (accounts.size && Date.now() - lastGrowth >= 2500) break;
      if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { emails: [...accounts], status: lastResult?.page || 'unreadable', entries: lastResult?.entries || 0 };
  } catch (_) {
    return { emails: [], status: 'unreadable', entries: 0 };
  } finally { await closeTemporaryTab(tab); }
}

async function switchViaChooser(tabId, email) {
  if (!await waitForTabReady(tabId, 30000)) throw new Error('Google 账号选择页加载超时');
  let selected;
  for (let attempt = 0; attempt < 5; attempt++) {
    selected = await readChooser(tabId, email);
    if (selected.clicked) break;
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!selected?.clicked) {
    // 选择页自动跳转或结构不兼容时使用 Google 的账号选择参数，随后仍严格验证邮箱。
    await chrome.tabs.update(tabId, { url: flowAccountUrl(email) });
  }
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && new URL(tab.url || ACCOUNT_CHOOSER_URL).origin === 'https://flow.google.com') return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('账号切换未进入 Flow，可能需要重新登录或完成验证');
}

async function listGoogleAccounts() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', {
      credentials: 'include', cache: 'no-store', signal: controller.signal
    });
    if (!response.ok) throw new Error('账号列表不可用');
    return parseGoogleAccounts(await response.text());
  } finally { clearTimeout(timer); }
}

async function readFlowAccount(tabId) {
  const tab = await waitForTabReady(tabId, 30000);
  if (!tab) throw new Error('Flow 页面加载超时，请稍后重新扫描');
  if (new URL(tab.url || '').origin !== 'https://flow.google.com') {
    throw new Error('Flow 需要登录或授权，请在新打开的页面完成后重新扫描');
  }
  // 页面完成导航后，认证数据可能仍在初始化。
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await sendFlowMessage(tabId, { action: 'gflow-discover-account' });
    if (result?.signed_in && result.email) return { email: validateEmail(result.email), tabId, windowId: tab.windowId, verified: true };
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Flow 页面未提供登录账号，请完成登录后重新扫描');
}

async function selectAccount(email) {
  email = validateEmail(email);
  const tabs = await chrome.tabs.query({ url: ['https://flow.google.com/*'] });
  for (const tab of tabs) {
    try {
      const result = await sendFlowMessage(tab.id, { action: 'gflow-discover-account' });
      if (result?.signed_in && validateEmail(result.email) === email) {
        return { email, tabId: tab.id, windowId: tab.windowId, verified: true };
      }
    } catch (_) {}
  }
  const tab = await chrome.tabs.create({ url: flowAccountUrl(email), active: false });
  const account = await readFlowAccount(tab.id);
  if (account.email !== email) throw new Error('Google 未切换到所选账号，请在 Flow 页面完成账号切换后重试');
  return account;
}

async function executeDiscovery() {
  let tabs = await chrome.tabs.query({ url: ['https://flow.google.com/*'] });
  let openedFlow = false;
  if (!tabs.length) {
    const tab = await chrome.tabs.create({ url: FLOW_URL, active: false });
    tabs = [tab];
    openedFlow = true;
  }
  const chooserPromise = discoverChooserAccounts();
  const listPromise = listGoogleAccounts().then(emails => ({ emails, available: true }), () => ({ emails: [], available: false }));
  const results = await Promise.all(tabs.map(async tab => {
    try {
      const account = await readFlowAccount(tab.id);
      let linked = [];
      try { linked = (await sendFlowMessage(tab.id, { action: 'gflow-account-links' })).accounts || []; } catch (_) {}
      return { account, linked };
    } catch (error) { return { error: error.message }; }
  }));
  const list = await listPromise;
  const chooser = await chooserPromise;
  const chooserEmails = chooser.emails;
  const accounts = new Map([...list.emails, ...chooserEmails].map(email => [email, { email, verified: false }]));
  for (const result of results) {
    for (const linked of result.linked || []) {
      try { const email = validateEmail(linked.email); if (!accounts.has(email)) accounts.set(email, { email, verified: false }); } catch (_) {}
    }
    if (result.account) accounts.set(result.account.email, result.account);
  }
  const response = { ok: true, success: true, accounts: [...accounts.values()], scannedTabs: tabs.length,
    openedFlow, accountListAvailable: list.available, chooserAccountCount: chooserEmails.length,
    diagnostics: { chooserStatus: chooser.status, chooserEntries: chooser.entries, chooserAccounts: chooserEmails.length,
      googleListStatus: list.available ? 'ok' : 'unavailable', googleListAccounts: list.emails.length,
      flowAccounts: results.filter(item => item.account).length },
    unreadableTabs: results.filter(item => item.error).length,
    message: results.find(item => item.error)?.error || '' };
  await chrome.storage.local.set({ accountDiscovery: response });
  await Logger.info('账号扫描来源诊断', response.diagnostics);
  return response;
}

function discoverAccounts() {
  if (!activeDiscovery) activeDiscovery = executeDiscovery().finally(() => { activeDiscovery = null; });
  return activeDiscovery;
}

async function closeTemporaryTab(tab) {
  if (tab && typeof tab.id === 'number') {
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
  }
}

// 监听范围只包含本次临时标签的 nzlxg 请求；Cookie 仅在内存中存在。
async function readObservedFlowCookies(tabId, email) {
  if (!chrome.webRequest?.onBeforeSendHeaders) throw new Error('请重新加载 GFlow 登录助手以启用请求读取权限');
  let cookieHeader='';
  const listener = details => {
    const url=new URL(details.url);
    if (details.tabId !== tabId || details.method !== 'POST' || url.origin !== 'https://flow.google.com'
        || url.pathname !== '/_/AiSandboxAngularFrontend/data/batchexecute' || url.searchParams.get('rpcids') !== 'nzlxg') return;
    cookieHeader=(details.requestHeaders || []).find(header=>header.name.toLowerCase()==='cookie')?.value || '';
  };
  chrome.webRequest.onBeforeSendHeaders.addListener(listener,
    {urls:['https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute*'],tabId}, ['requestHeaders','extraHeaders']);
  try {
    const diagnostic = await sendFlowMessage(tabId, {action:'gflow-credit-check',email});
    // 保留浏览器的真实顺序和同名 Cookie；拒绝空值及报文控制字符。
    if (!cookieHeader || cookieHeader.length > 262144 || /[\x00-\x1f\x7f]/.test(cookieHeader)) {
      throw new Error('Chrome 未提供本次 Flow 请求的 Cookie，请确认扩展管理页已允许新权限后重试');
    }
    const safe = {success:diagnostic?.success === true};
    if (['identity','network','rpc'].includes(diagnostic?.phase)) safe.phase=diagnostic.phase;
    for (const key of ['http_status','rpc_code']) if (Number.isInteger(diagnostic?.[key]) && diagnostic[key]>=0 && diagnostic[key]<600) safe[key]=diagnostic[key];
    return {cookieHeader,diagnostic:safe};
  } finally {
    chrome.webRequest.onBeforeSendHeaders.removeListener(listener);
  }
}

async function executeSync(accountEmail = null, snapshot = null) {
  const { config } = snapshot ? { config: snapshot } : await chrome.storage.local.get('config');
  if (!config) throw new Error('请先从 GFlow 复制配置并保存');
  const connection = validateConnection(config);
  const loginAccount = validateEmail(accountEmail || config.loginAccount);

  await Logger.info('开始同步 GFlow 登录凭据...', { account: loginAccount });

  // 固定本次同步的窗口和 Cookie 存储区，避免后台标签与读取来自不同窗口。
  let sourceTab = null;
  if (Number.isInteger(config.sourceTabId)) {
    try { sourceTab = await chrome.tabs.get(config.sourceTabId); } catch (_) { sourceTab = null; }
    // 页面关闭或浏览器重启后，按已保存的邮箱重新打开并校验身份。
  }
  if (!sourceTab) {
    const sourceTabs = chrome.tabs?.query ? await chrome.tabs.query({ active: true, currentWindow: true }) : [];
    sourceTab = sourceTabs[0];
  }
  let storeId;
  if (sourceTab && chrome.cookies?.getAllCookieStores) {
    const stores = await chrome.cookies.getAllCookieStores();
    storeId = stores.find(item => item.tabIds.includes(sourceTab.id))?.id;
    if (!storeId) throw new Error('无法确定当前窗口的登录态，请在 Flow 所在窗口重新打开助手');
  }
  let tempTab = null;
  let rawCookies, frontend, observed;
  let pageUrl = flowAccountUrl(loginAccount);
  try {
    const current = new URL(sourceTab?.url || '');
    if (current.origin === 'https://flow.google.com') {
      current.searchParams.set('authuser', loginAccount);
      pageUrl = current.href;
    }
  } catch (_) {}
  try {
    if (chrome.tabs?.create && chrome.tabs?.get) {
      await Logger.info('正在后台刷新 Flow 登录态…');
      tempTab = await chrome.tabs.create({ url: accountEmail ? ACCOUNT_CHOOSER_URL : pageUrl, active: false,
        ...(Number.isInteger(sourceTab?.windowId) ? { windowId: sourceTab.windowId } : {}) });
      if (accountEmail) await switchViaChooser(tempTab.id, loginAccount);
      const loadedTab = await waitForTabReady(tempTab.id);
      if (!loadedTab) throw new Error('Flow 页面加载超时，请确认网页可以正常打开后重试');
      if (new URL(loadedTab.url || '').hostname !== 'flow.google.com') {
        throw new Error('Flow 页面要求重新登录，请先在当前浏览器完成登录');
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
      if (chrome.tabs.sendMessage) {
        let session;
        try { session = await sendFlowMessage(tempTab.id, {action:'gflow-page-session',email:loginAccount}); }
        catch (_) { throw new Error('无法读取 Flow 页面登录态，请确认助手已重新加载后重试'); }
        if (!session?.signed_in) throw new Error('Flow 页面没有返回已登录账号，请在当前浏览器重新登录 Flow 后同步');
        if (session.account_matches !== true) throw new Error('Flow 当前账号与助手填写的邮箱不一致，请核对邮箱或使用独立浏览器配置');
        if (!session.frontend) throw new Error('Flow 页面认证字段未加载完整，请刷新 Flow 后重试');
        frontend = session.frontend;
        observed = await readObservedFlowCookies(tempTab.id, loginAccount);
        await Logger.info('Flow 浏览器额度检查完成', observed.diagnostic);
        if (!observed.diagnostic.success) throw new Error('所选账号的 Flow 额度检查未通过，已停止本账号同步');
      }
      // 根据实际预热标签确定存储区；定时同步没有活动标签时也保持一致。
      if (chrome.cookies?.getAllCookieStores) {
        const stores = await chrome.cookies.getAllCookieStores();
        const warmedStore = stores.find(item => item.tabIds.includes(tempTab.id));
        if (!warmedStore || (storeId && storeId !== warmedStore.id)) {
          throw new Error('Flow 页面与当前窗口登录态不一致，请从 Flow 所在窗口同步');
        }
        storeId = warmedStore.id;
      }
    }
    if (!observed) {
      // 兼容没有页面消息 API 的测试/旧浏览器；现用 Chrome 使用实际请求头。
      const scopes = [FLOW_URL, 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute'];
      const groups = [];
      for (const url of scopes) {
        groups.push(await chrome.cookies.getAll({ url, ...(storeId ? { storeId } : {}) }));
      }
      rawCookies = groups.flat();
    }
    const googleCookies = observed?.cookieHeader || serializeFlowCookies(rawCookies);
    await Logger.info('Cookie 提取成功，正在提交至本机 GFlow 内核...');

    const payload = {
      login_account: loginAccount,
      google_cookies: googleCookies,
      protocol_mode: 'protocol'
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    let response;
    try {
      response = await fetch(connection.apiUrl, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + connection.connectionToken
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      const errText = error.name === 'AbortError' ? 'GFlow 同步超时，请检查代理设置后重试' : '无法连接本机 GFlow，请确认 EasyCPA 内核运行中';
      await Logger.error(errText);
      throw new Error(errText);
    } finally {
      clearTimeout(timer);
    }

    let result = null;
    try { result = await response.json(); } catch (_) {}
    if (!response.ok || result?.success !== true) {
      if (response.status === 401 || response.status === 403) {
        await Logger.error('连接凭据失效');
        throw new Error('连接凭据失效，请回到 GFlow 重新复制扩展配置');
      }
      if (response.status === 404) {
        await Logger.error('接口未找到');
        throw new Error('当前 GFlow 版本不支持扩展同步，请更新插件');
      }
      const detail = result?.error;
      const safeMessage = typeof detail?.message === 'string'
        && detail.message.length <= 500
        && !/(cookie\s*[:=]|bearer\s|connectionToken|access_token|https?:\/\/|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i.test(detail.message)
        ? detail.message : null;
      const code = /^gflow_[a-z_]+$/.test(detail?.code || '') ? detail.code : null;
      const errorMsg = safeMessage
        ? safeMessage + (code ? ' [' + code + ']' : '')
        : 'GFlow 同步失败（HTTP ' + response.status + '）。请查看日志获取详细诊断。';
      await Logger.error('同步失败', { error: errorMsg, diagnostic: safeServerDiagnostic(detail?.diagnostic) });
      throw new Error(errorMsg);
    }

    const actionMsg = result.action === 'updated' ? 'GFlow 账号登录态已更新' : 'GFlow 账号已添加';
    await Logger.success(`✅ ${actionMsg}`, { action: result.action });
    return { success: true, action: result.action, message: actionMsg };
  } finally {
    await closeTemporaryTab(tempTab);
  }
}

async function executeBatchSync() {
  const { config } = await chrome.storage.local.get('config');
  if (!config) throw new Error('请先保存服务地址和连接 Token');
  validateConnection(config);
  const discovery = await discoverAccounts();
  if (!discovery.accounts.length) throw new Error(discovery.message || '未发现可切换账号，请在 Flow 完成登录后重试');
  const results = [];
  const batchState = { running: true, total: discovery.accounts.length, completed: 0, currentEmail: '', startedAt: Date.now(), results };
  await chrome.storage.local.set({ batchSync: { ...batchState, startedAt: Date.now() } });
  for (const account of discovery.accounts) {
    batchState.currentEmail = account.email;
    await chrome.storage.local.set({ batchSync: { ...batchState, completed: results.length, results: [...results] } });
    let result;
    try {
      // executeSync 为每个邮箱创建独立临时页面，校验实际身份后才读取请求 Cookie。
      result = await executeSync(account.email, config);
    } catch (error) { result = { success: false, message: error.message }; }
    results.push({ email: account.email, success: result.success, message: result.message });
    await chrome.storage.local.set({ batchSync: { ...batchState, completed: results.length, results: [...results] } });
  }
  const succeeded = results.filter(item => item.success).length;
  await chrome.storage.local.set({ batchSync: { ...batchState, running: false, currentEmail: '', completed: results.length, results, finishedAt: Date.now() } });
  return { success: succeeded === results.length, results,
    message: `共 ${results.length} 个账号，成功 ${succeeded} 个，失败 ${results.length - succeeded} 个` };
}

function syncNow(allAccounts = null) {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    let result;
    try {
      const { config } = await chrome.storage.local.get('config');
      const batch = allAccounts ?? (config?.syncMode !== 'single');
      result = await (batch ? executeBatchSync() : executeSync());
    } catch (error) {
      result = { success: false, message: error.message };
    }
    await chrome.storage.local.set({
      lastSync: { success: result.success, message: result.message, timestamp: Date.now() }
    });
    if (chrome.action?.setBadgeText) {
      await chrome.action.setBadgeText({ text: result.success ? 'OK' : '!' });
      await chrome.action.setBadgeBackgroundColor({ color: result.success ? '#0d9488' : '#dc2626' });
    }
    return result;
  })().finally(() => { activeSync = null; });
  return activeSync;
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  const action = request.action;
  if (action === 'selectAccount') {
    selectAccount(request.email).then(account => respond({ success: true, account }),
      error => respond({ success: false, error: error.message }));
    return true;
  }
  if (action === 'discoverAccounts') {
    discoverAccounts().then(respond, error => respond({ ok: false, success: false, error: error.message }));
    return true;
  }
  if (action === 'state' || action === 'getConfig') {
    publicState().then(result => respond({ ok: true, success: true, result, config: result }), () => respond({ ok: false, success: false }));
    return true;
  }
  if (action === 'save' || action === 'saveConfig') {
    saveConfiguration(request.config).then(result => respond({ ok: true, success: true, result, config: result }), e => respond({ ok: false, success: false, message: e.message, error: e.message }));
    return true;
  }
  if (action === 'syncAll') {
    syncNow(true).then(result => respond(result), error => respond({ success: false, message: error.message }));
    return true;
  }
  if (action === 'sync' || action === 'testNow') {
    syncNow().then(result => respond({ ok: true, success: result.success, result, ...result }), e => respond({ ok: false, success: false, message: e.message, error: e.message }));
    return true;
  }
  if (action === 'forget') {
    chrome.storage.local.remove(['config', 'lastSync'])
      .then(restoreAlarm)
      .then(publicState)
      .then(result => respond({ ok: true, result }), () => respond({ ok: false }));
    return true;
  }
  if (action === 'getLogs') {
    Logger.getLogs().then(logs => respond({ ok: true, success: true, logs }), () => respond({ ok: false, logs: [] }));
    return true;
  }
  if (action === 'clearLogs') {
    Logger.clearLogs().then(() => respond({ ok: true, success: true }), () => respond({ ok: false }));
    return true;
  }
  return false;
});

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void syncNow(); });
}
if (chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => { void restoreAlarm(); });
}
if (chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => { void restoreAlarm(); });
}