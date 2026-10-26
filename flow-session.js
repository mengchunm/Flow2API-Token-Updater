// 重复注入时只注册一次；支持扩展更新后恢复已打开页面的消息处理。
(() => {
if (globalThis.__gflowSessionListenerInstalled) return;
globalThis.__gflowSessionListenerInstalled = true;

// 只读取 Google Flow 已加载的认证字段，不执行创作，不读取其他网站。
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !['gflow-discover-account', 'gflow-page-session', 'gflow-credit-check'].includes(request.action)) return false;
  const source = Array.from(document.scripts).map(script => script.textContent || '').join('\n');
  function jsonString(key) {
    const pattern = new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")');
    const match = source.match(pattern);
    try { return match ? JSON.parse(match[1]) : ''; } catch (_) { return ''; }
  }
  const email = jsonString('oPEP7c');
  const at = jsonString('SNlM0e');
  const sid = jsonString('FdrFJe');
  const bl = source.match(/boq_labs-ai-sandbox-frontend_[A-Za-z0-9_.-]+/)?.[0] || '';
  const signedIn = typeof email === 'string' && email.includes('@');
  if (request.action === 'gflow-discover-account') { respond({ signed_in: signedIn, email: signedIn ? email.trim().toLowerCase() : '' }); return false; }
  const matches = signedIn && email.trim().toLowerCase() === String(request.email || '').trim().toLowerCase();
  // 认证参数只回传给本扩展并提交到用户配对的本机接口，不写入日志或存储。
  if (request.action === 'gflow-credit-check') {
    if (!matches || !at || !sid || !bl) { respond({success:false, phase:'identity'}); return false; }
    checkFlowCredits({at,sid,bl}).then(respond, () => respond({success:false,phase:'network'}));
    return true;
  }
  respond({signed_in:signedIn, account_matches:matches,
    ...(matches && at && sid && bl ? {frontend:{at,sid,bl,source_path:location.pathname}} : {})});
  return false;
});

// 固定为只读额度 RPC，不接受任意 URL、方法或业务参数。
async function checkFlowCredits({at,sid,bl}) {
  const url = new URL('/_/AiSandboxAngularFrontend/data/batchexecute', 'https://flow.google.com');
  url.search = new URLSearchParams({rpcids:'nzlxg', 'source-path':location.pathname,
    bl,'f.sid':sid,hl:'en',_reqid:String(Math.floor(Math.random()*80000)+10000),rt:'c'});
  const authuser = new URL(location.href).searchParams.get('authuser');
  if (authuser) url.searchParams.set('authuser', authuser);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url.href, {method:'POST',credentials:'include',redirect:'error',cache:'no-store',
      headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','x-same-domain':'1'},
      body:new URLSearchParams({'f.req':JSON.stringify([[['nzlxg','[]',null,'generic']]]),at}).toString(),
      signal:controller.signal});
    const text = await response.text();
    const diagnostic = {success:false,phase:'rpc',http_status:response.status};
    for (const line of text.split('\n')) {
      let frame;
      try { frame=JSON.parse(line.trim()); } catch (_) { continue; }
      if (!Array.isArray(frame)) continue;
      for (const item of frame) {
        if (!Array.isArray(item)) continue;
        if (item[0] === 'er') {
          const code=item[5] ?? item[6];
          if (Number.isInteger(code) && code >= 0 && code < 600) diagnostic.rpc_code=code;
          return diagnostic;
        }
        if (item[0] === 'wrb.fr' && item[1] === 'nzlxg' && typeof item[2] === 'string') {
          let payload;
          try {payload=JSON.parse(item[2]);} catch (_) {continue;}
          if (response.ok && Array.isArray(payload) && payload.some(value=>typeof value==='number' && Number.isFinite(value))) {
            return {...diagnostic,success:true};
          }
        }
      }
    }
    return diagnostic;
  } finally { clearTimeout(timer); }
}

})();
