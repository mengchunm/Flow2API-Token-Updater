// popup.js - Chrome扩展配置界面脚本

let statusTimer = null;
let approvedInsecureOrigin = '';
let selectedAccountBinding = null;

let discoveredAccounts = [];

function renderAccounts(response) {
    discoveredAccounts = Array.from(new Map((response.accounts || [])
        .filter(account => account && account.email)
        .map(account => [account.email, account])).values());
    const select = document.getElementById('accountSelect');
    const previous = select.value || document.getElementById('loginAccount').value.trim().toLowerCase();
    select.innerHTML = '<option value="">请选择账号</option>';
    for (const account of discoveredAccounts) {
        const option = document.createElement('option');
        option.value = account.email;
        option.textContent = account.email + (account.verified ? ' · Flow 已确认' : ' · 切换后验证');
        select.appendChild(option);
    }
    // 更新列表不自动触发切换，也不覆盖用户已经保存的页面绑定。
    select.value = discoveredAccounts.some(account => account.email === previous) ? previous : '';
    const count = document.getElementById('accountCount');
    if (count) count.textContent = `已发现 ${discoveredAccounts.length} 个账号（其中 ${discoveredAccounts.filter(account => account.verified).length} 个 Flow 已确认）`;
    return discoveredAccounts;
}

function handleStorageChanges(changes, area) {
    if (area === 'local' && changes.accountDiscovery) {
        renderAccounts(changes.accountDiscovery.newValue || { accounts: [] });
    }
}

async function chooseAccount(email) {
    selectedAccountBinding = null;
    const response = await sendMessage({ action: 'selectAccount', email });
    if (!response?.success) throw new Error(response?.error || '账号切换失败');
    const account = response.account;
    if (account.email !== email) throw new Error('Flow 账号验证不一致，请重试');
    selectedAccountBinding = { sourceTabId: account.tabId, sourceWindowId: account.windowId };
    document.getElementById('loginAccount').value = account.email;
    document.getElementById('accountSelect').value = account.email;
}

async function discoverAccounts() {
    const response = await sendMessage({ action: 'discoverAccounts' });
    if (!response?.success) throw new Error(response?.error || '账号扫描失败');
    const accounts = renderAccounts(response);
    if (!accounts.length) throw new Error(response.message || '已自动打开 Flow，请完成登录后重新扫描。');
    const current = document.getElementById('loginAccount').value.trim().toLowerCase();
    const selected = accounts.find(account => account.email === current)
        || accounts.find(account => account.verified) || accounts[0];
    await chooseAccount(selected.email);
    return accounts;
}

function sendMessage(request) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(request, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });
}

function normalizeApiUrl(value) {
    let url;
    try {
        url = new URL(String(value || '').trim());
    } catch (error) {
        throw new Error('连接接口格式无效');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('连接接口仅支持 HTTP 或 HTTPS');
    }
    if (url.username || url.password) {
        throw new Error('连接接口中不能包含用户名或密码');
    }
    url.hash = '';
    url.search = '';
    if (!url.pathname || url.pathname === '/') {
        url.pathname = '/api/plugin/update-token';
    }
    return url.toString();
}

function insecureRemoteOrigin(value) {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '[::1]';
    return url.protocol === 'http:' && !loopback ? url.origin : '';
}

function getFormConfig() {
    const apiUrl = normalizeApiUrl(document.getElementById('apiUrl').value);
    const connectionToken = document.getElementById('connectionToken').value.trim();
    const loginAccount = document.getElementById('loginAccount').value.trim().toLowerCase();
    const refreshInterval = Number.parseInt(
        document.getElementById('refreshInterval').value,
        10
    );

    if (!connectionToken) {
        throw new Error('请输入连接Token');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginAccount)) {
        throw new Error('请输入有效的Google账号邮箱');
    }
    if (!Number.isInteger(refreshInterval) || refreshInterval < 1 || refreshInterval > 1440) {
        throw new Error('刷新间隔必须在1-1440分钟之间');
    }

    return { apiUrl, connectionToken, loginAccount, refreshInterval, sourceTabId: selectedAccountBinding?.sourceTabId ?? null, sourceWindowId: selectedAccountBinding?.sourceWindowId ?? null };
}

function setBusy(busy) {
    document.getElementById('syncAllBtn').disabled = busy;
    document.getElementById('saveBtn').disabled = busy;
    document.getElementById('testBtn').disabled = busy;
    document.getElementById('discoverBtn').disabled = busy;
    document.getElementById('accountSelect').disabled = busy;
}

function renderLastSync(lastSync) {
    const state = document.getElementById('lastSync');
    if (!lastSync || !lastSync.timestamp) {
        state.textContent = '尚未执行同步';
        state.className = 'sync-state';
        return;
    }
    const date = new Date(lastSync.timestamp);
    const time = Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN');
    state.textContent = `${lastSync.success ? '最近同步成功' : '最近同步失败'} · ${time}\n${lastSync.message || ''}`.trim();
    state.className = `sync-state ${lastSync.success ? 'success' : 'error'}`;
}

async function requestApiPermission(apiUrl) {
    const url = new URL(apiUrl);
    const originPattern = `${url.protocol}//${url.hostname}/*`;
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) {
        throw new Error('需要授权访问Flow2API服务地址');
    }
}

async function saveCurrentConfig() {
    const config = getFormConfig();
    const insecureOrigin = insecureRemoteOrigin(config.apiUrl);
    if (insecureOrigin && approvedInsecureOrigin !== insecureOrigin) {
        const approved = confirm(
            '该地址使用非本机 HTTP 连接，Google 登录 Cookie 和连接 Token 将以明文传输。建议先为 Flow2API 配置 HTTPS。\n\n确定仍要使用该地址吗？'
        );
        if (!approved) {
            throw new Error('已取消保存，请改用HTTPS地址');
        }
    }
    approvedInsecureOrigin = insecureOrigin;
    config.insecureHttpOrigin = insecureOrigin;
    await requestApiPermission(config.apiUrl);
    const response = await sendMessage({ action: 'saveConfig', config });
    if (!response || !response.success) {
        throw new Error(response && response.error || '配置保存失败');
    }
    document.getElementById('apiUrl').value = response.config.apiUrl;
    document.getElementById('loginAccount').value = response.config.loginAccount;
    return response.config;
}

async function loadConfig() {
    const response = await sendMessage({ action: 'getConfig' });
    if (!response || !response.success) {
        throw new Error(response && response.error || '配置读取失败');
    }
    const config = response.config || {};
    document.getElementById('apiUrl').value = config.apiUrl || '';
    document.getElementById('connectionToken').value = config.connectionToken || '';
    document.getElementById('loginAccount').value = config.loginAccount || '';
    selectedAccountBinding = Number.isInteger(config.sourceTabId) ? { sourceTabId: config.sourceTabId, sourceWindowId: config.sourceWindowId } : null;
    document.getElementById('refreshInterval').value = config.refreshInterval || 60;
    approvedInsecureOrigin = response.config.insecureHttpOrigin || '';
    renderLastSync(config.lastSync);
}

document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('discoverBtn').addEventListener('click', async () => {
        setBusy(true);
        showStatus('正在检测账号，必要时自动打开 Flow，请稍候…', 'info', false);
        try {
            const accounts = await discoverAccounts();
            showStatus(`已发现 ${accounts.length} 个 Flow 账号，请选择后保存配置`, 'success');
        } catch (e) { showStatus(e.message, 'error', false); }
        finally { setBusy(false); }
    });
    document.getElementById('loginAccount').addEventListener('input', () => {
        selectedAccountBinding = null;
        document.getElementById('accountSelect').value = '';
    });
    document.getElementById('accountSelect').addEventListener('change', async e => {
        const email = e.target.value;
        if (!email) return;
        setBusy(true);
        showStatus('正在打开并验证所选 Flow 账号…', 'info', false);
        try {
            await chooseAccount(email);
            showStatus('已切换并确认账号，保存配置后用于同步', 'success');
        } catch (error) { showStatus(error.message, 'error', false); }
        finally { setBusy(false); }
    });
    try {
        await loadConfig();
        const { accountDiscovery } = await chrome.storage.local.get('accountDiscovery');
        if (!discoveredAccounts.length && accountDiscovery?.accounts?.length) {
            renderAccounts(accountDiscovery);
            document.getElementById('accountSelect').value = document.getElementById('loginAccount').value;
        }
    } catch (error) {
        showStatus(`配置读取失败：${error.message}`, 'error', false);
    }

    document.getElementById('saveBtn').addEventListener('click', async () => {
        setBusy(true);
        showStatus('正在保存配置...', 'info', false);
        try {
            await saveCurrentConfig();
            showStatus('配置保存成功', 'success');
        } catch (error) {
            showStatus(error.message, 'error', false);
        } finally {
            setBusy(false);
        }
    });

    document.getElementById('testBtn').addEventListener('click', async () => {
        setBusy(true);
        showStatus('正在保存配置并同步登录态...', 'info', false);
        try {
            await saveCurrentConfig();
            const response = await sendMessage({ action: 'testNow' });
            if (!response || !response.success) {
                throw new Error(response && response.error || '同步失败');
            }
            const actionText = response.action === 'added' ? '已添加账号' : '已更新账号';
            showStatus(`同步成功：${actionText}\n${response.message || ''}`.trim(), 'success', false);
            renderLastSync({
                timestamp: new Date().toISOString(),
                success: true,
                message: response.message || actionText
            });
        } catch (error) {
            showStatus(`同步失败：${error.message}`, 'error', false);
            renderLastSync({
                timestamp: new Date().toISOString(),
                success: false,
                message: error.message
            });
        } finally {
            setBusy(false);
        }
    });

    document.getElementById('syncAllBtn').addEventListener('click', async () => {
        setBusy(true);
        showStatus('正在自动发现账号并逐个切换、提取和同步，关闭弹窗后任务仍会继续…', 'info', false);
        try {
            // 未填写邮箱时先识别当前 Flow 身份，用户无需手动选择。
            if (!document.getElementById('loginAccount').value.trim()) await discoverAccounts();
            await saveCurrentConfig();
            const result = await sendMessage({ action: 'syncAll' });
            showStatus(result?.message || '批量任务结束', result?.success ? 'success' : 'error', false);
        } catch (error) { showStatus(error.message, 'error', false); }
        finally { setBusy(false); }
    });
    function renderBatch(batch) {
        const element = document.getElementById('batchState');
        if (!batch) return;
        element.style.display = 'block';
        element.textContent = `${batch.running ? '正在逐账号提取' : '批量提取完成'}：${batch.completed}/${batch.total}
`
            + (batch.results || []).map(item => `${item.success ? '成功' : '失败'} · ${item.email} · ${item.message}`).join('\n');
    }
    chrome.storage.local.get('batchSync').then(state => renderBatch(state.batchSync));
    chrome.storage.onChanged.addListener(handleStorageChanges);
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.batchSync) renderBatch(changes.batchSync.newValue);
    });

    document.getElementById('logsBtn').addEventListener('click', () => {
        window.location.href = 'logs.html';
    });
});

function showStatus(message, type, autoHide = true) {
    const statusEl = document.getElementById('status');
    if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
    }
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.style.display = 'block';

    if (autoHide) {
        statusTimer = setTimeout(() => {
            statusEl.style.display = 'none';
            statusTimer = null;
        }, 5000);
    }
}
