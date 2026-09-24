// ==UserScript==
// @name         Arena 账号切换（Arena Native Suite 配套）
// @namespace    local.amp.native.accounts
// @version      1.0.16
// @description  在 Arena 个人卡片里一键切换已保存的账号；显示各账号最近记录的额度
// @match        https://arena.ai/*
// @include      https://arena.ai/*
// @run-at       document-idle
// @grant        GM_cookie
// @grant        GM.cookie
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @noframes
// @downloadURL  https://raw.githubusercontent.com/755287249/-/main/Arena-Account-Switch.user.js
// @updateURL    https://raw.githubusercontent.com/755287249/-/main/Arena-Account-Switch.user.js
// ==/UserScript==

(function arenaAccountSwitch() {
  'use strict';
  const VERSION = '1.0.16';
  const ORIGIN = 'https://' + location.host;
  const AUTH_RE = /^arena-auth-prod-v1(\.\d+)?$/;
  const STORE = 'accounts.v2', OLD_STORE = 'accounts.v1'; // v2：按邮箱去重；旧版本标签页只会写 v1，不再污染
  const PENDING = 'amp.accounts.pending';
  const EARTH = '#6a5e54', EARTH_DARK = '#d8d3ca';
  const MIRROR = ['amp.lite.v2.usd', 'amp.lite.v2.balance', 'amp.lite.v2.pulse', 'amp.lite.v2.quota', 'amp.lite.v2.history']; // 主脚本的额度缓存，随账号切换
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const log = (...a) => console.info('[Arena 账号切换]', ...a);

  // ---------------- 存储 ----------------
  const BAD_NAME = /^(切换账号|选择账号登录|账号|添加账号|其他账号|当前)$/;
  const emailKey = a => String(a?.email || '').trim().toLowerCase();
  // 只保留有邮箱的真实账号；同邮箱合并（凭据取最近保存的那条，额度/缓存取较新的）
  function sanitize(list) {
    const by = new Map();
    for (const a of Array.isArray(list) ? list : []) {
      const k = emailKey(a); if (!k || !/@/.test(k)) continue;
      const x = { ...a }; if (x.name && BAD_NAME.test(String(x.name).trim())) delete x.name;
      const o = by.get(k);
      if (!o) { by.set(k, x); continue; }
      const [n, old] = (x.savedAt || 0) >= (o.savedAt || 0) ? [x, o] : [o, x];
      const qa = (q => Math.max(q?.creditsAt || 0, q?.usdAt || 0, q?.pulseAt || 0, q?.blockedAt || 0));
      by.set(k, { ...old, ...n, name: n.name || old.name, avatar: n.avatar || old.avatar, addedAt: (m => Number.isFinite(m) ? m : Date.now())(Math.min(o.addedAt || Infinity, x.addedAt || Infinity)),
        quota: qa(n.quota) >= qa(old.quota) ? n.quota : old.quota, mirror: n.mirror || old.mirror, pw: n.pw || old.pw });
    }
    return [...by.values()];
  }
  const load = () => { try { let v = GM_getValue(STORE, null); if (!Array.isArray(v)) { v = GM_getValue(OLD_STORE, []); } return sanitize(v); } catch { return []; } };
  const save = list => { try { GM_setValue(STORE, list); } catch (e) { log('保存失败', e); } };
  let accounts = load(), currentId = null, cookieMode = 'unknown', lastError = '';
  save(accounts);
  // 每次修改都先读最新存储再写回，多个标签页不会互相覆盖
  function mutate(fn) { accounts = load(); const r = fn(accounts); accounts = sanitize(accounts); save(accounts); return r; }
  const find = key => accounts.find(a => emailKey(a) === key) || null;
  try { GM_addValueChangeListener(STORE, (name, oldV, newV, remote) => { if (remote) accounts = sanitize(newV); }); } catch {}

  // ---------------- Cookie ----------------
  const gmCookie = typeof GM_cookie !== 'undefined' ? GM_cookie : null;
  function listCookies() {
    return new Promise(resolve => {
      if (gmCookie?.list) {
        try {
          gmCookie.list({ url: ORIGIN + '/' }, (cookies, error) => {
            if (error || !Array.isArray(cookies)) { cookieMode = 'gm-error'; lastError = String(error || '无结果'); resolve(docCookies()); return; }
            cookieMode = 'gm'; resolve(cookies);
          });
          return;
        } catch (e) { lastError = String(e?.message || e); }
      }
      resolve(docCookies());
    });
  }
  function docCookies() {
    const out = [];
    for (const part of document.cookie.split(/;\s*/)) { const i = part.indexOf('='); if (i > 0) out.push({ name: part.slice(0, i), value: part.slice(i + 1), path: '/', secure: true, httpOnly: false, hostOnly: true, fromDocument: true }); }
    if (cookieMode === 'unknown') cookieMode = 'document';
    return out;
  }
  const authOf = cookies => cookies.filter(c => AUTH_RE.test(c.name)).sort((a, b) => (+(a.name.split('.')[1] || -1)) - (+(b.name.split('.')[1] || -1)));
  function delCookie(c) {
    return new Promise(resolve => {
      if (c.fromDocument || !gmCookie?.delete) {
        const dom = c.hostOnly || !c.domain ? '' : '; domain=' + c.domain;
        document.cookie = c.name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=' + (c.path || '/') + dom; resolve(); return;
      }
      gmCookie.delete({ url: ORIGIN + (c.path || '/'), name: c.name }, () => resolve());
    });
  }
  function setCookie(c) {
    return new Promise(resolve => {
      const exp = c.expirationDate && c.expirationDate > Date.now() / 1000 + 3600 ? c.expirationDate : Math.floor(Date.now() / 1000) + 400 * 86400;
      if (c.fromDocument || !gmCookie?.set) {
        const dom = c.hostOnly || !c.domain ? '' : '; domain=' + c.domain;
        document.cookie = c.name + '=' + c.value + '; path=' + (c.path || '/') + dom + '; expires=' + new Date(exp * 1000).toUTCString() + '; secure; samesite=lax'; resolve(null); return;
      }
      const d = { url: ORIGIN + (c.path || '/'), name: c.name, value: c.value, path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly, expirationDate: exp };
      if (!c.hostOnly && c.domain) d.domain = c.domain;
      if (/^(lax|strict)$/i.test(c.sameSite || '')) d.sameSite = c.sameSite.toLowerCase();
      gmCookie.set(d, err => {
        if (!err) { resolve(null); return; }
        delete d.sameSite; gmCookie.set(d, err2 => resolve(err2 || null));
      });
    });
  }

  // ---------------- 身份 ----------------
  function b64(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); }
  function decodeSession(auth) {
    try {
      let v = auth.map(c => c.value).join('');
      try { v = decodeURIComponent(v); } catch {}
      if (v.startsWith('base64-')) v = b64(v.slice(7));
      let j = null; try { j = JSON.parse(v); } catch {}
      if (Array.isArray(j)) j = { access_token: j[0], refresh_token: j[1] };
      const at = j?.access_token || (/^eyJ/.test(v) ? v : null);
      let claims = null; if (at) { try { claims = JSON.parse(b64(at.split('.')[1])); } catch {} }
      const user = j?.user || {};
      return { anonymous: user.is_anonymous === true || claims?.is_anonymous === true, id: user.id || claims?.sub || null, email: user.email || claims?.email || null, name: user.user_metadata?.full_name || user.user_metadata?.name || null, avatar: user.user_metadata?.avatar_url || null, exp: j?.expires_at || claims?.exp || null };
    } catch { return {}; }
  }
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function domIdentity() {
    let email = null, avatar = null, name = null;
    const dlg = profileDialog();
    if (dlg) {
      email = [...dlg.querySelectorAll('*')].filter(e => !e.closest('[data-amp-panel]')).map(e => e.childElementCount === 0 ? (e.textContent || '').trim() : '').find(t => EMAIL.test(t)) || null;
      avatar = [...dlg.querySelectorAll('img')].find(i => !i.closest('[data-amp-panel]'))?.src || null;
      const h = [...dlg.querySelectorAll('h1,h2,h3,p,span,div')].find(e => e.childElementCount === 0 && (e.textContent || '').trim() && !EMAIL.test(e.textContent.trim()) && !e.closest('button,[data-amp-panel],[data-amp-switch]') && !BAD_NAME.test(e.textContent.trim()) && Number(getComputedStyle(e).fontWeight) >= 600);
      name = h ? h.textContent.trim() : null;
    }
    if (!email) {
      for (const b of document.querySelectorAll('aside button, nav button, [data-sidebar] button, button')) {
        const t = (b.innerText || '').trim(); if (EMAIL.test(t)) { email = t; avatar = avatar || b.querySelector('img')?.src || null; break; }
      }
    }
    return { email, avatar, name };
  }

  // ---------------- 额度 ----------------
  const readLS = k => { try { return JSON.parse(W.localStorage.getItem(k) || 'null'); } catch { return null; } };
  function quotaFromCache() {
    const usd = readLS('amp.lite.v2.usd'), bal = readLS('amp.lite.v2.balance'), pulse = readLS('amp.lite.v2.pulse');
    const q = {};
    if (usd && Number.isFinite(usd.balanceRemainingUsd)) { q.usd = usd.balanceRemainingUsd; q.allowance = usd.allowanceUsd; q.usdAt = usd.at || usd.spanAt || null; }
    if (bal && Number.isFinite(bal.remaining)) { q.credits = bal.remaining; q.daily = bal.daily; q.creditsAt = bal.at || null; }
    if (pulse && typeof pulse === 'object') { const v = Number.isFinite(pulse.pulse) ? pulse.pulse : pulse.value; if (Number.isFinite(v)) { q.pulse = v; q.pulseAt = pulse.checkedAt || pulse.at || null; } }
    // 主脚本记录的新会话/消息限流（如 daily usage limit）：限流中即视为无额度
    const lim = readLS('amp.lite.v2.quota');
    if (lim && typeof lim === 'object') {
      const now = Date.now(); let until = 0, at = 0, why = '';
      for (const k of ['chat', 'append']) {
        const x = lim[k]; if (!x || x.blocked !== true) continue;
        const u = Number.isFinite(x.resetAt) && x.resetAt > 0 ? x.resetAt : (x.at || now) + 3600000;
        if (u > now && u > until) { until = u; why = x.reason || (k === 'chat' ? '新会话限流' : '消息限流'); }
        at = Math.max(at, x.at || now);
      }
      q.blockedUntil = until; q.blockReason = until ? why : ''; q.blockedAt = at || now;
    }
    return q;
  }
  async function livePulse() {
    try {
      const res = await fetch(ORIGIN + '/api/me/pulse', { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!res.ok) return null; const j = await res.json();
      return Number.isInteger(j?.pulse) && j.pulse >= 0 && j.pulse <= 100 ? { pulse: j.pulse, pulseAt: Date.now() } : null;
    } catch { return null; }
  }
  async function liveCredits() {
    const [p, c] = await Promise.all([livePulse(), liveCredits0()]);
    return p || c ? { ...(c || {}), ...(p || {}), live: true } : null;
  }
  async function liveCredits0() {
    try {
      const res = await fetch(ORIGIN + '/api/billing/balance', { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!res.ok) return null; const j = await res.json();
      const r = Number(j?.creditsRemaining); if (!Number.isFinite(r)) return null;
      return { credits: r, daily: Number.isFinite(Number(j?.dailyFreeCredits)) ? Number(j.dailyFreeCredits) : null, creditsAt: Date.now(), live: true };
    } catch { return null; }
  }

  // ---------------- 账号记录 ----------------
  const keyOf = emailKey;
  function upsert(rec) {
    const k = keyOf(rec); if (!k) return null;
    if (rec.name && BAD_NAME.test(String(rec.name).trim())) rec.name = null;
    mutate(list => {
      let a = list.find(x => keyOf(x) === k);
      if (!a) { a = { addedAt: Date.now() }; list.push(a); }
      for (const [key, v] of Object.entries(rec)) if (v !== null && v !== undefined && v !== '') a[key] = key === 'quota' ? { ...(a.quota || {}), ...v } : v;
      a.invalid = false;
    });
    return find(k);
  }
  // 读取当前登录 Cookie 并写回当前账号（Arena 会轮换令牌，所以每次都要刷新保存的值）
  async function syncCurrent() {
    const cookies = await listCookies(), auth = authOf(cookies);
    if (!auth.length) { currentId = null; if (domIdentity().email) cookieMode = cookieMode === 'gm' ? 'hidden' : cookieMode === 'document' ? 'hidden' : cookieMode; return null; }
    const s = decodeSession(auth), d = domIdentity();
    // 匿名会话（退出登录后 Arena 给的空白身份）不是账号，不记录
    if (s.anonymous) { currentId = null; return null; }
    const email = s.email || d.email; if (!email) { currentId = null; return null; }
    const a = upsert({ id: s.id, email, name: d.name || s.name, avatar: d.avatar || s.avatar, cookies: auth.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, hostOnly: c.hostOnly, sameSite: c.sameSite, expirationDate: c.expirationDate, fromDocument: !!c.fromDocument })), exp: s.exp, savedAt: Date.now(), quota: quotaFromCache() });
    currentId = a ? keyOf(a) : null; return a;
  }
  function mirrorOut(a) { if (!a) return; const m = {}; for (const k of MIRROR) { try { const v = W.localStorage.getItem(k); if (v !== null) m[k] = v; } catch {} } const key = keyOf(a); mutate(list => { const x = list.find(y => keyOf(y) === key); if (x) x.mirror = m; }); }
  const markDirty = () => { try { W.localStorage.setItem('amp.account.dirty', String(Date.now())); } catch {} };
  function mirrorIn(a) { for (const k of MIRROR) { try { const v = a?.mirror?.[k]; if (typeof v === 'string') W.localStorage.setItem(k, v); else W.localStorage.removeItem(k); } catch {} } }

  // true = 服务端确认是这个账号；false = 确认失效/变成匿名；null = 无法判断（网络问题）
  async function meNow() {
    try {
      const r = await fetch(ORIGIN + '/api/me', { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (r.status === 401 || r.status === 403) return { bad: true };
      if (!r.ok) return null;
      return { user: (await r.json())?.user || null };
    } catch { return null; }
  }
  async function verifySession(target) {
    const judge = m => {
      if (!m) return null; if (m.bad) return false;
      const u = m.user; if (!u || !u.id || u.isAnonymous === true || u.is_anonymous === true) return false;
      const te = (target.email || '').toLowerCase(), ue = String(u.email || '').toLowerCase();
      if (te && ue) return te === ue; if (te && !ue) return target.id ? String(u.id) === String(target.id) : null;
      return target.id ? String(u.id) === String(target.id) : true;
    };
    let v = judge(await meNow());
    if (v === true) return true;
    // 访问令牌过期时先让 Arena 中间件用刷新令牌续期（会 Set-Cookie），再查一次
    try { await fetch(ORIGIN + '/agent', { credentials: 'include', cache: 'no-store', redirect: 'follow' }); } catch {}
    const v2 = judge(await meNow());
    return v2 === null ? v : v2;
  }
  async function switchTo(target) {
    const cur = await syncCurrent(); mirrorOut(cur);
    target = load().find(a => keyOf(a) === keyOf(target)) || target;
    if (!target.cookies?.length) { toast('这个账号没有保存登录凭据，请点 + 重新登录'); return; }
    const now = authOf(await listCookies());
    for (const c of now) await delCookie(c);
    for (const c of target.cookies) { const err = await setCookie(c); if (err) { toast('写入 Cookie 失败：' + err); return; } }
    const check = authOf(await listCookies());
    if (check.map(c => c.value).join('') !== target.cookies.map(c => c.value).join('')) { toast('无法写入登录 Cookie（需要 Tampermonkey 的 Cookie 权限，见面板说明），未切换'); return; }
    // 刷新页面前先确认这个登录凭据服务端还认：失效的话 Arena 会退回匿名并报 “Connecting to Arena has failed”
    toast('正在验证 ' + (target.email || '账号') + ' …');
    const ok = await verifySession(target);
    if (ok === false && target.pw && target.email) {
      // 令牌失效但记有密码：恢复原账号 Cookie 后用备忘密码重新登录
      for (const c of authOf(await listCookies())) await delCookie(c);
      for (const c of now) await setCookie(c);
      toast('登录已失效，正在用备忘的密码重新登录 ' + target.email + ' …');
      const r = await signInEmail(target.email, target.pw, { remember: true });
      if (r.rec) {
        mirrorIn({ ...target, ...r.rec }); markDirty();
        window.addEventListener('pagehide', () => mirrorIn({ ...target, ...r.rec }), { once: true });
        try { sessionStorage.setItem(PENDING, JSON.stringify({ key: keyOf(r.rec), prev: cur ? keyOf(cur) : null, at: Date.now() })); } catch {}
        toast('已重新登录 ' + target.email + '，正在切换…');
        setTimeout(() => { if (/^\/agent\/?$/.test(location.pathname)) location.reload(); else location.href = ORIGIN + '/agent'; }, 350);
        return true;
      }
      mutate(list => { const x = list.find(y => keyOf(y) === keyOf(target)); if (x) x.invalid = true; });
      toast('自动重新登录失败：' + r.error + (r.wrong ? '（备忘的密码可能已改，请在切换界面更新）' : ''));
      return false;
    }
    if (ok === false) {
      for (const c of authOf(await listCookies())) await delCookie(c);
      for (const c of now) await setCookie(c);
      mutate(list => { const x = list.find(y => keyOf(y) === keyOf(target)); if (x) x.invalid = true; });
      toast((target.email || '该账号') + ' 的登录已失效（令牌已被注销或过期），已保持当前账号。请输入密码重新登录');
      closeSwitcher(); openLoginForm(cur, { email: target.email, note: '该账号登录已失效，请重新输入密码' });
      return false;
    }
    if (ok) {
      const fresh = authOf(await listCookies());
      mutate(list => { const x = list.find(y => keyOf(y) === keyOf(target)); if (x) { delete x.invalid; if (fresh.length) x.cookies = fresh.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, hostOnly: c.hostOnly, sameSite: c.sameSite, expirationDate: c.expirationDate })); } });
    }
    mirrorIn(target); markDirty();
    // 主脚本在 pagehide 时会把旧账号的记录写回，所以离开页面时再覆盖一次（本监听注册更晚，后执行）
    window.addEventListener('pagehide', () => mirrorIn(target), { once: true });
    try { sessionStorage.setItem(PENDING, JSON.stringify({ key: keyOf(target), prev: cur ? keyOf(cur) : null, at: Date.now() })); } catch {}
    toast('正在切换到 ' + (target.email || target.name || '账号') + ' …');
    setTimeout(() => { if (/^\/agent\/?$/.test(location.pathname)) location.reload(); else location.href = ORIGIN + '/agent'; }, 250);
    return true;
  }
  // ---------------- 添加账号：弹出邮箱密码表单，直接登录并切换 ----------------
  // 与 Arena 登录页相同的接口：POST /nextjs-api/sign-in/email，成功后服务端用 Set-Cookie 写入新账号的 arena-auth-prod-v1
  async function addAccount() {
    const cur = await syncCurrent(); mirrorOut(cur);
    closeSwitcher(); openLoginForm(cur);
  }
  async function nativeAdd(cur) {
    if (!cur && !domIdentity().email) {
      bypassLogin = true; restoreLogin();
      try { sessionStorage.setItem(PENDING, JSON.stringify({ key: '__new__', at: Date.now() })); } catch {}
      const b = nativeLoginButtons()[0]; if (b) b.click(); else location.href = ORIGIN + '/agent';
      return;
    }
    const now = authOf(await listCookies());
    for (const c of now) await delCookie(c);
    if (authOf(await listCookies()).length) { toast('无法清除登录 Cookie（需要 Tampermonkey 的 Cookie 权限）'); return; }
    mirrorIn(null); markDirty();
    window.addEventListener('pagehide', () => mirrorIn(null), { once: true });
    try { sessionStorage.setItem(PENDING, JSON.stringify({ key: '__new__', at: Date.now() })); } catch {}
    location.href = ORIGIN + '/agent';
  }
  const LOGIN_CSS = `
[data-amp-login-form]{position:fixed;inset:0;z-index:2147483646;pointer-events:auto;display:flex;align-items:center;justify-content:center;font:13px/1.45 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#f3f1ec;
  background:rgba(22,21,19,.66);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);opacity:0;transition:opacity .25s ease}
[data-amp-login-form].on{opacity:1}
[data-amp-login-form] .lf-card{width:min(360px,calc(100vw - 32px));padding:26px 24px 20px;box-sizing:border-box;border-radius:18px;background:rgba(38,37,34,.94);box-shadow:0 20px 60px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.08);
  transform:translateY(10px) scale(.97);transition:transform .4s cubic-bezier(.22,1,.36,1)}
[data-amp-login-form].on .lf-card{transform:none}
[data-amp-login-form].shake .lf-card{animation:lfshake .42s cubic-bezier(.36,.07,.19,.97)}
@keyframes lfshake{20%,60%{transform:translateX(-7px)}40%,80%{transform:translateX(7px)}}
[data-amp-login-form] .lf-ic{width:64px;height:64px;margin:0 auto 12px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 2px rgba(255,255,255,.12);color:#d8d3ca}
[data-amp-login-form] .lf-t{text-align:center;font-size:17px;font-weight:600}
[data-amp-login-form] .lf-s{text-align:center;font-size:12px;color:rgba(243,241,236,.55);margin:3px 0 18px}
[data-amp-login-form] label{display:block;font-size:11.5px;color:rgba(243,241,236,.6);margin:0 0 5px 2px}
[data-amp-login-form] .lf-f{position:relative;margin-bottom:12px}
[data-amp-login-form] input{width:100%;height:40px;box-sizing:border-box;padding:0 12px;border-radius:10px;border:0;outline:none;font:inherit;font-size:14px;color:#f3f1ec;background:rgba(255,255,255,.07);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);transition:box-shadow .2s,background .2s}
[data-amp-login-form] input:focus{background:rgba(255,255,255,.1);box-shadow:inset 0 0 0 1.5px #d8d3ca}
[data-amp-login-form] input::placeholder{color:rgba(243,241,236,.35)}
[data-amp-login-form] .lf-eye{position:absolute;right:6px;bottom:6px;width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:rgba(243,241,236,.55);cursor:pointer;display:flex;align-items:center;justify-content:center}
[data-amp-login-form] .lf-eye:hover{color:#f3f1ec;background:rgba(255,255,255,.08)}
[data-amp-login-form] .lf-memo{width:min(460px,calc(100vw - 24px))}
[data-amp-login-form] .lf-list{max-height:min(56vh,420px);overflow:auto;margin:12px -6px 0;padding:0 6px}
[data-amp-login-form] .lf-it{display:flex;align-items:center;gap:10px;padding:9px 4px;border-top:1px solid rgba(255,255,255,.07)}
[data-amp-login-form] .lf-l{flex:1;min-width:0}
[data-amp-login-form] .lf-e{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-amp-login-form] .lf-e.cur::after{content:"当前";margin-left:6px;padding:0 6px;border-radius:6px;font-size:10px;background:#d8d3ca;color:#262522}
[data-amp-login-form] .lf-p{font:12px ui-monospace,Consolas,monospace;color:rgba(243,241,236,.7);margin-top:2px;user-select:text;word-break:break-all}
[data-amp-login-form] .lf-p.none{font-family:inherit;color:rgba(243,241,236,.35)}
[data-amp-login-form] .lf-ops{display:flex;gap:4px;flex-shrink:0}
[data-amp-login-form] .lf-mb{border:0;background:rgba(255,255,255,.08);color:rgba(243,241,236,.8);font:inherit;font-size:11px;cursor:pointer;padding:3px 8px;border-radius:6px}
[data-amp-login-form] .lf-mb:hover{background:rgba(255,255,255,.18);color:#fff}
[data-amp-login-form] .lf-rem{display:flex;align-items:center;gap:7px;margin:-2px 2px 8px;font-size:12px;color:rgba(243,241,236,.6);cursor:pointer;user-select:none}
[data-amp-login-form] .lf-rem input{accent-color:#d8d3ca;width:14px;height:14px;margin:0;cursor:pointer}
[data-amp-login-form] .lf-msg{min-height:18px;font-size:12px;color:#f2a39b;margin:2px 2px 10px}
[data-amp-login-form] .lf-msg.ok{color:#a8d8a8}
[data-amp-login-form] .lf-go{width:100%;height:42px;border:0;border-radius:11px;cursor:pointer;font:inherit;font-size:14px;font-weight:600;color:#262522;background:#d8d3ca;display:flex;align-items:center;justify-content:center;gap:8px;
  transition:transform .15s ease,filter .2s,opacity .2s}
[data-amp-login-form] .lf-go:hover{filter:brightness(1.06)}[data-amp-login-form] .lf-go:active{transform:scale(.98)}
[data-amp-login-form] .lf-go[disabled]{opacity:.7;cursor:default}
[data-amp-login-form] .lf-spin{width:15px;height:15px;border-radius:50%;border:2px solid rgba(38,37,34,.3);border-top-color:#262522;animation:lfspin .7s linear infinite}
@keyframes lfspin{to{transform:rotate(360deg)}}
[data-amp-login-form] .lf-row{display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:12px}
[data-amp-login-form] .lf-link{border:0;background:transparent;color:rgba(243,241,236,.55);font:inherit;font-size:12px;cursor:pointer;padding:3px 4px;border-radius:6px}
[data-amp-login-form] .lf-link:hover{color:#f3f1ec;background:rgba(255,255,255,.06)}
`;
  // 用邮箱密码登录（与 Arena 登录页同一接口），成功返回 { rec }，失败返回 { error } 并恢复原登录 Cookie
  async function signInEmail(em, pw, opt = {}) {
    const before = authOf(await listCookies());
    const restore = async () => {
      const nowAuth = authOf(await listCookies());
      if (before.length && nowAuth.map(c => c.value).join('') !== before.map(c => c.value).join('')) { for (const c of nowAuth) await delCookie(c); for (const c of before) await setCookie(c); }
    };
    let res, j = null;
    try {
      res = await fetch(ORIGIN + '/nextjs-api/sign-in/email', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email: em, password: pw, shouldLinkHistory: false }) });
      try { j = await res.json(); } catch {}
    } catch (err) { await restore(); return { error: '网络错误：' + (err?.message || err) }; }
    if (!res.ok || !j?.success) {
      await restore();
      if (j?.requiresVerification) return { error: '该邮箱尚未验证，请先到邮箱完成验证（或改用 Arena 登录页）' };
      if (res.status === 429) return { error: '尝试过于频繁，请稍后再试' };
      const t = (j && (j.error || j.message)) ? String(j.error || j.message) : '';
      return { error: /invalid.*(credential|password)|incorrect|wrong/i.test(t) ? '邮箱或密码错误' : /captcha|verification|bot/i.test(t) ? '需要人机验证：请改用 Arena 登录页' : t || '登录失败（HTTP ' + res.status + '）', wrong: /invalid.*(credential|password)|incorrect|wrong/i.test(t) };
    }
    if (j.user && j.user.emailConfirmed === false) { await restore(); return { error: '该邮箱尚未验证，请先完成邮箱验证' }; }
    opt.stage?.('正在保存…');
    let rec = null;
    for (let i = 0; i < 8 && !rec; i++) {
      const auth = authOf(await listCookies());
      if (auth.length && auth.map(c => c.value).join('') !== before.map(c => c.value).join('')) {
        const s = decodeSession(auth);
        let me = null; try { const r = await fetch(ORIGIN + '/api/me', { credentials: 'include', cache: 'no-store' }); if (r.ok) me = (await r.json())?.user || null; } catch {}
        const mail = s.email || me?.email || em;
        const name = me?.name || me?.displayName || me?.username || me?.fullName || s.name || null;
        const avatar = me?.avatarUrl || me?.avatar_url || me?.image || me?.picture || s.avatar || null;
        rec = upsert({ id: s.id || me?.id || null, email: mail, name, avatar, cookies: auth.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, hostOnly: c.hostOnly, sameSite: c.sameSite, expirationDate: c.expirationDate, fromDocument: !!c.fromDocument })), exp: s.exp, savedAt: Date.now(), pw: opt.remember ? pw : null });
      } else await new Promise(r => setTimeout(r, 250));
    }
    if (!rec) return { error: cookieMode === 'gm' ? '已登录，但没读到新的登录 Cookie，请刷新页面' : '已登录，但扩展读不到登录 Cookie（需要 Cookie 权限），请刷新页面' };
    return { rec };
  }
  function openLoginForm(cur, preset = {}) {
    document.querySelector('[data-amp-login-form]')?.remove();
    if (!document.getElementById('amp-login-css')) { const st = el('style', null, LOGIN_CSS, document.head || document.documentElement); st.id = 'amp-login-css'; }
    const root = el('div', null, null, document.body); root.dataset.ampLoginForm = '1';
    const card = el('form', null, null, root); card.className = 'lf-card'; card.autocomplete = 'on'; card.noValidate = true;
    const ic = el('div', null, null, card); ic.className = 'lf-ic';
    ic.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="4"/><path d="M3 20c0-3.3 3.1-6 7-6"/><path d="M18 14v6M15 17h6"/></svg>';
    el('div', null, '添加账号', card).className = 'lf-t';
    el('div', null, cur ? '登录成功后自动保存并切换到新账号，' + (cur.email || '当前账号') + ' 仍可随时切回' : '登录成功后自动保存并进入该账号', card).className = 'lf-s';
    const f1 = el('div', null, null, card); f1.className = 'lf-f'; el('label', null, '邮箱', f1);
    const email = el('input', null, null, f1); email.type = 'email'; email.name = 'email'; email.autocomplete = 'username'; email.placeholder = 'name@example.com'; email.required = true;
    const f2 = el('div', null, null, card); f2.className = 'lf-f'; el('label', null, '密码', f2);
    const pwd = el('input', null, null, f2); pwd.type = 'password'; pwd.name = 'password'; pwd.autocomplete = 'current-password'; pwd.placeholder = '输入密码'; pwd.required = true; pwd.style.paddingRight = '40px';
    const eye = el('button', null, null, f2); eye.type = 'button'; eye.className = 'lf-eye'; eye.title = '显示/隐藏密码'; eye.tabIndex = -1;
    const eyeOn = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    const eyeOff = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
    eye.innerHTML = eyeOn; eye.onclick = () => { const show = pwd.type === 'password'; pwd.type = show ? 'text' : 'password'; eye.innerHTML = show ? eyeOff : eyeOn; pwd.focus(); };
    const rl = el('label', null, null, card); rl.className = 'lf-rem';
    const remember = el('input', null, null, rl); remember.type = 'checkbox'; remember.checked = GM_getValue('rememberPw', true) !== false;
    el('span', null, '记住密码（账号备忘，仅存本机 Tampermonkey）', rl);
    remember.onchange = () => { try { GM_setValue('rememberPw', remember.checked); } catch {} };
    if (preset.email) email.value = preset.email;
    if (preset.pw) pwd.value = preset.pw;
    const msg = el('div', null, preset.note || '', card); msg.className = 'lf-msg';
    const go = el('button', null, null, card); go.type = 'submit'; go.className = 'lf-go'; go.innerHTML = '<span>登录并切换</span>';
    const row = el('div', null, null, card); row.className = 'lf-row';
    const cancel = el('button', null, '取消', row); cancel.type = 'button'; cancel.className = 'lf-link';
    const native = el('button', null, '改用 Arena 登录页', row); native.type = 'button'; native.className = 'lf-link'; native.title = '需要 Google 登录或验证码时使用';
    let busy = false;
    const close = () => { removeEventListener('keydown', onKey, true); root.classList.remove('on'); setTimeout(() => root.remove(), 260); };
    const onKey = e => { if (!root.isConnected) return; if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); close(); } else if (root.contains(e.target)) e.stopPropagation(); };
    addEventListener('keydown', onKey, true);
    for (const t of ['keyup', 'keypress']) root.addEventListener(t, e => e.stopPropagation());
    cancel.onclick = () => { if (!busy) close(); };
    native.onclick = () => { if (busy) return; close(); void nativeAdd(cur); };
    root.addEventListener('mousedown', e => { if (e.target === root && !busy) close(); });
    const fail = text => { msg.className = 'lf-msg'; msg.textContent = text; root.classList.remove('shake'); void root.offsetWidth; root.classList.add('shake'); };
    const setBusy = (b, label) => { busy = b; go.disabled = b; email.disabled = pwd.disabled = b; go.innerHTML = b ? '<span class="lf-spin"></span><span>' + (label || '登录中…') + '</span>' : '<span>登录并切换</span>'; };
    card.onsubmit = async e => {
      e.preventDefault(); e.stopPropagation(); if (busy) return;
      const em = email.value.trim(), pw = pwd.value;
      if (!EMAIL.test(em)) { fail('请输入正确的邮箱'); email.focus(); return; }
      if (!pw) { fail('请输入密码'); pwd.focus(); return; }
      if (cur && keyOf({ email: em }) === keyOf(cur)) { fail('这就是当前账号'); return; }
      msg.textContent = ''; setBusy(true);
      const r = await signInEmail(em, pw, { remember: remember.checked, stage: l => setBusy(true, l) });
      if (r.error) { setBusy(false); fail(r.error); return; }
      const rec = r.rec;
      msg.className = 'lf-msg ok'; msg.textContent = '已登录 ' + rec.email + '，正在切换…'; setBusy(true, '正在切换…');
      mirrorIn(rec); markDirty();
      window.addEventListener('pagehide', () => mirrorIn(rec), { once: true });
      try { sessionStorage.setItem(PENDING, JSON.stringify({ key: keyOf(rec), at: Date.now() })); } catch {}
      setTimeout(() => { if (/^\/agent\/?$/.test(location.pathname)) location.reload(); else location.href = ORIGIN + '/agent'; }, 450);
    };
    requestAnimationFrame(() => requestAnimationFrame(() => { root.classList.add('on'); (preset.email ? pwd : email).focus(); }));
  }
  // 账号密码备忘录：列出所有已保存账号的邮箱和备忘密码
  function openMemo() {
    document.querySelector('[data-amp-login-form]')?.remove();
    if (!document.getElementById('amp-login-css')) { const st = el('style', null, LOGIN_CSS, document.head || document.documentElement); st.id = 'amp-login-css'; }
    const root = el('div', null, null, document.body); root.dataset.ampLoginForm = '1';
    const card = el('div', null, null, root); card.className = 'lf-card lf-memo';
    el('div', null, '账号备忘录', card).className = 'lf-t';
    el('div', null, '密码只保存在本机 Tampermonkey 存储中（明文），不会上传', card).className = 'lf-s';
    const list = el('div', null, null, card); list.className = 'lf-list';
    const all = load().sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const btn = (p, t, fn) => { const b = el('button', null, t, p); b.type = 'button'; b.className = 'lf-mb'; b.onclick = () => fn(b); return b; };
    for (const a of all) {
      const r = el('div', null, null, list); r.className = 'lf-it';
      const l = el('div', null, null, r); l.className = 'lf-l';
      el('div', null, a.email || '', l).className = 'lf-e' + (keyOf(a) === currentId ? ' cur' : '');
      const pt = el('div', null, a.pw ? '••••••••' : '未记录密码', l); pt.className = 'lf-p' + (a.pw ? '' : ' none');
      const ops = el('div', null, null, r); ops.className = 'lf-ops';
      btn(ops, '邮箱', b => copyText(a.email || '', b));
      if (a.pw) { btn(ops, '显示', b => { const on = pt.textContent === '••••••••'; pt.textContent = on ? a.pw : '••••••••'; b.textContent = on ? '隐藏' : '显示'; }); btn(ops, '复制', b => copyText(a.pw, b)); }
      btn(ops, a.pw ? '改' : '记录', () => {
        const v = prompt((a.pw ? '修改' : '记录') + ' ' + a.email + ' 的密码（留空并确定可删除）', a.pw || ''); if (v === null) return;
        const key = keyOf(a); mutate(l2 => { const x = l2.find(y => keyOf(y) === key); if (x) { if (v) x.pw = v; else delete x.pw; } });
        root.remove(); openMemo();
      });
    }
    if (!all.length) el('div', null, '还没有保存的账号', list).className = 'lf-s';
    const row = el('div', null, null, card); row.className = 'lf-row';
    const close = () => { removeEventListener('keydown', onKey, true); root.classList.remove('on'); setTimeout(() => root.remove(), 260); };
    btn(row, '复制全部（邮箱 密码）', b => copyText(all.map(a => a.email + (a.pw ? ' ' + a.pw : '')).join('\n'), b)).className = 'lf-link';
    const c = el('button', null, '关闭', row); c.type = 'button'; c.className = 'lf-link'; c.onclick = close;
    const onKey = e => { if (!root.isConnected) return; if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    addEventListener('keydown', onKey, true);
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('on')));
  }
  async function checkPending() {
    let p = null; try { p = JSON.parse(sessionStorage.getItem(PENDING) || 'null'); } catch {}
    if (!p || Date.now() - p.at > 120000) return;
    // 等页面把账号渲染出来
    for (let i = 0; i < 20; i++) { const a = await syncCurrent(); if (a || i > 12) break; await new Promise(r => setTimeout(r, 750)); }
    if (p.key === '__new__') { if (currentId) { sessionStorage.removeItem(PENDING); try { window.dispatchEvent(new CustomEvent('amp:account', { detail: String(currentId) })); } catch {} toast('已记录新账号 ' + (accounts.find(a => keyOf(a) === currentId)?.email || '')); } return; }
    sessionStorage.removeItem(PENDING);
    if (currentId === p.key) { toast('已切换到 ' + (accounts.find(a => keyOf(a) === currentId)?.email || '账号')); return; }
    const t = accounts.find(a => keyOf(a) === p.key);
    if (t && !currentId) {
      mutate(list => { const x = list.find(y => keyOf(y) === p.key); if (x) x.invalid = true; });
      // 自动切回原账号，避免停在匿名/报错页面
      const prev = p.prev && !p.rb && accounts.find(a => keyOf(a) === p.prev);
      if (prev?.cookies?.length) {
        for (const c of authOf(await listCookies())) await delCookie(c);
        for (const c of prev.cookies) await setCookie(c);
        mirrorIn(prev); markDirty();
        window.addEventListener('pagehide', () => mirrorIn(prev), { once: true });
        try { sessionStorage.setItem(PENDING, JSON.stringify({ key: p.prev, at: Date.now(), rb: 1 })); } catch {}
        toast('切换失败：' + (t.email || '该账号') + ' 的登录已失效，正在切回 ' + (prev.email || '原账号') + ' …');
        setTimeout(() => location.reload(), 1200);
        return;
      }
      toast('切换失败：' + (t.email || '该账号') + ' 的登录已失效，请点 + 重新登录');
    }
  }

  // ---------------- UI ----------------
  const dark = () => document.documentElement.classList.contains('dark');
  const acc = () => dark() ? EARTH_DARK : EARTH;
  function profileDialog() {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (d.getClientRects().length === 0) continue;
      const t = d.innerText || '';
      if (/Sign Out|Log out|退出登录|登出/i.test(t) && /@/.test(t)) return d;
    }
    return null;
  }
  function el(tag, css, text, parent) { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined && text !== null) e.textContent = text; if (parent) parent.appendChild(e); return e; }
  function copyText(t, btn) {
    const done = () => { if (btn) { const o = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = o; }, 1200); } };
    try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(t, 'text'); done(); return; } } catch {}
    navigator.clipboard?.writeText(t).then(done, () => { const ta = el('textarea', 'position:fixed;left:-9999px', t, document.body); ta.select(); try { document.execCommand('copy'); done(); } catch {} ta.remove(); });
  }
  function toast(msg) {
    const t = el('div', 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;padding:9px 14px;border-radius:10px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.18);'
      + (dark() ? 'background:#2c2b28;color:#ecebe7;' : 'background:#fff;color:#262522;') + 'border:1px solid ' + (dark() ? '#3f3d39' : '#e5e1da'), msg, document.body);
    setTimeout(() => t.remove(), 4200);
  }
  const fmtT = ms => { if (!ms) return ''; const d = new Date(ms), n = new Date(); const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); return d.toDateString() === n.toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm; };
  function quotaLines(q) {
    const out = [];
    if (q && Number.isFinite(q.usd)) out.push('$' + q.usd.toFixed(2) + (Number.isFinite(q.allowance) ? ' / $' + Math.round(q.allowance) : ''));
    if (q && Number.isFinite(q.credits)) out.push('credits ' + q.credits + (Number.isFinite(q.daily) && q.daily ? ' / ' + q.daily : ''));
    if (!out.length) out.push('暂无额度记录');
    const at = Math.max(q?.creditsAt || 0, q?.usdAt || 0);
    out.push(q?.live ? '实时 · ' + fmtT(at) : at ? '记录于 ' + fmtT(at) : '');
    return out.filter(Boolean);
  }

  function injectButton(dlg) {
    if (dlg.querySelector('[data-amp-switch]')) return;
    const pill = [...dlg.querySelectorAll('*')].find(e => e.childElementCount === 0 && EMAIL.test((e.textContent || '').trim()));
    if (!pill) return;
    // 邮箱胶囊所在行里的“···”按钮
    let row = pill.parentElement, more = null;
    for (let i = 0; i < 4 && row && !more; i++, row = row.parentElement) more = [...row.querySelectorAll('button')].find(b => b !== pill && !b.contains(pill) && !/sign out|reset/i.test(b.innerText || '') && !/close|关闭/i.test(b.getAttribute('aria-label') || ''));
    const pillBox = pill.closest('button,span,div') || pill, cs = getComputedStyle(pillBox);
    const b = el('button', 'display:inline-flex;align-items:center;gap:5px;height:' + Math.max(26, pillBox.getBoundingClientRect().height || 30) + 'px;padding:0 12px;margin-left:8px;border:0;border-radius:999px;cursor:pointer;font:inherit;font-size:13px;white-space:nowrap;flex-shrink:0;'
      + 'background:' + (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : (dark() ? 'rgba(255,255,255,.08)' : '#e9e5de')) + ';color:inherit');
    b.type = 'button'; b.dataset.ampSwitch = '1'; b.title = '切换到已保存的账号，或添加新账号';
    b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l4 4-4 4"/><path d="M20 7H9"/><path d="M8 21l-4-4 4-4"/><path d="M4 17h11"/></svg><span>切换账号</span>';
    b.onclick = e => { e.preventDefault(); e.stopPropagation(); void openPanel(dlg); };
    // 做成与 “Reset Password” 同款的整行按钮（手机 / 放不下时用），不会把卡片撑宽
    const asRow = () => {
      const reset = [...dlg.querySelectorAll('button')].find(x => /reset password|重置密码/i.test(x.innerText || ''));
      b.removeAttribute('style'); b.className = reset?.className || '';
      b.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;width:100%;box-sizing:border-box;max-width:100%;cursor:pointer;' + (reset ? '' : 'height:40px;border-radius:8px;border:1px solid ' + (dark() ? '#3f3d39' : '#e5e1da') + ';background:transparent;color:inherit;font:inherit;font-size:14px;margin-top:8px');
      const label = b.querySelector('span'); if (label) label.style.display = '';
      if (reset) reset.insertAdjacentElement('beforebegin', b);
      else { const row = pillBox.parentElement; (row?.parentElement ? row : pillBox).insertAdjacentElement('afterend', b); }
      if (reset) {
        // 直接照抄 Reset Password 的外观（Arena 改了类名也能对上）
        const c = getComputedStyle(reset);
        for (const k of ['height', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderRadius', 'backgroundColor', 'color', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'paddingLeft', 'paddingRight']) b.style[k] = c[k];
        b.style.marginBottom = '10px';
      }
    };
    const narrow = innerWidth < 640 || matchMedia('(pointer:coarse)').matches && innerWidth < 820;
    const w0 = dlg.offsetWidth;
    if (narrow) { asRow(); return; }
    if (more && more.parentElement) more.insertAdjacentElement('afterend', b);
    else pillBox.insertAdjacentElement('afterend', b);
    // 桌面：放不下（超出屏幕、换行或把卡片撑宽）就改成整行按钮；等弹窗动画结束再量一次
    const bad = () => { const dr = dlg.getBoundingClientRect(), br = b.getBoundingClientRect(); return br.right > Math.min(dr.right, innerWidth) - 6 || dr.right > innerWidth - 2 || br.top - pillBox.getBoundingClientRect().top > 12 || (w0 && dlg.offsetWidth > w0 + 2); };
    requestAnimationFrame(() => { if (bad()) asRow(); });
    setTimeout(() => { if (b.isConnected && b.style.width !== '100%' && bad()) asRow(); }, 400);
  }

  // ---------------- 切换器：全屏轮播 ----------------
  const SW_CSS = `
[data-amp-switcher]{position:fixed;inset:0;z-index:2147483646;pointer-events:auto;font:13px/1.4 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#f3f1ec;
  background:rgba(22,21,19,.66);-webkit-backdrop-filter:blur(8px) saturate(1.1);backdrop-filter:blur(8px) saturate(1.1);opacity:0;transition:opacity .28s ease;user-select:none;outline:none}
[data-amp-switcher].on{opacity:1}
[data-amp-switcher] .sw-top{position:absolute;left:0;right:0;top:12vh;text-align:center;transform:translateY(-8px);opacity:0;transition:all .45s cubic-bezier(.22,1,.36,1) .05s}
[data-amp-switcher].on .sw-top{transform:none;opacity:1}
[data-amp-switcher] .sw-title{font-size:20px;font-weight:600;letter-spacing:.5px}
[data-amp-switcher] .sw-sub{margin-top:4px;font-size:12px;color:rgba(243,241,236,.55)}
[data-amp-switcher] .sw-stage{position:absolute;left:50%;top:47%;width:0;height:0;transform:scale(.94);transition:transform .5s cubic-bezier(.22,1,.36,1)}
[data-amp-switcher].on .sw-stage{transform:none}
[data-amp-switcher] .sw-it{position:absolute;left:0;top:0;width:160px;margin-left:-80px;margin-top:-80px;display:flex;flex-direction:column;align-items:center;cursor:pointer;
  transition:transform .55s cubic-bezier(.22,1,.36,1),opacity .45s ease,filter .45s ease;will-change:transform}
[data-amp-switcher] .sw-in{display:flex;flex-direction:column;align-items:center;transform:scale(var(--hv,1));transition:transform .2s cubic-bezier(.22,1,.36,1)}
[data-amp-switcher] .sw-av{position:relative;width:128px;height:128px;border-radius:50%;overflow:visible;background:#3a3834;display:flex;align-items:center;justify-content:center;
  font-size:44px;font-weight:600;color:#d8d3ca;box-shadow:0 10px 30px rgba(0,0,0,.35);transition:box-shadow .3s ease,transform .3s ease}
[data-amp-switcher] .sw-av img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;pointer-events:none}
[data-amp-switcher] .sw-it.cur .sw-av{box-shadow:0 10px 30px rgba(0,0,0,.35)}
[data-amp-switcher] .sw-it.sel .sw-av{box-shadow:0 14px 40px rgba(0,0,0,.5)}
[data-amp-switcher] .sw-it.sel.cur .sw-av{box-shadow:0 14px 40px rgba(0,0,0,.5)}
[data-amp-switcher] .sw-it.bad .sw-av{filter:grayscale(1);opacity:.55}
[data-amp-switcher] .sw-add .sw-av{background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 2px rgba(255,255,255,.14);color:rgba(243,241,236,.7)}
[data-amp-switcher] .sw-tag{position:absolute;right:-4px;bottom:6px;padding:1px 7px;border-radius:8px;font-size:11px;font-weight:600;color:#262522;background:#d8d3ca;box-shadow:0 2px 6px rgba(0,0,0,.3)}
[data-amp-switcher] .sw-ring{position:absolute;inset:-9px;width:calc(100% + 18px);height:calc(100% + 18px);transform:rotate(-90deg);pointer-events:none;overflow:visible}
[data-amp-switcher] .sw-ring circle{fill:none;stroke-width:5}
[data-amp-switcher] .sw-ring .tk{stroke:rgba(255,255,255,.12)}
[data-amp-switcher] .sw-ring .pg{stroke:#4cc36a;stroke-linecap:round;transition:stroke-dashoffset .8s cubic-bezier(.22,1,.36,1),stroke .3s ease;filter:drop-shadow(0 0 4px rgba(76,195,106,.55))}
[data-amp-switcher] .sw-it.empty .sw-ring .tk{stroke:#e0493a;filter:drop-shadow(0 0 6px rgba(224,73,58,.7))}
[data-amp-switcher] .sw-it.empty .sw-ring .pg{opacity:0}
[data-amp-switcher] .sw-it.empty .sw-av>img,[data-amp-switcher] .sw-it.empty .sw-av>.sw-ch{filter:brightness(.45) saturate(.5)}
[data-amp-switcher] .sw-it.empty .sw-av{background:#2a2826}
[data-amp-switcher] .sw-it.noq .sw-ring .pg{opacity:0}
[data-amp-switcher] .sw-q0{font-size:12px;margin-top:2px;color:#4cc36a;font-variant-numeric:tabular-nums}
[data-amp-switcher] .sw-q0.z{color:#ff7a6b}
[data-amp-switcher] .sw-bar{display:none!important;margin-top:12px;width:96px;height:4px;border-radius:2px;background:rgba(255,255,255,.16);overflow:hidden;transition:width .3s ease,height .3s ease}
[data-amp-switcher] .sw-bar i{display:block;height:100%;border-radius:inherit;background:#d8d3ca;transform-origin:left;transition:transform .6s cubic-bezier(.22,1,.36,1)}
[data-amp-switcher] .sw-bar.none{background:repeating-linear-gradient(90deg,rgba(255,255,255,.18) 0 6px,transparent 6px 10px)}
[data-amp-switcher] .sw-nm{margin-top:9px;max-width:170px;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-amp-switcher] .sw-det{max-height:0;opacity:0;overflow:hidden;text-align:center;transform:translateY(-4px);transition:max-height .35s cubic-bezier(.22,1,.36,1),opacity .25s ease,transform .35s cubic-bezier(.22,1,.36,1)}
[data-amp-switcher] .sw-it.sel .sw-det,[data-amp-switcher] .sw-it.near .sw-det{max-height:190px;opacity:1;transform:none}
[data-amp-switcher] .sw-it.sel .sw-bar,[data-amp-switcher] .sw-it.near .sw-bar{width:132px;height:6px}
[data-amp-switcher] .sw-em{font-size:11.5px;color:rgba(243,241,236,.6);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-amp-switcher] .sw-q1{margin-top:6px;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;color:#f3f1ec}
[data-amp-switcher] .sw-q2{font-size:11.5px;color:rgba(243,241,236,.7);font-variant-numeric:tabular-nums}
[data-amp-switcher] .sw-q3{font-size:10.5px;color:rgba(243,241,236,.45);margin-top:1px}
[data-amp-switcher] .sw-q3.live::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#8fd18f;margin-right:5px;vertical-align:1px;animation:swp 1.6s ease-in-out infinite}
@keyframes swp{50%{opacity:.35}}
[data-amp-switcher] .sw-bad{font-size:11px;color:#f2a39b;margin-top:2px}
[data-amp-switcher] .sw-memob{position:absolute;left:18px;top:18px;border:0;border-radius:999px;padding:8px 14px;background:rgba(255,255,255,.1);color:rgba(243,241,236,.85);font:inherit;font-size:12.5px;cursor:pointer;z-index:3}
[data-amp-switcher] .sw-memob:hover{background:rgba(255,255,255,.2);color:#fff}
[data-amp-switcher].vert .sw-memob{left:12px;top:12px}
[data-amp-switcher] .sw-memo{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:2px 4px;margin-top:6px;font-size:11px}
[data-amp-switcher] .sw-pwt{color:rgba(243,241,236,.8);font-family:ui-monospace,Consolas,monospace;letter-spacing:.5px;margin-right:4px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text}
[data-amp-switcher] .sw-pwt.none{color:rgba(243,241,236,.4);font-family:inherit;letter-spacing:0}
[data-amp-switcher] .sw-mb{border:0;background:rgba(255,255,255,.08);color:rgba(243,241,236,.75);font:inherit;font-size:11px;cursor:pointer;padding:2px 7px;border-radius:6px}
[data-amp-switcher] .sw-mb:hover{background:rgba(255,255,255,.18);color:#fff}
[data-amp-switcher] .sw-rm{margin-top:6px;border:0;background:transparent;color:rgba(243,241,236,.45);font:inherit;font-size:11px;cursor:pointer;padding:2px 8px;border-radius:6px}
[data-amp-switcher] .sw-rm:hover{color:#f2a39b;background:rgba(255,255,255,.06)}
[data-amp-switcher] .sw-arrow{position:absolute;top:47%;width:48px;height:48px;margin-top:-24px;border-radius:50%;border:0;cursor:pointer;color:#f3f1ec;background:rgba(255,255,255,.1);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;transition:background .2s,transform .2s cubic-bezier(.22,1,.36,1)}
[data-amp-switcher] .sw-arrow:hover{background:rgba(255,255,255,.18);transform:scale(1.08)}
[data-amp-switcher] .sw-arrow:active{transform:scale(.94)}
[data-amp-switcher] .sw-arrow.l{left:max(24px,calc(50% - 520px))}[data-amp-switcher] .sw-arrow.r{right:max(24px,calc(50% - 520px))}
[data-amp-switcher] .sw-close{position:absolute;right:22px;top:18px;width:36px;height:36px;border-radius:50%;border:0;cursor:pointer;color:#f3f1ec;background:rgba(255,255,255,.08);font-size:18px;line-height:36px;padding:0}
[data-amp-switcher] .sw-close:hover{background:rgba(255,255,255,.16)}
[data-amp-switcher] .sw-hint{position:absolute;left:0;right:0;bottom:9vh;text-align:center;font-size:12px;color:rgba(243,241,236,.5)}
[data-amp-switcher] .sw-hint kbd{display:inline-block;min-width:18px;padding:1px 6px;margin:0 2px;border-radius:5px;font:11px/16px inherit;color:#f3f1ec;background:rgba(255,255,255,.1);box-shadow:inset 0 -1px 0 rgba(0,0,0,.3)}
[data-amp-switcher] .sw-warn{position:absolute;left:50%;bottom:15vh;transform:translateX(-50%);max-width:520px;padding:9px 14px;border-radius:10px;font-size:12px;line-height:1.55;color:#f3e3c2;background:rgba(120,90,40,.35);box-shadow:inset 0 0 0 1px rgba(243,227,194,.2);text-align:center}
[data-amp-switcher] .sw-it.go .sw-av{animation:swgo .9s cubic-bezier(.22,1,.36,1) forwards}
[data-amp-switcher] .sw-it.go .sw-av::after{content:"";position:absolute;inset:-2px;border-radius:50%;border:3px solid transparent;border-top-color:#fff;border-right-color:rgba(255,255,255,.5);animation:swspin .8s linear infinite}
@keyframes swgo{0%{transform:scale(1)}30%{transform:scale(.9)}100%{transform:scale(1.04)}}
@keyframes swspin{to{transform:rotate(360deg)}}
[data-amp-switcher] .sw-mcard,[data-amp-switcher] .sw-mside{display:none}
[data-amp-switcher] .sw-addb{position:absolute;left:50%;top:calc(47% + 250px);transform:translateX(-50%);display:flex;align-items:center;gap:6px;border:0;border-radius:999px;padding:9px 18px 9px 14px;cursor:pointer;font:inherit;font-size:13px;color:rgba(243,241,236,.85);background:rgba(255,255,255,.1);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);transition:background .2s,transform .2s cubic-bezier(.22,1,.36,1),opacity .4s ease;z-index:3}
[data-amp-switcher] .sw-addb:hover{background:rgba(255,255,255,.2);color:#fff;transform:translateX(-50%) scale(1.05)}
[data-amp-switcher] .sw-addb:active{transform:translateX(-50%) scale(.95)}
[data-amp-switcher] .sw-addb.solo{top:47%;margin-top:-20px}
[data-amp-switcher] .sw-hint{left:auto!important;right:22px;bottom:18px!important;text-align:right}
[data-amp-switcher] .sw-warn{bottom:auto;top:138px}
[data-amp-switcher].vert .sw-top{top:max(14px,4vh)}
[data-amp-switcher].vert .sw-title{font-size:18px}
[data-amp-switcher].vert .sw-sub{display:none}
[data-amp-switcher].vert .sw-stage{top:42%}
[data-amp-switcher].vert .sw-it .sw-det{display:none}
[data-amp-switcher].vert .sw-av{width:112px;height:112px;font-size:40px}
[data-amp-switcher].vert .sw-it{margin-top:-72px}
[data-amp-switcher].vert .sw-nm{margin-top:7px;font-size:13px}
[data-amp-switcher].vert .sw-bar{margin-top:10px}
[data-amp-switcher].vert .sw-mcard{display:block;position:absolute;left:50%;bottom:calc(max(12px,3vh) + 34px);transform:translateX(-50%);width:min(320px,calc(100vw - 40px));padding:12px 14px;box-sizing:border-box;border-radius:14px;
  background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);text-align:center;transition:opacity .25s ease}
[data-amp-switcher].vert .sw-mcard .sw-em{max-width:none;font-size:12px;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-amp-switcher].vert .sw-mcard{padding:8px 10px!important;border-radius:12px!important;width:min(300px,calc(100vw - 48px))!important}
[data-amp-switcher].vert .sw-mcard .sw-memo{margin-top:5px;gap:4px}
[data-amp-switcher].vert .sw-mcard .sw-rm{margin:0;padding:3px 8px;border-radius:7px;font-size:11px;background:rgba(255,255,255,.06)}
[data-amp-switcher].vert .sw-mcard .sw-bad{font-size:11px;margin-top:3px}
[data-amp-switcher].vert .sw-mside{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:2px;position:absolute;top:42%;right:calc(50% + 72px);transform:translateY(-50%);width:calc(50% - 84px);max-width:150px;text-align:right;pointer-events:none;transition:opacity .25s ease}
[data-amp-switcher].vert .sw-mside[hidden]{display:none}
[data-amp-switcher].vert .sw-mside .sw-q0{margin:0;font-size:12px;font-weight:600}
[data-amp-switcher].vert .sw-mside .sw-q1{margin:2px 0 0;font-size:18px;line-height:1.15;font-weight:700;white-space:nowrap}[data-amp-switcher].vert .sw-mside .sw-q1 small{display:block;font-size:11px;font-weight:500;opacity:.6}
[data-amp-switcher].vert .sw-mside .sw-q2{font-size:11px}
[data-amp-switcher].vert .sw-mside .sw-q3{font-size:10px;margin-top:2px}
[data-amp-switcher].vert .sw-arrow{display:none!important;left:auto!important;right:10px!important;width:40px;height:40px;margin-top:-20px}
[data-amp-switcher].vert .sw-arrow.l{top:calc(42% - 30px)}[data-amp-switcher].vert .sw-arrow.r{top:calc(42% + 30px)}
[data-amp-switcher].vert .sw-arrow svg{transform:rotate(90deg)}
[data-amp-switcher].vert .sw-hint{right:12px;bottom:max(10px,2vh)!important;font-size:11px}
[data-amp-switcher].vert .sw-addb{left:auto;right:10px;top:42%;transform:translateY(-50%);flex-direction:column;gap:3px;padding:10px 8px;border-radius:16px;font-size:10.5px;margin:0}
[data-amp-switcher].vert .sw-addb:hover{transform:translateY(-50%) scale(1.05)}[data-amp-switcher].vert .sw-addb:active{transform:translateY(-50%) scale(.95)}
[data-amp-switcher].vert .sw-addb.solo{right:auto;left:50%;transform:translate(-50%,-50%);flex-direction:row;padding:10px 18px;font-size:13px}
[data-amp-switcher].vert .sw-warn{bottom:auto;top:calc(max(14px,4vh) + 56px);width:calc(100vw - 40px)}
[data-amp-switcher].vert .sw-close{right:12px;top:12px}
[data-amp-switcher].leaving{opacity:0}
[data-amp-switcher].leaving .sw-stage{transform:scale(.96)}
`;
  function ratioOf(q) {
    if (q && Number.isFinite(q.usd) && Number.isFinite(q.allowance) && q.allowance > 0) return Math.max(0, Math.min(1, q.usd / q.allowance));
    if (q && Number.isFinite(q.credits) && Number.isFinite(q.daily) && q.daily > 0) return Math.max(0, Math.min(1, q.credits / q.daily));
    return null;
  }
  function closeDialog(dlg) {
    const x = [...dlg.querySelectorAll('button')].find(b => /close|关闭/i.test(b.getAttribute('aria-label') || '') || (!b.innerText.trim() && b.querySelector('svg') && !b.dataset.ampSwitch && b.getBoundingClientRect().top - dlg.getBoundingClientRect().top < 40));
    if (x) x.click(); else dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }
  let closeSwitcher = () => {};
  async function openPanel(host) {
    if (host) closeDialog(host);
    await syncCurrent();
    document.querySelector('[data-amp-switcher]')?.remove();
    if (!document.getElementById('amp-switcher-css')) { const st = el('style', null, SW_CSS, document.head || document.documentElement); st.id = 'amp-switcher-css'; }
    const list = [...accounts].sort((a, b) => (keyOf(b) === currentId) - (keyOf(a) === currentId) || (a.addedAt || 0) - (b.addedAt || 0));
    const items = list.map(a => ({ a }));
    let sel = 0, busy = false, wheelAt = 0;
    const root = el('div', null, null, document.body); root.dataset.ampSwitcher = '1'; root.tabIndex = -1;
    const top = el('div', null, null, root); top.className = 'sw-top';
    el('div', null, currentId ? '切换账号' : '选择账号登录', top).className = 'sw-title';
    el('div', null, list.length ? list.length + ' 个已保存账号 · 点头像或按 Enter 切换' : '还没有保存的账号', top).className = 'sw-sub';
    const memoB = el('button', null, '备忘录', root); memoB.className = 'sw-memob'; memoB.type = 'button'; memoB.title = '查看所有账号和备忘密码'; memoB.onclick = e => { e.stopPropagation(); closeSwitcher(); openMemo(); };
    const close = el('button', null, '×', root); close.className = 'sw-close'; close.type = 'button'; close.title = '关闭 (Esc)';
    const stage = el('div', null, null, root); stage.className = 'sw-stage';
    const arrowSvg = d => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
    const L = el('button', null, null, root); L.className = 'sw-arrow l'; L.type = 'button'; L.title = '上一个 (←)'; L.innerHTML = arrowSvg('M15 18l-6-6 6-6');
    const R = el('button', null, null, root); R.className = 'sw-arrow r'; R.type = 'button'; R.title = '下一个 (→)'; R.innerHTML = arrowSvg('M9 6l6 6-6 6');
    const hint = el('div', null, null, root); hint.className = 'sw-hint';
    const addB = el('button', null, null, root); addB.className = 'sw-addb'; addB.type = 'button'; addB.title = currentId ? '添加账号：输入邮箱密码，登录后自动保存并切换' : '输入邮箱密码登录其他账号';
    addB.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>' + (currentId ? '添加账号' : '其他账号') + '</span>';
    addB.onclick = e => { e.stopPropagation(); if (busy) return; closeSwitcher(); void addAccount(); };
    hint.innerHTML = '<kbd>←</kbd><kbd>→</kbd> 切换 &nbsp;·&nbsp; <kbd>Enter</kbd> 确认 &nbsp;·&nbsp; <kbd>Esc</kbd> 关闭';
    if (cookieMode !== 'gm') {
      const w = el('div', null, (cookieMode === 'gm-error' ? '读取 Cookie 出错：' + lastError + '。' : cookieMode === 'hidden' ? '页面已登录，但读不到登录 Cookie（HttpOnly）。' : '当前无法通过扩展读取登录 Cookie。') + '需要 Tampermonkey 支持 HttpOnly Cookie 的版本，并在 设置 → 安全 →“允许脚本访问 Cookie”选“全部”。', root);
      w.className = 'sw-warn';
    }

    const nodes = items.map((it, i) => {
      const a = it.a, isCur = a && keyOf(a) === currentId;
      const n = el('div', null, null, stage); n.className = 'sw-it' + (it.add ? ' sw-add' : '') + (isCur ? ' cur' : '') + (a?.invalid ? ' bad' : '');
      const inn = el('div', null, null, n); inn.className = 'sw-in';
      const av = el('div', null, null, inn); av.className = 'sw-av';
      if (it.add) av.innerHTML = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
      else if (a.avatar) { const img = el('img', null, null, av); img.src = a.avatar; img.referrerPolicy = 'no-referrer'; img.draggable = false; img.onerror = () => { img.remove(); el('span', null, (a.name || a.email || '?')[0].toUpperCase(), av).className = 'sw-ch'; }; }
      else el('span', null, (a.name || a.email || '?')[0].toUpperCase(), av).className = 'sw-ch';
      let ringPg = null;
      if (!it.add) { av.insertAdjacentHTML('afterbegin', '<svg class="sw-ring" viewBox="0 0 100 100"><circle class="tk" cx="50" cy="50" r="47"/><circle class="pg" cx="50" cy="50" r="47" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg>'); ringPg = av.querySelector('.pg'); }
      if (isCur) el('span', null, '当前', av).className = 'sw-tag';
      const bar = el('div', null, null, inn); bar.className = 'sw-bar'; const fill = el('i', null, null, bar);
      if (it.add) bar.style.visibility = 'hidden';
      el('div', null, it.add ? (currentId ? '添加账号' : '其他账号') : (a.name || (a.email || '').split('@')[0] || '账号'), inn).className = 'sw-nm';
      const det = el('div', null, null, inn); det.className = 'sw-det';
      const paint = (box = det) => {
        box.textContent = ''; const det = box;
        if (it.add) { el('div', null, currentId ? '输入邮箱密码，登录后自动保存并切换' : '输入邮箱密码登录其他账号', det).className = 'sw-em'; return; }
        const q = a.quota || {}, r = ratioOf(q);
        bar.classList.toggle('none', r === null); fill.style.transform = 'scaleX(' + (r ?? 0) + ')';
        const hasP = Number.isFinite(q.pulse), blk = Number.isFinite(q.blockedUntil) && q.blockedUntil > Date.now();
        const pr = blk ? 0 : hasP ? q.pulse / 100 : r;
        n.classList.toggle('empty', pr !== null && pr <= 0); n.classList.toggle('noq', pr === null);
        if (ringPg) ringPg.setAttribute('stroke-dashoffset', String(100 - Math.round((pr ?? 0) * 100)));
        n.title = blk ? '限流中，约 ' + Math.max(1, Math.ceil((q.blockedUntil - Date.now()) / 60000)) + ' 分钟后解除' : hasP ? '脉冲额度 ' + q.pulse + '%' + (q.pulse <= 0 ? '（基本无法对话）' : '') : '';
        el('div', null, a.email || '', det).className = 'sw-em';
        if (blk) el('div', null, '限流中 · ' + Math.max(1, Math.ceil((q.blockedUntil - Date.now()) / 60000)) + ' 分钟后解除', det).className = 'sw-q0 z';
        if (hasP) el('div', null, q.pulse <= 0 ? '脉冲额度 0% · 基本无法对话' : '脉冲额度 ' + q.pulse + '%', det).className = 'sw-q0' + (q.pulse <= 0 ? ' z' : '');
        const hasUsd = Number.isFinite(q.usd), hasCr = Number.isFinite(q.credits);
        el('div', null, hasUsd ? '$' + q.usd.toFixed(2) + (Number.isFinite(q.allowance) ? ' / $' + Math.round(q.allowance) : '') : hasCr ? 'credits ' + q.credits : hasP || blk ? '' : '暂无额度记录', det).className = 'sw-q1';
        if (hasUsd && hasCr) el('div', null, 'credits ' + q.credits + (Number.isFinite(q.daily) && q.daily ? ' / ' + q.daily : ''), det).className = 'sw-q2';
        const at = Math.max(q.creditsAt || 0, q.usdAt || 0, q.pulseAt || 0, q.blockedAt || 0);
        if (at) { const t = el('div', null, (q.live ? '实时 · ' : '记录于 ') + fmtT(at), det); t.className = 'sw-q3' + (q.live ? ' live' : ''); }
        if (a.invalid) el('div', null, a.pw ? '登录已失效，点头像将用备忘密码自动重新登录' : '登录已失效，点头像输入密码重新登录', det).className = 'sw-bad';
        const memo = el('div', null, null, det); memo.className = 'sw-memo';
        const pwTxt = el('span', null, a.pw ? '••••••••' : '未记录密码', memo); pwTxt.className = 'sw-pwt' + (a.pw ? '' : ' none');
        const mb = (label, title, fn) => { const b = el('button', null, label, memo); b.type = 'button'; b.className = 'sw-mb'; b.title = title; b.onclick = e => { e.stopPropagation(); fn(b); }; return b; };
        mb('邮箱', '复制邮箱', b => copyText(a.email || '', b));
        if (a.pw) {
          mb('显示', '显示/隐藏密码', b => { const on = pwTxt.textContent === '••••••••'; pwTxt.textContent = on ? a.pw : '••••••••'; b.textContent = on ? '隐藏' : '显示'; });
          mb('复制', '复制密码', b => copyText(a.pw, b));
        }
        mb(a.pw ? '改' : '记录', a.pw ? '修改备忘密码' : '记录这个账号的密码', () => {
          const v = prompt((a.pw ? '修改' : '记录') + ' ' + (a.email || '该账号') + ' 的密码（仅保存在本机 Tampermonkey；留空并确定可删除）', a.pw || '');
          if (v === null) return; const key = keyOf(a);
          mutate(l => { const x = l.find(y => keyOf(y) === key); if (x) { if (v) x.pw = v; else delete x.pw; } });
          a.pw = v || undefined; const outer = inn.querySelector('.sw-det'); paint(outer); if (box !== outer) { if (box === mcard) vertInto(); else paint(box); }
          toast(v ? '已保存密码备忘' : '已删除密码备忘');
        });
        if (!isCur) {
          const rm = el('button', null, '移除记录', det); rm.className = 'sw-rm'; rm.type = 'button';
          rm.onclick = e => { e.stopPropagation(); if (!confirm('移除 ' + (a.email || '该账号') + ' 的本地记录？')) return; const key = keyOf(a); mutate(l => { const k = l.findIndex(y => keyOf(y) === key); if (k >= 0) l.splice(k, 1); }); void openPanel(null); };
        }
      };
      paint();
      n.onclick = e => { e.stopPropagation(); if (busy) return; if (i === sel) confirmSel(); else { sel = i; layout(); } };
      return { n, inn, av, paint: (box) => { paint(); if (box) paint(box); }, into: box => paint(box), it };
    });

    const N = nodes.length;
    const cur0 = items.findIndex(it => it.a && keyOf(it.a) === currentId);
    sel = cur0 >= 0 ? cur0 : 0;
    const X = [0, 175, 300, 400, 480], S = [1, .68, .5, .4, .34], O = [1, .88, .62, .38, 0];
    const Y = [0, 150, 250, 330, 400], OV = [1, .78, 0, 0, 0];
    const mcard = el('div', null, null, root); mcard.className = 'sw-mcard';
    // 竖屏：额度信息放在中间头像左侧，底部卡片只留邮箱和操作按钮
    const mside = el('div', null, null, root); mside.className = 'sw-mside';
    const vertInto = () => { const d = nodes[sel]; if (!d) return; d.into(mcard); mside.textContent = ''; for (const c of [...mcard.querySelectorAll('.sw-q0,.sw-q1,.sw-q2,.sw-q3')]) mside.append(c); const q1 = mside.querySelector('.sw-q1'); if (q1 && q1.textContent.includes(' / ')) { const [m, t] = q1.textContent.split(' / '); q1.textContent = m; const sm = document.createElement('small'); sm.textContent = '/ ' + t; q1.append(sm); } mside.hidden = !mside.children.length; const rm = mcard.querySelector('.sw-rm'), memo = mcard.querySelector('.sw-memo'); if (rm && memo) memo.append(rm); };
    let vert = false;
    const isVert = () => innerWidth < 640 || innerHeight > innerWidth * 1.15;
    function applyMode() {
      vert = isVert(); root.classList.toggle('vert', vert);
      hint.innerHTML = vert ? '上下滑动切换 &nbsp;·&nbsp; 点中间头像确认' : '<kbd>←</kbd><kbd>→</kbd> 切换 &nbsp;·&nbsp; <kbd>Enter</kbd> 确认 &nbsp;·&nbsp; <kbd>Esc</kbd> 关闭';
      L.title = vert ? '上一个' : '上一个 (←)'; R.title = vert ? '下一个' : '下一个 (→)';
    }
    applyMode();
    function layout() {
      nodes.forEach((d, i) => {
        let off = i - sel; if (N > 2) { off = ((off % N) + N) % N; if (off > N / 2) off -= N; }
        const k = Math.min(Math.abs(off), 4), x = Math.sign(off) * X[k];
        d.n.style.transform = vert ? 'translateY(' + Math.sign(off) * Y[k] + 'px) scale(' + S[k] + ')' : 'translateX(' + x + 'px) scale(' + S[k] + ')';
        d.n.style.opacity = String(vert ? OV[k] : O[k]); d.n.style.pointerEvents = (vert ? OV[k] === 0 : k >= 4) ? 'none' : 'auto'; d.n.style.zIndex = String(10 - k);
        d.n.style.filter = k >= 2 ? 'blur(' + (k - 1) * .6 + 'px)' : 'none';
        d.n.classList.toggle('sel', off === 0);
      });
      L.style.visibility = R.style.visibility = N > 1 ? 'visible' : 'hidden';
      if (vert) vertInto();
      addB.classList.toggle('solo', !N);
    }
    const move = dir => { if (busy || N < 2) return; sel = (sel + dir + N) % N; clearNear(); layout(); };
    function clearNear() { for (const d of nodes) { d.inn.style.setProperty('--hv', '1'); d.n.classList.remove('near'); } }
    // 鼠标靠近：头像按距离放大，并显示具体额度
    root.addEventListener('mousemove', e => {
      if (busy || vert) return;
      for (const d of nodes) {
        if (d.n.style.pointerEvents === 'none') continue;
        const r = d.av.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const p = Math.max(0, 1 - Math.hypot(e.clientX - cx, e.clientY - cy) / Math.max(150, r.width * 1.3));
        d.inn.style.setProperty('--hv', (1 + .16 * p).toFixed(3));
        d.n.classList.toggle('near', p > .42 && !d.n.classList.contains('sel'));
      }
    });
    root.addEventListener('mouseleave', clearNear);
    let t0 = null;
    root.addEventListener('touchstart', e => { const t = e.touches[0]; t0 = t ? { x: t.clientX, y: t.clientY, at: Date.now() } : null; }, { passive: true });
    root.addEventListener('touchmove', e => { if (t0) e.preventDefault(); }, { passive: false });
    root.addEventListener('touchend', e => {
      if (!t0) return; const t = e.changedTouches[0], dx = t.clientX - t0.x, dy = t.clientY - t0.y; t0 = null;
      const main = vert ? dy : dx, cross = vert ? dx : dy;
      if (Math.abs(main) > 36 && Math.abs(main) > Math.abs(cross)) { e.preventDefault(); move(main < 0 ? 1 : -1); }
    });
    const onResize = () => { if (!root.isConnected) { removeEventListener('resize', onResize); return; } const was = vert; applyMode(); if (was !== vert) { clearNear(); layout(); } };
    addEventListener('resize', onResize);
    root.addEventListener('wheel', e => { e.preventDefault(); const now = Date.now(); if (now - wheelAt < 280) return; const v = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; if (Math.abs(v) < 4) return; wheelAt = now; move(v > 0 ? 1 : -1); }, { passive: false });
    L.onclick = e => { e.stopPropagation(); move(-1); }; R.onclick = e => { e.stopPropagation(); move(1); };
    async function confirmSel() {
      const d = nodes[sel]; if (!d || busy) return;
      if (d.it.add) { closeSwitcher(); void addAccount(); return; }
      if (keyOf(d.it.a) === currentId) { closeSwitcher(); toast('已经是当前账号'); return; }
      if (d.it.a.invalid && !d.it.a.pw) { closeSwitcher(); openLoginForm(accounts.find(a => keyOf(a) === currentId) || null, { email: d.it.a.email, note: '该账号登录已失效，请重新输入密码' }); return; }
      busy = true; clearNear(); d.n.classList.add('go');
      const nm = d.inn.querySelector('.sw-nm'); if (nm) nm.textContent = '切换中…';
      await new Promise(r => setTimeout(r, 380));
      const went = await switchTo(d.it.a);
      if (!went && root.isConnected) { busy = false; d.n.classList.remove('go'); const k = keyOf(d.it.a); d.it.a = load().find(a => keyOf(a) === k) || d.it.a; d.n.classList.toggle('bad', !!d.it.a.invalid); (d.paint(null), vert && nodes[sel] === d && vertInto()); if (nm) nm.textContent = d.it.a.name || (d.it.a.email || '').split('@')[0]; return; }
      setTimeout(() => { if (root.isConnected && busy) { busy = false; d.n.classList.remove('go'); d.paint(); if (nm) nm.textContent = d.it.a.name || (d.it.a.email || '').split('@')[0]; } }, 4000);
    }
    const onKey = e => {
      if (!root.isConnected) return;
      const k = e.key; if (!['ArrowLeft', 'ArrowRight', 'Enter', 'Escape', ' '].includes(k)) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (k === 'ArrowLeft') move(-1); else if (k === 'ArrowRight') move(1); else if (k === 'Escape') closeSwitcher(); else confirmSel();
    };
    window.addEventListener('keydown', onKey, true);
    closeSwitcher = () => { window.removeEventListener('keydown', onKey, true); root.classList.add('leaving'); root.classList.remove('on'); setTimeout(() => root.remove(), 300); closeSwitcher = () => {}; };
    close.onclick = e => { e.stopPropagation(); closeSwitcher(); };
    root.addEventListener('click', e => { if (e.target === root || e.target === stage) closeSwitcher(); });
    layout();
    requestAnimationFrame(() => requestAnimationFrame(() => { root.classList.add('on'); root.focus({ preventScroll: true }); }));
    // 打开时实时读取当前账号额度
    const curA = accounts.find(a => keyOf(a) === currentId);
    if (curA) {
      const live = await liveCredits();
      if (live) { const key = keyOf(curA); mutate(l => { const x = l.find(y => keyOf(y) === key); if (x) x.quota = { ...(x.quota || {}), ...quotaFromCache(), ...live }; }); const d = nodes.find(z => z.it.a && keyOf(z.it.a) === key); if (d) { d.it.a.quota = find(key)?.quota || d.it.a.quota; (d.paint(null), vert && nodes[sel] === d && vertInto()); } }
    }
  }

  // ---------------- 未登录时的入口 ----------------
  // 已有保存的账号时，隐藏 Arena 的“Log in”，换成“立即登录”→ 选账号秒登
  let bypassLogin = false;
  const LOGIN_TXT = /^(log in|sign in|login|登录|登入)$/i;
  function nativeLoginButtons() { return [...document.querySelectorAll('button,a[href]')].filter(b => !b.dataset.ampLogin && b.getClientRects().length && LOGIN_TXT.test((b.innerText || b.textContent || '').trim())); }
  function restoreLogin() {
    for (const b of document.querySelectorAll('[data-amp-hidden-login]')) { b.style.removeProperty('display'); delete b.dataset.ampHiddenLogin; }
    for (const c of document.querySelectorAll('[data-amp-login]')) c.remove();
  }
  function replaceLogin() {
    const want = cookieMode === 'gm' && !bypassLogin && !currentId && accounts.some(a => a.cookies?.length && !a.invalid) && !domIdentity().email;
    if (!want) { if (document.querySelector('[data-amp-login],[data-amp-hidden-login]')) restoreLogin(); return false; }
    for (const c of document.querySelectorAll('[data-amp-login]')) if (!c.previousElementSibling?.dataset?.ampHiddenLogin) c.remove();
    for (const b of nativeLoginButtons()) {
      if (b.closest('[role="dialog"]')) continue; // 已打开的登录弹窗里不动
      const n = b.cloneNode(false);
      for (const a of ['id', 'href', 'aria-label', 'data-state', 'aria-expanded', 'aria-controls']) n.removeAttribute(a);
      n.dataset.ampLogin = '1'; if (n.tagName === 'BUTTON') n.type = 'button';
      n.textContent = '立即登录'; n.title = '选择已保存的账号直接登录';
      n.onclick = e => { e.preventDefault(); e.stopPropagation(); void openPanel(null); };
      b.dataset.ampHiddenLogin = '1'; b.style.setProperty('display', 'none', 'important');
      b.insertAdjacentElement('afterend', n);
    }
    return !!document.querySelector('[data-amp-login]');
  }
  let floater = null;
  function paintFloater() {
    const need = !currentId && cookieMode !== 'hidden' && accounts.some(a => a.cookies?.length) && !profileDialog() && !domIdentity().email && !replaceLogin();
    if (!need) { floater?.remove(); floater = null; return; }
    if (floater?.isConnected) return;
    floater = el('button', 'position:fixed;left:14px;bottom:14px;z-index:2147483645;padding:7px 12px;border-radius:999px;border:1px solid ' + (dark() ? '#3f3d39' : '#e5e1da') + ';cursor:pointer;font:12.5px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.12);' + (dark() ? 'background:#2c2b28;color:#ecebe7' : 'background:#fff;color:#262522'), '切换到已保存账号（' + accounts.length + '）', document.body);
    floater.type = 'button'; floater.onclick = () => void openPanel(null);
  }

  // ---------------- 启动 ----------------
  try { GM_registerMenuCommand('Arena 账号切换', () => void openPanel(null)); GM_registerMenuCommand('账号密码备忘录', () => openMemo()); } catch {}
  let scanQueued = false;
  const scan = () => { scanQueued = false; const d = profileDialog(); if (d) { injectButton(d); } replaceLogin(); };
  new MutationObserver(() => { if (!scanQueued) { scanQueued = true; requestAnimationFrame(scan); } }).observe(document.documentElement, { childList: true, subtree: true });
  (async () => {
    await checkPending();
    await syncCurrent();
    lastSeen = currentId;
    paintFloater();
    log('v' + VERSION + ' · Cookie 模式 ' + cookieMode + ' · 已保存 ' + accounts.length + ' 个账号' + (currentId ? ' · 当前 ' + currentId : ' · 未登录'));
  })();
  // 令牌会被 Arena 轮换：定期把最新 Cookie 写回当前账号
  // 运行中账号变化（例如在 Arena 登录页登录后没有整页刷新）：通知主脚本刷新限流/脉冲/额度
  let lastSeen, tick = 0;
  const watch = async () => {
    const before = lastSeen; await syncCurrent(); paintFloater();
    if (before !== undefined && currentId !== before) {
      log('账号变化', before, '→', currentId);
      if (currentId) { try { window.dispatchEvent(new CustomEvent('amp:account', { detail: String(currentId) })); } catch {} }
    }
    lastSeen = currentId;
  };
  // 未登录时每 5 秒检查一次（尽快识别新登录），已登录时每 60 秒同步一次 Cookie
  setInterval(() => { tick++; if (!currentId || tick % 12 === 0) void watch(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void syncCurrent(); });
})();
