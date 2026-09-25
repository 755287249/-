// ==UserScript==
// @name         油猴脚本-额度大的用额度小的没必要用-Arena Native Suite
// @namespace    local.amp.native
// @version      1.11.79
// @description  【测试版】Arena 原生
// @match        https://arena.ai/*
// @run-at       document-start
// @grant        none
// @noframes
// @downloadURL  https://raw.githubusercontent.com/755287249/-/main/test/Arena-Native-Suite.user.js
// @updateURL    https://raw.githubusercontent.com/755287249/-/main/test/Arena-Native-Suite.user.js
// ==/UserScript==

(function mergedArenaTools(){
'use strict';
// Only one copy may run; installing this next to the original Lite script would double-hook fetch.
if (window.__AMP_NATIVE_SUITE__) return;
try { Object.defineProperty(window, '__AMP_NATIVE_SUITE__', { value: '1.11.79' }); } catch {}
// Claude 内部型号几乎都带 -vertex（渠道标记），默认不写进对话名/显示名
// v1.11.78 “-public”也是部署标记（grok-4.7-xhigh-public）：和 -vertex 一样不显示，档位才能识别出来（xhigh）
const noVertex = n => typeof n === 'string' ? n.replace(/-vertex(?=$|[-_\s·])/ig, '').replace(/-public(?=$|[\s·])/ig, '') : n;
// v1.11.78 Arena 服务端故障转移（原模型报错 / 超时 → 自动改派别的模型）：这一轮真正回答的是改派之后的模型。
// 失败的那次调用（failed）不算这一轮的模型；已改派、但新模型的调用还没出现在 Trace 里（failover.pending）= 还没识别出来，返回空。
const servingCalls = d => { const calls = Array.isArray(d?.calls) ? d.calls.filter(Boolean) : []; return d?.failover?.pending ? [] : calls.filter(c => !c.failed); };
// localStorage 写入：满了（QuotaExceededError）会静默失败，导致“保存了刷新又没了”。
// 失败时依次清掉可重建的大缓存（本地历史副本 / 排行榜缓存 / 型号变更记录）再重试，并把结果告诉调用方。
const ampStore = (() => {
  const PRUNE = ['amp.lite.v2.history', 'amp.native.rank.v1', 'amp.native.resp.v1', 'amp.lite.v2.logs'];
  let failed = 0;
  function set(key, value) {
    try { localStorage.setItem(key, value); return true; } catch {}
    for (const k of PRUNE) {
      if (k === key) continue;
      try { if (localStorage.getItem(k) === null) continue; localStorage.removeItem(k); } catch { continue; }
      try { localStorage.setItem(key, value); console.warn('[Arena Native] 本地存储已满，已清理缓存 ' + k + ' 后保存成功'); return true; } catch {}
    }
    failed++; console.warn('[Arena Native] 本地存储写入失败：' + key); return false;
  }
  function usage() { let n = 0, ours = 0; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i), v = localStorage.getItem(k) || ''; n += k.length + v.length; if (/^amp\./.test(k)) ours += k.length + v.length; } } catch {} return { total: n * 2, ours: ours * 2 }; }
  return { set, usage, get failed() { return failed; } };
})();

// UI bridge: original detector source remains unchanged between the markers below.
// Only the display text is mirrored; no credentials, trace bodies or prompts are copied.
const legacyDisplay = {
  revision: 0, onchange: null,
  data: { state: '等待验证', text: '等待发送内容', at: null },
  snapshot() { return { tool:'Independent detector display', detectorVersion:'8.1.0', ...this.data }; }
};
function mountLegacyDisplayBridge() {
  let discovery=null;
  const attach=()=>{
    const source=document.getElementById('__arena_backend_model_detector__');
    if(!source?.shadowRoot)return false;
    // Keep the original hidden UI alive so its unchanged functions continue to work.
    source.style.setProperty('display','none','important');
    source.setAttribute('aria-hidden','true');
    source.setAttribute('inert','');
    const shadow=source.shadowRoot;
    const update=()=>{
      const state=shadow.querySelector('.state')?.textContent||'等待验证';
      const text=shadow.querySelector('pre')?.textContent||'';
      if(state===legacyDisplay.data.state&&text===legacyDisplay.data.text)return;
      legacyDisplay.data={state,text,at:new Date().toISOString()};
      legacyDisplay.revision++;
      legacyDisplay.onchange?.();
    };
    const observer=new MutationObserver(update);
    observer.observe(shadow,{subtree:true,childList:true,characterData:true});
    update();discovery?.disconnect();return true;
  };
  if(!attach()){
    discovery=new MutationObserver(attach);
    discovery.observe(document.documentElement||document,{childList:true,subtree:true});
  }
}

// BEGIN ORIGINAL DETECTOR v8.1.0 — executable source preserved verbatim
(() => {
    'use strict';

    /*
     * ============================================================
     * 模型检测 v8.0
     *
     * UI：
     *
     * 等待验证    等待发送内容
     *
     * ↓
     *
     * 验证进行中  查询 Run ID
     *             查询 Trace
     *             扫描 AI Span
     *             查询 Model
     *             查询 Provider
     *             查询 Operation
     *
     * ↓
     *
     * Model: xxx
     * 思考等级: high / medium / low / unknown
     *
     * ============================================================
     */

    const originalFetch = window.fetch;

    const processedRuns = new Set();
    const processedSpans = new Set();

    let panel = null;

    /*
     * ------------------------------------------------------------
     * New Chat 自动刷新
     * ------------------------------------------------------------
     */

    let newChatReloadScheduled = false;

    function isNewChatLink(element) {

        if (!element) {
            return false;
        }

        const link =
            element.closest?.(
                'a[href="/agent"]'
            );

        if (!link) {
            return false;
        }

        const menuItem =
            link.closest(
                'li[data-sidebar="menu-item"]'
            );

        if (!menuItem) {
            return false;
        }

        const text =
            (link.textContent || '').trim();

        return (
            text.includes('New Chat') ||
            link.getAttribute('href') === '/agent'
        );
    }

    function scheduleNewChatReload() {

        if (newChatReloadScheduled) {
            return;
        }

        newChatReloadScheduled = true;

        log(
            'NEW CHAT CLICKED - waiting for /agent navigation...'
        );

        let attempts = 0;

        const checkNavigation = () => {

            attempts++;

            const pathname =
                window.location.pathname;

            if (
                pathname === '/agent' &&
                !(window.__AMP_NATIVE_GACHA_NAV__ > Date.now())
            ) {

                log(
                    'NEW CHAT NAVIGATION DETECTED - reloading page...'
                );

                try {

                    sessionStorage.setItem(
                        '__ARENA_NEW_CHAT_RELOADED__',
                        '1'
                    );

                } catch {}

                window.location.reload();

                return;
            }

            if (
                attempts < 50
            ) {

                setTimeout(
                    checkNavigation,
                    100
                );

                return;
            }

            log(
                'NEW CHAT navigation timeout.'
            );

            newChatReloadScheduled =
                false;
        };

        setTimeout(
            checkNavigation,
            100
        );
    }

    document.addEventListener(
        'click',
        event => {

            try {

                if (
                    !(window.__AMP_NATIVE_GACHA_NAV__ > Date.now()) &&
                    isNewChatLink(
                        event.target
                    )
                ) {

                    scheduleNewChatReload();
                }

            } catch (e) {

                warn(
                    'NEW CHAT CLICK DETECTION ERROR',
                    e
                );
            }

        },
        true
    );

    /* Compact UI: isolated styles; local preferences contain UI state only. */
    const UI_KEY = '__arena_detector_ui_v81__';
    let ui = null;
    let uiData = { phase: 'waiting', title: '等待验证', step: '等待发送内容', result: null };
    let uiPrefs = { side: 'right', y: 0.32 };
    try {
        const saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
        if (saved.side === 'left' || saved.side === 'right') uiPrefs.side = saved.side;
        if (Number.isFinite(saved.y)) uiPrefs.y = Math.max(0, Math.min(1, saved.y));
    } catch {}
    let expanded = false;
    let drag = null;
    let suppressClick = false;
    const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(uiPrefs)); } catch {} };

    function viewportBox() {
        const v = window.visualViewport;
        return { x: v?.offsetLeft || 0, y: v?.offsetTop || 0,
            w: v?.width || window.innerWidth, h: v?.height || window.innerHeight };
    }
    function positionPanel() {
        if (!panel || !ui || drag) return;
        const v = viewportBox(), margin = 10;
        panel.style.setProperty('max-width', Math.max(40, v.w - margin * 2) + 'px', 'important');
        ui.card.style.maxHeight = Math.max(44, v.h - margin * 2) + 'px';
        const r = panel.getBoundingClientRect();
        const x = uiPrefs.side === 'right' ? v.x + v.w - r.width - margin : v.x + margin;
        const range = Math.max(0, v.h - r.height - margin * 2);
        panel.style.setProperty('left', Math.max(v.x + margin, x) + 'px', 'important');
        panel.style.setProperty('top', (v.y + margin + range * uiPrefs.y) + 'px', 'important');
    }
    function setExpanded(value, restoreFocus = false) {
        expanded = !!value;
        if (!ui) return;
        ui.card.hidden = !expanded;
        ui.chip.hidden = expanded;
        ui.chip.setAttribute('aria-expanded', String(expanded));
        positionPanel();
        if (expanded) ui.close.focus({ preventScroll: true });
        else if (restoreFocus) ui.chip.focus({ preventScroll: true });
    }
    function ensurePanel() {
        if (panel && document.documentElement?.contains(panel)) return panel;
        if (panel && ui) {
            if (document.documentElement) document.documentElement.appendChild(panel);
            return panel;
        }
        panel = document.createElement('div');
        panel.id = '__arena_backend_model_detector__';
        for (const [key, value] of Object.entries({ position: 'fixed', 'z-index': '2147483647',
            display: 'block', margin: '0', padding: '0', border: '0', width: 'max-content',
            height: 'auto', background: 'transparent', 'pointer-events': 'auto',
            right: 'auto', bottom: 'auto', opacity: '1', transform: 'none', 'color-scheme': 'dark' })) {
            panel.style.setProperty(key, value, 'important');
        }
        const shadow = panel.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
        <style>
        :host{font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e9edf4;text-align:left}
        *{box-sizing:border-box} [hidden]{display:none!important}
        button{font:inherit;color:inherit;cursor:pointer;border:0;outline-offset:3px;-webkit-tap-highlight-color:transparent}
        button:focus-visible,summary:focus-visible{outline:2px solid #a8c6ff}
        .chip{display:flex;align-items:center;gap:8px;min-height:42px;padding:0 13px;border-radius:22px;
            background:rgba(24,28,36,.94);border:1px solid #ffffff24;box-shadow:0 4px 18px #0003;
            touch-action:none;user-select:none;max-width:160px;transition:background .16s}
        .chip:hover{background:#303744}.dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--tone,#99a5b7)}
        .chip-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:600}
        .chevron{color:#8894a8;font-size:12px}
        .card{width:310px;max-width:100%;overflow:auto;overscroll-behavior:contain;background:rgba(22,26,34,.97);
            border:1px solid #ffffff22;border-radius:18px;box-shadow:0 12px 44px #0005;scrollbar-width:thin}
        .header{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 15px;border-bottom:1px solid #ffffff0e}
        .handle{flex:1;min-width:0;min-height:34px;display:flex;align-items:center;gap:9px;touch-action:none;cursor:grab;user-select:none;font-size:12px;color:#c7d0df;background:transparent;padding:0;text-align:left}
        .grip{color:#667386}.close{width:36px;height:34px;border-radius:9px;background:#ffffff09;color:#b7c3d4;font-size:20px}
        .close:hover{background:#ffffff18}.body{padding:15px}.state{font-size:11px;color:var(--tone);margin-bottom:10px}
        .model{font:600 17px/1.45 system-ui,sans-serif;color:#f0f4fb;overflow-wrap:anywhere;max-height:160px;overflow:auto;user-select:text}
        .reason{display:inline-block;margin-top:12px;padding:5px 9px;border-radius:8px;background:#ffffff08;color:#c3cddd;font-size:12px;overflow-wrap:anywhere;max-width:100%}
        details{margin-top:14px;border-top:1px solid #ffffff0d;padding-top:10px}summary{cursor:pointer;color:#8797ad;font-size:12px;min-height:30px;display:list-item;list-style-position:inside}
        pre{font:11px/1.7 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:#adb9ca;max-height:210px;overflow:auto;margin:8px 0 0;user-select:text}
        .footer{display:flex;align-items:center;gap:10px;margin-top:12px;color:#68788e;font-size:10px}
        .copy{margin-left:auto;flex:none;background:#ffffff09;border-radius:8px;padding:7px 10px;font-size:11px;color:#b8c7db}
        .busy .dot{animation:pulse 1.4s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}
        @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
        </style>
        <button class="chip" type="button" aria-expanded="false" aria-controls="detector-card" title="点击展开 · 拖动可移位"><span class="dot"></span><span class="chip-label">检测</span><span class="chevron">⌃</span></button>
        <section class="card" id="detector-card" aria-label="检测信息" hidden>
            <div class="header"><button type="button" class="handle" title="拖动移动面板，方向键微调，Home 恢复位置" aria-label="移动检测面板"><span class="grip">⠿</span><span class="dot"></span><span>检测信息</span></button><button type="button" class="close" title="收起（Esc）" aria-label="收起面板">−</button></div>
            <div class="body"><div class="state" role="status" aria-live="polite"></div><div class="model"></div><div class="reason"></div>
            <details><summary>详细信息与依据</summary><pre></pre></details>
            <div class="footer"><span>拖动移位 · 点击外部收起</span><button type="button" class="copy">复制信息</button></div></div>
        </section>`;
        const find = s => shadow.querySelector(s);
        ui = { shadow, chip: find('.chip'), label: find('.chip-label'), card: find('.card'),
            close: find('.close'), handle: find('.handle'), state: find('.state'), model: find('.model'),
            reason: find('.reason'), details: find('details'), pre: find('pre'), copy: find('.copy') };
        ui.chip.addEventListener('click', () => { if (!suppressClick) setExpanded(true); });
        ui.close.addEventListener('click', () => setExpanded(false, true));
        ui.details.addEventListener('toggle', positionPanel);
        ui.copy.addEventListener('click', async () => {
            const text = uiData.result ? resultLines(uiData.result).join('\n') : `${uiData.title}：${uiData.step}`;
            try { await navigator.clipboard.writeText(text); ui.copy.textContent = '已复制'; }
            catch { ui.details.open = true; const selection = window.getSelection();
                const range = document.createRange(); range.selectNodeContents(ui.pre); selection?.removeAllRanges(); selection?.addRange(range);
                ui.copy.textContent = '请长按文字复制'; }
            setTimeout(() => { ui.copy.textContent = '复制信息'; }, 2200);
        });
        const start = event => {
            if (!event.isPrimary || event.button !== 0) return;
            suppressClick = false;
            const rect = panel.getBoundingClientRect();
            drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
            event.currentTarget.setPointerCapture(event.pointerId);
        };
        const move = event => {
            if (!drag || event.pointerId !== drag.id) return;
            const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx,dy) < 6) return;
            drag.moved = true;
            const v = viewportBox(), rect = panel.getBoundingClientRect();
            panel.style.setProperty('left', Math.max(v.x + 10, Math.min(v.x + v.w - rect.width - 10, drag.left + dx)) + 'px', 'important');
            panel.style.setProperty('top', Math.max(v.y + 10, Math.min(v.y + v.h - rect.height - 10, drag.top + dy)) + 'px', 'important');
        };
        const end = event => {
            if (!drag || event.pointerId !== drag.id) return;
            const moved = drag.moved;
            if (moved) {
                const v = viewportBox(), rect = panel.getBoundingClientRect();
                uiPrefs.side = rect.left + rect.width / 2 < v.x + v.w / 2 ? 'left' : 'right';
                uiPrefs.y = Math.max(0, Math.min(1, (rect.top - v.y - 10) / Math.max(1, v.h - rect.height - 20)));
                saveUi();
            }
            drag = null;
            suppressClick = moved || event.type === 'pointercancel';
            positionPanel();
            setTimeout(() => { suppressClick = false; }, 300);
        };
        for (const el of [ui.chip, ui.handle]) {
            el.addEventListener('pointerdown', start); el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
            el.addEventListener('lostpointercapture', end);
            el.addEventListener('keydown', event => {
                if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key)) return;
                event.preventDefault();
                if (event.key === 'Home') uiPrefs = { side: 'right', y: .32 };
                if (event.key === 'ArrowLeft') uiPrefs.side = 'left';
                if (event.key === 'ArrowRight') uiPrefs.side = 'right';
                if (event.key === 'ArrowUp') uiPrefs.y = Math.max(0, uiPrefs.y - .05);
                if (event.key === 'ArrowDown') uiPrefs.y = Math.min(1, uiPrefs.y + .05);
                saveUi(); positionPanel();
            });
        }
        document.addEventListener('pointerdown', event => {
            if (expanded && !event.composedPath().includes(panel)) setExpanded(false);
        }, true);
        document.addEventListener('keydown', event => {
            if (expanded && event.key === 'Escape') setExpanded(false, true);
        });
        window.addEventListener('resize', positionPanel, { passive: true });
        window.visualViewport?.addEventListener('resize', positionPanel, { passive: true });
        window.visualViewport?.addEventListener('scroll', positionPanel, { passive: true });
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(positionPanel).observe(panel);
        const mount = () => {
            if (!panel.isConnected && document.documentElement) document.documentElement.appendChild(panel);
            positionPanel();
        };
        if (document.documentElement) mount();
        else document.addEventListener('DOMContentLoaded', mount, { once: true });
        return panel;
    }
    function resultLines(result) {
        const lines = [`Model: ${result?.model || 'unknown'}`, `思考等级: ${result?.reasoning?.display || 'unknown'}`];
        if (result?.internalModel && result.internalModel !== result.model) lines.push(`Arena 配置: ${result.internalModel}`);
        if (result?.reasoning?.source) lines.push(`依据: ${result.reasoning.source}`);
        if (Array.isArray(result?.reasoningTokens) && result.reasoningTokens.length) lines.push(`推理 Token: ${result.reasoningTokens.join(' / ')}（用量，不等于档位）`);
        if (result?.error) lines.push(`错误: ${result.error}`);
        return lines;
    }
    function renderDetectorUi() {
        ensurePanel();
        const busy = uiData.phase === 'verifying';
        const known = uiData.result?.model && uiData.result.model !== 'unknown';
        panel.style.setProperty('--tone', busy ? '#eac77b' : uiData.phase === 'result' ? (known ? '#8fdeb2' : '#eac77b') : '#99a5b7');
        ui.chip.classList.toggle('busy', busy); ui.card.classList.toggle('busy', busy);
        ui.label.textContent = busy ? '查询中' : uiData.phase === 'result' ? (known ? '查看结果' : '未识别') : '待检测';
        ui.chip.setAttribute('aria-label', `${ui.label.textContent}，点击展开检测信息`);
        ui.state.textContent = uiData.title;
        ui.model.textContent = uiData.result ? (uiData.result.model || 'unknown') : uiData.step;
        ui.reason.hidden = !uiData.result;
        ui.reason.textContent = uiData.result ? `思考等级 · ${uiData.result.reasoning?.display || 'unknown'}` : '';
        ui.pre.textContent = uiData.result ? resultLines(uiData.result).join('\n') : `${uiData.title}：${uiData.step}`;
        positionPanel();
    }
    function setPanelWaiting() {
        uiData = { phase: 'waiting', title: '等待验证', step: '发送内容后开始检测', result: null };
        renderDetectorUi();
    }
    function setPanelVerifying(step = '等待开始') {
        uiData = { phase: 'verifying', title: '验证进行中', step, result: null };
        renderDetectorUi();
    }
    function setPanelResult(result) {
        uiData = { phase: 'result', title: result?.error ? '检测结束 · 存在错误' : '检测结果', step: '', result };
        renderDetectorUi(); // Never auto-open or interrupt typing when results arrive.
    }

    /*
     * ------------------------------------------------------------
     * Console logging
     * ------------------------------------------------------------
     */

    function log(...args) {

        console.log(
            '%c[ARENA MODEL]',
            'background:#171717;color:#5cff8d;font-weight:bold',
            ...args
        );
    }

    function warn(...args) {

        console.warn(
            '%c[ARENA MODEL]',
            'background:#3a2900;color:#ffd479;font-weight:bold',
            ...args
        );
    }

    function error(...args) {

        console.error(
            '%c[ARENA MODEL]',
            'background:#3b0000;color:#ff8080;font-weight:bold',
            ...args
        );
    }

    /*
     * ------------------------------------------------------------
     * JWT
     * ------------------------------------------------------------
     */

    function decodeJwtPayload(
        token
    ) {

        try {

            if (
                !token ||
                typeof token !== 'string'
            ) {
                return null;
            }

            const clean =
                token.replace(
                    /^Bearer\s+/i,
                    ''
                );

            const parts =
                clean.split('.');

            if (
                parts.length !== 3
            ) {
                return null;
            }

            let b64 =
                parts[1]
                    .replace(/-/g, '+')
                    .replace(/_/g, '/');

            while (
                b64.length % 4 !== 0
            ) {

                b64 += '=';
            }

            const binary =
                atob(b64);

            const bytes =
                Uint8Array.from(
                    binary,
                    x =>
                        x.charCodeAt(0)
                );

            const decoded =
                new TextDecoder().decode(
                    bytes
                );

            return JSON.parse(
                decoded
            );

        } catch {

            return null;
        }
    }

    function extractRunInfo(
        token
    ) {

        const payload =
            decodeJwtPayload(
                token
            );

        if (!payload) {

            return {
                runId: null,
                payload: null
            };
        }

        const scopes =
            Array.isArray(
                payload.scopes
            )
                ? payload.scopes
                : [];

        const scope =
            scopes.find(
                value =>
                    typeof value === 'string' &&
                    value.startsWith(
                        'read:runs:'
                    )
            );

        return {

            runId:
                scope
                    ? scope.slice(
                        'read:runs:'.length
                    )
                    : null,

            payload
        };
    }

    /*
     * ------------------------------------------------------------
     * SSE
     * ------------------------------------------------------------
     */

    function processSseEvent(
        eventText
    ) {

        if (
            !eventText ||
            !eventText.trim()
        ) {
            return;
        }

        let eventName =
            '';

        for (
            const line
                of eventText.split(/\r?\n/)
        ) {

            if (
                line.startsWith(
                    'event:'
                )
            ) {

                eventName =
                    line.slice(
                        6
                    ).trim();

                break;
            }
        }

        if (
            eventName !== 'batch'
        ) {
            return;
        }

        const dataLines =
            eventText
                .split(/\r?\n/)
                .filter(
                    line =>
                        line.startsWith(
                            'data:'
                        )
                )
                .map(
                    line =>
                        line
                            .slice(5)
                            .trim()
                );

        if (
            !dataLines.length
        ) {
            return;
        }

        try {

            const parsed =
                JSON.parse(
                    dataLines.join('\n')
                );

            processBatch(
                parsed
            );

        } catch (e) {

            warn(
                'SSE batch parse failed',
                e
            );
        }
    }

    function processBatch(
        parsed
    ) {

        if (
            !parsed ||
            !Array.isArray(
                parsed.records
            )
        ) {
            return;
        }

        for (
            const record
                of parsed.records
        ) {

            if (
                !record ||
                typeof record !== 'object'
            ) {
                continue;
            }

            const headers =
                Array.isArray(
                    record.headers
                )
                    ? record.headers
                    : null;

            if (!headers) {
                continue;
            }

            let turnComplete =
                false;

            let token =
                null;

            for (
                const pair of headers
            ) {

                if (
                    !Array.isArray(pair) ||
                    pair.length < 2
                ) {
                    continue;
                }

                const name =
                    String(pair[0])
                        .toLowerCase();

                const value =
                    pair[1];

                if (
                    name ===
                        'trigger-control' &&
                    value ===
                        'turn-complete'
                ) {

                    turnComplete =
                        true;
                }

                if (
                    name ===
                        'public-access-token' &&
                    typeof value ===
                        'string'
                ) {

                    token =
                        value;
                }
            }

            if (
                !turnComplete
            ) {
                continue;
            }

            log(
                'TURN COMPLETE',
                {
                    seq:
                        record.seq_num,

                    hasToken:
                        !!token
                }
            );

            if (!token) {
                continue;
            }

            handleRunToken(
                token
            );
        }
    }

    /*
     * ------------------------------------------------------------
     * Run token
     * ------------------------------------------------------------
     */

    function handleRunToken(
        token
    ) {

        const {
            runId
        } =
            extractRunInfo(
                token
            );

        /*
         * 查询 Run ID
         */

        setPanelVerifying(
            '查询 Run ID'
        );

        if (!runId) {

            warn(
                'Public token found but read:runs scope missing.'
            );

            return;
        }

        window.__ARENA_RUN_ID__ =
            runId;

        window.__ARENA_RUN_TOKEN__ =
            token;

        log(
            'RUN ID:',
            runId
        );

        /*
         * 找到 Run ID 后继续。
         */

        setPanelVerifying(
            '查询 Trace'
        );

        if (
            processedRuns.has(
                runId
            )
        ) {

            return;
        }

        /*
         * Set 只表示“当前正在读取”。同一个 Agent run 可能包含多轮，
         * 本轮结束后删除，下一轮仍可重新读取最新的 chat turn。
         */

        processedRuns.add(
            runId
        );

        fetchTrace(
            runId,
            token
        ).finally(() => {

            processedRuns.delete(
                runId
            );
        });
    }

    /*
     * ------------------------------------------------------------
     * Trigger Trace
     * ------------------------------------------------------------
     */

    const DETAIL_MESSAGES = new Set([
        'ai.streamText.doStream',
        'token.usage.recorded',
        'spend.recorded'
    ]);

    const wait = ms =>
        new Promise(resolve => setTimeout(resolve, ms));

    async function fetchJson(
        url,
        token,
        maxBytes = 4 * 1024 * 1024
    ) {

        const response =
            await originalFetch(
                url,
                {
                    method: 'GET',

                    headers: {
                        Authorization:
                            `Bearer ${token}`,

                        Accept:
                            'application/json'
                    },

                    credentials:
                        'omit',

                    redirect:
                        'error',

                    cache:
                        'no-store'
                }
            );

        const text =
            await response.text();

        if (!response.ok) {

            const e =
                new Error(
                    `HTTP ${response.status}`
                );

            e.status =
                response.status;

            throw e;
        }

        if (text.length > maxBytes) {
            throw new Error(
                '响应过大，已停止解析'
            );
        }

        return JSON.parse(
            text
        );
    }

    function selectEventCandidates(
        trace,
        runId
    ) {

        if (!Array.isArray(trace?.events)) {
            return [];
        }

        let currentTurn =
            null;

        const selected =
            [];

        for (const event of trace.events) {

            if (
                !event ||
                event.runId !== runId ||
                typeof event.message !== 'string'
            ) {
                continue;
            }

            const turn =
                event.message.match(
                    /^chat turn (\d{1,4})$/
                );

            if (turn) {

                currentTurn =
                    Number(turn[1]);

                continue;
            }

            if (
                !DETAIL_MESSAGES.has(
                    event.message
                ) ||
                typeof event.spanId !== 'string'
            ) {
                continue;
            }

            selected.push({
                spanId:
                    event.spanId,

                runId:
                    event.runId,

                message:
                    event.message,

                turn:
                    currentTurn,

                partial:
                    event.isPartial !== false,

                path:
                    '$.events'
            });
        }

        const numbered =
            selected.filter(
                item =>
                    Number.isSafeInteger(
                        item.turn
                    )
            );

        const latestTurn =
            numbered.length
                ? Math.max(
                    ...numbered.map(
                        item => item.turn
                    )
                )
                : null;

        const latest =
            latestTurn === null
                ? selected
                : selected.filter(
                    item =>
                        item.turn === latestTurn
                );

        const seen =
            new Set();

        return latest
            .filter(item => {

                if (
                    seen.has(
                        item.spanId
                    )
                ) {
                    return false;
                }

                seen.add(
                    item.spanId
                );

                return true;
            })
            .slice(-24);
    }

    function selectTraceCandidates(
        spans
    ) {

        const exact =
            spans.filter(
                span =>
                    DETAIL_MESSAGES.has(
                        span.message
                    )
            );

        const ai =
            spans.filter(
                span =>
                    isLikelyAiSpan(
                        span
                    )
            );

        const source =
            exact.length
                ? [...exact, ...ai]
                : ai.length
                    ? ai
                    : spans;

        const seen =
            new Set();

        return source
            .filter(item => {

                if (
                    !item.spanId ||
                    seen.has(item.spanId)
                ) {
                    return false;
                }

                seen.add(item.spanId);

                return true;
            })
            .slice(-24);
    }

    function detailSetReady(
        candidates
    ) {

        const messages =
            new Set(
                candidates.map(
                    item => item.message
                )
            );

        return (
            messages.has(
                'ai.streamText.doStream'
            ) &&
            messages.has(
                'token.usage.recorded'
            ) &&
            messages.has(
                'spend.recorded'
            ) &&
            candidates.every(
                item => !item.partial
            )
        );
    }

    async function fetchTrace(
        runId,
        token
    ) {

        let candidates =
            [];

        let eventsWorked =
            false;

        try {

            /*
             * 先读取 /events。内部 modelName 通常不在 AI stream span，
             * 而在 token.usage.recorded / spend.recorded 中。
             */

            for (
                let attempt = 1;
                attempt <= 8;
                attempt++
            ) {

                setPanelVerifying(
                    `查询 Trace ${attempt}/8`
                );

                const url =
                    `https://api.trigger.dev/api/v1/runs/${encodeURIComponent(runId)}/events`;

                log(
                    'EVENTS REQUEST',
                    url
                );

                let json;

                try {

                    json =
                        await fetchJson(
                            url,
                            token
                        );

                    eventsWorked =
                        true;

                } catch (e) {

                    if (e?.status === 429) {
                        throw new Error(
                            'Trace 接口限流（HTTP 429）'
                        );
                    }

                    warn(
                        'EVENTS REQUEST FAILED - fallback to /trace',
                        e
                    );

                    break;
                }

                const current =
                    selectEventCandidates(
                        json,
                        runId
                    );

                if (current.length) {
                    candidates =
                        current;
                }

                log(
                    'DETAIL SPANS FOUND',
                    candidates.map(item => ({
                        message: item.message,
                        spanId: item.spanId,
                        turn: item.turn,
                        partial: item.partial
                    }))
                );

                if (
                    detailSetReady(
                        candidates
                    ) ||
                    attempt === 8
                ) {
                    break;
                }

                await wait(
                    1500
                );
            }

            /*
             * 兼容旧脚本使用的 /trace 树形接口；/events 不可用或未列出
             * 目标 span 时再回退，不会把任意字段误当思考档位。
             */

            const messages =
                new Set(
                    candidates.map(
                        item => item.message
                    )
                );

            if (
                !candidates.length ||
                (
                    !messages.has('token.usage.recorded') &&
                    !messages.has('spend.recorded')
                )
            ) {

                setPanelVerifying(
                    '查询 Trace（兼容接口）'
                );

                const url =
                    `https://api.trigger.dev/api/v1/runs/${encodeURIComponent(runId)}/trace`;

                const json =
                    await fetchJson(
                        url,
                        token
                    );

                const spans =
                    collectTraceSpans(
                        json
                    );

                log(
                    'TRACE SPANS FOUND',
                    spans.length
                );

                const fallback =
                    selectTraceCandidates(
                        spans
                    );

                const seen =
                    new Set();

                candidates =
                    [...candidates, ...fallback]
                        .filter(item => {

                            if (
                                !item.spanId ||
                                seen.has(item.spanId)
                            ) {
                                return false;
                            }

                            seen.add(item.spanId);

                            return true;
                        })
                        .slice(-24);

                if (!candidates.length) {

                    debugTrace(
                        json
                    );

                    throw new Error(
                        'Trace 中没有可读取的模型 span'
                    );
                }
            }

            setPanelVerifying(
                '读取模型与思考档位'
            );

            const result =
                await fetchSpanDetails(
                    runId,
                    token,
                    candidates
                );

            showModelResult(
                result
            );

            return result;

        } catch (e) {

            error(
                'TRACE FETCH FAILED',
                e
            );

            const result =
                buildFinalResult(
                    createAggregate(
                        runId
                    )
                );

            result.error =
                e?.message ||
                'Trace 读取失败';

            if (!eventsWorked) {
                result.reasoning.source =
                    result.error;
            }

            showModelResult(
                result
            );

            return result;
        }
    }

    /*
     * ------------------------------------------------------------
     * Trace span tree
     * ------------------------------------------------------------
     */

    function collectTraceSpans(
        traceResponse
    ) {

        const results =
            [];

        const visited =
            new WeakSet();

        const root =
            traceResponse?.trace
                ?.rootSpan;

        function visit(
            span,
            path
        ) {

            if (
                !span ||
                typeof span !== 'object'
            ) {
                return;
            }

            if (
                visited.has(span)
            ) {
                return;
            }

            visited.add(
                span
            );

            const data =
                span.data ||
                {};

            results.push({

                span,

                spanId:
                    span.id ||
                    span.spanId ||
                    null,

                parentId:
                    span.parentId ||
                    null,

                runId:
                    span.runId ||
                    null,

                message:
                    typeof data.message ===
                        'string'
                        ? data.message
                        : '',

                properties:
                    data.properties ||
                    span.properties ||
                    null,

                events:
                    data.events ||
                    span.events ||
                    null,

                output:
                    data.output,

                path
            });

            const children =
                Array.isArray(
                    span.children
                )
                    ? span.children
                    : [];

            for (
                let i = 0;
                i < children.length;
                i++
            ) {

                visit(
                    children[i],
                    `${path}.children[${i}]`
                );
            }
        }

        if (root) {

            visit(
                root,
                '$.trace.rootSpan'
            );

        } else {

            recursiveFindSpans(
                traceResponse?.trace ||
                    traceResponse,
                '$',
                results,
                visited
            );
        }

        return results;
    }

    function recursiveFindSpans(
        value,
        path,
        results,
        visited
    ) {

        if (
            !value ||
            typeof value !== 'object'
        ) {
            return;
        }

        if (
            visited.has(value)
        ) {
            return;
        }

        visited.add(
            value
        );

        if (
            value.id &&
            value.data &&
            typeof value.data === 'object'
        ) {

            results.push({

                span:
                    value,

                spanId:
                    value.id,

                parentId:
                    value.parentId ||
                    null,

                runId:
                    value.runId ||
                    null,

                message:
                    typeof value.data.message ===
                        'string'
                        ? value.data.message
                        : '',

                properties:
                    value.data.properties ||
                    null,

                events:
                    value.data.events ||
                    null,

                output:
                    value.data.output,

                path
            });
        }

        for (
            const [key, child]
                of Object.entries(value)
        ) {

            if (
                child &&
                typeof child === 'object'
            ) {

                recursiveFindSpans(
                    child,
                    `${path}.${key}`,
                    results,
                    visited
                );
            }
        }
    }

    /*
     * ------------------------------------------------------------
     * AI span detection
     * ------------------------------------------------------------
     */

    function isLikelyAiSpan(
        item
    ) {

        const strings =
            [];

        collectSearchableText(
            item.message,
            strings,
            0
        );

        collectSearchableText(
            item.properties,
            strings,
            0
        );

        collectSearchableText(
            item.events,
            strings,
            0
        );

        const text =
            strings
                .join(' ')
                .toLowerCase();

        return (
            text.includes(
                'ai.streamtext'
            ) ||
            text.includes(
                'streamtext'
            ) ||
            text.includes(
                'dostream'
            ) ||
            text.includes(
                'gen_ai'
            ) ||
            hasNestedKey(
                item.properties,
                'gen_ai'
            )
        );
    }

    function collectSearchableText(
        value,
        output,
        depth
    ) {

        if (
            depth > 20
        ) {
            return;
        }

        if (
            typeof value === 'string'
        ) {

            output.push(
                value
            );

            return;
        }

        if (
            !value ||
            typeof value !== 'object'
        ) {
            return;
        }

        for (
            const [key, child]
                of Object.entries(value)
        ) {

            output.push(
                key
            );

            collectSearchableText(
                child,
                output,
                depth + 1
            );
        }
    }

    function hasNestedKey(
        obj,
        target
    ) {

        if (
            !obj ||
            typeof obj !== 'object'
        ) {
            return false;
        }

        for (
            const [key, value]
                of Object.entries(obj)
        ) {

            if (
                key === target
            ) {
                return true;
            }

            if (
                value &&
                typeof value === 'object' &&
                hasNestedKey(
                    value,
                    target
                )
            ) {

                return true;
            }
        }

        return false;
    }

    /*
     * ------------------------------------------------------------
     * Span details
     * ------------------------------------------------------------
     */

    function createAggregate(
        runId
    ) {

        return {
            runId,
            spanIds: [],
            internalModels: [],
            requestModels: [],
            responseModels: [],
            fallbackModels: [],
            providers: [],
            operations: [],
            explicitEfforts: [],
            thinkingBudgets: [],
            thinkingStates: [],
            reasoningTokens: [],
            settingKeys: []
        };
    }

    function addUnique(
        list,
        value
    ) {

        if (
            value === null ||
            value === undefined ||
            value === ''
        ) {
            return;
        }

        if (
            !list.some(
                item =>
                    JSON.stringify(item) ===
                    JSON.stringify(value)
            )
        ) {
            list.push(value);
        }
    }

    function cleanLabel(
        value
    ) {

        return (
            typeof value === 'string' &&
            value.trim() &&
            value.length <= 240 &&
            !/[\u0000-\u001f\u007f]/.test(value)
        )
            ? value.trim()
            : null;
    }

    function cleanCount(
        value
    ) {

        return (
            Number.isSafeInteger(value) &&
            value >= 0
        )
            ? value
            : null;
    }

    function getPath(
        object,
        path
    ) {

        if (
            !object ||
            typeof object !== 'object'
        ) {
            return undefined;
        }

        if (
            Object.prototype.hasOwnProperty.call(
                object,
                path
            )
        ) {
            return object[path];
        }

        let current =
            object;

        for (
            const part of path.split('.')
        ) {

            if (
                !current ||
                typeof current !== 'object' ||
                !Object.prototype.hasOwnProperty.call(
                    current,
                    part
                )
            ) {
                return undefined;
            }

            current =
                current[part];
        }

        return current;
    }

    function firstLabel(
        object,
        paths
    ) {

        for (const path of paths) {

            const value =
                cleanLabel(
                    getPath(
                        object,
                        path
                    )
                );

            if (value) {
                return value;
            }
        }

        return null;
    }

    function parseObject(
        value
    ) {

        if (
            value &&
            typeof value === 'object'
        ) {
            return value;
        }

        if (
            typeof value === 'string' &&
            value.length < 65536
        ) {

            try {

                const parsed =
                    JSON.parse(value);

                return (
                    parsed &&
                    typeof parsed === 'object'
                )
                    ? parsed
                    : null;

            } catch {}
        }

        return null;
    }

    function normalizeTier(
        value
    ) {

        if (typeof value !== 'string') {
            return null;
        }

        const normalized =
            value
                .trim()
                .toLowerCase()
                .replace(/[\s_]+/g, '-')
                .replace(/^extra-high$/, 'xhigh')
                .replace(/^x-high$/, 'xhigh');

        return [
            'minimal',
            'low',
            'medium',
            'high',
            'xhigh',
            'max'
        ].includes(normalized)
            ? normalized
            : null;
    }

    function tierFromInternalModel(
        model
    ) {

        if (typeof model !== 'string') {
            return null;
        }

        /*
         * 同时兼容：xxx-high 与 xxx-max-20260910。
         * 只在 Arena 内部 modelName 上使用，不拿供应商型号猜档位。
         */

        const match =
            model
                .toLowerCase()
                .match(
                    /-(xhigh|high|medium|low|max|minimal)(?:-\d{8})?$/
                );

        return match?.[1] ||
            null;
    }

    function recordEffort(
        aggregate,
        value,
        path
    ) {

        const tier =
            normalizeTier(
                value
            );

        if (tier) {

            addUnique(
                aggregate.explicitEfforts,
                {
                    tier,
                    path
                }
            );

            return;
        }

        if (
            typeof value === 'boolean'
        ) {

            addUnique(
                aggregate.thinkingStates,
                {
                    value:
                        value
                            ? 'enabled'
                            : 'disabled',
                    path
                }
            );

            return;
        }

        if (typeof value === 'string') {

            const state =
                value
                    .trim()
                    .toLowerCase();

            if (
                [
                    'enabled',
                    'disabled',
                    'auto',
                    'on',
                    'off',
                    'none'
                ].includes(state)
            ) {

                addUnique(
                    aggregate.thinkingStates,
                    {
                        value: state,
                        path
                    }
                );
            }
        }
    }

    function scanReasoningObject(
        value,
        prefix,
        aggregate,
        depth = 0,
        budget = { left: 80 }
    ) {

        if (
            depth > 6 ||
            budget.left <= 0
        ) {
            return;
        }

        const parsed =
            parseObject(value) ||
            value;

        if (
            !parsed ||
            typeof parsed !== 'object'
        ) {
            return;
        }

        for (
            const [key, child]
                of Object.entries(parsed)
        ) {

            if (budget.left-- <= 0) {
                break;
            }

            const path =
                prefix
                    ? `${prefix}.${key}`
                    : key;

            const compact =
                key
                    .toLowerCase()
                    .replace(/[._-]/g, '');

            const context =
                path.toLowerCase();

            if (
                compact === 'reasoningeffort' ||
                (
                    compact === 'effort' &&
                    /reason|thinking/.test(context)
                )
            ) {

                recordEffort(
                    aggregate,
                    child,
                    path
                );
            }

            if (
                [
                    'budgettokens',
                    'thinkingbudget',
                    'thinkingbudgettokens'
                ].includes(compact)
            ) {

                const count =
                    cleanCount(child);

                if (count !== null) {

                    addUnique(
                        aggregate.thinkingBudgets,
                        {
                            tokens: count,
                            path
                        }
                    );
                }
            }

            if (
                [
                    'reasoningtokens',
                    'thinkingtokens'
                ].includes(compact)
            ) {

                const count =
                    cleanCount(child);

                if (count !== null) {

                    addUnique(
                        aggregate.reasoningTokens,
                        count
                    );
                }
            }

            if (
                /reason|thinking/.test(context) &&
                [
                    'type',
                    'mode',
                    'enabled'
                ].includes(compact)
            ) {

                recordEffort(
                    aggregate,
                    child,
                    path
                );
            }

            if (
                child &&
                typeof child === 'object'
            ) {

                scanReasoningObject(
                    child,
                    path,
                    aggregate,
                    depth + 1,
                    budget
                );
            }
        }
    }

    function mergeSpanDetail(
        aggregate,
        detail,
        candidate
    ) {

        const properties =
            (
                detail?.properties &&
                typeof detail.properties === 'object'
            )
                ? detail.properties
                : (
                    detail?.data?.properties &&
                    typeof detail.data.properties === 'object'
                )
                    ? detail.data.properties
                    : {};

        const message =
            cleanLabel(
                detail?.message
            ) ||
            candidate.message ||
            '';

        addUnique(
            aggregate.spanIds,
            candidate.spanId
        );

        const internalModel =
            firstLabel(
                properties,
                [
                    'modelName',
                    'model_name'
                ]
            );

        if (
            internalModel &&
            (
                message === 'token.usage.recorded' ||
                message === 'spend.recorded'
            )
        ) {

            addUnique(
                aggregate.internalModels,
                internalModel
            );
        }

        const requestModel =
            firstLabel(
                properties,
                [
                    'ai.telemetry.metadata.apiModelName',
                    'gen_ai.request.model',
                    'ai.model.id',
                    'apiModelName'
                ]
            );

        const responseModel =
            firstLabel(
                properties,
                [
                    'ai.response.model',
                    'gen_ai.response.model'
                ]
            );

        const provider =
            firstLabel(
                properties,
                [
                    'ai.model.provider',
                    'provider'
                ]
            );

        const operation =
            firstLabel(
                properties,
                [
                    'ai.operation.name',
                    'ai.operationName',
                    'operationName',
                    'operation_name'
                ]
            );

        addUnique(
            aggregate.requestModels,
            requestModel
        );

        addUnique(
            aggregate.responseModels,
            responseModel
        );

        addUnique(
            aggregate.providers,
            provider
        );

        addUnique(
            aggregate.operations,
            operation || message
        );

        /*
         * 显式 reasoning effort：值可直接作为档位证据。
         */

        for (
            const path of [
                'ai.settings.reasoningEffort',
                'ai.settings.reasoning_effort',
                'gen_ai.request.reasoning_effort',
                'gen_ai.request.reasoningEffort'
            ]
        ) {

            const value =
                getPath(
                    properties,
                    path
                );

            if (value !== undefined) {

                addUnique(
                    aggregate.settingKeys,
                    path
                );

                recordEffort(
                    aggregate,
                    value,
                    path
                );
            }
        }

        const thinking =
            getPath(
                properties,
                'ai.settings.thinking'
            );

        if (thinking !== undefined) {

            addUnique(
                aggregate.settingKeys,
                'ai.settings.thinking'
            );

            if (
                thinking &&
                typeof thinking === 'object'
            ) {

                scanReasoningObject(
                    thinking,
                    'ai.settings.thinking',
                    aggregate
                );

            } else {

                recordEffort(
                    aggregate,
                    thinking,
                    'ai.settings.thinking'
                );
            }
        }

        for (
            const path of [
                'ai.settings.providerOptions',
                'ai.prompt.providerOptions'
            ]
        ) {

            const options =
                getPath(
                    properties,
                    path
                );

            if (options !== undefined) {

                addUnique(
                    aggregate.settingKeys,
                    path
                );

                scanReasoningObject(
                    options,
                    path,
                    aggregate
                );
            }
        }

        const providerMetadata =
            getPath(
                properties,
                'ai.response.providerMetadata'
            );

        if (providerMetadata !== undefined) {

            addUnique(
                aggregate.settingKeys,
                'ai.response.providerMetadata'
            );

            /*
             * response metadata 主要是实际用量；只记录 token/budget/state，
             * 不把 reasoning_tokens 数量映射成 high/medium/low。
             */

            scanReasoningObject(
                providerMetadata,
                'ai.response.providerMetadata',
                aggregate
            );
        }

        for (
            const path of [
                'reasoningTokens',
                'ai.usage.reasoningTokens'
            ]
        ) {

            const count =
                cleanCount(
                    getPath(
                        properties,
                        path
                    )
                );

            if (count !== null) {

                addUnique(
                    aggregate.reasoningTokens,
                    count
                );
            }
        }

        /*
         * 保留原脚本的宽松模型兼容逻辑，但只作为最后回退，
         * 不用它判断思考档位。
         */

        const generic =
            extractAiInfo(
                detail
            );

        addUnique(
            aggregate.fallbackModels,
            cleanLabel(
                generic.model
            )
        );

        addUnique(
            aggregate.providers,
            cleanLabel(
                generic.provider
            )
        );

        addUnique(
            aggregate.operations,
            cleanLabel(
                generic.operationName
            )
        );
    }

    function resolveReasoning(
        aggregate
    ) {

        const explicit =
            [
                ...new Set(
                    aggregate.explicitEfforts.map(
                        item => item.tier
                    )
                )
            ];

        const modelTiers =
            aggregate.internalModels
                .map(model => ({
                    model,
                    tier:
                        tierFromInternalModel(
                            model
                        )
                }))
                .filter(item => item.tier);

        const suffixes =
            [
                ...new Set(
                    modelTiers.map(
                        item => item.tier
                    )
                )
            ];

        if (explicit.length) {

            const level =
                explicit.length === 1
                    ? explicit[0]
                    : null;

            let source =
                '显式参数 ' +
                aggregate.explicitEfforts
                    .map(item => item.path)
                    .join(' / ');

            if (
                suffixes.length &&
                (
                    suffixes.length !== explicit.length ||
                    suffixes.some(
                        tier =>
                            !explicit.includes(tier)
                    )
                )
            ) {

                source +=
                    `；内部 modelName 后缀=${suffixes.join('/')}`;
            }

            return {
                level,
                display:
                    level ||
                    `冲突（${explicit.join(' / ')}）`,
                source,
                kind:
                    'explicit'
            };
        }

        if (suffixes.length) {

            const level =
                suffixes.length === 1
                    ? suffixes[0]
                    : null;

            return {
                level,
                display:
                    level ||
                    `冲突（${suffixes.join(' / ')}）`,
                source:
                    'Arena 内部 modelName 后缀：' +
                    modelTiers
                        .map(
                            item => item.model
                        )
                        .join(' / '),
                kind:
                    'modelName-suffix'
            };
        }

        if (aggregate.thinkingBudgets.length) {

            const budgets =
                [
                    ...new Set(
                        aggregate.thinkingBudgets.map(
                            item => item.tokens
                        )
                    )
                ];

            return {
                level: null,
                display:
                    `已启用（budget ${budgets.join(' / ')} tokens）`,
                source:
                    '显式 thinking budget；没有可映射的 high/medium/low',
                kind:
                    'budget'
            };
        }

        if (aggregate.thinkingStates.length) {

            const states =
                [
                    ...new Set(
                        aggregate.thinkingStates.map(
                            item => item.value
                        )
                    )
                ];

            return {
                level: null,
                display:
                    states.join(' / '),
                source:
                    '显式 thinking 状态；未提供强度档位',
                kind:
                    'state'
            };
        }

        return {
            level: null,
            display: 'unknown',
            source:
                'trace 未提供 reasoningEffort/thinking 档位，且内部 modelName 无档位后缀',
            kind:
                'unknown'
        };
    }

    function joinValues(
        values
    ) {

        return values.length
            ? values.join(' / ')
            : null;
    }

    function buildFinalResult(
        aggregate
    ) {

        const responseModel =
            joinValues(
                aggregate.responseModels
            );

        const requestModel =
            joinValues(
                aggregate.requestModels
            );

        const fallbackModel =
            joinValues(
                aggregate.fallbackModels
            );

        const internalModel =
            joinValues(
                aggregate.internalModels
            );

        return {
            runId:
                aggregate.runId,

            spanIds:
                [...aggregate.spanIds],

            model:
                responseModel ||
                requestModel ||
                fallbackModel ||
                internalModel ||
                'unknown',

            internalModel,
            requestModel,
            responseModel,

            provider:
                joinValues(
                    aggregate.providers
                ) ||
                'unknown',

            operationName:
                joinValues(
                    aggregate.operations
                ) ||
                'unknown',

            reasoning:
                resolveReasoning(
                    aggregate
                ),

            reasoningTokens:
                [...aggregate.reasoningTokens],

            thinkingBudgets:
                aggregate.thinkingBudgets.map(
                    item => ({...item})
                ),

            settingKeys:
                [...aggregate.settingKeys]
        };
    }

    async function fetchSpanDetails(
        runId,
        token,
        candidates
    ) {

        const aggregate =
            createAggregate(
                runId
            );

        const seen =
            new Set();

        const selected =
            candidates
                .filter(candidate => {

                    if (
                        !candidate?.spanId ||
                        seen.has(candidate.spanId)
                    ) {
                        return false;
                    }

                    seen.add(candidate.spanId);

                    return true;
                })
                .slice(-24);

        for (
            let index = 0;
            index < selected.length;
            index++
        ) {

            const candidate =
                selected[index];

            if (index) {
                await wait(250);
            }

            setPanelVerifying(
                `读取 Span ${index + 1}/${selected.length}`
            );

            const url =
                `https://api.trigger.dev/api/v1/runs/${encodeURIComponent(runId)}/spans/${encodeURIComponent(candidate.spanId)}`;

            try {

                const json =
                    await fetchJson(
                        url,
                        token,
                        512 * 1024
                    );

                if (
                    json?.runId &&
                    json.runId !== runId
                ) {
                    continue;
                }

                if (
                    json?.spanId &&
                    json.spanId !== candidate.spanId
                ) {
                    continue;
                }

                mergeSpanDetail(
                    aggregate,
                    json,
                    candidate
                );

            } catch (e) {

                if (e?.status === 429) {

                    warn(
                        'SPAN DETAIL RATE LIMITED - stopped'
                    );

                    break;
                }

                warn(
                    'SPAN DETAIL FAILED',
                    candidate.spanId,
                    e
                );
            }
        }

        return buildFinalResult(
            aggregate
        );
    }

    /*
     * ------------------------------------------------------------
     * 从 span detail 中提取 AI 信息
     * ------------------------------------------------------------
     */

    function extractAiInfo(
        root
    ) {

        const result = {

            model: null,

            provider: null,

            operationName: null
        };

        const visited =
            new WeakSet();

        function visit(
            value,
            depth
        ) {

            if (
                depth > 40 ||
                !value ||
                typeof value !== 'object'
            ) {
                return;
            }

            if (
                visited.has(value)
            ) {
                return;
            }

            visited.add(
                value
            );

            /*
             * ai:
             *
             * {
             *   model,
             *   provider,
             *   operationName
             * }
             */

            if (
                value.ai &&
                typeof value.ai === 'object'
            ) {

                result.model =
                    result.model ||
                    getString(
                        value.ai,
                        [
                            'model',
                            'modelId',
                            'model_id',
                            'modelName',
                            'model_name'
                        ]
                    );

                result.provider =
                    result.provider ||
                    getString(
                        value.ai,
                        [
                            'provider',
                            'providerId',
                            'provider_id',
                            'providerName',
                            'provider_name'
                        ]
                    );

                result.operationName =
                    result.operationName ||
                    getString(
                        value.ai,
                        [
                            'operationName',
                            'operation',
                            'operation_name'
                        ]
                    );
            }

            /*
             * 通用字段兼容。
             */

            for (
                const [key, child]
                    of Object.entries(value)
            ) {

                const lower =
                    key.toLowerCase();

                if (
                    typeof child === 'string'
                ) {

                    if (
                        !result.model &&
                        (
                            lower === 'model' ||
                            lower === 'modelid' ||
                            lower === 'model_id' ||
                            lower === 'modelname' ||
                            lower === 'model_name' ||
                            lower.includes(
                                'request.model'
                            ) ||
                            lower.includes(
                                'response.model'
                            )
                        )
                    ) {

                        result.model =
                            child;
                    }

                    if (
                        !result.provider &&
                        (
                            lower === 'provider' ||
                            lower === 'providerid' ||
                            lower === 'provider_id' ||
                            lower === 'providername' ||
                            lower === 'provider_name'
                        )
                    ) {

                        result.provider =
                            child;
                    }

                    if (
                        !result.operationName &&
                        (
                            lower === 'operationname' ||
                            lower === 'operation_name'
                        )
                    ) {

                        result.operationName =
                            child;
                    }
                }

                if (
                    child &&
                    typeof child === 'object'
                ) {

                    visit(
                        child,
                        depth + 1
                    );
                }
            }
        }

        visit(
            root,
            0
        );

        return result;
    }

    function getString(
        obj,
        keys
    ) {

        if (
            !obj ||
            typeof obj !== 'object'
        ) {
            return null;
        }

        for (
            const key of keys
        ) {

            const value =
                obj[key];

            if (
                typeof value === 'string' &&
                value.trim()
            ) {

                return value.trim();
            }
        }

        return null;
    }

    /*
     * ------------------------------------------------------------
     * 最终显示
     * ------------------------------------------------------------
     */

    function showModelResult(
        result
    ) {

        const model =
            result?.model ||
            'unknown';

        const provider =
            result?.provider ||
            'unknown';

        const operation =
            result?.operationName ||
            'unknown';

        log(
            '%cMODEL + REASONING FOUND',
            'background:#075c2b;color:white;font-size:16px;font-weight:bold;padding:5px',
            {
                runId:
                    result?.runId,

                spanIds:
                    result?.spanIds,

                provider,

                model,

                internalModel:
                    result?.internalModel,

                requestModel:
                    result?.requestModel,

                responseModel:
                    result?.responseModel,

                reasoning:
                    result?.reasoning,

                reasoningTokens:
                    result?.reasoningTokens,

                operation
            }
        );

        setPanelResult(
            result
        );

        window.__ARENA_BACKEND_MODEL__ =
            model;

        window.__ARENA_INTERNAL_MODEL__ =
            result?.internalModel ||
            null;

        window.__ARENA_REQUEST_MODEL__ =
            result?.requestModel ||
            null;

        window.__ARENA_RESPONSE_MODEL__ =
            result?.responseModel ||
            null;

        window.__ARENA_REASONING_LEVEL__ =
            result?.reasoning?.level ||
            null;

        window.__ARENA_REASONING_INFO__ =
            result?.reasoning ||
            null;

        window.__ARENA_BACKEND_PROVIDER__ =
            provider;

        window.__ARENA_BACKEND_OPERATION__ =
            operation;

        window.__ARENA_MODEL_RESULT__ =
            result;
    }

    /*
     * ------------------------------------------------------------
     * Trace debug
     * ------------------------------------------------------------
     */

    function debugTrace(
        trace
    ) {

        console.group(
            '%c[ARENA TRACE DEBUG]',
            'background:#334;color:white;font-weight:bold'
        );

        console.dir(
            trace
        );

        console.groupEnd();
    }

    /*
     * ------------------------------------------------------------
     * fetch hook
     * ------------------------------------------------------------
     */

    window.fetch =
        function (...args) {

            let url = '';

            try {

                const input =
                    args[0];

                if (
                    typeof input ===
                        'string'
                ) {

                    url =
                        input;

                } else if (
                    input?.url
                ) {

                    url =
                        input.url;
                }

            } catch {}

            const isRealtime =
                /\/ai-proxy\/realtime\/v1\/sessions\/[^/]+\/out(?:\?|$)/
                    .test(url) ||
                /\/realtime\/v1\/sessions\/[^/]+\/out(?:\?|$)/
                    .test(url);

            if (!isRealtime) {

                return originalFetch.apply(
                    this,
                    args
                );
            }

            const promise =
                originalFetch.apply(
                    this,
                    args
                );

            log(
                'REALTIME OUT',
                url
            );

            promise.then(
                response => {

                    log(
                        'FETCH RESOLVED',
                        {
                            status:
                                response.status,

                            contentType:
                                response.headers.get(
                                    'content-type'
                                )
                        }
                    );

                    try {

                        const clone =
                            response.clone();

                        if (!clone.body) {
                            return;
                        }

                        const reader =
                            clone.body.getReader();

                        const decoder =
                            new TextDecoder();

                        let buffer =
                            '';

                        const readLoop =
                            async () => {

                                try {

                                    while (true) {

                                        const {
                                            value,
                                            done
                                        } =
                                            await reader.read();

                                        if (done) {
                                            break;
                                        }

                                        if (!value) {
                                            continue;
                                        }

                                        buffer +=
                                            decoder.decode(
                                                value,
                                                {
                                                    stream: true
                                                }
                                            );

                                        const pieces =
                                            buffer.split(
                                                /\r?\n\r?\n/
                                            );

                                        buffer =
                                            pieces.pop() ||
                                            '';

                                        for (
                                            const piece
                                                of pieces
                                        ) {

                                            processSseEvent(
                                                piece
                                            );
                                        }
                                    }

                                } catch (e) {

                                    if (
                                        e?.name ===
                                            'AbortError'
                                    ) {

                                        log(
                                            'SSE stream aborted by page'
                                        );

                                    } else {

                                        warn(
                                            'SSE READ ERROR',
                                            e
                                        );
                                    }
                                }
                            };

                        readLoop();

                    } catch (e) {

                        warn(
                            'SSE CLONE ERROR',
                            e
                        );
                    }
                },

                err => {

                    warn(
                        'REALTIME FETCH ERROR',
                        err
                    );
                }
            );

            return promise;
        };

    /*
     * ------------------------------------------------------------
     * Initialize
     * ------------------------------------------------------------
     */

    setPanelWaiting();

    log(
        '%cINSTALLED',
        'background:#111;color:#00ff66;font-size:16px;font-weight:bold'
    );

    /*
     * ------------------------------------------------------------
     * External helpers
     * ------------------------------------------------------------
     */

    window.__ARENA_DETECTOR__ = {

        getRunId() {

            return (
                window.__ARENA_RUN_ID__ ||
                null
            );
        },

        getModel() {

            return (
                window.__ARENA_BACKEND_MODEL__ ||
                null
            );
        },

        getInternalModel() {

            return (
                window.__ARENA_INTERNAL_MODEL__ ||
                null
            );
        },

        getRequestModel() {

            return (
                window.__ARENA_REQUEST_MODEL__ ||
                null
            );
        },

        getResponseModel() {

            return (
                window.__ARENA_RESPONSE_MODEL__ ||
                null
            );
        },

        getReasoningLevel() {

            return (
                window.__ARENA_REASONING_LEVEL__ ||
                null
            );
        },

        getReasoningInfo() {

            return (
                window.__ARENA_REASONING_INFO__ ||
                null
            );
        },

        getProvider() {

            return (
                window.__ARENA_BACKEND_PROVIDER__ ||
                null
            );
        },

        getOperation() {

            return (
                window.__ARENA_BACKEND_OPERATION__ ||
                null
            );
        },

        getResult() {

            return (
                window.__ARENA_MODEL_RESULT__ ||
                null
            );
        }
    };

})();
// END ORIGINAL DETECTOR v8.1.0
mountLegacyDisplayBridge();

// ====================================================================================
// Task feedback auto-continue (port of 9.23.2 ContinueWork.js, v2).
// Only the Arena "Was this task successful? / 此任务成功了吗？" card; only its single
// "Keep working / Continue working / 继续工作" option. Never generic confirmation dialogs.
// Always on.
// ====================================================================================
const continueWork = (() => {
  const KEY = 'amp.native.autoContinue';
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
  const visible = el => !!el?.isConnected && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden],[aria-hidden="true"],[inert]');
  const label = el => norm(el.getAttribute('aria-label') || el.innerText || el.textContent);
  const controls = root => [...root.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"]')].filter(visible);
  const question = /^(?:此任务成功了吗[？?]?|这项任务成功了吗[？?]?|任务成功了吗[？?]?|Was this task successful[？?]?)$/i;
  const continueText = /^(?:继续工作|继续|Keep working|Continue working)$/i;
  const yesText = /^(?:是|成功|Yes)$/i, noText = /^(?:否|失败|No)$/i;
  const allowed = () => location.origin === 'https://arena.ai' && /^\/agent(?:\/[0-9a-f-]{36})?\/?$/i.test(location.pathname);
  const state = { url: '', sent: false, at: 0, absentAt: null, serial: 0, confirmed: 0, clicks: 0 };
  let onClick = null;
  // v1.11.73 抽卡进行中 / 抽卡产生的对话：不点“继续工作”，只把反馈卡片收起（避免模型接着干活、页面跳动）
  const quietNow = () => { try { return !!window.__AMP_GACHA_QUIET__?.(); } catch { return false; } };
  const enabled = () => !quietNow(); // otherwise always on (v1.5): the only choice clicked is Keep working
  function candidates() {
    const out = [];
    const pre = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"]')].filter(b => continueText.test(norm(b.getAttribute('aria-label') || b.textContent)));
    if (!pre.length) return out;
    for (const button of pre.filter(visible).filter(b => continueText.test(label(b)))) {
      if (button.closest('pre,code,[contenteditable="true"],[data-message-author-role="user"],[data-role="user"],[data-user-message-layout]')) continue;
      let root = button.parentElement;
      for (let depth = 0; root && depth < 8; depth++, root = root.parentElement) {
        if (['BODY', 'HTML', 'MAIN'].includes(root.tagName)) break;
        const lines = (root.innerText || root.textContent || '').split(/\r?\n/).map(norm);
        const heading = question.test(norm(root.getAttribute('aria-label'))) || lines.some(t => question.test(t)) ||
          [...root.querySelectorAll('h1,h2,h3,h4,p,span,div,[role="heading"]')].some(el => visible(el) && question.test(norm(el.innerText || el.textContent)));
        if (!heading) continue;
        const bs = controls(root);
        if (bs.some(b => yesText.test(label(b))) && bs.some(b => noText.test(label(b))) && bs.filter(b => continueText.test(label(b))).length === 1) { out.push({ button, root }); break; }
      }
    }
    return out;
  }
  function inspect() {
    const url = location.href, t = Date.now();
    if (state.url !== url) { state.url = url; state.sent = false; state.absentAt = null; state.at = 0; }
    if (!allowed()) return { status: 'out-of-scope', pending: false, serial: state.serial, confirmed: state.confirmed };
    const found = candidates();
    if (state.sent && state.absentAt !== null && t - state.absentAt >= 1000) { state.sent = false; state.confirmed = state.serial; state.absentAt = null; }
    if (!found.length) { if (state.sent && state.absentAt === null) state.absentAt = t; return { status: state.sent ? 'settling' : 'idle', pending: state.sent, serial: state.serial, confirmed: state.confirmed }; }
    state.absentAt = null;
    return { status: state.sent ? (t - state.at >= 12000 ? 'unconfirmed' : 'waiting') : found.length === 1 ? 'ready' : 'ambiguous', pending: true, serial: state.serial, confirmed: state.confirmed };
  }
  function tick(expectedUrl = location.href) {
    if (location.href !== expectedUrl) return { status: 'navigation-changed', pending: false };
    const r = inspect(); if (r.status !== 'ready') return r;
    const found = candidates(); if (found.length !== 1) return { ...r, status: 'ambiguous' };
    const b = found[0].button;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return { ...r, status: 'disabled' };
    // Mark before dispatch so a rerender or a throwing handler can never cause a second click.
    state.sent = true; state.at = Date.now(); state.absentAt = null; state.serial++; state.clicks++;
    b.click(); try { onClick?.(); } catch {}
    return { status: 'clicked', pending: true, serial: state.serial, confirmed: state.confirmed };
  }
  // v1.11.77 Arena 的“此任务成功了吗？”面板是【替换输入框】渲染的（review panel）：以前只把它藏起来，输入框也跟着没了
  // （抽卡时 / 抽卡开出的对话里输入框消失）。现在藏起来的同时点它自己的关闭键（= 按 Esc，只记“已忽略”，不会让模型继续干活），
  // 面板关掉、输入框立刻回来；关不掉（Arena 改版）试 3 次后放弃隐藏，至少让面板显示出来能手动点。
  const closeBtn = root => [...root.querySelectorAll('button')].find(b => /^(close review panel|close|dismiss|关闭|关闭评审面板|忽略)$/i.test(norm(b.getAttribute('aria-label') || '')));
  const giveUp = new WeakSet();
  function dismiss(root) {
    if (!root.isConnected || giveUp.has(root)) return;
    const t = Date.now(); if (root._ampCwX && t - root._ampCwX < 1200) return;
    root._ampCwN = (root._ampCwN || 0) + 1;
    if (root._ampCwN > 3) { giveUp.add(root); root.removeAttribute('data-amp-cw-quiet'); return; }
    root._ampCwX = t; const x = closeBtn(root); if (x) try { x.click(); } catch {}
  }
  function quiet() {
    let n = 0;
    for (const { root } of candidates()) { if (giveUp.has(root)) continue; if (!root.hasAttribute('data-amp-cw-quiet')) { root.setAttribute('data-amp-cw-quiet', ''); n++; } dismiss(root); }
    for (const root of document.querySelectorAll('[data-amp-cw-quiet]')) dismiss(root);
    return n;
  }
  let scheduled = false, qRaf = 0;
  const auto = () => { if (quietNow()) { if (!qRaf) qRaf = requestAnimationFrame(() => { qRaf = 0; quiet(); }); return; } if (scheduled) return; scheduled = true; setTimeout(() => { scheduled = false; if (enabled()) tick(); else { quiet(); inspect(); } }, 250); };
  function start() {
    if (!document.documentElement) return;
    try { const st = document.createElement('style'); st.textContent = '[data-amp-cw-quiet]{display:none!important}'; (document.head || document.documentElement).append(st); } catch {}
    new MutationObserver(auto).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class'] });
    setInterval(auto, 2000);
    setInterval(() => { if (document.querySelector('[data-amp-cw-quiet]')) quiet(); }, 1300);
  }
  const api = { version: 3, inspect, tick, quiet, enabled, set(v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch {} if (v) auto(); }, onClick(fn) { onClick = fn; }, get clicks() { return state.clicks; } };
  if (!window.__arenaContinueWork || window.__arenaContinueWork.version < 3) window.__arenaContinueWork = api;
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  return api;
})();

// ====================================================================================
// Native gacha engine v1 — single-tab port of 模型探测工具 9.23.2 (ArenaCompanion) gacha.
// Replaces the Lite v2.10.1 auto-screening module (dual-tab locks, reload per job, heuristic selectors).
// Principles: exact PageBridge selectors; SPA New Chat click; send confirmed by POST status
// AND URL; resend in the same conversation (max 3); fatal pause on 401/403/429, login,
// human verification, terms, attachments or foreign drafts. Never bypasses CAPTCHA or
// rate limits; never waits out a limit automatically. No cookies/tokens are stored.
// ====================================================================================
const gacha = (() => {
  const SETTINGS = 'amp.native.gacha.settings.v1', RUN = 'amp.native.gacha.run.v1';
  const QUANTITIES = [5, 10, 15, 20, 30];
  const TIERS = ['none','minimal','low','medium','high','xhigh','max'];
  // Targets are vendors, not specific models: a draw hits when the identified name contains a vendor keyword.
  const VENDORS = [
    { id: 'openai', name: 'GPT', lab: 'OpenAI', kw: ['gpt'] },
    { id: 'anthropic', name: 'Claude', lab: 'Anthropic', kw: ['claude'] },
    { id: 'google', name: 'Gemini', lab: 'Google', kw: ['gemini'] },
    { id: 'xai', name: 'Grok', lab: 'xAI', kw: ['grok'] },
    { id: 'moonshot', name: 'Kimi', lab: 'Moonshot', kw: ['kimi'] }
  ];
  const vendorBy = id => VENDORS.find(v => v.id === id) || null;
  const vendorFromText = t => { t = String(t || '').toLowerCase(); return VENDORS.find(v => v.kw.some(k => t.includes(k)))?.id || ''; };
  const OLD_PROMPT = '只回答数字 1，不要补充其他文字。', OLD_PROMPTS = [OLD_PROMPT, '回复1'];
  const DEFAULTS = {
    vendor: '', archiveKeywords: ['super', 'GLM', 'deepseek', 'qwen', 'doubao', 'gpt-5.5', 'spark', 'grok-4.5'],
    archiveOn: true, prompt: '只回复我9不要调用任何工具', maxAttempts: 20, intervalMs: 800, stopOnThinking: true, sortSidebar: true
  };
  // Base waits for a normal device/network. Every wait is multiplied by pace.scale (1–4), learned from this run.
  // None of these skip a draw: a missing model triggers a resend in the same chat; a broken step pauses with a reason.
  const T = { newChat: 20000, sendReady: 5000, postSeen: 15000, urlSeen: 45000, settle: 500, idleWait: 90000,
    resendNoRun: 15000, resendPending: 45000, resendDefault: 30000, maxResends: 5, genStall: 600000, skipNap: 800 };
  const REASONS = {
    RATE_LIMIT: '当前 IP 被限流（HTTP 429），抽卡已停止；切换 IP 后点「我已更换 IP」重新开始',
    AUTH: '登录状态失效（HTTP 401/403），请先登录 Arena 后重新开始',
    HTTP: '发送请求失败，抽卡已停止',
    LOGIN: '请先登录 Arena',
    CAPTCHA: '需要人机验证，抽卡已停止（请手动完成，本脚本不处理验证）',
    TERMS: '网站弹出首次使用条款，请手动确认后重新开始',
    ALERT_LIMIT: '页面提示限流或额度用尽，抽卡已停止',
    ATTACHMENT: '输入框中有附件，已保留；抽卡不会夹带附件',
    DRAFT: '输入框中有其他草稿，已保留；请清空后重新开始',
    LEFT: '已离开抽卡对话，抽卡已停止',
    QUOTA: '额度或限流状态显示当前不可发送，抽卡已停止',
    USD: '美元额度快照显示已用尽/超限，抽卡已停止',
    SKIPS: '连续 8 次未能完成一轮，页面可能异常，抽卡已停止',
    STEP: '抽卡步骤未能完成',
    NO_CORE: '模型识别核心尚未就绪',
    RELOADED: '页面已刷新，本次抽卡已结束（再点 START 从 0 开始）'
  };
  const nap = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  let core = null, paintFn = null, rev = 0, token = 0, suppressReloadUntil = 0;
  const posts = []; let postSerial = 0;
  const readJSON = (store, key, otherwise = null) => { try { return JSON.parse(store.getItem(key)) ?? otherwise; } catch { return otherwise; } };
  const writeJSON = (store, key, value) => { try { if (store === localStorage) return ampStore.set(key, JSON.stringify(value)); store.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
  const list = (v, fallback) => Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string').map(x => x.trim()).filter(x => x && x.length <= 200))].slice(0, 50) : [...fallback];
  const WARMUP_TEXT = '（请先立即单独输出一行“思考中…”，然后再开始思考并完成任务；需要分析的内容直接写在回复正文里。）';
  function settings() {
    const s = readJSON(localStorage, SETTINGS, {}) || {};
    // v1.5 migration: an older free-text target (e.g. "gpt-6-astra") maps to its vendor.
    const customKeyword = typeof s.customKeyword === 'string' ? s.customKeyword.trim().slice(0, 60) : '';
    const vendor = typeof s.vendor === 'string' ? (vendorBy(s.vendor) ? s.vendor : (s.vendor === 'custom' && customKeyword ? 'custom' : '')) : vendorFromText(s.targetModel);
    const v = vendorBy(vendor), custom = vendor === 'custom';
    // 旧默认词（回复1 / 只回答数字 1…）自动换成新默认词；用户自己写的提示词原样保留。
    const prompt = typeof s.prompt === 'string' && s.prompt.trim() && (s.promptCustom === true || !OLD_PROMPTS.includes(s.prompt.trim())) ? s.prompt.slice(0, 4000) : DEFAULTS.prompt;
    return {
      vendor, customKeyword, targetModel: v ? v.name : custom ? customKeyword : '', targetKeywords: v ? [...v.kw] : custom ? [customKeyword] : [],
      archiveKeywords: list(s.archiveKeywords, DEFAULTS.archiveKeywords),
      archiveOn: typeof s.archiveOn === 'boolean' ? s.archiveOn : s.archiveMode !== 'off',
      prompt, maxAttempts: QUANTITIES.includes(s.maxAttempts) ? s.maxAttempts : DEFAULTS.maxAttempts,
      // v1.11.34：旧默认间隔 3 秒自动换成新默认 0.8 秒；用户自己保存过的值（intervalV2）原样保留。
      intervalMs: Number.isFinite(s.intervalMs) && (s.intervalV2 === true || s.intervalMs !== 3000) ? Math.max(0, Math.min(60000, Math.round(s.intervalMs))) : DEFAULTS.intervalMs, intervalV2: s.intervalV2 === true,
      stopOnThinking: s.stopOnThinking !== false, sortSidebar: s.sortSidebar !== false, earthTone: true,
      watchdog: s.watchdog === true, watchdogSec: [65, 70, 75, 80].includes(s.watchdogSec) ? s.watchdogSec : 75, watchdogRetries: [1, 2, 3].includes(s.watchdogRetries) ? s.watchdogRetries : 2,
      warmup: s.warmup === true, warmupText: typeof s.warmupText === 'string' && s.warmupText.trim() ? s.warmupText.slice(0, 300) : WARMUP_TEXT, promptCustom: s.promptCustom === true
    };
  }
  let saveOk = true;
  function saveSettings(patch) { const next = { ...settings(), ...patch }; if (patch && typeof patch.prompt === 'string') next.promptCustom = true; if (patch && Number.isFinite(patch.intervalMs)) next.intervalV2 = true; for (const k of ['targetModels', 'targets', 'targetModel', 'targetKeywords', 'targetTier', 'renameMode', 'archiveMode', 'archiveWhileDrawing', 'stopAfterIdentified']) delete next[k]; saveOk = writeJSON(localStorage, SETTINGS, next) && localStorage.getItem(SETTINGS) === JSON.stringify(next); changed(); return settings(); }
  function setVendor(id, keyword) {
    if (id === 'custom') { const k = String(keyword || '').trim().slice(0, 60); return saveSettings(k ? { vendor: 'custom', customKeyword: k } : { vendor: '' }); }
    return saveSettings({ vendor: vendorBy(id) ? id : '' });
  }

  // ---------------- run state (sessionStorage: one tab, one run) ----------------
  let run = readJSON(sessionStorage, RUN, null);
  // v1.11.73 停止就是结束：刷新页面 = 本次抽卡结束（不再有“暂停 / 继续”）。只有抽卡自己发起的页面跳转才接着同一轮跑。
  if (run && typeof run === 'object' && Array.isArray(run.attempts)) {
    const navResume = run.status === 'running' && run.resumeNavUntil && run.resumeNavUntil > now();
    const pending = [...new Set([...(run.archiveQueue || []), ...run.attempts.filter(a => a.verdict === 'archive' && a.sid && !a.archived).map(a => a.sid)])].slice(-200);
    if (navResume) { run.resumeNavUntil = 0; run.autoResume = true; }
    else if (['running', 'stopping', 'paused'].includes(run.status)) { run.status = 'stopped'; run.reason = REASONS.RELOADED; run.code = 'RELOADED'; run.phase = ''; run.endedAt = run.endedAt || now(); run.archiveQueue = pending; run.attempts = []; run.log = []; }
    else if (pending.length) { run.archiveQueue = pending; run.attempts = []; run.log = []; }
    else run = null;
    // An attempt interrupted by a reload is abandoned; it is never counted.
    const last = run?.attempts.at(-1); if (last && !last.done) { last.done = true; last.verdict = 'abandoned'; last.note = '页面刷新中断'; }
  } else run = null;
  // 结束状态立即写回：再刷新一次就不再重复提示“页面已刷新”
  try { if (run) writeJSON(sessionStorage, RUN, run); else sessionStorage.removeItem(RUN); } catch {}
  // v1.11.73 抽卡产生的对话（探测用）：之后再打开也不自动点“继续工作”、反馈卡片直接收起
  const QSIDS = 'amp.native.gacha.sids.v1';
  let gSids = new Set(Array.isArray(readJSON(localStorage, QSIDS, [])) ? readJSON(localStorage, QSIDS, []) : []);
  function noteSid(sid) { if (!sid || gSids.has(sid)) return; gSids.add(sid); if (gSids.size > 300) gSids = new Set([...gSids].slice(-300)); writeJSON(localStorage, QSIDS, [...gSids]); }
  try { window.__AMP_GACHA_QUIET__ = () => !!run && ['running', 'stopping'].includes(run.status) || gSids.has(sidOf(location.href)); } catch {}
  const persist = () => { if (run) { run.log = run.log.slice(-200); writeJSON(sessionStorage, RUN, run); } };
  function changed() { rev++; persist(); try { paintFn?.(); } catch {} try { window.dispatchEvent(new CustomEvent('amp-native-gacha')); } catch {} }
  function log(text, level = 'info') { if (!run) return; run.log.push({ at: now(), level, text: String(text).slice(0, 300) }); run.phase = level === 'phase' ? text : run.phase; changed(); }
  const phase = text => { if (run) { run.phase = text; run.log.push({ at: now(), level: 'phase', text }); changed(); } };
  class Stop extends Error { constructor(code, detail, kind = 'fatal') { super(REASONS[code] ? REASONS[code] + (detail ? ' · ' + detail : '') : detail || code); this.code = code; this.kind = kind; } }
  const fatal = (code, detail) => { throw new Stop(code, detail, 'fatal'); };
  const skip = detail => { throw new Stop('SKIP', detail, 'skip'); };
  const alive = my => my === token && run && run.status === 'running';
  async function waitFor(fn, ms, my, step = 250) {
    const end = now() + ms;
    for (;;) { if (my !== undefined && !alive(my)) throw new Stop('CANCEL', '', 'cancel'); const v = fn(); if (v) return v; if (now() >= end) return null; await nap(step); }
  }

  // ---------------- adaptive pacing ----------------
  // Each successful step records actual/expected time; the median ratio (1–4×) stretches every later wait,
  // so slow devices or networks get proportionally more patience instead of being skipped.
  const pace = {
    get scale() { const a = run?.stats?.slow || []; if (!a.length) return 1; const m = [...a].sort((x, y) => x - y)[a.length >> 1]; return Math.max(1, Math.min(4, m)); },
    note(ms, expected) { if (!run) return; const st = run.stats ||= { slow: [] }; st.slow.push(Math.max(0.2, ms / expected)); if (st.slow.length > 15) st.slow.shift(); },
    ms(base) { return Math.round(base * this.scale); },
    sec(base) { return Math.round(this.ms(base) / 1000); }
  };

  // ---------------- page adapter (exact PageBridge labels) ----------------
  const page = (() => {
    const visible = el => !!el && el.isConnected && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const label = el => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');
    const buttons = scope => scope ? [...scope.querySelectorAll('button')].filter(visible) : [];
    const find = (names, scope = document) => scope ? [...scope.querySelectorAll('button')].find(e => names.includes(label(e)) && visible(e)) : undefined;
    const SEND = ['Send message', '发送消息'], STOP = ['Stop generating', '停止生成', 'Stop response'];
    const main = () => [...document.querySelectorAll('main')].find(visible) || null;
    const input = () => { const all = [...document.querySelectorAll('main div[contenteditable="true"]')].filter(visible); return all.find(e => e.closest('form')) || all.at(-1) || null; };
    // 草稿比较前统一空白：零宽字符、不间断空格、多余换行都不算差异（以前因此误判“草稿不一致”而暂停）。
    const norm = t => String(t || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const sendBtns = m => m ? [...m.querySelectorAll('button')].filter(e => SEND.includes(label(e)) && !e.closest('[role="log"]') && visible(e)) : [];
    const sendBtn = m => { const b = sendBtns(m).filter(e => !e.disabled && e.getAttribute('aria-disabled') !== 'true'); return b.find(e => e.closest('form')) || b.at(-1) || null; };
    const dialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    const newChatLinks = () => [...document.querySelectorAll('a[href="/agent"]')].filter(e => visible(e) && label(e) === 'New Chat');
    const expander = () => find(['Expand sidebar', 'Open sidebar']);
    const stagedNames = m => m ? [...m.querySelectorAll('button')].filter(e => label(e).startsWith('Remove ') && !e.closest('[role="log"]') && visible(e)).map(label).map(t => t.slice(7)) : [];
    function completion(log) {
      const match = /^\/agent\/([0-9a-f-]{36})\/?$/i.exec(location.pathname);
      if (!log || !match) return null;
      try {
        let fiber = log[Object.keys(log).find(k => k.startsWith('__reactFiber'))];
        for (let n = 0; fiber && n < 100; n++, fiber = fiber.return) {
          const live = fiber.memoizedProps?.value;
          if (!live || live.id !== match[1] || !Array.isArray(live.messages)) continue;
          if (!['ready', 'submitted', 'streaming', 'error'].includes(live.status)) return null;
          const last = live.messages[live.messages.length - 1];
          const parts = Array.isArray(last?.parts) ? last.parts : [];
          const tool = p => p.type === 'dynamic-tool' || String(p.type || '').startsWith('tool-');
          const doneState = s => ['output-available', 'output-error', 'output-denied', 'result'].includes(s);
          const unfinished = last?.metadata?.pending === true || parts.some(p => p && (p.state === 'streaming' || (tool(p) && !doneState(p.state))));
          const answer = last?.role === 'assistant' && parts.some(p => p && ((p.type === 'text' && typeof p.text === 'string' && p.text.trim()) || (tool(p) && doneState(p.state))));
          // Routed thinking: the reply started without reasoning, then a reasoning part appears after answer text.
          // Natively thinking models reason before their first text, so they never match.
          const isReason = p => p && /reason|think/i.test(String(p.type || ''));
          const firstText = parts.findIndex(p => p && p.type === 'text' && typeof p.text === 'string' && p.text.trim());
          const firstReason = parts.findIndex(isReason);
          const routed = last?.role === 'assistant' && firstText >= 0 && firstReason > firstText ? String(last.id || live.messages.length) : '';
          return { busy: ['submitted', 'streaming'].includes(live.status) || unfinished, complete: live.status === 'ready' && !!answer && !unfinished, failed: live.status === 'error', routed };
        }
      } catch {}
      return null;
    }
    // 首包看门狗用：最后一条用户消息之后，助手是否已经产出任何内容（文字 / 推理文字 / 工具调用）。
    function chatState() {
      const m = main(), log = m && [...m.querySelectorAll('[role="log"]')].find(visible);
      const match = /^\/agent\/([0-9a-f-]{36})\/?$/i.exec(location.pathname); if (!log || !match) return null;
      try {
        let fiber = log[Object.keys(log).find(k => k.startsWith('__reactFiber'))];
        for (let n = 0; fiber && n < 100; n++, fiber = fiber.return) {
          const live = fiber.memoizedProps?.value;
          if (!live || live.id !== match[1] || !Array.isArray(live.messages)) continue;
          const msgs = live.messages; let ui = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'user') { ui = i; break; }
          if (ui < 0) return null;
          const u = msgs[ui], userText = (u.parts || []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n').trim();
          const meaningful = p => p && ((typeof p.text === 'string' && p.text.trim()) || /reason|think/i.test(String(p.type || '')) || p.type === 'dynamic-tool' || String(p.type || '').startsWith('tool-') || p.type === 'file');
          const hasOutput = msgs.slice(ui + 1).some(x => x?.role === 'assistant' && (x.parts || []).some(meaningful));
          return { sid: match[1], status: live.status, userKey: match[1] + '|' + (u.id || ui), userText, hasOutput, waiting: ['submitted', 'streaming'].includes(live.status) && !hasOutput };
        }
      } catch {}
      return null;
    }
    function blocker() {
      const ds = dialogs();
      if (ds.some(e => /Security Verification|人机身份验证|Verify you are human/i.test(e.innerText || e.textContent || ''))) return 'CAPTCHA';
      if (find(['Log In']) || ds.some(e => /Log In to your account|Log In or Create Account/.test(e.innerText || e.textContent || ''))) return 'LOGIN';
      if (ds.some(e => /Terms of Use & Privacy Policy/.test(e.innerText || e.textContent || ''))) return 'TERMS';
      const alerts = [...document.querySelectorAll('[role="alert"]')].filter(visible).map(e => e.innerText || e.textContent || '').join('\n');
      if (/too many requests|rate limit|try again later|quota exceeded|limit reached/i.test(alerts)) return 'ALERT_LIMIT';
      return '';
    }
    function view() {
      const m = main(), log = m && [...m.querySelectorAll('[role="log"]')].find(visible);
      const text = log ? /\S/.test(log.textContent || '') : false; // 性能：不用 innerText（整段对话会强制重排）
      const live = completion(log);
      const feedbackPending = window.__arenaContinueWork?.inspect?.().pending === true;
      const stop = !!m && [...m.querySelectorAll('button')].some(e => STOP.includes(label(e)) && !e.closest('[role="log"]') && visible(e));
      const sb = sendBtn(m);
      const spinner = !!m && [...m.querySelectorAll('[role="progressbar"],.animate-spin')].some(e => visible(e) && !e.closest('[role="log"]'));
      const ed = input();
      return { main: !!m, conversation: !!text, generating: feedbackPending || (live ? live.busy || (!live.complete && stop) : stop),
        complete: !!live?.complete, routed: live?.routed || '', editor: !!ed, draft: norm(ed?.innerText ?? ed?.textContent ?? ''), sendReady: !!sb,
        spinner, attachments: stagedNames(m), newLinks: newChatLinks().length, canExpand: !!expander(), blocker: blocker() };
    }
    // v1.11.77 抽卡填词 / 回车发送时不弹手机输入法：聚焦前临时 inputmode=none，发出去后失焦并恢复
    //（输入法一闪、输入框被顶上去再落回，都来自脚本聚焦输入框）
    const kbOff = el => { try { if (el && !el.hasAttribute('data-amp-kboff')) { el.setAttribute('data-amp-kboff', el.getAttribute('inputmode') || ''); el.setAttribute('inputmode', 'none'); } } catch {} };
    function kbRestore() { try { for (const el of document.querySelectorAll('[data-amp-kboff]')) { if (document.activeElement === el) el.blur(); const v = el.getAttribute('data-amp-kboff'); el.removeAttribute('data-amp-kboff'); if (v) el.setAttribute('inputmode', v); else el.removeAttribute('inputmode'); } } catch {} }
    function writeDraft(value) {
      const el = input(); if (!el) throw new Error('输入框尚未就绪'); kbOff(el); el.focus(); el.style.whiteSpace = 'pre-wrap';
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      const lines = String(value).replace(/\r\n?/g, '\n').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i && !document.execCommand('insertLineBreak', false)) throw new Error('未能填入提示词换行');
        if ((lines[i] || i === 0) && !document.execCommand('insertText', false, lines[i])) {
          // execCommand 被拒绝时改用 beforeinput/paste 事件，让编辑器自己插入文字。
          const dt = new DataTransfer(); dt.setData('text/plain', String(value));
          const ok = !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          if (!ok) el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: String(value), bubbles: true, cancelable: true }));
          return;
        }
      }
    }
    const clickSend = () => { const b = sendBtn(main()); if (!b) return false; b.click(); return true; };
    // 兜底：在输入框里按 Enter（Arena 的输入框回车即发送）。
    const pressEnter = () => { const el = input(); if (!el) return false; kbOff(el); el.focus(); for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); return true; };
    function clearDraft() { const el = input(); if (!el) return; kbOff(el); el.focus(); const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand('delete', false); }
    const clickStop = () => { const m = main(), b = m && buttons(m).filter(e => STOP.includes(label(e)) && !e.closest('[role="log"]') && !e.disabled); if (!b || b.length !== 1) return false; b[0].click(); return true; };
    return { view, chatState, writeDraft, clickSend, clickStop, pressEnter, clearDraft, kbRestore, norm, newChatLinks, expander, visible, label };
  })();
  const sidOf = url => { try { return new URL(url, location.href).pathname.match(/^\/agent\/([0-9a-f-]{36})\/?$/i)?.[1] || null; } catch { return null; } };
  const blank = v => /^\/agent\/?$/.test(location.pathname) && v.main && v.editor && !v.conversation && !v.generating;

  // ---------------- model policy (ModelNamePolicy / InternalTitle) ----------------
  const BAD = /^(unknown|model-a|model-b|未知|未提供|none|null|undefined)$/i, GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validName = n => typeof n === 'string' && n.trim().length >= 2 && n.trim().length <= 100 && !GUID.test(n.trim()) && !BAD.test(n.trim());
  function identify(live, attempt) {
    if (!live || live.sid !== attempt.sid || !live.data) return null;
    if (attempt.sentAt && live.submittedAt && live.submittedAt < attempt.sentAt - 3000) return null;
    // v1.11.78 Arena 自己的故障转移：原模型调用失败 → 改派。以前拿“最后一次调用”识别，新模型的调用还没进 Trace 时
    // 最后一次就是失败的原模型（v4-flash-vision-exp），于是先报原模型、过一会儿又变成 Grok（左右横跳）。
    // 现在只看真正回答了的调用；改派了但新模型还没出现 = 还没识别出来（不拿失败的原模型充数，也不拿它的内部名）。
    const all = live.data.calls || [], calls = servingCalls(live.data), last = calls.at(-1); if (!last) return null;
    const routed = calls.length !== all.length || !!live.data.routing;
    const internal = [last.internal, ...calls.map(c => c.internal), ...(routed ? [] : (live.data.internalNames || []))].find(validName) || null;
    const response = [last.response, ...calls.map(c => c.response)].find(validName) || null;
    const request = [last.request, ...calls.map(c => c.request)].find(validName) || null;
    const traced = [last.model, ...calls.map(c => c.model)].find(validName) || null;
    const name = internal || response || request || traced; if (!name) return null;
    const suffix = internal && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(internal) ? /-(none|minimal|low|medium|high|xhigh|max)$/i.exec(internal.replace(/-(vertex|agent|public)$/i, '')) : null;
    const tier = suffix ? suffix[1].toLowerCase() : (TIERS.includes(last.effort) ? last.effort : null);
    return { name: name.trim(), internal, response, request, traced, tier, partial: !!live.data.partial, routed };
  }
  const has = (name, words) => { const n = String(name || '').toLowerCase(); return words.some(w => w && n.includes(String(w).toLowerCase())); };
  function classify(id, s) {
    const all = [id.name, id.internal, id.response, id.request].filter(Boolean).join(' ');
    if (s.targetKeywords?.length && has(all, s.targetKeywords)) return 'hit';
    return s.archiveOn && has(all, s.archiveKeywords) ? 'archive' : 'keep';
  }
  const titleOf = id => noVertex(id.internal && validName(id.internal) ? id.internal : id.name).slice(0, 100);

  // ---------------- network observation (called from the shared fetch/XHR hooks) ----------------
  function notePost(path, status) {
    const kind = /\/stream\/create-chat$/.test(path) ? 'chat' : /\/in\/append$/.test(path) ? 'append' : null; if (!kind) return;
    posts.push({ serial: ++postSerial, kind, status: Number(status) || 0, at: now(), path: String(path).slice(0, 200) }); if (posts.length > 40) posts.shift();
    if (run?.status === 'running' && [401, 402, 403, 429].includes(Number(status))) {
      const code = Number(status) === 429 ? 'RATE_LIMIT' : 'AUTH'; void halt(new Stop(code, 'HTTP ' + status));
    }
  }
  const postsSince = serial => posts.filter(p => p.serial > serial);
  let chatIds = [];
  function noteChatId(id) { if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) { chatIds.push({ id, at: now() }); chatIds = chatIds.slice(-10); } }
  async function api(url, init) {
    const res = await (core?.rawFetch || fetch)(location.origin + url, { credentials: 'same-origin', cache: 'no-store', ...init });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; } return res;
  }
  // 改名会让 Arena 重新拉取会话列表/标题；对话正在生成时改名可能打断回复。所以先等页面空闲（最多 15 分钟），再多等 1.5 秒。
  async function waitIdle(max = 900000) {
    const end = Date.now() + max; let quiet = 0;
    while (Date.now() < end) {
      let busy = false; try { busy = !!page.view().generating; } catch {}
      if (busy) quiet = 0; else if (++quiet >= 3) return true;
      await nap(busy ? 800 : 500);
    }
    return false;
  }
  async function rename(sid, title) { if (sidOf(location.href) === sid && !(await waitIdle())) throw Object.assign(new Error('对话一直在生成，暂缓改名'), { status: 0 }); if (renameWant.get(sid) && renameWant.get(sid) !== title) return; await api('/api/history/agentic/' + encodeURIComponent(sid), { method: 'PATCH', headers: { 'content-type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ title: title.slice(0, 100) }) }); }
  // Titles owned by the gacha. Other writers (Lite local overlay / cloud sync) must skip these sids.
  const OWN = 'amp.native.gacha.titles.v1';
  const owned = new Map(Object.entries(readJSON(localStorage, OWN, {}) || {}).slice(-300));
  const ownTitle = (sid, title) => { owned.delete(sid); owned.set(sid, title); while (owned.size > 300) owned.delete(owned.keys().next().value); writeJSON(localStorage, OWN, Object.fromEntries(owned)); };
  const sidebarTitle = sid => { const a = [...document.querySelectorAll('a[href="/agent/' + sid + '"]')].find(e => e.closest('aside,nav,[data-sidebar]')); if (!a) return null; const sp = a.querySelector('span.truncate,div.truncate') || a; return (sp.textContent || '').trim() || null; };
  // One rename at a time, globally; a newer request for the same sid replaces an older pending one.
  let renameChain = Promise.resolve(); const renameWant = new Map(), renameAt = new Map();
  function queueRename(sid, title, own = true) {
    title = title.slice(0, 100); renameWant.set(sid, title); renameAt.set(sid, Date.now()); try { window.dispatchEvent(new Event('amp-title-sync')); } catch {} if (own || owned.has(sid)) ownTitle(sid, title);
    const job = async () => {
      if (renameWant.get(sid) !== title) return 'superseded';
      let lastErr = null;
      for (let i = 0; i < 3; i++) {
        try { await rename(sid, title); lastErr = null; break; }
        catch (e) { lastErr = e; if ([400, 401, 403, 429].includes(e.status)) break; await nap(1500 * (i + 1)); }
      }
      if (lastErr) throw lastErr;
      verifyLater(sid, title); return 'ok';
    };
    const p = renameChain.then(job, job); renameChain = p.catch(() => {}); return p;
  }
  // Arena writes its own generated title shortly after the first turn; check the sidebar and repair up to 3 times.
  function verifyLater(sid, title, round = 0) {
    if (round >= 3) return;
    setTimeout(() => {
      if (renameWant.get(sid) !== title) return;
      const shown = sidebarTitle(sid);
      if (shown === null || shown === title) { if (shown === null && round < 2) verifyLater(sid, title, round + 1); return; }
      if (run) log('对话名被改为“' + shown.slice(0, 40) + '”，已改回 ' + title, 'warn');
      rename(sid, title).catch(() => {}).finally(() => verifyLater(sid, title, round + 1));
    }, [4000, 10000, 25000][round]);
  }
  // Real-time model follow: when a conversation's latest turn is served by a different model, the old model name in
  // its title is replaced (prefix "#5 " / suffix " · 001" preserved). Custom titles without the old name are left alone.
  const escRe = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function followModel(sid, oldName, newName) {
    oldName = noVertex(oldName); newName = noVertex(newName);
    if (!sid || !newName || !validName(newName) || oldName === newName) return null;
    const a = run?.attempts?.at(-1); if (a && !a.done && a.sid === sid) return null; // the draw renames it itself
    const cur = noVertex(renameWant.get(sid) || sidebarTitle(sid) || owned.get(sid) || '');
    let next = null;
    if (oldName && cur && new RegExp(escRe(oldName), 'i').test(cur)) next = cur.replace(new RegExp(escRe(oldName), 'i'), newName);
    else if (owned.has(sid)) next = newName;
    if (!next || next === cur) return null;
    log('对话实际模型已变为 ' + newName + '，标题更新为 ' + next.slice(0, 60));
    queueRename(sid, next, false).catch(e => log('标题跟随模型失败 ' + (e.status ? 'HTTP ' + e.status : e.message), 'warn'));
    return next;
  }
  // Routed-thinking guard (all Agent chats, default on): stop once per reply when thinking appears mid-answer.
  let routedStopped = '';
  setInterval(() => {
    try {
      if (!settings().stopOnThinking || !/^\/agent\/[0-9a-f-]{36}/i.test(location.pathname)) return;
      const v = page.view(); if (!v.routed || !v.generating) return;
      const key = location.pathname + '|' + v.routed; if (key === routedStopped) return;
      if (page.clickStop()) { routedStopped = key; if (run?.status === 'running') log('回复中途被路由到 thinking，已停止生成', 'warn'); console.info('[Arena Native] 回复中途被路由到 thinking，已停止生成'); }
    } catch {}
  }, 600);
  // ---------------- 首包看门狗（实验，默认关闭）----------------
  // Arena 在原模型约 90 秒无首包时会改派其他模型并写入对话。赶在超时前停止并在同一对话重发，服务端没有记录失败，理论上仍是原模型。
  const WD_KEY = 'amp.native.watchdog.v1';
  let watchdogUntil = 0;
  const wd = { cur: '', t0: 0, chain: '', tries: 0, busy: false, told: '', checks: [] };
  const wdStats = readJSON(localStorage, WD_KEY, {}) || {};
  const wdSave = () => writeJSON(localStorage, WD_KEY, wdStats);
  function wdNote(level, text) { try { core?.note?.(level, text); } catch {} if (run?.status === 'running') log(text, level === 'warn' ? 'warn' : 'info'); console.info('[Arena Native] ' + text); }
  function wdVerify() {
    wd.checks = wd.checks.filter(c => {
      if (now() - c.at > 1200000) return false;
      const live = core?.runFor?.(c.sid); if (!live?.data?.calls?.length || !(live.submittedAt >= c.at - 2000)) return true;
      const pv = String(live.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 20); if (c.want && pv && pv !== c.want) return false;
      const last = servingCalls(live.data).at(-1); if (!last) return true; const got = last.request || last.model;
      if (!got || got === '未提供' || live.busy && !live.data.routing) return true;
      const sw = live.data.routing;
      const kept = !sw && (!c.expected || got === c.expected);
      wdStats[kept ? 'kept' : 'changed'] = (wdStats[kept ? 'kept' : 'changed'] || 0) + 1; wdSave();
      wdNote(kept ? 'info' : 'warn', '首包看门狗验证：重发后 ' + (kept ? '仍是原模型 ' + got : '模型为 ' + got + (c.expected ? '（原模型 ' + c.expected + '）' : '') + (sw ? ' · 被改派' : '')) + ' · 累计 保持 ' + (wdStats.kept || 0) + ' / 改变 ' + (wdStats.changed || 0));
      return false;
    });
  }
  async function wdFire(st, s) {
    wd.busy = true; watchdogUntil = now() + 30000; wd.tries++;
    const live = core?.runFor?.(st.sid), expected = live?.data?.calls?.at(-1)?.request || null;
    try {
      wdNote('warn', '首包看门狗：' + s.watchdogSec + ' 秒没有任何输出，停止并在同一对话重发（第 ' + wd.tries + '/' + s.watchdogRetries + ' 次）' + (expected ? ' · 当前模型 ' + expected : ''));
      if (!page.clickStop()) { wdNote('warn', '首包看门狗：找不到停止按钮，放弃'); return; }
      const end = now() + 15000; while (now() < end && page.view().generating) await nap(300);
      await nap(1500);
      if (page.view().draft) { wdNote('warn', '首包看门狗：输入框里有内容，未自动重发（请手动发送）'); return; }
      page.writeDraft(st.userText);
      const want = page.norm(st.userText), end2 = now() + 6000; let ok = false;
      while (now() < end2 && !(ok = page.view().sendReady && page.view().draft === want)) await nap(150);
      if (!ok || !page.clickSend()) { if (!page.pressEnter()) { wdNote('warn', '首包看门狗：重发失败，请手动发送'); return; } }
      wdStats.stops = (wdStats.stops || 0) + 1; wdSave();
      wd.checks.push({ sid: st.sid, expected, at: now(), want: String(st.userText).replace(/[\x00-\x1f\x7f]+|\s+/g, ' ').trim().slice(0, 20) });
    } catch (e) { wdNote('warn', '首包看门狗出错：' + (e.message || e)); }
    finally { wd.busy = false; watchdogUntil = now() + 6000; }
  }
  setInterval(() => {
    try {
      wdVerify();
      const s = settings(); if (!s.watchdog || wd.busy) return;
      const st = page.chatState(); if (!st) return;
      const chain = st.sid + '|' + page.norm(st.userText);
      if (chain !== wd.chain) { wd.chain = chain; wd.tries = 0; }
      if (st.hasOutput) { if (wd.tries && wd.told !== st.userKey) { wd.told = st.userKey; wdNote('info', '首包看门狗：重发后已开始输出（重发 ' + wd.tries + ' 次）'); } wd.cur = st.userKey; wd.t0 = 0; return; }
      if (!st.waiting) { wd.t0 = 0; return; }
      if (wd.cur !== st.userKey || !wd.t0) { wd.cur = st.userKey; wd.t0 = now(); return; }
      if (now() - wd.t0 >= s.watchdogSec * 1000 && st.userText) {
        if (wd.tries >= s.watchdogRetries) { if (wd.told !== st.userKey + '|max') { wd.told = st.userKey + '|max'; wdNote('warn', '首包看门狗：已重发 ' + wd.tries + ' 次仍无输出，不再干预'); } return; }
        void wdFire(st, s);
      }
    } catch {}
  }, 1000);
  async function archive(sid) { await api('/api/chat/' + encodeURIComponent(sid) + '/archive', { method: 'POST', headers: { Accept: 'application/json' } }); }

  // ---------------- guards ----------------
  function guard(v = page.view()) {
    if (v.blocker) fatal(v.blocker);
    const live = core?.huntLive?.();
    if (live?.blocked) fatal('QUOTA', live.blocked);
    const usd = core?.usdQuota?.();
    if (usd && (usd.overLimit === true || usd.balanceRemainingUsd <= 0) && now() - usd.at < 600000) fatal('USD', '剩余 $' + (+usd.balanceRemainingUsd).toFixed(2));
  }
  // During a draw the feedback card must never stall the run, even if auto-continue is off for manual chats.
  // v1.11.73 抽卡时不再点“继续工作”（会让模型接着干活、页面跳来跳去、还白耗额度）：把“此任务成功了吗？”卡片收起即可，不影响识别
  function tickContinue() { try { window.__arenaContinueWork?.quiet?.(); } catch {} skipQuestion(); }
  // 模型有时会弹出“选项卡片”（带 Skip / Submit 的提问）：抽卡时直接点 Skip 结束这一问，不影响识别。
  let lastSkip = 0;
  function skipQuestion() {
    if (now() - lastSkip < 1500) return;
    const logEl = [...document.querySelectorAll('main [role="log"]')].find(page.visible); if (!logEl) return;
    const skipBtn = [...logEl.querySelectorAll('button')].reverse().find(b => page.visible(b) && !b.disabled && /^(skip|跳过)$/i.test(page.label(b)));
    if (!skipBtn) return;
    const card = skipBtn.closest('div'); let box = card; for (let i = 0; i < 6 && box && !/submit|提交/i.test(box.textContent || ''); i++) box = box.parentElement;
    if (!box) return;
    lastSkip = now(); skipBtn.click(); log('模型弹出选项卡片，已自动 Skip');
  }
  async function ensureIdle(my) {
    const ok = await waitFor(() => { tickContinue(); const v = page.view(); guard(v); return !v.generating; }, T.idleWait, my, 400);
    if (!ok) { page.clickStop(); log('当前页面持续生成 ' + pace.sec(T.idleWait) + ' 秒，已停止并开新对话', 'warn'); await nap(800); }
  }
  // v1.11.79 开新对话时路径一变就同步一次顶部标题：上一抽刚揭晓的结果不会在新对话页上多停留（以前要等下一次定时刷新，最多 0.5 秒）
  function syncOnNav() { const p0 = location.pathname, t0 = now(); const f = () => { if (location.pathname !== p0) { try { window.dispatchEvent(new Event('amp-title-sync')); } catch {} return; } if (now() - t0 < 3000) requestAnimationFrame(f); }; try { requestAnimationFrame(f); } catch {} }
  function clickNewChat(link) { suppressReloadUntil = now() + 3000; try { window.__AMP_NATIVE_GACHA_NAV__ = suppressReloadUntil; } catch {} link.click(); syncOnNav(); }
  // v1.11.73 新建对话不再拉开左侧抽屉：桌面端点侧栏里看得见的 New Chat；手机端直接用 Next.js 路由切到 /agent（同一页面内，不刷新）
  function routerNew() {
    try { const r = window.next?.router; if (typeof r?.push !== 'function') return false; suppressReloadUntil = now() + 3000; try { window.__AMP_NATIVE_GACHA_NAV__ = suppressReloadUntil; } catch {} r.push('/agent'); syncOnNav(); return true; } catch { return false; }
  }
  // 兜底（路由不可用时）：仍要借侧栏里的 New Chat，但侧栏和遮罩全程透明，用户看不到抽屉弹出
  async function quietSidebarNew(my) {
    const d = document.documentElement, esc = () => { try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch {} };
    const x = page.expander(); if (!x) return false;
    d.setAttribute('data-amp-quietnav', ''); let ok = false;
    try { x.click(); await waitFor(() => page.newChatLinks().length === 1, 3000, my, 100); const l = page.newChatLinks(); if (l.length === 1) { clickNewChat(l[0]); ok = true; } }
    finally { setTimeout(() => { if (document.querySelector('[role="dialog"][data-mobile="true"][data-state="open"]')) esc(); setTimeout(() => d.removeAttribute('data-amp-quietnav'), 700); }, ok ? 900 : 0); }
    return ok;
  }
  async function openNewChat(my) {
    phase('打开新对话');
    for (let round = 1; ; round++) {
      if (blank(page.view())) return;
      const links = page.newChatLinks(); let ok = false;
      if (links.length === 1) { clickNewChat(links[0]); ok = true; }
      else if (round <= 2 && routerNew()) ok = true;
      else ok = await quietSidebarNew(my);
      if (!ok) {
        // 实在没有入口：一次受控的页面跳转，加载后自动接着这一轮
        log('未找到新建对话入口，改用页面跳转', 'warn'); run.resumeNavUntil = now() + 30000; persist();
        location.assign('/agent'); await nap(60000); throw new Stop('CANCEL', '', 'cancel');
      }
      const t0 = now();
      if (await waitFor(() => { const v = page.view(); guard(v); return blank(v); }, pace.ms(T.newChat), my)) { pace.note(now() - t0, 2500); return; }
      if (round >= 3) skip('新对话连续 3 次未就绪（每次等待 ' + pace.sec(T.newChat) + ' 秒）');
      log('新对话未就绪，重新打开新对话（第 ' + (round + 1) + ' 次）', 'warn');
    }
  }
  async function fillAndSend(my, attempt, fresh) {
    const s = run.settings, want = page.norm(s.prompt); phase(fresh ? '填写并发送' : '同一对话重发（第 ' + attempt.resends + ' 次）');
    let v = page.view(); guard(v);
    if (v.attachments.length) fatal('ATTACHMENT');
    // 残留草稿（上一轮没发出去的提示词、或用户误输入）：清空后重填，而不是直接暂停。
    if (v.draft && v.draft !== want) { log('输入框有残留内容，已清空后重填', 'warn'); try { page.clearDraft(); } catch {} await nap(150); }
    if (!await waitFor(() => { const x = page.view(); return x.editor && !x.spinner && !x.generating; }, pace.ms(10000), my, 150)) { if (fresh) skip('输入框 ' + pace.sec(10000) + ' 秒内未就绪，换新对话重试'); fatal('STEP', '输入框 ' + pace.sec(10000) + ' 秒内未就绪'); }
    let ready = false;
    for (let i = 0; i < 4 && !ready; i++) {
      const x0 = page.view();
      if (x0.draft !== want) { try { if (x0.draft) page.clearDraft(); page.writeDraft(s.prompt); } catch (e) { log('填写提示词失败：' + (e.message || e) + '，重试', 'warn'); } }
      // 轮询间隔 120ms：发送按钮一亮就发，不必等满 250ms。
      ready = !!await waitFor(() => { const x = page.view(); return x.sendReady && x.draft === want; }, pace.ms(i ? T.sendReady * 1.5 : T.sendReady), my, 120);
      if (!ready && i < 3) { log('发送按钮未就绪，重新填写提示词（第 ' + (i + 2) + ' 次）', 'warn'); await nap(300 + i * 400); }
    }
    if (!ready) {
      const x = page.view();
      // 草稿已对但按钮没亮（Arena 偶发不刷新按钮状态）：按 Enter 兜底发送。
      if (x.draft === want && page.pressEnter()) { log('发送按钮未亮，改用回车发送', 'warn'); }
      else if (fresh) skip('发送按钮未就绪或草稿不一致，换新对话重试');
      else fatal('STEP', '发送按钮未就绪或草稿不一致');
    }
    const serial = postSerial; let clicked = 0, post = null;
    const sentByPage = () => { const x = page.view(); return x.generating || (fresh && !!sidOf(location.href)) || (!x.draft && x.conversation) || postsSince(serial).some(p => p.kind === 'chat' || p.kind === 'append'); };
    for (;;) {
      guard(); attempt.sentAt = now();
      if (!ready && clicked === 0) { clicked = 1; } else if (!page.clickSend()) { if (sentByPage()) break; await nap(400); if (sentByPage()) break; if (!page.pressEnter()) { if (fresh) skip('发送按钮状态已改变'); fatal('STEP', '发送按钮状态已改变'); } }
      clicked++;
      post = await waitFor(() => postsSince(serial).find(p => p.kind === 'chat' || p.kind === 'append'), pace.ms(T.postSeen), my);
      if (post) { pace.note(now() - attempt.sentAt, 2500); break; }
      // The request hook can miss a POST on slow pages: if the page shows the message was sent, carry on.
      if (sentByPage()) { log('未捕获到发送请求，但页面已在回复，继续', 'warn'); break; }
      const x = page.view();
      if (clicked >= 2 || !(x.sendReady && x.draft === want)) { if (fresh && !sidOf(location.href)) skip('点击发送后 ' + pace.sec(T.postSeen) + ' 秒内未观察到发送'); fatal('STEP', '点击发送后 ' + pace.sec(T.postSeen) + ' 秒内未观察到发送'); }
      log('未观察到发送，再点一次发送', 'warn');
    }
    page.kbRestore(); // v1.11.77 已发出：输入框失焦、恢复输入法设置
    if (post) {
      if (post.status === 429) fatal('RATE_LIMIT'); if ([401, 403].includes(post.status)) fatal('AUTH', 'HTTP ' + post.status);
      if (post.status < 200 || post.status >= 300) fatal('HTTP', 'HTTP ' + post.status);
    }
    if (fresh) {
      // Prefer the address bar; Arena may push the URL late (queue), so the create-chat response id is accepted too.
      // Keep waiting while the page is still generating; only a silent page counts as a failure.
      const t0 = now(); let sid = null;
      for (;;) {
        sid = await waitFor(() => sidOf(location.href) || chatIds.find(c => c.at >= attempt.sentAt - 500)?.id, pace.ms(T.urlSeen), my);
        if (sid) break;
        if (!page.view().generating || now() - t0 > 4 * pace.ms(T.urlSeen)) fatal('STEP', Math.round((now() - t0) / 1000) + ' 秒内未拿到新对话地址');
        log('页面仍在生成，继续等待新对话地址', 'warn');
      }
      pace.note(now() - attempt.sentAt, 4000);
      attempt.sid = sid; attempt.url = location.origin + '/agent/' + sid; noteSid(sid);
    }
    changed();
  }
  async function monitor(my, attempt) {
    const s = run.settings; phase('等待模型识别');
    let settledAt = 0, idAt = 0, id = null, note = 0;
    for (;;) {
      if (!alive(my)) throw new Stop('CANCEL', '', 'cancel');
      tickContinue();
      const v = page.view(); guard(v);
      const here = sidOf(location.href);
      if (here ? here !== attempt.sid : !/^\/agent\/?$/.test(location.pathname)) fatal('LEFT');
      const live = core.runFor(attempt.sid), t = now();
      if (!v.generating && t >= watchdogUntil) settledAt ||= t; else settledAt = 0;
      const got = identify(live, attempt);
      if (got) {
        if (!id) pace.note(t - attempt.sentAt, 6000);
        // v1.11.78 只有完整身份（已结束调用的内部名）才报“已识别 X”：请求名 / 进行中的调用随后可能失败被 Arena 改派，
        // 以前一识别到就报名字，于是先报原模型、再报改派后的模型（左右横跳）
        const complete = !!got.internal && !got.partial;
        if (!id || got.name !== id.name) idAt ||= t;
        id = got;
        // v1.11.78 这一抽里原模型调用失败、被 Arena 改派：定名时只记一条日志，这一抽按实际回答的模型算（不弹提醒、不显示原模型）
        // v1.11.79 阶段文字不再带名字：名字由老虎机状态行跟着轮子一格一格写出（已识别厂商 X → 已识别 X 型号 → … · 档位），底栏 / 抽卡面板只写“已识别”
        const settle_ = () => { if (attempt.model !== id.name) { attempt.model = id.name; attempt.tier = id.tier; phase('已识别'); } if (id.routed && !attempt.routed) { attempt.routed = true; log('本抽原模型调用失败，Arena 已自动改派；按实际回答的 ' + noVertex(id.name) + ' 计'); } return id; };
        if (complete) settle_();
        // Rename only with a settled, final name: an internal name, or a stable fallback after 8s.
        if (settledAt && t - settledAt >= T.settle && (complete || t - idAt > pace.ms(8000))) return settle_();
        if (t - idAt > pace.ms(25000)) return settle_();
      } else if (id && live?.data?.failover?.pending) {
        // 识别到的调用随后失败、正在改派：收回，等改派后的模型（计时重新开始）
        id = null; idAt = 0;
      } else if (settledAt) {
        // The reply is finished but no model yet: trace data can lag, so wait (longer while it is still being read),
        // then resend in the same chat. Never skip the draw.
        const idle = t - settledAt, why = !live?.runId ? '没有运行记录' : live.busy ? '记录读取中' : '记录不完整';
        const limit = pace.ms(!live?.runId ? T.resendNoRun : (live.busy || !live.data) ? T.resendPending : T.resendDefault);
        if (idle >= limit) {
          if (attempt.resends >= T.maxResends) fatal('STEP', '同一对话重发 ' + T.maxResends + ' 次仍未识别到模型（' + why + '）');
          attempt.resends++; log('回复结束 ' + Math.round(idle / 1000) + ' 秒仍未识别到模型（' + why + '），在同一对话重发', 'warn');
          await fillAndSend(my, attempt, false); settledAt = 0; continue;
        }
        if (idle > 3000 && t - note > 5000) { note = t; phase('等待模型信息 ' + Math.round(idle / 1000) + '/' + Math.round(limit / 1000) + ' 秒'); }
      } else {
        const since = t - attempt.sentAt;
        if (since > T.genStall) fatal('STEP', '回复持续 ' + Math.round(since / 60000) + ' 分钟仍未识别到模型');
        if (since > 30000 && t - note > 10000) { note = t; phase('回复中，继续等待模型信息（' + Math.round(since / 1000) + ' 秒）'); }
      }
      await nap(150);
    }
  }
  async function settle(attempt, verdict, id) {
    const s = run.settings;
    if (attempt.sid) {
      // 改名放后台排队，不阻塞下一抽（改的是刚抽完的那个对话，不是正在看的新对话）
      const nm = titleOf(id); attempt.renamed = nm; queueRename(attempt.sid, nm).catch(e => { attempt.note = '改名失败 ' + (e.status ? 'HTTP ' + e.status : e.message); log(attempt.note, 'warn'); });
    }
    if (verdict === 'archive') {
      try { await archive(attempt.sid); attempt.archived = true; } catch (e) { attempt.note = '归档失败 ' + (e.status ? 'HTTP ' + e.status : e.message); log(attempt.note, 'warn'); }
    }
  }
  // v1.11.79 等老虎机把这一抽 厂商 → 型号 → 档位 依次停完（最多 max 毫秒；切到后台 / 老虎机收起不等）
  async function revealDone(my, max) { const t0 = now(); while (alive(my) && now() - t0 < max) { let busy = false; try { busy = gachaSlot.revealing(); } catch {} if (!busy) return; await nap(40); } }
  async function one(my) {
    // 每轮开始都读取最新保存的提示词（以前一直用开始抽卡时的快照，改了设置也还发旧词）。
    { const cur = settings(); run.settings = { ...run.settings, prompt: cur.prompt, intervalMs: cur.intervalMs, stopOnThinking: cur.stopOnThinking }; }
    const s = run.settings, attempt = { no: (run.seq = (run.seq || run.attempts.length) + 1), at: now(), sid: null, url: null, resends: 0, done: false };
    run.attempts.push(attempt); if (run.attempts.length > 200) run.attempts.splice(0, run.attempts.length - 200); changed();
    try {
      await ensureIdle(my); guard(); await openNewChat(my); await fillAndSend(my, attempt, true);
      const id = await monitor(my, attempt), verdict = classify(id, s);
      attempt.verdict = verdict; attempt.done = true; run.completed++; attempt.draw = run.completed; try { attempt.shown = core?.shown?.(attempt.sid) || null; } catch {} run.skips = 0; run.recovered = false;
      log('#' + run.completed + ' ' + id.name + (id.tier ? ' · ' + id.tier : '') + ' → ' + ({ hit: '命中目标', keep: '保留', archive: '归档' }[verdict]));
      await settle(attempt, verdict, id);
      // 次数优先：命中只记录，不提前结束，直到抽满设定次数。
      if (verdict === 'hit') { run.hits = [...(run.hits || []), id.name].slice(-50); log('命中目标：' + id.name + '（已命中 ' + run.hits.length + ' 次，继续抽满 ' + s.maxAttempts + ' 次）'); }
    } catch (e) {
      attempt.done = true;
      if (e instanceof Stop && e.kind === 'fatal' && e.code === 'STEP') { e.kind = 'skip'; }
      if (e instanceof Stop && e.kind === 'skip') { attempt.verdict = 'skipped'; attempt.note = e.message; run.skips++; run.skipTotal = (run.skipTotal || 0) + 1; log('本轮未完成，不计次数，换新对话补抽：' + e.message.replace(/^SKIP · /, '').replace(/^抽卡步骤未能完成(?:，已暂停（点 START 继续）)? · /, ''), 'warn'); changed(); await nap(T.skipNap); return; }
      attempt.verdict = e instanceof Stop && e.kind === 'cancel' ? 'cancelled' : 'error'; attempt.note = e.message; throw e;
    } finally { page.kbRestore(); changed(); }
  }
  async function loop(my) {
    try {
      while (alive(my)) {
        const s = run.settings;
        if (run.completed >= s.maxAttempts) { const h = run.hits || []; finish(h.length ? 'hit' : 'done', '已完成 ' + run.completed + '/' + s.maxAttempts + ' 次' + (h.length ? '，命中 ' + h.length + ' 次：' + [...new Set(h)].join('、') : '，未命中目标')); break; }
        // 连续失败时逐步放慢（5/10/20/40 秒）再补抽；连续 8 次都失败才判定页面异常并暂停。补抽总数上限为设定次数的 2 倍。
        if (run.skips >= 8) fatal('SKIPS');
        if ((run.skipTotal || 0) > Math.max(10, s.maxAttempts * 2)) fatal('SKIPS', '补抽次数过多（' + run.skipTotal + ' 次）');
        if (run.skips >= 2) { const w = Math.min(40000, 5000 * 2 ** (run.skips - 2)); phase('连续 ' + run.skips + ' 次未完成，' + Math.round(w / 1000) + ' 秒后补抽'); await nap(w); if (!alive(my)) break; }
        await one(my);
        if (!alive(my)) break;
        // v1.11.79 老虎机依次停完再开下一个对话（与间隔等待同时计时）：顶部标题不会在揭晓到一半时被新对话换掉；
        // 三格都停下后完整结果（顶部的档位与“识别模型为 …”）至少停留 0.6 秒再切走
        phase('间隔等待'); { const t0 = now(); await revealDone(my, 2500); let dwell = 0; try { dwell = Math.max(0, 600 - gachaSlot.settledFor()); } catch {} await nap(Math.max(s.intervalMs - (now() - t0), dwell)); }
      }
    } catch (e) { if (my === token) await halt(e); }
    finally { if (my === token && run?.status === 'stopping') { run.status = 'stopped'; run.reason = '已手动停止'; run.endedAt = now(); changed(); } if (run && !['running'].includes(run.status)) void archiveQueued(false); }
  }
  async function halt(e) {
    if (!run || !['running', 'stopping'].includes(run.status)) return;
    token++;
    if (e instanceof Stop && e.kind === 'cancel') { run.status = 'stopped'; run.reason = run.reason || '已手动停止'; }
    else { run.status = 'stopped'; run.code = e?.code || 'ERROR'; run.reason = e?.message || String(e); log(run.reason, 'error'); }
    run.endedAt = now();
    run.phase = ''; run.ipOld = null;
    if (ipLimited()) {
      // 429 限流按 IP 计：提示切换 IP，并记下当前（Arena 看到的）IP，用来确认之后是否真的换了
      run.reasonRaw = run.reason; run.reason = '当前 IP 被限流（HTTP 429），请切换 IP 后点「我已更换 IP」';
      const id = run.id; void ipNow().then(ip => { if (run?.id === id && ipLimited() && ip) { run.ipOld = ip; run.reason += ' · 当前 IP ' + ip; changed(); } });
    }
    changed();
  }
  const ipLimited = () => !!run && ['stopped', 'paused'].includes(run.status) && (run.code === 'RATE_LIMIT' || run.code === 'ALERT_LIMIT' || (run.code === 'QUOTA' && /429|速率|限流/.test(run.reasonRaw || run.reason || '') && !/余额/.test(run.reasonRaw || run.reason || '')));
  // Arena 实际看到的出口 IP：同域 Cloudflare trace；取不到再用 ipify
  async function ipNow() {
    try { const r = await fetch('/cdn-cgi/trace', { cache: 'no-store', credentials: 'omit' }); const m = /(?:^|\n)ip=([^\n]+)/.exec(await r.text()); if (m) return m[1].trim(); } catch {}
    try { const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store', credentials: 'omit' }); const j = await r.json(); if (j?.ip) return String(j.ip); } catch {}
    return null;
  }
  // 用户点“我已更换 IP”：确认 IP 变了、新 IP 访问 Arena 正常（非 429），清掉本地限流记录后继续抽卡
  async function ipRetry() {
    if (!ipLimited()) return { ok: false, error: '当前不是 IP 限流暂停' };
    const old = run.ipOld || null, ip = await ipNow();
    if (old && ip && ip === old) return { ok: false, error: 'IP 还是 ' + ip + '，没有变化，请确认已切换（切换后可能要等几秒）' };
    try { const r = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' }); if (r.status === 429) return { ok: false, error: '新 IP ' + (ip || '') + ' 仍被限流（HTTP 429），请再换一个' }; }
    catch (e) { return { ok: false, error: '无法连接 Arena：' + (e?.message || e) }; }
    try { core?.clearLimits?.(); } catch {}
    const msg = 'IP 已从 ' + (old || '未知') + ' 更换为 ' + (ip || '未知') + '，检测正常，重新开始抽卡（从 0 开始）';
    const res = start(); if (res.ok) log(msg); return res.ok ? { ok: true, msg } : res;
  }
  function finish(status, reason) { if (!run) return; token++; run.status = status; run.reason = reason; run.phase = ''; run.endedAt = now(); log(reason); changed(); }
  async function archiveQueued(manual) {
    if (!run) return 0;
    const todo = manual ? run.attempts.filter(a => a.verdict === 'archive' && a.sid && !a.archived) : [];
    for (const sid of (run.archiveQueue || [])) todo.push({ sid, fromQueue: true });
    let n = 0; for (const a of todo) { try { await archive(a.sid); a.archived = true; n++; } catch (e) { a.note = '归档失败 ' + (e.status ? 'HTTP ' + e.status : e.message); } await nap(400); }
    run.archiveQueue = todo.filter(a => a.fromQueue && !a.archived).map(a => a.sid);
    if (todo.length) { log('整理完成：归档 ' + n + '/' + todo.length + ' 个本次抽卡产生的对话'); } return n;
  }
  function start(resume = false) {
    if (!core) return { ok: false, error: REASONS.NO_CORE };
    if (run && ['running', 'stopping'].includes(run.status)) return { ok: false, error: '抽卡正在进行' };
    const s = settings();
    // v1.11.73 每次开始都是全新的一轮（从 0 开始），不接着旧进度；只把上一轮还没归档完的对话带过来继续归档
    const carry = run ? [...new Set([...(run.archiveQueue || []), ...(run.attempts || []).filter(a => a.verdict === 'archive' && a.sid && !a.archived).map(a => a.sid)])].slice(-200) : [];
    run = { id: Math.random().toString(36).slice(2), status: 'running', startedAt: now(), settings: s, completed: 0, skips: 0, skipTotal: 0, hits: [], attempts: [], log: [], phase: '', reason: '', archiveQueue: carry };
    log('开始抽卡 · 共 ' + s.maxAttempts + ' 抽 · 从 0 开始');
    if (!/^\/agent(\/|$)/.test(location.pathname)) {
      // Not on an Agent page: go to /agent (a fresh chat) and let the run resume automatically after load.
      log('当前不是 Agent 页面，正在前往 arena.ai/agent 新建对话'); run.resumeNavUntil = now() + 30000; run.autoResume = false; token++; persist(); changed();
      location.assign('/agent'); return { ok: true, navigating: true };
    }
    run.autoResume = false; const my = ++token; changed(); void loop(my); return { ok: true };
  }
  function stop() { if (!run || !['running'].includes(run.status)) return; run.status = 'stopping'; run.reason = '已手动停止'; token++; changed(); setTimeout(() => { if (run?.status === 'stopping') { run.status = 'stopped'; run.endedAt = now(); changed(); } }, 300); }
  // 抽卡中用户亲手点了 Arena 的“停止生成”（isTrusted，脚本自己的 click() 不算）→ 视为停止抽卡（停止就是结束）
  try { document.addEventListener('click', e => {
    if (!e.isTrusted || run?.status !== 'running') return;
    const b = e.target?.closest?.('button'); if (!b || b.closest('[role="log"]')) return;
    if (!['Stop generating', '停止生成', 'Stop response'].includes((b.getAttribute('aria-label') || b.textContent || '').trim())) return;
    log('检测到手动停止生成，抽卡已停止'); stop();
  }, true); } catch {}
  function reset() { if (run && ['running', 'stopping'].includes(run.status)) return; run = null; try { sessionStorage.removeItem(RUN); } catch {} changed(); }
  function bindCore(c) { core = c; if (run?.autoResume && run.status === 'running') { run.autoResume = false; const my = ++token; setTimeout(() => void loop(my), 1500); } else if (run && !['running', 'stopping'].includes(run.status) && run.archiveQueue?.length) setTimeout(() => { if (run && !['running', 'stopping'].includes(run.status)) void archiveQueued(false); }, 4000); }
  // v8.1 detector reloads the page on sidebar New Chat clicks; gacha clicks set a short-lived flag to bypass it.
  const reloadSuppressed = () => now() < suppressReloadUntil || (run?.status === 'running');
  // v1.11.77 “换模型”类弹窗（模型变更提醒 / 被 Arena 改派 / 疑似换模型）在抽卡里一律不弹：抽卡进行中（含正在停止），
  // 或当前是抽卡开出的对话、且最后一条用户消息就是抽卡提示词。在抽卡对话里自己接着问别的，提醒照常。
  function quietTurn(sid) {
    if (run && ['running', 'stopping'].includes(run.status)) return true;
    if (!sid || !gSids.has(sid)) return false;
    let cs = null; try { cs = page.chatState(); } catch {}
    if (!cs || cs.sid !== sid) return true;
    const n = x => String(x || '').replace(/\s+/g, ' ').trim(), ps = [settings().prompt, run?.settings?.prompt].filter(Boolean).map(n);
    return !cs.userText || ps.includes(n(cs.userText));
  }
  // 老虎机动画用：当前这一抽的实时识别进度（不复制整个 run，便宜，可高频调用）
  function peek() {
    if (!run) return null;
    const a = run.attempts.at(-1) || null; let partial = '', exact = '';
    if (a?.sid && core?.runFor && !a.done) { try { const live = core.runFor(a.sid), rc = servingCalls(live?.data).at(-1); if (live && live.sid === a.sid && !(a.sentAt && live.submittedAt && live.submittedAt < a.sentAt - 3000)) { exact = rc?.internal || rc?.response || ''; partial = exact || rc?.request || (rc?.model && rc.model !== '未提供' ? rc.model : ''); } } catch {} }
    const ok = !!a?.done && ['hit', 'keep', 'archive'].includes(a.verdict);
    // v1.11.73 显示用的“第几抽”只按真正完成的抽数算（补抽 / 页面没加载好的轮次不涨号）；shown = 顶部标题此刻显示的厂商 / 型号 / 档位
    const max0 = run.settings?.maxAttempts || 1, draw = a?.draw || Math.max(1, Math.min(max0, (run.completed || 0) + 1));
    // v1.11.77 抽完之后标题仍显示这个对话时继续跟标题（标题要等抽卡定名那一刻才给出完整结果）
    let shown = a?.shown || null; if (a?.sid && core?.shown) { try { const live = core.shown(a.sid) || null; if (!a.done || (live && (live.full || !shown))) shown = live || (a.done ? shown : null); } catch {} }
    return { draw, shown, id: run.id, status: run.status, reason: run.reason || '', completed: run.completed || 0, max: run.settings?.maxAttempts || 0, hits: (run.hits || []).length, no: a?.no || 0, phase: run.phase || '', sid: a?.sid || null, sent: !!a?.sentAt, done: !!a?.done, ok, verdict: a?.verdict || '', model: a?.model || '', tier: a?.tier || null, partial: validName(partial) ? partial : '', exact: validName(exact) ? exact : '' };
  }
  return {
    QUANTITIES, DEFAULTS, REASONS, settings, saveSettings, saveOk: () => saveOk, VENDORS, vendorFromText, setVendor, noteChatId, ownsTitle: sid => owned.has(sid), waitIdle, pendingTitle: sid => { const t = renameWant.get(sid); return t && Date.now() - (renameAt.get(sid) || 0) < 600000 ? t : null; }, followModel, start, stop, reset, bindCore, ipLimited, ipRetry, notePost, reloadSuppressed, archiveQueued: () => archiveQueued(true), running: () => run?.status === 'running',
    state: () => run ? JSON.parse(JSON.stringify(run)) : null, peek, setPaint(fn) { paintFn = fn; }, get revision() { return rev; },
    running: () => !!run && ['running', 'stopping'].includes(run.status), quietTurn,
    _test: { identify, classify, validName, titleOf, page, T, pace }
  };
})();

// ====================================================================================
// 出错自动刷新：对话里出现 “Something went wrong. Please try again.” 时倒计时 5 秒后刷新当前对话。
// 整页刷新（手动 F5 或自动刷新）后滚到最新消息一次——只在加载阶段滚，之后不锁定，可随意往上翻看历史。
// 不自动刷新的情况：输入框有未发送内容、抽卡运行/停止中/暂停、页面显示限流提示、页面加载时就已存在的错误、刷新次数超限。
// ====================================================================================
const errReload = (() => {
  const CONV = /^\/agent\/([0-9a-f-]{36})\/?$/i;
  const LOG_KEY = 'amp.native.errReload', JUST_KEY = 'amp.native.errReload.just';
  const WAIT = 5, PER_SID_GAP = 60e3, WINDOW = 10 * 60e3, MAX_IN_WINDOW = 3, BASELINE = 6000;
  const PHRASE = /^(?:something went wrong[.!。]?(?:\s*please try again[.!。]?)?|出了点问题[，,。.]?(?:\s*请重试[。.!！]?)?|出错了[，,。.]?(?:\s*请重试[。.!！]?)?)$/i;
  const SKIP = 'pre,code,blockquote,[contenteditable="true"],textarea,.prose,[class*="markdown"],[data-streamdown],[data-message-author-role],[data-user-message-layout]';
  const sidNow = () => (CONV.exec(location.pathname) || [])[1] || null;
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!el?.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const read = (k, d) => { try { const v = JSON.parse(sessionStorage.getItem(k) || 'null'); return v ?? d; } catch { return d; } };
  const write = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const mainEl = () => document.querySelector('main');
  const logEl = () => { const m = mainEl(); return m && [...m.querySelectorAll('[role="log"]')].find(visible) || null; };

  // 只认“整段文字就是这句话”的提示元素；消息正文、代码、输入框里出现同样的句子不算
  function findError() {
    const m = mainEl(); if (!m) return null;
    let snap; try { snap = document.evaluate(".//*[contains(text(),'Something went wrong') or contains(text(),'something went wrong') or contains(text(),'出了点问题') or contains(text(),'出错了')]", m, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); } catch { return null; }
    for (let i = snap.snapshotLength - 1; i >= 0; i--) {
      let el = snap.snapshotItem(i);
      if (el.closest(SKIP)) continue;
      for (let up = el.parentElement, n = 0; up && up !== m && n < 3; up = up.parentElement, n++) { if (PHRASE.test(norm(up.textContent))) el = up; else break; }
      if (PHRASE.test(norm(el.textContent)) && visible(el)) return el;
    }
    return null;
  }
  // Arena 对话页的状态（React context：{ id, messages, status, … }），从对话区往上找
  function chatValue() {
    const sid = sidNow(), log = logEl(); if (!sid || !log) return null;
    try { let f = log[Object.keys(log).find(k => k.startsWith('__reactFiber'))]; for (let n = 0; f && n < 100; n++, f = f.return) { const v = f.memoizedProps?.value; if (v && v.id === sid && Array.isArray(v.messages)) return v; } } catch {}
    return null;
  }
  function chatStatus() { const v = chatValue(); return v ? String(v.status || '') : null; }
  // 任务进行中：页面状态是 submitted / streaming（Arena 自己的 isStreaming 也这样算），或者看得到“停止生成”按钮
  const STOP_RE = /^(?:stop(?:\s+(?:generating|response|streaming))?|停止(?:生成|回答)?)$/i;
  let runAt = 0, runVal = false;
  function turnBusy(fresh) {
    const now = Date.now(); if (!fresh && now - runAt < 300) return runVal; runAt = now;
    const st = chatStatus(); if (st === 'submitted' || st === 'streaming') return (runVal = true);
    const m = mainEl(); return (runVal = !!m && [...m.querySelectorAll('button')].some(b => STOP_RE.test(norm(b.getAttribute('aria-label') || b.textContent)) && visible(b)));
  }
  const draft = () => [...document.querySelectorAll('main div[contenteditable="true"], main textarea')].filter(visible).some(e => norm(e.value ?? e.innerText ?? e.textContent).length > 0);
  const gachaBusy = () => { try { const pk = gacha.peek(); return !!pk && ['running', 'stopping'].includes(pk.status); } catch { return false; } };
  const limited = () => { try { return [...document.querySelectorAll('[role="alert"]')].some(e => visible(e) && /too many requests|rate limit|try again later|quota exceeded|limit reached|429/i.test(e.textContent || '')); } catch { return false; } };
  function budget(sid) { const now = Date.now(), list = read(LOG_KEY, []).filter(x => x && now - x.at < WINDOW); return { list, ok: !list.some(x => x.sid === sid && now - x.at < PER_SID_GAP) && list.length < MAX_IN_WINDOW, n: list.length }; }

  // ---------- 提示条 ----------
  let host = null, box = null, hideTimer = 0;
  function ui() {
    if (box?.isConnected) return box;
    host = document.createElement('div'); host.id = 'amp-err-reload'; host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000';
    const root = host.attachShadow({ mode: 'open' }), st = document.createElement('style');
    st.textContent = '.b{position:fixed;display:flex;align-items:center;gap:8px;box-sizing:border-box;width:max-content;max-width:min(580px,calc(100vw - 24px));padding:8px 8px 8px 14px;border-radius:12px;background:rgba(38,37,34,.95);color:#f3f1ec;font:13px/1.45 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.28);transform:translateX(-50%);animation:in .18s ease-out}.b[hidden]{display:none}.t{flex:1;min-width:0}.b button{flex:none;height:26px;padding:0 10px;border:0;border-radius:7px;cursor:pointer;font:inherit;font-size:12px;background:rgba(255,255,255,.12);color:#f3f1ec}.b button:hover{background:rgba(255,255,255,.2)}.b button.p{background:#d8d3ca;color:#262522}.b button.p:hover{background:#fff}.b button.x{width:26px;padding:0;font-size:15px;background:transparent;color:rgba(243,241,236,.6)}@keyframes in{from{opacity:0;transform:translate(-50%,6px)}}';
    box = document.createElement('div'); box.className = 'b'; box.hidden = true; box.setAttribute('role', 'status');
    root.append(st, box); (document.body || document.documentElement).append(host);
    return box;
  }
  function place() {
    if (!box) return;
    const m = mainEl()?.getBoundingClientRect(), ed = [...document.querySelectorAll('main div[contenteditable="true"], main textarea')].find(visible), f = (ed?.closest('form') || ed)?.getBoundingClientRect();
    box.style.left = Math.round(m && m.width ? m.left + m.width / 2 : innerWidth / 2) + 'px';
    box.style.bottom = Math.round(f && f.height ? Math.max(12, innerHeight - f.top + 10) : 150) + 'px';
  }
  function show(text, actions = [], closable = false, kind = '') {
    const b = ui(); clearTimeout(hideTimer); b.textContent = ''; b.dataset.kind = kind;
    const t = document.createElement('span'); t.className = 't'; t.textContent = text; b.append(t);
    actions.forEach(([label, fn], i) => { const x = document.createElement('button'); x.type = 'button'; x.textContent = label; if (!i) x.className = 'p'; x.onclick = fn; b.append(x); });
    if (closable) { const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.title = '关闭'; x.onclick = () => { stale = true; hide(); }; b.append(x); }
    b.hidden = false; place();
  }
  function hide() { if (timer) busy = false; clearInterval(timer); timer = 0; errBar = false; if (box) box.hidden = true; }
  function toast(text, ms = 3200) { show(text, [], false, 'toast'); hideTimer = setTimeout(hide, ms); }

  // ---------- 检测与自动刷新 ----------
  let timer = 0, busy = false, stale = false, baseSid = null, baseUntil = 0, errBar = false;
  function reloadNow(sid, auto) {
    sid = sid || sidNow();
    if (auto) { const b = budget(sid); b.list.push({ sid, at: Date.now() }); write(LOG_KEY, b.list); }
    write(JUST_KEY, { sid, at: Date.now(), auto: !!auto });
    clearInterval(timer); timer = 0; show('正在刷新当前对话…');
    location.reload();
  }
  function cancel() { stale = true; busy = false; hide(); }
  function autoReload(sid, label) {
    let n = WAIT; busy = true;
    const paint = () => show(label.replace('{n}', n), [['立即刷新', () => reloadNow(sid, false)], ['取消', cancel]], false, 'count');
    paint(); clearInterval(timer);
    timer = setInterval(() => {
      if (sidNow() !== sid) { busy = false; hide(); return; }
      if (draft()) { clearInterval(timer); timer = 0; busy = false; show('输入框里有未发送的内容，没有自动刷新；需要时手动刷新', [['刷新', () => reloadNow(sid, false)]], true); errBar = true; return; }
      if (--n <= 0) { clearInterval(timer); timer = 0; reloadNow(sid, false); return; }
      paint();
    }, 1000);
  }
  function countdown(sid) {
    let n = WAIT; busy = true;
    const paint = () => show('检测到 “Something went wrong”，' + n + ' 秒后自动刷新当前对话', [['立即刷新', () => reloadNow(sid, false)], ['取消', cancel]]);
    paint(); clearInterval(timer);
    timer = setInterval(() => {
      if (sidNow() !== sid || !findError()) { busy = false; hide(); return; } // 已恢复或已离开这个对话
      if (draft()) { clearInterval(timer); timer = 0; busy = false; stale = true; show('输入框里有未发送的内容，已取消自动刷新；需要时手动刷新', [['刷新', () => reloadNow(sid, false)]], true); errBar = true; return; }
      if (--n <= 0) { clearInterval(timer); timer = 0; reloadNow(sid, true); return; }
      paint();
    }, 1000);
  }
  function tick() {
    const sid = sidNow();
    if (!sid) { if (busy) { busy = false; hide(); } baseSid = null; return; }
    if (sid !== baseSid) { baseSid = sid; baseUntil = 0; stale = false; busy = false; hide(); }
    if (!baseUntil) { if (!logEl()) return; baseUntil = Date.now() + BASELINE; } // 对话渲染出来后的前几秒算“加载时就有”
    if (busy) return;
    const el = findError();
    if (!el) { stale = false; if (errBar) hide(); return; }
    if (Date.now() < baseUntil) { stale = true; return; }
    if (stale) return;
    const st = chatStatus(); if (st === 'submitted' || st === 'streaming') return;
    if (gachaBusy() || limited()) return;
    stale = true; // 这一次出错只处理一次；提示消失后再出现才会重新处理
    if (draft()) { show('检测到 “Something went wrong”。输入框里有未发送的内容，没有自动刷新', [['刷新', () => reloadNow(sid, false)]], true); errBar = true; return; }
    const b = budget(sid);
    if (!b.ok) { show('近 10 分钟已自动刷新 ' + b.n + ' 次，暂停自动刷新；需要时手动刷新', [['刷新', () => reloadNow(sid, false)]], true); errBar = true; return; }
    stale = false; countdown(sid);
  }

  // ---------- 刷新后滚到最新消息（一次，不锁定） ----------
  function findScroller() {
    const log = logEl(); if (!log) return null;
    const can = e => { if (e.scrollHeight - e.clientHeight <= 1) return false; const oy = getComputedStyle(e).overflowY; return oy === 'auto' || oy === 'scroll' || oy === 'overlay'; };
    // 优先对话区本身（Arena 的 role="log" 就是滚动容器），其次它里面一两层，最后才是最近的可滚动外层。
    // 以前取“可滚动空间最大”的：外层容器也能滚时会选错，跟随时整块聊天区被推走，看起来像跳回中间。
    if (can(log)) return log;
    let best = null, room = 0;
    for (const e of log.querySelectorAll(':scope > *, :scope > * > *')) { const r = e.scrollHeight - e.clientHeight; if (r > room + 1 && can(e)) { best = e; room = r; } }
    if (best) return best;
    for (let e = log.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) if (can(e)) return e;
    const se = document.scrollingElement; return se && se.scrollHeight - se.clientHeight > 1 ? se : null;
  }
  // v1.11.71 输入法弹出 / 输入框变高 → 对话区变矮时，保持最底下那段内容不动（整体跟着输入框往上推）；收起时再一起落回去
  (() => {
    let sc = null, ro = null, lastH = 0, lastTop = 0;
    const note = () => { if (sc) { lastH = sc.clientHeight; lastTop = sc.scrollTop; } };
    const fit = () => {
      if (!sc || !sc.isConnected) return; const h = sc.clientHeight;
      if (lastH && h !== lastH) { const want = Math.max(0, Math.min(sc.scrollHeight - h, lastTop + (lastH - h))); if (Math.abs(sc.scrollTop - want) > 1) { sc._ampAnchorAt = Date.now(); sc.scrollTop = want; } }
      note();
    };
    // 浏览器改高度时可能先把滚动位置“夹”到底部并发出 scroll：高度已变就按变化前的位置补偿，而不是把被夹过的位置当成新的起点
    const onScroll = () => { if (sc && lastH && sc.clientHeight !== lastH) fit(); else note(); };
    const bind = () => { let s = null; try { s = findScroller(); } catch {} if (s === sc) return; try { ro?.disconnect(); } catch {} sc?.removeEventListener('scroll', onScroll); sc = s; lastH = 0; if (!sc) return; ro = new ResizeObserver(fit); ro.observe(sc); sc.addEventListener('scroll', onScroll, { passive: true }); note(); };
    setInterval(bind, 1200); try { window.visualViewport?.addEventListener('resize', () => requestAnimationFrame(fit)); } catch {}
  })();
  function bottomOnce(msg) {
    const t0 = Date.now(); let done = false, lastH = -1, stableAt = Date.now(), sc = null, said = false;
    const off = () => { if (done) return; done = true; clearInterval(iv); removeEventListener('wheel', off, true); removeEventListener('touchstart', off, true); removeEventListener('keydown', onKey, true); removeEventListener('mousedown', onDown, true); };
    const onKey = e => { if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown)$/.test(e.key) || (e.key === ' ' && !e.target?.closest?.('[contenteditable="true"],textarea,input'))) off(); };
    const onDown = e => { if (sc && (e.target === sc || sc.contains(e.target))) off(); };
    addEventListener('wheel', off, { capture: true, passive: true }); addEventListener('touchstart', off, { capture: true, passive: true }); addEventListener('keydown', onKey, true); addEventListener('mousedown', onDown, true);
    const iv = setInterval(() => {
      if (done) return;
      if (follow.on || Date.now() - t0 > 15000) { off(); return; } // 跟随接手后交给跟随（它会把最新内容贴在输入框上方）
      if (!sc || !sc.isConnected) sc = findScroller();
      if (!sc) return;
      const h = sc.scrollHeight, room = h - sc.clientHeight;
      if (h !== lastH) { lastH = h; stableAt = Date.now(); }
      if (room > 2 && sc.scrollTop < room - 2) sc.scrollTop = h;
      if (msg && !said) { said = true; toast(msg); }
      if (Date.now() - stableAt > 2500 && room > 2) off();
    }, 200);
  }
  // ---------- 跟随最新：最新内容（最底部的白点）一直贴在输入框上方 ----------
  // 自动开始：① 发送消息、在交互面板里做了选择；② 打开 / 刷新对话时任务正在进行、画面停在最底部（这个对话里没往上翻过）。
  // 手动开始：③ 点页面自带的“到底部”按钮；④ 任务进行中自己往下滚到露出最底部的白点。
  // 跟随时：内容变长就往下补；工具组（Running commands → Ran commands、Thinking… 等）做完自动收起、内容变短时往上补，
  //   不留空白、不把最新内容晾在屏幕中间；Arena 发送后把提问平滑滚到顶部（下面空出一大块）也会被拉回到底部。
  // 取消：往上翻对话（手指下拉 / 滚轮上滑 / PageUp·↑·Home·Shift+空格 / 往上拖滚动条）。
  //   在代码块、命令输出这类自带滚动、还能往上滚的小框里滑不算；点按按钮、在输入框里打字也不算。之后滚回最底部或再发消息就恢复。
  const follow = (() => {
    const LABEL = /scroll\s*(?:to\s*)?(?:the\s*)?(?:bottom|end|latest)|scroll\s*down|(?:jump|go|back|return|skip)\s*to\s*(?:the\s*)?(?:bottom|latest|present|end|recent)|(?:new|latest)\s*messages?|滚动到底|滚到底|回到底|到底部|跳到底|最新消息|回到最新|新消息/i;
    const NOT = 'aside,nav,header,form,[role="dialog"],[role="menu"],[role="listbox"],[role="tablist"],[data-sidebar],[contenteditable="true"]';
    const PAD = 24, PULL = 6; // 白点与输入框顶边保持 24px（Arena 自己的底部也留 24px）；下面空出超过 6px 才往上补
    let on = false, sc = null, findAt = 0, raf = 0, path = '', holding = false, pressed = false, pressAt = 0, downTop = 0, verify = 0;
    let inAt = 0, inDir = 0, lastTop = -1, selfTop = -1;
    let touching = false, touchAt = 0, touchY = null, touchMoved = false, touchBox = false, gestureUntil = 0;
    let userUp = false, upPath = '', armedUntil = 0, armTimer = 0, told = false;
    const running = () => turnBusy();
    const gap = e => e.scrollHeight - e.clientHeight - e.scrollTop;
    const scroller = () => { if (sc && sc.isConnected && sc !== document.scrollingElement) return sc; if (Date.now() - findAt < 400) return sc && sc.isConnected ? sc : null; findAt = Date.now(); return (sc = findScroller()); };
    const inScroller = t => { const s = scroller(); return !!(s && t && (t === s || s.contains(t))); };
    // 最新内容的末尾（白点所在处）和可见区域的底边（吸底输入框的顶边）；认不出页面结构时返回 null，退回“滚到最底部”
    function edges(s) {
      if (s === document.scrollingElement || s === document.body) return null;
      const sr = s.getBoundingClientRect(); let end = -Infinity, vis = sr.bottom;
      for (const c of s.children) {
        const cs = getComputedStyle(c); if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
        const r = c.getBoundingClientRect(); if (r.height <= 0) continue;
        if (cs.position === 'sticky') { if (r.top > sr.top + sr.height * 0.3 && r.top < vis) vis = r.top; continue; }
        if (!c.childElementCount && !norm(c.textContent)) continue; // 空白垫片不算内容
        if (r.bottom > end) end = r.bottom;
      }
      return end === -Infinity ? null : { end, vis };
    }
    const need = s => { const e = edges(s); return e ? e.end - (e.vis - PAD) : gap(s); }; // > 0：还要往下滚多少；< 0：下面空出多少
    const atEnd = s => { const e = edges(s); return e ? e.end <= e.vis + 2 : gap(s) <= 8; }; // 白点露出来了
    const isTouching = () => touching && Date.now() - touchAt < 5000; // 被点的元素消失时收不到 touchend：5 秒没动静就当松手
    const paused = () => (holding && Date.now() - pressAt < 60000) || isTouching() || Date.now() < gestureUntil;
    const setTop = (s, v) => { s.scrollTop = v; selfTop = s.scrollTop; };
    const mine = s => Math.abs(s.scrollTop - selfTop) < 1.5; // 是跟随自己滚的
    function loop() {
      raf = 0; if (!on) return;
      if (location.pathname !== path) { stop(); return; }
      const s = scroller();
      if (s && !paused()) {
        const n = need(s), room = s.scrollHeight - s.clientHeight;
        if (n > 1 && s.scrollTop < room - 0.5) setTop(s, Math.min(room, s.scrollTop + n));
        // 工具组收起 / 提问被顶到上方后下面空了一块：往上补，最新内容回到输入框上方（只在任务进行中，Arena 这时才留空白）
        else if (n < -PULL && s.scrollTop > 0.5 && running()) setTop(s, Math.max(0, s.scrollTop + n));
      }
      raf = requestAnimationFrame(loop);
    }
    function begin(quiet) {
      if (!sidNow()) return false;
      const was = on; on = true; path = location.pathname; userUp = false; armedUntil = 0; clearInterval(armTimer);
      if (!sc || !sc.isConnected) { findAt = 0; scroller(); }
      if (pressed && sc) { holding = true; downTop = sc.scrollTop; } // 拖着滚动条到底时，松手前先不动
      if (!raf) raf = requestAnimationFrame(loop);
      // 倒计时 / 别的提示在用时不弹（toast 收起时会连带取消倒计时）；自动开始的只在本页第一次提示
      if (!was && !(quiet && told) && !timer && !errBar && (!box || box.hidden)) { told = true; toast(quiet ? '已自动跟随最新消息 · 往上滑动即可取消' : '已跟随最新消息 · 向上滚动取消', 1800); }
      return true;
    }
    function stop(user) { on = false; holding = false; clearInterval(verify); if (raf) cancelAnimationFrame(raf); raf = 0; if (user) { userUp = true; upPath = location.pathname; } }
    // 发送消息 / 交互面板选择后：马上跟随；新对话要等地址变成 /agent/<id>，20 秒内等到就开始
    function arm() {
      userUp = false; armedUntil = Date.now() + 20000;
      if (begin(true)) return;
      clearInterval(armTimer);
      armTimer = setInterval(() => { if (on || Date.now() > armedUntil) { clearInterval(armTimer); return; } if (sidNow() && logEl()) begin(true); }, 250);
    }
    // 每秒看一次：任务进行中、画面在最底部、这个对话里没往上翻过 → 自动跟随
    function watch() {
      if (on) return;
      if (upPath && upPath !== location.pathname) { userUp = false; upPath = ''; }
      if (userUp || !sidNow() || paused()) return;
      const s = scroller(); if (s && running() && atEnd(s)) begin(true);
    }
    function onClick(e) {
      const b = e.target?.closest?.('button,[role="button"]'); if (!b || !sidNow() || b.closest(NOT) || b.hasAttribute('aria-haspopup') || b.hasAttribute('aria-expanded')) return;
      const label = norm([b.getAttribute('aria-label'), b.getAttribute('title'), b.textContent].filter(Boolean).join(' '));
      if (LABEL.test(label)) { sc = null; begin(); return; }
      // 认不出文字的按钮（通常只有一个箭头图标）：点的时候不在底部、2.5 秒内页面自己滚到了底部 → 就是“到底部”按钮。
      // 流式输出时底部一直在往下走，平滑滚动停在“点击那一刻的底部”时可能还差很多：
      // 所以只要往下走了点击时离底部距离的六成以上，或者已经离底部很近（初始距离的 1/4，最多 160px），就算。
      const m = mainEl(); if (!m || !m.contains(b) || label.length > 24) return;
      const s = findScroller(), g0 = s ? gap(s) : 0; if (!s || g0 < 40) return;
      const top0 = s.scrollTop, near = Math.max(3, Math.min(160, g0 * 0.25));
      clearInterval(verify); const t0 = Date.now();
      verify = setInterval(() => { if (!s.isConnected || Date.now() - t0 > 2500) { clearInterval(verify); return; } const moved = s.scrollTop - top0; if (moved > 20 && (gap(s) <= near || moved >= g0 * 0.6)) { clearInterval(verify); sc = s; begin(); } }, 80);
    }
    // 自己往下滚、露出了最底部的白点，并且任务正在进行 → 开始跟随（松手后的惯性滚动也算，2.5 秒内）
    function auto(s) { if (on || !s || inDir < 0 || Date.now() - inAt > 2500) return; if (atEnd(s) && running()) begin(); }
    const note = d => { inAt = Date.now(); inDir = d; };
    const editing = t => !!t?.closest?.('[contenteditable="true"],textarea,input,select');
    // 手指 / 滚轮下面有自带滚动、还能往上滚的小框（代码块、命令输出、思考过程等）：这次滑动滚的是小框，不是对话
    function boxUp(t) {
      const s = sc; if (!s) return false;
      for (let e = t instanceof Element ? t : t?.parentElement; e && e !== s; e = e.parentElement) {
        if (e.scrollHeight - e.clientHeight > 2 && e.scrollTop > 0.5) { const oy = getComputedStyle(e).overflowY; if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return true; }
      }
      return false;
    }
    function init() {
      addEventListener('click', onClick, true);
      // 滚轮上滑 → 取消（滚的是还能往上滚的小框时不算）
      addEventListener('wheel', e => {
        if (!e.deltaY || !inScroller(e.target)) return;
        if (e.deltaY < 0) { if (boxUp(e.target)) return; note(-1); if (on) stop(true); }
        else { note(1); auto(sc); }
      }, { capture: true, passive: true });
      // 触摸：按住时先不贴底（不和手指抢）；手指往下拉 → 取消（按下时在还能往上滚的小框里不算）；松手后 1.2 秒惯性也先不贴底
      addEventListener('touchstart', e => {
        if (e.touches.length > 1 || !inScroller(e.target)) { touchY = null; return; }
        touching = true; touchAt = Date.now(); touchMoved = false; touchY = e.touches[0]?.clientY ?? null; touchBox = boxUp(e.target);
      }, { capture: true, passive: true });
      addEventListener('touchmove', e => {
        if (touchY === null) return; touchAt = Date.now();
        const dy = (e.touches[0]?.clientY ?? touchY) - touchY; if (Math.abs(dy) > 12) touchMoved = true;
        if (dy > 12) { if (touchBox) return; note(-1); if (on) stop(true); } else if (dy < -12) { note(1); auto(sc); }
      }, { capture: true, passive: true });
      const touchEnd = () => {
        if (!touching) return; touching = false; touchY = null;
        if (touchMoved) { gestureUntil = Date.now() + 1200; if (inDir > 0) inAt = Date.now(); }
      };
      addEventListener('touchend', touchEnd, { capture: true, passive: true });
      addEventListener('touchcancel', touchEnd, { capture: true, passive: true });
      addEventListener('keydown', e => { if (editing(e.target)) return; if (/^(PageUp|ArrowUp|Home)$/.test(e.key) || (e.key === ' ' && e.shiftKey)) { note(-1); if (on) stop(true); } else if (/^(PageDown|ArrowDown|End)$/.test(e.key) || e.key === ' ') { note(1); setTimeout(() => auto(scroller()), 400); } }, true);
      // 按住鼠标时（拖滚动条 / 选文字）先不贴底；松开时如果往上走了就取消，否则继续跟随
      addEventListener('mousedown', e => { if (e.button !== 0 || !inScroller(e.target)) return; pressed = true; pressAt = Date.now(); note(0); downTop = sc.scrollTop; if (on) holding = true; }, true);
      addEventListener('mouseup', () => { if (!pressed) return; pressed = false; const s = sc; if (holding) { holding = false; if (on && s && s.scrollTop < downTop - 10 && !mine(s)) stop(true); } else if (s && s.scrollTop > downTop + 10) { note(0); auto(s); } }, true);
      // 滚轮惯性、拖滚动条、按键滚动：滚动过程中一露出白点就开始跟随
      addEventListener('scroll', e => {
        const s = sc; if (!s || e.target !== s) return;
        // v1.11.71 输入法 / 输入框高度变化时“贴住底部”的补偿滚动不算用户往下滚，不触发跟随
        if (Date.now() - (s._ampAnchorAt || 0) < 250) { lastTop = s.scrollTop; return; }
        if (on) { lastTop = s.scrollTop; return; }
        const down = lastTop >= 0 && s.scrollTop > lastTop + 0.5; lastTop = s.scrollTop;
        if (inDir > 0 || (inDir === 0 && down)) auto(s);
      }, { capture: true, passive: true });
    }
    return { init, begin, stop, arm, watch, get on() { return on; } };
  })();

  // ---------- 收尾提示：回复写完了，页面还显示“进行中”（白点一直转、只有停止按钮）----------
  // Arena 要等服务器发来“本轮结束”才退出进行中；回复写完后服务器还要收尾（保存这一轮；对话太长时压缩上下文），
  // 可能要一两分钟。这时刷新，这一轮可能暂时看不见（并没有丢，收尾完成后会出现）——所以提示不用刷新、不用重发。
  const wrap = (() => {
    const BUSY_TOOL = /^(input-streaming|input-available|approval-requested|approval-responded)$/;
    const TAIL = '不用刷新，也不用重发——这时刷新，这一轮可能暂时看不见（不是丢了，收尾完成后会出现）。';
    let sid = null, sendAt = 0, finishAt = 0, sig = '', sigAt = 0, mode = '', modeAt = 0, shown = false, dismissed = '';
    const ours = () => !!box && !box.hidden && box.dataset.kind === 'wrap';
    function reset(s) { if (ours()) hide(); sid = s; sendAt = 0; finishAt = 0; sig = ''; sigAt = 0; mode = ''; modeAt = 0; shown = false; dismissed = ''; }
    // 最后一条消息：写完的正文结尾、没有还在跑的工具 = 回复写完了；data-compaction（phase=start）= 正在压缩上下文
    function lastInfo() {
      const v = chatValue(), msgs = v?.messages; if (!Array.isArray(msgs) || !msgs.length) return null;
      const m = msgs[msgs.length - 1] || {}, parts = Array.isArray(m.parts) ? m.parts : [], p = parts[parts.length - 1] || {};
      let len = 0; for (const x of parts) if (x && typeof x.text === 'string') len += x.text.length;
      const tool = parts.some(x => x && typeof x.type === 'string' && (x.type.startsWith('tool-') || x.type === 'dynamic-tool') && BUSY_TOOL.test(String(x.state || '')));
      const compact = parts.some(x => x && ((x.type === 'data-compaction' && x.data?.phase === 'start' && !x.data?.summary) || (x.type === 'tool-compact' && x.state && x.state !== 'output-available' && x.state !== 'output-error')));
      const done = m.role === 'assistant' && p.type === 'text' && !!String(p.text || '').trim() && p.state !== 'streaming' && !tool;
      return { sig: msgs.length + ':' + parts.length + ':' + len + ':' + (p.type || '') + ':' + (p.state || ''), done, compact };
    }
    const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + String(s % 60).padStart(2, '0') + ' 秒'; };
    function text(now) {
      const t = mmss(now - modeAt);
      if (mode === 'compact') return 'Arena 正在压缩对话上下文（对话太长时自动整理，已 ' + t + '）。完成前白点会一直转、只能停止；' + TAIL;
      if (mode === 'wrap') return '回复已写完，Arena 还在收尾（已 ' + t + '）。收尾完成前白点会一直转、只能停止；' + TAIL;
      return '已经 ' + t + '没有新内容，Arena 仍显示进行中（可能在想下一步，也可能在收尾）。' + TAIL;
    }
    function check() {
      const s = sidNow(); if (s !== sid) reset(s); if (!s) return;
      const now = Date.now();
      if (!turnBusy()) {
        if (shown && ours()) toast('Arena 已收尾，可以继续发送了', 2600);
        shown = false; mode = ''; sig = ''; sigAt = 0; return;
      }
      const info = lastInfo(), dom = !!document.querySelector('main [role="status"][aria-label="Compacting conversation"]');
      const key = info ? info.sig : '-'; if (key !== sig) { sig = key; sigAt = now; }
      let m = '';
      if (dom || info?.compact) m = 'compact';
      else if (info?.done && finishAt && finishAt >= sendAt && now - finishAt > 6000 && now - sigAt > 6000) m = 'wrap'; // 流里已经出现 finish
      else if (info?.done && now - sigAt > 60000) m = 'idle';
      if (m !== mode) { mode = m; modeAt = m === 'wrap' ? finishAt : m === 'idle' ? sigAt : now; }
      if (!m || dismissed === m + ':' + sendAt) { if (ours()) hide(); shown = false; return; }
      if (m === 'compact' && now - modeAt < 4000) return;
      if (ours()) { const t = box.querySelector('.t'); if (t) t.textContent = text(now); return; } // 只改文字，不重建按钮（免得点不中）
      if (timer || errBar || (box && !box.hidden)) return; // 倒计时 / 别的提示在用
      show(text(now), [['知道了', () => { dismissed = mode + ':' + sendAt; shown = false; hide(); }]], false, 'wrap'); shown = true;
    }
    function sent(s) { if (s !== sid) reset(s); sendAt = Date.now(); finishAt = 0; dismissed = ''; }
    function finish(s) { const cur = sidNow(); if (!cur || (s && s !== cur && /^[0-9a-f-]{36}$/i.test(s))) return; if (cur !== sid) reset(cur); finishAt = Date.now(); }
    return { check, sent, finish };
  })();

  // ---------- 刷新后最新一轮“不见了”：本机记下每个对话最近一次发送（消息 id、时间、开头几个字、服务器响应）----------
  // 刷新后页面里找不到这条消息：说明服务器已收到、这一轮还没收尾，不用重发；看到这一轮结束后仍没显示就自动刷新一次。
  const SEND_KEY = 'amp.native.lastSend.v1', PEND_KEY = 'amp.native.pendReload';
  const sends = () => { try { const v = JSON.parse(localStorage.getItem(SEND_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
  const saveSends = all => { try { localStorage.setItem(SEND_KEY, JSON.stringify(all)); } catch {} };
  function noteSend(sid, info) {
    if (!sid || !/^[\w-]{8,128}$/.test(sid)) return;
    try { wrap.sent(sid); } catch {}
    if (!info || typeof info.mid !== 'string' || !/^[\w-]{4,128}$/.test(info.mid)) return;
    const all = sends(), now = Date.now();
    all[sid] = { mid: info.mid, at: +info.at || now, text: norm(info.text).slice(0, 40), st: +info.st || 0 };
    for (const k of Object.keys(all)) if (!all[k] || !(now - all[k].at < 86400e3)) delete all[k];
    Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(12).forEach(k => delete all[k]);
    saveSends(all);
  }
  function noteSendStatus(sid, status) { const all = sends(), e = all[sid]; if (!e || e.st || !(Date.now() - e.at < 120e3)) return; e.st = +status || 0; saveSends(all); }
  function pendingCheck() {
    const sid = sidNow(); if (!sid) return;
    const e = sends()[sid]; if (!e || !e.mid || !(Date.now() - e.at < 45 * 60e3)) return;
    const t0 = Date.now(); let seenAt = 0, wasBusy = false, idleAt = 0, closed = false, shownAt = 0;
    // v1.11.72 同一条消息只提示一次：显示过就记在本机（之后刷新、切回来、别的标签页都不再弹），8 秒后自己收起；
    // 页面在后台时不弹；页面恢复得慢时多等一会儿（消息列表出现后 8 秒）再判断“没显示”。
    const quiet = () => { const x = sends()[sid]; return !!x && x.mid === e.mid && !!x.q; };
    const markQuiet = () => { const all = sends(), x = all[sid]; if (x && x.mid === e.mid && !x.q) { x.q = 1; saveSends(all); } };
    const has = () => { try { return !!document.querySelector('[data-chat-message-id="' + CSS.escape(e.mid) + '"]'); } catch { return false; } };
    const ago = () => { const m = Math.floor((Date.now() - e.at) / 60e3); return m < 1 ? '刚才' : ' ' + m + ' 分钟前'; };
    const iv = setInterval(() => {
      const ours = !!box && !box.hidden && box.dataset.kind === 'pending';
      if (sidNow() !== sid || Date.now() - t0 > 20 * 60e3) { clearInterval(iv); if (ours) hide(); return; }
      const log = logEl(); if (!log) return;
      if (!seenAt) { if (log.querySelector('[data-chat-message-id]') || Date.now() - t0 > 12000) seenAt = Date.now(); return; }
      if (has()) { clearInterval(iv); if (ours) { hide(); toast('最新一轮已经显示出来了', 2200); } return; }
      if (Date.now() - seenAt < 4000) return; // 给页面一点时间恢复这一轮
      if (turnBusy()) { wasBusy = true; idleAt = 0; } else if (wasBusy && !idleAt) idleAt = Date.now();
      if (wasBusy && idleAt && Date.now() - idleAt > 5000) { // 看到这一轮结束了，页面还是没显示 → 刷新一次（每条消息最多一次）
        clearInterval(iv);
        if (read(PEND_KEY, '') !== e.mid && !timer && !busy) { write(PEND_KEY, e.mid); autoReload(sid, '上一轮已收尾，{n} 秒后刷新显示最新内容'); }
        else if (ours) hide();
        return;
      }
      if (closed || timer || errBar || (box && !box.hidden && !ours)) return;
      if (ours) { if (Date.now() - shownAt > 8000) { closed = true; hide(); return; } }
      else if (quiet() || document.hidden || Date.now() - seenAt < 8000) return;
      const bad = e.st >= 400, got = e.st >= 200 && e.st < 300;
      const msg = '你' + ago() + '发送的' + (e.text ? '“' + e.text + '”' : '消息') + (bad ? '，服务器返回了 ' + e.st + '，可能没发出去；过一会儿还不出现再重新发送。' : (got ? '服务器已收到，' : '，') + '这一轮还在进行或收尾，页面暂时没显示——不用重发，完成后会出现。');
      if (ours) { const t = box.querySelector('.t'); if (t) t.textContent = msg; }
      else { markQuiet(); shownAt = Date.now(); show(msg, [['刷新', () => reloadNow(sid, false)], ['知道了', () => { closed = true; hide(); }]], false, 'pending'); }
    }, 1000);
  }
  function afterLoad() {
    const sid = sidNow(), j = read(JUST_KEY, null);
    try { sessionStorage.removeItem(JUST_KEY); } catch {}
    if (!sid) return;
    let nav = ''; try { nav = performance.getEntriesByType('navigation')[0]?.type || ''; } catch {}
    const ours = !!j && j.sid === sid && Date.now() - j.at < 60e3;
    if (nav === 'reload' || ours) bottomOnce(ours && j.auto ? '已自动刷新，回到最新消息' : '');
    try { pendingCheck(); } catch {}
  }
  function start() {
    afterLoad(); try { follow.init(); } catch {}
    setInterval(() => { try { tick(); } catch {} }, 2000);
    setInterval(() => { try { follow.watch(); } catch {} try { wrap.check(); } catch {} }, 1000);
    addEventListener('resize', () => { if (box && !box.hidden) place(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  return { tick, findError, bottomOnce, follow, reloadNow, draft, gachaBusy, toast, sidNow, turnBusy, noteSend, noteSendStatus, findScroller, noteFinish: s => wrap.finish(s) };
})();

// ====================================================================================
// VIP pin (request model clzui / dxzui), current-chat progress fill, model-change alert.
// ====================================================================================
const vip = (() => {
  const KEY = 'amp.native.vip.v1', RE = /clzui|dxzui/i;
  let map = new Map(); try { map = new Map(Object.entries(JSON.parse(localStorage.getItem(KEY)) || {}).slice(-300)); } catch {}
  let rev = 0;
  const save = () => { ampStore.set(KEY, JSON.stringify(Object.fromEntries(map))); rev++; };
  // Called with the request models of the latest turn. Any latest turn whose request model is not VIP drops the pin.
  function note(sid, requests) {
    if (!sid || !requests?.length) return null;
    const hit = requests.find(r => RE.test(r));
    if (hit) { if (map.get(sid) !== hit) { map.delete(sid); map.set(sid, hit); while (map.size > 300) map.delete(map.keys().next().value); save(); return 'set'; } return null; }
    if (map.has(sid)) { const old = map.get(sid); map.delete(sid); save(); return { dropped: old }; }
    return null;
  }
  try { window.addEventListener('storage', e => { if (e.key === KEY) { try { map = new Map(Object.entries(JSON.parse(e.newValue) || {})); rev++; } catch {} } }); } catch {}
  return { note, get: sid => map.get(sid) || null, get rev() { return rev; }, RE };
})();
const progress = (() => {
  // The selected conversation's card fills from its left bar to the full row as the chat loads.
  let path = '', fill = 0, done = false, startAt = 0, seenAt = 0, old = new WeakSet();
  const MSG = 'main [data-user-message-body-row],main [data-user-message-action],main [role="log"] p,main article';
  const sidNow = () => (location.pathname.match(/^\/agent\/([0-9a-f-]{36})/i) || [])[1] || '';
  function tick() {
    const p = location.pathname;
    // Messages of the previous chat stay mounted for a moment during SPA navigation: only NEW message nodes count as loaded.
    if (p !== path) { path = p; fill = 6; done = false; startAt = Date.now(); seenAt = 0; old = new WeakSet(document.querySelectorAll(MSG)); }
    if (!done && sidNow()) {
      const loaded = document.readyState === 'complete' && [...document.querySelectorAll(MSG)].some(n => !old.has(n));
      if (loaded && !seenAt) seenAt = Date.now();
      const el = Date.now() - startAt;
      if (seenAt && Date.now() - seenAt > 350) fill = Math.min(100, fill + 18);
      else fill = Math.min(88, fill + (88 - fill) * (seenAt ? 0.25 : 0.07));
      if (el > 9000) fill = 100;
      if (fill >= 100) { fill = 100; done = true; }
    }
    paint();
  }
  let links = [];
  function paint() {
    const sid = sidNow();
    for (const a of links.length ? links : document.querySelectorAll('a[data-amp-current]')) {
      const cur = !!sid && a.isConnected && a.getAttribute('href') === '/agent/' + sid;
      if (cur) { if (!a.hasAttribute('data-amp-current')) a.setAttribute('data-amp-current', ''); const f = fill + '%'; if (a.style.getPropertyValue('--amp-fill') !== f) a.style.setProperty('--amp-fill', f); a.toggleAttribute('data-amp-done', done); a.toggleAttribute('data-amp-ink', fill >= 55); }
      else if (a.hasAttribute('data-amp-current')) { a.removeAttribute('data-amp-current'); a.removeAttribute('data-amp-done'); a.removeAttribute('data-amp-ink'); a.style.removeProperty('--amp-fill'); }
    }
  }
  function mark(list) { links = list; paint(); }
  setInterval(() => { try { tick(); } catch {} }, 120);
  return { mark, get fill() { return fill; } };
})();
// Vendor/brand detection for sidebar logos: title first, then the local cache (internal name / request models / VIP model).
const brand = (() => {
  const LIST = [
    ['openai', /gpt|chatgpt|openai|codex|dall-?e|\bo[134](?:-mini|-pro)?\b/i],
    ['anthropic', /claude|anthropic|\bopus\b|\bsonnet\b|\bhaiku\b/i],
    ['google', /gemini|gemma|\bbard\b|google/i],
    ['xai', /grok|\bxai\b/i],
    ['moonshot', /kimi|moonshot/i],
    ['deepseek', /deepseek/i],
    ['qwen', /qwen|qwq|tongyi/i],
    ['zhipu', /\bglm|chatglm|zhipu/i],
    ['xiaomi', /\bmimo/i],
    ['bytedance', /doubao|\bseed-?\d/i],
    ['minimax', /minimax|\babab/i],
    ['mistral', /mistral|mixtral|codestral|magistral|devstral/i],
    ['meta', /llama|\bmeta\b/i]
  ];
  const of = t => { t = String(t || ''); if (!t) return ''; for (const [id, re] of LIST) if (re.test(t)) return id; return ''; };
  // Filled by the Lite catalog once it is ready: sid → cached names; rev changes when the cache changes.
  const hint = { get: () => '', rev: () => 0 };
  const NAME = { openai: 'GPT', anthropic: 'Claude', google: 'Gemini', xai: 'Grok', moonshot: 'Kimi', deepseek: 'DeepSeek', qwen: 'Qwen', zhipu: 'GLM', xiaomi: 'MiMo', bytedance: 'Doubao', minimax: 'MiniMax', mistral: 'Mistral', meta: 'Llama' };
  // 版本号：取名字里第一个数字 + 紧随的次版本（claude-opus-5.5 → 5.05、claude-fable-5-1 → 5.01、gpt-6 → 6）；日期等长数字忽略。
  const version = t => { const k = String(t || '').toLowerCase().replace(/^#\d+\s*/, '').replace(/\s*·\s*\d+\s*$/, '').replace(/(\d)([a-z])/g, '$1-$2').replace(/([a-z])(\d)/g, '$1-$2').split(/[^a-z0-9]+/).filter(Boolean); const i = k.findIndex(x => /^\d{1,2}$/.test(x)); if (i < 0) return null; const minor = /^\d{1,2}$/.test(k[i + 1] || '') ? +k[i + 1] : 0; return +k[i] + minor / 100; };
  // 有 logo 的地方不写厂商前缀：claude-opus-5.5-medium-vertex → opus-5.5-medium（去 -vertex，K3 大写）
  const VPRE = /^(?:[\w.-]+\/)?(?:gpt|chatgpt|claude|gemini|grok|kimi|qwen|deepseek|mimo|glm|llama|mistral|doubao|minimax)[-_ ]+(?=[\w])/i;
  const short = n => { n = noVertex(String(n || '')).trim(); if (!of(n)) return n; let r = n.replace(VPRE, ''); if (r === n) r = (n.match(/^[\w.-]+\/(.+)$/) || [])[1] || n; if (/^k\d/.test(r)) r = 'K' + r.slice(1); return r; };
  // 同一模型判定：去 -vertex / 厂商前缀 / 分隔符差异（5-5 与 5.5）后比较；只多了档位或更细的后缀视为同一模型（细化，不算变更）
  const TIERX = /-(none|minimal|low|medium|high|xhigh|max|thinking)$/;
  const canon = n => short(n).toLowerCase().replace(/-(agent)$/, '').replace(/[._\s/]+/g, '-').replace(/-+/g, '-');
  const same = (a, b) => { const x = canon(a), y = canon(b); if (!x || !y) return false; if (x === y) return true; const bx = x.replace(TIERX, ''), by = y.replace(TIERX, ''); const tx = (x.match(TIERX) || [])[1], ty = (y.match(TIERX) || [])[1]; if (bx === by) return !tx || !ty || tx === ty; return (by.startsWith(bx + '-') && !tx) || (bx.startsWith(by + '-') && !ty); };
  const tierOf = n => (canon(n).match(TIERX) || [])[1] || '';
  return { of, hint, NAME, version, short, same, canon, tierOf, forSid: (sid, title) => of(title) || of(hint.get(sid)) };
})();
// ====================================================================================
// 抽卡老虎机（v1.11.34）：抽卡进行时在屏幕中央显示三段式滚轮——厂商 → 型号 → 档位，
// v1.11.77 三个轮子同时起转、同速同相位（始终对齐成一排）；下面是总进度条。
// v1.11.79 完整身份（厂商 + 型号 + 档位）确定之后像真正的老虎机一样 厂商 → 型号 → 档位 一格一格依次停下；
// 顶部标题、进度条下的状态行、模型信息、左侧卡片都跟着轮子亮出（还没停下的格子哪里都不透露）。
const gachaSlot = (() => {
  const MOB = (window.innerWidth || 800) < 560, H = MOB ? 36 : 44, N = 12, SPIN = 15;
  const VW = new Set(['claude', 'gpt', 'chatgpt', 'gemini', 'grok', 'kimi', 'deepseek', 'qwen', 'glm', 'mimo', 'doubao', 'minimax', 'mistral', 'llama', 'anthropic', 'openai', 'google', 'xai', 'models', 'agent']);
  const FILL = [
    ['Claude', 'GPT', 'Gemini', 'Grok', 'Kimi', 'DeepSeek', 'Qwen', 'GLM'],
    ['opus', 'sonnet', 'haiku', 'luna', 'fable', 'pro', 'flash', 'astra', 'K3', 'nova', 'mini', 'ultra'],
    ['max', 'xhigh', 'high', 'medium', 'low', '标准']
  ];
  const TIER_RE = /^(none|minimal|low|medium|high|xhigh|max)$/;
  function parts(name, tier) {
    const n = noVertex(String(name || '')).replace(/-(agent)$/i, '').trim();
    const bid = brand.of(n), raw = n.toLowerCase().split(/[-_\s/·:]+/).filter(Boolean);
    let toks = raw.filter(t => !VW.has(t)), t = tier && TIER_RE.test(tier) ? tier : '';
    if (toks.length > 1 && TIER_RE.test(toks.at(-1))) { t = t || toks.at(-1); toks.pop(); }
    const out = [];
    for (const x of toks) { const last = out.at(-1); if (/^\d{1,2}$/.test(x) && last && /^\d{1,2}$/.test(last)) out[out.length - 1] = last + '.' + x; else out.push(x); }
    return { vendor: brand.NAME[bid] || (raw[0] || '—'), family: out.join('-') || '—', tier: !t || t === 'none' ? '标准' : t };
  }
  const dark = () => { const d = document.documentElement; return d.dataset.theme === 'dark' || d.classList.contains('dark') || (!d.classList.contains('light') && getComputedStyle(d).colorScheme === 'dark'); };
  const CSS = ':host{all:initial}'
    + '.wrap{position:fixed;left:50%;top:46%;z-index:2147482000;transform:translate(-50%,-50%) scale(.94);opacity:0;pointer-events:none;transition:opacity .22s ease,transform .36s cubic-bezier(.22,1,.36,1);font:500 14px/1.3 var(--font-basel-grotesk,var(--font-inter,system-ui)),-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;'
    + '--bg:rgba(250,248,244,.78);--fg:#262522;--mut:#7a746b;--line:#0000000f;--acc:#6a5e54;--accfg:#fff;--card:#fffdf9;--win:#e6ddd0;--track:#e6ddd0;color:var(--fg)}'
    + '.wrap.dark{--bg:rgba(30,29,27,.74);--fg:#ecebe7;--mut:#a9a59d;--line:#ffffff14;--acc:#d8d3ca;--accfg:#262522;--card:#34322e;--win:#4b4740;--track:#3a3733}'
    + '.wrap.on{opacity:1;transform:translate(-50%,-50%) scale(1)}'
    + '.box{pointer-events:none;width:min(480px,calc(100vw - 24px));box-sizing:border-box;padding:14px 14px 12px;border-radius:22px;background:transparent;border:0;box-shadow:none;transition:box-shadow .3s,border-color .3s}'
    + '.wrap.dark .box{box-shadow:none}.head,.cap,.foot{text-shadow:0 0 6px var(--halo),0 0 2px var(--halo)}.wrap{--halo:rgba(250,248,244,.95)}.wrap.dark{--halo:rgba(20,19,18,.95)}'
    + '.head{display:flex;align-items:center;gap:8px;margin:9px 2px 0;white-space:nowrap;font-size:12px;color:var(--mut)}.head b{color:var(--fg);font-weight:600;font-size:13px;font-variant-numeric:tabular-nums}.head .sp{flex:1}'
    + '.btn{pointer-events:auto;white-space:nowrap;appearance:none;border:0;background:transparent;color:var(--mut);font:inherit;font-size:11px;padding:3px 8px;border-radius:7px;cursor:pointer}.btn:hover{background:var(--card);color:var(--fg)}'
    + '.reels{display:grid;grid-template-columns:1fr 1.4fr .95fr;gap:14px;padding:0 6px}'
    + '.reel{position:relative;height:' + (H * 4) + 'px;margin:4px 0;perspective:520px}'
    + '.win{position:absolute;left:-6px;right:-6px;top:50%;height:' + (H + 6) + 'px;margin-top:-' + ((H + 6) / 2) + 'px;border-radius:14px;background:var(--win);box-shadow:0 10px 30px rgba(0,0,0,.2),0 0 0 3px color-mix(in srgb,var(--acc) 18%,transparent),inset 0 0 0 2px var(--acc);transition:box-shadow .25s,background .25s}'
    + '.reel.stop .win{box-shadow:0 10px 30px rgba(0,0,0,.24),0 0 0 5px color-mix(in srgb,var(--acc) 26%,transparent),inset 0 0 0 2px var(--acc)}'
    + '.drum{position:absolute;inset:0;transform-style:preserve-3d}'
    + '.it{position:absolute;left:0;right:0;top:50%;height:' + (H - 6) + 'px;margin-top:-' + ((H - 6) / 2) + 'px;display:flex;align-items:center;justify-content:center;gap:8px;padding:0 12px;box-sizing:border-box;border-radius:12px;background:var(--card);color:var(--fg);box-shadow:0 4px 14px rgba(0,0,0,.14),inset 0 0 0 1px var(--line);backface-visibility:hidden;will-change:transform,opacity;white-space:nowrap}'
    + '.it .ic{display:none;width:18px;height:18px;align-items:center;justify-content:center;flex:none}.it .ic:not(:empty){display:inline-flex}.it .ic svg{width:16px;height:16px}'
    + '.it .nm{min-width:0;overflow:hidden;text-overflow:ellipsis}'
    + '.it.sel{background:transparent;box-shadow:none;font-weight:700;color:var(--acc)}.it.sel .ic{color:var(--fg)}'
    + '.reel.thunk .win{animation:thunk .36s cubic-bezier(.3,1.6,.5,1)}@keyframes thunk{0%{transform:scale(1)}35%{transform:scale(1.045)}100%{transform:scale(1)}}'
    + '.cap{display:grid;grid-template-columns:1fr 1.4fr .95fr;gap:14px;padding:0 6px;margin:2px 0 0;font-size:10px;color:var(--mut);text-align:center;letter-spacing:.04em}'
    + '.bar{position:relative;height:6px;margin:12px 2px 0;border-radius:6px;background:var(--track);box-shadow:0 1px 4px rgba(0,0,0,.12);overflow:hidden}'
    + '.fill{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:6px;background:var(--acc);transition:width .45s cubic-bezier(.22,1,.36,1)}'
    + '.fill::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);background-size:60px 100%;background-repeat:no-repeat;animation:shine 1.3s linear infinite}'
    + '.wrap.dark .fill::after{background:linear-gradient(90deg,transparent,rgba(0,0,0,.25),transparent);background-size:60px 100%;background-repeat:no-repeat}'
    + '.wrap.idle .fill::after{animation:none;opacity:0}@keyframes shine{from{background-position:-60px 0}to{background-position:calc(100% + 60px) 0}}'
    + '.foot{display:flex;align-items:center;gap:8px;margin:3px 2px 0;font-size:11px;color:var(--mut);min-height:18px}.foot .ph{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.badge{flex:none;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;background:var(--card);color:var(--fg);opacity:0;transform:scale(.8);transition:opacity .2s,transform .3s cubic-bezier(.3,1.6,.5,1)}.badge.show{opacity:1;transform:scale(1)}'
    + '.badge.hit{background:var(--acc);color:var(--accfg)}'
    + '.wrap.hit .win{box-shadow:0 10px 30px rgba(0,0,0,.24),0 0 0 6px color-mix(in srgb,var(--acc) 34%,transparent),inset 0 0 0 2px var(--acc)}'
    + '.badge.gold{color:#3a2600;background:linear-gradient(100deg,#b8860b,#ffd76a 35%,#fff3c4 50%,#ffd76a 65%,#b8860b);background-size:220% 100%;animation:goldsweep 1.6s linear infinite;box-shadow:0 0 14px rgba(255,196,60,.65)}.badge.dim{background:#8884;color:var(--mut)}'
    + '.wrap.legend .win{background:linear-gradient(100deg,#b8860b,#ffd76a 35%,#fff3c4 50%,#ffd76a 65%,#b8860b);background-size:220% 100%;animation:goldsweep 1.6s linear infinite;box-shadow:0 0 0 2px #e0b23a,0 0 26px 6px rgba(255,190,50,.55),0 0 60px 14px rgba(255,190,50,.25)}'
    + '.wrap.legend .it.sel{color:#3a2600;text-shadow:0 1px 0 rgba(255,255,255,.5)}.wrap.legend .it.sel .ic{color:#3a2600}'
    + '.wrap.legend .reels{animation:legend 1.1s cubic-bezier(.3,1.5,.5,1)}@keyframes legend{0%{transform:scale(1)}30%{transform:scale(1.06)}100%{transform:scale(1)}}@keyframes goldsweep{from{background-position:120% 0}to{background-position:-100% 0}}'
    + '.wrap.legend .box::before{content:"";position:absolute;inset:-40px;pointer-events:none;background:radial-gradient(closest-side,rgba(255,200,70,.35),transparent 70%);animation:glow 1.8s ease-in-out infinite}.box{position:relative}@keyframes glow{50%{opacity:.45}}'
    + '.wrap.dim .reels,.wrap.dim .cap{filter:grayscale(1) brightness(.8);opacity:.45;transition:filter .5s,opacity .5s}.wrap.dim .win{box-shadow:inset 0 0 0 2px #8886}'
    + '@media (max-width:560px){.box{width:min(350px,calc(100vw - 36px));padding:6px 4px}.reels,.cap{gap:9px;padding:0 3px;grid-template-columns:1.2fr 1.25fr .95fr}.it{font-size:12px;padding:0 6px;gap:5px;border-radius:10px}.it .ic{width:14px;height:14px}.it .ic svg{width:13px;height:13px}.win{left:-3px;right:-3px;border-radius:12px}.head{font-size:11px;gap:6px}.head b{font-size:12px}.bar{height:5px;margin-top:9px}.btn{padding:3px 6px}}'
    + '@media (prefers-reduced-motion:reduce){.fill::after{animation:none}.reel.thunk{animation:none}.wrap.legend *,.wrap.legend .box::before{animation:none!important}}';

  let host = null, root = null, wrap = null, reels = [], fillEl, phEl, badgeEl, noEl, hitEl, raf = 0, hideT = 0, disp = null, lastPeek = 0, p = null, hiddenRun = '', endShown = '';
  function build() {
    host = document.createElement('div'); host.id = 'amp-gacha-slot';
    root = host.attachShadow({ mode: 'open' });
    // 老虎机上方不放任何信息（免得和对话里的提示词重叠）；状态、抽数、停止/收起都放在进度条下方
    root.innerHTML = '<style>' + CSS + '</style><div class="wrap"><div class="box">'
      + '<div class="reels"></div><div class="cap"><span>厂商</span><span>型号</span><span>档位</span></div><div class="bar"><div class="fill"></div></div>'
      + '<div class="head"><span>抽卡中</span><b class="no"></b><span class="hits"></span><span class="sp"></span><button class="btn stop" type="button">停止</button><button class="btn min" type="button" title="本次抽卡不再显示">收起</button></div>'
      + '<div class="foot"><span class="ph"></span><span class="badge"></span></div></div></div>';
    wrap = root.querySelector('.wrap'); fillEl = root.querySelector('.fill'); phEl = root.querySelector('.ph'); badgeEl = root.querySelector('.badge'); noEl = root.querySelector('.no'); hitEl = root.querySelector('.hits');
    root.querySelector('.stop').onclick = () => { try { gacha.stop(); } catch {} hide(); };
    root.querySelector('.min').onclick = () => { hiddenRun = p?.id || ''; hide(); };
    const box = root.querySelector('.reels');
    reels = FILL.map((list, k) => {
      const el = document.createElement('div'); el.className = 'reel'; box.appendChild(el);
      el.innerHTML = '<div class="win"></div><div class="drum"></div>'; const drum = el.lastChild;
      const items = Array.from({ length: N }, () => { const d = document.createElement('div'); d.className = 'it'; d.innerHTML = '<span class="ic"></span><span class="nm"></span>'; drum.appendChild(d); return d; });
      return { k, el, items, list, pos: NaN, sel: -1 };
    });
    (document.body || document.documentElement).appendChild(host);
  }
  const wrapI = i => ((i % N) + N) % N;
  function setItem(r, d, label) {
    d.lastChild.textContent = label; d.title = label;
    if (r.k === 0) { const id = brand.of(label); let ic = ''; try { ic = id ? gachaUi.vendorIcon(id, 16) : ''; } catch {} if (d.firstChild.innerHTML !== ic) d.firstChild.innerHTML = ic; }
  }
  function paintReel(r) {
    for (let i = 0; i < N; i++) {
      const off = ((((i - r.pos) % N) + N + N / 2) % N) - N / 2, a = Math.abs(off), d = r.items[i];
      // 与“切换厂商”弹巢一致：卡片绕水平轴排成圆柱，离中心越远越倾斜、越小、越淡
      d.style.transform = 'translateY(' + (off * H * .92) + 'px) rotateX(' + (-off * 24) + 'deg) translateZ(' + (-a * a * 6) + 'px) scale(' + Math.max(.72, 1 - a * .07) + ')';
      d.style.opacity = String(Math.max(0, 1 - a * .3)); d.style.zIndex = String(100 - Math.round(a * 10));
    }
    const k = wrapI(Math.round(r.pos)); if (k !== r.sel) { r.sel = k; r.items.forEach((d, i) => d.classList.toggle('sel', i === k)); }
  }
  function resetReels() {
    for (const r of reels) {
      r.el.classList.remove('stop', 'thunk');
      // v1.11.77 只换看不见的格子：刚停住的结果不会在原地突然变字，而是跟着转走
      r.items.forEach((d, i) => { const off = ((((i - r.pos) % N) + N + N / 2) % N) - N / 2; if (Math.abs(off) >= 3.5 || !d.lastChild.textContent) setItem(r, d, r.list[(i + r.k * 3) % r.list.length]); });
    }
  }
  function show() {
    clearTimeout(hideT); hideT = 0;
    if (!host || !host.isConnected) build();
    wrap.classList.toggle('dark', dark());
    if (!wrap.classList.contains('on')) requestAnimationFrame(() => wrap.classList.add('on'));
    if (!raf) { let last = performance.now(); const step = t => { raf = 0; const dt = Math.min(.05, (t - last) / 1000); last = t; frame(t, dt); if (host && wrap.classList.contains('on')) raf = requestAnimationFrame(step); }; raf = requestAnimationFrame(step); }
  }
  function hide(delay = 0) {
    if (!wrap || hideT) return;
    hideT = setTimeout(() => { hideT = 0; wrap.classList.remove('on'); cancelAnimationFrame(raf); raf = 0; disp = null; }, delay);
  }
  // v1.11.79 像真正的老虎机：三个轮子一起起转（同速同相位），这一抽的完整身份定下之后 厂商 → 型号 → 档位 一个接一个停下
  // （间隔 GAP 毫秒）；每停一格就通知顶部标题 / 状态行 / 模型信息同一刻亮出这一格。下一抽已经开始时加快依次停。
  const GAP = 400, LAND = 360, FGAP = 110, FLAND = 200;
  let revealed = { sid: '', key: '', stage: 0, labels: null, sched: null }; const holdAt = new Map(), gaveUp = new Set();
  function publish(D) {
    revealed = { sid: D.sid || '', key: D.lkey || '', stage: D.stage, labels: D.labels ? D.labels.slice() : null, sched: D.sched };
    try { window.dispatchEvent(new Event('amp-title-sync')); } catch {}
  }
  function newDisp(no) {
    const pos = Number.isFinite(reels[0]?.pos) ? reels[0].pos : Math.random() * N;
    disp = { no, sid: '', att: 0, t0: performance.now(), targets: null, labels: null, ok: false, verdict: '', endAt: 0, mode: 'spin', v: 0, coast: false, stopAt: 0, okAt: 0, fast: false, stage: 0, sched: null, tkey: '', lkey: '', hits0: p ? p.hits || 0 : 0 };
    for (const r of reels) { if (!Number.isFinite(r.pos)) r.pos = pos; r.m = 'spin'; r.cst = false; r.at = Infinity; }
    revealed = { sid: '', key: '', stage: 0, labels: null, sched: null };
    resetReels(); badgeEl.className = 'badge'; wrap.classList.remove('hit', 'legend', 'dim');
  }
  // 结果变了：从第一个不同的格子起重新转（前面已经停对的格子不动，顶部也不回退）
  function respin(D, from) {
    from = Math.max(0, from);
    D.stage = Math.min(D.stage, from); D.mode = 'spin'; D.v = Math.max(D.v, SPIN * .6); D.coast = false; D.sched = null;
    D.labels = from > 0 && D.targets ? D.targets.slice() : null; if (!D.labels) D.lkey = '';
    reels.forEach((r, k) => { if (k >= from) { r.m = 'spin'; r.cst = false; r.at = Infinity; r.el.classList.remove('stop', 'thunk'); } });
    publish(D);
  }
  // 揭晓文字：停下几格写几格（顶部名字 / 模型信息 / 状态行共用）
  function stageName(v) {
    const L = v?.labels, n = v?.stage || 0; if (!L || n < 1 || !L[0] || L[0] === '—') return '识别中…';
    if (n === 1 || !L[1] || L[1] === '—') return L[0];
    return L[1].toLowerCase().includes(L[0].toLowerCase()) ? L[1] : L[0] + ' ' + L[1];
  }
  function stageText(L, n) {
    if (!L || !(n >= 1) || !L[0] || L[0] === '—') return '';
    if (n === 1) return '已识别厂商 ' + L[0];
    return '已识别 ' + stageName({ stage: n, labels: L }) + (n >= 3 && L[2] && L[2] !== '—' ? ' · ' + L[2] : '');
  }
  function frame(t, dt) {
    if (t - lastPeek > 60) { lastPeek = t; try { p = gacha.peek(); } catch { p = null; } }
    if (!p) { hide(); return; }
    if (!disp) newDisp(p.draw);
    const running = p.status === 'running' || p.status === 'stopping', D = disp;
    // 结果以顶部标题的完整身份为准（同一来源）；整抽已完成而标题还没给出结果时稍等 0.45 秒，再用本抽的识别结果。补抽不换号。
    if (p.draw === D.no) {
      if (p.sid && D.sid !== p.sid) D.sid = p.sid;
      // 同一抽里换了一轮（上一轮未完成、补抽）：上一轮的结果作废，三个轮子重新一起转
      if (p.no && D.att && p.no !== D.att && !D.endAt) { D.targets = null; D.tkey = ''; D.okAt = 0; if (D.mode !== 'spin' || D.labels) respin(D, 0); }
      D.att = p.no || D.att;
      const skipped = p.done && p.verdict === 'skipped', sh = !skipped && p.shown && p.shown.full && (!p.sid || p.shown.sid === p.sid) ? p.shown : null;
      let want = null, wkey = '';
      if (sh) { const pr = parts(sh.name || sh.fam || '', sh.tier); want = [brand.NAME[sh.vid] || pr.vendor, sh.fam || pr.family, sh.tier || '标准']; wkey = (sh.fam || '') + '|' + (sh.tier || ''); }
      else if (p.ok) { D.okAt ||= t; if (t - D.okAt > 450) { const pr = parts(p.model, p.tier); want = [pr.vendor, pr.family, pr.tier]; } }
      if (want && (!D.targets || want.join('\n') !== D.targets.join('\n'))) { D.targets = want; D.tkey = wkey; }
      else if (want && wkey && D.tkey !== wkey) {
        // 同样的结果、这次来自顶部标题：正在依次停 / 已经停在这个结果上，就把揭晓进度直接交给标题
        D.tkey = wkey; if (D.labels && D.labels.join('\n') === want.join('\n')) { D.lkey = wkey; publish(D); }
      }
      if (p.done && !p.ok && !skipped) { D.verdict = p.verdict; if (p.verdict === 'cancelled') D.coast = true; else if (!D.targets) D.targets = ['—', '—', '—']; }
      if (p.ok) { D.ok = true; D.verdict = p.verdict; }
    } else if (!D.endAt) {
      // 已经开始下一抽：这一抽还没停完就加快依次停下（结果已知停在结果上，未知三格都显示 —）
      if (!D.targets) D.targets = ['—', '—', '—'];
      if (!D.fast) { D.fast = true; let i = 0; for (const r of reels) if (r.m === 'spin' && Number.isFinite(r.at)) r.at = Math.min(r.at, t + (i++) * FGAP); if (D.sched) { D.sched.gap = FGAP; D.sched.dur = FLAND; D.sched.t0 = t - D.stage * FGAP; } }
    }
    // 已经在停（或已停下）而结果又变了：从第一个不同的格子起重新转、依次重新停
    if (D.labels && !D.endAt && D.targets && D.targets.join('\n') !== D.labels.join('\n')) { const from = D.targets.findIndex((x, i) => x !== D.labels[i]); if (from > 0) D.lkey = D.tkey || D.lkey; respin(D, from); }
    if (D.mode === 'spin' && (D.coast || (!running && !D.targets))) { D.mode = 'land'; D.coast = true; }
    if (D.mode === 'spin') {
      // 三个轮子同一时刻起转、一起加速到全速
      if (D.fast) D.v = SPIN; else D.v = Math.min(SPIN, D.v + SPIN / .7 * dt);
      if (D.targets && (D.fast || D.v >= SPIN * .15)) {
        // 排好依次停下的时刻表：厂商马上开始减速，型号晚 GAP 毫秒，档位再晚 GAP 毫秒（已经停对的格子不重排）
        const gap = D.fast ? FGAP : GAP, first = Math.max(0, reels.findIndex(r => r.m !== 'stop'));
        D.labels = D.targets.slice(); D.lkey = D.tkey || ''; D.mode = 'land'; D.stage = first;
        D.sched = { t0: t - first * gap, gap, dur: D.fast ? FLAND : LAND };
        reels.forEach((r, k) => { if (r.m !== 'stop') r.at = t + (k - first) * gap; });
        publish(D);
      }
    }
    let stopped = 0;
    reels.forEach((r, k) => {
      if (r.m === 'spin') {
        r.pos += D.v * dt;
        if (D.mode === 'land') {
          if (D.coast) { r.m = 'land'; r.cst = true; r.from = r.pos; r.to = Math.ceil(r.pos) + 2; r.t0 = t; r.dur = 600; r.v0 = D.v; }
          else if (t >= r.at) {
            // 目标项放在滚轮背面（4 格外完全透明，换字看不见），从当前转速平滑减速停在它上面
            const to = Math.ceil(r.pos) + 4; setItem(r, r.items[wrapI(to)], D.labels[k]);
            r.m = 'land'; r.cst = false; r.from = r.pos; r.to = to; r.t0 = t; r.dur = D.sched ? D.sched.dur : LAND; r.v0 = D.v;
          }
        }
      }
      if (r.m === 'land') {
        // 三次 Hermite：起点速度 = 当前转速（不突然加速），终点速度 0
        const q = Math.min(1, (t - r.t0) / r.dur), d = r.to - r.from, sp = Math.max(0, Math.min(3, r.v0 * r.dur / 1000 / d));
        r.pos = r.from + d * q * (sp + q * (3 - 2 * sp + q * (sp - 2)));
        if (q >= 1) {
          r.m = 'stop'; r.pos = r.to;
          if (!r.cst) { r.el.classList.add('stop'); r.el.classList.remove('thunk'); void r.el.offsetWidth; r.el.classList.add('thunk'); try { navigator.vibrate?.(k === 2 ? 12 : 7); } catch {} }
        }
      }
      if (r.m === 'stop') stopped++;
      r.pos = Number.isFinite(r.pos) ? r.pos : 0; paintReel(r);
    });
    if (D.mode === 'land') {
      // 揭晓进度 = 从左数已经停下的格子数（厂商 → 型号 → 档位）；每停一格通知顶部标题同一刻亮出这一格
      const first = reels.findIndex(r => r.m !== 'stop' || r.cst), stage = first < 0 ? 3 : first;
      if (!D.coast && stage !== D.stage) { D.stage = stage; publish(D); }
      if (stopped === reels.length) { D.mode = 'stop'; D.stopAt = t; if (D.coast) D.coast = false; }
    }
    const L = D.labels || ['', '', ''];
    if (D.mode === 'stop' && !D.endAt && (D.verdict || !running || D.fast)) {
      D.endAt = t;
      const v = D.verdict, txt = { hit: '命中！', keep: '保留', archive: '归档', skipped: '未完成 · 补抽', cancelled: '已停止', error: '出错' }[v] || '';
      // 命中目标厂商且档位为 max / xhigh / high → 金色传说；抽到归档词里的模型 → 整体变暗变灰
      // v1.11.76 GPT 的金色传说只给 Astra：Sol / Terra / Luna 就算是 max 也只算“命中”（与左侧卡片的金色同一规则）
      const gptWeak = L[0] === 'GPT' && /(^|-)(sol|terra|luna)(-|$)/i.test(L[1] || '') && !/(^|-)astra(-|$)/i.test(L[1] || '');
      const legend = v === 'hit' && /^(max|xhigh|high)$/.test(L[2] || '') && !gptWeak, dim = v === 'archive';
      const label = legend ? '金色传说 · ' + L[2] : txt;
      if (label) { badgeEl.textContent = label; badgeEl.className = 'badge show' + (legend ? ' gold' : v === 'hit' ? ' hit' : dim ? ' dim' : ''); }
      wrap.classList.toggle('hit', v === 'hit' && !legend); wrap.classList.toggle('legend', legend); wrap.classList.toggle('dim', dim);
      if (legend) { try { navigator.vibrate?.([12, 60, 12, 60, 30]); } catch {} }
      // 金色传说 / 命中 / 归档 多停留一会儿再切到下一抽（即使下一抽已经开始）
      D.hold = ['hit', 'keep', 'archive'].includes(v) ? (legend ? 2000 : 1400) : D.fast ? 250 : 500;
    }
    // 展示完这一抽（停稳后停留一下）再切到下一抽；下一抽的顶部标题一给出完整结果就立刻切过去（与标题保持一致）
    if (p.draw !== D.no && D.endAt && (t - D.endAt > (D.hold || 650) || !!(p.shown && p.shown.full && p.shown.sid === p.sid))) newDisp(p.draw);
    // 头部与进度
    noEl.textContent = '第 ' + (disp.no || Math.max(1, Math.min(p.max || 1, p.completed + 1))) + ' / ' + p.max + ' 抽';
    // v1.11.79 命中数也等三格都停下再加（不提前剧透）
    const hits = p.draw === disp.no && !disp.endAt ? Math.min(p.hits, disp.hits0) : p.hits;
    hitEl.textContent = hits ? '· 命中 ' + hits : '';
    const frac = p.done ? 0 : !p.sid && !p.sent ? (/新对话/.test(p.phase) ? .1 : .04) : !p.sid ? .25 : disp.mode === 'stop' && disp.labels ? .92 : disp.sched && !disp.coast ? .62 + .1 * disp.stage : .5;
    const pct = p.max ? Math.min(100, (p.completed + (running ? frac : 0)) / p.max * 100) : 0;
    const w = pct.toFixed(1) + '%'; if (fillEl.style.width !== w) fillEl.style.width = w;
    wrap.classList.toggle('idle', !running);
    let ph = running ? (p.phase || '准备中') : (p.reason || ({ done: '已完成', hit: '已完成', paused: '已停止', stopped: '已停止' }[p.status] || ''));
    // v1.11.79 进度条下的状态行与轮子同步：停下几格只写几格（已识别厂商 Qwen → 已识别 qwen3.8-max-0902 → … · 标准），还没停下时不写名字
    if (running) { const st = stageText(disp.labels, disp.coast ? 0 : disp.stage); if (st) ph = st; else if (/^已识别/.test(ph)) ph = '识别中…'; }
    if (phEl.textContent !== ph) phEl.textContent = ph;
    root.querySelector('.head span').textContent = running ? '抽卡中' : ['paused', 'stopped'].includes(p.status) ? '已停止' : '抽卡结束';
    root.querySelector('.stop').style.display = running ? '' : 'none';
  }
  // v1.11.79 顶部标题问：这个对话此刻能亮出几格？null = 全部（不在抽卡里 / 老虎机已收起 / 切到后台 / 三格都已停下）；
  // { stage: 0 } 还在转，什么都不亮；1 只亮厂商；2 厂商 + 型号。老虎机 0.9 秒内还没开始落位就不等。
  function reveal(sid, key) {
    if (!sid || !wrap?.classList.contains('on') || !p || p.sid !== sid || !disp || !['running', 'stopping'].includes(p.status) || document.hidden) return null;
    const now = performance.now(), R = revealed, k = sid + '|' + key;
    // 已经等不及、完整亮出过的结果：之后老虎机才开始落位也不再收回（不来回跳）
    if (gaveUp.has(k)) return null;
    if (disp.no === p.draw && R.sid === sid && R.labels) {
      // 动画帧被节流（卡顿）时按落位时刻表推算，顶部不会一直卡住
      let st = R.stage; const sc = R.sched; if (sc) st = Math.max(st, [0, 1, 2].filter(k => now >= sc.t0 + k * sc.gap + sc.dur + 400).length);
      return st >= 3 ? null : { stage: st, labels: R.labels };
    }
    if (!holdAt.has(k)) { holdAt.set(k, now); if (holdAt.size > 24) holdAt.delete(holdAt.keys().next().value); }
    if (now - holdAt.get(k) < 900) return { stage: 0, labels: null };
    gaveUp.add(k); if (gaveUp.size > 24) gaveUp.delete(gaveUp.values().next().value); return null;
  }
  // 模型信息 / 底栏 / 左侧卡片 / 波轮用：这个对话的这一抽还在老虎机里揭晓（没全部停下）→ 已经亮出的部分；否则 null
  function view(sid) {
    if (!sid || !wrap?.classList.contains('on') || !disp || document.hidden) return null;
    let q = null; try { q = gacha.peek(); } catch {}
    if (!q || q.sid !== sid || !['running', 'stopping'].includes(q.status)) return null;
    // 这一抽刚开始、老虎机还在展示上一抽的结果：先什么都不亮（进行中的调用名也不透露）
    if (disp.no !== q.draw) return { stage: 0, labels: null };
    if (disp.coast || disp.endAt || disp.stage >= 3) return null;
    return { stage: disp.labels ? disp.stage : 0, labels: disp.labels ? disp.labels.slice() : null };
  }
  // 抽卡循环用：这一抽三格都停下已经多久了（毫秒；不在揭晓 / 老虎机收起 = Infinity）
  function settledFor() {
    if (!wrap?.classList.contains('on') || !disp || !disp.endAt || document.hidden || disp.coast) return Infinity;
    let q = null; try { q = gacha.peek(); } catch {}
    return q && q.draw === disp.no && disp.labels ? performance.now() - disp.endAt : Infinity;
  }
  // 抽卡循环用：这一抽已经定了（有结果）但三格还没全部停下 → 先别开下一个对话
  function revealing() {
    if (!wrap?.classList.contains('on') || !disp || document.hidden) return false;
    let q = null; try { q = gacha.peek(); } catch {}
    return !!q && ['running', 'stopping'].includes(q.status) && q.draw === disp.no && q.ok && !disp.endAt && !disp.coast;
  }
  function tick() {
    let q = null; try { q = gacha.peek(); } catch {}
    const running = !!q && q.status === 'running';
    if (running && q.id !== hiddenRun) { endShown = ''; show(); return; }
    if (wrap?.classList.contains('on') && q && !running) {
      // 结束：停留几秒展示结果再淡出
      const key = q.id + q.status; if (endShown !== key) { endShown = key; hide(['paused', 'stopped', 'stopping'].includes(q.status) ? 900 : 4500); }
    } else if (wrap?.classList.contains('on') && (!q || q.id === hiddenRun)) hide();
  }
  setInterval(() => { try { tick(); } catch {} }, 250);
  return { parts, reveal, view, revealing, settledFor, stageName };
})();
const routeAlert = (() => {
  // Pops a notice whenever a conversation's response model changes (e.g. routed to another model).
  const KEY = 'amp.native.resp.v1';
  // v1.11.71 旧版本在“同一运行被多个对话共用”时可能把别的对话的模型记到这里，升级后清空一次，避免再误报一次“换回来”
  try { if (localStorage.getItem(KEY + '.rev') !== '2') { localStorage.removeItem(KEY); localStorage.setItem(KEY + '.rev', '2'); } } catch {}
  let last = new Map(); try { last = new Map(Object.entries(JSON.parse(localStorage.getItem(KEY)) || {}).slice(-300)); } catch {}
  let host = null, box = null;
  function ensure() {
    if (host?.isConnected) return; if (!document.body) return;
    host = document.createElement('div'); host.id = 'amp-route-alert'; host.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>:host{all:initial}.stack{display:flex;flex-direction:column;gap:8px;align-items:center;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}'
      + '.card{pointer-events:auto;min-width:280px;max-width:min(520px,92vw);background:#fff;color:#1f2430;border:1px solid #e2e6ed;border-left:4px solid var(--amp-acc,#2f6fed);border-radius:12px;box-shadow:0 8px 28px #0000002a;padding:10px 12px;display:grid;grid-template-columns:1fr auto;gap:2px 10px;animation:in .22s ease-out}'
      + '.lg{display:inline-flex;vertical-align:-2px;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:#fff;color:#111;box-shadow:0 0 0 1px #0000001a;margin-right:5px;font-style:normal}.lg svg{width:11px;height:11px;fill:currentColor}.card.gold{border-left-color:#c9950c}.card.drop{border-left-color:#e38a1e}h4{margin:0;font-size:12px;font-weight:700;color:var(--amp-acc,#2f6fed)}.gold h4{color:#a87b06}.drop h4{color:#c26d0a}.m{grid-column:1;font-weight:600;word-break:break-all}.m b{color:var(--amp-acc,#2f6fed)}.m s{opacity:.6}.t{grid-column:1;font-size:11px;color:#6b7383;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + 'button{grid-column:2;grid-row:1/4;align-self:start;border:0;background:transparent;font-size:16px;line-height:1;color:#8a93a3;cursor:pointer;padding:2px 4px;border-radius:6px}button:hover{background:#f0f2f6}@keyframes in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}'
      + '@media (prefers-color-scheme:dark){.card{background:#2c2b28;color:#ecebe7;border-color:#3f3d39}.t{color:#a9a59d}button:hover{background:#363531}}.card{border-left-color:var(--amp-acc,#2f6fed)}h4{color:var(--amp-acc,#2f6fed)}.m b{color:var(--amp-acc,#2f6fed)}</style><div class="stack"></div>';
    box = root.querySelector('.stack'); document.body.append(host);
  }
  function show(title, from, to, sub, kind = '') {
    ensure(); if (!box) return;
    const c = document.createElement('div'); c.className = 'card ' + kind; c.setAttribute('role', 'alert');
    const h = document.createElement('h4'); h.textContent = title;
    const m = document.createElement('div'); m.className = 'm';
    // 有厂商 logo 时名字不带厂商前缀；前后厂商不同时各自带 logo
    const ico = n => { const v = brand.of(n); if (!v) return null; const i = document.createElement('i'); i.className = 'lg'; try { i.innerHTML = gachaUi.vendorIcon(v, 12); } catch {} return i; };
    const nm = n => brand.of(n) ? brand.short(n) : noVertex(String(n || ''));
    if (from) { const s = document.createElement('s'); const fi = ico(from); if (fi) m.append(fi); s.textContent = nm(from); m.append(s, ' → '); }
    const b = document.createElement('b'); const ti = ico(to); if (ti) m.append(ti); b.textContent = nm(to); m.append(b);
    const t = document.createElement('div'); t.className = 't'; t.textContent = String(sub || '').replace(/(#\d+\s*·\s*)(.+)$/, (_, a, x) => a + nm(x));
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', '关闭'); x.onclick = () => c.remove();
    c.append(h, x, m, t); box.prepend(c); while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => c.remove(), 8000);
  }
  function note(sid, model, sub, quiet) {
    if (!sid || !model) return;
    const old = last.get(sid);
    if (old === model) return;
    // 同一模型只是名字更精确（加了档位、-vertex、5-5→5.5）：静默更新记录，不弹提醒
    const refine = old && brand.same(old, model);
    last.delete(sid); last.set(sid, model); while (last.size > 300) last.delete(last.keys().next().value);
    ampStore.set(KEY, JSON.stringify(Object.fromEntries(last)));
    // 只在当前打开的这个对话里弹提醒（后台对话的变化静默记下），切换对话不会误报
    const here = (location.pathname.match(/^\/agent\/([\w-]{1,128})\/?$/) || [])[1] === sid;
    if (old && !quiet && !refine && here && !gacha.quietTurn(sid)) show('模型变更提醒', old, model, sub, '');
  }
  return { note, show };
})();

// ====================================================================================
// Native slot-machine button + popover. Modeled on Arena-Web-Manager gacha-page-ui.ts:
// a 32×32 button before Send/Stop (108px with progress while running), a 256px ShadowRoot
// popover with the exact AWM popover CSS, pill slider 5/10/15/20/30 and html.dark theme.
// ====================================================================================
const gachaUi = (() => {
  const CSS = "/* Mirrored in apps/api/src/gacha-popover-style.ts for the isolated native ShadowRoot.\n   tests/gacha-panel.test.mjs verifies exact parity. */\n.gachaPopover {\n  --gp-bg:#fff; --gp-fg:#242936; --gp-muted:#626d7f; --gp-line:#e2e6ed;\n  --gp-hover:#f0f2f6; --gp-field:#f8f9fb; --gp-track:#e2e6ed;\n  --gp-accent:#1c1c1e; --gp-accent-fg:#fff; --gp-accent-hover:#3a3a3c; --gp-danger:#ba3445; --gp-shadow:0 4px 18px #00000012,0 1px 3px #0000000b;\n  box-sizing:border-box; width:256px; max-width:calc(100vw - 24px); padding:10px;\n  border:1px solid var(--gp-line); border-radius:16px; background:var(--gp-bg); color:var(--gp-fg);\n  box-shadow:var(--gp-shadow); font:400 13px/1.45 -apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,sans-serif;\n  color-scheme:light; text-align:left; -webkit-font-smoothing:antialiased;\n}\n.gachaPopover[data-theme=\"dark\"] {\n  --gp-bg:#23262c; --gp-fg:#eceef4; --gp-muted:#a4adbf; --gp-line:#3a404c;\n  --gp-hover:#2d3139; --gp-field:#1c1f25; --gp-track:#3a404c;\n  --gp-accent:#dcdcdc; --gp-accent-fg:#1c1c1e; --gp-accent-hover:#c6c6c6;\n  --gp-danger:#ff9da8; --gp-shadow:0 5px 24px #0003,0 1px 3px #0002; color-scheme:dark;\n}\n.gachaPopover *, .gachaPopover *::before, .gachaPopover *::after { box-sizing:border-box; }\n.gachaPopover [hidden] { display:none!important; }\n.gachaPopover button { appearance:none; display:inline-flex; align-items:center; justify-content:center; gap:5px; min-height:0; margin:0; border:0; padding:0; background:transparent; color:inherit; font:inherit; cursor:pointer; box-shadow:none; letter-spacing:normal; }\n.gachaPopover button:hover { background:var(--gp-hover); }\n.gachaPopover button:disabled { opacity:.45; cursor:not-allowed; }\n.gachaPopover :is(button,input,textarea,select):focus-visible { outline:2px solid var(--gp-accent); outline-offset:3px; }\n.gachaPopover .gpHeader { display:flex; gap:4px; align-items:center; }\n.gachaPopover .gpIcon { width:28px; height:28px; flex:0 0 28px; border-radius:7px; color:var(--gp-muted); }\n.gachaPopover .gpIcon svg { width:16px; height:16px; }\n.gachaPopover .gpTextIcon { font-family:Georgia,serif; font-size:15px; }\n.gachaPopover .gpClose { font-size:18px; width:22px; flex-basis:22px; }\n.gachaPopover .gpChosen { flex:1; min-width:0; display:flex; flex-direction:column; gap:0; padding:3px 4px; border-radius:8px; }\n.gachaPopover .gpChosen small { color:var(--gp-muted); font-size:10px; line-height:15px; font-weight:400; }\n.gachaPopover .gpChosen span { display:block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; font-weight:600; }\n.gachaPopover .gpQuantity { margin:9px 0 8px; }\n.gachaPopover .gpRange { position:relative; height:26px; border-radius:20px; background:linear-gradient(to right,var(--gp-accent) 0%,var(--gp-accent) var(--gp-fill,75%),var(--gp-track) var(--gp-fill,75%),var(--gp-track) 100%); }\n.gachaPopover .gpDots { position:absolute; inset:0 12px; display:flex; align-items:center; justify-content:space-between; pointer-events:none; }\n.gachaPopover .gpDots i { width:4px; height:4px; border-radius:50%; background:var(--gp-muted); opacity:.6; }\n.gachaPopover .gpRange input { appearance:none; -webkit-appearance:none; display:block; position:absolute; inset:0; width:100%; height:26px; margin:0; padding:0; border:0; background:transparent; cursor:pointer; box-shadow:none; }\n.gachaPopover .gpRange input::-webkit-slider-runnable-track { height:26px; background:transparent; border:0; }\n.gachaPopover .gpRange input::-webkit-slider-thumb { appearance:none; -webkit-appearance:none; width:26px; height:26px; border-radius:50%; background:#fff; border:1px solid #00000008; box-shadow:0 1px 4px #0002; }\n.gachaPopover .gpRange input::-moz-range-track { background:transparent; height:26px; border:0; }\n.gachaPopover[data-theme=\"dark\"] .gpRange input::-webkit-slider-thumb { border-color:#0000002e; }\n.gachaPopover[data-theme=\"dark\"] .gpRange input::-moz-range-thumb { border:1px solid #0000002e; }\n.gachaPopover .gpRange input::-moz-range-thumb { width:25px; height:25px; border-radius:50%; border:0; background:#fff; box-shadow:0 1px 4px #0002; }\n.gachaPopover .gpTicks { display:flex; justify-content:space-between; margin:5px 4px 0; }\n.gachaPopover .gpTicks button { width:20px; height:18px; border-radius:4px; font-size:10px; color:var(--gp-muted); font-variant-numeric:tabular-nums; }\n.gachaPopover .gpTicks button[aria-pressed=\"true\"] { color:var(--gp-fg); font-weight:600; }\n.gachaPopover .gpFooter { display:flex; align-items:center; justify-content:space-between; gap:8px; }\n.gachaPopover .gpProgress { font-size:11px; color:var(--gp-muted); font-variant-numeric:tabular-nums; }\n.gachaPopover .gpPrimary { background:var(--gp-accent); color:var(--gp-accent-fg); padding:6px 12px; min-height:30px; border-radius:9px; font-size:12px; font-weight:500; white-space:nowrap; }\n.gachaPopover .gpPrimary:hover { background:var(--gp-accent-hover); }\n.gachaPopover .gpSecondary { border:1px solid var(--gp-line); border-radius:8px; padding:6px 10px; font-size:12px; }\n.gachaPopover .gpStatus { display:flex; align-items:center; gap:6px; margin-top:8px; font-size:11px; color:var(--gp-muted); min-width:0; }\n.gachaPopover .gpStatus::before { content:\"\"; width:5px; height:5px; flex:0 0 5px; border-radius:50%; background:currentColor; opacity:.55; }\n.gachaPopover .gpStatus span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n.gachaPopover .gpMenu { margin:8px -5px 2px; padding:4px; border-radius:10px; background:var(--gp-bg); max-height:240px; overflow-y:auto; overscroll-behavior:contain; }\n.gachaPopover .gpCaption { color:var(--gp-muted); margin:0 6px 5px; font-size:11px; }\n.gachaPopover .gpOption { display:flex; width:100%; min-height:34px; padding:7px 9px; justify-content:space-between; border-radius:8px; font-size:12px; }\n.gachaPopover .gpOption span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n.gachaPopover .gpOption[aria-checked=\"true\"] { background:var(--gp-hover); }\n.gachaPopover .gpSettings { margin-top:10px; padding-top:10px; border-top:1px solid var(--gp-line); }\n.gachaPopover label { display:grid; gap:5px; margin:0 0 10px; color:var(--gp-muted); font-size:11px; min-width:0; }\n.gachaPopover :is(textarea,input:not([type=\"range\"]):not([type=\"checkbox\"]),select) { display:block; width:100%; min-width:0; border:1px solid var(--gp-line); border-radius:8px; padding:7px 8px; background:var(--gp-field); color:var(--gp-fg); font:400 12px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,sans-serif; box-shadow:none; }\n.gachaPopover textarea { min-height:64px; resize:vertical; }\n.gachaPopover .gpModelsInput { min-height:112px; }\n.gachaPopover .gpRow { display:grid; grid-template-columns:1fr 1fr; gap:8px; }\n.gachaPopover .gpCheck { display:flex; align-items:center; gap:7px; font-size:11px; }\n.gachaPopover .gpCheck input { width:13px; height:13px; margin:0; accent-color:var(--amp-acc,#2f6fed); }\n.gachaPopover .gpHelp { font-size:11px; color:var(--gp-muted); margin:0 0 10px; line-height:1.55; }\n.gachaPopover .gpSaveRow { display:flex; justify-content:flex-end; }\n.gachaPopover .gpMessage { margin:8px 0 0; color:var(--gp-muted); font-size:11px; line-height:1.5; overflow-wrap:anywhere; }\n.gachaPopover .gpMessage[data-error=\"true\"] { color:var(--gp-danger); }\n.gachaPopover.gpModelNotice { width:300px; padding:14px; }\n.gachaPopover .gpNoticeHead { display:flex; align-items:center; justify-content:space-between; font-size:12px; font-weight:600; }\n.gachaPopover .gpModelTransition { margin:9px 0 6px; font-size:13px; font-weight:500; overflow-wrap:anywhere; }\n.gachaPopover .gpNoticeReason { margin:0; color:var(--gp-muted); font-size:11px; line-height:1.6; }\n@media(prefers-reduced-motion:no-preference) { .gachaPopover .gpRange { transition:background .12s; } }\n@media (pointer:coarse) {\n  .gachaPopover .gpIcon { width:32px; height:32px; flex-basis:32px; }\n  .gachaPopover .gpPrimary,.gachaPopover .gpSecondary { min-height:36px; }\n  .gachaPopover .gpOption { min-height:40px; }\n  .gachaPopover .gpTicks button { height:24px; width:28px; }\n}\n";
  const slotIcon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="4" y="4" width="14" height="16" rx="3"/><rect x="7" y="8" width="8" height="5" rx="1"/><path d="M8 17h6m4-9h2v4"/><circle cx="20" cy="14" r="1"/></svg>';
  const gear = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 3-.6 2.3-2 .9-2.1-.6-2 3.4 1.6 1.7v2.6l-1.6 1.7 2 3.4 2.2-.6 1.9.9L9 21h4l.6-2.3 2-.9 2.1.6 2-3.4-1.6-1.7v-2.6L19.7 9l-2-3.4-2.2.6-1.9-.9L13 3Z"/><circle cx="11" cy="12" r="3"/></svg>';
  const Q = gacha.QUANTITIES;
  const chevron = '<svg data-amp-chev width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  // ---------------- live Arena Agent leaderboard (strength ranking) ----------------
  // Read same-origin from /leaderboard/agent (public page), cached 6h; the snapshot below is only a fallback.
  const ranking = (() => {
    const KEY = 'amp.native.rank.v1', TTL = 6 * 3600000, FALLBACK = ["Claude Fable 5.1 (Max)", "GPT 6 Astra (Max)", "Claude Opus 5 (High)", "Claude Opus 5 (Max)", "Claude Fable 5 (High)", "Claude Opus 4.8 (High)", "GPT 5.6 Sol (xHigh)", "Kimi K3 (Max)", "Claude Sonnet 5 (High)", "GPT 5.5 (xHigh)", "Hy4 preview", "Deepseek V4.1 Flash (Max)", "Gemini 3.8 Flash (High)", "GLM 5.2 (Max)", "Muse Spark 1.3 (Max)", "DeepSeek V4 Pro (High)", "Qwen3.8 Max", "GLM 5.3 (Max)", "Grok 4.5", "GPT 5.5", "Grok 4.6 (xHigh)", "Deepseek V4 Flash (High)", "GPT 5.6 Terra (xHigh)", "GPT 5.4 (High)", "GLM 5.3 Flash", "Qwen3.8 Flash Next", "GPT 5.6 Luna (xHigh)", "Gemini 3.7 Flash (High)", "Qwen 3.8 27B", "DeepSeek V4 Pro", "Claude Sonnet 4.6", "Muse Spark 1.2 (xHigh)", "Muse Spark 1.1", "Qwen3.7 Max", "Hy3", "Mimo V2.5 Pro", "Minimax M3", "Gemini 3.1 Pro Preview", "Gemini 3.6 Flash (High)", "Qwen3.7 Plus", "Inkling Small", "Inkling", "Mistral Medium 3.5", "Minimax M2.7", "Gemini 3.5 Flash Lite", "Solar Pro 4"];
    const TIER = /^(none|minimal|low|medium|high|xhigh|max)$/;
    const toks = v => String(v || '').toLowerCase().replace(/(\d)([a-z])/g, '$1-$2').replace(/([a-z])(\d)/g, '$1-$2').split(/[^a-z0-9]+/).filter(Boolean);
    let list = null, at = 0, loading = false, rev = 0;
    const build = names => names.map((n, i) => { const t = toks(n.replace(/\((\d{4,})\)/g, '')), tier = t.filter(x => TIER.test(x)); return { rank: i + 1, name: n, base: t.filter(x => !TIER.test(x)), tier: tier[0] || '' }; }).filter(e => e.base.length);
    try { const c = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(c?.names) && c.names.length > 5) { list = build(c.names); at = c.at || 0; } } catch {}
    if (!list) list = build(FALLBACK);
    function parse(html) {
      const doc = new DOMParser().parseFromString(html, 'text/html'), out = [];
      for (const tr of doc.querySelectorAll('table tbody tr')) {
        const cells = tr.querySelectorAll('td'); if (cells.length < 3) continue;
        const cell = [...cells].slice(0, 3).find(c => c.querySelector('a[href^="http"]') || /·/.test(c.textContent || ''));
        if (!cell) continue;
        const link = cell.querySelector('a'); let name = (link?.textContent || '').trim();
        if (!name) name = [...cell.querySelectorAll('*')].filter(e => !e.children.length).map(e => (e.textContent || '').trim()).find(t => t && !t.includes('·')) || '';
        if (name && name.length < 80) out.push(name);
      }
      return out;
    }
    async function refresh(force = false) {
      if (loading || (!force && Date.now() - at < TTL)) return; loading = true;
      try {
        const res = await fetch('/leaderboard/agent', { credentials: 'same-origin', cache: 'no-store' });
        if (res.ok) { const names = parse(await res.text()); if (names.length > 5) { list = build(names); at = Date.now(); rev++; ampStore.set(KEY, JSON.stringify({ names, at })); } }
      } catch {} finally { loading = false; }
    }
    const find = (hay, needle) => { for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((x, j) => hay[i + j] === x)) return true; return false; };
    // Lower is stronger. Exact family match = rank (tier match preferred); unknown sibling (same first 2 tokens) = 100 + rank; unranked = 1000.
    function score(title) {
      const t = toks(String(title || '').replace(/^#\d+\s*/, '').replace(/\s*·\s*\d+\s*$/, ''));
      let best = null;
      for (const e of list) if (find(t, e.base)) { const tierOk = e.tier && t.includes(e.tier); const sc = e.rank - (tierOk ? 0.5 : 0) - e.base.length * 0.001; if (!best || e.base.length > best.len || (e.base.length === best.len && sc < best.sc)) best = { sc, len: e.base.length }; }
      if (best) return best.sc;
      const fam = list.find(e => e.base.length >= 2 && find(t, e.base.slice(0, 2)));
      return fam ? 100 + fam.rank : 1000;
    }
    // 档位强弱：max > xhigh > high > medium > low > minimal > 无后缀
    const TIER_RANK = { max: 6, xhigh: 5, high: 4, medium: 3, low: 2, minimal: 1, none: 0 };
    function tier(title) { const t = toks(String(title || '').replace(/\s*·\s*\d+\s*$/, '')); let b = 0; for (const x of t) if (TIER_RANK[x] > b) b = TIER_RANK[x]; return b; }
    // 系列强弱：去掉档位词后按排行榜比较（同系列不同档位得到相同的值）
    function family(title) { return score(toks(String(title || '').replace(/^#\d+\s*/, '').replace(/\s*·\s*\d+\s*$/, '')).filter(x => !TIER.test(x)).join('-')); }
    return { score, tier, family, refresh, get rev() { return rev; }, get at() { return at; }, get size() { return list.length; } };
  })();
  // ---------------- sidebar: highlight the chosen vendor, sort by live strength ----------------
  // Non-destructive: only CSS `order` on each list item and a data attribute. React-owned nodes are never moved.
  const sidebar = (() => {
    let stamp = '', touched = new Set(), lastRows = [], flatP = null, flatM = null, flatSet = new Set();
    // GPT 同一代里的强弱：Astra > Sol > Terra > Luna（与 Arena 模型菜单的顺序一致）；没有这些词的排在它们后面。
    // v1.11.76 系列比档位优先：astra-low 也排在 luna-max 前面；金色只给 Astra 的 high / xhigh / max。
    // GPT 不用排行榜的系列名次（新型号常未上榜，短名/全名混用时名次还会不一致），版本号相同就按这个比，再比档位。
    const GPT_FAM = { astra: 1, sol: 2, terra: 3, luna: 4 };
    const gptFam = title => { let best = 9; for (const x of String(title || '').toLowerCase().replace(/(\d)([a-z])/g, '$1-$2').replace(/([a-z])(\d)/g, '$1-$2').split(/[^a-z0-9]+/)) if (GPT_FAM[x] && GPT_FAM[x] < best) best = GPT_FAM[x]; return best; };
    function unflat() {
      for (const el of flatSet) { el.style.removeProperty('order'); el.style.removeProperty('margin-left'); el.style.removeProperty('margin-right'); el.style.removeProperty('margin-top'); }
      flatSet = new Set(); document.querySelectorAll('[data-amp-flat]').forEach(n => n.removeAttribute('data-amp-flat')); document.querySelectorAll('[data-amp-flatp]').forEach(n => n.removeAttribute('data-amp-flatp')); flatP = null; flatM = null;
    }
    // v1.11.78 目标模型的卡片（置顶的命中 / 金色卡片）标题下一小行“最近一次对话时间”（月-日 时:分），最新的那张字色深一点；其他卡片不加。
    // 时间用 Arena 侧栏自己的数据（卡片组件 props.entry.updatedAt——它分 Today / Yesterday 用的就是这个），不额外请求。
    // 只加属性 + 伪元素（不插节点），和标题左对齐。
    try { const st = document.createElement('style'); st.textContent = '[data-amp-flat]{display:contents!important}[data-amp-flatp]{display:flex!important;flex-direction:column!important;row-gap:0!important;gap:0!important}'; (document.head || document.documentElement).append(st); } catch {}
    // 样式表单独放、每次同步前确认还在（脚本启动时 head 还没有，React 水合出错重建文档时会把早插入的 style 一起清掉）
    const CT_CSS = '[data-amp-ctime]{position:relative!important;padding-bottom:13px!important}'
      + '[data-amp-ctime]::before{content:attr(data-amp-ctime);position:absolute;left:0;right:0;bottom:0;height:13px;font-size:10.5px;line-height:13px;font-weight:400;font-style:normal;font-variant-numeric:tabular-nums;letter-spacing:.01em;color:hsl(var(--text-tertiary,35 6% 38%));opacity:.85;white-space:nowrap;overflow:hidden;visibility:visible;pointer-events:none;text-align:left}'
      + '[data-amp-ctime][data-amp-cnew]::before{color:hsl(var(--text-secondary,35 6% 30%));opacity:1;font-weight:600}'
      + 'a[data-amp-current][data-amp-ink] [data-amp-ctime]::before{color:var(--amp-cur-fg,var(--amp-acc-fg,#fff));opacity:.8}';
    const ctCss = () => { if (document.head && !document.getElementById('amp-ctime-css')) { const st = document.createElement('style'); st.id = 'amp-ctime-css'; st.textContent = CT_CSS; document.head.append(st); } };
    const entryAt = (a, sid) => { try { const k = Object.keys(a).find(x => x.startsWith('__reactFiber')); let f = k ? a[k] : null; for (let n = 0; f && n < 30; n++, f = f.return) { const e = f.memoizedProps?.entry; if (e && typeof e === 'object' && e.id === sid) { const t = Date.parse(e.updatedAt || e.lastMessageAt || e.createdAt || ''); return Number.isFinite(t) ? t : null; } } } catch {} return null; };
    const ctFmt = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0'); return (d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '-') + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
    const ctEl = a => a.querySelector('[data-amp-local-title]') || a.querySelector('span.truncate,div.truncate');
    let ctSet = new Set();
    const ctPut = (el, text, isNew) => { if (el.getAttribute('data-amp-ctime') !== text) el.setAttribute('data-amp-ctime', text); el.toggleAttribute('data-amp-cnew', !!isNew); };
    const ctOff = el => { el.removeAttribute('data-amp-ctime'); el.removeAttribute('data-amp-cnew'); };
    const titleOf = a => { const sp = a.querySelector('[data-amp-local-title]'); if (sp) return sp.getAttribute('data-amp-local-title');
      const tt = a.querySelector('span.truncate,div.truncate'); if (tt && !tt.querySelector('svg,button,[data-amp-vlogo],.sr-only')) return (tt.textContent || '').trim();
      let out = ''; const w = document.createTreeWalker(a, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement?.closest('[data-amp-vlogo],svg,button,.sr-only') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      while (w.nextNode()) out += w.currentNode.nodeValue; return out.trim(); };
    const clear = el => { el.style.removeProperty('order'); el.style?.removeProperty?.('--amp-tint'); el.removeAttribute('data-amp-target-hit'); el.removeAttribute('data-amp-vip'); el.removeAttribute('data-amp-brand'); unlogo(el); };
    const unlogo = a => { a.querySelectorAll?.('[data-amp-vlogo]').forEach(n => n.remove()); a.querySelectorAll?.('[data-amp-logo-hidden]').forEach(n => n.removeAttribute('data-amp-logo-hidden')); a.removeAttribute?.('data-amp-logo'); };
    // Replace the round native icon at the left of a pinned card with the vendor logo (titles cannot carry logos).
    function logo(a, vid) {
      if (!vid) { if (a.hasAttribute('data-amp-logo')) unlogo(a); return; }
      const holders = [...a.querySelectorAll('[data-amp-vlogo]')]; holders.slice(1).forEach(n => n.remove());
      let holder = holders[0] || null;
      if (holder && holder.getAttribute('data-amp-vlogo') !== vid) { holder.setAttribute('data-amp-vlogo', vid); holder.toggleAttribute('data-full', !!BADGE[vid]); holder.innerHTML = vendorIcon(vid, 12); }
      const title = a.querySelector('span.truncate,div.truncate,[data-amp-local-title]');
      // Hide every native icon before the title that is not hidden yet (React may re-render a fresh one).
      const icons = [...a.querySelectorAll('svg,img')].filter(n => !n.closest('button,[data-amp-vlogo],[data-amp-logo-hidden]') && !(title && title.contains(n)) && (!title || (n.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)));
      const boxes = icons.map(icon => { let box = icon; while (box.parentElement && box.parentElement !== a && box.parentElement.children.length === 1 && !box.parentElement.contains(title)) box = box.parentElement; box.setAttribute('data-amp-logo-hidden', ''); return box; });
      if (!holder) {
        holder = document.createElement('span'); holder.setAttribute('data-amp-vlogo', vid); if (BADGE[vid]) holder.setAttribute('data-full', ''); holder.innerHTML = vendorIcon(vid, 12);
        if (a.hasAttribute('data-amp-logo-seen')) holder.setAttribute('data-noanim', ''); // 只有第一次出现时做入场动画
        const hidden = a.querySelector('[data-amp-logo-hidden]');
        if (boxes.length) boxes[0].before(holder); else if (hidden) hidden.before(holder); else if (title) title.before(holder); else a.prepend(holder);
      }
      a.setAttribute('data-amp-logo', vid); a.setAttribute('data-amp-logo-seen', '');
    }
    function sync(keywords) {
      const sortOn = gacha.settings().sortSidebar;
      if (sortOn) void ranking.refresh();
      const kw = (keywords || []).map(k => k.toLowerCase());
      const links = [...document.querySelectorAll('a[href^="/agent/"]')].filter(a => a.closest('aside,nav,[data-sidebar]') && /^\/agent\/[0-9a-f-]{8,}/i.test(a.getAttribute('href')));
      progress.mark(links);
      const sidOfA = a => (a.getAttribute('href').match(/[0-9a-f-]{36}/i) || [''])[0], ats = new Map(links.map(a => [a, entryAt(a, sidOfA(a))]));
      const key = sortOn + '|' + kw.join(',') + '|' + ranking.rev + '|' + vip.rev + '|' + brand.hint.rev() + '|' + links.map(a => a.getAttribute('href') + '=' + titleOf(a) + '@' + (ats.get(a) || '')).join(',');
      if (key === stamp) { for (const r of lastRows) { if (!r.a.isConnected) continue; if (r.ct) { ctCss(); const el = ctEl(r.a); if (el && el.getAttribute('data-amp-ctime') !== r.ct) { ctPut(el, r.ct, r.cnew); ctSet.add(el); } } const n = r.a.getElementsByTagName('svg').length + r.a.getElementsByTagName('img').length; if (n === r.ic && (!r.vid || r.a.querySelector('[data-amp-vlogo]'))) continue; logo(r.a, r.vid); r.ic = r.a.getElementsByTagName('svg').length + r.a.getElementsByTagName('img').length; } return; } stamp = key; lastRows = [];
      const groups = new Map();
      for (const a of links) {
        const item = a.closest('li') || a, list = item.parentElement; if (!list) continue; if (!groups.has(list)) groups.set(list, []);
        const title = titleOf(a).toLowerCase(), sid = (a.getAttribute('href').match(/[0-9a-f-]{36}/i) || [''])[0];
        // 金色传说置顶：命中目标厂商且档位为 max / xhigh / high（取代以前 dxzui / clzui 的金色置顶）
        // v1.11.76 GPT 先比系列再比档位：Astra 最强 → Sol → Terra → Luna。金色只给 Astra（标题里没有这些系列词的旧型号照旧按档位）——
        // 以前 luna-max 因为档位是 max 被镀金置顶，排到了 astra-medium / astra-low 前面
        const vid = brand.forSid(sid, title) || brand.of(vip.get(sid)), gpt = sortOn && vid === 'openai', gf = gpt ? gptFam(title) : 0;
        const hitNow = sortOn && kw.length > 0 && kw.some(k => title.includes(k)), isVip = hitNow && /(^|[-\s·(])(max|xhigh|high)(?=$|[-\s·)])/i.test(title) && !(gpt && gf > 1 && gf < 9);
        groups.get(list).push({ a, item, at: ats.get(a) || null, vip: isVip, hit: hitNow, sc: sortOn ? ranking.score(title) : 0, gf, fam: sortOn && !gpt ? ranking.family(title) : 0, tier: sortOn ? ranking.tier(title) : 0, ver: brand.version(title), vid, nt: sortOn ? title.replace(/\s*·\s*\d+\s*$/, '') : '' });
      }
      const next = new Set();
      // 金色只给同厂商里版本号最高的那一代（有 5.5 时 5 的 high/max 不再是金色；gpt 有 6 时 5.6 不是金色）
      { const topVer = new Map(); for (const rows of groups.values()) for (const r of rows) if (r.hit && r.ver != null) { const g = r.vid || ''; if (!(topVer.get(g) >= r.ver)) topVer.set(g, r.ver); }
        for (const rows of groups.values()) for (const r of rows) if (r.vip && !(r.ver != null && r.ver === topVer.get(r.vid || ''))) r.vip = false; }
      // 选了目标模型（或有 VIP）时：把所有日期分组（Today / Yesterday / Older）里命中的卡片统一置顶。
      // 仍然不移动 React 节点：把分组容器设为 display:contents，所有卡片成为同一个 flex 容器的子项，再用 order 排。
      const lists = [...groups.keys()], anyPin = [...groups.values()].some(rows => rows.some(r => r.vip || r.hit));
      let P = null, flatPinned = null;
      if (lists.length > 1 && anyPin) { P = lists[0].parentElement; while (P && !lists.every(l => P.contains(l))) P = P.parentElement; if (P && !P.closest('aside,nav,[data-sidebar]')) P = null; }
      if (P !== flatP) unflat();
      if (P) {
        flatP = P;
        if (!P.hasAttribute('data-amp-flatp')) {
          // 进入平铺前量一下原来的缩进/间距，平铺后补回去，看起来和分组时一样
          const pr = P.getBoundingClientRect(), cs = getComputedStyle(P), pl = pr.left + parseFloat(cs.paddingLeft || 0) + parseFloat(cs.borderLeftWidth || 0), prr = pr.right - parseFloat(cs.paddingRight || 0) - parseFloat(cs.borderRightWidth || 0);
          const li0 = groups.get(lists[0])[0]?.item, li1 = groups.get(lists[0])[1]?.item, r0 = li0?.getBoundingClientRect(), r1 = li1?.getBoundingClientRect();
          flatM = { l: r0 ? Math.max(0, r0.left - pl) : 0, r: r0 ? Math.max(0, prr - r0.right) : 0, gap: r0 && r1 ? Math.max(0, Math.min(12, r1.top - r0.bottom)) : 0, lab: null };
          for (const l of lists) { let n = l; while (n && n !== P) { n.setAttribute('data-amp-flat', ''); n = n.parentElement; } }
          P.setAttribute('data-amp-flatp', '');
        } else for (const l of lists) { let n = l; while (n && n !== P) { if (!n.hasAttribute('data-amp-flat')) n.setAttribute('data-amp-flat', ''); n = n.parentElement; } }
        const setO = (el, o, kind) => { el.style.order = String(o); if (kind === 'li') { el.style.marginLeft = flatM.l + 'px'; el.style.marginRight = flatM.r + 'px'; el.style.marginTop = flatM.gap + 'px'; } else if (kind === 'lab') { el.style.marginLeft = flatM.l + 'px'; el.style.marginRight = flatM.r + 'px'; el.style.marginTop = '10px'; } flatSet.add(el); };
        const all = [...groups.values()].flat(); all.forEach((r, i) => r.i = i);
        const best = new Map(); for (const r of all) { const g = r.vid || '~' + r.i; best.set(g, Math.min(best.get(g) ?? Infinity, r.sc)); }
        for (const r of all) { r.g = r.vid || '~' + r.i; r.gs = best.get(r.g); }
        const cmp = (x, y) => (y.vip - x.vip) || (y.hit - x.hit) || (sortOn ? (x.gs - y.gs) || (x.g < y.g ? -1 : x.g > y.g ? 1 : 0) || ((y.ver ?? -1) - (x.ver ?? -1)) || (x.gf - y.gf) || (x.fam - y.fam) || (y.tier - x.tier) || (x.sc - y.sc) || (x.nt < y.nt ? 1 : x.nt > y.nt ? -1 : 0) : 0) || (x.i - y.i);
        let seg = 0, firstBase = null;
        for (const c of P.children) {
          const base = 100000 + (seg++) * 10000, L = lists.filter(l => c === l || c.contains(l));
          if (!L.length) { setO(c, base); continue; }
          if (firstBase === null) firstBase = base;
          for (const l of L) { let n = l; while (n !== c) { for (const sib of n.parentElement.children) if (sib !== n && !lists.some(x => sib === x || sib.contains(x))) setO(sib, base, 'lab'); n = n.parentElement; } }
          for (const l of L) groups.get(l).filter(r => !(r.vip || r.hit)).sort(cmp).forEach((r, k) => setO(r.item, base + 1 + k, 'li'));
        }
        flatPinned = all.filter(r => r.vip || r.hit).sort(cmp); flatPinned.forEach((r, k) => setO(r.item, (firstBase ?? 100000) - 5000 + k, 'li'));
      }
      for (const [list, rows] of groups) {
        const sortable = !P && /flex|grid/.test(getComputedStyle(list).display);
        if (!P) rows.forEach((r, i) => r.i = i);
        const pinned = rows.some(r => r.vip) || sortOn;
        // 同厂商先比版本号（opus-5.5 > fable-5.1，未上榜的新版本也能排前），版本相同再按排行榜（fable/opus、档位）。
        // 比较器必须可传递，否则同一输入在不同轮次可能排出不同顺序 → 卡片来回交换（频闪）。
        const best = new Map(); for (const r of rows) { const g = r.vid || '~' + r.i; best.set(g, Math.min(best.get(g) ?? Infinity, r.sc)); }
        if (!P) for (const r of rows) { r.g = r.vid || '~' + r.i; r.gs = best.get(r.g); }
        const sorted = rows.slice().sort((x, y) => (y.vip - x.vip) || (y.hit - x.hit) || (sortOn ? (x.gs - y.gs) || (x.g < y.g ? -1 : x.g > y.g ? 1 : 0) || ((y.ver ?? -1) - (x.ver ?? -1)) || (x.gf - y.gf) || (x.fam - y.fam) || (y.tier - x.tier) || (x.sc - y.sc) || (x.nt < y.nt ? 1 : x.nt > y.nt ? -1 : 0) : 0) || (x.i - y.i));
        // Strength shading: the strongest pinned card gets 50% of the selected card's colour depth, the rest fade evenly.
        // 平铺时（多个日期分组合成一列）按整列的最终顺序算深浅，否则每个分组各自从最深开始，跨分组时忽深忽浅
        const pool = flatPinned || sorted, hits = pool.filter(r => r.hit && !r.vip), vips = pool.filter(r => r.vip);
        const tint = (arr, r) => { const n = arr.length, k = arr.indexOf(r); return k < 0 ? '' : (50 * (n - k) / n).toFixed(1) + '%'; };
        sorted.forEach((r, rank) => {
          if (P) {} else if (sortable && pinned) r.item.style.order = String(rank); else r.item.style.removeProperty('order');
          const tv = r.vip ? tint(vips, r) : r.hit ? tint(hits, r) : ''; if (tv) r.a.style.setProperty('--amp-tint', tv); else r.a.style.removeProperty('--amp-tint');
          r.a.toggleAttribute('data-amp-target-hit', r.hit && !r.vip); r.a.toggleAttribute('data-amp-vip', r.vip);
          // Every conversation whose vendor is known (title keyword or local cache) shows that vendor's logo.
          logo(r.a, r.vid); if (r.vid) r.a.setAttribute('data-amp-brand', r.vid); else r.a.removeAttribute('data-amp-brand');
          next.add(r.item); next.add(r.a); lastRows.push(r);
        });
      }
      for (const el of touched) if (!next.has(el) && el.isConnected) clear(el);
      touched = next;
      // v1.11.78 目标模型卡片的时间小字（最新的一张加深）
      { ctCss(); const rows = [...groups.values()].flat(), pins = rows.filter(r => (r.vip || r.hit) && r.at), newest = pins.length > 1 ? Math.max(...pins.map(r => r.at)) : null, nextCt = new Set();
        for (const r of rows) { r.ct = ''; r.cnew = false; if (!((r.vip || r.hit) && r.at)) continue; const el = ctEl(r.a); if (!el) continue; r.ct = ctFmt(r.at); r.cnew = r.at === newest; ctPut(el, r.ct, r.cnew); nextCt.add(el); }
        for (const el of ctSet) if (!nextCt.has(el)) ctOff(el); ctSet = nextCt; }
    }
    // 旧对话后台逐页加载：把侧栏底部的“加载更多”转圈临时贴在可视区底部（sticky），触发 Arena 自己的无限滚动拉下一页；
    // 每页加载完先取消，隔一会儿再贴，逐页慢慢拉，不滚动、不抢焦点，不影响其他操作。
    const older = { at: 0, n: 0, pages: 0, el: null };
    function olderStep() {
      if (!document.getElementById('amp-older-css') && document.head) { const st = document.createElement('style'); st.id = 'amp-older-css'; st.textContent = '[data-amp-older]{position:sticky!important;bottom:0!important;z-index:2;opacity:.5;pointer-events:none}[data-amp-flat]{display:contents!important}[data-amp-flatp]{display:flex!important;flex-direction:column!important;row-gap:0!important;gap:0!important}'; document.head.append(st); }
      const sortOn = (() => { try { return gacha.settings().sortSidebar; } catch { return false; } })();
      const sp = [...document.querySelectorAll('aside svg.animate-spin,nav svg.animate-spin,[data-sidebar] svg.animate-spin')].map(v => v.parentElement).find(d => d && d.classList.contains('justify-center') && d.classList.contains('pb-4'));
      if (older.el && older.el !== sp) { older.el.removeAttribute('data-amp-older'); older.el = null; }
      if (!sp || !sortOn || document.hidden || older.pages >= 60) return;
      const n = document.querySelectorAll('aside a[href^="/agent/"],nav a[href^="/agent/"],[data-sidebar] a[href^="/agent/"]').length;
      if (sp.hasAttribute('data-amp-older')) {
        // 新的一页到了（或等太久）就先放开，下一轮再贴
        if (n > older.n || Date.now() - older.at > 8000) { sp.removeAttribute('data-amp-older'); older.el = null; if (n > older.n) older.pages++; older.at = Date.now(); }
        return;
      }
      if (Date.now() - older.at < 1200) return;
      sp.setAttribute('data-amp-older', ''); older.el = sp; older.n = n; older.at = Date.now();
    }
    setInterval(() => { try { olderStep(); } catch {} }, 700);
    return { sync, reset: () => { unflat(); for (const el of touched) if (el.isConnected) clear(el); touched = new Set(); for (const el of ctSet) ctOff(el); ctSet = new Set(); stamp = ''; lastRows = []; } };
  })();
  const ICON_PATH = {"openai": "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z", "anthropic": "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z", "google": "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81", "xai": "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"};
  // Vendors outside the five targets get a coloured monogram badge (logo only; not selectable as a target).
  const BADGE = { deepseek: ['#4d6bfe', 'D'], qwen: ['#615ced', 'Q'], zhipu: ['#3859ff', 'Z'], xiaomi: ['#ff6900', 'Mi'], bytedance: ['#1e6fff', '豆'], minimax: ['#e73562', 'M'], mistral: ['#fa520f', 'M'], meta: ['#0467df', '∞'] };
  const badge = (id, size) => { const [bg, t] = BADGE[id]; return '<svg class="gpVIcon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="' + bg + '"/><text x="12" y="12" dy=".36em" text-anchor="middle" font-size="' + (t.length > 1 ? 10 : 13) + '" font-weight="700" font-family="system-ui,-apple-system,Segoe UI,sans-serif" fill="#fff">' + t + '</text></svg>'; };
  const vendorIcon = (id, size = 14) => BADGE[id] ? badge(id, size) : ICON_PATH[id] ? '<svg class="gpVIcon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="' + ICON_PATH[id] + '"/></svg>'
    : id === 'moonshot' ? '<svg class="gpVIcon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 3h3.6v7.6L14.2 3h4.5l-7.1 7.9L19.4 21h-4.6l-5.8-7.6-1.4 1.5V21H4z"/><circle cx="20.5" cy="3.5" r="1.8" fill="#2f6fed"/></svg>'
    : '<svg class="gpVIcon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M8 12h8"/></svg>';
  let mounted = false;
  function mount() {
    if (mounted || !document.body || location.hostname !== 'arena.ai') return; mounted = true;
    const host = document.createElement('div'); host.id = 'amp-native-gacha-host';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>:host{all:initial}' + CSS + '.panel{display:none;position:fixed;pointer-events:auto;max-height:calc(100dvh - 24px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}.gachaPopover .choices,.gachaPopover .gpMenu{overflow:visible!important;overflow-x:visible!important;max-height:none!important}.panel.open{display:block}.launcher{display:none;position:fixed;pointer-events:auto;border:1px solid #8884;border-radius:8px;background:#fff;color:#333;height:32px;box-sizing:border-box;padding:0 8px;font:12px system-ui;align-items:center;justify-content:center;gap:5px;cursor:pointer}.launcher.show{display:inline-flex}.gpLog{margin:8px 0 0;max-height:132px;overflow:auto;font-size:11px;color:var(--gp-muted);line-height:1.5;border-top:1px solid var(--gp-line);padding-top:6px}.gpLog div{display:flex;gap:6px;white-space:nowrap}.gpLog time{flex:none;font-variant-numeric:tabular-nums;opacity:.8}.gpLog span{overflow:hidden;text-overflow:ellipsis}.gpLog [data-v=hit]{color:var(--gp-fg);font-weight:600}.gpLog [data-v=warn],.gpLog [data-v=error]{color:var(--gp-danger)}.gpOptRow{display:flex;align-items:center;gap:2px}.gpOptRow .gpOption{flex:1;min-width:0}.gpDel{width:26px;height:26px;flex:0 0 26px;border-radius:7px;color:var(--gp-muted);font-size:15px}.choices{max-height:320px!important}.gpAdd{display:flex;gap:6px;margin:6px 2px 2px}.gpAdd input{flex:1}.gpAdd .gpSecondary{flex:none}'
      // ---- compact v1.4 card: ~224px, one header row + one slider row; secondary panels collapsed by default ----
      + '.gachaPopover{width:224px;padding:8px;border-radius:14px}.gachaPopover .gpHeader{gap:2px}.gachaPopover .gpIcon{width:26px;height:26px;flex-basis:26px}'
      + '.gachaPopover .gpChosen{align-items:center;padding:2px 4px;line-height:1.2}.gachaPopover .gpChosen .gpCount{font-size:12px;font-weight:600;color:var(--amp-acc,#2f6fed);font-variant-numeric:tabular-nums;max-width:100%}.gachaPopover[data-theme=dark] .gpChosen .gpCount{color:var(--amp-acc-soft,#6ea0ff)}'
      + '.gachaPopover .gpChosen .gpName{font-size:12px;font-weight:500;color:var(--gp-fg)}.gachaPopover .gpQuantity{display:flex;align-items:center;gap:6px;margin:7px 0 0}.gachaPopover .gpRange{flex:1;height:24px}'
      + '.gachaPopover .gpRange{background:linear-gradient(to right,var(--amp-acc,#2f6fed) 0%,var(--amp-acc,#2f6fed) var(--gp-fill,75%),var(--gp-track) var(--gp-fill,75%),var(--gp-track) 100%)}.gachaPopover .gpRange input{height:24px}.gachaPopover .gpRange input::-webkit-slider-runnable-track{height:24px}'
      + '.gachaPopover .gpRange input::-webkit-slider-thumb{width:24px;height:24px}.gachaPopover .gpRange input::-moz-range-thumb{width:23px;height:23px}.gachaPopover .gpDots i{background:#fff;opacity:.55}'
      + '.gachaPopover .gpGo{flex:none;min-width:56px;height:24px;min-height:24px;padding:0 10px;border-radius:12px;font-size:11px;font-weight:700;letter-spacing:.06em}'
      + '.gachaPopover .gpGo[data-a=start]{background:#6a5e54;color:#fff}.gachaPopover .gpGo[data-a=start]:hover{background:#5b5048}.gachaPopover .gpGo[data-a=stop]{background:var(--gp-danger);color:#fff}.gachaPopover .gpStatus{margin-top:6px;gap:5px}.gachaPopover .gpStatus span:first-child{flex:none}.gachaPopover .gpStatus .gpReset{margin-left:auto;font-size:10px;color:var(--gp-muted);padding:0 4px;border-radius:5px}'
      + '.gachaPopover .gpIp{display:block;margin:7px 0 0;border:0;border-radius:8px;padding:6px 14px;background:#6a5e54;color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer}.gachaPopover .gpIp:hover{background:#5b5048}.gachaPopover .gpIp[disabled]{opacity:.6;cursor:wait}.gachaPopover .gpIp[hidden]{display:none}'
      + '.gachaPopover .gpMessage{margin:6px 0 0;font-size:11px;line-height:1.45;color:var(--gp-muted)}.gachaPopover .gpMessage[data-error=true]{color:var(--gp-danger)}.gachaPopover .gpSettings{margin-top:8px;padding-top:8px}.gachaPopover label{margin-bottom:8px}.gachaPopover textarea{min-height:52px}.gachaPopover .gpModelsInput{min-height:84px}'
      + '.gachaPopover .gpMenu{margin:6px -3px 0}.gachaPopover .gpOption{min-height:30px;padding:5px 8px;justify-content:flex-start;gap:8px}.gachaPopover .gpOption .gpMark{margin-left:auto;color:var(--amp-acc,#2f6fed)}.gachaPopover .gpName{display:inline-flex;align-items:center;gap:4px;max-width:100%;overflow:hidden}.gachaPopover .gpChosen span.gpName{display:inline-flex;align-items:center;justify-content:center;gap:4px}.gachaPopover .gpChosen .gpName span{display:inline-flex;align-items:center;max-width:none}'
      + '.gachaPopover .gpRow2{display:grid;grid-template-columns:1fr 72px;gap:6px}.gachaPopover .gpSaveRow{display:flex;justify-content:flex-end}.gachaPopover .gpSecondary{padding:4px 10px;font-size:11px}.gachaPopover .gpHead{font-size:12px;color:var(--gp-fg);margin-bottom:6px}.gachaPopover .gpModelsInput{min-height:72px;margin-bottom:6px}.gachaPopover .choices{display:grid;grid-template-columns:1fr 1fr;gap:4px}.gachaPopover .choices .gpOption{border:1px solid var(--gp-line);border-radius:9px;transition:background .15s,color .15s,border-color .15s}.gachaPopover .choices .gpOption[data-on=true]{background:var(--amp-acc,#2f6fed);border-color:var(--amp-acc,#2f6fed);color:var(--amp-acc-fg,#fff)}.gachaPopover .choices .gpOption[data-on=true]:hover{background:color-mix(in srgb,var(--amp-acc,#2f6fed) 86%,#000)}'
      + '.gachaPopover .gpCustom{display:flex;align-items:center;min-height:30px;border:1px solid var(--gp-line);border-radius:9px;overflow:hidden;background:var(--gp-field)}.gachaPopover .gpCustom[data-on=true]{border-color:var(--amp-acc,#2f6fed);background:var(--amp-acc,#2f6fed)}.gachaPopover .gpCustom input{flex:1;min-width:0;width:100%;height:28px;border:0;outline:0;background:transparent;padding:0 6px;font:inherit;font-size:12px;color:var(--gp-fg);box-shadow:none}.gachaPopover .gpCustom[data-on=true] input{color:var(--amp-acc-fg,#fff);font-weight:600}.gachaPopover .gpCustom input::placeholder{color:var(--gp-muted);font-weight:400}.gachaPopover .gpCustomGo{flex:none;width:24px;height:28px;font-size:12px;color:var(--gp-muted);border-radius:0}.gachaPopover .gpCustom[data-on=true] .gpCustomGo{color:var(--amp-acc-fg,#fff)}'
      + '.gachaPopover .gpChips{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 6px;max-height:132px;overflow:auto}.gachaPopover .gpChip{padding:1px 7px;min-height:20px;border:1px solid var(--gp-line);border-radius:10px;font-size:11px;line-height:17px;background:var(--gp-field);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gachaPopover .gpChip:hover,.gachaPopover .gpChip[data-pending=true]{border-color:var(--gp-danger);color:var(--gp-danger);background:transparent}.gachaPopover .gpChipEmpty{font-size:11px;color:var(--gp-muted)}'
      + '.gachaPopover .gpConfirm{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:0 0 6px;padding:6px 8px;border:1px solid var(--gp-danger);border-radius:9px;font-size:11px}.gachaPopover .gpConfirm span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gachaPopover .gpConfirm div{display:flex;gap:4px;flex:none}.gachaPopover .gpDanger{background:var(--gp-danger)!important;color:#fff!important;border-color:var(--gp-danger)!important}'
      + '.gachaPopover .gpAddRow{display:flex;gap:4px;align-items:flex-end}.gachaPopover .gpModelsInput.gpAddInput{flex:1;min-height:28px!important;height:28px;margin:0!important;resize:none;overflow:hidden;scrollbar-width:none;padding:5px 7px;font-size:12px;line-height:16px}.gachaPopover .gpAddRow .gpSecondary{flex:none;height:28px}@media (max-width:480px){.gachaPopover{width:208px}}'
      + '@keyframes gpIn{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}.panel.open{animation:gpIn .2s cubic-bezier(.22,.9,.3,1);transform-origin:bottom right}'
      + '.gachaPopover .gpGo,.gachaPopover .choices .gpOption,.gachaPopover .gpChip,.gachaPopover .gpIcon,.gachaPopover .gpChosen,.launcher{transition:transform .5s cubic-bezier(.22,.9,.3,1),background .15s,color .15s,border-color .15s}'
      + '.gachaPopover .gpGo:not(:disabled):hover,.gachaPopover .choices .gpOption:not(:disabled):hover,.gachaPopover .gpChip:not(:disabled):hover,.gachaPopover .gpIcon:hover,.launcher:hover{transform:scale(1.07);transition:transform .28s cubic-bezier(.34,1.8,.5,1),background .15s,color .15s,border-color .15s}'
      + '.gachaPopover .gpGo:not(:disabled):active,.gachaPopover .choices .gpOption:not(:disabled):active,.gachaPopover .gpChip:not(:disabled):active,.gachaPopover .gpIcon:active{transform:scale(.94);transition-duration:.08s}'
      + '.gachaPopover .gpCustom{transition:border-color .15s,box-shadow .15s,background .15s}.gachaPopover .gpCustom:hover,.gachaPopover .gpCustom:focus-within{border-color:var(--amp-acc,#2f6fed);box-shadow:0 0 0 2px color-mix(in srgb,var(--amp-acc,#2f6fed) 22%,transparent)}.gachaPopover .gpCustom input{overflow:hidden}'
      + '.gachaPopover .gpChip{animation:gpIn .22s ease-out both}.gachaPopover .choices .gpOption[data-on=true]{box-shadow:0 2px 10px color-mix(in srgb,var(--amp-acc,#2f6fed) 35%,transparent)}'
      + '@media (prefers-reduced-motion:reduce){.panel.open,.gachaPopover *{animation:none!important;transition:none!important;transform:none!important}}</style>'
      + '<button class="launcher" type="button" aria-label="抽卡设置">' + slotIcon + '<span class="launcherProgress"></span></button><section class="gachaPopover panel" role="dialog" aria-label="抽卡设置"></section>';
    const panel = root.querySelector('.panel'), launcher = root.querySelector('.launcher');
    panel.innerHTML = '<div class="gpHeader"><button type="button" class="gpIcon" data-ui="models" title="归档设置" aria-label="归档设置">' + gear + '</button><button type="button" class="gpChosen" data-ui="choose" aria-label="选择目标模型" aria-haspopup="menu"><span class="gpCount" data-s="count">20张</span><span class="gpName"><span data-s="vicon"></span><span data-s="chosen">不限</span></span></button><button type="button" class="gpIcon gpTextIcon" data-ui="text" title="提示词与选项" aria-label="提示词与选项">T</button></div>'
      + '<div class="gpMenu choices" role="menu" aria-label="选择目标模型" hidden></div>'
      + '<div class="gpSettings modelEditor" hidden><label class="gpCheck gpHead"><input type="checkbox" data-k="archiveOn">归档黑名单</label><div class="gpChips" data-s="chips"></div><div class="gpConfirm" data-s="confirm" hidden><span data-s="confirmText"></span><div><button type="button" class="gpSecondary" data-ui="confirmNo">取消</button><button type="button" class="gpSecondary gpDanger" data-ui="confirmYes">删除</button></div></div><div class="gpAddRow"><textarea class="gpModelsInput gpAddInput" data-ui="archiveLines" rows="1" placeholder="输入关键词，换行可一次添加多个"></textarea><button type="button" class="gpSecondary" data-ui="saveModels">添加</button></div></div>'
      + '<div class="gpSettings advanced" hidden><div class="gpRow2"><label>提示词<input data-k="prompt" maxlength="4000"></label><label>间隔 秒<input data-k="intervalSec" type="number" min="0" max="60" step=".1"></label></div><label class="gpCheck"><input data-k="stopOnThinking" type="checkbox">路由到 Thinking 时停止</label><label class="gpCheck"><input data-k="sortSidebar" type="checkbox">左侧按实时排名排序</label><div class="gpSaveRow"><button type="button" class="gpSecondary" data-ui="saveText">保存</button></div><div class="gpLog" data-s="log" hidden></div></div>'
      + '<div class="gpQuantity"><div class="gpRange"><div class="gpDots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><input type="range" min="0" max="4" step="1" aria-label="抽卡张数" data-ui="quantity"></div><button type="button" class="gpPrimary gpGo" data-a="start">START</button><button type="button" class="gpPrimary gpGo" data-a="stop" hidden>STOP</button></div>'
      + '<div class="gpStatus" role="status" hidden><span data-s="status"></span><span data-s="model"></span><button type="button" class="gpReset" data-a="reset" hidden>清除</button></div><p class="gpMessage" data-s="reason" role="status" hidden></p><button type="button" class="gpIp" data-a="ipok" hidden>我已更换 IP</button>';
    document.body.append(host);
    const $ = s => root.querySelector(s), field = k => $('[data-k="' + k + '"]'), text = (k, v) => { const e = $('[data-s="' + k + '"]'); if (e) e.textContent = v; };
    let anchor = null, lastAnchorRect = null, priorFocus = null, section = null, archiveConfirm = false, message = '', messageError = false, busy = false, graceT = 0;
    const visible = el => el instanceof HTMLElement && el.isConnected && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden';
    const media = matchMedia('(prefers-color-scheme: dark)');
    let theme = 'light';
    const applyTheme = () => {
      const el = document.documentElement, explicit = el.dataset.theme;
      const dark = explicit === 'dark' || (explicit !== 'light' && (el.classList.contains('dark') || (!el.classList.contains('light') && (getComputedStyle(el).colorScheme === 'dark' || (getComputedStyle(el).colorScheme !== 'light' && media.matches)))));
      theme = dark ? 'dark' : 'light'; root.querySelectorAll('.gachaPopover').forEach(n => n.dataset.theme = theme);
      el.toggleAttribute('data-amp-dark', dark); el.setAttribute('data-amp-tone', gacha.settings().earthTone ? 'earth' : 'blue');
      const bg = composerBg(dark), pop = root.querySelector('.gachaPopover');
      if (pop) { pop.style.setProperty('--gp-bg', bg);
        if (dark) { pop.style.setProperty('--gp-fg', '#ecebe7'); pop.style.setProperty('--gp-muted', '#a9a59d'); pop.style.setProperty('--gp-line', 'color-mix(in srgb,' + bg + ',#fff 12%)'); pop.style.setProperty('--gp-hover', 'color-mix(in srgb,' + bg + ',#fff 7%)'); pop.style.setProperty('--gp-field', 'color-mix(in srgb,' + bg + ',#000 18%)'); pop.style.setProperty('--gp-track', 'color-mix(in srgb,' + bg + ',#fff 14%)'); }
        else for (const k of ['--gp-fg', '--gp-muted', '--gp-line', '--gp-hover', '--gp-field', '--gp-track']) pop.style.removeProperty(k); }
      launcher.style.background = bg; launcher.style.color = dark ? '#ecebe7' : '#242936';
    };
    // Colour of the native prompt box (walk up from the editor to the first opaque background).
    function composerBg(dark) {
      const ed = document.querySelector('form [contenteditable="true"],form textarea,[contenteditable="true"]');
      for (let n = ed; n && n !== document.body; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; const m = c.match(/rgba?\(([^)]+)\)/); if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); if (p.length < 4 || p[3] > 0.5) return c; } }
      return dark ? '#2c2b28' : '#fff';
    }
    applyTheme(); setInterval(applyTheme, 3000); window.addEventListener('amp-native-gacha', applyTheme); new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] }); media.addEventListener?.('change', applyTheme);
    const position = () => {
      if (!panel.classList.contains('open')) return;
      const vv = window.visualViewport, width = vv?.width || innerWidth, height = vv?.height || innerHeight;
      const r = anchor?.isConnected && visible(anchor) ? anchor.getBoundingClientRect() : lastAnchorRect;
      if (!r) { close(); return; }
      panel.style.width = Math.min(256, width - 24) + 'px'; panel.style.maxHeight = Math.max(120, height - 24) + 'px';
      const box = panel.getBoundingClientRect();
      panel.style.left = Math.max(12, Math.min(r.right - box.width, width - box.width - 12)) + 'px';
      const above = r.top - box.height - 8;
      panel.style.top = Math.max(12, Math.min(above >= 12 ? above : r.bottom + 8, height - box.height - 12)) + 'px';
    };
    try { new ResizeObserver(position).observe(panel); } catch {}
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true); window.visualViewport?.addEventListener('resize', position);
    const close = () => { if (!panel.classList.contains('open')) return; panel.classList.remove('open'); anchor?.setAttribute('aria-expanded', 'false'); collapse(); if (priorFocus?.isConnected) priorFocus.focus?.(); };
    const sections = { choose: '.choices', models: '.modelEditor', text: '.advanced' };
    const show = next => {
      section = section === next ? null : next;
      for (const [name, sel] of Object.entries(sections)) { $(sel).hidden = name !== section; $('[data-ui="' + name + '"]').setAttribute('aria-expanded', String(name === section)); }
      if (section === 'models') { const s = gacha.settings(); $('[data-ui="archiveLines"]').value = ''; field('archiveOn').checked = s.archiveOn; pendingDel = null; chips(); }
      position();
    };
    // Every open starts from the plain first-level card: all secondary panels collapsed.
    const collapse = () => { section = null; for (const [name, sel] of Object.entries(sections)) { $(sel).hidden = true; $('[data-ui="' + name + '"]').setAttribute('aria-expanded', 'false'); } };
    const say = (m, error = false) => { message = m; messageError = error; render(); };
    let pendingDel = null;
    function chips() {
      const s = gacha.settings(), box = $('[data-s="chips"]'), locked = gacha.running(); box.replaceChildren();
      for (const k of s.archiveKeywords) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'gpChip'; b.textContent = k; b.title = '点击删除“' + k + '”'; b.disabled = locked; b.dataset.pending = String(pendingDel === k);
        b.onclick = () => { pendingDel = k; chips(); };
        box.append(b);
      }
      if (!s.archiveKeywords.length) { const e = document.createElement('span'); e.className = 'gpChipEmpty'; e.textContent = '黑名单为空'; box.append(e); }
      const c = $('[data-s="confirm"]'); c.hidden = !pendingDel; if (pendingDel) text('confirmText', '删除“' + pendingDel + '”？');
      position();
    }
    function load() {
      const s = gacha.settings();
      field('prompt').value = s.prompt; field('intervalSec').value = String(s.intervalMs / 1000);
      field('stopOnThinking').checked = s.stopOnThinking; field('sortSidebar').checked = s.sortSidebar; field('archiveOn').checked = s.archiveOn;
    }
    // Second level of the vendor picker: GPT / Claude / Gemini / Grok / Kimi + custom keyword (2 columns × 3 rows).
    // Click lights a target, click again turns it off (= 不限).
    function choices() {
      const s = gacha.settings(), box = $('.choices'), locked = gacha.running(); box.replaceChildren();
      for (const v of gacha.VENDORS) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'gpOption'; b.setAttribute('role', 'menuitemcheckbox');
        const on = v.id === s.vendor; b.setAttribute('aria-checked', String(on)); b.dataset.on = String(on); b.title = v.lab + ' · 名称含 ' + v.kw.join('/') + (on ? ' · 再次点击取消' : '');
        b.innerHTML = vendorIcon(v.id, 15) + '<span></span>'; b.children[1].textContent = v.name;
        b.disabled = locked; b.onclick = () => { gacha.setVendor(on ? '' : v.id); choices(); render(); };
        box.append(b);
      }
      const wrap = document.createElement('div'); wrap.className = 'gpCustom'; const on = s.vendor === 'custom'; wrap.dataset.on = String(on);
      const inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 60; inp.placeholder = '自定义关键词'; inp.value = s.customKeyword || ''; inp.disabled = locked; inp.setAttribute('aria-label', '自定义目标关键词（回车确认）');
      const go = document.createElement('button'); go.type = 'button'; go.className = 'gpCustomGo'; go.disabled = locked; go.textContent = on ? '✓' : '↵'; go.title = on ? '点击取消自定义关键词' : '启用自定义关键词';
      const apply = toggle => { const k = inp.value.trim(); if (!k) { gacha.setVendor(''); } else if (toggle && on && k === s.customKeyword) gacha.setVendor(''); else gacha.setVendor('custom', k); choices(); render(); };
      inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); apply(true); } };
      go.onclick = () => apply(true);
      wrap.append(inp, go); box.append(wrap);
    }
    const clock = t => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
    let logStamp = '';
    function render() {
      const s = gacha.settings(), st = gacha.state(), active = gacha.running();
      const idx = Math.max(0, Q.indexOf(active ? st.settings.maxAttempts : s.maxAttempts));
      const slider = $('[data-ui="quantity"]'); slider.value = String(idx); slider.setAttribute('aria-valuetext', Q[idx] + ' 次'); $('.gpRange').style.setProperty('--gp-fill', 'calc(12px + (100% - 24px) * ' + idx / 4 + ')');
      text('count', Q[idx] + '张');
      const cfg = active ? st.settings : s, vend = gacha.VENDORS.find(v => v.id === cfg.vendor);
      const customOn = cfg.vendor === 'custom' && cfg.customKeyword;
      text('chosen', vend ? vend.name : customOn ? cfg.customKeyword : '不限'); const vi = $('[data-s="vicon"]'), vk = vend ? vend.id : ''; if (vi.dataset.v !== vk) { vi.dataset.v = vk; vi.innerHTML = vend ? vendorIcon(vend.id, 13) : ''; }
      root.querySelectorAll('[data-k]:not([data-k="sortSidebar"]):not([data-k="stopOnThinking"]):not([data-k="earthTone"]),[data-ui="quantity"],[data-ui="archiveLines"],[data-ui="saveModels"],[data-ui="saveText"],.gpChip,[data-ui="confirmYes"]').forEach(n => n.disabled = active || busy);
      const start = $('[data-a="start"]'), stop = $('[data-a="stop"]'), reset = $('[data-a="reset"]');
      { const ipb = $('[data-a="ipok"]'); if (ipb) { const on = !active && gacha.ipLimited(); ipb.hidden = !on; if (!on) { ipb.disabled = false; ipb.textContent = '我已更换 IP'; } } }
      start.hidden = active; stop.hidden = !active; stop.disabled = st?.status === 'stopping'; reset.hidden = active || !st;
      start.textContent = 'START'; start.title = '开始抽卡（每次都从 0 开始）';
      const total = st ? st.settings.maxAttempts : s.maxAttempts, done = st?.completed || 0;
      if (active) text('count', done + ' / ' + total + '张');
      const statusLabel = !st ? '' : active ? (st.status === 'stopping' ? '正在停止' : st.phase || '抽卡中') : ({ paused: '已停止', stopped: '已停止', hit: '已命中目标', done: '已完成' }[st.status] || st.status);
      text('status', statusLabel + (st && !active && ['paused', 'stopped'].includes(st.status) ? ' · ' + done + '/' + total : ''));
      const lastModel = st?.attempts?.filter(a => a.model).at(-1)?.model || ''; text('model', lastModel ? ' · ' + lastModel : '');
      $('.gpStatus').hidden = !st || (!active && !st.status);
      const reason = message || (st && !active && st.reason ? st.reason : '');
      const box = $('[data-s="reason"]'); box.textContent = reason; box.hidden = !reason; box.dataset.error = String(messageError || (['paused', 'stopped'].includes(st?.status) && !!st.code && st.code !== 'RELOADED' && !message));
      const logBox = $('[data-s="log"]'), rows = (st?.attempts || []).slice(-30).reverse(), key = JSON.stringify(rows.map(a => [a.no, a.verdict, a.model, a.archived, a.note]));
      logBox.hidden = !rows.length;
      if (key !== logStamp) {
        logStamp = key; logBox.replaceChildren(...rows.map(a => { const d = document.createElement('div'), t = document.createElement('time'), sp = document.createElement('span');
          t.textContent = clock(a.at); sp.textContent = (a.draw ? '#' + a.draw + ' ' : a.done ? '' : '#' + Math.min(total, done + 1) + ' ') + (a.model || '') + (a.tier ? ' · ' + a.tier : '') + ' ' + ({ hit: '命中', keep: '保留', archive: a.archived ? '已归档' : '待归档', other: '保留', skipped: '未完成·不计数', error: '中断', cancelled: '取消', abandoned: '中断' }[a.verdict] || '进行中') + (a.resends ? ' · 重发 ' + a.resends : '') + (a.note ? ' · ' + a.note : '');
          d.dataset.v = a.verdict === 'hit' ? 'hit' : ['skipped', 'error'].includes(a.verdict) ? 'warn' : ''; d.title = sp.textContent; d.append(t, sp); return d; }));
      }
      const name = vend ? vend.name : customOn ? cfg.customKeyword : '不限', tgt = vend ? vend.id : customOn ? 'custom' : '';
      for (const b of document.querySelectorAll('[data-amp-native-gacha="1"]')) {
        b.title = active ? '抽卡中 ' + done + '/' + total + (st.phase ? ' · ' + st.phase : '') + ' · 点击查看' : ['paused', 'stopped'].includes(st?.status) ? '抽卡已停止 · ' + (st.reason || '') : '目标模型：' + name + ' · 点击设置并抽卡';
        b.setAttribute('aria-label', active ? '抽卡进度 ' + done + '/' + total + '，目标 ' + name : '抽卡，目标模型 ' + name);
        b.dataset.running = String(active); b.toggleAttribute('data-empty', !tgt);
        const n = b.querySelector('[data-amp-name]'); if (n && n.textContent !== name) n.textContent = name;
        const ico = b.querySelector('[data-amp-icon]'); if (ico && ico.dataset.v !== tgt) { ico.dataset.v = tgt; ico.innerHTML = vend ? vendorIcon(vend.id, 14) : ''; ico.hidden = !vend; }
        b.toggleAttribute('data-empty', !tgt);
        const lab = b.querySelector('[data-amp-progress]'); if (lab) { lab.hidden = !active; lab.textContent = done + '/' + total; }
        const bar = b.querySelector('[data-amp-progress-bar]'); if (bar) { bar.hidden = !active; bar.style.width = (total ? Math.min(100, done / total * 100) : 0) + '%'; }
        const dot = b.querySelector('[data-amp-dot]'); if (dot) dot.hidden = active || !(['paused', 'stopped'].includes(st?.status) && st.code && !['RELOADED', 'CANCEL'].includes(st.code));
        if (!b.querySelector('[data-amp-ring]')) b.insertAdjacentHTML('beforeend', '<i data-amp-ring aria-hidden="true"></i><span data-amp-land aria-hidden="true"></span>');
        b.style.setProperty('--amp-p', String(total ? Math.round(Math.min(100, done / total * 100)) : 0)); spinLand(b, st, active);
      }
      sidebar.sync(cfg.targetKeywords);
      launcher.querySelector('.launcherProgress').textContent = active ? done + '/' + total : '';
      position();
    }
    // v1.11.70 抽卡“波轮”（手机端 Gemini 布局）：按钮保持圆形，抽卡时厂商图标像洗衣机波轮一样来回转，外圈圆环显示进度；
    // 每出一张（这一抽有了结论）就停一下、亮出抽到的厂商 1.3 秒，命中时外圈变绿；整轮命中目标结束时再闪一圈绿光。
    function spinLand(b, st, active) {
      const last = (st?.attempts || []).filter(a => a && a.model && a.verdict).at(-1), key = last ? (st.id || '') + ':' + last.no + ':' + last.verdict : '';
      if (!active) {
        if (b._ampSpin && st?.status === 'hit') { b.setAttribute('data-hit', ''); clearTimeout(b._ampHitT); b._ampHitT = setTimeout(() => b.removeAttribute('data-hit'), 1600); }
        b._ampSpin = false; clearTimeout(b._ampLandT); b.removeAttribute('data-landed'); return;
      }
      // 刚转起来（新开一轮 / 暂停后继续 / 刷新页面）：之前已有的结果不再闪，只亮之后新出的
      if (!b._ampSpin) { b._ampSpin = true; b._ampLand = key; return; }
      if (!last || key === b._ampLand) return;
      // v1.11.79 老虎机还在依次停这一抽：波轮先不亮出抽到的厂商 / 命中绿圈，等三格都停下（每停一格都会重绘到这里）
      if ((() => { try { return !!gachaSlot.view(last.sid); } catch { return false; } })()) return;
      b._ampLand = key;
      const land = b.querySelector('[data-amp-land]'), vid = brand.of(last.model) || '';
      if (land) land.innerHTML = vid ? vendorIcon(vid, 19) : '<b>' + (String(last.model).trim().charAt(0).toUpperCase() || '?') + '</b>';
      b.setAttribute('data-landed', last.verdict === 'hit' ? 'hit' : 'miss'); b.dataset.landModel = String(last.model).slice(0, 80);
      clearTimeout(b._ampLandT); b._ampLandT = setTimeout(() => b.removeAttribute('data-landed'), 1300);
    }
    try { CSS.registerProperty({ name: '--amp-p', syntax: '<number>', inherits: true, initialValue: '0' }); } catch {}
    const nativeStyle = document.createElement('style');
    nativeStyle.textContent = '[data-amp-native-gacha="1"]{position:relative;display:inline-flex!important;align-items:center;justify-content:center;gap:4px;height:32px!important;width:auto!important;max-width:220px;padding:0 8px!important;border:0;border-radius:8px!important;background:transparent;color:inherit;font-size:13px;font-weight:400;line-height:1.25;font-family:inherit;white-space:nowrap;overflow:hidden;cursor:pointer;flex-shrink:0;transition:background .12s ease}'
      + '[data-amp-native-gacha="1"]:hover{background:color-mix(in srgb,currentColor 9%,transparent)!important}[data-amp-native-gacha="1"]:focus-visible{outline:2px solid currentColor;outline-offset:2px}'
      + '[data-amp-native-gacha="1"] [data-amp-icon]{display:inline-flex;flex:none}[data-amp-native-gacha="1"] [data-amp-icon][hidden]{display:none}[data-amp-native-gacha="1"] [data-amp-name]{overflow:hidden;text-overflow:ellipsis;min-width:0}[data-amp-native-gacha="1"][data-empty] [data-amp-name]{opacity:.7}'
      + '[data-amp-native-gacha="1"] [data-amp-chev]{flex:none;opacity:.6}[data-amp-native-gacha="1"][data-running="true"] [data-amp-chev]{display:none}'
      + '[data-amp-progress]{font:11px system-ui;font-variant-numeric:tabular-nums;opacity:.75;flex:none}[data-amp-progress]::before{content:"· "}'
      + '[data-amp-progress-bar]{position:absolute;bottom:0;left:0;height:2px;background:currentColor;opacity:.6;transition:width .2s}[data-amp-dot]{position:absolute;top:5px;right:3px;width:6px;height:6px;border-radius:50%;background:#e38a1e}'
      + '[data-amp-native-gacha="1"] :is([data-amp-ring],[data-amp-land]){display:none}'
      + 'a[data-amp-target-hit],a[data-amp-vip],a[data-amp-current]{position:relative!important;isolation:isolate;border-radius:8px;transform-origin:left center;transition:transform .6s cubic-bezier(.22,.9,.3,1),background-color .3s ease,color .25s ease,box-shadow .3s ease}'
      + 'a[data-amp-target-hit]{background:color-mix(in srgb,var(--amp-acc,#2f6fed) var(--amp-tint,14%),transparent)!important;box-shadow:inset 3px 0 0 var(--amp-acc,#2f6fed);font-weight:650}'
      + 'a[data-amp-vip]{background:color-mix(in srgb,#d4a017 var(--amp-tint,22%),transparent)!important;box-shadow:inset 3px 0 0 #c9950c;font-weight:700}'
      + 'a[data-amp-target-hit] :is(span,div).truncate,a[data-amp-target-hit] [data-amp-local-title]::after{font-weight:650!important}a[data-amp-vip] :is(span,div).truncate,a[data-amp-vip] [data-amp-local-title]::after,a[data-amp-current][data-amp-done] [data-amp-local-title]::after{font-weight:700!important}'
      /* hover: grow quickly with a small overshoot, shrink back slowly on leave */
      + 'a[data-amp-target-hit],a[data-amp-vip],a[data-amp-current]{transform:scale(var(--amp-mag,1))}html[data-amp-mag-on] a[data-amp-target-hit],html[data-amp-mag-on] a[data-amp-vip],html[data-amp-mag-on] a[data-amp-current]{transition:transform .14s ease-out,background-color .3s ease,color .25s ease,box-shadow .3s ease}'
      + 'a[data-amp-target-hit]:active,a[data-amp-vip]:active,a[data-amp-current]:active{transform:scale(.985);transition-duration:.08s}'
      + '@keyframes ampPinIn{from{opacity:0;transform:translateX(-8px) scale(.98)}to{opacity:1;transform:none}}a[data-amp-target-hit],a[data-amp-vip]{animation:ampPinIn .38s cubic-bezier(.22,.9,.3,1) backwards}'
      /* current conversation: the left bar grows into a solid fill following the load progress */
      + 'a[data-amp-current]{box-shadow:inset 3px 0 0 var(--amp-cur,var(--amp-acc,#2f6fed))!important;overflow:hidden}a[data-amp-current][data-amp-vip]{--amp-cur:#c9950c}'
      + 'a[data-amp-current]::before{content:"";position:absolute;left:0;top:0;bottom:0;width:max(3px,var(--amp-fill,0%));background:var(--amp-cur,var(--amp-acc,#2f6fed));z-index:-1;border-radius:inherit;transition:width .35s cubic-bezier(.22,.9,.3,1);pointer-events:none}'
      + 'a[data-amp-current][data-amp-done]::before{box-shadow:0 2px 10px color-mix(in srgb,var(--amp-cur,var(--amp-acc,#2f6fed)) 45%,transparent)}'
      /* text turns white once the fill passes the text; the renamed-title span keeps its own text transparent (only ::after is visible) — fixes the overlapping names */
      + 'a[data-amp-current][data-amp-ink]{color:var(--amp-cur-fg,var(--amp-acc-fg,#fff))!important}a[data-amp-current][data-amp-ink] :is(span,div,p,svg):not([data-amp-local-title]):not([data-amp-vlogo]):not([data-amp-vlogo] *){color:var(--amp-cur-fg,var(--amp-acc-fg,#fff))!important}a[data-amp-current][data-amp-vip]{--amp-cur-fg:#fff}'
      + 'a[data-amp-current] span[data-amp-local-title][data-amp-local-title],a[data-amp-current] div[data-amp-local-title][data-amp-local-title]{color:transparent!important}a[data-amp-current][data-amp-ink] [data-amp-local-title]::after{color:var(--amp-cur-fg,var(--amp-acc-fg,#fff))!important}'
      + '[data-amp-vlogo]{display:inline-flex!important;align-items:center;justify-content:center;flex:none;width:18px;height:18px;border-radius:50%;background:#fff;color:#111;box-shadow:0 0 0 1px #0000001a;margin-right:6px;animation:ampLogoIn .3s ease-out both}[data-amp-vlogo] svg{width:12px;height:12px}[data-amp-vlogo][data-full]{background:transparent;box-shadow:none}[data-amp-vlogo][data-full] svg{width:18px;height:18px}a[data-amp-vip] [data-amp-vlogo]{box-shadow:0 0 0 1.5px #c9950c}'
      + '@keyframes ampLogoIn{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}'
      + '[data-amp-logo-hidden]{display:none!important}[data-amp-vlogo][data-noanim]{animation:none!important}[data-amp-vlogo]:not([data-full]),[data-amp-vlogo]:not([data-full]) svg{color:#111!important;fill:currentColor}[data-amp-vlogo]~[data-amp-vlogo]{display:none!important}'
      /* slot button next to Send: springy grow on hover (overshoot then settle), slow shrink on leave */
      + '[data-amp-native-gacha="1"]{transition:transform .5s cubic-bezier(.22,.9,.3,1),background .12s ease!important;will-change:transform}[data-amp-native-gacha="1"]:hover{transform:scale(1.07);transition:transform .3s cubic-bezier(.34,1.8,.5,1),background .12s ease!important}[data-amp-native-gacha="1"]:active{transform:scale(.95);transition-duration:.08s!important}'
      + '@media (prefers-reduced-motion:reduce){a[data-amp-target-hit],a[data-amp-vip],a[data-amp-current],[data-amp-native-gacha="1"],[data-amp-vlogo]{animation:none!important;transition:none!important;transform:none!important}}'
      + '';
    // Accent palette. Default = blue. 原色 (earth) mode: light = low-saturation burnt umber, dark = warm off-white matching Arena's greys.
    nativeStyle.textContent += 'html{--amp-acc:#6a5e54;--amp-acc-fg:#fff;--amp-acc-soft:#6a5e54}html[data-amp-dark]{--amp-acc:#d8d3ca;--amp-acc-fg:#262522;--amp-acc-soft:#e4dfd6}html[data-amp-tone=earth]{--amp-acc:#6a5e54;--amp-acc-fg:#fff;--amp-acc-soft:#6a5e54}html[data-amp-tone=earth][data-amp-dark]{--amp-acc:#d8d3ca;--amp-acc-fg:#262522;--amp-acc-soft:#e4dfd6}';
    (document.head || document.body).append(nativeStyle);
    // Dock-style magnification for the pinned sidebar cards: the closer the pointer, the larger the card.
    // Moving: quick follow (.14s). Leaving the sidebar: all cards shrink back slowly (.6s, CSS default transition).
    (() => {
      const SEL_CARD = 'a[data-amp-target-hit],a[data-amp-vip],a[data-amp-current]', MAX = 0.06;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      let raf = 0, last = null, active = new Set();
      const reset = () => { document.documentElement.removeAttribute('data-amp-mag-on'); for (const a of active) a.style.removeProperty('--amp-mag'); active = new Set(); };
      const frame = () => {
        raf = 0; const e = last; if (!e) return;
        const side = e.target?.closest?.('aside,nav,[data-sidebar]'); if (!side) { reset(); return; }
        document.documentElement.setAttribute('data-amp-mag-on', '');
        // 只放大鼠标所在（最近）的卡片和紧挨着的上下各一张，其余卡片完全不动。
        const next = new Set();
        const cards = [...side.querySelectorAll(SEL_CARD)].map(a => ({ a, r: a.getBoundingClientRect() })).filter(x => x.r.height).sort((x, y) => x.r.top - y.r.top);
        const inCol = cards.length && e.clientX >= Math.min(...cards.map(x => x.r.left)) - 12 && e.clientX <= Math.max(...cards.map(x => x.r.right)) + 12;
        let ni = -1, nd = Infinity;
        if (inCol) cards.forEach((x, k) => { const d = Math.abs(e.clientY - (x.r.top + x.r.height / 2)); if (d < nd) { nd = d; ni = k; } });
        if (ni >= 0 && nd > cards[ni].r.height * 1.2) ni = -1; // 离卡片区太远：都不放大
        for (let k = ni - 1; ni >= 0 && k <= ni + 1; k++) {
          const x = cards[k]; if (!x) continue;
          const h = x.r.height, d = Math.abs(e.clientY - (x.r.top + x.r.height / 2)), kk = Math.max(0, 1 - d / (h * 1.6));
          const v = 1 + (k === ni ? MAX : MAX * 0.45) * kk * kk * (3 - 2 * kk);
          if (v > 1.0005) { x.a.style.setProperty('--amp-mag', v.toFixed(4)); next.add(x.a); }
        }
        for (const a of active) if (!next.has(a)) a.style.removeProperty('--amp-mag');
        active = next;
      };
      document.addEventListener('pointermove', e => { if (e.pointerType === 'touch') return; last = e; if (!raf) raf = requestAnimationFrame(frame); }, { passive: true });
      document.addEventListener('pointerleave', reset); window.addEventListener('blur', reset);
      document.addEventListener('pointerout', e => { if (!e.relatedTarget) reset(); }, { passive: true });
    })();
    const toggle = b => {
      if (panel.classList.contains('open')) { close(); return; }
      anchor = b || launcher; priorFocus = document.activeElement; load(); message = ''; collapse(); panel.classList.add('open'); anchor.setAttribute('aria-expanded', 'true'); render(); position(); $('[data-ui="quantity"]').focus({ preventScroll: true });
    };
    const SEL = 'button[aria-label="Send message"],button[aria-label="发送消息"],button[aria-label="Stop generating"],button[aria-label="Stop response"],button[aria-label="停止生成"]';
    // ---------------- 长按厂商按钮：左轮式竖向选择器 ----------------
    // 按住约 0.35 秒（或按住直接上推）弹出一列竖向卡片，像左轮弹巢一样滚动；上下推动切换，松开即选中中间那项。
    const REV_H = 46;
    let revCssOn = false;
    function revCss() {
      if (revCssOn) return; revCssOn = true;
      const st = document.createElement('style'); st.id = 'amp-revolver-css';
      st.textContent = '[data-amp-revolver]{position:fixed;z-index:2147483646;pointer-events:none;width:200px;height:' + (REV_H * 5) + 'px;perspective:520px;opacity:0;transform:translateY(10px) scale(.96);transition:opacity .18s ease,transform .28s cubic-bezier(.22,1,.36,1);font:500 14px/1 var(--font-basel-grotesk,var(--font-inter,system-ui)),"PingFang SC","Microsoft YaHei",sans-serif}'
        + '[data-amp-revolver].on{opacity:1;transform:none}[data-amp-revolver].out{opacity:0;transform:translateY(6px) scale(.97);transition:opacity .22s ease .08s,transform .3s ease .08s}'
        + '[data-amp-revolver] .rv-win{position:absolute;left:-6px;right:-6px;top:50%;height:' + (REV_H + 6) + 'px;margin-top:-' + ((REV_H + 6) / 2) + 'px;border-radius:14px;background:var(--rv-win);box-shadow:0 10px 30px rgba(0,0,0,.26),0 0 0 3px color-mix(in srgb,var(--rv-acc) 18%,transparent),inset 0 0 0 2px var(--rv-acc)}'
        + '[data-amp-revolver] .rv-drum{position:absolute;inset:0;transform-style:preserve-3d}'
        + '[data-amp-revolver] .rv-it{position:absolute;left:0;right:0;top:50%;height:' + (REV_H - 6) + 'px;margin-top:-' + ((REV_H - 6) / 2) + 'px;display:flex;align-items:center;gap:10px;padding:0 14px;box-sizing:border-box;border-radius:12px;background:var(--rv-card);color:var(--rv-fg);box-shadow:0 4px 14px rgba(0,0,0,.14),inset 0 0 0 1px var(--rv-line);backface-visibility:hidden;will-change:transform,opacity}'
        + '[data-amp-revolver] .rv-it.sel{background:transparent;box-shadow:none;font-weight:700;color:var(--rv-acc)}[data-amp-revolver] .rv-it.sel .rv-ic{color:var(--rv-fg)}[data-amp-revolver] .rv-it .rv-ic{display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;flex:none}[data-amp-revolver] .rv-it .rv-ic svg{width:16px;height:16px}'
        + '[data-amp-revolver] .rv-it .rv-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}[data-amp-revolver] .rv-it .rv-ck{opacity:0;font-size:12px;color:var(--rv-acc)}[data-amp-revolver] .rv-it.cur .rv-ck{opacity:1}'
        + '[data-amp-revolver] .rv-hint{position:absolute;left:0;right:0;top:4px;text-align:center;font-size:11px;font-weight:400;color:var(--rv-mut)}'
        + '[data-amp-native-gacha="1"]{touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}[data-amp-native-gacha="1"][data-amp-rv]{transform:scale(.94)!important}';
      (document.head || document.documentElement).append(st);
    }
    function revItems() {
      const s = gacha.settings(), out = [{ id: '', name: '不限', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="M8 12h8"/></svg>' }];
      for (const v of gacha.VENDORS) out.push({ id: v.id, name: v.name, icon: vendorIcon(v.id, 16) });
      if (s.customKeyword) out.push({ id: 'custom', kw: s.customKeyword, name: s.customKeyword, icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h10M4 17h7"/></svg>' });
      return out;
    }
    function wheelOpen(b) {
      revCss();
      const items = revItems(), s = gacha.settings(), curId = s.vendor || '';
      const cur = Math.max(0, items.findIndex(it => it.id === curId)); let pos = cur, target = cur, shown = -1, done = false, raf = 0, idleT = 0, acc = 0;
      const dark = document.documentElement.classList.contains('dark');
      const root = document.createElement('div'); root.dataset.ampRevolver = '1';
      root.style.cssText = dark ? '--rv-card:#34322e;--rv-win:#4b4740;--rv-fg:#ecebe7;--rv-line:#ffffff14;--rv-acc:#d8d3ca;--rv-mut:#a9a59d' : '--rv-card:#fffdf9;--rv-win:#e6ddd0;--rv-fg:#262522;--rv-line:#0000000f;--rv-acc:#6a5e54;--rv-mut:#7a746b';
      root.innerHTML = '<div class="rv-win"></div><div class="rv-drum"></div><div class="rv-hint">滚轮选择 · 停下或移开确认</div>';
      const drum = root.querySelector('.rv-drum');
      const els = items.map((it, i) => { const d = document.createElement('div'); d.className = 'rv-it' + (i === cur ? ' cur' : ''); d.innerHTML = '<span class="rv-ic">' + it.icon + '</span><span class="rv-nm"></span><span class="rv-ck">当前</span>'; d.querySelector('.rv-nm').textContent = it.name; drum.append(d); return d; });
      document.body.append(root);
      const r = b.getBoundingClientRect(), W = 200, H = REV_H * 5;
      root.style.left = Math.max(8, Math.min(innerWidth - W - 8, r.left + r.width / 2 - W / 2)) + 'px';
      root.style.top = Math.max(8, r.top - H - 14) + 'px';
      b.setAttribute('data-amp-rv', ''); b._ampRv = true;
      const n = els.length, wrapI = k => ((k % n) + n) % n;
      const paint = () => {
        els.forEach((d, i) => {
          const off = ((((i - pos) % n) + n + n / 2) % n) - n / 2, a = Math.abs(off);
          d.style.transform = 'translateY(' + (off * REV_H * 0.92) + 'px) rotateX(' + (-off * 24) + 'deg) translateZ(' + (-a * a * 6) + 'px) scale(' + Math.max(.72, 1 - a * .07) + ')';
          d.style.opacity = String(Math.max(0, 1 - a * .3)); d.style.zIndex = String(100 - Math.round(a * 10));
        });
        const k = wrapI(Math.round(pos)); if (k !== shown) { shown = k; els.forEach((d, i) => d.classList.toggle('sel', i === k)); }
      };
      paint(); requestAnimationFrame(() => root.classList.add('on'));
      const loop = () => { raf = 0; pos += (target - pos) * .3; if (Math.abs(target - pos) < .003) pos = target; paint(); if (pos !== target) raf = requestAnimationFrame(loop); };
      const finish = pick => {
        if (done) return; done = true; clearTimeout(idleT); cancelAnimationFrame(raf);
        b.removeEventListener('mouseleave', leave); b.removeEventListener('click', clk, true); removeEventListener('keydown', esc, true); removeEventListener('blur', away); document.removeEventListener('visibilitychange', away);
        const kr = Math.round(target), k = wrapI(kr);
        const from = pos, t0 = performance.now(); const snap = t => { const p = Math.min(1, (t - t0) / 160); pos = from + (kr - from) * (1 - Math.pow(1 - p, 3)); paint(); if (p < 1) requestAnimationFrame(snap); }; requestAnimationFrame(snap);
        root.classList.add('out'); setTimeout(() => root.remove(), 420);
        b.removeAttribute('data-amp-rv'); b._ampRv = false; b._ampWh = null; b._ampRvSkip = Date.now();
        if (pick) { const it = items[k]; if (it.id !== curId || it.id === 'custom') { if (it.id === 'custom') gacha.setVendor('custom', it.kw); else gacha.setVendor(it.id); try { window.dispatchEvent(new CustomEvent('amp-native-gacha')); } catch {} } }
      };
      const leave = () => finish(true);
      const clk = ev => { ev.preventDefault(); ev.stopImmediatePropagation(); finish(true); };
      const esc = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); } else if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } };
      const away = ev => { if (ev?.type === 'visibilitychange' && document.visibilityState !== 'hidden') return; finish(false); };
      b.addEventListener('mouseleave', leave); b.addEventListener('click', clk, true); addEventListener('keydown', esc, true); addEventListener('blur', away); document.addEventListener('visibilitychange', away);
      return {
        push(d) {
          if (done) return;
          // 普通鼠标一格 ≈ 100 → 转一张；触控板的细碎滚动累积到 60 再转一张，避免一碰就飞
          if (Math.abs(d) >= 50) target += Math.sign(d); else { acc += d; if (Math.abs(acc) >= 60) { target += Math.sign(acc); acc = 0; } }
          if (!raf) raf = requestAnimationFrame(loop);
          clearTimeout(idleT); idleT = setTimeout(() => finish(true), 1200);
        }
      };
    }
    function attachRevolver(b) {
      if (b.dataset.ampRvBound) return; b.dataset.ampRvBound = '1';
      // 触屏：按钮一开始就禁止浏览器把上下滑当成页面滚动（以前样式要等弹巢打开后才注入，手机上手势被滚动抢走）
      revCss(); b.style.touchAction = 'none'; b.style.webkitTouchCallout = 'none'; b.style.userSelect = 'none';
      b.addEventListener('contextmenu', e => { if (b.hasAttribute('data-amp-rv') || b._ampRvT) e.preventDefault(); });
      // 电脑：鼠标停在厂商按钮上直接滚动滚轮 → 弹出同一个弹巢并跟着转；停下约 1.2 秒、移开鼠标或点一下即确认，Esc 取消
      b.addEventListener('wheel', e => {
        const st = gacha.state(); if (st && ['running', 'stopping'].includes(st.status)) return;
        if (b._ampRv && !b._ampWh) return; // 正在用手势/长按拨动
        if (!e.deltaY) return;
        e.preventDefault(); e.stopPropagation();
        const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        (b._ampWh ||= wheelOpen(b)).push(d);
      }, { passive: false });
      b.addEventListener('pointerdown', e => {
        if (e.button !== 0 || b._ampRv) return;
        const st = gacha.state(); if (st && ['running', 'stopping'].includes(st.status)) return; // 抽卡中不允许换厂商
        const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
        try { b.setPointerCapture(pid); } catch {}
        // 事件挂在 window（捕获阶段）：按钮被重绘/移除、指针捕获丢失时仍能收到抬起/取消，不会卡住
        const cancel = () => { clearTimeout(b._ampRvT); b._ampRvT = 0; removeEventListener('pointermove', early, true); removeEventListener('pointerup', cancel, true); removeEventListener('pointercancel', cancel, true); removeEventListener('blur', cancel); };
        const touch = e.pointerType !== 'mouse';
        // 手机：在按钮上上下滑动（任一方向超过 8px）立即弹出弹巢，继续滑动选择，松手确认；电脑：长按或向上推
        const early = ev => { if (ev.pointerId !== pid) return; const dy = y0 - ev.clientY, dx = Math.abs(ev.clientX - x0); if (touch ? Math.abs(dy) > 8 && Math.abs(dy) > dx : dy > 12) { cancel(); open(ev, touch ? dy : 0); } else if (dx > (touch ? 24 : 14) || (!touch && ev.clientY - y0 > 14)) cancel(); };
        b._ampRvT = setTimeout(() => { cancel(); open(e); }, 350);
        addEventListener('pointermove', early, true); addEventListener('pointerup', cancel, true); addEventListener('pointercancel', cancel, true); addEventListener('blur', cancel);
        function open(ev0, pre = 0) {
          revCss(); try { b.setPointerCapture(pid); } catch {}
          const items = revItems(), s = gacha.settings(), curId = s.vendor || '';
          let cur = Math.max(0, items.findIndex(it => it.id === curId)), pos = cur, shown = -1, startY = ev0.clientY + pre, startPos = pos, done = false;
          const dark = document.documentElement.classList.contains('dark');
          const root = document.createElement('div'); root.dataset.ampRevolver = '1';
          root.style.cssText = dark ? '--rv-card:#34322e;--rv-win:#4b4740;--rv-fg:#ecebe7;--rv-line:#ffffff14;--rv-acc:#d8d3ca;--rv-mut:#a9a59d' : '--rv-card:#fffdf9;--rv-win:#e6ddd0;--rv-fg:#262522;--rv-line:#0000000f;--rv-acc:#6a5e54;--rv-mut:#7a746b';
          root.innerHTML = '<div class="rv-win"></div><div class="rv-drum"></div><div class="rv-hint">上下推动 · 松开选中</div>';
          const drum = root.querySelector('.rv-drum');
          const els = items.map((it, i) => { const d = document.createElement('div'); d.className = 'rv-it' + (i === cur ? ' cur' : ''); d.innerHTML = '<span class="rv-ic">' + it.icon + '</span><span class="rv-nm"></span><span class="rv-ck">当前</span>'; d.querySelector('.rv-nm').textContent = it.name; drum.append(d); return d; });
          document.body.append(root);
          const r = b.getBoundingClientRect(), W = 200, H = REV_H * 5;
          root.style.left = Math.max(8, Math.min(innerWidth - W - 8, r.left + r.width / 2 - W / 2)) + 'px';
          root.style.top = Math.max(8, r.top - H - 14) + 'px';
          b.setAttribute('data-amp-rv', ''); b._ampRv = true;
          const wrap = k => ((k % items.length) + items.length) % items.length;
          const paint = () => {
            els.forEach((d, i) => {
              const n = els.length, off = ((((i - pos) % n) + n + n / 2) % n) - n / 2, a = Math.abs(off);
              // 弹巢：卡片绕水平轴排成圆柱，离中心越远越倾斜、越小、越淡
              d.style.transform = 'translateY(' + (off * REV_H * 0.92) + 'px) rotateX(' + (-off * 24) + 'deg) translateZ(' + (-a * a * 6) + 'px) scale(' + Math.max(.72, 1 - a * .07) + ')';
              d.style.opacity = String(Math.max(0, 1 - a * .3)); d.style.zIndex = String(100 - Math.round(a * 10));
            });
            const k = wrap(Math.round(pos)); if (k !== shown) { if (shown >= 0) try { navigator.vibrate?.(6); } catch {} shown = k; els.forEach((d, i) => d.classList.toggle('sel', i === k)); }
          };
          paint(); requestAnimationFrame(() => root.classList.add('on'));
          // 循环滚动：不分首尾，最后一项之后接第一项
          const clampPos = p => p;
          const move = ev => { if (ev.pointerId !== pid || done) return; ev.preventDefault(); pos = clampPos(startPos + (startY - ev.clientY) / (REV_H * .92)); paint(); };
          const finish = (ev, pick) => {
            if (ev && ev.pointerId !== pid) return; if (done) return; done = true;
            removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); removeEventListener('pointercancel', cc, true); removeEventListener('keydown', esc, true);
            removeEventListener('pointermove', touchT, true); removeEventListener('blur', away); removeEventListener('pagehide', away); document.removeEventListener('visibilitychange', away); clearInterval(dog);
            try { b.releasePointerCapture(pid); } catch {}
            const kr = Math.round(pos), k = wrap(kr);
            // 吸附到选中项再淡出
            const from = pos, t0 = performance.now(); const snap = t => { const p = Math.min(1, (t - t0) / 160); pos = from + (kr - from) * (1 - Math.pow(1 - p, 3)); paint(); if (p < 1) requestAnimationFrame(snap); }; requestAnimationFrame(snap);
            root.classList.add('out'); setTimeout(() => root.remove(), 420);
            b.removeAttribute('data-amp-rv'); b._ampRv = false; b._ampRvSkip = Date.now();
            if (pick) { const it = items[k]; if (it.id !== curId || it.id === 'custom') { if (it.id === 'custom') gacha.setVendor('custom', it.kw); else gacha.setVendor(it.id); try { window.dispatchEvent(new CustomEvent('amp-native-gacha')); } catch {} } }
          };
          const up = ev => finish(ev, true), cc = ev => finish(ev, false), esc = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(null, false); } };
          // 离开页面 / 切到后台 / 打开抽屉导致手势被系统拿走：一律收起弹巢（不改选择）
          const away = ev => { if (ev?.type === 'visibilitychange' && document.visibilityState !== 'hidden') return; finish(null, false); };
          let lastEv = Date.now(); const touchT = ev => { if (ev.pointerId === pid) lastEv = Date.now(); };
          const dog = setInterval(() => { if (done) return clearInterval(dog); if (!b.isConnected && Date.now() - lastEv > 1200) finish(null, false); else if (Date.now() - lastEv > 12000) finish(null, false); }, 400);
          addEventListener('pointermove', touchT, true);
          addEventListener('pointermove', move, true); addEventListener('pointerup', up, true); addEventListener('pointercancel', cc, true); addEventListener('keydown', esc, true);
          addEventListener('blur', away); addEventListener('pagehide', away); document.addEventListener('visibilitychange', away);
        }
      });
    }
    function install() {
      let inserted = false;
      for (const action of [...document.querySelectorAll(SEL)].filter(visible)) {
        const toolbar = action.parentElement; let composer = action.closest('form') || toolbar;
        for (let i = 0; i < 4 && composer && !composer.querySelector('[contenteditable="true"],textarea'); i++) composer = composer.parentElement;
        if (!toolbar || !composer?.querySelector('[contenteditable="true"],textarea') || action.closest('[role="log"]')) continue;
        const existing = toolbar.querySelector('[data-amp-native-gacha="1"]');
        if (existing) { inserted = true; if (existing.nextElementSibling !== action) toolbar.insertBefore(existing, action); lastAnchorRect = existing.getBoundingClientRect(); if (panel.classList.contains('open') && !anchor?.isConnected) anchor = existing; continue; }
        // Prefer a native *text* button in the composer (e.g. "Agent ⌄" / "gpt-6 ⌄") so size and typography match.
        const own = b => b.matches('[data-amp-native-gacha]') || b === action;
        const textPeer = [...composer.querySelectorAll('button')].find(b => !own(b) && visible(b) && (b.innerText || '').trim() && !b.closest('[role="log"]'));
        const peer = textPeer || [...toolbar.querySelectorAll('button')].find(b => !own(b));
        const b = document.createElement('button'); b.type = 'button'; b.dataset.ampNativeGacha = '1'; b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-expanded', 'false');
        b.className = peer?.className || '';
        b.innerHTML = '<span data-amp-icon hidden></span><span data-amp-name></span><span data-amp-progress hidden></span>' + chevron + '<i data-amp-progress-bar hidden></i><i data-amp-dot hidden></i><i data-amp-ring aria-hidden="true"></i><span data-amp-land aria-hidden="true"></span>';
        if (textPeer) { const cs = getComputedStyle(textPeer); for (const k of ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontFamily']) if (cs[k]) b.style[k] = cs[k]; }
        b.onclick = e => { e.preventDefault(); e.stopPropagation(); if (b._ampRvSkip && Date.now() - b._ampRvSkip < 500) return; toggle(b); }; attachRevolver(b);
        toolbar.insertBefore(b, action); inserted = true; lastAnchorRect = b.getBoundingClientRect();
        if (panel.classList.contains('open')) anchor = b;
      }
      // The slot button lives and dies with the composer: no floating substitute. Orphans are removed.
      for (const b of document.querySelectorAll('[data-amp-native-gacha="1"]')) {
        const next = b.nextElementSibling;
        if (!next || !next.matches(SEL) || !visible(next)) b.remove();
      }
      launcher.classList.remove('show');
      if (panel.classList.contains('open') && !(anchor?.isConnected && anchor !== launcher)) {
        const b = [...document.querySelectorAll('[data-amp-native-gacha="1"]')].find(visible);
        // v1.11.77 抽卡换对话时输入框会重建一下：面板留在原位，1.5 秒内按钮回来就接着挂上，不再一闪就关
        if (b) { anchor = b; clearTimeout(graceT); graceT = 0; }
        else if (!graceT) graceT = setTimeout(() => { graceT = 0; if (!panel.classList.contains('open') || (anchor?.isConnected && anchor !== launcher)) return; const b2 = [...document.querySelectorAll('[data-amp-native-gacha="1"]')].find(visible); if (b2) { anchor = b2; position(); } else close(); }, 1500);
      }
      render();
    }
    let scheduled = false;
    // 性能：流式输出（[role=log] 内）和脚本自己写入的节点不触发；只有侧栏变化时只同步侧栏，不重建抽卡按钮
    const OWN = '[data-amp-native-gacha],[data-amp-vlogo],[data-amp-hname],[data-amp-htier],[data-amp-hlogo],[data-amp-slot],#amp-lite-dock';
    const ownNode = n => n.nodeType === 1 && !!(n.matches(OWN) || n.hasAttribute('data-amp-local-title'));
    let needComp = false, needSide = false;
    const syncSide = () => { try { const st = gacha.state(), cfg = gacha.running() && st ? st.settings : gacha.settings(); sidebar.sync(cfg.targetKeywords); } catch {} };
    // v1.11.78 卡片时间：Arena 更新了某个对话的时间但卡片位置没变（DOM 不变、不触发观察器）时，每 20 秒对一次
    setInterval(() => { if (!document.hidden && document.querySelector('[data-amp-ctime]')) syncSide(); }, 20000);
    new MutationObserver(recs => {
      for (const rec of recs) {
        const t = rec.target, e = t.nodeType === 1 ? t : t.parentElement; if (!e) continue;
        if (e.closest('[role="log"]') || e.closest(OWN)) continue;
        if (rec.addedNodes.length + rec.removedNodes.length && [...rec.addedNodes, ...rec.removedNodes].every(ownNode)) continue;
        if (e.closest('aside,nav,[data-sidebar]')) needSide = true; else needComp = true;
        if (needComp) break;
      }
      if (scheduled || !(needComp || needSide)) return; scheduled = true;
      requestAnimationFrame(() => { scheduled = false; const c = needComp, sd = needSide; needComp = needSide = false; if (c) install(); else if (sd) syncSide(); });
    }).observe(document.body, { childList: true, subtree: true });
    setInterval(() => { if (!document.hidden) syncSide(); }, 1500); // 排行榜/厂商识别等异步结果到达后补一次
    for (const name of Object.keys(sections)) $('[data-ui="' + name + '"]').onclick = () => { if (name === 'choose') choices(); show(name); };

    $('[data-ui="quantity"]').oninput = e => { gacha.saveSettings({ maxAttempts: Q[Number(e.target.value)] }); render(); };
    const lines = v => [...new Set(v.split(/[\n,，]+/).map(s => s.trim()).filter(Boolean))];
    const addInput = $('[data-ui="archiveLines"]');
    const grow = () => { addInput.style.height = 'auto'; addInput.style.height = Math.min(96, addInput.scrollHeight + 2) + 'px'; position(); };
    addInput.oninput = grow;
    addInput.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('[data-ui="saveModels"]').click(); } };
    $('[data-ui="saveModels"]').onclick = () => {
      const add = lines(addInput.value); if (!add.length) { addInput.focus(); return; }
      const cur = gacha.settings().archiveKeywords, low = new Set(cur.map(x => x.toLowerCase()));
      const fresh = add.filter(x => !low.has(x.toLowerCase())), arch = [...cur, ...fresh];
      if (arch.length > 50 || arch.some(x => x.length > 200)) { say('最多 50 个关键词', true); return; }
      gacha.saveSettings({ archiveKeywords: arch, archiveOn: field('archiveOn').checked }); addInput.value = ''; grow(); pendingDel = null; chips();
      say(fresh.length ? '已添加 ' + fresh.length + ' 个' : '关键词已存在');
    };
    $('[data-ui="confirmNo"]').onclick = () => { pendingDel = null; chips(); };
    $('[data-ui="confirmYes"]').onclick = () => {
      const k = pendingDel; pendingDel = null; if (!k) return chips();
      gacha.saveSettings({ archiveKeywords: gacha.settings().archiveKeywords.filter(x => x !== k) }); chips(); say('已删除“' + k + '”');
    };
    field('archiveOn').onchange = () => { gacha.saveSettings({ archiveOn: field('archiveOn').checked }); render(); };
    for (const k of ['stopOnThinking', 'sortSidebar']) field(k).onchange = () => { gacha.saveSettings({ [k]: field(k).checked }); render(); };
    // 提示词改完即保存（失焦/回车），不必再点“保存”。
    const savePrompt = () => { const v = field('prompt').value.trim(); if (v && v !== gacha.settings().prompt) { gacha.saveSettings({ prompt: v }); if (!gacha.saveOk()) say('保存失败：浏览器本地存储已满或被禁用', true); else say(gacha.running() ? '已保存，下一轮生效' : '提示词已保存'); } };
    field('prompt').addEventListener('change', savePrompt); field('prompt').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); savePrompt(); field('prompt').blur(); } });
    $('[data-ui="saveText"]').onclick = () => {
      const sec = Number(field('intervalSec').value);
      if (!field('prompt').value.trim()) { say('提示词不能为空', true); return; }
      if (!Number.isFinite(sec) || sec < 0 || sec > 60) { say('间隔 0～60 秒', true); return; }
      gacha.saveSettings({ prompt: field('prompt').value.trim(), intervalMs: Math.round(sec * 1000), stopOnThinking: field('stopOnThinking').checked, sortSidebar: field('sortSidebar').checked }); if (gacha.saveOk()) say('已保存'); else say('保存失败：浏览器本地存储已满或被禁用', true);
    };
    $('[data-a="start"]').onclick = () => { message = ''; const st = gacha.state(), r = gacha.start(); if (!r.ok) { say(r.error, true); render(); return; } close(); render(); };
    $('[data-a="stop"]').onclick = () => { gacha.stop(); render(); };
    $('[data-a="reset"]').onclick = () => { gacha.reset(); message = ''; render(); };
    $('[data-a="ipok"]').onclick = async e => { const b = e.currentTarget; if (b.disabled) return; b.disabled = true; b.textContent = '检测中…'; let r; try { r = await gacha.ipRetry(); } catch (x) { r = { ok: false, error: String(x?.message || x) }; } b.disabled = false; b.textContent = '我已更换 IP'; if (r.ok) { say(r.msg); setTimeout(() => { if (message === r.msg) { message = ''; render(); } }, 5000); close(); } else say(r.error, true); };
    document.addEventListener('pointerdown', e => { if (!e.composedPath().includes(host) && !e.target.closest?.('[data-amp-native-gacha]')) close(); });
    document.addEventListener('keydown', e => {
      if (!panel.classList.contains('open')) return;
      if (e.key === 'Escape') { e.preventDefault(); if (pendingDel) { pendingDel = null; chips(); } else if (section) show(section); else close(); }
    }, true);
    window.addEventListener('amp-native-gacha', () => render());
    window.addEventListener('amp-native-gacha-open', () => { const b = [...document.querySelectorAll('[data-amp-native-gacha="1"]')].find(visible); if (b && !panel.classList.contains('open')) toggle(b); });
    load(); install();
    return { render, install, root };
  }
  return { mount, vendorIcon, get mounted() { return mounted; } };
})();


(function () {
  'use strict';
  const VERSION = 'native-1.11.78', KEY = 'amp.lite.v2', DB_VERSION = 3, LEVELS = ['none','minimal','low','medium','high','xhigh','max'];
  // 每轮最多详读的模型调用数 / 内存保留完整原始数据的轮数 / 每轮持久化精简原始数据的上限
  const TURN_CALL_LIMIT = 16, RAW_KEEP = 3, RAW_PERSIST_BYTES = 262144;
  // 原始数据总预算可选档位（MB）、发送时间缓存条数、额度刷新最小间隔
  const BUDGET_OPTIONS = [16, 32, 64, 128, 256], SENT_KEEP = 4000, BALANCE_INTERVAL = 60000;
  const RUN = /^run_[\w-]{1,100}$/, SPAN = /^[a-f0-9]{16,32}$/i;
  const number = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
  const label = v => typeof v === 'string' && v.length <= 200 && !/[\x00-\x1f\x7f]|Bearer\s|eyJ[\w-]+\.[\w-]+\./i.test(v) ? v : null;
  function get(o, path) {
    if (!o || typeof o !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(o, path)) return o[path];
    for (const k of path.split('.')) { if (!o || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o,k)) return undefined; o = o[k]; }
    return o;
  }
  function object(v) { if (typeof v === 'string' && v.length < 524288) { try { v = JSON.parse(v); } catch { return {}; } } return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function sidOf(url) { try { return new URL(url,'https://arena.ai').pathname.match(/^\/agent\/([\w-]{1,128})\/?$/)?.[1] || null; } catch { return null; } }
  function streamSid(url) { try { return new URL(url,'https://arena.ai').pathname.match(/\/realtime\/v1\/sessions\/([\w-]{1,128})\//)?.[1] || null; } catch { return null; } }
  function authorized(token, expectedSid, now = Date.now()) {
    if (typeof token !== 'string' || token.length > 16384 || token.split('.').length !== 3) throw Error('运行令牌格式不符');
    let p; try { let s=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'); s+='='.repeat((4-s.length%4)%4); p=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s),c=>c.charCodeAt(0)))); } catch { throw Error('运行令牌无法解码'); }
    if (p?.pub !== true || p.iss !== 'https://id.trigger.dev' || ![p.aud].flat().includes('https://api.trigger.dev')) throw Error('不是公开运行令牌');
    if (!Number.isFinite(p.exp) || p.exp*1000 <= now+5000) throw Error('运行令牌已过期');
    const scopes=Array.isArray(p.scopes)?p.scopes:[], runs=scopes.filter(s=>typeof s==='string'&&s.startsWith('read:runs:'));
    const sessions=scopes.filter(s=>typeof s==='string'&&s.startsWith('read:sessions:')).map(s=>s.slice(14));
    const sid=expectedSid || (sessions.length===1?sessions[0]:null);
    if (!sid || !sessions.includes(sid) || runs.length!==1 || !RUN.test(runs[0].slice(10))) throw Error('会话与运行读取权限不匹配');
    return {sid,runId:runs[0].slice(10),expires:p.exp*1000};
  }
  // Trace 里的 startTime 是纳秒字符串（BigInt 序列化），duration 是纳秒数
  const toMs = v => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && /^\d{10,}$/.test(v)) { const n = Number(v.length > 15 ? v.slice(0, -6) : v); return Number.isSafeInteger(n) ? n : null; }
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e15 ? Math.round(v / 1e6) : v > 1e11 ? Math.round(v) : null;
    if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
    return null;
  };
  const toDurationMs = v => { const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : typeof v === 'number' ? v : NaN; return Number.isFinite(n) && n >= 0 ? Math.round(n / 1e5) / 10 : null; };

  // 1. 白名单解析：正文不参与档位判断，也不进入缓存。
  function configs(node, source='span', path='$.properties', out=[], depth=0) {
    if (!node || typeof node!=='object' || Array.isArray(node) || depth>8 || out.length>=48) return out;
    for (const [key,raw] of Object.entries(node).slice(0,160)) {
      if (!/^[\w.-]{1,180}$/.test(key) || key.split('.').some(k=>/^(messages?|parts|text|content|prompt|input|output|delta|headers|authorization|cookie|token|password|secret|signature)$/i.test(k))) continue;
      const p=path+'.'+key, leaf=key.split('.').at(-1), parent=p.split('.').at(-2);
      let v=raw;
      if (v && typeof v==='object' && Object.keys(v).length===1 && 'stringValue' in v) v=v.stringValue;
      if (/^(reasoning_effort|reasoningEffort|thinkingLevel|thinking_level)$/.test(leaf) || leaf==='effort' && /^(reasoning|output_config|outputConfig)$/.test(parent)) {
        if(typeof v==='string') out.push({kind:'effort',value:LEVELS.includes(v.trim().toLowerCase())?v.trim().toLowerCase():null,source,path:p});
      } else if (/^(thinkingBudget|thinking_budget|budget_tokens|budgetTokens)$/.test(leaf) && /^(thinking|thinkingConfig|thinking_config)$/.test(parent) && Number.isSafeInteger(v) && v>=-1) {
        out.push({kind:'budget',value:v,source,path:p});
      } else if (leaf==='type' && parent==='thinking' && ['enabled','disabled','adaptive'].includes(v)) {
        out.push({kind:'mode',value:v,source,path:p});
      } else {
        if (typeof v==='string' && /^(providerOptions|provider_options|reasoning|thinking|thinkingConfig|thinking_config|output_config|outputConfig)$/.test(leaf)) v=object(v);
        if (v && typeof v==='object') configs(v,source,p,out,depth+1);
      }
      if(out.length>=48)break;
    }
    return out;
  }
  function effort(items=[]) {
    const seen=new Set(), evidence=items.filter(x=>{const k=JSON.stringify(x);if(seen.has(k))return false;seen.add(k);return true;});
    const e=evidence.filter(x=>x.kind==='effort'), levels=[...new Set(e.map(x=>x.value).filter(x=>LEVELS.includes(x)))];
    const status=levels.length>1?'conflict':e.some(x=>x.value===null)?'unsupported':levels.length?'explicit':'unknown';
    return {status,value:status==='explicit'?levels[0]:null,levels,budgets:[...new Set(evidence.filter(x=>x.kind==='budget').map(x=>x.value))],modes:[...new Set(evidence.filter(x=>x.kind==='mode').map(x=>x.value))],evidence};
  }
  function hint(internal, request) {
    if(!internal)return {value:null,status:'未提供'};
    const strip=s=>s.replace(/-(vertex|agent|public)$/i,'').replace(/-\d{8}$|-\d{4}$/,'');
    const s=strip(internal), m=/-(none|minimal|low|medium|high|xhigh|max)$/i.exec(s);
    if(!m)return {value:null,status:'无后缀'};
    const norm=s=>s.toLowerCase().replace(/[._]/g,'-'), base=s.slice(0,-m[0].length);
    if(request && norm(strip(request))===norm(s))return {value:null,status:'型号本身的组成部分'};
    return {value:m[1].toLowerCase(),status:!request?'仅后缀，未核对基座':norm(strip(request))===norm(base)?'内部标签，非显式参数':'基座不一致，待核对'};
  }
  function reported(readings) {
    const evidence=readings.filter(x=>number(x.value)!==null), values=[...new Set(evidence.map(x=>x.value))];
    return {value:values.length===1?values[0]:null,status:values.length>1?'conflict':values.length?values[0]===0?'zero':'positive':'missing',evidence};
  }
  // 按 "chat turn N" 标记把 Trace 切成段；同一轮号再次出现记为第 attempt 次。
  // baseline 是页面提交新消息时记下的（标记数, 已见 span, 服务端最新事件时间），用于在后端不写新标记时仍能识别出新记录；
  // since 使用服务端时间域，避免本机时钟偏差把新记录过滤掉。
  function plan(trace, runId, baseline=null) {
    if(!Array.isArray(trace?.events))throw Error('Trace 缺少 events 数组');
    const segments=[], attempts={};let seg={index:0,turn:null,attempt:0,at:null,events:[],items:[],first:0,last:-1}, markers=0, newest=null;
    for(const [i,e] of trace.events.entries()) {
      if(!e||typeof e!=='object'||e.runId&&e.runId!==runId)continue;
      const at=toMs(e.startTime);if(at&&(!newest||at>newest))newest=at;
      const m=/^chat turn (\d+)$/.exec(e.message||'');
      if(m){markers++;const turn=+m[1];attempts[turn]=(attempts[turn]||0)+1;if(segments.length||seg.events.length)segments.push(seg);seg={index:segments.length,turn,attempt:attempts[turn],at:toMs(e.startTime),events:[],items:[],first:i,last:i};}
      seg.last=i;
      const pill=icon=>(e.style?.accessory?.items||[]).find(x=>x?.icon===icon&&label(x.text))?.text||null;
      const id=SPAN.test(e.spanId||'')?e.spanId:null, msg=label(e.message)||'';
      const kind=m?'marker':/^ai\.(streamText\.doStream|generateText\.doGenerate)$/.test(msg)?'stream':msg==='token.usage.recorded'?'usage':msg==='spend.recorded'?'cost':null;
      if(seg.events.length<2400)seg.events.push({spanId:id,parentId:typeof e.parentId==='string'?e.parentId.slice(0,64):null,message:msg,at:toMs(e.startTime),durationMs:toDurationMs(e.duration),isPartial:e.isPartial!==false,isError:e.isError===true,isCancelled:e.isCancelled===true,level:label(e.level),model:pill('tabler-cube'),totalLabel:pill('tabler-hash'),icon:label(e.style?.icon),kind});
      if(!kind||kind==='marker'||!id)continue;
      seg.items.push({id,kind,message:msg,at:toMs(e.startTime),turn:seg.turn,partial:e.isPartial!==false,error:e.isError===true,model:pill('tabler-cube'),totalLabel:pill('tabler-hash'),properties:e.properties});
    }
    segments.push(seg);
    const cur=segments.at(-1), spanIds=new Set();for(const s of segments)for(const x of s.items)spanIds.add(x.id);
    let items=cur.items, prior=0, resumed=false;
    if(baseline&&markers<=(baseline.markers||0)){const fresh=items.filter(x=>!baseline.spans?.has(x.id)&&(!x.at||!baseline.since||x.at>=baseline.since));prior=items.filter(x=>x.kind==='stream').length-fresh.filter(x=>x.kind==='stream').length;items=fresh;resumed=true;}
    const streams=items.filter(x=>x.kind==='stream'), usage=items.filter(x=>x.kind==='usage'), cost=items.filter(x=>x.kind==='cost');
    // Arena 服务端故障转移：原模型首包超时/报错 → model.resample.attempt_failed → failover.record_inserted → model.resample.switched/committed
    const route=cur.events.filter(e=>/^(model\.resample\.(attempt_failed|switched|committed)|failover\.record_inserted|agent\.empty_turn|Agent turn failed)$/.test(e.message)).map(e=>({message:e.message,at:e.at,spanId:e.spanId,level:e.level}));
    const records=[...usage.slice(-TURN_CALL_LIMIT),...cost.slice(-4)];
    return {turn:cur.turn,attempt:cur.attempt,segment:cur.index,markers,at:resumed?(streams[0]?.at??cur.at):cur.at,range:[cur.first,cur.last],allStreams:streams,allRecords:[...usage,...cost],streams:streams.slice(-TURN_CALL_LIMIT),records,count:streams.length,limited:streams.length>TURN_CALL_LIMIT||usage.length>TURN_CALL_LIMIT||cost.length>4,ready:!!streams.length&&items.every(x=>!x.partial),events:cur.events,route,prior,resumed,spanIds,newest,segments:segments.map(s=>({index:s.index,turn:s.turn,attempt:s.attempt,at:s.at,calls:s.items.filter(x=>x.kind==='stream').length}))};
  }
  function detail(data,event,runId) {
    if(data?.runId && data.runId!==runId || data?.spanId && data.spanId!==event.id || data?.message && data.message!==event.message)throw Error('Span 返回了不同的调用标识');
    const p=object(data?.properties), text=paths=>paths.map(k=>label(get(p,k))).find(Boolean)||null;
    const readings=(paths,kind,source='span')=>paths.flatMap(path=>number(get(p,path))!==null?[{kind,value:get(p,path),source,path:'$.properties.'+path}]:[]);
    const d={id:event.id,kind:event.kind,at:event.at??null,partial:event.partial||data?.isPartial===true,available:!!data?.properties};
    if(event.kind!=='stream')return {...d,internal:text(['modelName','model_name','model','ai.model.id']),messageId:text(['messageId','message_id','assistantMessageId','nodeId']),route:text(['provider']),reasoning:readings(['reasoningTokens'],'reasoning','record'),input:readings(['inputTokens'],'input','record'),output:readings(['outputTokens'],'output','record'),total:readings(['totalTokens'],'total','record'),cacheRead:readings(['cacheReadTokens','cache_read_tokens','cachedInputTokens','cacheReadInputTokens','cachedTokens'],'cacheRead','record'),cacheWrite:readings(['cacheWriteTokens','cache_write_tokens','cacheCreationInputTokens','cacheCreationTokens'],'cacheWrite','record'),fields:event.kind==='cost'?costFields(p):[],usd:event.kind==='cost'?usdFields(p):null};
    d.request=text(['ai.telemetry.metadata.apiModelName','gen_ai.request.model','ai.model.id']);d.response=text(['ai.response.model','gen_ai.response.model']);
    d.route=text(['ai.telemetry.metadata.modelProvider']);d.adapter=text(['ai.model.provider']);d.finish=text(['ai.response.finishReason']);
    d.configs=configs(p);const opt=get(p,'ai.prompt.providerOptions');if(opt!==undefined)configs({providerOptions:opt},'span','$.properties.ai.prompt',d.configs);
    d.reasoning=readings(['ai.usage.reasoningTokens','gen_ai.usage.reasoning_tokens'],'reasoning');
    const meta=object(get(p,'ai.response.providerMetadata'));
    for(const path of ['anthropic.usage.output_tokens_details.thinking_tokens','vertex.usageMetadata.thoughtsTokenCount','google.usageMetadata.thoughtsTokenCount']) {
      const v=get(meta,path);if(number(v)!==null)d.reasoning.push({kind:'reasoning',value:v,source:'providerMetadata',path:'$.properties.ai.response.providerMetadata.'+path});
    }
    d.input=readings(['ai.usage.inputTokens','ai.usage.promptTokens','gen_ai.usage.input_tokens'],'input');d.output=readings(['ai.usage.outputTokens','ai.usage.completionTokens','gen_ai.usage.output_tokens'],'output');d.total=readings(['ai.usage.totalTokens','gen_ai.usage.total_tokens'],'total');
    // 缓存 token（估算美金用：缓存读取比普通输入便宜很多）；追踪数据里每次调用自带的成本（ai.totalCost）
    d.cacheRead=readings(['ai.usage.cachedInputTokens','ai.usage.inputTokenDetails.cacheReadTokens','ai.usage.cacheReadTokens','gen_ai.usage.cache_read_input_tokens','gen_ai.usage.cache_read.input_tokens'],'cacheRead');
    d.cacheWrite=readings(['ai.usage.inputTokenDetails.cacheWriteTokens','ai.usage.cacheWriteTokens','gen_ai.usage.cache_creation_input_tokens','gen_ai.usage.cache_creation.input_tokens'],'cacheWrite');
    for(const [path,k] of [['openai.cachedPromptTokens','cacheRead'],['azure.cachedPromptTokens','cacheRead'],['anthropic.cacheReadInputTokens','cacheRead'],['anthropic.cacheCreationInputTokens','cacheWrite'],['google.usageMetadata.cachedContentTokenCount','cacheRead'],['vertex.usageMetadata.cachedContentTokenCount','cacheRead']]){const v=get(meta,path);if(number(v)!==null)d[k].push({kind:k,value:v,source:'providerMetadata',path:'$.properties.ai.response.providerMetadata.'+path});}
    const ai=data?.ai&&typeof data.ai==='object'?data.ai:null;
    if(ai){if(number(ai.cachedTokens)!==null&&!d.cacheRead.length)d.cacheRead.push({kind:'cacheRead',value:ai.cachedTokens,source:'span',path:'$.ai.cachedTokens'});if(typeof ai.totalCost==='number'&&Number.isFinite(ai.totalCost)&&ai.totalCost>=0)d.aiCost=ai.totalCost;}
    d.settings={};for(const k of ['temperature','topP','maxOutputTokens']){const v=get(p,'ai.settings.'+k);if(typeof v==='number'&&Number.isFinite(v))d.settings[k]=v;}
    return d;
  }
  // 用量记录（token.usage.recorded）是 Arena 按消息写入的轮次级记录，携带内部名称。
  // 只有一次调用时其数字与该调用合并；多次调用时数字单独列为 records，不摊到某一次调用；
  // 记录数与调用数相等时仅按顺序配对名称。
  function snapshot(run,p,details) {
    const recs=p.allRecords.map(e=>({e,d:details.get(e.id)})), usage=recs.filter(x=>x.e.kind==='usage'), pool=usage.length?usage:recs;
    // 名称池取自全部用量与花费记录：用量记录缺名时仍可由花费记录提供
    const names=[...new Set(recs.map(x=>x.d?.internal).filter(Boolean))], single=p.count===1;
    const paired=pool.length>1&&pool.length===p.allStreams.length, one=pool.length===1;
    // 用量记录按消息写入：记录之后才开始的调用属于下一条消息（如交互面板选择后继续、中途换了模型），不沿用前一条消息的名称；
    // 多条记录且与调用数不一一对应时，每次调用取时间上最先落在它之后的那条记录
    const lastRec=Math.max(0,...recs.map(x=>x.e.at||0));
    const calls=p.streams.map(e=>{
      const d=details.get(e.id)||{}, i=p.allStreams.indexOf(e), late=!paired&&!!lastRec&&!!e.at&&e.at>lastRec;
      const rec=paired?pool[i]?.d:late?null:one?pool[0].d:pool.length>1&&e.at?pool.find(x=>x.e.at&&x.e.at>=e.at)?.d||null:null;
      const internal=rec?.internal||(!late&&names.length===1?names[0]:null), scope=rec?.internal?(paired||single?'call':'turn'):internal?'turn':null;
      const first=k=>(d[k]?.length?d[k]:single&&rec?.[k]||[]), input=first('input'), output=first('output'), total=first('total');
      return {id:e.id,at:e.at?new Date(e.at).toISOString():null,model:d.request||e.model||'未提供',request:d.request||null,response:d.response||null,internal,internalScope:scope,route:d.route||rec?.route||null,adapter:d.adapter||null,finish:d.finish||null,hint:hint(internal,d.request),effort:effort([...(d.configs||[]),...(single?run.requestConfigs||[]:[])]),reasoning:reported([...(d.reasoning||[]),...(single&&rec?.reasoning||[])]),tokens:{input:input[0]?.value??null,output:output[0]?.value??null,total:total[0]?.value??null,cacheRead:first('cacheRead')[0]?.value??null,cacheWrite:first('cacheWrite')[0]?.value??null},tokenSources:[...input,...output,...total],totalLabel:e.totalLabel,settings:d.settings||{},cost:typeof d.aiCost==='number'?d.aiCost:null,partial:!d.available||d.partial===true};
    });
    const records=pool.filter(x=>x.d?.available).slice(-TURN_CALL_LIMIT).map(({e,d})=>({id:e.id,at:e.at?new Date(e.at).toISOString():null,kind:e.kind,internal:d.internal||null,messageId:d.messageId||null,input:d.input[0]?.value??null,output:d.output[0]?.value??null,reasoning:d.reasoning[0]?.value??null,total:d.total[0]?.value??null,cacheRead:d.cacheRead?.[0]?.value??null,cacheWrite:d.cacheWrite?.[0]?.value??null}));
    // 花费记录单独列出（spend.recorded 的费用类字段），不混入用量记录
    const costs=recs.filter(x=>x.e.kind==='cost'&&x.d?.available).slice(-4).map(({e,d})=>({id:e.id,at:e.at?new Date(e.at).toISOString():null,internal:d.internal||null,messageId:d.messageId||null,fields:d.fields||[]}));
    const rt=p.route||[], sw=rt.find(x=>x.message==='model.resample.switched');
    const outcome=rt.some(x=>x.message==='Agent turn failed')?'failed':rt.some(x=>x.message==='agent.empty_turn')?'empty':null;
    // v1.11.78 故障转移：每个 attempt_failed 之前最后开始的那次调用 = 原模型失败的调用（failed，不算这一轮的模型）；
    // 报错的调用后面还没有新调用、这一轮也还没有结论（Agent turn failed / 空回复）时同样先不认它（多半正在改派）。
    // 失败的调用之后还没有新的调用 = 改派进行中、新模型还没出现在 Trace 里 → 记为部分记录、接着读，不拿原模型充数
    const failAts=rt.filter(x=>x.message==='model.resample.attempt_failed'&&x.at).map(x=>x.at),failedIds=new Set();
    for(const fa of failAts){const b=p.allStreams.filter(x=>x.at&&x.at<=fa).at(-1);if(b)failedIds.add(b.id);}
    if(!outcome)for(const x of p.allStreams)if(x.error)failedIds.add(x.id);
    const lastFailed=Math.max(0,...p.allStreams.filter(x=>failedIds.has(x.id)).map(x=>x.at||0)),pendingSwitch=failedIds.size>0&&!p.allStreams.some(x=>x.at&&x.at>lastFailed&&!failedIds.has(x.id));
    for(const c of calls)if(failedIds.has(c.id))c.failed=true;
    const partial=pendingSwitch||p.limited||calls.some(c=>c.partial&&!c.failed)||[...p.streams,...p.records].some(e=>!details.get(e.id)?.available&&!failedIds.has(e.id));
    const failover=failedIds.size?{pending:pendingSwitch,at:new Date(Math.max(lastFailed,...failAts)).toISOString()}:null;
    let routing=null;
    if(sw){const nm=e=>e?(details.get(e.id)?.request||e.model||null):null,before=p.allStreams.filter(x=>x.at&&x.at<=sw.at).at(-1),after=p.allStreams.find(x=>x.at&&x.at>=sw.at&&!failedIds.has(x.id))||p.allStreams.find(x=>x.at&&x.at>lastFailed&&!failedIds.has(x.id)),failAt=rt.find(x=>x.message==='model.resample.attempt_failed')?.at;
      routing={from:nm(before),to:nm(after),waitMs:before?.at&&failAt?Math.max(0,failAt-before.at):null,at:new Date(sw.at).toISOString(),committed:rt.some(x=>x.message==='model.resample.committed'),reason:run.routeReason||null,cause:run.routeCause||null};}
    return {routing,failover,outcome,version:2,key:run.runId+':'+(p.allStreams[0]?.id||'s'+p.segment),sid:run.sid,runId:run.runId,turn:p.turn,attempt:p.attempt,segment:p.segment,resumed:p.resumed,at:new Date().toISOString(),startedAt:p.at?new Date(p.at).toISOString():null,revision:run.revision,prompt:run.prompt||null,sentAt:run.submittedAt?new Date(run.submittedAt).toISOString():null,calls,count:p.count,prior:p.prior,internalNames:names,records,costs,credits:run.credits||null,partial,raw:{events:p.events,spans:run.rawSpans?Object.fromEntries(run.rawSpans):{},probe:run.probe||null}};
  }
  // 原始数据精简：去掉提示词/回答/工具定义等正文键，长字符串截断。
  const RAW_DROP=/^(messages?|parts|text|content|delta|headers|authorization|cookie|password|secret|signature|tools|definitions|system|system_instructions|toolCalls|responseText|object|reasoningText)$/i;
  function trimRaw(v,depth=0) {
    if(v===null||typeof v!=='object'){if(typeof v==='string'&&v.length>200&&!/…\[共 \d+ 字符\]$/.test(v))return v.slice(0,200)+'…[共 '+v.length+' 字符]';return v;}
    if(depth>10)return '[层级过深]';
    if(Array.isArray(v))return v.slice(0,200).map(x=>trimRaw(x,depth+1));
    const out={};
    for(const [k,x] of Object.entries(v).slice(0,300)){
      if(RAW_DROP.test(k)){out[k]='[已省略 '+(typeof x==='string'?x.length+' 字符':Array.isArray(x)?x.length+' 项':typeof x)+']';continue;}
      out[k]=trimRaw(x,depth+1);
    }
    return out;
  }
  function trimSpan(data) {
    const out={};for(const k of ['spanId','parentId','runId','message','startTime','durationMs','isPartial','isError','isCancelled','level','entityType'])if(data?.[k]!==undefined)out[k]=data[k];
    if(data?.properties!==undefined)out.properties=trimRaw(object(data.properties));if(data?.ai&&typeof data.ai==='object')out.ai=trimRaw(data.ai);return out;
  }
  function sanitizeRaw(raw) {
    if(!raw||typeof raw!=='object')return {events:[],spans:{}};
    let events=(Array.isArray(raw.events)?raw.events:[]).slice(0,2400).filter(e=>e&&typeof e==='object').map(e=>({spanId:SPAN.test(e.spanId||'')?e.spanId:null,parentId:typeof e.parentId==='string'?e.parentId.slice(0,64):null,message:label(e.message)||'',at:number(e.at),durationMs:typeof e.durationMs==='number'&&Number.isFinite(e.durationMs)?e.durationMs:null,isPartial:e.isPartial===true,isError:e.isError===true,isCancelled:e.isCancelled===true,level:label(e.level),model:label(e.model),totalLabel:label(e.totalLabel),icon:label(e.icon),kind:['marker','stream','usage','cost'].includes(e.kind)?e.kind:null}));
    let size=JSON.stringify(events).length;if(size>RAW_PERSIST_BYTES/2){events=[...events.slice(0,300),...events.slice(-300)];size=JSON.stringify(events).length;}
    const spans={};
    for(const [id,v] of Object.entries(raw.spans&&typeof raw.spans==='object'?raw.spans:{}).slice(0,64)){if(!SPAN.test(id)||!v||typeof v!=='object')continue;const t=trimRaw(v), n=JSON.stringify(t).length;if(size+n>RAW_PERSIST_BYTES)continue;spans[id]=t;size+=n;}
    // 探测结果（run 记录 / 元数据 / 会话记录）：只保留状态与精简后的正文
    let probe=null;
    if(raw.probe&&typeof raw.probe==='object'){probe={};for(const k of ['run','metadata','session','cost']){const v=raw.probe[k];if(!v||typeof v!=='object')continue;const row={status:number(v.status)??0,at:typeof v.at==='string'?v.at.slice(0,40):null};if(typeof v.error==='string')row.error=v.error.slice(0,200);if(v.data!==undefined){const t=trimRaw(v.data);if(JSON.stringify(t).length<=65536)row.data=t;else row.error='已省略（超过 64 KB）';}probe[k]=row;}if(!Object.keys(probe).length)probe=null;}
    return {events,spans,probe};
  }
  // 从 /in/append 载荷提取用户消息开头（≤40 字），用于在轮次列表里辨认是哪个问题。
  function promptPreview(j) {
    let found=null;
    (function walk(n,depth){if(found||!n||typeof n!=='object'||depth>7)return;if(Array.isArray(n)){for(const v of n){walk(v,depth+1);if(found)return;}return;}
      if(n.role&&n.role!=='user')return;
      for(const [k,v] of Object.entries(n))if(typeof v==='string'&&/^(text|content|prompt|message|input)$/.test(k)&&v.trim()){found=v;return;}
      for(const v of Object.values(n)){walk(v,depth+1);if(found)return;}})(j,0);
    return found?found.replace(/[\x00-\x1f\x7f]+|\s+/g,' ').trim().slice(0,40)||null:null;
  }
  // 消息 id 是页面用 UUIDv7 生成的：前 48 位为 Unix 毫秒时间戳（版本位为 7 才解析）
  function uuidTime(id) {
    if(typeof id!=='string')return null;const m=/^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(id.trim());if(!m)return null;
    const ms=parseInt(m[1]+m[2],16);return ms>1262304000000&&ms<4102444800000?ms:null;
  }
  const pad2=n=>String(n).padStart(2,'0');
  function stamp(ms,now=Date.now()) {
    if(!Number.isFinite(ms))return null;const d=new Date(ms),n=new Date(now),date=pad2(d.getMonth()+1)+'-'+pad2(d.getDate()),time=pad2(d.getHours())+':'+pad2(d.getMinutes());
    return (d.getFullYear()===n.getFullYear()?date:d.getFullYear()+'-'+date)+' '+time;
  }
  const fullStamp=ms=>Number.isFinite(ms)?new Date(ms).toLocaleString('zh-CN',{hour12:false}):null;
  // create-chat 响应头里的应用层限流：ratelimit-limit / remaining / reset（Unix 秒）/ retry-after（秒）
  // 429 正文的分类沿用页面自己的规则：每日 Agent 消息上限（100 条 / 24 小时）、每日花费上限、按模型限流、其余为通用限流
  const AGENT_DAILY_TEXT="You've reached the daily limit of 100 agent messages. Please try again later.";
  function quotaReason(body){
    if(typeof body!=='string'||!body.trim())return null;let j=null;try{j=JSON.parse(body);}catch{}
    const msg=j&&typeof j==='object'?(typeof j.error==='string'?j.error:typeof j.message==='string'?j.message:null):body.trim().slice(0,200);
    if(j&&typeof j==='object'&&typeof j.modelId==='string')return {kind:'model',reason:'该模型限流'+(label(j.modelId)?' · '+j.modelId.slice(0,60):'')};
    if(msg===AGENT_DAILY_TEXT)return {kind:'agent-daily',reason:'每日 Agent 消息上限（100 条 / 24 小时）'};
    if(msg==='daily spend limit reached')return {kind:'daily-spend',reason:'每日花费上限'};
    if(!msg||/^too many requests\.?$/i.test(msg)||/^</.test(msg))return null;
    return {kind:'generic',reason:label(msg.slice(0,160))};
  }
  function quotaOf(headers,status,now=Date.now(),body=null) {
    const h=k=>{const v=typeof headers?.get==='function'?headers.get(k):headers?.[k];return v===null||v===undefined?null:String(v);};
    const int=v=>v!==null&&/^\d{1,12}$/.test(v.trim())?Number(v.trim()):null;
    const limit=int(h('ratelimit-limit')),remaining=int(h('ratelimit-remaining')),reset=int(h('ratelimit-reset')),retry=int(h('retry-after'));
    if(limit===null&&remaining===null&&reset===null&&retry===null&&status!==429)return null;
    const retryDate=retry===null&&h('retry-after')?Date.parse(h('retry-after')):NaN;
    const resetAt=reset!==null?(reset>1e11?reset:reset>1e9?reset*1000:now+reset*1000):retry!==null?now+retry*1000:Number.isFinite(retryDate)&&retryDate>now?retryDate:null;
    // ratelimit-policy（如 "10;w=60"）给出窗口长度；服务端不一定发
    const policy=h('ratelimit-policy'),win=policy&&/(?:^|[;,\s])w=(\d{1,8})/.exec(policy),why=status===429?quotaReason(body):null;
    return {at:now,status:number(status)??null,limit,remaining,resetAt,blocked:status===429,window:win?Number(win[1]):null,kind:why?.kind||null,reason:why?.reason||null};
  }
  // 剩余时间的口语化：1 分钟内 / N 分钟后 / 当天 HH:mm / 跨天日期
  const until=(ms,now=Date.now())=>{const d=ms-now;return d<60000?'1 分钟内':d<3600000?Math.ceil(d/60000)+' 分钟后':(d<86400000?new Date(ms).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'}):stamp(ms,now))+' ';};
  // 限流状态的展示。窗口内：剩余/上限；窗口过后不再隐藏，按上限显示并标注“已重置”（推断值，下次观测时更新）；429 解除后同样保留
  function quotaView(q,kind,now=Date.now(),showReset=false){
    if(!q)return null;const label=kind==='chat'?'新会话':'消息',daily=q.kind==='agent-daily'||q.kind==='daily-spend',live=q.resetAt?q.resetAt>now:now-q.at<(daily?86400000:60000);
    const base=(kind==='chat'?'来自 create-chat 响应头 ratelimit-*；服务端按窗口计数，本机各标签页共享同一份记录':'来自 /in/append 响应头 ratelimit-*')+' · 记录于 '+new Date(q.at).toLocaleTimeString('zh-CN',{hour12:false})+(q.window?' · 窗口 '+q.window+' 秒':'')+(q.reason?' · '+q.reason:'');
    if(q.blocked){
      if(live)return {label,value:'限流中',tail:(q.resetAt?' · '+until(q.resetAt,now)+'解除':daily?' · 解除时间未知':'')+(q.kind==='agent-daily'?' · 每日上限':q.kind==='daily-spend'?' · 花费上限':''),cls:'blocked',title:base};
      if(q.limit===null||kind!=='chat')return now-(q.resetAt||q.at)<600000?{label,value:'已解除限流',tail:'',cls:'muted',title:base}:null;
      if(!showReset)return null;
      return {label,value:q.limit+'/'+q.limit,tail:' · 已解除',cls:'muted',title:base+' · 解除后按上限显示，属推断值'};
    }
    if(q.limit===null&&q.remaining===null)return null;
    if(live){const low=q.remaining!==null&&q.limit&&q.remaining<=Math.max(2,Math.floor(q.limit*0.2));return {label,value:(q.remaining??'?')+'/'+(q.limit??'?'),tail:q.resetAt?' · '+until(q.resetAt,now)+'重置':'',cls:low?'low':'',title:base};}
    // 只有新会话限流在窗口过后仍保留（它只能在新建会话时观测到）；消息限流窗口过后隐藏
    // “已重置”只是推断值，默认不显示（设置里可打开）
    if(kind!=='chat'||!showReset)return null;
    return {label,value:(q.limit??'?')+'/'+(q.limit??'?'),tail:' · 已重置',cls:'muted',title:base+' · 窗口已过，按上限显示，属推断值；下次新建会话时更新'};
  }
  // 花费记录（spend.recorded）里的费用类字段：键名含 cost/usd/credit/price/charge 等的数字，以及 strategy/source/currency 类短字符串。字段名不做假设，原样列出
  const COST_KEY=/(cost|usd|credit|price|charg|amount|cents?$|multiplier|margin|discount|rate$)/i;
  function costFields(node,path='$.properties',out=[],depth=0){
    if(!node||typeof node!=='object'||Array.isArray(node)||depth>3||out.length>=24)return out;
    for(const [key,raw] of Object.entries(node).slice(0,120)){
      if(!/^[\w.-]{1,120}$/.test(key)||RAW_DROP.test(key))continue;let v=raw;if(v&&typeof v==='object'&&Object.keys(v).length===1&&'stringValue' in v)v=v.stringValue;
      if(typeof v==='string'&&/^[\[{]/.test(v)&&v.length<65536&&/(cost|price|charge|usage|billing|pricing|credit)/i.test(key)){try{v=JSON.parse(v);}catch{}}
      const p=path+'.'+key;
      if(typeof v==='number'&&Number.isFinite(v)){if(COST_KEY.test(key))out.push({path:p,key,value:v});}
      else if(typeof v==='string'){if(v.length<=80&&/^(pricingStrategy|strategy|source|currency|billingMode|plan|tier)$/i.test(key))out.push({path:p,key,value:v});}
      else if(v&&typeof v==='object')costFields(v,p,out,depth+1);
      if(out.length>=24)break;
    }
    return out;
  }
  // 页面自带的费用接口 GET /api/chat/{id}/cost：messages 以助手消息节点 id 为键；1 美元 = 1000 credits（页面常量），优先用 totalChargedCredits
  const CREDITS_PER_USD=1000;
  const usdOf=e=>[e?.totalChargedUsd,e?.totalCharged,e?.charged?.totalCostUsd].find(v=>typeof v==='number'&&Number.isFinite(v))??null;
  function creditsOf(e){if(typeof e?.totalChargedCredits==='number'&&Number.isFinite(e.totalChargedCredits))return e.totalChargedCredits;const usd=usdOf(e);return usd===null?null:usd*CREDITS_PER_USD;}
  function costSummary(j){
    if(!j||typeof j!=='object')return null;const s=j.session&&typeof j.session==='object'?j.session:null,msgs=j.messages&&typeof j.messages==='object'&&!Array.isArray(j.messages)?j.messages:null;
    if(!s&&!msgs)return null;const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null,entries={};
    for(const [k,e] of Object.entries(msgs||{}).slice(0,2000)){if(!/^[\w-]{1,128}$/.test(k)||!e||typeof e!=='object')continue;entries[k]={credits:creditsOf(e),usd:usdOf(e),actualUsd:num(e.actual?.totalCostUsd),baseUsd:num(e.basePriceUsd),strategy:label(e.pricingStrategy),multiplier:num(e.costMultiplier),margin:num(e.marginMultiplier),fallback:e.actual?.isFallback===true,source:label(e.actual?.source)};}
    const agg=s?.aggregate&&typeof s.aggregate==='object'?s.aggregate:null;
    const session=s?{actualUsd:num(s.actualTotalUsd),chargedUsd:num(s.chargedTotalUsd),messages:num(s.messageCount),credits:agg&&creditsOf(agg)!==null?creditsOf(agg):num(s.chargedTotalUsd)!==null?s.chargedTotalUsd*CREDITS_PER_USD:null}:null;
    return {session,entries};
  }
  // 本轮消耗：优先取本轮消息 id 命中的条目（流里的 messageId / nodeId、用量记录的 messageId、页面最后一条助手消息）；否则取“提交时未见过的新条目”；再否则取会话累计的差值
  function resolveTurnCredits({entries={},candidates=[],strong=[],before=null,sessionBefore=null,session=null}){
    const sum=keys=>{let credits=0,usd=0,actual=0,ok=false;const parts=[];for(const k of keys){const e=entries[k];if(!e||e.credits===null)continue;ok=true;credits+=e.credits;usd+=e.usd??0;actual+=e.actualUsd??0;parts.push({key:k,credits:e.credits,usd:e.usd,actualUsd:e.actualUsd,strategy:e.strategy,multiplier:e.multiplier,margin:e.margin,fallback:e.fallback});}return ok?{credits,usd,actualUsd:actual,parts}:null;};
    // strong：来自本轮 Trace 记录的消息 id，直接认；candidates：流里收集的 id，基线里已有的条目属于之前的轮次（重连回放的旧帧可能混入），排除
    const seen=new Set(),pick=(list,strict)=>list.filter(k=>typeof k==='string'&&entries[k]&&!(strict&&before instanceof Set&&before.has(k))&&!seen.has(k)&&seen.add(k));
    let ids=pick(strong,false),r=sum(ids);if(r)return {...r,source:'message',keys:ids};
    ids=pick(candidates,true);r=sum(ids);if(r)return {...r,source:'message',keys:ids};
    if(before instanceof Set){const fresh=Object.keys(entries).filter(k=>!before.has(k));r=sum(fresh);if(r)return {...r,source:'new',keys:fresh};}
    if(sessionBefore&&session&&sessionBefore.credits!==null&&session.credits!==null&&session.credits>sessionBefore.credits)return {credits:session.credits-sessionBefore.credits,usd:session.chargedUsd!==null&&sessionBefore.chargedUsd!==null?session.chargedUsd-sessionBefore.chargedUsd:null,actualUsd:session.actualUsd!==null&&sessionBefore.actualUsd!==null?session.actualUsd-sessionBefore.actualUsd:null,parts:[],source:'session',keys:[]};
    return null;
  }
  // 本地标题取名：优先带推理强度后缀的内部名称，一旦取到就锁定；否则用首个内部名称，再退回请求型号。
  function pickName(s) {
    // v1.11.78 改派过的一轮只认改派后的调用（失败的原模型的请求名 / 内部名都不算）；请求名取最后一次回答的调用
    const serving=servingCalls(s),routed=serving.length!==(s?.calls||[]).length||!!s?.routing;
    const names=routed?[...new Set(serving.map(c=>c.internal).filter(Boolean))]:Array.isArray(s?.internalNames)?s.internalNames.filter(Boolean):[], withSuffix=names.find(n=>hint(n,null).value), internal=withSuffix||names[0]||null;
    if(internal)return {name:noVertex(internal),source:'internal',locked:!!withSuffix};
    const request=serving.slice().reverse().map(c=>c.request||c.model).find(n=>n&&n!=='未提供');
    return request?{name:request,source:'request',locked:false}:null;
  }
  function nextName(old,pick) {
    if(!pick)return old?.name?old:null;
    if(old?.locked&&old.name)return old;
    if(!old?.name||pick.locked||old.source==='request'&&pick.source==='internal')return pick;
    return old;
  }
  function localSnapshot(s) {
    if(!s||![1,2].includes(s.version)||!/^\w[\w-]{0,127}$/.test(s.sid||'')||!RUN.test(s.runId||'')||!Array.isArray(s.calls))return null;
    const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
    const evidence=items=>(Array.isArray(items)?items:[]).slice(0,128).flatMap(e=>{if(!e||typeof e.path!=='string'||e.path.length>2000||!/^\$[\w.-]*$/.test(e.path))return[];const x={source:['span','record','providerMetadata','页面请求'].includes(e.source)?e.source:'未知来源',path:e.path};if(e.kind==='effort')return[{...x,kind:'effort',value:LEVELS.includes(e.value)?e.value:null}];if(e.kind==='budget')return Number.isSafeInteger(e.value)&&e.value>=-1?[{...x,kind:'budget',value:e.value}]:[];if(e.kind==='mode')return['enabled','disabled','adaptive'].includes(e.value)?[{...x,kind:'mode',value:e.value}]:[];return number(e.value)!==null?[{...x,kind:['input','output','total','reasoning'].includes(e.kind)?e.kind:'token',value:e.value}]:[];});
    const calls=s.calls.slice(0,TURN_CALL_LIMIT).filter(c=>c&&SPAN.test(c.id||'')).map(c=>{const request=label(c.request),internal=label(c.internal);return{id:c.id,at:iso(c.at),model:label(c.model)||'未提供',request,response:label(c.response),internal,internalScope:['call','turn'].includes(c.internalScope)?c.internalScope:internal?'turn':null,route:label(c.route),adapter:label(c.adapter),finish:label(c.finish),hint:hint(internal,request),effort:effort(evidence(c.effort?.evidence)),reasoning:reported(evidence(c.reasoning?.evidence)),tokens:{input:number(c.tokens?.input),output:number(c.tokens?.output),total:number(c.tokens?.total),cacheRead:number(c.tokens?.cacheRead),cacheWrite:number(c.tokens?.cacheWrite)},tokenSources:evidence(c.tokenSources),totalLabel:label(c.totalLabel),settings:Object.fromEntries(['temperature','topP','maxOutputTokens'].filter(k=>typeof c.settings?.[k]==='number'&&Number.isFinite(c.settings[k])).map(k=>[k,c.settings[k]])),cost:typeof c.cost==='number'&&Number.isFinite(c.cost)&&c.cost>=0?c.cost:null,partial:c.partial===true,failed:c.failed===true};});
    if(!calls.length)return null;
    const key=typeof s.key==='string'&&/^run_[\w-]{1,100}:[\w-]{1,40}$/.test(s.key)?s.key:s.runId+':'+calls[0].id;
    const rawRecords=Array.isArray(s.records)?s.records:s.turnUsage&&typeof s.turnUsage==='object'?[{...s.turnUsage,id:null,kind:'usage'}]:[];
    const mid=v=>typeof v==='string'&&/^[\w-]{4,128}$/.test(v)?v:null,fnum=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
    const records=rawRecords.slice(0,TURN_CALL_LIMIT).filter(r=>r&&typeof r==='object').map(r=>({id:SPAN.test(r.id||'')?r.id:null,at:iso(r.at),kind:r.kind==='cost'?'cost':'usage',internal:label(r.internal),messageId:mid(r.messageId),input:number(r.input),output:number(r.output),reasoning:number(r.reasoning),total:number(r.total),cacheRead:number(r.cacheRead),cacheWrite:number(r.cacheWrite)}));
    const costs=(Array.isArray(s.costs)?s.costs:[]).slice(0,4).filter(c=>c&&typeof c==='object').map(c=>({id:SPAN.test(c.id||'')?c.id:null,at:iso(c.at),internal:label(c.internal),messageId:mid(c.messageId),fields:(Array.isArray(c.fields)?c.fields:[]).slice(0,24).flatMap(f=>f&&typeof f.path==='string'&&/^\$[\w.-]{0,400}$/.test(f.path)&&typeof f.key==='string'&&f.key.length<=120&&(fnum(f.value)!==null||label(f.value))?[{path:f.path,key:f.key,value:fnum(f.value)??label(f.value)}]:[])}));
    const c=s.credits&&typeof s.credits==='object'?s.credits:null,credits=c?(()=>{const out={credits:fnum(c.credits),usd:fnum(c.usd),actualUsd:fnum(c.actualUsd),source:['message','new','session'].includes(c.source)?c.source:null,keys:(Array.isArray(c.keys)?c.keys:[]).filter(k=>typeof k==='string'&&/^[\w-]{1,128}$/.test(k)).slice(0,8),parts:(Array.isArray(c.parts)?c.parts:[]).slice(0,8).filter(p=>p&&typeof p==='object').map(p=>({key:typeof p.key==='string'&&/^[\w-]{1,128}$/.test(p.key)?p.key:null,credits:fnum(p.credits),usd:fnum(p.usd),actualUsd:fnum(p.actualUsd),strategy:label(p.strategy),multiplier:fnum(p.multiplier),margin:fnum(p.margin),fallback:p.fallback===true})),session:c.session&&typeof c.session==='object'?{credits:fnum(c.session.credits),chargedUsd:fnum(c.session.chargedUsd),actualUsd:fnum(c.session.actualUsd),messages:fnum(c.session.messages)}:null,balance:c.balance&&typeof c.balance==='object'?{before:fnum(c.balance.before),beforeAt:iso(c.balance.beforeAt),after:fnum(c.balance.after),afterAt:iso(c.balance.afterAt),delta:fnum(c.balance.delta)}:null,at:iso(c.at)};return out.credits!==null||out.session||out.balance?out:null;})():null;
    return{version:2,key,sid:s.sid,runId:s.runId,turn:number(s.turn),attempt:number(s.attempt)||1,segment:number(s.segment)||0,resumed:s.resumed===true,at:iso(s.at)||new Date().toISOString(),startedAt:iso(s.startedAt),revision:number(s.revision)||0,prompt:typeof s.prompt==='string'?s.prompt.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,40):null,sentAt:iso(s.sentAt),calls,count:number(s.count)??calls.length,prior:number(s.prior)||0,internalNames:(Array.isArray(s.internalNames)?s.internalNames:[]).map(label).filter(Boolean).slice(0,6),records,costs,credits,routing:s.routing&&typeof s.routing==='object'?{from:label(s.routing.from),to:label(s.routing.to),waitMs:number(s.routing.waitMs),at:iso(s.routing.at),committed:s.routing.committed===true,reason:typeof s.routing.reason==='string'?s.routing.reason.slice(0,300):null,cause:typeof s.routing.cause==='string'?s.routing.cause.slice(0,120):null}:null,failover:s.failover&&typeof s.failover==='object'?{pending:s.failover.pending===true,at:iso(s.failover.at)}:null,outcome:['failed','empty'].includes(s.outcome)?s.outcome:null,partial:s.partial===true,raw:sanitizeRaw(s.raw)};
  }

  // 2. 逐行解析；一条坏消息不应终止整个读流循环。
  class Lines {
    constructor(onJSON,onIssue=()=>{}){this.onJSON=onJSON;this.onIssue=onIssue;this.decoder=new TextDecoder();this.buffer='';this.pending='';this.discard=false;}
    feed(bytes){
      const text=typeof bytes==='string'?bytes:this.decoder.decode(bytes,{stream:true});this.buffer+=text;
      let i;while((i=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,i).replace(/\r$/,'');this.buffer=this.buffer.slice(i+1);if(this.discard){this.discard=false;continue;}this.line(line);}
      if(this.buffer.length>2*1024*1024){this.buffer='';this.pending='';this.discard=true;this.onIssue('单行过大，已跳过；后续流仍继续解析');}
    }
    line(line){
      let s=line.trim();if(!s){this.pending='';return;}if(/^(event:|id:|retry:|:)/.test(s))return;
      if(s.startsWith('data:'))s=s.slice(5).trim();if(!s||s==='[DONE]')return;
      let value;try{value=JSON.parse(this.pending?this.pending+'\n'+s:s);this.pending='';}catch{if((this.pending||/^[\[{]/.test(s))&&this.pending.length+s.length<2*1024*1024)this.pending=this.pending?this.pending+'\n'+s:s;return;}
      try{this.onJSON(value);}catch(e){this.onIssue('帧处理异常',e);}
    }
    end(){if(!this.discard&&this.buffer.trim())this.line(this.buffer);this.buffer='';this.pending='';}
  }
  function inspect(node,onToken,onType,depth=0) {
    if(!node||typeof node!=='object'||depth>6)return;
    if(Array.isArray(node)){for(const v of node.slice(0,3000))inspect(v,onToken,onType,depth+1);return;}
    const headers=Array.isArray(node.headers)?node.headers:node.headers&&typeof node.headers==='object'?Object.entries(node.headers):[];
    for(const h of headers)if(Array.isArray(h)&&String(h[0]).toLowerCase()==='public-access-token'&&typeof h[1]==='string')onToken(h[1]);
    if(typeof node.type==='string'&&/^(start|start-step|finish|finish-step|text-start|text-delta|text-end|reasoning-start|reasoning-delta|reasoning-end|message-metadata|error|abort)$/.test(node.type))onType(node.type,node);
    if(Array.isArray(node.records))inspect(node.records,onToken,onType,depth+1);
    for(const key of ['body','data','message','response','payload','event']) {
      let v=node[key];if(typeof v==='string'&&/^[\[{]/.test(v.trim())){try{v=JSON.parse(v);}catch{continue;}}
      if(v&&typeof v==='object')inspect(v,onToken,onType,depth+1);
    }
    // 正文 delta 字符串不会被当作协议对象解析。
  }

  // ---------- 实时监控 · 纯函数 ----------
  // 页面 useChat 状态里的助手消息（AI SDK v5 UIMessage.parts）压成“步骤摘要”：step-start 分隔一次模型调用；
  // 有文字的 reasoning = 可见思考链，tool-* / dynamic-tool = 工具调用（bash 等），text = 正文。
  const monTool=t=>t==='dynamic-tool'||/^tool-/.test(t);
  const monMedian=a=>{const v=(a||[]).filter(x=>Number.isFinite(x)).sort((x,y)=>x-y);if(!v.length)return 0;const m=v.length>>1;return v.length%2?v[m]:(v[m-1]+v[m])/2;};
  function monMetaModel(meta){
    if(!meta||typeof meta!=='object')return null;
    for(const k of ['model','modelId','modelName','model_id','model_name','apiModelName','internalModelName']){const v=meta[k];if(typeof v==='string'&&v.length<=120&&/[a-z]/i.test(v))return v;if(v&&typeof v==='object')for(const j of ['id','name','slug'])if(typeof v[j]==='string'&&v[j].length<=120&&/[a-z]/i.test(v[j]))return v[j];}
    return null;
  }
  function liveMsg(msg){
    const parts=Array.isArray(msg?.parts)?msg.parts:[],steps=[];let st=null,fr=-1,ft=-1;
    const open=()=>{st={r:0,rc:0,t:0,tools:[],live:false};steps.push(st);};
    parts.forEach((p,i)=>{
      if(!p||typeof p!=='object')return;const t=String(p.type||'');
      if(t==='step-start'){open();return;}if(!st)open();
      const txt=typeof p.text==='string'?p.text:'';
      if(/^reasoning|thinking/.test(t)){if(txt.trim()){st.r++;st.rc+=txt.length;if(fr<0)fr=i;}}
      else if(t==='text'){st.t+=txt.length;if(ft<0&&txt.trim())ft=i;}
      else if(monTool(t))st.tools.push(String(p.toolName||t.slice(5)||'tool').slice(0,32));
      const ps=String(p.state||'');if(ps==='streaming'||monTool(t)&&/^input-/.test(ps))st.live=true;
    });
    const fs=steps.findIndex(x=>x.r>0);
    return {id:String(msg?.id||''),steps,n:steps.length,think:steps.filter(x=>x.r).length,rc:steps.reduce((a,x)=>a+x.rc,0),tc:steps.reduce((a,x)=>a+x.t,0),tools:steps.reduce((a,x)=>a+x.tools.length,0),live:steps.some(x=>x.live),
      midText:fr>=0&&ft>=0&&fr>ft,firstThink:fs,before:fs>0?steps.slice(0,fs).filter(x=>x.t||x.tools.length).length:0,model:monMetaModel(msg?.metadata)};
  }
  // 本条回复 cur 相对此前各轮 prev 的疑点。level：strong 基本可判定换了模型 / medium 可疑 / weak 仅供参考
  function liveFlags(prev,cur,done){
    const out=[];if(!cur||!cur.n)return out;
    const hist=(prev||[]).filter(m=>m&&m.n).slice(-12),th=hist.filter(m=>m.think).length,no=hist.length-th;
    if(cur.think&&th===0){
      const midStep=cur.firstThink>0&&cur.before>0;
      if(cur.midText||midStep)out.push({kind:'think-mid',level:cur.midText||no>=1?'strong':'medium',text:cur.midText?'回复中途出现思考链':'第 '+(cur.firstThink+1)+' 步开始出现思考链',detail:(cur.midText?'先输出了正文，之后才开始思考':'前 '+cur.firstThink+' 步都没有思考')+(no?'；此前 '+no+' 轮也都没有':'')});
      // v1.11.77 一开始就在思考不算换模型的强信号（只记录 + 补读 Trace 核对，不弹提示、不自动停）；
      // 强信号只有“回复先出正文、过一会儿才出现思考链”（上面的 think-mid）
      else if(no>=2)out.push({kind:'think-new',level:'medium',text:'思考链出现：此前 '+no+' 轮都没有',detail:'这一轮从一开始就在思考；只作参考，已补读 Trace 核对型号'});
      else if(no===1)out.push({kind:'think-new',level:'medium',text:'思考链出现：上一轮没有',detail:'再观察一轮会更可靠'});
    }else if(!cur.think&&done&&th>=2&&no===0)out.push({kind:'think-gone',level:'medium',text:'思考链消失：此前 '+th+' 轮都有',detail:'可能换了模型或降了档位，也可能只是这轮不需要思考'});
    const per=m=>m.think?m.rc/m.think:0,withT=hist.filter(m=>m.think),base=monMedian(withT.map(per));
    if(cur.think&&(done||cur.think>=3)&&withT.length>=2&&base>=600){const v=per(cur),k=v/base,d='每步思考约 '+Math.round(v)+' 字，此前中位 '+Math.round(base)+' 字';
      if(k<=0.25)out.push({kind:'think-drop',level:'medium',text:'思考强度骤降 ↓'+Math.round((1-k)*100)+'%',detail:d});
      else if(k>=4)out.push({kind:'think-rise',level:'weak',text:'思考强度骤增 ×'+(Math.round(k*10)/10),detail:d});}
    return out;
  }
  // Trace 调用级：同一模型内的档位变化（显式参数 / 内部名称后缀）、单次调用消耗（输出 + 推理 token）与输出速度的突变
  function traceShift(calls,same,tierOf){
    const list=Array.isArray(calls)?calls:[],tiers=[];let pv=null;
    for(const c of list){const t=c.eff||(c.internal?tierOf(c.internal):null)||null;if(!t)continue;if(pv&&pv.t!==t&&same(pv.c,c))tiers.push({from:pv.t,to:t,at:c.at??null,turn:c.turn??null,attempt:c.attempt??null,n:c.n??null});pv={t,c};}
    const done=list.filter(c=>!c.partial&&Number.isFinite(c.out)),key=c=>(c.run||'trace')+':'+c.turn+':'+c.attempt,lk=done.length?key(done.at(-1)):null;
    const cur=done.filter(c=>key(c)===lk),base=done.filter(c=>key(c)!==lk).slice(-40),v=c=>c.out+(Number.isFinite(c.rsn)?c.rsn:0);
    let shift=null,speed=null;
    if(cur.length&&base.length>=3){const b=monMedian(base.map(v)),x=monMedian(cur.map(v)),k=b?x/b:0,sm=same(base.at(-1),cur.at(-1));
      if(b>=1500&&k<=0.3)shift={kind:'drop',base:b,cur:x,ratio:k,same:sm,turn:cur[0].turn??null,attempt:cur[0].attempt??null};
      else if(x>=1500&&b>0&&k>=3.5)shift={kind:'rise',base:b,cur:x,ratio:k,same:sm,turn:cur[0].turn??null,attempt:cur[0].attempt??null};}
    const tb=base.map(c=>c.tps).filter(x=>Number.isFinite(x)&&x>0),tc=cur.map(c=>c.tps).filter(x=>Number.isFinite(x)&&x>0);
    if(tb.length>=3&&tc.length){const b=monMedian(tb),x=monMedian(tc),k=x/b;if(k>=2.5||k<=0.4)speed={base:b,cur:x,ratio:k,turn:cur[0].turn??null,attempt:cur[0].attempt??null};}
    return {tiers,shift,speed};
  }
  // 观察到的思考强度（推理 token）分 0–4 级
  const thinkLevel=t=>t===null||t===undefined||t===''||!Number.isFinite(+t)?null:+t<=0?0:+t<1000?1:+t<4000?2:+t<16000?3:4;
  if(typeof window==='undefined'){if(typeof module!=='undefined')module.exports={get,authorized,configs,effort,hint,reported,plan,detail,snapshot,Lines,inspect,sidOf,streamSid,localSnapshot,pickName,nextName,promptPreview,trimRaw,trimSpan,sanitizeRaw,toMs,toDurationMs,uuidTime,stamp,quotaOf,quotaView,until,costFields,costSummary,creditsOf,resolveTurnCredits,CREDITS_PER_USD,BUDGET_OPTIONS,liveMsg,liveFlags,traceShift,thinkLevel,monMedian};return;}
  if(window.top!==window.self)return;
  if(window.__AMP_LITE__?.version===VERSION)return;
  window.__AMP_LITE__?.stop?.();

  // 3. 页面上下文原生 fetch：不使用 unsafeWindow、GM 请求或跨上下文桥。
  let native=window.fetch;
  for(let i=0;i<8&&native?.__orig&&native.__orig!==native;i++)native=native.__orig;
  const rawFetch=native.bind(window), runs=new Map(), submissions=new Map(), readers=new Set(), logs=[], rawStore=new Map(), recentPosts=new Map(), contSeen=new Map();
  const load=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
  const store=(key,value)=>{try{return ampStore.set(key,JSON.stringify(value));}catch{return false;}};
  const clamp=(v,min,max,fallback)=>Number.isFinite(v)?Math.min(max,Math.max(min,Math.round(v))):fallback;
  const stored=load(KEY+'.prefs',{}), prefs={width:clamp(stored.width,280,720,340),sidebarWidth:clamp(stored.sidebarWidth,200,560,null),cloudSync:stored.cloudSync===true,cloudFormat:stored.cloudFormat==='name'?'name':'prefix',rawBudget:BUDGET_OPTIONS.includes(stored.rawBudget)?stored.rawBudget:64,showSent:stored.showSent!==false,showQuota:stored.showQuota!==false,showCredits:stored.showCredits!==false,showBar:stored.showBar!==false,barCollapsed:stored.barCollapsed===true,barOffset:stored.barOffset!==false,showSeq:stored.showSeq===true,hideDocIcon:stored.hideDocIcon!==false,stopOnResample:stored.stopOnResample!==false,showQuotaReset:stored.showQuotaReset===true,spendUnit:stored.spendUnit==='usd'?'usd':'token',sheetH:typeof stored.sheetH==='number'&&stored.sheetH>=0.05&&stored.sheetH<=1?stored.sheetH:0.5,sheetFull:stored.sheetFull===true,pullRefresh:stored.pullRefresh!==false,glassDrawer:stored.glassDrawer!==false,gemLayout:stored.gemLayout!==false,monOn:stored.monOn!==false,monAlert:stored.monAlert!==false,monStop:stored.monStop===true,wsRight:stored.wsRight!==false,wsSwipe:stored.wsSwipe!==false,wsEdge:stored.wsEdge!==false,wsEdgeY:typeof stored.wsEdgeY==='number'&&stored.wsEdgeY>=0.12&&stored.wsEdgeY<=0.88?stored.wsEdgeY:0.6,kbResize:stored.kbResize!==false};
  // 手机/窄屏：底部只留一条余额栏，点击余额栏才展开模型信息
  const miniBar=()=>innerWidth<768||!!document.getElementById('amp-lite-dock')?.hasAttribute('data-compact');
  const savePrefs=()=>store(KEY+'.prefs',prefs);
  let history=load(KEY+'.history',[]);if(!Array.isArray(history))history=[];history=history.map(x=>{const s=localSnapshot(x);return s?{...s,raw:{events:[],spans:{}}}:null;}).filter(Boolean).slice(0,20);
  let stopped=false,enabled=true,cooldown=0,pendingNew=null,lastRoute=location.pathname,frames=0,queries=0,ui=null,paintTimer=0,revision=0,onLog=null,onSnapshot=null,onSent=null;
  // 限流 / 额度状态：服务端按窗口计数、与标签页无关，所以放在 localStorage 并监听 storage 事件同步；窗口过后保留最后一次观测值（见 quotaView）
  const quotaShape=q=>q&&typeof q==='object'?{at:number(q.at)??0,status:number(q.status),limit:number(q.limit),remaining:number(q.remaining),resetAt:number(q.resetAt),blocked:q.blocked===true,window:number(q.window),kind:['agent-daily','daily-spend','model','generic'].includes(q.kind)?q.kind:null,reason:label(q.reason)}:null;
  const balanceShape=b=>b&&typeof b==='object'&&number(b.remaining)!==null?{remaining:number(b.remaining),daily:number(b.daily),refreshAt:number(b.refreshAt),at:number(b.at)??0}:null;
  let quota={chat:quotaShape(load(KEY+'.quota',{})?.chat),append:quotaShape(load(KEY+'.quota',{})?.append)},balance=balanceShape(load(KEY+'.balance',null)),balanceAt=0,balanceFail=0,balanceTimer=0,balanceResetTimer=0;
  const hhmm=ms=>Number.isFinite(ms)?new Date(ms).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit'}):'--:--';
  // 已知不可用的可选接口：记住结果，冷却期内不再请求，也不再刷日志。
  const DENY_KEY='amp.lite.v2.deny';let deny={};try{deny=JSON.parse(localStorage.getItem(DENY_KEY))||{};}catch{}
  const denied=k=>(deny[k]||0)>Date.now();
  function denyFor(k,ms){const first=!denied(k);deny[k]=Date.now()+ms;ampStore.set(DENY_KEY,JSON.stringify(deny));return first;}
  function undeny(k){if(deny[k]){delete deny[k];ampStore.set(DENY_KEY,JSON.stringify(deny));}}
  function errorText(e){const s=(e?.name?e.name+': ':'')+(e?.message||String(e||''));return s.replace(/Bearer\s+\S+|eyJ[\w-]+\.[\w-]+\.[\w-]+/gi,'[令牌已隐藏]').slice(0,200);}
  function log(level,stage,text,e,ctx){const row={at:new Date().toISOString(),level,stage,text:text+(e?' · '+errorText(e):''),sid:ctx?.sid??sidOf(location.href),runId:RUN.test(ctx?.runId||'')?ctx.runId:null,spanId:SPAN.test(ctx?.spanId||'')?ctx.spanId:null};logs.push(row);if(logs.length>600)logs.shift();try{onLog?.(row);}catch{}paint();}
  legacyDisplay.onchange=()=>paint();
  gacha.setPaint(()=>paint());
  // ---------------- 美元额度（移植 probe-usd-stable v2.0.0 usd-quota 规则）----------------
  // 只取最新一轮最后一条 spend.recorded（cost）记录；要求 partial===false、本轮未截断；不回退到更早的轮次。
  const finiteNum=v=>typeof v==='number'&&Number.isFinite(v);
  const usdLabel=v=>typeof v==='string'&&v.length<=120&&!/[\u0000-\u001f\u007f]/.test(v)&&!/Bearer |^eyJ/.test(v)?v:null;
  function usdFields(p){
    const g=k=>get(p,k),out={allowanceUsd:finiteNum(g('allowanceUsd'))&&g('allowanceUsd')>=0?g('allowanceUsd'):null,balanceRemainingUsd:finiteNum(g('balanceRemainingUsd'))?g('balanceRemainingUsd'):null,
      chargedUserTotalUsd:finiteNum(g('chargedUserTotalUsd'))&&g('chargedUserTotalUsd')>=0?g('chargedUserTotalUsd'):null,allowanceTier:usdLabel(g('allowanceTier')),allowanceSource:usdLabel(g('allowanceSource')),
      windowStartAtMs:Number.isSafeInteger(g('windowStartAtMs'))&&g('windowStartAtMs')>=0&&g('windowStartAtMs')<=8640000000000000?g('windowStartAtMs'):null,overLimit:typeof g('overLimit')==='boolean'?g('overLimit'):null,
      costUsd:finiteNum(g('costUsd'))&&g('costUsd')>=0?g('costUsd'):null,chargedUsd:finiteNum(g('chargedUsd'))&&g('chargedUsd')>=0?g('chargedUsd'):null,unpriced:typeof g('unpriced')==='boolean'?g('unpriced'):null};
    return out.allowanceUsd===null&&out.balanceRemainingUsd===null?null:out;
  }
  const usdShape=u=>u&&typeof u==='object'&&finiteNum(u.allowanceUsd)&&finiteNum(u.balanceRemainingUsd)&&number(u.at)!==null?u:null;
  let usd=usdShape(load(KEY+'.usd',null));
  function noteUsd(r,p){
    if(!r?.data||p.limited)return;
    const costs=p.records.filter(e=>e.kind==='cost'),last=costs[costs.length-1];if(!last)return;
    const d=r.cache.get(last.id);if(!d?.available||d.partial||!d.usd)return;
    const u=d.usd;if(!finiteNum(u.allowanceUsd)||u.allowanceUsd<0||!finiteNum(u.balanceRemainingUsd))return;
    const spanAt=last.at||Date.now();if(usd&&usd.spanAt&&spanAt<usd.spanAt)return;
    if(usd&&usd.spanId===last.id)return;
    usd={...u,sid:r.sid,runId:r.runId,turn:p.turn,spanId:last.id,spanAt,at:Date.now()};store(KEY+'.usd',usd);
    log('info','美元额度','剩余 $'+u.balanceRemainingUsd.toFixed(2)+' / 总额度 $'+u.allowanceUsd.toFixed(2)+(u.overLimit?' · 已超限':'')+' · 第 '+(p.turn??'?')+' 轮计费记录',null,r);paint();
  }
  // ---------------- Pulse（/api/me/pulse，与 9.23.2 页脚一致：10 分钟一次；被限流不提前重试）----------------
  const pulseShape=v=>v&&typeof v==='object'&&['ready','signed-out','forbidden','rate-limited','server-error','invalid','network-error','timeout'].includes(v.status)?v:null;
  let pulse=pulseShape(load(KEY+'.pulse',null)),pulseBusy=false;
  async function refreshPulse(force=false){
    if(stopped||!enabled||pulseBusy||!prefs.showBar)return;if(!force&&pulse&&Date.now()-pulse.checkedAt<600000)return;
    pulseBusy=true;const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),8000);let next;
    try{const res=await rawFetch(location.origin+'/api/me/pulse',{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:ctrl.signal});
      if(res.status===401)next={status:'signed-out'};else if(res.status===403)next={status:'forbidden'};else if(res.status===429)next={status:'rate-limited'};else if(!res.ok)next={status:'server-error'};
      else if(!/application\/json/i.test(res.headers.get('content-type')||''))next={status:'invalid'};
      else{const j=await res.json(),ok=Number.isInteger(j?.pulse)&&j.pulse>=0&&j.pulse<=100,t=typeof j?.refreshedAt==='string'&&j.refreshedAt.length<=64?Date.parse(j.refreshedAt):NaN;next=ok?{status:'ready',pulse:j.pulse,refreshedAt:Number.isFinite(t)?t:null}:{status:'invalid'};}
    }catch(e){next={status:ctrl.signal.aborted?'timeout':'network-error'};}
    finally{clearTimeout(timer);pulseBusy=false;}
    // 失败时保留上一次的有效数值，只更新状态
    pulse={...(pulse?.status==='ready'||next.status==='ready'?{pulse:pulse?.pulse,refreshedAt:pulse?.refreshedAt}:{}),...next,checkedAt:Date.now()};store(KEY+'.pulse',pulse);paint();
  }
  // ---------------- 抽卡引擎所需的只读接口 ----------------
  function runFor(sid){
    const r=[...runs.values()].filter(x=>x.sid===sid).at(-1);if(!r)return null;
    const fresh=r.data&&r.data.revision===r.revision;
    return {sid:r.sid,runId:r.runId,submittedAt:r.submittedAt||0,busy:!!r.busy||!!r.timer,phase:r.phase||'',
      data:fresh?{calls:r.data.calls.map(c=>({at:c.at,model:c.model,request:c.request,response:c.response,internal:c.internal,effort:c.effort?.value||null,failed:!!c.failed})),internalNames:[...r.data.internalNames],partial:r.data.partial,routing:r.data.routing||null,failover:r.data.failover||null}:null,prompt:r.prompt||null};
  }
  function huntLive(){
    const blocks=[quota.chat,quota.append].filter(q=>q?.blocked&&(!q.resetAt||q.resetAt>Date.now()));
    return {blocked:Date.now()<cooldown?'Trace 接口限流冷却中（无法识别模型）':blocks.length?'消息额度或速率限制（'+blocks.map(q=>q.reason||('HTTP '+(q.status||429))).join('；')+'）':balance?.remaining===0&&!(balance.refreshAt&&balance.refreshAt<=Date.now())?'账户剩余额度为零':null};
  }
  // ---------------- 底部信息栏 ----------------
  const BAR_H=24;
  let bar=null;
  function mountBar(){
    if(bar||stopped||!document.body)return;
    const host=document.createElement('div');host.id='amp-native-bar';document.body.append(host);const root=host.attachShadow({mode:'open'});
    const barCss=`:host{all:initial;position:fixed;left:0;right:0;bottom:var(--amp-kb-inset,0px);z-index:30;height:${BAR_H}px;display:block;font:400 11px/1 var(--font-basel-grotesk,var(--font-inter,system-ui)),'PingFang SC','Microsoft YaHei',sans-serif;
--bg:hsl(var(--surface-primary,36 45% 98%));--raised:hsl(var(--surface-tertiary,33 31% 94%));--line:hsl(var(--border-faint,30 5% 90%));--fg:hsl(var(--text-primary,24 6% 17%));--muted:hsl(var(--text-tertiary,35 6% 42%));--good:hsl(var(--interactive-positive,125 49% 38%));--warn:hsl(var(--syntax-yellow,40 92% 38%));--bad:#c2410c;color:var(--fg)}
:host([hidden]){display:none!important}:host([data-collapsed]){left:auto;right:8px;bottom:6px;height:auto}
.bar{box-sizing:border-box;height:${BAR_H}px;display:flex;align-items:center;gap:0;padding:0 6px 0 10px;background:var(--bg);border-top:1px solid var(--line);white-space:nowrap;overflow:hidden}
.items{display:flex;align-items:center;min-width:0;flex:1;overflow:hidden;gap:0}
.it{display:inline-flex;align-items:center;gap:4px;padding:0 9px;height:${BAR_H}px;border-left:1px solid var(--line);color:var(--muted);cursor:default;flex:none}
.it:first-child{border-left:0;padding-left:0}.it b{font-weight:500;color:var(--fg);font-variant-numeric:tabular-nums}
.it[data-state=good] b{color:var(--good)}.it[data-state=warn] b{color:var(--warn)}.it[data-state=low] b,.it[data-state=blocked] b{color:var(--bad)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.7}.it[data-state=good] .dot{color:var(--good)}.it[data-state=warn] .dot{color:var(--warn)}.it[data-state=low] .dot{color:var(--bad)}
.meter{width:36px;height:4px;border-radius:2px;background:var(--line);overflow:hidden}.meter i{display:block;height:100%;background:currentColor}
.it[data-state=good] .meter{color:var(--good)}.it[data-state=warn] .meter{color:var(--warn)}.it[data-state=low] .meter{color:var(--bad)}
.it.click{cursor:pointer}.it.click:hover{background:var(--raised)}
.it[data-key=usd] .meter{color:var(--amp-acc,#6a5e54)!important}.it[data-state=good] b,.it[data-state=good] .dot,.it[data-state=good] .meter{color:var(--amp-acc,#6a5e54)!important}.it b.pct{font-weight:600;color:var(--amp-acc,#6a5e54)}.it[data-key=usd]{cursor:default}
.tip{position:fixed;z-index:5;left:8px;bottom:${BAR_H+8}px;display:flex;align-items:center;gap:14px;padding:14px 16px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 28px #0000002a,0 1px 3px #0000000f;font:400 12px/1.4 var(--font-basel-grotesk,var(--font-inter,system-ui)),'PingFang SC','Microsoft YaHei',sans-serif;white-space:nowrap;opacity:0;transform:translateY(6px) scale(.97);transform-origin:bottom left;transition:opacity .18s ease,transform .22s cubic-bezier(.22,.9,.3,1);pointer-events:none}
.tip[data-show]{opacity:1;transform:none}.tip svg{width:88px;height:88px;flex:none;display:block}.tip .arc{transition:stroke-dasharray .6s cubic-bezier(.22,.9,.3,1)}
.tip .pc{font-size:15px;font-weight:700;fill:var(--amp-acc,#6a5e54);font-variant-numeric:tabular-nums}
.tip .info{display:flex;flex-direction:column;gap:2px;min-width:0}.tip .lab{font-size:11px;color:var(--muted)}
.tip .big{font-size:26px;line-height:1.15;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums;color:var(--fg)}
.tip .sub{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}.tip .sub b{font-weight:600;color:var(--fg)}
.tip .foot{font-size:10px;color:var(--muted);margin-top:3px}
@media (prefers-reduced-motion:reduce){.tip,.tip .arc{transition:none}}
.tools{display:flex;align-items:center;gap:2px;flex:none;margin-left:6px}
button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:20px;min-width:20px;padding:0 6px;border-radius:4px;color:var(--muted);cursor:pointer;font:inherit}
button:hover{background:var(--raised);color:var(--fg)}button:focus-visible{outline:2px solid var(--fg);outline-offset:1px}
svg{width:12px;height:12px;display:block}.pill{display:none;border:1px solid var(--line);background:var(--bg);border-radius:12px;padding:4px 8px;box-shadow:0 1px 4px #0001}
:host([data-collapsed]) .bar{display:none}:host([data-collapsed]) .pill{display:inline-flex;gap:6px}
.detail{display:none;flex:none;margin-left:6px;height:18px;padding:0 8px;border-radius:9px;border:1px solid var(--line);color:var(--fg);font-size:11px}:host([data-mini]) .detail{display:inline-flex}:host([data-mini]) .bar{padding-right:6px}:host([data-mini]) .tools{display:none}:host([data-mini]) .bar{cursor:default}:host([data-mini]) .it[data-key=usd]{cursor:pointer}:host([data-mini]) .it{border-left:0;padding:0 8px}:host([data-mini]) .it:first-child{padding-left:0}:host([data-mini]) .meter{width:44px}`;
    let sheet;try{sheet=new CSSStyleSheet();sheet.replaceSync(barCss);root.adoptedStyleSheets=[sheet];}catch{el('style','',barCss,root);}
    const wrap=el('div','bar',null,root),items=el('div','items',null,wrap),tools=el('div','tools',null,wrap);
    // 悬浮美金额度：圆环饼图（余额 / 已用）+ 总额度与余额，替代原来的文字提示。
    const tip=el('div','tip',null,root);tip.setAttribute('role','tooltip');let tipTimer=0;
    function showTip(anchor){
      clearTimeout(tipTimer);if(!usd){tip.removeAttribute('data-show');return;}
      const total=usd.allowanceUsd,rem=usd.balanceRemainingUsd,pct=total>0?Math.max(0,Math.min(100,rem/total*100)):0,used=Math.max(0,total-rem);
      const R=38,C=2*Math.PI*R,f=v=>'$'+(+v).toFixed(2),low=usd.overLimit||pct<20;
      const acc=low?'var(--bad)':'var(--amp-acc,#6a5e54)';
      const fm=v=>'$'+(+v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
      tip.innerHTML='<svg viewBox="0 0 88 88" aria-hidden="true"><circle cx="44" cy="44" r="'+R+'" fill="none" stroke="var(--line)" stroke-width="7"/>'
        +'<circle class="arc" cx="44" cy="44" r="'+R+'" fill="none" stroke="'+acc+'" stroke-width="7" stroke-linecap="round" stroke-dasharray="0 '+C+'" transform="rotate(-90 44 44)"/>'
        +'<text class="pc" x="44" y="44" dy=".35em" text-anchor="middle"'+(low?' style="fill:var(--bad)"':'')+'>'+(Math.round(pct*10)/10)+'%</text></svg>'
        +'<div class="info"><span class="lab">剩余金额</span><span class="big"'+(low?' style="color:var(--bad)"':'')+'>'+fm(rem)+'</span><span class="sub">总额度 <b>'+fm(total)+'</b></span>'
        +'<span class="foot">'+(usd.overLimit?'已超限 · ':'')+'更新于 '+ago(usd.at)+'</span></div>';
      const r=anchor.getBoundingClientRect();tip.style.left=Math.max(8,Math.min(r.left,innerWidth-tip.offsetWidth-8))+'px';
      tip.setAttribute('data-show','');
      requestAnimationFrame(()=>{const a=tip.querySelector('.arc');if(a)a.setAttribute('stroke-dasharray',(C*pct/100).toFixed(1)+' '+C.toFixed(1));});
    }
    const hideTip=()=>{clearTimeout(tipTimer);tipTimer=setTimeout(()=>tip.removeAttribute('data-show'),120);};
    // 手机（窄屏）：点美金只弹出金额卡片；右侧“详细”按钮才打开模型信息
    wrap.onclick=e=>{if(!miniBar())return;const it=e.target.closest?.('.it[data-key=usd]');if(it){e.stopPropagation();if(tip.hasAttribute('data-show'))tip.removeAttribute('data-show');else showTip(it);}};
    const detailBtn=el('button','detail','详细',wrap);detailBtn.title='打开模型信息';detailBtn.onclick=e=>{e.stopPropagation();tip.removeAttribute('data-show');ui?.toggle();};
    document.addEventListener('pointerdown',e=>{if(tip.hasAttribute('data-show')&&!e.composedPath().includes(host))tip.removeAttribute('data-show');},true);
    const pill=el('button','pill','',root);pill.title='展开底部信息栏';pill.onclick=()=>{prefs.barCollapsed=false;savePrefs();sync();};
    const refreshBtn=el('button','','',tools);refreshBtn.title='立即刷新额度、Pulse 与余额';refreshBtn.setAttribute('aria-label',refreshBtn.title);
    refreshBtn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>';
    refreshBtn.onclick=()=>{void refreshBalance(true);void refreshPulse(true);paint();};
    const panelBtn=el('button','','模型信息',tools);panelBtn.title='打开模型信息侧栏';panelBtn.onclick=()=>ui?.show();
    const hideBtn=el('button','','',tools);hideBtn.title='收起底部信息栏';hideBtn.setAttribute('aria-label',hideBtn.title);
    hideBtn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>';hideBtn.onclick=()=>{prefs.barCollapsed=true;savePrefs();sync();};
    const offsetCss=`html[data-amp-bar-offset] body .h-dvh,html[data-amp-bar-offset] body .h-screen,html[data-amp-bar-offset] body .h-svh{height:calc(100dvh - ${BAR_H}px)!important}html[data-amp-bar-offset] body .max-h-dvh,html[data-amp-bar-offset] body .max-h-screen{max-height:calc(100dvh - ${BAR_H}px)!important}html[data-amp-bar-overlap] main{padding-bottom:${BAR_H}px!important;box-sizing:border-box!important}html[data-amp-bar-offset]:not([data-amp-kbhide]) main:is(.min-h-svh,.min-h-dvh,.min-h-screen){padding-bottom:${BAR_H}px!important;box-sizing:border-box!important}`;
    let offsetSheet=null,offsetStyle=null;try{offsetSheet=new CSSStyleSheet();offsetSheet.replaceSync(offsetCss);document.adoptedStyleSheets=[...document.adoptedStyleSheets,offsetSheet];}catch{offsetStyle=el('style','',offsetCss,document.head||document.body);}
    const fmtUsd=v=>(v<0?'-$':'$')+Math.abs(v).toFixed(2),exactUsd=v=>'$'+String(v);
    const clock=t=>Number.isFinite(t)?new Date(t).toLocaleTimeString('zh-CN',{hour12:false}):'--:--:--';
    const ago=t=>{if(!Number.isFinite(t))return '';const d=Date.now()-t;return d<60000?'刚刚':d<3600000?Math.floor(d/60000)+' 分钟前':d<86400000?Math.floor(d/3600000)+' 小时前':Math.floor(d/86400000)+' 天前';};
    let stamp='';
    function item(key,state,parts,title,onclick){return {key,state,parts,title,onclick};}
    function build(){
      const out=[],now=Date.now();
      if(usd){const pct=usd.allowanceUsd>0?usd.balanceRemainingUsd/usd.allowanceUsd*100:null,state=usd.overLimit||usd.balanceRemainingUsd<0?'low':pct===null?'':pct>=50?'good':pct>=20?'warn':'low';
        out.push(item('usd',state,[['meter',pct===null?0:Math.max(0,Math.min(100,pct))],['t','美金 '],['b',fmtUsd(usd.balanceRemainingUsd)],['t',' / '+fmtUsd(usd.allowanceUsd)],['p',pct!==null?' · '+Math.round(pct)+'%':''],['t',usd.overLimit?' · 已超限':'']],
          '美元额度（来自 Trace spend.recorded，最新一轮最后一条已结算记录）\n剩余 '+exactUsd(usd.balanceRemainingUsd)+'\n总额度 '+exactUsd(usd.allowanceUsd)+(usd.chargedUserTotalUsd!==null?'\n窗口内已计费 '+exactUsd(usd.chargedUserTotalUsd):'')+(usd.allowanceTier?'\n档位 '+usd.allowanceTier:'')+(usd.allowanceSource?'\n来源 '+usd.allowanceSource:'')+(usd.windowStartAtMs?'\n窗口开始 '+new Date(usd.windowStartAtMs).toLocaleString('zh-CN',{hour12:false}):'')+(usd.chargedUsd!==null?'\n该条计费 '+exactUsd(usd.chargedUsd):'')+'\n记录于 '+new Date(usd.at).toLocaleString('zh-CN',{hour12:false})+'（'+ago(usd.at)+'）\n每次对话结束后自动更新；这是服务端快照，不是实时余额',miniBar()?()=>ui?.toggle():null));
      }else{let sb=null;try{sb=ui?.spendBrief?.()||null;}catch{}if(sb)out.push(item('spend','',[['t','本对话 '],['b',sb.text]],sb.title,()=>ui?.show('overview')));else out.push(item('usd','',[['t','美金 '],['b','—']],'尚无美元额度快照：完成一轮对话后，从该轮 Trace 的计费记录读取',null));}
      const mini=miniBar();
      // Pulse（GET /api/me/pulse，0–100 的整数）是 Arena 的独立指标，并非美元余额；两者数值相同时并入美金一项，不再重复显示。
      const usdPct=usd&&usd.allowanceUsd>0?Math.round(usd.balanceRemainingUsd/usd.allowanceUsd*100):null;
      const pulseSame=pulse?.status==='ready'&&typeof pulse.pulse==='number'&&usdPct!==null&&pulse.pulse===usdPct;
      if(pulse&&!mini&&!pulseSame){const ok=typeof pulse.pulse==='number',state=!ok?'':pulse.pulse>=50?'good':pulse.pulse>=20?'warn':'low';
        out.push(item('pulse',pulse.status==='ready'?state:'',[['t','脉冲额度 '],['b',ok?pulse.pulse+'%':'—'],['t',pulse.status!=='ready'?' · '+({'signed-out':'未登录',forbidden:'无权限','rate-limited':'限流',timeout:'超时','network-error':'网络错误','server-error':'服务错误',invalid:'格式异常'}[pulse.status]||pulse.status):'']],
          '脉冲额度（Arena Pulse，GET /api/me/pulse）· 与美金余额是两个不同的指标；数值与美金百分比相同时自动并入美金一项 · 每 10 分钟读取一次，点击立即刷新'+(pulse.refreshedAt?'\n服务端刷新于 '+new Date(pulse.refreshedAt).toLocaleString('zh-CN',{hour12:false}):'')+'\n读取于 '+clock(pulse.checkedAt),()=>void refreshPulse(true)));
      }
      if(balance){const stale=balance.refreshAt&&balance.refreshAt<=now,used=balance.daily?(balance.daily-balance.remaining)/balance.daily:0;
        out.push(item('credits',balance.remaining<=0&&!stale?'low':used>=0.5?'warn':'',[['t','额度 '],['b',balance.remaining.toLocaleString('zh-CN')+(balance.daily!==null?'/'+balance.daily.toLocaleString('zh-CN'):'')],['t',balance.refreshAt&&balance.refreshAt>now?' · '+until(balance.refreshAt,now).trim()+'重置':stale?' · 待刷新':'']],
          'GET /api/billing/balance（credits）· 读取于 '+clock(balance.at)+(balance.refreshAt?'\n重置时间 '+new Date(balance.refreshAt).toLocaleString('zh-CN',{hour12:false}):''),()=>void refreshBalance(true)));
      }
      if(!miniBar())for(const [kind,q] of [['chat',quota.chat],['append',quota.append]]){const v=quotaView(q,kind,now,prefs.showQuotaReset);if(v)out.push(item('q'+kind,v.cls==='blocked'?'blocked':v.cls==='low'?'warn':'',[['t',v.label+' '],['b',v.value],['t',v.tail||'']],v.title));}
      const r=selectedRun(),c=r?.data?.calls?.at(-1);
      if(mini){const g=gacha.state();if(g&&['running','stopping'].includes(g.status))out.push(item('gacha','good',[['t','抽卡 '],['b',g.completed+'/'+g.settings.maxAttempts]],'点击打开抽卡面板',()=>window.dispatchEvent(new CustomEvent('amp-native-gacha-open'))));return out;}
      // v1.11.79 这一抽还在老虎机里揭晓：底栏的“模型”也只写已经停下的格子
      const gvb=(()=>{try{return gachaSlot.view(sidOf(location.href));}catch{return null;}})();
      if(c&&gvb)out.push(item('model','',[['t','模型 '],['b',gachaSlot.stageName(gvb)]],'老虎机揭晓中：厂商 → 型号 → 档位 依次停下',()=>ui?.show()));
      else if(c){const eff=c.effort?.value||({conflict:'冲突',unsupported:'不支持'}[c.effort?.status])||'';out.push(item('model','',[['t','模型 '],['b',(c.internal||c.model||'未提供').slice(0,48)],['t',eff?' · '+eff:'']],'当前会话最近一次模型调用\n请求 '+(c.request||'—')+'\n响应 '+(c.response||'—')+'\n内部 '+(c.internal||'—')+'\n显式档位 '+(eff||'未知'),()=>ui?.show()));}
      const sid=sidOf(location.href),cr=sid?costState.get(sid)?.credits||r?.data?.credits:null;
      if(cr&&cr.credits!==null&&cr.credits!==undefined)out.push(item('turn','',[['t','本轮 '],['b',Math.round(cr.credits).toLocaleString('zh-CN')+' cr'],['t',cr.usd!==null&&cr.usd!==undefined?' · $'+(+cr.usd).toFixed(4):'']],'GET /api/chat/{id}/cost · 本轮计费'));
      const g=gacha.state();
      if(g){const run=['running','stopping'].includes(g.status);out.push(item('gacha',run?'good':g.status==='hit'?'good':['paused','stopped'].includes(g.status)?'warn':'',[['t','抽卡 '],['b',g.completed+'/'+g.settings.maxAttempts],['t',' · '+(run?(g.phase||'进行中'):({hit:'已命中',done:'已完成',paused:'已停止',stopped:'已停止'}[g.status]||g.status))]],(g.reason||g.phase||'')+'\n点击打开抽卡面板',()=>window.dispatchEvent(new CustomEvent('amp-native-gacha-open'))));}
      const last=Math.max(usd?.at||0,pulse?.checkedAt||0,balance?.at||0);
      out.push(item('updated','',[['t','更新 '],['b',last?clock(last):'--:--:--']],'最近一次数据更新时间（美金 '+(usd?clock(usd.at):'—')+' · Pulse '+(pulse?clock(pulse.checkedAt):'—')+' · 额度 '+(balance?clock(balance.at):'—')+'）'));
      return out;
    }
    // 手机输入法弹出时：底栏和“给底栏让位”的高度改写都暂停，避免键盘上方留下一大块黑边
    // 手机：让输入法弹出时页面真正缩到键盘上方（Chrome/Edge 安卓的 interactive-widget），否则布局仍是整屏高、键盘上方空出一截
    const ensureVp=()=>{try{if(!matchMedia('(pointer:coarse)').matches)return;let m=document.querySelector('meta[name=viewport]');if(!m){m=document.createElement('meta');m.name='viewport';m.content='width=device-width, initial-scale=1';(document.head||document.documentElement).append(m);}const c=m.getAttribute('content')||'';if(!/interactive-widget/.test(c))m.setAttribute('content',c+(c?', ':'')+'interactive-widget=resizes-content');}catch{}};
    ensureVp();setTimeout(ensureVp,1500);setTimeout(ensureVp,5000);
    // 键盘弹出时：输入框底边到键盘的距离 = 输入框到屏幕左边的距离（按实际测量：先压掉外层底部留白，不够再整体下移）
    let kbBox=null,kbRaf=0;
    // v1.11.71 底部信息栏贴在输入法上方（浏览器只缩“可见区域”时按键盘遮住的高度抬起）；输入面板只能靠位移上去时，
    // 对话区底部补上同样的留白并一起滚上去——最新内容跟着输入框推上去，而不是被输入框盖住
    const barFollow=()=>prefs.kbResize!==false&&prefs.showBar&&!prefs.barCollapsed&&!host.hidden;
    const kbInset=on=>{try{const vv=window.visualViewport;document.documentElement.style.setProperty('--amp-kb-inset',(on&&barFollow()&&vv?Math.max(0,Math.round(innerHeight-vv.offsetTop-vv.height)):0)+'px');}catch{}};
    let kbPadEl=null,kbPadPx=0,kbPadBase=0;
    const logSc=()=>{try{const s=errReload.findScroller?.();if(s?.isConnected)return s;}catch{}const l=[...document.querySelectorAll('main [role="log"]')].find(e=>e.getClientRects().length);for(let e=l;e&&e!==document.body;e=e.parentElement){const oy=getComputedStyle(e).overflowY;if((oy==='auto'||oy==='scroll'||oy==='overlay')&&e.scrollHeight>e.clientHeight+1)return e;}return null;};
    const kbPad=px=>{try{px=Math.max(0,Math.round(px||0));const sc=px?logSc():kbPadEl;if(kbPadEl&&kbPadEl!==sc){kbPadEl.style.removeProperty('padding-bottom');kbPadEl=null;kbPadPx=0;}if(!sc)return;const d=px-kbPadPx;if(!d)return;const want=sc.scrollTop+d;if(px){if(!kbPadEl)kbPadBase=parseFloat(getComputedStyle(sc).paddingBottom)||0;sc.style.setProperty('padding-bottom',(kbPadBase+px)+'px','important');}else sc.style.removeProperty('padding-bottom');kbPadEl=px?sc:null;kbPadPx=px;sc._ampAnchorAt=Date.now();sc.scrollTop=Math.max(0,want);}catch{}};
    const kbClear=()=>{kbPad(0);if(kbBox){kbBox.style.removeProperty('transform');kbBox.style.removeProperty('--amp-kb-dy');kbBox.style.removeProperty('z-index');kbBox.style.removeProperty('position');}kbBox=null;};
    // 整个输入面板 = 同时包含输入框和发送按钮、且有圆角边框/背景的那一层（不是内部的编辑区）
    const kbPanel=ed=>{let n=ed.parentElement;for(let i=0;i<12&&n&&n!==document.body&&n.tagName!=='MAIN';i++,n=n.parentElement){if(!n.querySelector('button[aria-label="Send message"],button[aria-label="发送消息"],button[type=submit]'))continue;const cs=getComputedStyle(n);if(parseFloat(cs.borderTopWidth)>0&&parseFloat(cs.borderTopLeftRadius)>=8)return n;}return null;};
    const kbFit=()=>{cancelAnimationFrame(kbRaf);kbRaf=requestAnimationFrame(()=>{try{
      if(!kbOpen()){kbClear();return;}
      const ed=document.activeElement;if(!ed?.closest?.('main'))return;
      if(!kbBox||!kbBox.isConnected||!kbBox.contains(ed)){kbClear();kbBox=kbPanel(ed);if(!kbBox)return;}
      const vv=window.visualViewport,vb=(vv?vv.offsetTop+vv.height:innerHeight)-(barFollow()?BAR_H:0);
      const cur=parseFloat(kbBox.style.getPropertyValue('--amp-kb-dy')||'0')||0,r=kbBox.getBoundingClientRect();
      const want=Math.max(8,Math.round(r.left)),bottom=r.bottom-cur;
      // 面板底边到键盘 = 面板到屏幕左边的距离；整块面板（含发送按钮）一起上下移动，位移参与点击命中
      // v1.11.78 模型信息抽屉开着（在页面里占位、输入框在它上面）：输入框只会往上让，不会往下挪到抽屉上
      const dk=document.getElementById('amp-lite-dock'),sheetUnder=!!dk&&!dk.hidden&&dk.hasAttribute('data-compact')&&!dk.hasAttribute('data-full');
      const dy=Math.max(-900,Math.min(sheetUnder?0:600,Math.round(vb-want-bottom)));
      kbBox.style.setProperty('--amp-kb-dy',dy+'px');kbBox.style.setProperty('transform',dy?'translateY('+dy+'px)':'none','important');kbPad(prefs.kbResize!==false&&dy<0?-dy:0);
      if(dy){if(getComputedStyle(kbBox).position==='static')kbBox.style.setProperty('position','relative');kbBox.style.setProperty('z-index','40');}
    }catch{}});};
    if(!document.getElementById('amp-kb-css')){const st=document.createElement('style');st.id='amp-kb-css';st.textContent='html[data-amp-kb][data-amp-kbhide] main{padding-bottom:0!important}';(document.head||document.documentElement).append(st);}
    let kbMax=0;const kbOpen=()=>document.documentElement.hasAttribute('data-amp-kb');
    const kbCheck=()=>{try{const vv=window.visualViewport,h=vv?vv.height:innerHeight;kbMax=Math.max(kbMax,innerHeight,h);const ae=document.activeElement,typing=!!ae&&(ae.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName));const kb=matchMedia('(pointer:coarse)').matches&&typing&&h<kbMax-120;if(kb!==kbOpen()){document.documentElement.toggleAttribute('data-amp-kb',kb);ensureVp();sync();}kbInset(kb);kbFit();}catch{}};
    window.visualViewport?.addEventListener('resize',kbCheck,{passive:true});window.visualViewport?.addEventListener('scroll',()=>{if(kbOpen()){kbInset(true);kbFit();}},{passive:true});document.addEventListener('input',()=>{if(kbOpen())kbFit();},true);addEventListener('resize',kbCheck,{passive:true});addEventListener('orientationchange',()=>{kbMax=0;setTimeout(kbCheck,500);});document.addEventListener('focusin',()=>setTimeout(kbCheck,350),true);document.addEventListener('focusout',()=>setTimeout(kbCheck,350),true);
    function sync(){
      // v1.11.71 打字时不再藏起底部信息栏（设置里关掉“输入法弹出时一起上移”才恢复旧行为）
      const kbHide=kbOpen()&&prefs.kbResize===false;document.documentElement.toggleAttribute('data-amp-kbhide',kbHide);
      const eligible=prefs.showBar&&location.origin==='https://arena.ai'&&!kbHide;host.hidden=!eligible;document.documentElement.style.setProperty('--amp-bar-h',eligible&&!prefs.barCollapsed?BAR_H+'px':'0px');host.toggleAttribute('data-collapsed',!!prefs.barCollapsed);
      const offset=eligible&&!prefs.barCollapsed&&prefs.barOffset;document.documentElement.toggleAttribute('data-amp-bar-offset',offset);
      if(!offset)document.documentElement.removeAttribute('data-amp-bar-overlap');
      else{const m=document.querySelector('main');if(m){const b=m.getBoundingClientRect().bottom;if(b>innerHeight-BAR_H+1&&!document.documentElement.hasAttribute('data-amp-bar-overlap'))document.documentElement.setAttribute('data-amp-bar-overlap','');}}
      if(!eligible)return;
      const mini=miniBar();host.toggleAttribute('data-mini',mini);if(mini&&prefs.barCollapsed){prefs.barCollapsed=false;savePrefs();host.removeAttribute('data-collapsed');}
      const list=build(),key=mini+JSON.stringify(list.map(x=>[x.key,x.state,x.parts,x.title]));
      pill.textContent=usd?'美金 '+fmtUsd(usd.balanceRemainingUsd):'信息栏';
      if(key===stamp)return;stamp=key;
      items.replaceChildren(...list.map(x=>{const s=el('span','it'+(x.onclick?' click':''));s.dataset.key=x.key;if(x.state)s.dataset.state=x.state;
        if(x.key==='usd'){s.onpointerenter=e=>{if(e.pointerType==='mouse'&&!miniBar())showTip(s);};s.onpointerleave=e=>{if(e.pointerType==='mouse'&&!miniBar())hideTip();};s.onfocus=()=>{if(!miniBar())showTip(s);};s.onblur=()=>{if(!miniBar())hideTip();};s.setAttribute('aria-label',x.parts.map(p=>p[0]==='meter'?'':p[1]).join(''));}else s.title=x.title;
        for(const [k,v] of x.parts){if(k==='meter'){const m=el('span','meter',null,s);el('i',null,null,m).style.width=v+'%';}else if(k==='b')el('b','',v,s);else if(k==='p'){if(v)el('b','pct',v,s);}else if(v)s.append(v);}
        if(x.onclick){s.tabIndex=0;s.setAttribute('role','button');s.onclick=x.onclick;s.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();x.onclick();}};}
        return s;}));
    }
    bar={host,sync,destroy(){if(offsetSheet)document.adoptedStyleSheets=document.adoptedStyleSheets.filter(s=>s!==offsetSheet);offsetStyle?.remove();document.documentElement.removeAttribute('data-amp-bar-offset');document.documentElement.removeAttribute('data-amp-bar-overlap');host.remove();}};sync();
  }
  function paint(){if(stopped||paintTimer)return;paintTimer=setTimeout(()=>{paintTimer=0;try{ui?.render();bar?.sync();}catch(e){console.warn('[AMP Lite] UI:',e?.name||'error',e?.message||'');}},100);}
  function selectedRun(){const sid=sidOf(location.href);return [...runs.values()].filter(r=>r.sid===sid).at(-1)||null;}
  const turnLabel=s=>!s?'':(s.turn?'第 '+s.turn+' 轮':'未标记轮次')+(s.attempt>1?' · 第 '+s.attempt+' 次':'')+(s.resumed?' · 续':'');
  function save(s){if(!s?.calls.some(c=>c.model&&c.model!=='未提供')||s.failover?.pending)return;const c=localSnapshot(s);if(c){history=[{...c,raw:{events:[],spans:{}}},...history.filter(x=>x.key!==c.key)].slice(0,20);store(KEY+'.history',history.slice(0,6));}try{onSnapshot?.(s);}catch{}}
  // 内存中保留最近 RAW_KEEP 轮的完整原始 Trace 与 Span（持久化的是精简版）
  function keepRaw(r){if(!r.data)return;const key=r.data.key;rawStore.delete(key);rawStore.set(key,{trace:r.rawTrace,spans:r.rawSpans,probe:r.probe,at:Date.now()});while(rawStore.size>RAW_KEEP)rawStore.delete(rawStore.keys().next().value);}
  // v1.11.73 抽卡进行中：Trace 读得更勤（0.5~2.5 秒一次），模型识别更快；平时保持原来的节奏
  function gFast(){try{return gacha.running();}catch{return false;}}
  function later(r,ms=1200,final=false){if(stopped||!enabled||!r.token||Date.now()<cooldown)return;clearTimeout(r.timer);r.timer=setTimeout(()=>{r.timer=null;if(r.busy)later(r,400,final);else void poll(r,final);},ms);}
  // v1.11.71 锁定对话：Arena 可能把同一个 Trace 运行先后给多个对话用。以前新对话的令牌被忽略（信息不更新），
  // 旧对话却把新对话的调用读进来，误报“换模型 / 又换回来”。现在按对话分段：每个对话只认自己那段事件，互不串台。
  const shareLog=new Map(); // runId → [{sid,from}]：from = 接手时上一个对话最后一条事件的服务端时间（第一个对话 from=null）
  function ownTrace(r,trace){
    const L=r&&shareLog.get(r.runId);if(!L||!Array.isArray(trace?.events))return trace;
    const ev=trace.events,mark=e=>/^chat turn \d+$/.test(e?.message||'');
    // 分界落在新对话的第一个轮次标记上（服务端时间），上一个对话在分界之后才写完的尾巴仍归它自己
    const cuts=L.map((w,i)=>{if(!i)return -Infinity;let t=Infinity;for(const e of ev){const at=toMs(e?.startTime);if(at!==null&&at>w.from&&at<t&&mark(e))t=at;}return t===Infinity?w.from+0.001:t;});
    const owner=at=>{let k=0;for(let i=1;i<cuts.length;i++)if(at>=cuts[i])k=i;return L[k].sid;};
    return {...trace,events:ev.filter(e=>{const at=toMs(e?.startTime);return at!==null&&owner(at)===r.sid;})};
  }
  function accept(token,sid){
    let auth;try{auth=authorized(token,sid);}catch(e){log('warn','权限',e.message,null,{sid});return;}
    let r=runs.get(auth.runId);
    if(r&&r.sid!==auth.sid){
      if(r.rejectedToken===token)return;
      // 同一个运行换了对话：记下分界（服务端时间，不用本机时钟），上一个对话的记录到此冻结，新对话单独记录
      if(r.newest){const L=shareLog.get(auth.runId)||[{sid:r.sid,from:null}];L.push({sid:auth.sid,from:r.newest});while(L.length>12)L.splice(1,1);shareLog.delete(auth.runId);shareLog.set(auth.runId,L);while(shareLog.size>16)shareLog.delete(shareLog.keys().next().value);}
      log('warn','权限','同一个运行换了对话（'+String(r.sid).slice(0,8)+' → '+String(auth.sid).slice(0,8)+'）：按对话分开记录，互不串台',null,{sid:auth.sid,runId:auth.runId});
      clearTimeout(r.timer);r.abort?.abort();r.token=null;runs.delete(auth.runId);r=null;
    }
    if(r){if(r.rejectedToken===token)return;if(r.token!==token){r.token=token;r.expires=auth.expires;log('debug','权限','运行令牌已更新',null,r);if(r.phase!=='已读取'){r.tries=0;later(r);}}return;}
    const pending=submissions.get(auth.sid)||(pendingNew&&Date.now()-pendingNew.at<15000?pendingNew:null);
    r={...auth,token,revision:pending?.revision||++revision,requestConfigs:pending?.configs||[],prompt:pending?.prompt||null,submittedAt:pending?.at||null,baseline:null,markers:0,seen:new Set(),newest:null,tries:0,finalReads:0,busy:false,timer:null,abort:null,cache:new Map(),rawSpans:new Map(),rawTrace:[],missing:new Map(),probe:null,data:null,credits:costOf(auth.sid).credits,phase:'等待 Trace'};
    runs.set(auth.runId,r);while(runs.size>8){const [id,old]=runs.entries().next().value;clearTimeout(old.timer);old.abort?.abort();old.token=null;runs.delete(id);}
    pendingNew=null;log('detail','权限','检测到运行令牌 · '+r.runId+' · 有效期至 '+new Date(r.expires).toLocaleTimeString('zh-CN'),null,r);later(r,gFast()?500:1600);paint();
  }
  // 首包提示：在页面发出的用户消息末尾追加一句，让模型先输出“思考中…”，服务端尽早收到首包，避免约 90 秒无首包被改派。
  function warmBody(url,body){
    try{
      const gs=gacha.settings();if(!gs.warmup||gacha.running())return null;
      if(typeof body!=='string'||body.length>1048576){try{const u=new URL(url,location.href);if(/(\/in\/append|\/stream\/create-chat)$/.test(u.pathname))log('warn','首包提示','消息请求体不是文本（'+(body?.constructor?.name||typeof body)+'），未追加',null,{});}catch{}return null;}
      const u=new URL(url,location.href);if(u.origin!==location.origin||!/(\/in\/append|\/stream\/create-chat)$/.test(u.pathname))return null;
      const j=JSON.parse(body),kind=typeof j.kind==='string'?j.kind:typeof j.type==='string'?j.type:'';
      if(kind&&kind!=='message'||/regenerate/i.test(j.trigger||j.payload?.trigger||''))return null;
      const tip=gs.warmupText.trim(),add='\n\n'+tip;let done=false,dup=false;
      // 与 promptPreview 同一套查找规则：第一个用户节点里的 text/content/prompt/message/input 字符串
      (function walk(n,depth){if(done||dup||!n||typeof n!=='object'||depth>7)return;if(Array.isArray(n)){for(const v of n){walk(v,depth+1);if(done||dup)return;}return;}
        if(n.role&&n.role!=='user')return;
        for(const [k,v] of Object.entries(n))if(typeof v==='string'&&/^(text|content|prompt|message|input)$/.test(k)&&v.trim()){if(v.includes(tip))dup=true;else{n[k]=v+add;done=true;}return;}
        for(const v of Object.values(n)){walk(v,depth+1);if(done||dup)return;}})(Array.isArray(j.messages)?[...j.messages].reverse().find(m=>m?.role==='user')||j:j,0);
      if(dup)return null;
      if(!done){log('warn','首包提示','未找到消息正文字段，未追加 · 键 '+Object.keys(j).slice(0,8).join(','),null,{});return null;}log('detail','首包提示','已在本条消息末尾追加首包提示',null,{sid:streamSid(url)||sidOf(location.href)});return JSON.stringify(j);
    }catch{return null;}
  }
  const WARMUP_DEFAULT='（请先立即单独输出一行“思考中…”，然后再开始思考并完成任务；需要分析的内容直接写在回复正文里。）';
  function notePost(path,kind,sid){const k=path+'|'+kind,now=Date.now();if(now-(recentPosts.get(k)||0)<1500)return;recentPosts.set(k,now);if(recentPosts.size>60)recentPosts.delete(recentPosts.keys().next().value);log('detail','请求','POST '+path.slice(0,160)+(kind?' · kind='+kind:''),null,{sid});}
  function requestSeen(url,body){
    if(!enabled)return;
    let u;try{u=new URL(url,location.href);}catch{return;}
    if(u.origin!==location.origin)return;
    let j={};if(typeof body==='string'&&body.length<1048576){try{j=JSON.parse(body);}catch{}}
    const kind=label(typeof j.kind==='string'?j.kind:typeof j.type==='string'?j.type:'')||null;
    if(['ping','heartbeat'].includes(kind))return;
    const sid=streamSid(url)||sidOf(location.href), session=/(\/in\/append|\/stream\/create-chat)$/.test(u.pathname);
    // 会话相关的其他 POST（反馈、撤回等）只记路径，便于核对页面行为
    if(!session){if(/^\/(api|ai-proxy|agent)\//.test(u.pathname)&&!/\/(events|spans)\b|telemetry|analytics|metrics|logs?\b|ping|heartbeat|presence/i.test(u.pathname))notePost(u.pathname,kind,sid);return;}
    notePost(u.pathname,kind,sid);
    const continuation=kind&&kind!=='message'||/regenerate/i.test(j.trigger||j.payload?.trigger||'');
    if(continuation){if(!/^(stop|cancel|abort|interrupt)/i.test(kind||'')){try{errReload.follow.arm();errReload.noteSend(sidOf(location.href)||sid,null);}catch{}}if(sid&&!/^(stop|cancel|abort|interrupt)/i.test(kind||'')){const l=contSeen.get(sid)||[];l.push({at:Date.now(),kind:/regenerate/i.test(j.trigger||j.payload?.trigger||'')?'regenerate':kind||'continue'});contSeen.delete(sid);contSeen.set(sid,l.slice(-40));while(contSeen.size>20)contSeen.delete(contSeen.keys().next().value);}for(const r of runs.values())if(r.sid===sid){r.tries=0;r.finalReads=0;r.liveReads=0;r.phase='工作流继续';later(r);}return;}
    const preview=promptPreview(j), entry={revision:++revision,at:Date.now(),configs:configs(j,'页面请求','$'),prompt:preview,balance:balance&&Date.now()-balance.at<180000?{remaining:balance.remaining,at:balance.at}:null};
    const pm=j.payload?.message,mid=j.message?.id??(pm&&typeof pm==='object'&&pm.role!=='assistant'?pm.id:undefined);if(typeof mid==='string'&&/^[\w-]{8,64}$/.test(mid)){try{onSent?.(mid,entry.at);}catch{}}
    // 发送后自动跟随最新；记下这条消息（刷新后若页面里找不到，提示“服务器已收到、不用重发”）
    entry.mid=typeof mid==='string'?mid:null;try{errReload.follow.arm();const ps=sidOf(location.href)||sid;if(ps)errReload.noteSend(ps,entry.mid?{mid:entry.mid,text:preview,at:entry.at}:null);}catch{}
    if(sid){submissions.set(sid,entry);void costBaseline(sid,entry);}else pendingNew=entry;
    // 记下提交前已见过的标记数与 span：后端若不写新的轮次标记（如撤回后重发），仍能靠“新出现的 span”识别本轮
    for(const r of runs.values())if(r.sid===sid){clearTimeout(r.timer);r.abort?.abort();if(r.data)save(r.data);r.revision=entry.revision;r.requestConfigs=entry.configs;r.prompt=preview;r.submittedAt=entry.at;r.baseline={markers:r.markers,spans:new Set(r.seen),since:r.newest||null};r.tries=0;r.finalReads=0;r.liveReads=0;r.cache.clear();r.missing=new Map();r.rawSpans=new Map();r.rawTrace=[];r.credits=null;if(r.probe)delete r.probe.cost;r.phase='等待新一轮';later(r,1800);}
    log('detail','提交','页面提交新消息'+(preview?' · “'+preview+'”':''),null,{sid});paint();
  }
  function frameSeen(frame,ctx){
    frames++;const sid=ctx.sid||sidOf(location.href);inspect(frame,t=>accept(t,ctx.sid),(type,node)=>{
      // 助手消息的 id / nodeId 出现在 start 与 message-metadata 帧里；费用接口按 nodeId（缺省为消息 id）计
      if(node&&typeof node==='object'){noteTurnId(sid,node.messageId);const meta=node.messageMetadata;if(meta&&typeof meta==='object'){noteTurnId(sid,meta.nodeId);noteTurnId(sid,meta.messageId);}}
      if(type==='finish'){try{errReload.noteFinish(sid);}catch{}for(const r of runs.values())if(r.sid===sid)r.huntFinishedAt=Date.now();log('detail','读流','检测到流结束（finish）',null,ctx);for(const r of runs.values())if(r.sid===sid&&r.finalReads<2)later(r,gFast()?400:1200,true);clearTimeout(balanceTimer);balanceTimer=setTimeout(()=>{if(Date.now()-(balance?.at||0)>8000)void refreshBalance(true);},6000);scheduleCost(sid,COST_DELAYS[0],true);}
      else if(type==='error'||type==='abort'){log('detail','读流','检测到流事件 '+type,null,ctx);scheduleCost(sid,COST_DELAYS[1],true);}
    });paint();
  }
  async function json(r,path,signal){
    if(Date.now()<cooldown)throw Object.assign(Error('限流冷却中'),{status:429});
    const auth=authorized(r.token,r.sid);if(auth.runId!==r.runId)throw Error('运行权限不一致');
    // 页面令牌可读的只读接口：events / spans（Trace）以及 run 记录、run 元数据、会话记录（探测用）
    const tails={events:'/api/v1/runs/'+r.runId+'/events',metadata:'/api/v1/runs/'+r.runId+'/metadata',run:'/api/v3/runs/'+r.runId,session:'/api/v1/sessions/'+encodeURIComponent(r.sid)};
    const tail=/^spans\/[a-f0-9]{16,32}$/i.test(path)?'/api/v1/runs/'+r.runId+'/'+path:tails[path];if(!tail)throw Error('不允许的读取路径');
    const stage=path==='events'?'Trace':path.startsWith('spans/')?'Span':'探测',direct='https://api.trigger.dev',proxy=location.origin+'/ai-proxy',bases=denied('direct')?[proxy]:[direct,proxy];
    for(let i=0;i<bases.length;i++){
      const ctrl=new AbortController(),cancel=()=>ctrl.abort(),timeout=setTimeout(()=>ctrl.abort(),15000);
      if(signal.aborted){clearTimeout(timeout);throw new DOMException('已取消','AbortError');}signal.addEventListener('abort',cancel,{once:true});
      try{
        log('debug','请求','GET '+bases[i]+tail,null,r);queries++;const res=await rawFetch(bases[i]+tail,{method:'GET',headers:{Authorization:'Bearer '+r.token,Accept:'application/json'},credentials:'omit',redirect:'error',cache:'no-store',signal:ctrl.signal});
        if(res.ok||stage!=='探测')log('detail',stage,'HTTP '+res.status+' · '+path,null,{sid:r.sid,runId:r.runId,spanId:path.startsWith('spans/')?path.slice(6):null});if(!res.ok){const e=Error('HTTP '+res.status);e.status=res.status;if(res.status===429)cooldown=Date.now()+Math.max(120000,Math.min(600000,(Number(res.headers.get('Retry-After'))||0)*1000));throw e;}
        const text=await res.text();if(text.length>(path==='events'?4194304:path==='run'?2097152:524288))throw Object.assign(Error(stage+' 数据超过读取上限'),{format:true});
        try{return JSON.parse(text);}catch{throw Object.assign(Error(stage+' 返回内容不是有效 JSON'),{format:true});}
      }catch(e){
        if(!signal.aborted&&!e.status&&!e.format&&bases[i]===proxy&&bases.length===1)undeny('direct');
        if(signal.aborted||e.status||e.format||i===bases.length-1)throw e;
        // 浏览器直连 api.trigger.dev 失败（CORS/网络/拦截），改走本站 /ai-proxy；30 分钟内直接走代理，不再每次先失败一次。
        if(bases[i]===direct){if(denyFor('direct',1800000))log('detail','连接','直连 api.trigger.dev 不可用（'+errorText(e)+'），30 分钟内改走本站 /ai-proxy',null,r);}
      }finally{clearTimeout(timeout);signal.removeEventListener('abort',cancel);}
    }
  }
  // ---- 模型被改派（服务端故障转移）----
  const pageGenerating=()=>!!document.querySelector('button[aria-label="Stop generating"],button[aria-label="Stop response"],button[aria-label="停止生成"]');
  function flatProps(o,pre='',out=[],depth=0){if(!o||typeof o!=='object'||depth>4||out.length>200)return out;for(const [k,v] of Object.entries(o)){const p=pre?pre+'.'+k:k;if(v&&typeof v==='object')flatProps(v,p,out,depth+1);else out.push([p,v]);}return out;}
  async function noteRoute(r,p,signal){
    const sw=r.data?.routing;if(!sw)return;
    // v1.11.78 改派后的新模型还没出现在 Trace 里：先不提醒，等下一次读取拿到它的名字（最多等 20 秒），不再先弹一个“→ 其他模型”
    if(!sw.to&&r.data?.failover?.pending&&Date.now()-(Date.parse(sw.at)||0)<20000)return;
    const k=r.runId+'|'+(p.turn??'')+'|'+sw.at;if(r.routeNoted===k)return;r.routeNoted=k;
    // 读取故障转移事件本身的属性（原因、前后模型等），只读一次
    const bits=[],props={};
    for(const x of (p.route||[]).filter(x=>x.spanId&&/^(model\.resample\.(attempt_failed|switched)|failover\.record_inserted)$/.test(x.message)).slice(0,3)){
      try{const d=await json(r,'spans/'+x.spanId,signal);r.rawSpans.set(x.spanId,d);for(const [kk,v] of flatProps(object(d?.properties)))if(['string','number','boolean'].includes(typeof v)&&(props[kk.replace(/^(properties\.)?/,'')]??=v,true)&&/reason|error|cause|timeout|status|code|failure|rawMessage|site|from|to|previous|next|model|attempt|elapsed|ms/i.test(kk)&&!/userId|sessionId|chatId|prompt|messages|originIp/i.test(kk))bits.push(kk.replace(/^(properties\.)?/,'')+'='+String(v).slice(0,80));}catch{}
    }
    const reason=[...new Set(bits)].slice(0,10).join(' · ')||null;r.routeReason=reason;if(r.data?.routing)r.data.routing.reason=reason;
    const wait=sw.waitMs?Math.round(sw.waitMs/1000)+' 秒':'';
    // 区分改派原因：内容审核拦截 / 空响应 / 首包超时 / 其他调用失败
    const fin=(r.data?.calls||[]).map(c=>c.finish).find(Boolean)||'',fk=String(props.failureKind||''),ec=String(props.errorCategory||'');
    const cause=/content.?filter/i.test(fin)?'被内容审核拦截（finish=content-filter），'+(wait?wait+'内':'')+'没有任何输出':fk==='empty_stream'?(wait?wait+'内':'')+'返回了空内容（empty_stream'+(fin?' · finish='+fin:'')+'）':sw.waitMs>=60000?wait+'内没有返回任何内容（首包超时）':'调用失败'+(fk||ec?'（'+[fk,ec].filter(Boolean).join(' · ')+'）':'')+(wait?'，用时 '+wait:'');
    r.routeCause=cause;if(r.data?.routing)r.data.routing.cause=cause;
    log('warn','路由',turnLabel(r.data)+' · '+(sw.from||'原模型')+' '+cause+'，Arena 自动改派 '+(sw.to||'其他模型')+(sw.committed?'（已写入本对话，后续轮次也会用新模型）':'')+(reason?' · '+reason:''),null,r);
    if(r.sid===sidOf(location.href)&&!gacha.quietTurn(r.sid))try{routeAlert.show('模型被 Arena 改派',sw.from||'原模型',sw.to||'其他模型','原模型'+cause+'，服务端自动故障转移'+(sw.committed?' · 本对话之后也会用新模型，想要原模型请新开对话':''),'drop');}catch{}
    // v1.11.78 抽卡的这一轮不自动停：让改派后的模型答完，它的用量记录才会给出带档位的内部名（这一抽才识别得准）
    if(prefs.stopOnResample&&sidOf(location.href)===r.sid&&pageGenerating()&&!gacha.quietTurn(r.sid)){
      const b=document.querySelector('button[aria-label="Stop generating"],button[aria-label="Stop response"],button[aria-label="停止生成"]');
      if(b){b.click();log('info','路由','已自动停止生成：改派后的模型不是原来那个，继续等待只会消耗额度（设置里可关闭）',null,r);}
    }
    save(r.data);paint();
  }
  // 长回复期间常规轮询早已用完：页面仍在生成时每 20 秒只读一次事件列表，尽快发现改派。
  async function watchRoute(){
    if(stopped||!enabled||Date.now()<cooldown||document.hidden||!pageGenerating())return;
    const sid=sidOf(location.href),r=[...runs.values()].find(x=>x.sid===sid&&x.token);if(!r||r.busy||r.watching)return;
    const age=Date.now()-(r.submittedAt||0);if(age<45000||age>1800000)return;
    r.watching=true;const ctrl=new AbortController();
    try{const trace=ownTrace(r,await json(r,'events',ctrl.signal));const p=plan(trace,r.runId,r.baseline);
      if(p.route.some(x=>x.message==='model.resample.switched')&&p.count){r.data=snapshot(r,p,r.cache);keepRaw(r);await noteRoute(r,p,ctrl.signal);}
    }catch{}finally{r.watching=false;}
  }
  const routeWatch=setInterval(()=>{void watchRoute();},20000);
  async function poll(r,final=false,kick=null){
    if(stopped||!enabled||r.busy||Date.now()<cooldown||!r.token||r.tries>=8&&!final&&!kick||final&&r.finalReads>=2)return;
    if(final)r.finalReads++;if(!kick)r.tries++;r.lastRead=Date.now();r.busy=true;r.phase=kick?'实时核对':'读取 Trace';
    const epoch=r.revision,ctrl=new AbortController();r.abort=ctrl;
    const live=()=>!stopped&&enabled&&r.revision===epoch&&!ctrl.signal.aborted&&runs.get(r.runId)===r;
    try{
      const trace=ownTrace(r,await json(r,'events',ctrl.signal));if(!live())return;
      const p=plan(trace,r.runId,r.baseline);r.markers=p.markers;for(const id of p.spanIds)r.seen.add(id);r.newest=Math.max(r.newest||0,p.newest||0)||null;monTrace(r,trace);
      // 刷新页面后首次提交时还没有基线：若最新段落明显早于本次提交，就把当前内容记为基线，之后只认新出现的标记或 span。
      // 基线一旦存在便不再用本机时钟判断，避免时钟偏差把新一轮吞掉
      const stale=!p.resumed&&!r.baseline&&r.tries<=6&&!!r.submittedAt&&!!p.at&&p.at<r.submittedAt-90000;
      if(stale)r.baseline={markers:p.markers,spans:new Set(p.spanIds),since:p.newest||null};
      log('detail','Trace',(p.turn?'第 '+p.turn+' 轮':'未标记轮次')+(p.attempt>1?' · 第 '+p.attempt+' 次':'')+(p.resumed?' · 同轮新记录':'')+' · '+p.count+' 次模型调用'+(p.prior?'（此前 '+p.prior+' 次）':'')+' · '+p.markers+' 个轮次标记 · '+trace.events.length+' 条事件'+(p.limited?' · 超出详读上限':''),null,r);
      if(!p.count||stale){r.phase='等待本轮记录';log('debug','轮次',stale?'最新轮次早于本次提交，继续等待':'尚无本轮模型调用记录',null,r);if(!kick){if(r.tries<(gFast()?24:8))later(r,gFast()?Math.min(2500,600+300*r.tries):Math.min(15000,2500*r.tries));else r.phase='暂未发现本轮记录';}return;}
      r.rawTrace=trace.events.slice(p.range[0],p.range[1]+1);
      r.data=snapshot(r,p,r.cache);keepRaw(r);save(r.data);paint(); // 先显示模型标签，不等所有 span 成功。
      if(r.data.routing)void noteRoute(r,p,ctrl.signal);
      if(!r.probe)void probeRun(r,['run','session','metadata']);else if(final&&r.finalReads===1)void probeRun(r,['run','metadata']);
      if(p.ready||final||r.tries>=4||kick){
        // 先读用量/花费记录（携带内部名称，条数少），再读模型调用；中途被新消息打断时名称也已到手
        // 实时核对（kick）：只读已完成的调用、从最新往前、每次最多 4 个详情
        const todo=kick?[...p.streams].reverse().filter(e=>!e.partial).concat(p.records):[...p.records,...p.streams];let n=0,kf=0;
        for(const e of todo){
          if(!live())return;n++;if(r.cache.get(e.id)?.available&&!r.cache.get(e.id)?.partial||(r.missing.get(e.id)||0)>=2)continue;
          if(e.properties){r.cache.set(e.id,detail({runId:r.runId,spanId:e.id,message:e.message,isPartial:e.partial,properties:e.properties},e,r.runId));r.rawSpans.set(e.id,{spanId:e.id,runId:r.runId,message:e.message,isPartial:e.partial,properties:e.properties});}
          else {
            if(kick&&kf++>=4)continue;
            try{const d=await json(r,'spans/'+e.id,ctrl.signal);if(!live())return;r.cache.set(e.id,detail(d,e,r.runId));r.rawSpans.set(e.id,d);}
            catch(err){
              if(err.status===404){const k=(r.missing.get(e.id)||0)+1;r.missing.set(e.id,k);log(k>1?'warn':'detail','Span','详情 HTTP 404，跳过此 Span'+(k>1?'（第 '+k+' 次）':''),null,{sid:r.sid,runId:r.runId,spanId:e.id});continue;}
              if([401,403].includes(err.status)){r.phase='模型已识别 · 详情未提供';log('warn','Span','详情接口 HTTP '+err.status+'；保留模型标签',null,{sid:r.sid,runId:r.runId,spanId:e.id});save(r.data);return;}
              throw err;}
          }
          const d=r.cache.get(e.id)||{};
          log('detail','字段',({stream:'模型调用',usage:'用量记录',cost:'花费记录'}[e.kind]||e.kind)+' '+n+'/'+todo.length+(d.request?' · '+d.request:'')+(d.internal?' · '+d.internal:'')+(d.configs?.find(x=>x.kind==='effort')?' · 显式 '+(d.configs.find(x=>x.kind==='effort').value||'不支持'):'')+(d.output?.[0]?' · 输出 '+d.output[0].value:'')+(d.reasoning?.[0]?' · 推理 '+d.reasoning[0].value:''),null,{sid:r.sid,runId:r.runId,spanId:e.id});
          r.data=snapshot(r,p,r.cache);keepRaw(r);if(n%4===0)save(r.data);paint();await new Promise(resolve=>setTimeout(resolve,300));
        }
      }
      if(!live())return;r.data=snapshot(r,p,r.cache);keepRaw(r);r.phase=r.data.partial?'部分记录':'已读取';save(r.data);noteUsd(r,p);monTrace(r,trace);if(r.data.routing)void noteRoute(r,p,ctrl.signal);
      if(r.data.outcome&&r.outcomeNoted!==r.data.key){r.outcomeNoted=r.data.key;const lc=r.data.calls.at(-1);log('warn','结果',turnLabel(r.data)+' · '+(r.data.outcome==='failed'?'Arena 记录本轮失败':'本轮没有产出回复')+(lc?.finish==='length'?' · '+(lc.model||'模型')+' 推理用尽输出上限（'+(lc.tokens?.output??'?')+' Token）仍未作答':''),null,r);}
      const last=r.data.calls.at(-1),eff=last?.effort;
      log('info','结果',turnLabel(r.data)+' · '+p.count+' 次调用 · '+(last?.model||'未提供')+(last?.internal?' · 内部名称 '+last.internal:'')+' · 显式 '+(eff?.value||({conflict:'冲突',unsupported:'不支持'}[eff?.status])||'未知')+' · 推理 Token '+(last?.reasoning.status==='conflict'?'冲突':last?.reasoning.value??'—')+(r.data.partial?' · 部分字段未取得':''),null,r);
      if(!kick&&r.data.partial&&r.tries<(gFast()?24:8))later(r,gFast()?Math.min(2500,600+300*r.tries):Math.min(15000,2500*r.tries));
    }catch(e){
      if(!live()||e.name==='AbortError'&&ctrl.signal.aborted)return;
      r.phase=e.status===429?'限流暂停':[401,403].includes(e.status)?'权限失效':'Trace 读取失败';
      if([401,403].includes(e.status)){r.rejectedToken=r.token;r.token=null;}
      log('warn','Trace',r.phase,e,r);
    }finally{if(r.abort===ctrl)r.abort=null;r.busy=false;paint();}
  }

  // 探测：用同一枚页面令牌读取 run 记录 / run 元数据 / 会话记录，结果进原始标签页与导出；HTTP 状态一并记录，便于摸清权限边界
  async function probeRun(r,kinds){
    if(r.probing||!r.token||stopped||!enabled)return;r.probing=true;const ctrl=new AbortController(),epoch=r.revision;
    try{
      r.probe=r.probe||{};
      for(const kind of kinds){
        if(stopped||!enabled||runs.get(r.runId)!==r||!r.token)return;
        if(denied('probe.'+kind)){r.probe[kind]=r.probe[kind]||{status:0,at:new Date().toISOString(),error:'页面令牌无权读取，已跳过'};continue;}
        const at=new Date().toISOString();
        try{const d=await json(r,kind,ctrl.signal);r.probe[kind]={status:200,at,data:d};log('detail','探测',kind+' · 已读取 · '+(JSON.stringify(d).length/1024).toFixed(1)+' KB',null,r);}
        catch(e){r.probe[kind]={status:e.status||0,at,error:errorText(e)};
          // 401/403/404：页面令牌的权限范围不含该接口（仅探测用，不影响模型识别）。6 小时内不再请求。
          if([401,403,404].includes(e.status)){if(denyFor('probe.'+kind,21600000))log('detail','探测',kind+' · HTTP '+e.status+' · 页面令牌无权读取此接口（仅探测，不影响识别），6 小时内跳过',null,r);}
          else log('warn','探测',kind+' · '+(e.status?'HTTP '+e.status:errorText(e)),null,r);if(e.status===429)return;}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    }finally{r.probing=false;if(runs.get(r.runId)===r&&r.revision===epoch&&r.data){r.data={...r.data,raw:{...r.data.raw,probe:r.probe}};keepRaw(r);save(r.data);}paint();}
  }
  // 限流与额度
  function noteQuota(kind,headers,status,body=null){
    const q=quotaOf(headers,status,Date.now(),body),before=quota[kind];
    // 成功响应没有限流头（/in/append 常见）：若此前记录为限流中，视为已解除
    if(!q){if(before?.blocked&&status>=200&&status<400){quota={...quota,[kind]:null};store(KEY+'.quota',quota);log('info','限流',(kind==='chat'?'新会话':'消息')+' 限流已解除（请求成功）');paint();}return;}
    quota={...quota,[kind]:q};store(KEY+'.quota',quota);
    const text=(kind==='chat'?'新会话':'消息')+(q.blocked?' 限流 HTTP 429':'')+(q.reason?' · '+q.reason:'')+(q.limit!==null?' · 剩余 '+(q.remaining??'?')+'/'+q.limit:'')+(q.resetAt?' · '+hhmm(q.resetAt)+(q.blocked?' 解除':' 重置'):'')+(q.window?' · 窗口 '+q.window+' 秒':'');
    if(q.blocked||!before||before.remaining!==q.remaining||before.limit!==q.limit||before.blocked)log(q.blocked?'warn':'detail','限流',text.trim());paint();
  }
  function noteBalance(j,source){
    const b={remaining:number(j?.creditsRemaining),daily:number(j?.dailyFreeCredits),refreshAt:Number.isFinite(Date.parse(j?.refreshedAt||''))?Date.parse(j.refreshedAt):null,at:Date.now()};
    if(b.remaining===null)return false;const changed=!balance||balance.remaining!==b.remaining||balance.daily!==b.daily;balance=b;store(KEY+'.balance',b);
    // 到了每日重置时间再读一次（页面自身也这么做），避免状态行停在过期数字上
    clearTimeout(balanceResetTimer);if(b.refreshAt&&b.refreshAt>b.at&&b.refreshAt-b.at<90000000)balanceResetTimer=setTimeout(()=>void refreshBalance(true),b.refreshAt-b.at+1500);
    if(changed)log('detail','额度','剩余 '+b.remaining+(b.daily!==null?' / 每日 '+b.daily:'')+(b.refreshAt?' · '+hhmm(b.refreshAt)+' 重置':'')+' · '+source);costBalance();paint();return true;
  }
  // 每轮 credits：页面自带接口 GET /api/chat/{sid}/cost（同源 cookie，页面自己也在用）。提交时先记基线（已计费的消息 id 集合、会话累计、余额），
  // 流结束后按 2.5 / 6 / 15 / 40 秒读取，直到命中本轮消息的计费条目；命中不了时退化为“新出现的条目”或会话累计差值，余额变化另行记录
  const COST_DELAYS=[2500,6000,15000,40000],costState=new Map();let costFail=0,costFailAt=0;
  const MID=/^[\w-]{4,128}$/,midList=list=>[...new Set(list.filter(k=>typeof k==='string'&&MID.test(k)))];
  function costOf(sid){if(!costState.has(sid)){costState.set(sid,{baseline:null,latest:null,credits:null,timer:0,tries:0,ids:new Set(),busy:false,done:0});while(costState.size>12){const [k,v]=costState.entries().next().value;clearTimeout(v.timer);costState.delete(k);}}return costState.get(sid);}
  // 只在“本机提交之后、流结束前后 3 秒内”收集消息 id，避免重连回放的历史帧把上几轮的 id 混进来
  function noteTurnId(sid,id){if(!sid||typeof id!=='string'||!MID.test(id))return;const c=costOf(sid);if(!c.baseline||c.done&&Date.now()-c.done>3000||c.ids.has(id))return;if(c.ids.size>=8)c.ids.delete(c.ids.values().next().value);c.ids.add(id);}
  const costAllowed=()=>prefs.showCredits&&!stopped&&enabled&&!(costFail>=3&&Date.now()-costFailAt<600000);
  function creditsRow(resolved,session,bal){return {credits:resolved?.credits??null,usd:resolved?.usd??null,actualUsd:resolved?.actualUsd??null,source:resolved?.source||null,keys:resolved?.keys||[],parts:resolved?.parts||[],session:session||null,balance:bal||null,at:new Date().toISOString()};}
  const balDelta=(before,after)=>before&&after&&after.at>before.at?{before:before.remaining,beforeAt:new Date(before.at).toISOString(),after:after.remaining,afterAt:new Date(after.at).toISOString(),delta:before.remaining-after.remaining}:null;
  async function costGet(sid,ids){
    const q=ids?.length?'includeSession=false&messageIds='+encodeURIComponent([...new Set(ids)].sort().slice(0,50).join(',')):'includeSession=true';
    if(denied('cost')){const e=Error('费用接口暂不可用');e.status=403;e.known=true;throw e;}
    const path='/api/chat/'+encodeURIComponent(sid)+'/cost?'+q;
    let res=await rawFetch(location.origin+path,{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store'});
    // 403/401 时换一条线路再试一次（相对路径 + include 凭据，与额度接口的备用方式相同）
    if(res.status===403||res.status===401){try{const r2=await rawFetch(path,{headers:{Accept:'application/json'},credentials:'include',cache:'no-store',redirect:'follow'});if(r2.ok)res=r2;}catch{}}
    if(!res.ok){const e=Error('HTTP '+res.status);e.status=res.status;
      // 其它接口正常而费用接口 401/403/404：该账号/对话不开放费用明细。1 小时内不再请求；本轮用量改用余额前后差值。
      if([401,403,404].includes(res.status)){e.first=denyFor('cost',3600000);}
      throw e;}
    undeny('cost');
    const text=await res.text();if(text.length>2097152)throw Error('费用数据超过读取上限');return JSON.parse(text);
  }
  // 上一轮的现场：用户发得快时（流结束后几秒内又提交），上一轮的 credits 还没读到；用之后到达的任一响应补记到上一轮的快照里
  function settlePrev(sid,sum,prev,run){
    if(!sum||!prev?.data||!prev.baseline||prev.credits&&prev.credits.source==='message')return false;
    const strong=midList([...(prev.data.records||[]).map(x=>x.messageId),...(prev.data.costs||[]).map(x=>x.messageId)]);
    const resolved=resolveTurnCredits({entries:sum.entries,candidates:midList(prev.ids),strong,before:prev.baseline.keys||null,sessionBefore:prev.baseline.session||null,session:sum.session});
    if(!resolved)return false;const base=run?.data?.key===prev.data.key?run.data:prev.data,credits=creditsRow(resolved,sum.session,balDelta(prev.baseline.balance,prev.balanceAfter)||prev.credits?.balance||null),data={...base,credits};
    if(run&&run.data===base)run.data=data;save(data);log('info','费用','补记上一轮 '+Math.round(resolved.credits)+' credits · '+({message:'按消息 id 命中',new:'按新出现的计费条目推断',session:'按会话累计差值推断'}[resolved.source]),null,{sid,runId:run?.runId});return true;
  }
  const prevOf=(c,run)=>({baseline:c.baseline,ids:[...c.ids],credits:c.credits,data:run?.data||null,balanceAfter:balance?{remaining:balance.remaining,at:balance.at}:null});
  async function costBaseline(sid,entry){
    if(!sid||stopped||!enabled)return;const c=costOf(sid),run=[...runs.values()].filter(x=>x.sid===sid).at(-1)||null;
    const prev=prevOf(c,run);
    clearTimeout(c.timer);c.timer=0;c.tries=0;c.credits=null;c.ids=new Set();c.done=0;
    const b={at:entry?.at||Date.now(),keys:null,session:null,balance:entry?.balance||null};c.baseline=b;if(!costAllowed())return;
    if(!b.balance){await refreshBalance(true);if(balance&&c.baseline===b&&Date.now()-balance.at<30000)b.balance={remaining:balance.remaining,at:balance.at};}
    try{const j=await costGet(sid),sum=costSummary(j);costFail=0;
      // 流已经结束才拿到基线（极快的一轮）：这份数据可能已含本轮计费，不能当基线用，只保留“按消息 id 命中”这一条路
      const late=c.baseline!==b||!!c.done;
      if(sum&&!late){b.keys=new Set(Object.keys(sum.entries));b.session=sum.session;c.latest={summary:sum,at:Date.now()};}
      log('debug','费用','提交前基线 · '+(sum?Object.keys(sum.entries).length+' 条已计费消息'+(sum.session?.credits!==null&&sum.session?.credits!==undefined?' · 会话累计 '+Math.round(sum.session.credits)+' credits':''):'无数据')+(late?' · 到得太晚，不作基线':''),null,{sid});
      if(sum)settlePrev(sid,sum,prev,run);
    }catch(e){if(e.known)return;if([401,403,404].includes(e.status)){costFail++;costFailAt=Date.now();}log('debug','费用','基线读取失败'+(e.status?' · HTTP '+e.status:''),e.status?null:e,{sid});}
  }
  function costNew(sid,at,bal){if(!sid)return;const c=costOf(sid);clearTimeout(c.timer);c.timer=0;c.tries=0;c.credits=null;c.ids=new Set();c.done=0;c.baseline={at:at||Date.now(),keys:new Set(),session:null,balance:bal||null};}
  function scheduleCost(sid,delay,restart=false){if(!sid||!costAllowed())return;const c=costOf(sid);if(restart){c.tries=0;if(!c.done)c.done=Date.now();}clearTimeout(c.timer);c.timer=setTimeout(()=>{c.timer=0;void costRead(sid);},delay);}
  function domAssistantId(sid){if(sidOf(location.href)!==sid)return null;const nodes=document.querySelectorAll('[data-agent-transcript-message][data-chat-message-id]');for(let i=nodes.length-1;i>=0;i--){const n=nodes[i];if(n.querySelector('[data-user-message-layout],[data-user-message-body-row]'))continue;return n.getAttribute('data-chat-message-id');}return null;}
  // 余额前后差值：账号级数字，其他标签页的消耗也会算进来，所以只作参考；流结束前不建条目
  function costBalance(){
    const sid=sidOf(location.href),c=sid&&costState.get(sid);if(!c||!c.done||!c.baseline?.balance||!balance||balance.at<=c.baseline.at)return;
    const bal=balDelta(c.baseline.balance,{remaining:balance.remaining,at:balance.at});if(!bal||c.credits?.balance&&c.credits.balance.after===bal.after)return;
    c.credits=c.credits?{...c.credits,balance:bal}:creditsRow(null,c.latest?.summary?.session||null,bal);
    const r=[...runs.values()].filter(x=>x.sid===sid).at(-1);if(r){r.credits=c.credits;if(r.data){r.data={...r.data,credits:r.credits};keepRaw(r);save(r.data);}}paint();
  }
  const trimCost=(j,keys)=>{const msgs=j?.messages&&typeof j.messages==='object'?j.messages:{},picked={};for(const k of keys)if(msgs[k])picked[k]=msgs[k];return {session:j?.session??null,messages:picked,messageCount:Object.keys(msgs).length};};
  async function costRead(sid){
    const c=costOf(sid);if(c.busy||!costAllowed())return;c.busy=true;c.tries++;
    const r=[...runs.values()].filter(x=>x.sid===sid).at(-1)||null,b=c.baseline,prev=prevOf(c,r);
    try{
      const strong=midList([...(r?.data?.records||[]).map(x=>x.messageId),...(r?.data?.costs||[]).map(x=>x.messageId)]),want=midList([...c.ids,...strong,domAssistantId(sid)]);
      let j=await costGet(sid),sum=costSummary(j);costFail=0;
      if(!sum){log('detail','费用','GET /api/chat/{sid}/cost 返回了无法识别的结构',null,{sid});return;}
      // 等待期间页面又提交了新一轮：这份响应属于上一轮，补记后退出（新一轮流结束时会另行读取）
      if(c.baseline!==b){settlePrev(sid,sum,prev,r);return;}
      const missing=want.filter(k=>!sum.entries[k]);
      if(missing.length){try{const j2=await costGet(sid,missing),s2=costSummary(j2);if(s2){Object.assign(sum.entries,s2.entries);j={...j,messages:{...(j.messages||{}),...(j2.messages||{})}};}}catch(e){log('debug','费用','按消息 id 读取失败'+(e.status?' · HTTP '+e.status:''),e.status?null:e,{sid});}}
      if(c.baseline!==b){settlePrev(sid,sum,prev,r);return;}
      c.latest={summary:sum,at:Date.now()};
      const resolved=resolveTurnCredits({entries:sum.entries,candidates:want,strong,before:b?.keys||null,sessionBefore:b?.session||null,session:sum.session});
      const bal=(b?.balance&&balance?balDelta(b.balance,{remaining:balance.remaining,at:balance.at}):null)||c.credits?.balance||null;
      c.credits=creditsRow(resolved,sum.session,bal);
      if(r){r.credits=c.credits;r.probe=r.probe||{};r.probe.cost={status:200,at:c.credits.at,data:trimCost(j,[...(resolved?.keys||[]),...want])};if(r.data){r.data={...r.data,credits:r.credits,raw:{...r.data.raw,probe:r.probe}};keepRaw(r);save(r.data);}}
      const srcText={message:'按本轮消息 id 命中',new:'按新出现的计费条目推断',session:'按会话累计差值推断'}[resolved?.source]||'';
      log(resolved?'info':'detail','费用',resolved?'本轮 '+Math.round(resolved.credits)+' credits'+(resolved.usd!==null&&resolved.usd!==undefined?' · 计费 $'+(+resolved.usd).toFixed(4):'')+(resolved.actualUsd?' · 实际 $'+(+resolved.actualUsd).toFixed(4):'')+(resolved.parts[0]?.strategy?' · '+resolved.parts[0].strategy:'')+' · '+srcText+(bal?' · 余额 '+bal.before+' → '+bal.after:''):'第 '+c.tries+' 次读取尚无本轮计费条目'+(sum.session?.credits!==null&&sum.session?.credits!==undefined?' · 会话累计 '+Math.round(sum.session.credits)+' credits':'')+(want.length?' · 候选 id '+want.length+' 个':' · 尚未捕获本轮消息 id'),null,{sid,runId:r?.runId});
      if(!(resolved&&resolved.source!=='session')&&c.tries<COST_DELAYS.length)scheduleCost(sid,COST_DELAYS[c.tries]);
    }catch(e){
      const refused=[401,403,404].includes(e.status);if(refused){costFail++;costFailAt=Date.now();if(r){r.probe=r.probe||{};r.probe.cost={status:e.status,at:new Date().toISOString(),error:errorText(e)};}}
      if(e.known){}else if(refused&&e.first)log('detail','费用','GET /api/chat/{id}/cost · HTTP '+e.status+' · 此账号不开放费用明细（登录正常，其它接口可用）；1 小时内不再读取，本轮用量改用余额前后差值',null,{sid});
      else if(!refused)log(c.tries<COST_DELAYS.length?'detail':'warn','费用','读取失败'+(e.status?' · HTTP '+e.status:''),e.status?null:e,{sid});
      if(!refused&&c.tries<COST_DELAYS.length)scheduleCost(sid,COST_DELAYS[c.tries]);
    }finally{c.busy=false;paint();}
  }
  async function refreshBalance(force=false){
    if(!prefs.showQuota||stopped||!enabled)return;const now=Date.now();
    if(!force&&now-balanceAt<BALANCE_INTERVAL||balanceFail>=3&&now-balanceAt<600000)return;balanceAt=now;
    // 403/网络失败时自动换路：当前地址 → 强制 HTTPS 同域 → 相对路径 + include 凭据 → 页面自身 fetch。全部失败只记调试日志，保留上次额度，不报错。
    const path='/api/billing/balance',httpsOrigin='https://'+location.host;
    const tries=[[rawFetch,location.origin+path,'same-origin'],[rawFetch,httpsOrigin+path,'include'],[rawFetch,path,'include'],[window.fetch.bind(window),httpsOrigin+path,'include']]
      .filter((t,i,a)=>a.findIndex(x=>x[0]===t[0]&&x[1]===t[1]&&x[2]===t[2])===i);
    const errs=[];
    for(const [fn,url,cred] of tries){
      try{const res=await fn(url,{method:'GET',headers:{Accept:'application/json'},credentials:cred,cache:'no-store',redirect:'follow'});
        if(!res.ok){errs.push('HTTP '+res.status+' · '+url);if(res.status===429)break;continue;}
        const ct=res.headers.get('content-type')||'';if(!/json/i.test(ct)){errs.push('非 JSON · '+url);continue;}
        if(noteBalance(await res.json(),'主动读取')){balanceFail=0;if(errs.length)log('debug','额度','已通过备用线路读取（'+url+'），此前：'+errs.join('；'));return;}
        errs.push('数据无效 · '+url);
      }catch(e){errs.push((e?.message||'网络错误')+' · '+url);}
    }
    balanceFail++;log('debug','额度','GET '+path+' 暂不可用，已保留上次额度：'+errs.join('；'));
  }
  window.addEventListener('storage',onStorage);function onStorage(e){if(e.key===KEY+'.quota'){const q=load(KEY+'.quota',{});quota={chat:quotaShape(q?.chat),append:quotaShape(q?.append)};paint();}else if(e.key===KEY+'.balance'){balance=balanceShape(load(KEY+'.balance',null));paint();}}
  // 4. tee 分流：AbortError 是流取消，不是 JSON 解析失败。
  function captureAllowed(url,ct){
    try{const u=new URL(url,location.href);return [location.origin,'https://api.trigger.dev'].includes(u.origin)&&!/^\/ai-proxy\/api\/v1\/runs\//.test(u.pathname)&&(/event-stream|ndjson|stream\+json/i.test(ct||'')||!!streamSid(url));}catch{return false;}
  }
  async function readBranch(reader,ctx,signal){
    const parser=new Lines(f=>frameSeen(f,ctx),(text,e)=>log('warn','解析',text,e,ctx));readers.add(reader);
    let lastData=Date.now(),bytes=0;
    try{
      while(!stopped){
        let chunk;
        try{chunk=await reader.read();}
        catch(e){
          if(enabled&&!stopped){
            if(e.name==='AbortError'||signal?.aborted)log('debug','读流','页面取消了这条流',null,ctx);
            // 空闲的长连接（会话实时通道）约每 30 秒被服务器/代理重置一次，Arena 会自动重连，不影响对话：降为调试日志
            else if(Date.now()-lastData>8000||bytes<2048)log('debug','读流','空闲连接被服务器重置（Arena 会自动重连，不影响对话）',e,ctx);
            else log('warn','读流','网络流断开（回复传输中）',e,ctx);
          }
          break;
        }
        if(chunk.done)break;
        lastData=Date.now();bytes+=chunk.value?.byteLength||0;
        if(enabled){try{parser.feed(chunk.value);}catch(e){parser.buffer='';parser.pending='';log('warn','解码','当前分块解码失败，跳过该块',e,ctx);}}
      }
      if(enabled){try{parser.end();}catch(e){log('warn','解析','尾帧处理失败',e,ctx);}}
    }finally{log('debug','读流','旁路流读取结束',null,ctx);readers.delete(reader);try{reader.releaseLock();}catch{}}
  }
  const wrapped=function(input,init){
    const url=typeof input==='string'?input:input?.url||String(input),method=String(init?.method||input?.method||'GET').toUpperCase();
    if(enabled&&method==='POST'){
      if(init?.body!==undefined){requestSeen(url,init.body);const nb=warmBody(url,init.body);if(nb!==null){init={...init,body:nb};arguments[1]=init;}}
      else if(input?.clone){
        const self=this,args=arguments;
        if(gacha.settings().warmup&&/(\/in\/append|\/stream\/create-chat)$/.test(String(url).split('?')[0]))
          return input.clone().text().then(body=>{requestSeen(url,body);const nb=warmBody(url,body);if(nb!==null){args[0]=new Request(input,{body:nb});}return wrapped.after.call(self,args,url,method,init);},()=>wrapped.after.call(self,args,url,method,init));
        input.clone().text().then(body=>requestSeen(url,body)).catch(()=>{});
      }
    }
    return wrapped.after.call(this,arguments,url,method,init);
  };
  wrapped.after=function(args,url,method,init){
    const input=args[0];
    return native.apply(this,args).then(res=>{
      if(!enabled||stopped)return res;
      let path='';try{path=new URL(res.url||url,location.href).pathname;}catch{}
      if(method==='POST'&&/(\/stream\/create-chat|\/in\/append)$/.test(path))gacha.notePost(path,res.status);
      if(method==='POST'&&/\/in\/append$/.test(path)){try{errReload.noteSendStatus(sidOf(location.href)||streamSid(res.url||url),res.status);}catch{}}
      if(method==='POST'&&/\/stream\/create-chat$/.test(path)){
        if(res.status===429)res.clone().text().then(t=>noteQuota('chat',res.headers,res.status,t)).catch(()=>noteQuota('chat',res.headers,res.status));
        else{noteQuota('chat',res.headers,res.status);if(res.ok&&res.clone){const pend=pendingNew;try{res.clone().json().then(j=>{gacha.noteChatId(j?.id);try{if(typeof j?.id==='string'&&pend?.mid)errReload.noteSend(j.id,{mid:pend.mid,text:pend.prompt,at:pend.at,st:res.status});}catch{}if(typeof j?.id==='string'&&/^[\w-]{8,128}$/.test(j.id))costNew(j.id,pend?.at,pend?.balance);}).catch(()=>{});}catch{}}}
      }
      else if(method==='POST'&&/\/in\/append$/.test(path)){if(res.status===429)res.clone().text().then(t=>noteQuota('append',res.headers,res.status,t)).catch(()=>noteQuota('append',res.headers,res.status));else noteQuota('append',res.headers,res.status);}
      if(res.status===200&&method==='GET'&&/\/api\/billing\/balance$/.test(path)&&res.clone){try{res.clone().json().then(j=>noteBalance(j,'页面请求')).catch(()=>{});}catch{}}
      if(res.status!==200)return res;
      const actual=res.url||url,ct=res.headers.get('content-type')||'';
      if(!captureAllowed(actual,ct))return res;
      const ctx={sid:streamSid(actual)||sidOf(location.href)};
      const t=res.headers.get('public-access-token');if(t)accept(t,ctx.sid);
      try{
        if(!res.body?.tee)return res;
        const [site,probe]=res.body.tee(),replacement=new Response(site,{status:res.status,statusText:res.statusText,headers:res.headers});
        const decorate=response=>{for(const key of ['url','redirected','type']){try{Object.defineProperty(response,key,{value:res[key],configurable:true});}catch{}}const clone=response.clone.bind(response);try{response.clone=()=>decorate(clone());}catch{}return response;};
        log('debug','分流','原生 tee 旁路已建立',null,ctx);void readBranch(probe.getReader(),ctx,init?.signal||input?.signal);return decorate(replacement);
      }catch(e){log('warn','分流','无法建立旁路读取器',e,ctx);return res;}
    });
  };
  wrapped.__orig=native;wrapped.__ampLite=true;window.fetch=wrapped;
  const XO=window.XMLHttpRequest?.prototype,oldOpen=XO&&(XO.open.__orig||XO.open),oldSend=XO&&(XO.send.__orig||XO.send),xhrInfo=new WeakMap();
  let xhrOpen,xhrSend;
  if(XO){
    xhrOpen=function(method,url){xhrInfo.set(this,{url:String(url),method:String(method).toUpperCase()});return oldOpen.apply(this,arguments);};
    xhrSend=function(body){
      const info=xhrInfo.get(this);if(info&&enabled){
        if(info.method==='POST'){requestSeen(info.url,body);const nb=warmBody(info.url,body);if(nb!==null){body=nb;arguments[0]=nb;}}
        let offset=0,parser=null,failed=false;
        const consume=()=>{if(stopped||!enabled||failed)return;try{
          const url=this.responseURL||info.url;if(!captureAllowed(url,this.getResponseHeader('content-type')))return;
          if(this.responseType&&this.responseType!=='text')return;
          parser ||= new Lines(f=>frameSeen(f,{sid:streamSid(url)||sidOf(location.href)}),(text,e)=>log('warn','解析',text,e));
          const text=this.responseText||'';if(text.length>offset){parser.feed(text.slice(offset));offset=text.length;}
        }catch(e){failed=true;log('warn','XHR','响应读取失败',e);}};
        this.addEventListener('progress',consume);this.addEventListener('load',()=>{consume();parser?.end();if(info.method==='POST'){let path='';try{path=new URL(info.url,location.href).pathname;}catch{}if(/(\/stream\/create-chat|\/in\/append)$/.test(path))gacha.notePost(path,this.status);if(/\/stream\/create-chat$/.test(path))noteQuota('chat',{get:k=>this.getResponseHeader(k)},this.status,this.status===429&&(!this.responseType||this.responseType==='text')?this.responseText:null);}},{once:true});
      }
      return oldSend.apply(this,arguments);
    };
    xhrOpen.__orig=oldOpen;xhrSend.__orig=oldSend;XO.open=xhrOpen;XO.send=xhrSend;
  }
  const ES=window.EventSource?.__orig||window.EventSource;let eventSource;
  if(ES){eventSource=function(url,options){const es=new ES(url,options);if(captureAllowed(url,'text/event-stream'))for(const name of ['message','batch'])es.addEventListener(name,e=>{if(!enabled||stopped)return;let data;try{data=JSON.parse(e.data);}catch{return;}try{frameSeen(data,{sid:streamSid(url)||sidOf(location.href)});}catch(err){log('warn','解析','EventSource 帧处理异常',err);}});return es;};eventSource.prototype=ES.prototype;Object.setPrototypeOf(eventSource,ES);eventSource.__orig=ES;window.EventSource=eventSource;}

  // 5. 本地缓存：IndexedDB v3（sessions / snapshots / turns / raw / sent / meta / logs）。事务内分配会话全局序号；原始数据单独存放并受总预算约束。
  class LocalCatalog {
    constructor(){this.entries=new Map();this.snapshots=new Map();this.loading=new Map();this.turnLists=new Map();this.turnCache=new Map();this.fingerprints=new Map();this.pending=new Map();this.localLogs=[];this.pendingLogs=[];this.sent=new Map();this.pendingSent=[];this.sentWrites=0;this.rawTotal=null;this.rawCount=null;this.queue=Promise.resolve();this.seq=0;this.revision=0;this.logRevision=0;this.persistent=false;this.closed=false;this.warned=false;this.ready=this.open();}
    changed(){this.revision++;this.onchange?.();}
    failure(sid){if(this.warned||this.closed)return;this.warned=true;log('warn','本地缓存','本地存储不可用或空间不足；编号与标题不会持久化',null,{sid});}
    open(){return new Promise(resolve=>{let request;try{request=indexedDB.open('amp.lite.local',DB_VERSION);}catch{resolve(null);return;}
      request.onupgradeneeded=e=>{const db=request.result,tx=request.transaction;
        if(e.oldVersion<1){const sessions=db.createObjectStore('sessions',{keyPath:'sid'});sessions.createIndex('seq','seq',{unique:true});db.createObjectStore('snapshots',{keyPath:'sid'});db.createObjectStore('meta',{keyPath:'key'});const logs=db.createObjectStore('logs',{keyPath:'id',autoIncrement:true});logs.createIndex('sid','sid');}
        if(e.oldVersion<2){const turns=db.createObjectStore('turns',{keyPath:'key'});turns.createIndex('sid','sid');
          if(e.oldVersion>=1){// 旧快照迁入 turns；会话名称按“优先带强度后缀的内部名称”重新推导
            const sessions=tx.objectStore('sessions'),cursor=tx.objectStore('snapshots').openCursor();
            cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;const s=localSnapshot(c.value?.data);if(s){turns.put(this.turnRow(s));const g=sessions.get(s.sid);g.onsuccess=()=>{const row=g.result;if(!row)return;const name=nextName(row.name||null,pickName(s));if(name){row.name=name;row.title=('#'+row.seq+' '+name.name).slice(0,100);sessions.put(row);}};}c.continue();};}}
        if(e.oldVersion<3){const raw=db.createObjectStore('raw',{keyPath:'key'});raw.createIndex('at','at');raw.createIndex('sid','sid');const sent=db.createObjectStore('sent',{keyPath:'id'});sent.createIndex('at','at');const meta=tx.objectStore('meta');
          // 原始数据从 turns / snapshots 拆到 raw 表，并统计总量
          let total=0,count=0;const moved=new Set(),empty={events:[],spans:{},probe:null};
          const move=d=>{const r=d?.raw,key=typeof d?.key==='string'?d.key:null;if(r&&typeof r==='object'&&key&&!moved.has(key)&&(r.events?.length||Object.keys(r.spans||{}).length)){moved.add(key);const bytes=JSON.stringify(r).length;total+=bytes;count++;raw.put({key,sid:d.sid,at:typeof d.at==='string'?d.at:new Date(0).toISOString(),bytes,data:r});}return {...d,raw:empty};};
          const finish=()=>{meta.put({key:'rawTotal',value:total});meta.put({key:'rawCount',value:count});};
          const snaps=()=>{const sc=tx.objectStore('snapshots').openCursor();sc.onsuccess=()=>{const c=sc.result;if(!c){finish();return;}const v=c.value;if(v?.data?.raw)c.update({...v,data:move(v.data)});c.continue();};sc.onerror=finish;};
          if(e.oldVersion>=2){const tc=tx.objectStore('turns').openCursor();tc.onsuccess=()=>{const c=tc.result;if(!c){snaps();return;}const v=c.value;if(v?.data?.raw)c.update({...v,data:move(v.data)});c.continue();};tc.onerror=snaps;}
          else if(e.oldVersion>=1)snaps();else finish();}
      };
      request.onerror=()=>resolve(null);request.onblocked=()=>{this.failure(sidOf(location.href));};request.onsuccess=()=>{if(this.closed){request.result.close();resolve(null);return;}this.db=request.result;this.db.onversionchange=()=>{this.db.close();this.persistent=false;this.failure(sidOf(location.href));};resolve(this.db);};
    }).then(async db=>{if(!db){this.failure(sidOf(location.href));return null;}this.persistent=true;await this.migrate().catch(()=>this.failure(sidOf(location.href)));const counters=await this.metaGet(['rawTotal','rawCount']);this.rawTotal=number(counters.rawTotal)??0;this.rawCount=number(counters.rawCount)??0;const rows=await this.rows('sessions',null,null,'next',100000);for(const row of rows){this.entries.set(row.sid,row);this.seq=Math.max(this.seq,row.seq||0);}try{this.channel=new BroadcastChannel('amp.lite.local');this.channel.onmessage=e=>{const row=e.data;if(row?.kind==='session'&&/^\w[\w-]{0,127}$/.test(row.entry?.sid||'')&&number(row.entry.seq)!==null){this.entries.set(row.entry.sid,row.entry);this.snapshots.delete(row.entry.sid);this.loading.delete(row.entry.sid);this.turnLists.delete(row.entry.sid);this.changed();}if(row?.kind==='logs'){this.logRevision++;this.onchange?.();}};}catch{}this.changed();return db;}).catch(()=>{this.persistent=false;this.failure(sidOf(location.href));return null;});}
    migrate(){const old=load('amp.sessions.v2',null);if(!old?.sessions)return Promise.resolve();return new Promise(resolve=>{const tx=this.db.transaction(['sessions','meta'],'readwrite'),store=tx.objectStore('sessions'),count=store.count();count.onsuccess=()=>{if(count.result)return;let max=number(old.seq)||0;const used=new Set();for(const [sid,value]of Object.entries(old.sessions).slice(0,10000)){const seq=number(value?.seq);if(!/^\w[\w-]{0,127}$/.test(sid)||!seq||used.has(seq))continue;used.add(seq);max=Math.max(max,seq);store.put({sid,seq,models:[],title:'',at:null,partial:true,legacy:true});}tx.objectStore('meta').put({key:'seq',value:max});};tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>resolve();});}
    rows(store,index,key,direction='prev',limit=300){if(!this.db)return Promise.resolve([]);return new Promise(resolve=>{const out=[];try{const tx=this.db.transaction(store),source=index?tx.objectStore(store).index(index):tx.objectStore(store),req=source.openCursor(key===null?null:IDBKeyRange.only(key),direction);req.onsuccess=()=>{const c=req.result;if(!c||out.length>=limit){resolve(out);return;}out.push(c.value);c.continue();};req.onerror=()=>resolve(out);}catch{resolve(out);}});}
    metaGet(keys){return new Promise(resolve=>{const out={};if(!this.db){resolve(out);return;}try{const tx=this.db.transaction('meta'),store=tx.objectStore('meta');for(const k of keys){const q=store.get(k);q.onsuccess=()=>{out[k]=q.result?.value;};}tx.oncomplete=()=>resolve(out);tx.onerror=tx.onabort=()=>resolve(out);}catch{resolve(out);}});}
    // turns / snapshots 只存结构化部分；原始数据在 raw 表按 key 关联
    static strip(s){return {...s,raw:{events:[],spans:{},probe:null}};}
    turnRow(s){const last=s.calls.at(-1);return {key:s.key,sid:s.sid,runId:s.runId,turn:s.turn,attempt:s.attempt,segment:s.segment,at:s.at,startedAt:s.startedAt,sentAt:s.sentAt||null,prompt:s.prompt,count:s.count,calls:s.calls.length,model:last?.model||null,internal:last?.internal||s.internalNames[0]||null,effort:last?.effort?.value||null,credits:s.credits?.credits??null,partial:s.partial,rawBytes:JSON.stringify(s.raw||{}).length,data:LocalCatalog.strip(s)};}
    withRaw(data){const s=localSnapshot(data);if(!s||!this.db)return Promise.resolve(s);return new Promise(resolve=>{try{const req=this.db.transaction('raw').objectStore('raw').get(s.key);req.onsuccess=()=>{const r=req.result?.data;if(r&&typeof r==='object')s.raw=sanitizeRaw(r);resolve(s);};req.onerror=()=>resolve(s);}catch{resolve(s);}});}
    getSnapshot(sid){if(this.snapshots.has(sid))return Promise.resolve(this.snapshots.get(sid));if(this.loading.has(sid))return this.loading.get(sid);const p=this.ready.then(()=>new Promise(resolve=>{if(!this.db){resolve(null);return;}try{const req=this.db.transaction('snapshots').objectStore('snapshots').get(sid);req.onsuccess=()=>resolve(this.withRaw(req.result?.data));req.onerror=()=>resolve(null);}catch{resolve(null);}})).then(s=>{if(s)this.snapshots.set(sid,s);return s;});this.loading.set(sid,p);return p;}
    // 某会话的轮次列表（不含快照正文），按开始时间升序
    turnsOf(sid){if(!sid)return [];if(!this.turnLists.has(sid)){this.turnLists.set(sid,[]);void this.loadTurns(sid);}return this.turnLists.get(sid);}
    async loadTurns(sid){await this.ready;const rows=this.db?await this.rows('turns','sid',sid,'next',400):[];const list=rows.map(({data,...meta})=>meta).sort((a,b)=>(a.startedAt||a.at).localeCompare(b.startedAt||b.at)||a.at.localeCompare(b.at));const memory=this.turnLists.get(sid)||[];for(const m of memory)if(!list.some(x=>x.key===m.key))list.push(m);this.turnLists.set(sid,list);this.changed();}
    remember(key,s){this.turnCache.delete(key);this.turnCache.set(key,s);while(this.turnCache.size>12)this.turnCache.delete(this.turnCache.keys().next().value);}
    getTurn(key){if(this.turnCache.has(key))return Promise.resolve(this.turnCache.get(key));return this.ready.then(()=>new Promise(resolve=>{if(!this.db){resolve(null);return;}try{const req=this.db.transaction('turns').objectStore('turns').get(key);req.onsuccess=()=>{resolve(this.withRaw(req.result?.data).then(s=>{if(s)this.remember(key,s);return s;}));};req.onerror=()=>resolve(null);}catch{resolve(null);}}));}
    // importOnly：来自 localStorage 旧历史的导入，只在 IndexedDB 尚无该会话时写入，避免覆盖更完整的记录
    record(input,quiet=false,importOnly=false){const s=localSnapshot(input);if(!s||!s.calls.some(c=>c.model!=='未提供'))return Promise.resolve(null);const fingerprint=JSON.stringify({...s,at:''});if(this.fingerprints.get(s.key)===fingerprint)return Promise.resolve(this.entries.get(s.sid));this.fingerprints.set(s.key,fingerprint);
      this.pending.set(s.key,{s,quiet,importOnly});
      this.queue=this.queue.then(()=>this.ready).then(()=>{const job=this.pending.get(s.key);if(!job||job.s!==s)return null;this.pending.delete(s.key);return this.commit(job.s,job.importOnly).then(result=>{if(!result)return null;const {entry,applied,turnWritten}=result,before=this.entries.get(s.sid);this.entries.set(s.sid,entry);if(applied){this.snapshots.set(s.sid,s);}else if(this.db){this.snapshots.delete(s.sid);this.loading.delete(s.sid);}
        if(turnWritten){this.remember(s.key,s);const list=this.turnLists.get(s.sid);if(list){const {data,...meta}=this.turnRow(s);const i=list.findIndex(x=>x.key===meta.key);if(i>=0)list[i]=meta;else{list.push(meta);list.sort((a,b)=>(a.startedAt||a.at).localeCompare(b.startedAt||b.at)||a.at.localeCompare(b.at));}}}
        this.seq=Math.max(this.seq,entry.seq);this.changed();try{this.channel?.postMessage({kind:'session',entry});}catch{}try{this.onentry?.(entry,before,s,job.quiet||job.importOnly);}catch{}
        if(!job.quiet&&(!before||before.title!==entry.title))log('info','本地标题',(this.persistent?'已保存':'临时记录')+' '+entry.title,null,{sid:s.sid,runId:s.runId});else if(!job.quiet&&applied)log('detail','本地缓存','已更新 #'+entry.seq+' '+turnLabel(s)+' 的快照',null,{sid:s.sid,runId:s.runId});return entry;});}).catch(()=>{this.fingerprints.delete(s.key);this.failure(s.sid);return null;});return this.queue;
    }
    commit(s,importOnly=false){const serving=servingCalls(s),models=[...new Set(serving.map(c=>c.request||c.model).filter(n=>n&&n!=='未提供'))],pick=pickName(s),routed=serving.length!==s.calls.length||!!s.routing;
      const make=(seq,old)=>{const newer=!old?.at||old.at<=s.at,follow=newer&&pick?.source==='internal'&&old?.name?.name&&pick.name!==old.name.name;const name=(follow?pick:nextName(old?.name||(old?.models?.length?{name:old.models.join(' / '),source:'request',locked:false}:null),pick))||{name:models.join(' / '),source:'request',locked:false};return {sid:s.sid,seq,models:[...new Set([...(old?.models||[]),...models])].slice(0,8),name,title:('#'+seq+' '+name.name).slice(0,100),vendor:brand.of(serving.map(c=>(c.internal||'')+' '+(c.response||'')).join(' ')+' '+(routed?'':(s.internalNames||[]).join(' ')))||old?.vendor||null,vmodel:(()=>{const c=[...serving].reverse().find(c=>brand.of(c.internal)||brand.of(c.response));return c?(brand.of(c.internal)?c.internal:c.response):((routed?[]:(s.internalNames||[])).find(n=>brand.of(n))||old?.vmodel||null);})(),at:old?.at&&old.at>s.at?old.at:s.at,partial:s.partial,temporary:!this.persistent,runId:s.runId,turn:s.turn,turns:old?.turns||1,cloud:old?.cloud||null};};
      if(!this.db){const old=this.entries.get(s.sid);if(importOnly&&old)return Promise.resolve({entry:old,applied:false,turnWritten:false});const entry=make(old?.seq||++this.seq,old);const applied=!old?.at||old.at<=s.at;return Promise.resolve({entry,applied,turnWritten:applied});}
      return new Promise((resolve,reject)=>{let entry,applied=true,turnWritten=false;const tx=this.db.transaction(['sessions','snapshots','turns','raw','meta'],'readwrite'),sessions=tx.objectStore('sessions'),turns=tx.objectStore('turns'),meta=tx.objectStore('meta'),req=sessions.get(s.sid);
        const put=(seq,old)=>{if(!Number.isSafeInteger(seq)||seq<1){tx.abort();return;}entry=make(seq,old);const prev=turns.get(s.key);prev.onsuccess=()=>{if(!prev.result?.at||prev.result.at<=s.at){turns.put(this.turnRow(s));turnWritten=true;this.writeRaw(tx,s);}const cnt=turns.index('sid').count(IDBKeyRange.only(s.sid));cnt.onsuccess=()=>{entry.turns=Math.max(1,cnt.result||0);sessions.put(entry);};};if(!old?.at||old.at<=s.at)tx.objectStore('snapshots').put({sid:s.sid,data:LocalCatalog.strip(s)});else applied=false;};
        req.onsuccess=()=>{if(req.result){if(importOnly){entry=req.result;applied=false;return;}put(req.result.seq,req.result);return;}const counter=meta.get('seq');counter.onsuccess=()=>{const seq=(number(counter.result?.value)||0)+1;meta.put({key:'seq',value:seq});put(seq,null);};};tx.oncomplete=()=>resolve({entry,applied,turnWritten});tx.onerror=tx.onabort=()=>reject(tx.error||Error('本地事务失败'));});
    }
    // 原始数据写入 raw 表并维护总量；超过预算时按时间从最旧的轮开始删除
    writeRaw(tx,s){const r=s.raw;if(!r||!(r.events?.length||Object.keys(r.spans||{}).length||r.probe))return;const store=tx.objectStore('raw'),meta=tx.objectStore('meta'),bytes=JSON.stringify(r).length,prev=store.get(s.key);
      prev.onsuccess=()=>{const old=prev.result?.bytes||0;store.put({key:s.key,sid:s.sid,at:s.at,bytes,data:r});const mt=meta.get('rawTotal'),mc=meta.get('rawCount');
        mc.onsuccess=()=>{let total=Math.max(0,(number(mt.result?.value)||0)-old)+bytes,count=(number(mc.result?.value)||0)+(prev.result?0:1),removed=0,freed=0;const budget=(BUDGET_OPTIONS.includes(prefs.rawBudget)?prefs.rawBudget:64)*1048576;
          const done=()=>{this.rawTotal=Math.max(0,total);this.rawCount=Math.max(0,count-removed);meta.put({key:'rawTotal',value:this.rawTotal});meta.put({key:'rawCount',value:this.rawCount});if(removed)log('detail','本地缓存','原始数据超出预算，已清理最旧 '+removed+' 轮（'+(freed/1048576).toFixed(1)+' MB）');};
          if(total<=budget){done();return;}const cur=store.index('at').openCursor();cur.onsuccess=()=>{const c=cur.result;if(!c||total<=budget){done();return;}if(c.value.key!==s.key){total-=c.value.bytes||0;freed+=c.value.bytes||0;removed++;c.delete();}c.continue();};cur.onerror=done;};};}
    setCloud(sid,cloud){return this.ready.then(()=>new Promise(resolve=>{const e=this.entries.get(sid);if(e){e.cloud=cloud;this.changed();}if(!this.db){resolve();return;}try{const tx=this.db.transaction('sessions','readwrite'),store=tx.objectStore('sessions'),q=store.get(sid);q.onsuccess=()=>{if(q.result){q.result.cloud=cloud;store.put(q.result);}};tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();}catch{resolve();}}));}
    // 消息发送时间（非 UUIDv7 消息 id 的回退来源）
    noteSent(id,at,sid){if(this.closed||typeof id!=='string'||!Number.isFinite(at))return;this.sent.set(id,at);if(this.sent.size>SENT_KEEP)this.sent.delete(this.sent.keys().next().value);this.pendingSent.push({id,at,sid:sid||''});if(!this.sentTimer)this.sentTimer=setTimeout(()=>this.flushSent(),500);}
    async flushSent(){this.sentTimer=0;await this.ready;const items=this.pendingSent.splice(0);if(!this.db||this.closed||!items.length)return;try{const tx=this.db.transaction('sent','readwrite'),store=tx.objectStore('sent');for(const e of items)store.put(e);this.sentWrites+=items.length;if(this.sentWrites>=100){this.sentWrites=0;const cnt=store.count();cnt.onsuccess=()=>{let extra=cnt.result-SENT_KEEP;if(extra<=0)return;const cur=store.index('at').openCursor();cur.onsuccess=()=>{const c=cur.result;if(!c||extra<=0)return;c.delete();extra--;c.continue();};};}}catch{}}
    sentAt(ids){const out=new Map(),missing=[];for(const id of ids){if(this.sent.has(id)){const at=this.sent.get(id);if(at!==null)out.set(id,at);}else missing.push(id);}if(!missing.length)return Promise.resolve(out);
      return this.ready.then(()=>new Promise(resolve=>{if(!this.db){resolve(out);return;}try{const store=this.db.transaction('sent').objectStore('sent');let n=0;const step=()=>{if(++n===missing.length)resolve(out);};for(const id of missing){const q=store.get(id);q.onsuccess=()=>{const at=number(q.result?.at);this.sent.set(id,at);if(at!==null)out.set(id,at);step();};q.onerror=step;}}catch{resolve(out);}}));}
    count(store){return new Promise(resolve=>{if(!this.db){resolve(null);return;}try{const q=this.db.transaction(store).objectStore(store).count();q.onsuccess=()=>resolve(q.result);q.onerror=()=>resolve(null);}catch{resolve(null);}});}
    async usage(){await this.ready;let estimate=null;try{const e=await navigator.storage?.estimate?.();if(e)estimate={usage:number(Math.round(e.usage||0)),quota:number(Math.round(e.quota||0))};}catch{}const counts={};for(const st of ['sessions','turns','raw','logs','sent'])counts[st]=await this.count(st);return {rawTotal:this.rawTotal,rawCount:this.rawCount,counts,estimate,persistent:this.persistent};}
    async clearRaw(){await this.ready;if(this.db)await new Promise(resolve=>{try{const tx=this.db.transaction(['raw','meta'],'readwrite');tx.objectStore('raw').clear();tx.objectStore('meta').put({key:'rawTotal',value:0});tx.objectStore('meta').put({key:'rawCount',value:0});tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();}catch{resolve();}});this.rawTotal=0;this.rawCount=0;for(const s of this.turnCache.values())s.raw={events:[],spans:{},probe:null};this.changed();}
    async exportAll(withRaw=false){await this.ready;const sessions=[...this.entries.values()].sort((a,b)=>(a.seq||0)-(b.seq||0)),rows=this.db?await this.rows('turns',null,null,'next',100000):[];const raw=new Map();if(withRaw&&this.db)for(const r of await this.rows('raw',null,null,'next',100000))raw.set(r.key,r.data);
      return {sessions,turns:rows.map(({data,...meta})=>({...meta,data:data?(withRaw?{...data,raw:raw.get(meta.key)||null}:LocalCatalog.strip(data)):null})),rawIncluded:withRaw};}
    addLog(entry){if(this.closed)return;const e={at:entry.at,level:entry.level,stage:String(entry.stage).slice(0,40),text:String(entry.text).slice(0,1600),sid:entry.sid||'',runId:entry.runId||null,spanId:entry.spanId||null};this.localLogs.push(e);if(this.localLogs.length>600)this.localLogs.shift();this.pendingLogs.push(e);this.logRevision++;if(!this.flushTimer)this.flushTimer=setTimeout(()=>this.flush(),350);}
    async flush(){this.flushTimer=0;await this.ready;const items=this.pendingLogs.splice(0);if(!this.db||this.closed||!items.length)return;try{const tx=this.db.transaction('logs','readwrite'),store=tx.objectStore('logs');let last=0;for(const [i,e]of items.entries()){const req=store.add(e);req.onsuccess=()=>{last=req.result;if(i===items.length-1&&last>4000){const cursor=store.openCursor(IDBKeyRange.upperBound(last-4000));cursor.onsuccess=()=>{const c=cursor.result;if(c){c.delete();c.continue();}};}};}tx.oncomplete=()=>{this.logRevision++;this.onchange?.();try{this.channel?.postMessage({kind:'logs'});}catch{}};tx.onerror=()=>{this.pendingLogs=[];};}catch{this.pendingLogs=[];}}
    async readLogs(sid){await this.ready;const memory=this.localLogs.filter(e=>!e.sid||e.sid===sid);if(!this.db)return memory.slice(-600);const persisted=await this.rows('logs','sid',sid||'','prev',600),global=await this.rows('logs','sid','','prev',40),seen=new Set();return [...persisted,...global,...memory].sort((a,b)=>a.at.localeCompare(b.at)).filter(e=>{const k=[e.at,e.level,e.stage,e.text,e.sid,e.runId,e.spanId].join('|');if(seen.has(k))return false;seen.add(k);return true;}).slice(-600);}
    async clearLogs(){this.localLogs=[];this.pendingLogs=[];logs.length=0;await this.ready;if(this.db)await new Promise(resolve=>{try{const tx=this.db.transaction('logs','readwrite');tx.objectStore('logs').clear();tx.oncomplete=tx.onerror=()=>resolve();}catch{resolve();}});this.logRevision++;this.onchange?.();try{this.channel?.postMessage({kind:'logs'});}catch{}}
    destroy(){this.closed=true;clearTimeout(this.flushTimer);clearTimeout(this.sentTimer);this.channel?.close();this.db?.close();}
  }
  const catalog=new LocalCatalog();onSnapshot=s=>void catalog.record(s);onLog=e=>catalog.addLog(e);onSent=(id,at)=>catalog.noteSent(id,at,sidOf(location.href));catalog.onchange=()=>{paint();brandTick();};
  // 厂商图标：对话名没有关键词时，用本地缓存里的内部名称/请求型号识别厂商。
  brand.hint.get=sid=>{const e=sid&&catalog.entries.get(sid);return e?[e.vendor,e.name?.name,...(e.models||[])].filter(Boolean).join(' '):'';};brand.hint.rev=()=>catalog.revision;
  let brandTimer=0;function brandTick(){if(brandTimer)return;brandTimer=setTimeout(()=>{brandTimer=0;try{window.dispatchEvent(new CustomEvent('amp-native-gacha'));}catch{}},250);}
  // 云端标题同步（可选，默认关闭）：PATCH /api/history/agentic/{sid}，即页面自带“重命名”所用接口；每个会话同一标题只发一次
  const cloudState=new Map();
  async function syncTitle(entry,manual=false){
    if(stopped||!enabled||!entry?.title||!entry.name?.name||entry.temporary||gacha.ownsTitle(entry.sid))return false;if(!prefs.cloudSync&&!manual)return false;
    const want=(prefs.cloudFormat==='name'?entry.name.name:entry.title).slice(0,100);
    if(entry.cloud?.title===want||!manual&&!(entry.name.locked||!entry.partial))return false;
    const st=cloudState.get(entry.sid)||{at:0,fails:0},now=Date.now();if(!manual&&(now-st.at<60000||st.fails>=3))return false;st.at=now;cloudState.set(entry.sid,st);
    if(!manual){await gacha.waitIdle();if(stopped||entry.cloud?.title===want)return false;}
    try{const res=await rawFetch(location.origin+'/api/history/agentic/'+encodeURIComponent(entry.sid),{method:'PATCH',headers:{'content-type':'application/json',Accept:'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({title:want})});
      if(!res.ok){st.fails++;log('warn','云端标题','PATCH HTTP '+res.status+(res.status===401||res.status===403?' · 需要登录':''),null,{sid:entry.sid});return false;}
      st.fails=0;await catalog.setCloud(entry.sid,{title:want,at:new Date().toISOString()});log('info','云端标题','已同步 '+want,null,{sid:entry.sid});paint();return true;
    }catch(e){st.fails++;log('warn','云端标题','同步失败',e,{sid:entry.sid});return false;}
  }
  catalog.onentry=(entry,before,snap,quiet)=>{try{if(snap?.calls?.length&&(!entry.at||!snap.at||snap.at>=entry.at)){const calls=servingCalls(snap).filter(c=>c.model!=='未提供'),reqs=[...new Set(calls.map(c=>c.request).filter(Boolean))],last=calls.at(-1)||{},resp=last.response||last.internal||last.request||null,label='#'+entry.seq+' · '+(entry.title||'').replace(/^#\d+\s*/,'');const v=vip.note(entry.sid,reqs);void v;if(resp)routeAlert.note(entry.sid,resp,label,quiet);}}catch{}const o=before?.name?.name,n=entry?.name?.name;if(o&&n&&o!==n&&entry.name.source==='internal'){log('info','模型变化',o+' → '+n,null,{sid:entry.sid});try{gacha.followModel(entry.sid,o,n);}catch{}if(entry.cloud?.title&&!gacha.ownsTitle(entry.sid))void syncTitle(entry,true);paint();}else void syncTitle(entry);try{window.dispatchEvent(new Event('amp-title-sync'));}catch{}};
  void catalog.ready.then(async()=>{for(const s of history.slice().reverse())await catalog.record(s,true,true);});
  const css=`
:host{all:initial;position:relative;color-scheme:inherit;font:400 13px/1.55 var(--font-basel-grotesk,var(--font-inter,system-ui)),'PingFang SC','Microsoft YaHei',sans-serif;color:var(--fg);--bg:hsl(var(--surface-primary,36 45% 98%));--raised:hsl(var(--surface-tertiary,33 31% 94%));--line:hsl(var(--border-faint,30 5% 93%));--edge:hsl(var(--border-medium,30 9% 87%));--fg:hsl(var(--text-primary,24 6% 17%));--secondary:hsl(var(--text-tertiary,35 6% 38%));--heading:hsl(var(--header-primary,60 3% 14%));--green:hsl(var(--interactive-positive,125 49% 43%));--warn:hsl(var(--syntax-yellow,48 92% 38%));--mono:var(--font-basel-grotesk-mono,var(--font-dm-mono,ui-monospace)),Consolas,monospace}
:host([hidden]),[hidden]{display:none!important}:host([data-floating]){position:fixed;top:12px;right:56px;z-index:40;margin:0}
*{box-sizing:border-box}button,select{font:inherit;color:inherit}button{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:none;border:0;border-radius:4px;padding:5px 8px;cursor:pointer;transition:background .12s,color .12s}button:hover{background:var(--raised);color:var(--heading)}button:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--heading);outline-offset:2px}button:disabled{opacity:.4;cursor:default}button:disabled:hover{background:none}svg{display:block;flex:none;width:16px;height:16px;pointer-events:none}h2,h3,p{margin:0}h2{font-size:14px;font-weight:500;color:var(--heading)}h3{font-size:12px;font-weight:500;color:var(--secondary)}.mono,code{font-family:var(--mono);font-variant-numeric:tabular-nums}code{overflow-wrap:anywhere}.muted{color:var(--secondary)}.warning{color:var(--warn)}.grow{flex:1;min-width:0}.icon-button{width:28px;height:28px;padding:6px;color:var(--secondary);flex:none}.icon-button svg{width:15px;height:15px}
.trigger{height:32px;max-width:310px;padding:0 8px;gap:8px;font-size:12px;white-space:nowrap}.trigger[aria-expanded=true]{background:var(--raised)}.trigger-label{overflow:hidden;text-overflow:ellipsis;max-width:168px}.trigger-mini{font-size:11px;color:var(--secondary);border-left:1px solid var(--edge);padding-left:8px}.chevron{width:12px;height:12px;color:var(--secondary)}
.head{display:flex;align-items:center;gap:8px;padding:12px 16px 8px;flex:none}.head>.grow{display:flex;align-items:center;gap:8px}.return-live{font-size:11px;padding:2px 5px}
.tabs{display:flex;gap:16px;padding:0 16px;border-bottom:1px solid var(--line);flex:none;overflow-x:auto;scrollbar-width:none}.tab{position:relative;border-radius:0;padding:8px 0 10px;color:var(--secondary);font-size:12px;flex:none}.tab[aria-selected=true]{color:var(--heading)}.tab[aria-selected=true]:after{content:'';position:absolute;bottom:-1px;left:0;right:0;height:2px;background:var(--heading)}.tab:hover{background:none}
.pickers{display:flex;flex-direction:column;gap:6px;margin:12px 14px 0;flex:none}.call-picker{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--secondary)}.call-picker>span:first-child{flex:none;width:28px}.selector{flex:1;min-width:0;border:1px solid var(--edge);border-radius:4px;background:var(--bg);color:var(--fg);padding:5px 7px;font-size:12px;max-width:100%}.selector option{background:var(--bg);color:var(--fg)}
.body{padding:16px;overflow:auto;overscroll-behavior:contain;min-height:0;scrollbar-width:thin;scrollbar-color:var(--edge) transparent}.section+.section{margin-top:20px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.eyebrow{font-size:11px;color:var(--secondary)}.model-title{display:flex;align-items:flex-start;gap:6px;margin:4px 0 10px}.name{font:400 17px/1.5 var(--mono);letter-spacing:-.025em;overflow-wrap:anywhere;min-width:0;flex:1;color:var(--heading)}.model-title .icon-button{margin-right:-5px;margin-top:-1px}.row{display:grid;grid-template-columns:80px minmax(0,1fr);align-items:baseline;gap:10px;padding:6px 0;font-size:12px}.key{color:var(--secondary)}.value{overflow-wrap:anywhere;white-space:pre-wrap;min-width:0}.model-more{margin-top:5px;padding-top:6px;border-top:1px solid var(--line)}summary{display:flex;align-items:center;gap:5px;cursor:pointer;font-size:11px;color:var(--secondary);list-style:none;padding:3px 0}summary::-webkit-details-marker{display:none}summary svg{width:12px;height:12px}details[open]>summary svg{transform:rotate(90deg)}
.config{border:1px solid var(--edge);border-radius:6px;overflow:hidden}.config-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 12px;font-size:12px}.config-row+.config-row{border-top:1px solid var(--line)}.config-label{color:var(--secondary)}.config-value{font:400 14px/1.3 var(--mono);overflow-wrap:anywhere;text-align:right;max-width:60%}.tag{font:400 15px/1.3 var(--mono);background:var(--raised);border-radius:4px;padding:4px 7px;color:var(--heading)}.note{font-size:11px;line-height:1.65;color:var(--secondary);margin-top:7px;overflow-wrap:anywhere}.note.warning{color:var(--warn)}.usage{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}.usage-cell{min-width:0}.usage-label{font-size:11px;color:var(--secondary)}.usage-value{font:400 17px/1.5 var(--mono);letter-spacing:-.035em;margin:3px 0 1px;overflow-wrap:anywhere;color:var(--heading)}.usage-total{display:flex;justify-content:space-between;gap:10px;padding-top:10px;margin-top:9px;border-top:1px solid var(--line);font-size:11px;color:var(--secondary)}.usage-total strong{font-weight:400;color:var(--fg)}.usage-turn{margin-top:10px;padding-top:8px;border-top:1px dashed var(--line);font-size:11px;color:var(--secondary);display:flex;flex-wrap:wrap;gap:3px 12px}.usage-turn strong{font-weight:400;color:var(--fg);font-family:var(--mono)}.pill{display:inline-block;font-size:10px;padding:1px 5px;border-radius:3px;background:var(--raised);color:var(--secondary);margin-left:6px;vertical-align:middle;font-family:inherit}
.empty{padding:28px 10px 32px;text-align:center}.empty-icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border:1px solid var(--edge);border-radius:8px;color:var(--secondary);margin-bottom:12px}.empty-icon svg{width:19px;height:19px}.empty strong{font-size:14px;font-weight:500;display:block;color:var(--heading)}.empty p{font-size:12px;line-height:1.9;color:var(--secondary);margin-top:7px;white-space:pre-line}
.group-title{font-size:11px;color:var(--secondary);margin:16px 0 2px}.group-title:first-child{margin-top:0}.entry{padding:10px 0;border-top:1px solid var(--line);font-size:12px}.entry-top{display:flex;justify-content:space-between;gap:8px}.entry-source{font-size:10px;color:var(--secondary);flex:none}.entry code{display:block;margin-top:4px;font-size:11px;color:var(--secondary)}.legend{font-size:10px;line-height:1.7;color:var(--secondary);margin-top:12px;padding-top:8px;border-top:1px solid var(--line)}.legend code{font-size:10px}
.history-item{width:100%;display:block;text-align:left;padding:11px 8px;border-bottom:1px solid var(--line);border-radius:4px;font-size:12px}.history-item[data-open]{background:var(--raised)}.history-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}.history-meta{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--secondary);margin-top:4px}.turn-list{margin:4px 0 10px 6px;border-left:1px solid var(--edge);padding-left:6px}.turn-item{width:100%;display:block;text-align:left;padding:8px;border-radius:4px;font-size:12px}.turn-item[data-current]{outline:1px solid var(--edge)}.turn-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.turn-meta{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--secondary);margin-top:3px;font-family:var(--mono)}.clear{font-size:11px;color:var(--secondary);margin-top:12px}
.logline{border-top:1px solid var(--line);padding:10px 0;font-size:12px;overflow-wrap:anywhere}.log-meta{display:flex;justify-content:space-between;color:var(--secondary);font-size:10px;margin-bottom:4px}.logline.warn{color:var(--warn)}.logline.error{color:hsl(var(--interactive-negative,2 63% 54%))}.log-origin{margin-top:4px}.log-origin summary{font-size:10px}.log-origin code{display:block;font-size:10px;word-break:break-all;color:var(--secondary)}
.footer{padding:8px 10px;display:flex;align-items:center;gap:2px;border-top:1px solid var(--line);flex:none}.footer button{font-size:11px;color:var(--secondary);gap:5px}.footer svg{width:13px;height:13px}.upd{cursor:pointer;border:0;background:none;border-radius:6px;padding:3px 6px!important}.upd:hover{background:var(--line)}.upd[data-new='1']{color:#fff!important;background:#6a5e54}
.upds{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:1px;min-width:0}.upds .footer-note{margin-left:0;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}.upd[data-miss='1']{opacity:.7}.footer-note{margin-left:auto;font:10px var(--mono);color:var(--secondary);padding-right:3px}.toast{font-size:11px;text-align:center;color:var(--secondary);padding:6px 12px;border-top:1px solid var(--line);flex:none}
.raw-controls{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px}.raw-controls .selector{flex:1;min-width:110px}.raw-controls button{font-size:11px;border:1px solid var(--edge);padding:4px 7px}.event-row{display:grid;grid-template-columns:54px minmax(0,1fr) auto;gap:8px;padding:5px 0;border-top:1px solid var(--line);font-size:11px;align-items:baseline;width:100%;text-align:left;border-radius:0;color:var(--fg)}.event-row[data-kind=stream]{color:var(--heading)}.event-row[data-kind=marker]{color:var(--warn)}.event-row[data-active]{background:var(--raised)}.event-row time{font-family:var(--mono);font-size:10px;color:var(--secondary)}.event-msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.event-extra{font-family:var(--mono);font-size:10px;color:var(--secondary);white-space:nowrap}pre.json{margin:8px 0 0;padding:10px;border:1px solid var(--edge);border-radius:6px;background:var(--raised);font:11px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto;color:var(--fg)}
.theme-toggle{width:32px;max-width:32px;padding:0;justify-content:center}.theme-toggle .trigger-label,.theme-toggle .trigger-mini{display:none!important}.theme-toggle svg{transition:transform .4s cubic-bezier(.34,1.6,.5,1)}.theme-toggle:hover svg{transform:rotate(-20deg) scale(1.1)}@media(max-width:767px){.trigger{width:32px;max-width:32px;padding:0;justify-content:center}.trigger-label,.trigger-mini,.trigger>.chevron{display:none}.usage-value{font-size:17px}:host{margin-inline-end:4px}}@media(prefers-reduced-motion:reduce){button{transition:none}}
:host([data-entry]){display:inline-flex;vertical-align:top;margin-inline-end:6px;flex:none}
:host([data-dock]){display:block;flex:0 0 var(--amp-width,340px);width:var(--amp-width,340px);min-width:0;height:calc(100dvh - var(--amp-bar-h,0px));align-self:stretch;margin:0;z-index:1;position:relative}
.panel{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--bg);border-left:1px solid var(--edge);position:relative}.resizer{position:absolute;top:0;bottom:0;left:-3px;width:7px;cursor:col-resize;z-index:5;touch-action:none}.resizer:hover,.resizer[data-active]{background:var(--edge)}.drag-shield{position:fixed;inset:0;z-index:2147483000;cursor:col-resize;user-select:none}
.head{min-height:52px;padding:10px 14px}.head>.grow{gap:9px}.head .icon-button{margin-left:auto}.local-number{font-size:11px;color:var(--secondary)}.body{flex:1;padding:14px;min-height:0}.name{font-size:16px}.section+.section{margin-top:17px}.tabs{padding:0 14px}.config-row{padding:9px 10px}.config-label{font-size:12px}.row{grid-template-columns:76px minmax(0,1fr);gap:8px}.footer{padding:8px 9px}.cache-banner{display:flex;align-items:center;gap:8px;padding:5px 14px 9px;font-size:10px;color:var(--secondary)}.compact-bar{display:none}.log-controls{display:flex;align-items:center;gap:12px;margin-bottom:8px}.log-controls .selector{margin-left:auto;flex:none;width:100px}.log-actions{display:flex;gap:6px;flex-wrap:wrap}.log-actions button{font-size:11px;border:1px solid var(--edge);padding:4px 7px}
:host([data-compact]){width:100%;height:var(--amp-sheet-h,50dvh);flex:0 0 auto;margin:0;max-height:none;z-index:2}.panel .compact-top{display:flex;align-items:center;gap:2px}.compact-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 13px/1.35 var(--mono);color:var(--heading);letter-spacing:-.01em}.compact-info{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px;color:var(--secondary);margin-top:1px}.ci-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}:host([data-compact]) .panel{height:100%;max-height:none;border-left:0;border-top:1px solid var(--edge);border-radius:16px 16px 0 0;box-shadow:0 -10px 28px -14px #0000004d}:host([data-compact]) .resizer{display:none}:host([data-compact]) .compact-bar{display:block;padding:0 6px 8px 14px;flex:none;touch-action:none;-webkit-user-select:none;user-select:none;cursor:grab}:host([data-compact]) .head{display:none}:host([data-compact]:not([data-expanded])) :is(.tabs,.subtabs,.cache-banner,.pickers,.body,.toast){display:none}:host([data-compact]) .body{max-height:none}
.logbar{padding:12px 14px 0;flex:none}:host([data-compact]:not([data-expanded])) .logbar{display:none}

:host([data-grip]){display:block;position:fixed;top:0;width:0;height:0;z-index:60}.grip{position:fixed;width:6px;cursor:col-resize;touch-action:none;z-index:60}.grip:hover,.grip[data-active]{background:var(--edge)}
.status{display:flex;flex-wrap:wrap;gap:4px 12px;padding:6px 14px 0;font-size:11px;color:var(--secondary);flex:none;min-height:0}.status[hidden]{display:none}.status strong{font-weight:400;color:var(--fg);font-family:var(--mono)}.status .blocked{color:hsl(var(--interactive-negative,2 63% 54%))}.status .low{color:var(--warn)}
.setting{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--line);font-size:12px}.setting:first-of-type{border-top:0}.setting .grow{display:flex;flex-direction:column;gap:2px}.setting .hint{font-size:10px;color:var(--secondary);line-height:1.5}.setting .selector{flex:none;width:112px}.switch{position:relative;width:34px;height:20px;border-radius:10px;background:var(--edge);flex:none;padding:0;transition:background .12s}.switch[aria-checked=true]{background:var(--green)}.switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--bg);transition:transform .12s}.switch[aria-checked=true]::after{transform:translateX(14px)}.switch:hover{background:var(--edge)}.switch[aria-checked=true]:hover{background:var(--green)}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}.stat{border:1px solid var(--edge);border-radius:6px;padding:8px 10px}.stat-label{font-size:10px;color:var(--secondary)}.stat-value{font:400 13px/1.5 var(--mono);color:var(--heading);overflow-wrap:anywhere}.bar{height:4px;border-radius:2px;background:var(--raised);overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:var(--heading)}
:host([data-fold]){display:block;position:fixed;top:0;left:0;width:0;height:0;z-index:45}.fold{position:fixed;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:22px;min-height:40px;padding:10px 0;border:1px solid var(--edge);border-right:0;border-radius:10px 0 0 10px;background:var(--bg);color:var(--secondary);box-shadow:-3px 2px 12px #00000014;font-size:11px;line-height:1.2}.fold:hover{background:var(--raised);color:var(--heading)}.fold svg{width:14px;height:14px;transform:rotate(180deg);transition:transform .2s}.fold[data-open] svg{transform:none}.fold-label{writing-mode:vertical-rl;letter-spacing:2px;font-weight:500}.fold[data-open] .fold-label{display:none}
.head-fold{margin-left:auto;flex:none;height:28px;padding:0 6px 0 10px;gap:2px;font-size:12px;color:var(--secondary);border:1px solid var(--edge);border-radius:14px}.head-fold svg{width:14px;height:14px}
.upd.chentry{opacity:.55}.upd.chentry:hover{opacity:1}.chform{display:flex;align-items:center;gap:4px;padding:2px 0 1px}.chform input{width:118px;height:22px;box-sizing:border-box;padding:0 7px;border:1px solid var(--edge);border-radius:6px;background:var(--bg);color:var(--fg);font:11px var(--mono);outline:0}.chform input:focus{border-color:var(--secondary)}.chform input[data-bad]{border-color:#c0584f;animation:chshake .28s}.chform button{height:22px;padding:0 8px!important;border:1px solid var(--edge);border-radius:6px}@keyframes chshake{25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
.section.spend{margin-top:0}.spend .section-heading{margin-bottom:8px}.unit{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--edge);border-radius:8px}.unit button{height:20px;padding:0 8px!important;border:0;border-radius:6px;font-size:11px;color:var(--secondary);background:none}.unit button[aria-pressed="true"],.unit button[aria-pressed="true"]:hover{background:var(--heading);color:var(--bg)}.spend-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.spend-cell{min-width:0;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:var(--raised)}.spend-value{font:500 18px/1.35 var(--mono);letter-spacing:-.03em;color:var(--heading);margin:2px 0 1px;overflow-wrap:anywhere}.spend-sub{font-size:10.5px;line-height:1.45;color:var(--secondary);overflow-wrap:anywhere}.spend-sub span{display:inline-block}.spend+.empty{margin-top:10px}
 .detect-card{padding:12px 13px;border:1px solid var(--line);border-radius:10px;background:var(--raised)}.detect-state{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--secondary)}.detect-state i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--edge)}.detect-card[data-tone=same] .detect-state i{background:var(--green)}.detect-card[data-tone=changed] .detect-state,.detect-card[data-tone=error] .detect-state{color:var(--warn)}.detect-card[data-tone=changed] .detect-state i,.detect-card[data-tone=error] .detect-state i{background:var(--warn)}.detect-card[data-tone=busy] .detect-state i{background:var(--heading);animation:ampPulse 1s ease-in-out infinite}@keyframes ampPulse{50%{opacity:.2}}
.detect-model{display:flex;align-items:center;gap:8px;margin:8px 0 4px;min-width:0}.detect-name{font:500 17px/1.35 var(--mono);letter-spacing:-.025em;color:var(--heading);overflow-wrap:anywhere;min-width:0}.detect-tier{flex:none;font-size:10.5px;line-height:1;padding:3px 7px;border-radius:999px;color:var(--secondary);box-shadow:inset 0 0 0 1px var(--edge)}.detect-sub{font-size:11px;line-height:1.6;color:var(--secondary);overflow-wrap:anywhere}
.detect-changes{margin-top:10px;padding-top:8px;border-top:1px dashed var(--edge)}.detect-change+.detect-change{margin-top:7px}.detect-flow{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 7px;font:12.5px/1.5 var(--mono);min-width:0}.detect-flow .from{color:var(--secondary);overflow-wrap:anywhere}.detect-flow .arrow{color:var(--warn)}.detect-flow b{font-weight:500;color:var(--heading);overflow-wrap:anywhere}
.detect-go{width:100%;height:36px;margin-top:10px;border-radius:8px;background:var(--heading);color:var(--bg);font-size:13px;font-weight:500;letter-spacing:.02em}.detect-go:hover{background:var(--heading);color:var(--bg);opacity:.9}.detect-go:disabled,.detect-go:disabled:hover{background:var(--heading);color:var(--bg);opacity:.45}
.vlogo{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:#fff;color:#111;box-shadow:0 0 0 1px #0000001f}.vlogo svg{width:12px;height:12px;fill:currentColor}.vlogo[data-full]{background:none;box-shadow:none}.vlogo[data-full] svg{width:18px;height:18px}
.tl-row{display:grid;grid-template-columns:12px minmax(0,1fr) auto;column-gap:8px;row-gap:1px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}.tl-row:first-child{border-top:0;padding-top:2px}.tl-dot{width:7px;height:7px;border-radius:50%;background:var(--edge)}.tl-row[data-current] .tl-dot{background:var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 22%,transparent)}.tl-name{display:flex;align-items:center;gap:6px;min-width:0;font:12.5px/1.45 var(--mono);color:var(--heading)}.tl-name>span:last-child{overflow-wrap:anywhere;min-width:0}.tl-name .vlogo{width:16px;height:16px}.tl-name .vlogo svg{width:10px;height:10px}.tl-name .vlogo[data-full] svg{width:16px;height:16px}.tl-count{font:11px var(--mono);color:var(--secondary);white-space:nowrap}.tl-meta{grid-column:2/4;font-size:10.5px;line-height:1.5;color:var(--secondary);overflow-wrap:anywhere}.tl-more{font-size:10.5px;color:var(--secondary);padding:0 0 6px 20px}
.config-value.legacy-state{font-family:inherit;font-size:12.5px}.legacy-state[data-tone=ok]{color:var(--green)}.legacy-state[data-tone=busy],.legacy-state[data-tone=bad]{color:var(--warn)}.legacy-raw{margin-top:8px}.legacy-raw+.log-actions{margin-top:8px}
:host([data-reload]){display:inline-flex;flex:none;vertical-align:top;margin:0 0 0 4px}.reload-toggle{width:32px;height:32px;padding:0;border-radius:4px;color:var(--amp-reload-fg,hsl(var(--interactive-active,60 4% 11%)))}.reload-toggle:hover{background:none;color:var(--amp-reload-fg,hsl(var(--interactive-active,60 4% 11%)));opacity:.75}.reload-toggle svg{width:22px;height:22px;transition:transform .4s cubic-bezier(.34,1.6,.5,1)}.reload-toggle:active svg{transform:rotate(-90deg)}.reload-toggle[data-arm]{color:var(--warn);background:var(--raised)}.reload-toggle[data-spin] svg{animation:ampSpin .8s linear infinite}@keyframes ampSpin{to{transform:rotate(360deg)}}
.sheet-grip{display:none}:host([data-compact]) .sheet-grip{display:flex;align-items:center;justify-content:center;height:20px;flex:none;touch-action:none;cursor:grab;-webkit-tap-highlight-color:transparent}.sheet-grip i{display:block;width:36px;height:4px;border-radius:2px;background:var(--edge);transition:width .15s,background .15s}:host([data-dragging]) .sheet-grip i,.sheet-grip:hover i{width:46px;background:var(--secondary)}
:host([data-compact][data-float]){position:fixed;left:0;right:0;bottom:var(--amp-bar-h,0px);height:var(--amp-sheet-h,50dvh);z-index:45}:host([data-compact][data-full]){position:fixed;left:0;right:0;top:0;bottom:var(--amp-bar-h,0px);height:auto;z-index:45}:host([data-compact][data-full]) .panel{border-radius:0;border-top:0;box-shadow:none}:host([data-compact][data-expanded]) .panel{animation:ampSheetIn .24s cubic-bezier(.22,.9,.3,1)}:host([data-dragging]) .panel{animation:none}@keyframes ampSheetIn{from{transform:translateY(18px);opacity:.5}to{transform:none;opacity:1}}
.sheet-btn{width:32px;height:32px;padding:0;border-radius:8px;color:var(--secondary);flex:none}.sheet-btn svg{width:17px;height:17px}.sheet-btn:hover{color:var(--heading)}.head-export{width:28px;height:28px;margin-left:-4px}
.chip{display:inline-flex;align-items:center;height:18px;padding:0 7px!important;border-radius:9px!important;font-size:10.5px;line-height:1;color:var(--secondary);background:var(--raised);box-shadow:inset 0 0 0 1px var(--edge);flex:none;gap:0}.chip[hidden]{display:none!important}.chip:hover{background:var(--raised);color:var(--heading)}
.info-btn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;margin:-4px -4px -4px 2px;border-radius:50%;color:var(--secondary);vertical-align:middle;flex:none;opacity:.72;font-weight:400}.info-btn svg{width:14px;height:14px;stroke-width:1.9}.info-btn:hover{background:none;opacity:1}.info-btn[aria-expanded=true]{opacity:1;color:var(--heading)}
.info-text{font-size:11.5px;line-height:1.7;color:var(--secondary);background:var(--raised);border-radius:8px;padding:8px 10px;margin:2px 0 10px;white-space:pre-line;overflow-wrap:anywhere;font-weight:400;animation:ampInfo .16s ease-out}.info-text[hidden]{display:none}@keyframes ampInfo{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}.setting+.info-text{margin-top:0}.spend-grid+.info-text,.info-text+.info-text{margin-top:8px}.setting-title{display:block}
.subtabs{display:flex;gap:2px;margin:10px 14px 0;padding:2px;border:1px solid var(--edge);border-radius:9px;flex:none;align-self:flex-start}.subtabs[hidden]{display:none}.subtabs button{height:24px;padding:0 12px;border-radius:7px;font-size:12px;color:var(--secondary)}.subtabs button[aria-pressed=true],.subtabs button[aria-pressed=true]:hover{background:var(--heading);color:var(--bg)}
.tab[data-dot]::before{content:'';position:absolute;top:7px;right:-7px;width:6px;height:6px;border-radius:50%;background:#e38a1e}
:host([data-compact]) .tabs{gap:14px}:host([data-compact]) .pickers{flex-direction:row;gap:8px;margin:10px 14px 0}:host([data-compact]) .call-picker{flex:1;min-width:0}:host([data-compact]) .call-picker>span:first-child{display:none}
.about-head{display:flex;align-items:center;gap:11px;margin:2px 0 18px}.about-logo{width:38px;height:38px;border-radius:11px;background:var(--heading);color:var(--bg);display:flex;align-items:center;justify-content:center;font:600 16px/1 var(--mono);flex:none}.about-title{font-size:14px;font-weight:500;color:var(--heading)}.about-sub{font:11px/1.4 var(--mono);color:var(--secondary);margin-top:2px}
.mc-card{display:block;border:1px solid var(--line);border-radius:14px;background:var(--bg);padding:12px 13px;box-shadow:0 1px 2px #0000000a;min-width:0}
.mc-card+.mc-card,.mc-card+.section,.section+.mc-card{margin-top:10px}
.section.spend{border:1px solid var(--line);border-radius:14px;padding:12px 13px;background:var(--bg);box-shadow:0 1px 2px #0000000a}
.mc-head{display:flex;align-items:center;gap:7px;margin-bottom:9px;min-width:0}
.mc-head h3{font-size:13px;font-weight:600;color:var(--heading);margin:0;white-space:nowrap}
.mc-head .eyebrow{margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.mc-ic{width:15px;height:15px;color:var(--secondary);flex:none}
.mc-hero{padding:14px 14px 12px;background:linear-gradient(180deg,var(--raised),var(--bg) 78%)}
.mc-top{display:flex;align-items:center;gap:10px;min-width:0}
.mc-top>.icon-button{margin-left:auto;flex:none}
.vlogo.mc-big{width:32px;height:32px}.vlogo.mc-big svg{width:18px;height:18px}
.mc-name{display:flex;align-items:center;flex-wrap:wrap;gap:5px 8px;min-width:0}
.mc-fam{font:600 19px/1.2 var(--mono);color:var(--heading);letter-spacing:-.01em;overflow-wrap:anywhere}
.mc-sub{margin-top:7px;font-size:11.5px;color:var(--secondary);line-height:1.5}
.mc-tier{display:inline-flex;align-items:center;gap:4px;height:21px;padding:0 8px;border-radius:999px;font:600 11px/1 var(--mono);color:var(--heading);background:var(--raised);box-shadow:inset 0 0 0 1px var(--edge);flex:none;white-space:nowrap}
.mc-tier[data-lv="4"],.mc-tier[data-lv="5"],.mc-tier[data-lv="6"]{background:var(--heading);color:var(--bg);box-shadow:none}
.mc-tier[data-lv="6"]{background:linear-gradient(135deg,var(--heading) 55%,color-mix(in srgb,var(--heading) 55%,var(--warn)))}
.mc-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}
.mc-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px 0 8px;border-radius:999px;border:1px solid var(--line);background:var(--raised);font:12px/1 inherit;color:var(--fg);white-space:nowrap;max-width:100%}
.mc-chip>span{overflow:hidden;text-overflow:ellipsis}
button.mc-chip{cursor:pointer}button.mc-chip:hover{border-color:var(--edge)}
.mc-chip svg{width:14px;height:14px;flex:none;color:var(--secondary)}
.mc-chip[data-tone=ok] svg{color:var(--green)}
.mc-chip[data-tone=think] svg{color:var(--heading)}
.mc-chip[data-lv="3"] svg,.mc-chip[data-lv="4"] svg{stroke-width:2.2}
.mc-chip[data-tone=suspect],.mc-chip[data-tone=warn]{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,transparent);background:color-mix(in srgb,var(--warn) 9%,var(--bg))}
.mc-chip[data-tone=suspect] svg,.mc-chip[data-tone=warn] svg{color:var(--warn)}
.mc-chip[data-tone=switch]{color:var(--bg);background:var(--warn);border-color:transparent}.mc-chip[data-tone=switch] svg{color:var(--bg)}
.mc-srcs{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;margin-top:10px;padding:0;border:0;background:none;font:11px/1.2 inherit;color:var(--secondary);cursor:pointer;text-align:left}
.mc-src{display:inline-flex;align-items:center;gap:4px}.mc-src i{width:7px;height:7px;border-radius:50%;background:var(--edge);flex:none}
.mc-src[data-st=ok] i{background:var(--green)}.mc-src[data-st=diff] i{background:var(--warn)}.mc-src[data-st=diff]{color:var(--warn)}.mc-src[data-st=none]{opacity:.6}
.mc-live{width:7px;height:7px;border-radius:50%;background:var(--green);animation:ampPulse 1.2s ease-in-out infinite;flex:none}
.mc-strip{display:flex;align-items:flex-end;gap:3px;min-height:68px;padding:4px 2px 0;overflow-x:auto;scrollbar-width:none;overscroll-behavior-x:contain}
.mc-strip::-webkit-scrollbar{display:none}
.mc-step{display:flex;flex-direction:column;align-items:center;gap:4px;flex:0 0 15px}
.mc-step .bar{width:10px;border-radius:4px 4px 2px 2px;background:color-mix(in srgb,var(--heading) 28%,transparent);overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
.mc-step .bar i{display:block;width:100%;background:var(--heading)}
.mc-step[data-g="1"] .bar{background:color-mix(in srgb,var(--warn) 42%,transparent)}.mc-step[data-g="1"] .bar i{background:var(--warn)}
.mc-step[data-g="2"] .bar{background:color-mix(in srgb,var(--green) 38%,transparent)}.mc-step[data-g="2"] .bar i{background:var(--green)}
.mc-step[data-g="3"] .bar{background:color-mix(in srgb,var(--secondary) 38%,transparent)}.mc-step[data-g="3"] .bar i{background:var(--secondary)}
.mc-strip[data-few]{gap:7px}.mc-strip[data-few] .mc-step{flex-basis:24px}.mc-strip[data-few] .mc-step .bar{width:16px;border-radius:5px 5px 3px 3px}.mc-strip[data-few] .mc-step-ic svg{width:13px;height:13px}
.mc-step[data-live] .bar{animation:ampPulse 1.2s ease-in-out infinite}
.mc-step-ic{height:13px;display:flex;align-items:center;justify-content:center;color:var(--secondary)}
.mc-step-ic svg{width:12px;height:12px}.mc-step-ic .dot{width:3px;height:3px;border-radius:50%;background:var(--edge)}
.mc-step[data-think] .mc-step-ic{color:var(--heading)}
.mc-sw{align-self:center;display:flex;color:var(--warn);margin:0 1px 16px;flex:none}.mc-sw svg{width:13px;height:13px}
.mc-verdict{display:flex;align-items:flex-start;gap:7px;margin-top:10px;padding:8px 10px;border-radius:10px;background:var(--raised);font-size:12px;line-height:1.5;color:var(--fg)}
.mc-verdict svg{width:15px;height:15px;flex:none;margin-top:1px;color:var(--secondary)}
.mc-verdict[data-tone=ok] svg{color:var(--green)}
.mc-verdict[data-tone=suspect]{background:color-mix(in srgb,var(--warn) 11%,var(--bg));color:var(--warn)}.mc-verdict[data-tone=suspect] svg{color:var(--warn)}
.mc-verdict[data-tone=switch]{background:var(--warn);color:var(--bg)}.mc-verdict[data-tone=switch] svg{color:var(--bg)}
.mc-verdict[data-tone=busy] svg{animation:ampSpin 1s linear infinite}
.mc-flags{display:flex;flex-direction:column;margin-top:6px}
.mc-flag{display:flex;align-items:flex-start;gap:8px;padding:8px 1px;border-top:1px solid var(--line)}
.mc-flag:first-child{border-top:0}
.mc-flag>svg{width:15px;height:15px;flex:none;margin-top:1px;color:var(--secondary)}
.mc-flag[data-st=suspect]>svg,.mc-flag[data-st=confirmed]>svg{color:var(--warn)}
.mc-flag-t{font-size:12px;color:var(--fg);line-height:1.45}.mc-flag-d{font-size:11px;color:var(--secondary);margin-top:2px;line-height:1.5;overflow-wrap:anywhere}
.mc-flag-s{font-size:10.5px;padding:2px 7px;border-radius:999px;background:var(--raised);color:var(--secondary);white-space:nowrap;flex:none}
.mc-flag-s:empty{display:none}
.mc-flag[data-st=confirmed] .mc-flag-s{background:var(--warn);color:var(--bg)}.mc-flag[data-st=suspect] .mc-flag-s{color:var(--warn)}
.mc-callbar{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.mc-callbar-h{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--secondary);margin-bottom:6px}
.mc-stack{display:flex;height:8px;border-radius:999px;overflow:hidden;background:var(--raised);gap:1px}
.mc-stack i{display:block;min-width:2px;flex-basis:0}
.mc-stack .in,.mc-legend .in{background:color-mix(in srgb,var(--heading) 45%,transparent)}
.mc-stack .cache,.mc-legend .cache{background:color-mix(in srgb,var(--heading) 18%,transparent)}
.mc-stack .out,.mc-legend .out{background:var(--heading)}
.mc-stack .rsn,.mc-legend .rsn{background:var(--warn)}
.mc-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:7px;font-size:11px;color:var(--secondary)}
.mc-legend span{display:inline-flex;align-items:center;gap:5px}.mc-legend i{width:8px;height:8px;border-radius:2px;display:inline-block}
details.mc-card>summary{display:flex;align-items:center;gap:7px;list-style:none;cursor:pointer;font-size:13px;font-weight:600;color:var(--heading);min-width:0}
details.mc-card>summary::-webkit-details-marker{display:none}
details.mc-card>summary .grow{flex:1;min-width:0}
details.mc-card>summary .eyebrow{font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
details.mc-card>summary .mc-chev{width:14px;height:14px;color:var(--secondary);transition:transform .18s;flex:none}
details.mc-card[open]>summary .mc-chev{transform:rotate(90deg)}
details.mc-card[open]>summary{margin-bottom:4px}
.mc-group{margin-top:6px}.mc-gh{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--secondary);margin:10px 0 2px}.mc-gh svg{width:13px;height:13px}
details.mc-card .section.credits{margin-top:12px}
.tl-change[data-tier],.mc-sw[data-tier]{color:var(--secondary)}
.tl-change{display:flex;align-items:center;gap:6px;margin:0 0 2px 1px;padding:3px 0 5px;font-size:11px;color:var(--warn)}.tl-change svg{width:13px;height:13px;flex:none}
.mc-act{margin-top:12px}.mc-act .detect-go{width:100%}
.ci-text[data-tone=switch],.ci-text[data-tone=suspect]{color:var(--warn)}
.body{touch-action:pan-y}
.body.slide-l{animation:ampSlideL .24s cubic-bezier(.2,.8,.3,1)}
.body.slide-r{animation:ampSlideR .24s cubic-bezier(.2,.8,.3,1)}
@keyframes ampSlideL{from{transform:translateX(28px);opacity:.3}to{transform:none;opacity:1}}
@keyframes ampSlideR{from{transform:translateX(-28px);opacity:.3}to{transform:none;opacity:1}}
:host([data-compact]) .mc-fam{font-size:18px}
:host([data-compact]) .mc-card{border-radius:16px}
.about-upds{display:flex;flex-direction:column;align-items:stretch;gap:6px;margin:0;min-width:0}.about-upds .upd{display:flex;justify-content:flex-start;width:100%;min-height:36px;margin:0;padding:8px 12px!important;border:1px solid var(--line);border-radius:10px;font:12px/1.4 var(--mono);color:var(--fg);text-align:left;white-space:normal;overflow:visible;max-width:none;text-overflow:clip}.about-upds .upd:hover{background:var(--raised)}.about-upds .upd[data-new='1']{border-color:transparent}.about-upds .upd.chentry{justify-content:center;border-style:dashed;color:var(--secondary);opacity:1}.about-upds .chform{padding:2px 0}
`;
  function el(tag,cls,text,parent){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined&&text!==null)e.textContent=text;if(parent)parent.append(e);return e;}
  function button(parent,text,title,fn,cls=''){const b=el('button',cls,text,parent);b.type='button';b.title=title;b.setAttribute('aria-label',title);b.dataset.focus=title;b.onclick=fn;return b;}
  const paths={sun:['M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4','M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'],moon:['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z'],cube:['m12 3 9 5-9 5-9-5 9-5Z','M3 8v9l9 5 9-5V8M12 13v9'],chevron:['m9 5 7 7-7 7'],down:['m6 9 6 6 6-6'],copy:['M9 9h12v12H9z','M15 5V3H3v12h2'],download:['M12 3v12m-5-5 5 5 5-5','M4 16v5h16v-5'],reload:['M21.17 8A10 10 0 0 0 12 2 10 10 0 0 0 2.05 11','M17 8h4.4a.6.6 0 0 0 .6-.6V3','M2.88 16A10 10 0 0 0 12.05 22 10 10 0 0 0 22 13','M7.05 16H2.65a.6.6 0 0 0-.6.6V21'],info:['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z','M12 11v5.5','M12 7.6v.01'],close:['M6.5 6.5l11 11M17.5 6.5l-11 11'],user:['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z','M4.5 20.5a7.5 7.5 0 0 1 15 0'],brain:['M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z','M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z','M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4','M12 5v13'],terminal:['m4 17 6-6-6-6','M12 19h8'],swap:['M8 3 4 7l4 4','M4 7h16','m16 21 4-4-4-4','M20 17H4'],bolt:['M13 2 3 14h9l-1 8 10-12h-9l1-8z'],alert:['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z','M12 9v4','M12 17h.01'],check:['M20 6 9 17l-5-5'],pulse:['M22 12h-4l-3 9L9 3l-3 9H2'],layers:['m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z','m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65','m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65'],gauge:['m12 14 4-4','M3.34 19a10 10 0 1 1 17.32 0'],hash:['M4 9h16','M4 15h16','M10 3 8 21','M16 3l-2 18'],route:['M16 3h5v5','M4 20 21 3','M21 16v5h-5','m15 15 6 6','M4 4l5 5']};
  function icon(name,parent,cls=''){const s=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [k,v]of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))s.setAttribute(k,v);if(cls)s.setAttribute('class',cls);for(const d of paths[name]||[]){const p=document.createElementNS(s.namespaceURI,'path');p.setAttribute('d',d);s.append(p);}parent?.append(s);return s;}
  function iconButton(parent,name,title,fn){const b=button(parent,'',title,fn,'icon-button');icon(name,b);return b;}
  function download(data,name='amp-lite-export.json'){const a=document.createElement('a'),u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.href=u;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),10000);}
  // 原始数据：内存里有完整版就用完整版，否则用缓存的精简版
  function rawOf(s){if(!s)return null;const mem=rawStore.get(s.key);if(mem)return {events:s.raw?.events?.length?s.raw.events:[],spans:Object.fromEntries(mem.spans),trace:mem.trace,probe:mem.probe||s.raw?.probe||null,full:true};return {events:s.raw?.events||[],spans:s.raw?.spans||{},trace:null,probe:s.raw?.probe||null,full:false};}
  function exported(){const s=ui?.view(),snap=localSnapshot(s),sid=snap?.sid||sidOf(location.href),raw=rawOf(s);return{tool:'Arena Model Probe Lite',version:VERSION,at:new Date().toISOString(),sid,pageSid:sidOf(location.href),frames,queries,cooldown,snapshot:snap?{...snap,raw:undefined}:null,local:catalog.entries.get(sid)||null,turns:catalog.turnsOf(sid),persistent:catalog.persistent,quota,balance,credits:costState.get(sid)?.credits||null,raw:raw?{full:raw.full,events:raw.events,trace:raw.trace,spans:raw.spans,probe:raw.probe}:null,logs:logs.slice()};}
  function refresh(){const r=selectedRun();if(!r){log('info','重读','当前没有可用的运行读取权限');return;}if(Date.now()<cooldown){log('warn','重读','限流冷却中',null,r);return;}r.tries=0;r.finalReads=0;later(r,0,true);if(prefs.showCredits&&!(r.credits&&r.credits.source==='message'))scheduleCost(r.sid,300,true);}
  async function fetchSpan(r,id){if(!r?.token||r.busy||!SPAN.test(id))return;const ctrl=new AbortController();try{const d=await json(r,'spans/'+id,ctrl.signal);r.rawSpans.set(id,d);if(r.data)keepRaw(r);log('detail','Span','已按需读取 '+id,null,{sid:r.sid,runId:r.runId,spanId:id});}catch(e){log('warn','Span','按需读取失败',e,{sid:r.sid,runId:r.runId,spanId:id});}paint();}
  // ---- 一键检测：立刻读取本对话此刻的完整 Trace（所有轮次）+ 本机记录，逐次调用核对模型，找出中途换模型的位置 ----
  // 常规检测只看最新一段；交互面板选择等“续接”不写新的轮次标记，同一轮里前后两段可能由不同模型完成，所以这里逐次调用比对。
  // 名称来源：内部名称（用量记录）> 响应型号 > 请求型号 > Trace 标签；只多了档位 / -vertex / 日期等后缀（brand.same）不算换模型。
  const force={busy:false,step:'',sid:null,serial:0,bySid:new Map(),abort:null},forceSpans=new Map();
  const FORCE_SRC=['internal','response','request','pill'],FORCE_SRC_TEXT={internal:'内部名称',response:'响应型号',request:'请求型号',pill:'Trace 标签'};
  const forceEq=(a,b)=>a===b||brand.same(a,b);
  const forceBest=c=>c.internal||c.response||c.request||c.pill||null;
  // 两次调用是否同一模型：共同具备的名称来源逐一比较，任何一项不同就算换了；没有共同来源时比较各自最可靠的名称
  function forceSame(a,b){let common=0;for(const k of FORCE_SRC)if(a[k]&&b[k]){common++;if(!forceEq(a[k],b[k]))return false;}if(common)return true;const x=forceBest(a),y=forceBest(b);return !x||!y||forceEq(x,y);}
  function forceRun(sid){for(const r of [...runs.values()].filter(r=>r.sid===sid&&r.token).reverse()){try{authorized(r.token,r.sid);return r;}catch{}}return null;}
  // 按 "chat turn N" 切段：每段收集模型调用（Trace 标签、起止时间）、用量记录（带内部名称）与服务端改派事件
  function forceSegments(trace,runId){
    if(!Array.isArray(trace?.events))throw Error('Trace 缺少 events 数组');
    const segs=[],attempts={};let seg=null;
    const open=(turn,at)=>{seg={turn,attempt:turn===null?1:(attempts[turn]=(attempts[turn]||0)+1),at,streams:[],records:[],route:[]};segs.push(seg);};
    for(const e of trace.events){
      if(!e||typeof e!=='object'||e.runId&&e.runId!==runId)continue;
      const at=toMs(e.startTime),msg=label(e.message)||'',m=/^chat turn (\d+)$/.exec(msg);
      if(m){open(+m[1],at);continue;}
      if(!seg)open(null,at);
      if(/^(model\.resample\.(attempt_failed|switched|committed)|failover\.record_inserted)$/.test(msg)){seg.route.push({message:msg,at});continue;}
      const id=SPAN.test(e.spanId||'')?e.spanId:null;if(!id)continue;
      if(/^ai\.(streamText\.doStream|generateText\.doGenerate)$/.test(msg)){const dur=toDurationMs(e.duration),pill=(e.style?.accessory?.items||[]).map(x=>x?.icon==='tabler-cube'?label(x.text):null).find(Boolean)||null;seg.streams.push({id,kind:'stream',message:msg,at,end:at&&dur!==null&&e.isPartial===false?at+dur:null,partial:e.isPartial!==false,error:e.isError===true,pill,properties:e.properties});}
      else if(msg==='token.usage.recorded')seg.records.push({id,kind:'usage',message:msg,at,partial:e.isPartial!==false,properties:e.properties});
    }
    return segs.filter(s=>s.streams.length||s.records.length);
  }
  // 每次调用的内部名称：本段里时间上最先落在它之后的用量记录（按消息写入，同一条消息里的多次调用共用一个名称；进行中的调用还没有）
  function forceNames(seg,det){
    const recs=seg.records.map(x=>({at:x.at,name:det.get(x.id)?.internal||null})).filter(x=>x.name);
    return seg.streams.map((s,i)=>{if(!recs.length)return null;if(s.at!==null)return recs.find(x=>x.at!==null&&x.at>=s.at)?.name||null;return recs.length===seg.streams.length?recs[i].name:null;});
  }
  function forceTraceCalls(segs,det,runId,local){
    const out=[];
    segs.forEach((seg,si)=>{const names=forceNames(seg,det),ls=local.find(s=>s.runId===runId&&s.turn===seg.turn&&s.attempt===seg.attempt&&s.prompt);
      // 用量记录按消息写入：同一条消息里中途换了模型时，内部名称只归给型号相符的调用，避免把前半段也算成新模型
      {const own=seg.streams.map(x=>{const d=det.get(x.id)||{};return d.response||d.request||x.pill||null;}),known=own.filter(Boolean);if(known.some(n=>!forceEq(n,known[0])))own.forEach((n,i)=>{if(n&&names[i]&&!forceEq(n,names[i]))names[i]=null;});}
      seg.streams.forEach((s,i)=>{const d=det.get(s.id)||{};out.push({src:'trace',id:s.id,seg:si,turn:seg.turn,attempt:seg.attempt,n:i+1,at:s.at,end:s.end,partial:s.partial,error:s.error,internal:names[i],response:d.response||null,request:d.request||null,pill:s.pill,prompt:ls?.prompt||null});});});
    return out;
  }
  // 本机记录里的调用（更早的 run，或读不到 Trace 时的全部记录）
  function forceLocalCalls(local,skipRun){
    const out=[],seen=new Set();
    for(const s of local){if(skipRun&&s.runId===skipRun)continue;
      s.calls.forEach((c,i)=>{if(seen.has(c.id))return;seen.add(c.id);out.push({src:'local',id:c.id,seg:null,run:s.runId,turn:s.turn,attempt:s.attempt,n:(s.prior||0)+i+1,at:Date.parse(c.at||'')||Date.parse(s.startedAt||s.at||'')||null,end:null,partial:false,error:false,internal:c.internal||null,response:c.response||null,request:c.request||null,pill:c.request?null:c.model&&c.model!=='未提供'?c.model:null,prompt:s.prompt||null,routing:s.routing||null,out:number(c.tokens?.output),rsn:c.reasoning?.value!==undefined?number(c.reasoning.value):null,eff:c.effort?.value||null});});}
    return out;
  }
  // 连续同一模型的调用合为一段；和段内已知名称（每种来源取最新）比较，避免某次调用缺名称时漏判
  function forceGroups(calls){
    const gs=[];
    for(const c of calls){let g=gs.at(-1);if(g&&forceSame(g.agg,c)){g.calls.push(c);g.last=c;}else{g={calls:[c],first:c,last:c,agg:{}};gs.push(g);}for(const k of FORCE_SRC)if(c[k])g.agg[k]=c[k];}
    for(const g of gs){g.names=Object.fromEntries(FORCE_SRC.map(k=>[k,g.agg[k]||null]));g.count=g.calls.length;g.turns=[...new Set(g.calls.map(c=>c.turn).filter(t=>t!==null&&t!==undefined))];g.local=g.calls.every(c=>c.src==='local');}
    gs.forEach((g,i)=>{g.title=forceTitle(g,[gs[i-1],gs[i+1]].filter(Boolean));});
    return gs;
  }
  // 段的显示名：按来源优先级取第一个能和相邻段区分开的名称（内部名称相同而请求型号不同时显示请求型号）
  function forceTitle(g,nb){for(const k of FORCE_SRC){const v=g.names[k];if(v&&nb.every(n=>!n.names[k]||!forceEq(n.names[k],v)))return {name:v,src:k};}const k=FORCE_SRC.find(k=>g.names[k]);return {name:k?g.names[k]:'未提供',src:k||null};}
  const forceGap=ms=>ms<120000?Math.round(ms/1000)+' 秒':ms<7200000?Math.round(ms/60000)+' 分钟':Math.round(ms/3600000)+' 小时';
  function forceTags(sid,a,b,segs){
    const tags=[],lo=a.at,hi=b.at,both=a.src==='trace'&&b.src==='trace';
    if(both){tags.push(a.seg===b.seg?'同一轮中途':a.turn===b.turn?'重试':'新一轮');
      if(lo!==null&&hi!==null&&segs.slice(a.seg,b.seg+1).some(s=>s.route.some(x=>x.at!==null&&x.at>=lo-1000&&x.at<=hi+1000)))tags.push('服务端改派');}
    else if(b.src==='local'&&b.routing?.to&&forceEq(b.routing.to,b.request||b.pill||''))tags.push('服务端改派');
    const cont=lo!==null&&hi!==null?(contSeen.get(sid)||[]).find(x=>x.at>=lo-15000&&x.at<=hi+15000):null;
    if(cont)tags.push(cont.kind==='regenerate'?'重新生成后':'交互选择后');
    else if(both&&a.seg===b.seg&&a.end&&hi!==null&&hi-a.end>20000)tags.push('停顿 '+forceGap(hi-a.end)+'后');
    return tags;
  }
  async function forceFetch(r,list,det,ctrl,out,limit){
    let n=0;
    for(const x of list){
      if(n>=limit||stopped||ctrl.signal.aborted)break;
      if(det.has(x.id))continue;n++;
      try{const d=await json(r,'spans/'+x.id,ctrl.signal),v=detail(d,x,r.runId);det.set(x.id,v);out.fetched++;if(v.available&&!v.partial){forceSpans.set(x.id,v);while(forceSpans.size>800)forceSpans.delete(forceSpans.keys().next().value);}}
      catch(e){if(e.status===429||e.status===401||e.status===403||e.name==='AbortError')break;}
    }
  }
  // 逐次调用比对（一键检测与实时监控共用）：Trace 调用 + 本机更早轮次 → 分段、变更点、当前型号，写入 out
  function forceAnalyze(sid,runId,segs,det,local,out){
    const traced=runId?forceTraceCalls(segs,det,runId,local):[],ids=new Set(traced.map(c=>c.id));
    for(const c of traced){const d=det.get(c.id);if(!d)continue;c.out=number(d.output?.[0]?.value);c.rsn=d.reasoning?.length?number(d.reasoning[0].value):null;c.inp=number(d.input?.[0]?.value);c.eff=d.configs?effort(d.configs).value||null:null;}
    const older=forceLocalCalls(local,runId).filter(c=>!ids.has(c.id));
    out.localTurns=new Set(older.map(c=>c.run+':'+c.turn+':'+c.attempt)).size;
    let last=null;for(const c of traced){if(c.at===null)c.at=last;else last=c.at;}
    const calls=[...older,...traced].map((c,i)=>({c,i})).sort((x,y)=>((x.c.at??0)-(y.c.at??0))||x.i-y.i).map(x=>x.c),groups=forceGroups(calls);
    for(const c of calls)c.tps=Number.isFinite(c.out)&&c.out>0&&c.end&&c.at&&c.end-c.at>=800?Math.round(c.out/((c.end-c.at)/1000)):null;
    out.calls=calls;out.groups=groups.map(g=>({title:g.title,names:g.names,count:g.count,from:g.first.at,to:g.last.at,turns:g.turns,local:g.local,partial:g.last.partial}));
    out.callGroup={};groups.forEach((g,i)=>{for(const c of g.calls)out.callGroup[c.id]=i;});
    out.changes=[];for(let i=1;i<groups.length;i++){const a=groups[i-1].last,b=groups[i].first;out.changes.push({from:groups[i-1].title.name,to:groups[i].title.name,at:b.at,turn:b.turn,attempt:b.attempt,n:b.n,local:b.src==='local',tags:forceTags(sid,a,b,segs),tierOnly:famEq(groups[i-1].title.name,groups[i].title.name)});}
    {let fi=0;out.callFam={};groups.forEach((g,i)=>{if(i&&!out.changes[i-1].tierOnly)fi++;for(const c of g.calls)out.callFam[c.id]=fi;});}
    const lc=calls.at(-1),lg=groups.at(-1);out.current=null;
    if(lc)out.current={name:lg.title.name,src:lg.title.src,internal:lc.internal||lg.names.internal,response:lc.response,request:lc.request,pill:lc.pill,at:lc.at,turn:lc.turn,attempt:lc.attempt,n:lc.n,partial:lc.partial,local:lc.src==='local',eff:lc.eff||null};
    const sh=traceShift(calls,monFamSame,n=>brand.tierOf(n));out.tiers=sh.tiers;out.shift=sh.shift;out.speed=sh.speed;
    return out;
  }
  async function forceDetect(){
    const sid=sidOf(location.href);if(!sid||force.busy||stopped)return null;
    force.busy=true;force.sid=sid;const step=t=>{force.step=t;force.serial++;paint();};step('读取本机记录');
    const out={sid,at:Date.now(),runId:null,events:0,fetched:0,localTurns:0,notes:[],calls:[],groups:[],changes:[],current:null,error:null};
    const ctrl=new AbortController();force.abort=ctrl;
    try{
      await catalog.ready;
      const rows=await catalog.rows('turns','sid',sid,'next',400).catch(()=>[]),local=[];
      for(const row of rows){try{const s=localSnapshot(row?.data);if(s)local.push(s);}catch{}}
      const mem=selectedRun()?.data;if(mem?.sid===sid){try{const s=localSnapshot(mem);if(s&&!local.some(x=>x.key===s.key))local.push(s);}catch{}}
      let r=forceRun(sid);
      if(!r&&typeof window.__ARENA_RUN_TOKEN__==='string'){accept(window.__ARENA_RUN_TOKEN__,sid);r=forceRun(sid);}
      let trace=null,segs=[];const det=new Map();
      if(!r)out.notes.push('没有这个对话的运行读取权限（页面只在收到回复流时下发，有效期有限）：只核对了本机记录。发一条消息后再检测，可读取完整记录。');
      else{
        out.runId=r.runId;step('读取此刻的 Trace');
        try{trace=ownTrace(r,await json(r,'events',ctrl.signal));}catch(e){if(e.name==='AbortError')throw e;out.notes.push('读取 Trace 失败（'+(e.status===429?'接口限流，稍后再试':e.status===401||e.status===403?'读取权限已失效，发一条消息后再试':errorText(e))+'）：只核对了本机记录。');}
        if(trace){
          segs=forceSegments(trace,r.runId);out.events=trace.events.length;
          for(const x of segs.flatMap(s=>[...s.records,...s.streams])){
            if(x.properties){try{det.set(x.id,detail({runId:r.runId,spanId:x.id,message:x.message,isPartial:x.partial,properties:x.properties},x,r.runId));}catch{}continue;}
            const c=r.cache.get(x.id);if(c?.available&&!c.partial&&!x.partial)det.set(x.id,c);else if(forceSpans.has(x.id)&&!x.partial)det.set(x.id,forceSpans.get(x.id));
          }
          // 先读用量记录（带内部名称，从最新一段往前），再读最近两段的模型调用（响应 / 请求型号）
          step('补读调用详情');
          const todo=[];for(let i=segs.length-1;i>=0;i--)todo.push(...[...segs[i].records].reverse());
          for(let i=segs.length-1;i>=Math.max(0,segs.length-2);i--)todo.push(...[...segs[i].streams].reverse().slice(0,8));
          await forceFetch(r,todo,det,ctrl,out,18);
          // 第二遍：初步分段后，补读每个变更点前后两次调用的详情，确认实际型号
          const first=forceGroups(forceTraceCalls(segs,det,r.runId,local)),edge=[];
          for(let i=1;i<first.length;i++)for(const c of [first[i-1].last,first[i].first]){const s=segs[c.seg]?.streams[c.n-1];if(s)edge.push(s);}
          if(edge.length)await forceFetch(r,edge,det,ctrl,out,8);
        }
      }
      step('比对模型');
      forceAnalyze(sid,trace?r.runId:null,segs,det,local,out);const calls=out.calls;
      if(!out.current&&!out.notes.length)out.notes.push('这个对话还没有模型调用记录。');
      log('info','一键检测',(out.changes.length?'中途换过 '+out.changes.length+' 次模型：'+out.changes.map(c=>c.from+' → '+c.to).join('；'):calls.length?'全程同一模型':'没有模型调用记录')+(out.current?' · 当前 '+out.current.name:'')+' · '+calls.length+' 次调用'+(out.events?' · Trace '+out.events+' 条事件':'')+(out.fetched?' · 补读 '+out.fetched+' 个详情':''),null,{sid,runId:out.runId});
    }catch(e){out.error=e?.name==='AbortError'?'已取消':errorText(e);log('warn','一键检测','检测失败',e,{sid});}
    finally{force.busy=false;force.abort=null;force.step='';force.bySid.delete(sid);force.bySid.set(sid,out);while(force.bySid.size>12)force.bySid.delete(force.bySid.keys().next().value);force.serial++;paint();}
    if(out.runId&&out.events&&!out.error)refresh();
    return out;
  }
  // ---- 实时监控：读页面对话状态（零请求）→ 新步骤 / 思考链变化时按需读 Trace（事件驱动、限速）→ 每次读完自动逐次核对 ----
  // 目的：同一轮里模型被悄悄换掉时尽早发现。强信号（回复先出正文、过一会儿才开始思考）立即补读 Trace 确认；一开始就在思考不算强信号；
  // 确认换模型由原有“模型变更提醒”通知，这里只对“疑似”弹提示，避免重复。
  const mon={bySid:new Map(),serial:0,sig:'',stamp:'',timer:0,alerts:new Set()};
  const TIER_LV={none:0,minimal:1,low:2,medium:3,high:4,xhigh:5,max:6},TIER_SPLIT=/^(.*?)[-\s·]+(none|minimal|low|medium|high|xhigh|max)$/i;
  // 名称 → [家族名, 档位]：与顶栏一致（有厂商时去掉厂商前缀）
  function famTier(n){n=String(n||'');const x=brand.of(n)?brand.short(n):noVertex(n),m=x.match(TIER_SPLIT);return m?[m[1],m[2].toLowerCase()]:[x,''];}
  function monOf(sid){let m=mon.bySid.get(sid);if(!m){m={sid,flags:[],auto:null,cur:null,hist:[],sums:new Map(),msgId:'',steps:0,busy:false,wasBusy:false,local:null,localAt:0,localRev:-1,localBusy:false,autoKey:'',at:0};mon.bySid.set(sid,m);while(mon.bySid.size>12)mon.bySid.delete(mon.bySid.keys().next().value);}return m;}
  // 与抽卡的 completion() 相同：从 [role=log] 的 React fiber 往上找 useChat 的 {id, messages, status}
  function monChat(){
    const sid=sidOf(location.href);if(!sid)return null;
    const logs=[...document.querySelectorAll('main [role="log"]')],logEl=logs.find(e=>e.getClientRects().length)||logs[0];if(!logEl)return null;
    try{const k=Object.keys(logEl).find(x=>x.startsWith('__reactFiber'));let f=k?logEl[k]:null;for(let n=0;f&&n<100;n++,f=f.return){const v=f.memoizedProps?.value;if(v&&v.id===sid&&Array.isArray(v.messages))return {sid,status:String(v.status||''),messages:v.messages};}}catch{}
    return null;
  }
  function monSum(m,msg){const parts=Array.isArray(msg?.parts)?msg.parts:[],k=parts.length+':'+(typeof parts.at(-1)?.text==='string'?parts.at(-1).text.length:0),hit=m.sums.get(msg?.id);if(hit&&hit.k===k)return hit.s;const x=liveMsg(msg);m.sums.set(msg?.id,{k,s:x});if(m.sums.size>120)m.sums.delete(m.sums.keys().next().value);return x;}
  function monTick(){
    if(stopped||!enabled||!prefs.monOn||document.hidden)return;
    const c=monChat();if(!c)return;
    const msgs=c.messages,last=msgs.at(-1),lp=Array.isArray(last?.parts)?last.parts:[],tail=lp.at(-1);
    const sig=c.sid+'|'+msgs.length+'|'+(last?.id||'')+'|'+lp.length+'|'+(typeof tail?.text==='string'?tail.text.length:0)+'|'+(tail?.state||'')+'|'+c.status;
    if(sig===mon.sig)return;mon.sig=sig;
    const m=monOf(c.sid),now=Date.now(),busy=c.status==='submitted'||c.status==='streaming';
    let ui_=-1;for(let i=msgs.length-1;i>=0;i--)if(msgs[i]?.role==='user'){ui_=i;break;}
    const after=msgs.slice(ui_+1).filter(x=>x?.role==='assistant'),curMsg=after.at(-1)||null;
    const hist=msgs.slice(0,Math.max(0,ui_)).concat(after.slice(0,-1)).filter(x=>x?.role==='assistant').slice(-12).map(x=>monSum(m,x));
    const cur=curMsg?monSum(m,curMsg):null;
    m.cur=cur;m.hist=hist;m.busy=busy;m.at=now;
    if(cur&&cur.id!==m.msgId){m.msgId=cur.id;m.steps=0;}
    // 新步骤 = 新的一次模型调用：生成中立即补读 Trace（首步更快，后续限速）
    if(cur&&cur.n>m.steps){const first=m.steps===0;m.steps=cur.n;if(busy)monKick(c.sid,first?'first':'step');}
    if(m.wasBusy&&!busy)setTimeout(()=>{const r=forceRun(c.sid);if(r&&!r.finalReads)monKick(c.sid,'done');},3500);
    m.wasBusy=busy;
    if(cur)for(const f of liveFlags(hist,cur,!busy)){const key=cur.id+':'+f.kind;if(m.flags.some(x=>x.key===key))continue;const x={...f,key,at:now,msg:cur.id,step:cur.n,status:'suspect'};m.flags.push(x);if(m.flags.length>24)m.flags.shift();monFlag(c.sid,x,busy);}
    const stamp=[c.sid,cur?.id,cur?.n,cur?.think,cur?.tools,busy,m.flags.map(f=>f.key+f.status).join(','),m.autoKey].join('|');
    if(stamp!==mon.stamp){mon.stamp=stamp;mon.serial++;paint();}
  }
  // 抽卡模块原有的“路由到 Thinking 时停止”（默认开）已处理“正文之后出现思考链”，自动停止不重复点击
  function monGuardOn(){try{return (JSON.parse(localStorage.getItem('amp.native.gacha.settings.v1')||'{}')||{}).stopOnThinking!==false;}catch{return true;}}
  function monCurrentName(sid){const m=mon.bySid.get(sid);return m?.auto?.current?.name||catalog.entries.get(sid)?.name?.name||null;}
  function monFlag(sid,f,busy){
    log(f.level==='strong'?'warn':'info','实时监控',f.text+(f.detail?'（'+f.detail+'）':''),null,{sid});
    if(f.level!=='weak')monKick(sid,'anomaly');
    if(f.level==='strong'&&prefs.monAlert&&!mon.alerts.has(f.key)&&(mon.alerts.add(f.key),!gacha.quietTurn(sid))){const cur=monCurrentName(sid);try{routeAlert.show('疑似换模型 · 正在核对',null,f.text,(cur?'当前识别 '+short_(cur)+' · ':'')+f.detail,'drop');}catch{}}
    if(f.level==='strong'&&prefs.monStop&&busy&&pageGenerating()&&!(f.kind==='think-mid'&&mon.bySid.get(sid)?.cur?.midText&&monGuardOn())){const b=document.querySelector('button[aria-label="Stop generating"],button[aria-label="Stop response"],button[aria-label="停止生成"]');if(b&&!b.disabled){b.click();log('warn','实时监控','已按设置自动停止生成',null,{sid});}}
  }
  // 事件驱动读取：首步 / 疑点最短 2.5 秒，普通新步骤 5 秒起、长回复逐步放慢到 16 秒；每轮最多 90 次，遵守限流冷却
  function monKick(sid,why){
    if(stopped||!enabled||!prefs.monOn||Date.now()<cooldown)return;
    const r=forceRun(sid);if(!r)return;const n=r.liveReads||0;if(n>=90)return;
    const urgent=why==='anomaly'||why==='first'||why==='done',gap=urgent?2500:n<10?5000:n<30?9000:16000;
    const due=Math.max(Date.now()+(why==='step'?1500:400),(r.lastRead||0)+gap);
    if(r.kickTimer){if(!urgent||r.kickDue<=due)return;clearTimeout(r.kickTimer);}
    r.kickDue=due;r.kickWhy=urgent?why:(r.kickWhy||why);
    r.kickTimer=setTimeout(()=>{r.kickTimer=0;if(stopped||!r.token||runs.get(r.runId)!==r||Date.now()<cooldown)return;const w=r.kickWhy||why;r.kickWhy=null;if(r.busy){setTimeout(()=>monKick(sid,w),1200);return;}r.liveReads=(r.liveReads||0)+1;void poll(r,false,w);},Math.max(0,due-Date.now()));
  }
  // 本机更早轮次（异步加载后缓存；本机记录变化后 30 秒内最多刷新一次）
  function monLocal(sid){
    const m=monOf(sid);
    if((m.local===null||m.localRev!==catalog.revision&&Date.now()-m.localAt>30000)&&!m.localBusy){m.localBusy=true;m.localAt=Date.now();m.localRev=catalog.revision;
      void Promise.resolve(catalog.ready).then(()=>catalog.rows('turns','sid',sid,'next',400)).then(rows=>{const out=[];for(const row of rows||[]){try{const x=localSnapshot(row?.data);if(x)out.push(x);}catch{}}m.local=out;}).catch(()=>{m.local=m.local||[];}).finally(()=>{m.localBusy=false;});}
    return m.local||[];
  }
  // 每次读到 Trace 后自动核对（零额外请求）：复用一键检测的分段与比对逻辑
  function monTrace(r,trace){
    if(!prefs.monOn||!r?.sid||!Array.isArray(trace?.events))return;
    try{
      const sid=r.sid,segs=forceSegments(trace,r.runId),det=new Map();
      for(const x of segs.flatMap(g=>[...g.records,...g.streams])){
        if(x.properties){try{det.set(x.id,detail({runId:r.runId,spanId:x.id,message:x.message,isPartial:x.partial,properties:x.properties},x,r.runId));}catch{}continue;}
        const c=r.cache.get(x.id)||forceSpans.get(x.id);if(c?.available&&!(c.partial&&!x.partial))det.set(x.id,c);}
      const local=[...monLocal(sid)];if(r.data?.sid===sid){try{const x=localSnapshot(r.data);if(x&&!local.some(y=>y.key===x.key))local.push(x);}catch{}}
      const out=forceAnalyze(sid,r.runId,segs,det,local,{sid,at:Date.now(),runId:r.runId,events:trace.events.length,fetched:0,localTurns:0,notes:[],calls:[],groups:[],changes:[],current:null,error:null,auto:true});
      monSetAuto(sid,out);
    }catch(e){log('debug','实时监控','自动核对失败',e,{sid:r.sid});}
  }
  function monSetAuto(sid,out){
    const m=monOf(sid);m.auto=out;const cur=out.current,tk=cur&&!cur.local?cur.turn+':'+cur.attempt:null;
    // 不比较本机与服务端时钟：空闲时看到的最新一轮是“上一轮”，生成中只有出现更新的一轮后才据此下结论
    if(!m.busy&&tk)m.idleKey=tk;
    const fresh=!!tk&&(!m.busy||m.idleKey===undefined||tk!==m.idleKey);
    for(const f of m.flags){
      if(f.status!=='suspect')continue;
      if(f.msg!==m.cur?.id){f.status='stale';continue;}
      if(!fresh)continue;
      const inTurn=c=>!c.local&&c.turn===cur.turn&&c.attempt===cur.attempt,ch=out.changes.filter(c=>inTurn(c)&&!c.tierOnly)[0];
      if(ch){f.status='confirmed';f.from=ch.from;f.to=ch.to;log('warn','实时监控','已确认换模型：'+ch.from+' → '+ch.to+'（'+f.text+'）',null,{sid});continue;}
      // 疑点所在那一步对应的调用已完成且型号没变 → 排除（可能只是档位 / 思考设置变化）
      const tc=out.calls.filter(c=>c.src==='trace'&&inTurn(c)),k=tc[Math.max(1,f.step)-1];
      if(tc.length>=f.step&&k&&!k.partial){f.status='cleared';f.same=cur.name;log('info','实时监控','已排除：第 '+f.step+' 步仍是 '+cur.name+'（'+f.text+'）',null,{sid});}
    }
    const key=out.changes.map(c=>c.from+'>'+c.to+'@'+c.at).join('|')+'#'+(out.current?.name||'')+'#'+out.calls.length+'#'+out.calls.filter(c=>!c.partial).length+'#'+(out.shift?.kind||'')+'#'+out.tiers.length+'#'+m.flags.map(f=>f.status).join('');
    if(key!==m.autoKey){m.autoKey=key;mon.serial++;paint();}
  }
  // 当前对话的换模型结论：switch 本轮已确认 / suspect 疑似 / info 更早换过 / ok 未发现 / idle 数据不足 / off 已关闭
  function monState(sid){
    if(!prefs.monOn)return {tone:'off',icon:'pulse',short:'监控已关',text:'实时监控已在设置里关闭'};
    const m=sid?mon.bySid.get(sid):null,auto=m?.auto,cur=auto?.current;
    const recent=f=>Date.now()-f.at<30*60000&&f.level!=='weak';
    const conf=m?.flags.filter(f=>f.status==='confirmed'&&recent(f)).at(-1);
    const inTurn=c=>cur&&c.turn===cur.turn&&c.attempt===cur.attempt&&!c.local;
    const ch=auto?.changes.filter(c=>inTurn(c)&&!c.tierOnly).at(-1);
    if(ch||conf){const a=ch?.from||conf.from,b=ch?.to||conf.to;return {tone:'switch',icon:'swap',short:'本轮换了模型',text:'已确认换模型：'+short_(a)+' → '+short_(b)+(ch?'（第 '+ch.n+' 次调用起）':''),from:a,to:b};}
    const sus=m?.flags.filter(f=>f.status==='suspect'&&recent(f)).at(-1);
    if(sus)return {tone:'suspect',icon:'alert',short:'疑似换模型',text:'疑似换模型：'+sus.text+' · 正在核对',flag:sus};
    const tier=auto?.tiers.filter(inTurn).at(-1)||auto?.changes.filter(c=>inTurn(c)&&c.tierOnly).map(c=>({from:tierName(c.from),to:tierName(c.to)})).at(-1);
    if(tier)return {tone:'info',icon:'gauge',short:'档位变化',text:'同一模型，档位 '+tier.from+' → '+tier.to+'（不算换模型）'};
    const sh=auto?.shift&&cur&&auto.shift.turn===cur.turn?auto.shift:null;
    if(sh&&sh.kind==='drop')return {tone:'suspect',icon:'gauge',short:'消耗骤降',text:'单次调用消耗骤降 ↓'+Math.round((1-sh.ratio)*100)+'%'+(sh.same?'（名称未变，疑似降档）':'')};
    if(auto?.changes.length)return {tone:'info',icon:'swap',short:'换过 '+auto.changes.length+' 次',text:'本对话更早换过 '+auto.changes.length+' 次模型，本轮未变'};
    if(auto?.calls.length)return {tone:'ok',icon:'check',short:'未换模型',text:'全程同一模型 · '+auto.calls.length+' 次调用'};
    return {tone:'idle',icon:'pulse',short:'监控中',text:'实时监控中：等待本对话的调用记录'};
  }
  const short_=n=>n?famTier(n).filter(Boolean).join(' '):'未知';
  mon.timer=setInterval(()=>{try{monTick();}catch(e){if(!mon.err){mon.err=1;log('debug','实时监控','读取对话状态失败',e);}}},650);
  // 同一模型家族（忽略档位 / -thinking 等后缀）：档位变化单独提示，不算换模型
  const MON_TX=/-(none|minimal|low|medium|high|xhigh|max|thinking)$/,famKey=n=>n?brand.canon(n).replace(MON_TX,''):'',famEq=(a,b)=>!!a&&!!b&&(forceEq(a,b)||famKey(a)===famKey(b));
  const monFamSame=(a,b)=>famEq(a.internal||forceBest(a),b.internal||forceBest(b)),tierName=n=>brand.tierOf(n)||'默认';
  function dragger(handle,hooks){
    handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();const start=hooks.start(e);if(!start)return;try{handle.setPointerCapture(e.pointerId);}catch{}handle.dataset.active='';const shield=el('div','drag-shield',null,handle.getRootNode());let moved=false;
      const move=ev=>{if(Math.abs(ev.clientX-start.x)>2)moved=true;if(moved)hooks.move(ev,start);},up=ev=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',up);delete handle.dataset.active;shield.remove();if(moved)hooks.end(ev,start);else hooks.tap?.(ev);};
      handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up);});
    handle.addEventListener('dblclick',e=>{e.preventDefault();hooks.reset();});
  }
  // 把没有拖动的单击转发给被遮住的元素（Arena 侧栏边缘自带的折叠按钮）
  function forwardTap(handle,e){const host=handle.getRootNode().host||handle;const prev=host.style.pointerEvents;host.style.pointerEvents='none';try{const target=document.elementFromPoint(e.clientX,e.clientY);if(target&&target!==host)target.click();}finally{host.style.pointerEvents=prev;}}
  // Arena 左侧会话栏：shadcn 侧栏用 --sidebar-width 变量控制宽度，覆盖该变量即可调宽
  const sidebarOriginal=new WeakMap();
  function findSidebar(){const wrapper=[...document.querySelectorAll('[style*="--sidebar-width"]')].find(e=>e.style.getPropertyValue('--sidebar-width'));if(!wrapper)return null;const peer=wrapper.querySelector('[data-side][data-state]'),panel=wrapper.querySelector('[data-sidebar="sidebar"]')||peer;return {wrapper,peer,panel};}
  function sidebarWidth(sb){const v=sb.wrapper.style.getPropertyValue('--sidebar-width').trim();let n=NaN;if(/px$/.test(v))n=parseFloat(v);else if(/rem$/.test(v))n=parseFloat(v)*(parseFloat(getComputedStyle(document.documentElement).fontSize)||16);return Number.isFinite(n)&&n>0?n:sb.panel?.getBoundingClientRect().width||240;}
  function applySidebar(w){const sb=findSidebar();if(!sb)return null;if(!sidebarOriginal.has(sb.wrapper))sidebarOriginal.set(sb.wrapper,sb.wrapper.style.getPropertyValue('--sidebar-width'));const target=w?w+'px':sidebarOriginal.get(sb.wrapper)||'';if(sb.wrapper.style.getPropertyValue('--sidebar-width')!==target)sb.wrapper.style.setProperty('--sidebar-width',target);return sb;}
  function mount(){
    if(stopped||ui||!document.body)return;
    const saved=load(KEY+'.ui',{}),pref={open:saved.open!==false,level:['info','detail','debug'].includes(saved.level)?saved.level:'detail'};
    const persist=()=>store(KEY+'.ui',pref);
    const entry=el('div');entry.id='amp-lite-panel';entry.setAttribute('data-entry','');document.body.append(entry);
    const host=el('aside');host.id='amp-lite-dock';host.setAttribute('data-dock','');host.setAttribute('aria-label','模型信息');document.body.append(host);host.style.setProperty('--amp-width',prefs.width+'px');
    const gripHost=el('div');gripHost.id='amp-lite-grip';gripHost.setAttribute('data-grip','');document.body.append(gripHost);
    const foldHost=el('div');foldHost.id='amp-lite-fold';foldHost.setAttribute('data-fold','');foldHost.hidden=true;document.body.append(foldHost);
    const reloadHost=el('div');reloadHost.id='amp-lite-reload';reloadHost.setAttribute('data-reload','');reloadHost.hidden=true;
    const entryRoot=entry.attachShadow({mode:'open'}),root=host.attachShadow({mode:'open'}),gripRoot=gripHost.attachShadow({mode:'open'}),foldRoot=foldHost.attachShadow({mode:'open'}),reloadRoot=reloadHost.attachShadow({mode:'open'});let sheet;
    try{sheet=new CSSStyleSheet();sheet.replaceSync(css);entryRoot.adoptedStyleSheets=[sheet];root.adoptedStyleSheets=[sheet];gripRoot.adoptedStyleSheets=[sheet];foldRoot.adoptedStyleSheets=[sheet];reloadRoot.adoptedStyleSheets=[sheet];}catch{el('style','',css,entryRoot);el('style','',css,root);el('style','',css,gripRoot);el('style','',css,foldRoot);el('style','',css,reloadRoot);}
    // 右侧“模型信息”的收起 / 展开把手：展开时贴在侧栏左边缘（›），收起后贴在屏幕右边缘（‹ 模型信息）
    const fold=button(foldRoot,'','收起模型信息',()=>{pref.open=!pref.open;persist();render();},'fold');icon('chevron',fold);el('span','fold-label','模型信息',fold);const foldAt={on:false};
    function placeFold(){const on=foldAt.on;foldHost.hidden=!on;if(!on)return;const open=!!pref.open&&!host.hidden;fold.toggleAttribute('data-open',open);const t=open?'收起模型信息':'展开模型信息';if(fold.title!==t){fold.title=t;fold.setAttribute('aria-label',t);}fold.setAttribute('aria-expanded',String(open));
      const mr=document.querySelector('main')?.getBoundingClientRect();if(!mr)return;const w=22,h=fold.offsetHeight||44,vw=document.documentElement.clientWidth||innerWidth;let x=vw-w;if(open){const r=host.getBoundingClientRect();if(r.width>0)x=r.left-w;}
      fold.style.left=Math.round(x)+'px';fold.style.top=Math.round(mr.top+Math.max(8,(mr.height-h)/2))+'px';}
    try{new ResizeObserver(()=>placeFold()).observe(host);}catch{}
    const marks=new Map(),aliasCSS='[data-amp-local-title]{position:relative!important;color:transparent!important;display:block!important;flex:1 1 0%!important;min-width:0!important}[data-amp-local-title]>*{visibility:hidden!important}[data-amp-local-title]::after{content:attr(data-amp-short) / "";position:absolute;inset:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:hsl(var(--text-primary,24 6% 17%));pointer-events:none}[data-user-message-action][data-amp-sent]{display:flex!important;align-items:center;justify-content:flex-end;width:auto!important}[data-user-message-action][data-amp-sent]::before,[data-user-message-body-row][data-amp-sent]::after{content:attr(data-amp-sent);font-size:11px;line-height:1;font-family:inherit;font-variant-numeric:tabular-nums;color:hsl(var(--text-secondary,35 6% 45%));white-space:nowrap;pointer-events:none;opacity:.8}[data-user-message-action][data-amp-sent]::before{margin-right:6px}[data-user-message-body-row][data-amp-sent]::after{margin-top:2px}';
    let aliasSheet,aliasStyle;try{aliasSheet=new CSSStyleSheet();aliasSheet.replaceSync(aliasCSS);document.adoptedStyleSheets=[...document.adoptedStyleSheets,aliasSheet];}catch{aliasStyle=el('style','',aliasCSS,document.head||document.body);}
    let tab='overview',historyView=null,turnKey=null,selected=null,moreOpen=false,boundPath=location.pathname,compact=false,expanded=false,bodyStamp=[],pickerStamp='',turnStamp='',toastTimer=0,logItems=[],logKey='',logSerial=0,cacheLimit=50,openSid=null,confirmLogClear=false,lastLayout='',lastCooling=false,seenRevision=0,rawFilter='all',rawSpan=null,rawSerial=0,usageInfo=null,usageAt=0,confirmRawClear=false,settingsSerial=0,sentMarks=new Map(),sentPending=new Set(),sentStamp='';
    // 右上角按钮：切换深色 / 浅色模式（模型信息改由底部余额栏 / 信息栏打开）。
    const pageDark=()=>{const d=document.documentElement;return d.classList.contains('dark')||d.dataset.theme==='dark'||(!d.classList.contains('light')&&getComputedStyle(d).colorScheme==='dark');};
    function flipTheme(){const next=pageDark()?'light':'dark',d=document.documentElement;
      try{localStorage.setItem('theme',next);}catch{}
      d.classList.remove('dark','light');d.classList.add(next);if(d.dataset.theme)d.dataset.theme=next;d.style.colorScheme=next;
      try{window.dispatchEvent(new StorageEvent('storage',{key:'theme',newValue:next}));}catch{}paintTheme();}
    const trigger=button(entryRoot,'','切换深色 / 浅色模式',flipTheme,'trigger theme-toggle');const sunIcon=icon('sun',trigger),moonIcon=icon('moon',trigger);const triggerLabel=el('span','trigger-label','',trigger),mini=el('span','trigger-mini','',trigger);triggerLabel.hidden=true;mini.hidden=true;
    function paintTheme(){const dk=pageDark();sunIcon.style.display=dk?'':'none';moonIcon.style.display=dk?'none':'';trigger.title=dk?'切换到浅色模式':'切换到深色模式';trigger.setAttribute('aria-label',trigger.title);}
    paintTheme();new MutationObserver(paintTheme).observe(document.documentElement,{attributes:true,attributeFilter:['class','data-theme','style']});
    // 手机：长按输入框（约 0.3 秒，轻震一下）再往下拉 = 刷新页面（取代原来左上角的刷新按钮）。
    // 整页跟着手指往下，顶部圆环随下拉距离画满；画满后松开就刷新，没松手推回去就取消。
    // 输入框有未发送内容 / 待发附件 / 抽卡进行中 / 本轮还在进行时圆环变橙色，并提示松开后的后果。
    function reloadRisk(){let risky=false,turn=false;try{risky=errReload.draft()||errReload.gachaBusy()||[...document.querySelectorAll('main button[aria-label^="Remove "]')].some(b=>!b.closest('[role="log"]')&&b.getClientRects().length>0);turn=!risky&&!!errReload.sidNow()&&errReload.turnBusy(true);}catch{}return {risky,turn};}
    const pull=(()=>{
      const HOLD=320,SLOP=10,FULL=90,R=10,C=+(2*Math.PI*R).toFixed(2),bound=new WeakSet();
      const ph=document.createElement('div');ph.id='amp-pull';ph.hidden=true;const pr=ph.attachShadow({mode:'open'});
      const ps=document.createElement('style');ps.textContent=':host{all:initial;position:fixed;left:0;right:0;top:0;height:0;z-index:2147482000;pointer-events:none;display:block;--bg:hsl(var(--surface-primary,36 45% 98%));--fg:hsl(var(--text-primary,24 6% 17%));--line:hsl(var(--border-medium,30 9% 87%));--acc:var(--amp-acc,#6a5e54);--warn:#d97706;font:500 12px/1 var(--font-basel-grotesk,var(--font-inter,system-ui)),"PingFang SC","Microsoft YaHei",sans-serif}:host([hidden]){display:none}'
        +'.w{position:absolute;left:50%;top:0;display:flex;align-items:center;gap:7px;height:36px;padding:0 13px 0 5px;border-radius:18px;background:var(--bg);color:var(--fg);box-shadow:0 4px 16px #00000030,0 0 0 1px #0000000f;white-space:nowrap;transform:translate(-50%,-60px);opacity:0;will-change:transform}'
        +'svg{width:26px;height:26px;display:block;flex:none;transition:transform .2s cubic-bezier(.34,1.6,.5,1)}.tr{stroke:var(--line)}.arc{stroke:var(--acc);transition:stroke .15s}'
        +'.dot{fill:var(--acc);opacity:0;transform:scale(.3);transform-origin:13px 13px;transition:opacity .15s,transform .22s cubic-bezier(.34,1.6,.5,1)}.w[data-armed] svg{transform:scale(1.12)}.w[data-armed] .dot{opacity:1;transform:none}'
        +'.w[data-risky] .arc{stroke:var(--warn)}.w[data-risky] .dot{fill:var(--warn)}.w[data-risky][data-armed] .lbl{color:var(--warn)}'
        +'.w[data-spin] .rot{animation:ampPullSpin .75s linear infinite;transform-origin:13px 13px}.w[data-spin] .dot{opacity:0}@keyframes ampPullSpin{to{transform:rotate(360deg)}}';
      pr.append(ps);
      // 用 DOM 接口画圆环（不用 innerHTML，页面启用 Trusted Types 时也不报错）
      const w=document.createElement('div');w.className='w';pr.append(w);
      const sv=(tag,attrs,parent)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const k in attrs)n.setAttribute(k,String(attrs[k]));parent.append(n);return n;};
      const svg=sv('svg',{viewBox:'0 0 26 26','aria-hidden':'true'},w);sv('circle',{class:'tr',cx:13,cy:13,r:R,fill:'none','stroke-width':2.4},svg);const arc=sv('circle',{class:'arc',cx:13,cy:13,r:R,fill:'none','stroke-width':2.4,'stroke-linecap':'round',transform:'rotate(-90 13 13)','stroke-dasharray':C+' '+C,'stroke-dashoffset':C},sv('g',{class:'rot'},svg));sv('circle',{class:'dot',cx:13,cy:13,r:4},svg);
      const lbl=document.createElement('span');lbl.className='lbl';lbl.textContent='下拉刷新';w.append(lbl);
      let st=null,raf=0,resetTimer=0;
      const damp=d=>d<=FULL?d*0.7:FULL*0.7+(d-FULL)*0.2;
      function paint(){raf=0;if(!st||!st.pulling)return;const d=st.dy,p=Math.min(1,d/FULL),y=Math.min(140,damp(d)),b=document.body;if(b){b.style.transition='none';b.style.transform='translateY('+y.toFixed(1)+'px)';}
        w.style.transition='none';w.style.opacity=String(Math.min(1,0.25+p*1.2));w.style.transform='translate(-50%,'+(y/2-18).toFixed(1)+'px)';arc.setAttribute('stroke-dashoffset',(C*(1-p)).toFixed(2));
        const armed=p>=1;if(armed!==st.armed){st.armed=armed;w.toggleAttribute('data-armed',armed);if(armed){try{navigator.vibrate?.(12);}catch{}}}
        const r=st.risk||{};w.toggleAttribute('data-risky',!!(r.risky||r.turn));const t=!armed?'下拉刷新':r.risky?'松开刷新 · 未发送内容会丢失':r.turn?'松开刷新 · 本轮还在进行':'松开刷新';if(lbl.textContent!==t)lbl.textContent=t;}
      function frame(){if(!raf)raf=requestAnimationFrame(paint);}
      function clear(){const b=document.body;if(b){b.style.removeProperty('transform');b.style.removeProperty('transition');}w.removeAttribute('data-armed');w.removeAttribute('data-risky');w.removeAttribute('data-spin');ph.hidden=true;}
      function settle(){const b=document.body;clearTimeout(resetTimer);document.documentElement.removeAttribute('data-amp-pulling');if(b){b.style.transition='transform .3s cubic-bezier(.22,.9,.3,1)';b.style.transform='translateY(0px)';}w.style.transition='opacity .2s ease,transform .3s cubic-bezier(.22,.9,.3,1)';w.style.opacity='0';w.style.transform='translate(-50%,-60px)';resetTimer=setTimeout(clear,320);}
      function cancel(){if(!st)return;const s=st;st=null;clearTimeout(s.timer);if(s.pulling)settle();}
      function fire(){document.documentElement.removeAttribute('data-amp-pulling');w.setAttribute('data-spin','');lbl.textContent='正在刷新…';const b=document.body;if(b){b.style.transition='transform .2s ease';b.style.transform='translateY('+(FULL*0.7).toFixed(1)+'px)';}w.style.transition='transform .2s ease';w.style.transform='translate(-50%,'+(FULL*0.35-18).toFixed(1)+'px)';setTimeout(()=>{try{errReload.reloadNow(errReload.sidNow(),false);}catch{location.reload();}},160);}
      function onStart(e){if(st&&Date.now()-st.t0>8000)cancel();if(st||!prefs.pullRefresh||innerWidth>=768||e.touches.length!==1)return;if(e.target?.closest?.('button,a,select,input,label,[role="button"],[role="menu"],[role="menuitem"],[role="listbox"],[role="option"],[role="combobox"]'))return;const p=e.touches[0];
        st={t0:Date.now(),x:p.clientX,y:p.clientY,active:false,pulling:false,armed:false,dy:0,risk:null,timer:setTimeout(()=>{if(!st)return;st.active=true;st.risk=reloadRisk();try{navigator.vibrate?.(8);}catch{}},HOLD)};}
      function onMove(e){if(!st)return;const p=e.touches[0];if(!p)return;const dx=p.clientX-st.x,dy=p.clientY-st.y;
        if(!st.active){if(Math.hypot(dx,dy)>SLOP)cancel();return;}
        if(!st.pulling){if(dy>6&&dy>Math.abs(dx)){st.pulling=true;st.y0=p.clientY;clearTimeout(resetTimer);if(!ph.isConnected)document.documentElement.append(ph);ph.hidden=false;document.documentElement.setAttribute('data-amp-pulling','');try{getSelection()?.removeAllRanges();}catch{}}else{if(Math.hypot(dx,dy)>SLOP*2)cancel();return;}}
        if(e.cancelable)e.preventDefault();st.dy=Math.max(0,p.clientY-st.y0);frame();}
      function onEnd(e){if(!st)return;const s=st;st=null;clearTimeout(s.timer);if(!s.pulling)return;if(e.cancelable)e.preventDefault();if(s.armed)fire();else settle();}
      function onCtx(e){if(!st)return;if(st.pulling){e.preventDefault();return;}cancel();}
      function card(){const m=document.querySelector('main');if(!m)return null;const ed=[...m.querySelectorAll('div[contenteditable="true"],textarea')].filter(x=>!x.closest('[role="log"]')&&x.getClientRects().length).pop();if(!ed)return null;let c=ed;for(let i=0;i<7&&c.parentElement&&c.parentElement!==m;i++){const cs=getComputedStyle(c);if(parseFloat(cs.borderTopWidth)>=1&&parseFloat(cs.borderTopLeftRadius)>=8)return c;c=c.parentElement;}return ed;}
      function bind(){if(!prefs.pullRefresh||innerWidth>=768)return;const c=card();if(!c||bound.has(c))return;bound.add(c);c.addEventListener('touchstart',onStart,{passive:true});c.addEventListener('touchmove',onMove,{passive:false});c.addEventListener('touchend',onEnd,{passive:false});c.addEventListener('touchcancel',()=>cancel(),{passive:true});c.addEventListener('contextmenu',onCtx);}
      // 兜底：手势中途输入框被重绘（收不到 touchend）时，下一次触摸先把页面复位
      window.addEventListener('touchstart',()=>{if(st&&st.pulling&&Date.now()-st.t0>400)cancel();},{passive:true,capture:true});
      document.addEventListener('visibilitychange',()=>{if(document.hidden)cancel();});
      return {bind,destroy(){cancel();clear();ph.remove();}};
    })();
    // 手机侧栏（Arena 的对话列表抽屉）：变窄 + 半透明磨砂玻璃，遮罩调淡（设置里可关）；下拉刷新时整页禁止选中文字
    const glassStyle=el('style','','@media (max-width:767px){html[data-amp-glass] [data-sidebar="sidebar"][data-mobile="true"]{--sidebar-width:min(64vw,264px)!important;background-color:hsl(var(--sidebar-background,36 45% 98%) / .42)!important;-webkit-backdrop-filter:blur(26px) saturate(1.8);backdrop-filter:blur(26px) saturate(1.8);border-right:1px solid hsl(var(--border-medium,30 9% 87%) / .55);box-shadow:inset -1px 0 0 hsl(0 0% 100% / .3),12px 0 40px -10px #0000004d!important}'
      +'html[data-amp-glass] [data-sidebar="sidebar"][data-mobile="true"] :is([data-sidebar="header"],[data-sidebar="content"],[data-sidebar="footer"],[data-sidebar="group"],[data-sidebar="group-label"]){background-color:transparent!important}'
      +'html[data-amp-glass] body:has(> [role="dialog"][data-mobile="true"][data-state="open"]) > div.bg-black\\/80[data-state]:not([role]){background-color:rgb(0 0 0 / .08)!important}html[data-amp-glass]:has(body > [role="dialog"][data-mobile="true"][data-state="open"]) #amp-native-bar{opacity:0!important;pointer-events:none!important}}'
      +'html[data-amp-pulling],html[data-amp-pulling] *{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important}',document.head||document.body);
    // 手机端 Gemini 风格布局（设置里可关；只在 /agent 页面、屏宽 < 768 时生效，颜色沿用 Arena 原配色）：
    // 顶栏 ≡ · 模型名（与左侧卡片一致）…… 工作区 · 深浅色 · 头像（绿色圆环 = 美金余额）；输入框圆角长条：+ · 输入 · 厂商图标 · 发送；
    // 模式切换（Battle / Agent / Side by Side / Direct）从输入框挪到左侧抽屉 logo 旁。
    // v1.11.75 工作区面板选择器：Arena 的 Radix Sheet 自带 title="Workspace" 属性 → 纯 CSS 第一帧就能接管；再加上脚本打过标记的（vaul 抽屉 / 其他方式认出的 Sheet）
    const WSR=':is(html[data-amp-wsr] [role=dialog]:is([title="Workspace"],[title="工作区"]),[data-vaul-drawer][data-amp-wsright],[role=dialog][data-amp-wsright])';
    const gemOn=()=>!!prefs.gemLayout&&innerWidth<768&&/^\/agent(?:\/|$)/.test(location.pathname);
    const gemStyle=el('style','','@media (max-width:767px){'
      +'html[data-amp-gem] main div.grid:has(> div > button[aria-label="Open sidebar"]){display:flex!important;align-items:center;gap:4px}html[data-amp-gem] main div.grid:has(> div > button[aria-label="Open sidebar"]) > div:first-child{flex:none}html[data-amp-gem] main div.grid:has(> div > button[aria-label="Open sidebar"]) > div:nth-child(2){flex:1 1 auto;min-width:0;justify-content:flex-start!important}html[data-amp-gem] main div.grid:has(> div > button[aria-label="Open sidebar"]) > div:last-child{flex:none;gap:6px}html[data-amp-gem] main div.grid:has(> div > button[aria-label="Open sidebar"]) > div:last-child > *{order:1}'
      +'html[data-amp-gem] #amp-lite-panel[data-entry]{order:2!important}html[data-amp-gem] #amp-avatar{order:3!important}'
      +'html[data-amp-gem] main button[aria-label="Open sidebar"]{position:relative}html[data-amp-gem] main button[aria-label="Open sidebar"] > svg{opacity:0}'
      +'html[data-amp-gem] main button[aria-label="Open sidebar"]::after{content:"";position:absolute;left:50%;top:50%;width:24px;height:24px;margin:-12px 0 0 -12px;background:currentColor;-webkit-mask:url(data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%3E%3Cpath%20d=%22M4%208.5h16M4%2015.5h16%22%20stroke=%22black%22%20stroke-width=%222%22%20stroke-linecap=%22round%22/%3E%3C/svg%3E) center/contain no-repeat;mask:url(data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%3E%3Cpath%20d=%22M4%208.5h16M4%2015.5h16%22%20stroke=%22black%22%20stroke-width=%222%22%20stroke-linecap=%22round%22/%3E%3C/svg%3E) center/contain no-repeat;pointer-events:none}'
      +'html[data-amp-gem] main div:not([role="log"] *):has(> div > div > div.editor-content){border-radius:26px!important}html[data-amp-gem] main div:not([role="log"] *):has(> div > div.editor-content){padding:5px 6px!important}'
      +'html[data-amp-gem] main div:not([role="log"] *):has(> div.editor-content){flex-direction:row!important;flex-wrap:wrap;align-items:flex-end;gap:2px!important}html[data-amp-gem] main div:not([role="log"] *):has(> div.editor-content) > div.editor-content{order:1;flex:1 1 0%;min-width:0;align-self:center;padding:2px 4px}'
      +'html[data-amp-gem] main div:not([role="log"] *):has(> div.editor-content) > div.editor-content ~ div,html[data-amp-gem] main div:not([role="log"] *):has(> div.editor-content) > div.editor-content ~ div > div{display:contents!important}html[data-amp-gem] main div:not([role="log"] *):has(> div.editor-content) > div.editor-content ~ div > div:first-child > *{order:0}html[data-amp-gem] main div:not([role="log"] *):has(> div.editor-content) > div.editor-content ~ div > div:last-child > *{order:2}html[data-amp-gem] main div:not([role="log"] *):has(> div.editor-content) > :not(.editor-content):not(.editor-content ~ div){order:-1;flex:0 0 100%}'
      +'html[data-amp-gem] main button[aria-label="Add files and connections"]{width:36px!important;height:36px!important;border-radius:50%!important}'
      +'html[data-amp-gem] main button[aria-label="Send message"],html[data-amp-gem] main button[aria-label^="Stop"]{width:36px!important;min-width:36px!important;height:36px!important;padding:0!important;border-radius:50%!important}'
      +'html[data-amp-gem] main button[aria-label="Add files and connections"] ~ button[role="combobox"]{display:none!important}'
      +'html[data-amp-gem][data-amp-mode-open] main button[aria-label="Add files and connections"] ~ button[role="combobox"]{display:flex!important;position:fixed!important;left:10px!important;top:8px!important;width:44px!important;height:40px!important;opacity:0!important;pointer-events:none!important;z-index:1!important}'
      +'html[data-amp-gem] [data-amp-native-gacha="1"]{width:36px!important;min-width:36px;max-width:36px;height:36px!important;padding:0!important;border-radius:50%!important;gap:0!important}'
      +'html[data-amp-gem] [data-amp-native-gacha="1"] :is([data-amp-name],[data-amp-chev],[data-amp-progress],[data-amp-progress-bar]){display:none!important}html[data-amp-gem] [data-amp-native-gacha="1"] [data-amp-icon] svg{width:19px!important;height:19px!important}'
      +'html[data-amp-gem] [data-amp-native-gacha="1"][data-empty]::after{content:"";position:absolute;inset:auto;left:50%;top:50%;width:19px;height:19px;margin:-9.5px 0 0 -9.5px;background:currentColor;opacity:.72;-webkit-mask:url(data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%3E%3Crect%20x=%223.5%22%20y=%223.5%22%20width=%2217%22%20height=%2217%22%20rx=%224.5%22%20fill=%22none%22%20stroke=%22black%22%20stroke-width=%221.8%22/%3E%3Ccircle%20cx=%228.6%22%20cy=%228.6%22%20r=%221.5%22/%3E%3Ccircle%20cx=%2215.4%22%20cy=%2215.4%22%20r=%221.5%22/%3E%3Ccircle%20cx=%2215.4%22%20cy=%228.6%22%20r=%221.5%22/%3E%3Ccircle%20cx=%228.6%22%20cy=%2215.4%22%20r=%221.5%22/%3E%3Ccircle%20cx=%2212%22%20cy=%2212%22%20r=%221.5%22/%3E%3C/svg%3E) center/contain no-repeat;mask:url(data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%3E%3Crect%20x=%223.5%22%20y=%223.5%22%20width=%2217%22%20height=%2217%22%20rx=%224.5%22%20fill=%22none%22%20stroke=%22black%22%20stroke-width=%221.8%22/%3E%3Ccircle%20cx=%228.6%22%20cy=%228.6%22%20r=%221.5%22/%3E%3Ccircle%20cx=%2215.4%22%20cy=%2215.4%22%20r=%221.5%22/%3E%3Ccircle%20cx=%2215.4%22%20cy=%228.6%22%20r=%221.5%22/%3E%3Ccircle%20cx=%228.6%22%20cy=%2215.4%22%20r=%221.5%22/%3E%3Ccircle%20cx=%2212%22%20cy=%2212%22%20r=%221.5%22/%3E%3C/svg%3E) center/contain no-repeat;pointer-events:none}'
      +'html[data-amp-gem] [data-amp-native-gacha="1"][data-running="true"]{border-color:transparent!important}html[data-amp-gem] [data-amp-native-gacha="1"][data-running="true"] [data-amp-ring]{display:block;position:absolute;inset:0;border-radius:50%;pointer-events:none;background:conic-gradient(currentColor calc(var(--amp-p,0)*1%),color-mix(in srgb,currentColor 16%,transparent) 0);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2.6px),#000 calc(100% - 2.2px));mask:radial-gradient(farthest-side,transparent calc(100% - 2.6px),#000 calc(100% - 2.2px));transition:--amp-p .45s ease}'
      +'@keyframes ampWash{0%{transform:rotate(0)}38%{transform:rotate(290deg)}50%{transform:rotate(290deg)}88%{transform:rotate(0)}100%{transform:rotate(0)}}html[data-amp-gem] [data-amp-native-gacha="1"][data-running="true"]:not([data-landed]) [data-amp-icon],html[data-amp-gem] [data-amp-native-gacha="1"][data-running="true"][data-empty]:not([data-landed])::after{animation:ampWash 1.6s cubic-bezier(.45,0,.55,1) infinite}'
      +'html[data-amp-gem] [data-amp-native-gacha="1"][data-running="true"] [data-amp-ring]::before{content:"";position:absolute;inset:0;border-radius:50%;background:conic-gradient(transparent 0 76%,color-mix(in srgb,currentColor 45%,transparent) 95%,currentColor);animation:ampOrbit 1.25s linear infinite}@keyframes ampOrbit{to{transform:rotate(1turn)}}html[data-amp-gem] [data-amp-native-gacha="1"][data-landed] [data-amp-ring]::before{opacity:0;animation-play-state:paused}'
      +'html[data-amp-gem] [data-amp-native-gacha="1"][data-running="true"][data-landed] [data-amp-icon]{visibility:hidden}html[data-amp-gem] [data-amp-native-gacha="1"][data-running="true"][data-landed][data-empty]::after{opacity:0}html[data-amp-gem] [data-amp-native-gacha="1"][data-running="true"][data-landed] [data-amp-land]{display:flex;position:absolute;inset:0;align-items:center;justify-content:center;font:700 13px/1 system-ui,sans-serif;animation:ampLand .45s cubic-bezier(.3,1.6,.5,1) both}html[data-amp-gem] [data-amp-native-gacha="1"] [data-amp-land] svg{width:19px!important;height:19px!important}@keyframes ampLand{0%{transform:scale(.35) rotate(-140deg);opacity:0}100%{transform:none;opacity:1}}'
      +'html[data-amp-gem] [data-amp-native-gacha="1"][data-landed="hit"] [data-amp-ring]{background:hsl(var(--interactive-positive,125 49% 43%))}html[data-amp-gem] [data-amp-native-gacha="1"][data-hit]{animation:ampHit 1.2s ease-out both}@keyframes ampHit{0%{box-shadow:0 0 0 0 hsl(var(--interactive-positive,125 49% 43%)/.55)}100%{box-shadow:0 0 0 14px hsl(var(--interactive-positive,125 49% 43%)/0)}}'
      +'@media (prefers-reduced-motion:reduce){html[data-amp-gem] [data-amp-native-gacha="1"] :is([data-amp-icon],[data-amp-land],[data-amp-ring]),html[data-amp-gem] [data-amp-native-gacha="1"] [data-amp-ring]::before,html[data-amp-gem] [data-amp-native-gacha="1"]::after,html[data-amp-gem] [data-amp-native-gacha="1"][data-hit]{animation:none!important;transition:none!important}}'
      // v1.11.72 工作区从右侧滑出：接管 Arena 的底部抽屉，只改位置和进出动画（颜色、内容都是 Arena 原样）
      // v1.11.75 Arena 手机端工作区其实是 Radix Sheet（不是 vaul）：WSR 同时覆盖两种；不再要求 Gemini 布局
      +WSR+'{position:fixed!important;inset:var(--app-banner-height,0px) 0 0 auto!important;width:var(--amp-ws-w,min(92vw,480px))!important;max-width:none!important;height:auto!important;max-height:none!important;min-height:0!important;margin:0!important;border-radius:20px 0 0 20px!important;transform:none!important;translate:var(--amp-ws-x,0px) 0;transition:translate .3s cubic-bezier(.32,.72,0,1)!important;animation-name:ampWsIn!important;animation-duration:.36s!important;animation-timing-function:cubic-bezier(.32,.72,0,1)!important;animation-fill-mode:none!important;box-shadow:-12px 0 36px rgb(0 0 0/.2)!important;overflow:hidden!important}'
      +WSR+'[data-state=closed]{animation-name:ampWsOut!important;animation-duration:.28s!important;animation-fill-mode:forwards!important}'+WSR+'[data-amp-ws-drag]{transition:none!important;-webkit-user-select:none!important;user-select:none!important}'+WSR+'::after{display:none!important}'+WSR+'>div.relative.flex.w-full.justify-center:first-child,'+WSR+'>div.cursor-grab.touch-none{display:none!important}'
      +':is([data-vaul-overlay],div[data-state]:not([role]))[data-amp-wsright][data-state=open]{animation-name:ampWsFadeIn!important;animation-duration:.36s!important}:is([data-vaul-overlay],div[data-state]:not([role]))[data-amp-wsright][data-state=closed]{animation-name:ampWsFadeOut!important;animation-duration:.28s!important;animation-fill-mode:forwards!important}'
      +'[data-amp-wsgrip]{position:absolute;left:0;top:0;bottom:0;width:18px;z-index:60;touch-action:none;cursor:grab;-webkit-user-select:none;user-select:none}[data-amp-wsgrip]::after{content:"";position:absolute;left:6px;top:50%;width:5px;height:44px;margin-top:-22px;border-radius:3px;background:hsl(var(--surface-tertiary,33 31% 94%))}'
      +'@keyframes ampWsIn{from{translate:var(--amp-ws-from,100%) 0}to{translate:0 0}}@keyframes ampWsOut{from{translate:var(--amp-ws-x,0px) 0}to{translate:100% 0}}@keyframes ampWsFadeIn{from{opacity:var(--amp-ws-ov0,0)}to{opacity:1}}@keyframes ampWsFadeOut{from{opacity:var(--amp-ws-ov1,1)}to{opacity:0}}'
      +'@media (prefers-reduced-motion:reduce){'+WSR+',[data-amp-wsright]{animation-duration:.01s!important;transition:none!important}}'
      +'html[data-amp-gem] main div.flex.items-center.justify-end:has(> :is(button[aria-label="Open workspace"],button[aria-label="打开工作区"])):not(:has(> #amp-avatar))::after{content:"";order:3;flex:none;width:36px;height:36px;border-radius:999px;box-shadow:inset 0 0 0 1.5px color-mix(in srgb,currentColor 16%,transparent)}' // v1.11.73 头像位先占好（水合后头像放进同一个位置，顶部不再跳）
      +'html[data-amp-gem]:is([data-amp-wsedge],[data-amp-wspre]) main :is(button[aria-label="Open workspace"],button[aria-label="Toggle workspace sidebar"],button[aria-label="打开工作区"],button[aria-label="切换工作区侧边栏"]){position:absolute!important;width:1px!important;height:1px!important;min-width:0!important;min-height:0!important;padding:0!important;margin:0!important;border:0!important;opacity:0!important;pointer-events:none!important;overflow:hidden!important}'
      +'html[data-amp-gem] main button[aria-label="Add files and connections"]{position:relative}html[data-amp-gem] main button[aria-label="Add files and connections"] > span{opacity:0}'
      +'html[data-amp-gem] main button[aria-label="Add files and connections"]::after{content:"";position:absolute;inset:auto;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;background:currentColor;-webkit-mask:url(data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%3E%3Cpath%20d=%22M12%204.5v15M4.5%2012h15%22%20stroke=%22black%22%20stroke-width=%221.7%22%20stroke-linecap=%22round%22/%3E%3C/svg%3E) center/contain no-repeat;mask:url(data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%3E%3Cpath%20d=%22M12%204.5v15M4.5%2012h15%22%20stroke=%22black%22%20stroke-width=%221.7%22%20stroke-linecap=%22round%22/%3E%3C/svg%3E) center/contain no-repeat;pointer-events:none}'
      +'}',document.head||document.body);
    // 右上角头像 + 余额圆环（美金剩余 / 总额度：≥20% 绿色，<20% 橙色，<5% 或超限红色）。
    // 点头像：装了账号切换脚本（v1.0.21+）就打开账号切换面板，否则打开左侧抽屉（底部是账号那一行）。
    let me=(()=>{const m=load(KEY+'.me',null);return m&&typeof m==='object'?m:null;})(),meBusy=0,avStamp='';
    async function loadMe(force){if(meBusy&&Date.now()-meBusy<15000)return;if(!force&&me&&Date.now()-(me.at||0)<30*60e3)return;meBusy=Date.now();
      try{const r=await fetch('/api/me',{credentials:'include',cache:'no-store'});if(r.status===401||r.status===403)me={anon:true,at:Date.now()};else if(r.ok){const u=(await r.json())?.user||{};me={email:u.email||null,name:u.name||u.displayName||u.username||u.fullName||null,avatar:u.avatarUrl||u.avatar_url||u.image||u.picture||null,at:Date.now()};}store(KEY+'.me',me);}catch{}
      meBusy=0;avStamp='';paintAvatar();}
    window.addEventListener('amp:account',()=>{me=null;meBusy=0;avStamp='';loadMe(true);});
    const avatarHost=document.createElement('div');avatarHost.id='amp-avatar';const avRoot=avatarHost.attachShadow({mode:'open'});
    el('style','',':host{display:inline-flex;flex:none;align-items:center}:host([hidden]){display:none}.av{position:relative;width:36px;height:36px;padding:0;margin:0;border:0;border-radius:50%;background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:inherit;-webkit-tap-highlight-color:transparent}'
      +'.ring{position:absolute;inset:0;width:36px;height:36px;transform:rotate(-90deg);pointer-events:none}.tr{stroke:hsl(var(--border-medium,30 9% 87%))}.arc{stroke:#2fa55a;transition:stroke-dashoffset .6s ease,stroke .3s}.av[data-level=low] .arc{stroke:#e38a1e}.av[data-level=crit] .arc{stroke:#d9453b}.av[data-level=none] .arc{display:none}'
      +'.pic{width:27px;height:27px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;background:hsl(var(--surface-tertiary,30 10% 92%));color:hsl(var(--text-secondary,30 5% 35%));font:600 12px/1 system-ui,sans-serif}.pic img{width:100%;height:100%;object-fit:cover;display:block}.pic svg{width:17px;height:17px}',avRoot);
    const avBtn=button(avRoot,'','账号',()=>avatarTap(),'av'),AV_R=16.2,AV_C=+(2*Math.PI*AV_R).toFixed(2);
    const avSvg=document.createElementNS('http://www.w3.org/2000/svg','svg');avSvg.setAttribute('viewBox','0 0 36 36');avSvg.setAttribute('class','ring');avSvg.setAttribute('aria-hidden','true');
    for(const [cls,extra] of [['tr',{}],['arc',{'stroke-dasharray':AV_C+' '+AV_C,'stroke-dashoffset':AV_C,'stroke-linecap':'round'}]]){const c=document.createElementNS(avSvg.namespaceURI,'circle');for(const [k,v] of Object.entries({class:cls,cx:18,cy:18,r:AV_R,fill:'none','stroke-width':2.6,...extra}))c.setAttribute(k,String(v));avSvg.append(c);}
    avBtn.append(avSvg);const avPic=el('span','pic',null,avBtn),avArc=avSvg.querySelector('.arc');
    function paintAvatar(){const ratio=usd&&usd.allowanceUsd>0&&finiteNum(usd.balanceRemainingUsd)?Math.max(0,Math.min(1,usd.balanceRemainingUsd/usd.allowanceUsd)):null;
      const level=ratio===null?'none':usd.overLimit||ratio<0.05?'crit':ratio<0.2?'low':'ok',who=me&&!me.anon?(me.email||me.name||''):'',sw=!!document.documentElement.dataset.ampSwitchVer;
      const stamp=[ratio===null?'':ratio.toFixed(3),level,who,me?.avatar||'',me?.anon?1:0,sw].join('|');if(stamp===avStamp)return;avStamp=stamp;
      avBtn.dataset.level=level;avArc.setAttribute('stroke-dashoffset',ratio===null?String(AV_C):(AV_C*(1-ratio)).toFixed(2));
      const tip=(who?'账号 '+who:me?.anon?'未登录':'账号')+(ratio!==null?' · 美金余额 $'+usd.balanceRemainingUsd.toFixed(2)+' / $'+usd.allowanceUsd.toFixed(2)+'（'+Math.round(ratio*100)+'%）':'')+(sw?' · 点击切换账号':' · 点击打开侧栏');avBtn.title=tip;avBtn.setAttribute('aria-label',tip);
      avPic.replaceChildren();const initial=()=>{avPic.textContent=(who||'?').trim().charAt(0).toUpperCase();};
      if(me?.avatar){const img=document.createElement('img');img.alt='';img.referrerPolicy='no-referrer';img.decoding='async';img.onerror=()=>{img.remove();if(who)initial();else icon('user',avPic);};img.src=me.avatar;avPic.append(img);}else if(who)initial();else icon('user',avPic);}
    function avatarTap(){const side=()=>document.querySelector('main button[aria-label="Open sidebar"]')?.click();if(!document.documentElement.dataset.ampSwitchVer){side();return;}
      const open=!!document.querySelector('[data-amp-switcher]');try{window.dispatchEvent(new CustomEvent('amp:switch-open'));}catch{}if(open)return;setTimeout(()=>{if(!document.querySelector('[data-amp-switcher]'))side();},350);}
    // 抽屉顶部 logo 旁的模式切换：原按钮在输入框工具栏里（手机上藏起来不占位置）；点这里先关抽屉，再在左上角打开 Arena 自己的模式菜单
    const modeHost=document.createElement('div');modeHost.id='amp-mode';const modeRoot=modeHost.attachShadow({mode:'open'});
    el('style','',':host{display:inline-flex;flex:none;align-items:center;margin:0 4px 0 2px}.mode{display:inline-flex;align-items:center;gap:3px;height:30px;padding:0 5px 0 7px;border-radius:9px;border:1px solid hsl(var(--border-medium,30 9% 87%) / .8);background:hsl(var(--surface-primary,36 45% 98%) / .45);color:inherit;font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}.mode:active{background:hsl(var(--surface-primary,36 45% 98%) / .85)}.ico{display:inline-flex}.ico svg{width:16px;height:16px;display:block}.mode>svg{width:12px;height:12px;opacity:.6}',modeRoot);
    const modeBtn=button(modeRoot,'','切换模式',()=>modeTap(),'mode'),modeIco=el('span','ico',null,modeBtn);icon('down',modeBtn);
    const modeTrigger=()=>document.querySelector('main button[aria-label="Add files and connections"] ~ button[role="combobox"]')||[...document.querySelectorAll('main button[role="combobox"]')].find(b=>/^(Battle|Agent|Side by Side|Direct)\b/i.test((b.textContent||'').trim()))||null;
    function syncMode(){const row=document.querySelector('[role="dialog"][data-mobile="true"] [data-sidebar="header"] > div'),trig=gemOn()?modeTrigger():null;
      if(!row||!trig){if(modeHost.isConnected)modeHost.remove();return;}
      const logo=row.querySelector(':scope > ul')||row.firstElementChild;if(logo&&logo.nextSibling!==modeHost)logo.after(modeHost);
      const name=(trig.textContent||'').trim()||'模式';if(modeHost.dataset.name!==name){modeHost.dataset.name=name;modeIco.replaceChildren();const sv=trig.querySelector('svg');if(sv)modeIco.append(sv.cloneNode(true));modeBtn.title='模式：'+name+' · 点击切换';modeBtn.setAttribute('aria-label',modeBtn.title);}
      // 顺便记下侧栏底部的头像（/api/me 没给头像时用）
      const fi=document.querySelector('[role="dialog"][data-mobile="true"] [data-sidebar="footer"] img'),fs=fi&&(fi.currentSrc||fi.src);if(fs&&me&&!me.anon&&!me.avatar){me.avatar=fs;store(KEY+'.me',me);avStamp='';paintAvatar();}}
    function modeTap(){const hb=document.querySelector('[role="dialog"][data-mobile="true"] [data-sidebar="header"] > div > button');if(hb)hb.click();else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
      setTimeout(()=>{const t=modeTrigger();if(!t)return;const d=document.documentElement;d.setAttribute('data-amp-mode-open','');requestAnimationFrame(()=>{t.click();let n=0;const iv=setInterval(()=>{n++;if(t.getAttribute('aria-expanded')!=='true'&&n>2||n>300||!t.isConnected){clearInterval(iv);d.removeAttribute('data-amp-mode-open');}},200);});},420);}
    // v1.11.70 手机端工作区：顶栏不再单独放工作区按钮，收进右侧屏幕边缘的小把手——向左拖出来（或轻点）打开，上下拖动换位置（会记住）。
    // 原生按钮只是视觉隐藏（保留 1px 给顶栏定位），打开时照样点它；工作区打开 / 有弹窗 / 正在输入时把手自动让开；新对话还没有工作区时把手变灰。
    const WS_SEL=['Open workspace','Toggle workspace sidebar','Close workspace','打开工作区','切换工作区侧边栏','关闭工作区'].map(x=>'main button[aria-label="'+x+'"]').join(','),WS_OPEN=64;
    const WS_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.2a1.9 1.9 0 0 1 1.9-1.9h3.9l2 2.2h7.3a1.9 1.9 0 0 1 1.9 1.9v8.1a1.9 1.9 0 0 1-1.9 1.9H5.4a1.9 1.9 0 0 1-1.9-1.9z"/></svg>';
    const wsHost=document.createElement('div');wsHost.id='amp-wsedge';const wsRoot=wsHost.attachShadow({mode:'open'});
    el('style','',':host{all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:35;display:block;--w:0px;--k:0;--y:60vh;font:13px/1.35 system-ui,-apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif;color:hsl(var(--text-primary,30 5% 15%))}'
      +'.tab{position:fixed;right:var(--w);top:calc(var(--y) - 30px);width:22px;height:60px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding-left:1px;border-radius:13px 0 0 13px;background:color-mix(in srgb,hsl(var(--surface-primary,36 45% 98%)) 84%,transparent);-webkit-backdrop-filter:blur(14px) saturate(1.6);backdrop-filter:blur(14px) saturate(1.6);box-shadow:inset 1px 0 0 hsl(var(--border-medium,30 9% 87%)),inset 0 1px 0 hsl(var(--border-medium,30 9% 87%)),inset 0 -1px 0 hsl(var(--border-medium,30 9% 87%)),-3px 3px 14px rgb(0 0 0/.10);color:hsl(var(--text-secondary,30 5% 35%));touch-action:none;cursor:grab;outline:none;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;transition:right .3s cubic-bezier(.2,.9,.3,1),opacity .2s,transform .25s}'
      +'.tab::before{content:"";position:absolute;left:-16px;right:0;top:-10px;bottom:-10px}.tab svg{width:15px;height:15px;flex:none;pointer-events:none}.tab:focus-visible{box-shadow:0 0 0 2px hsl(var(--text-secondary,30 5% 35%))}'
      +':host([data-drag]) .tab{transition:opacity .2s;cursor:grabbing}:host([data-drag="move"]) .tab{transform:scale(1.08)}:host([data-disabled]) .tab svg{opacity:.4}'
      +':host([data-notab]) .tab{display:none!important}'
      +':host([data-away]) .tab{opacity:0;pointer-events:none;transform:translateX(26px)}:host([data-nope]) .tab{animation:wsNope .42s}@keyframes wsNope{20%,60%{transform:translateX(-5px)}40%,80%{transform:translateX(3px)}}'
      +'.ghost{position:fixed;top:var(--app-banner-height,0px);bottom:0;right:0;width:var(--w);box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column;align-items:stretch;border-radius:20px 0 0 20px;background:hsl(var(--surface-secondary,0 0% 100%));box-shadow:-12px 0 36px rgb(0 0 0/.2);color:hsl(var(--text-secondary,30 5% 35%));pointer-events:none;visibility:hidden;white-space:nowrap}'
      +'.ghost::before{content:"";position:absolute;left:6px;top:50%;width:5px;height:44px;margin-top:-22px;border-radius:3px;background:hsl(var(--surface-tertiary,33 31% 94%))}'
      +'.ghost > *{opacity:clamp(0,calc(var(--k)*4 - .5),1)}.gh{display:flex;align-items:center;gap:8px;padding:22px 20px 0 24px;font-size:18px;color:hsl(var(--text-primary,30 5% 15%))}.gh svg{width:20px;height:20px;flex:none;color:hsl(var(--text-tertiary,35 6% 38%))}'
      +'.gs{margin:14px 20px 12px 24px;height:10px;width:44%;border-radius:5px;background:hsl(var(--surface-tertiary,33 31% 94%))}.gd{height:1px;margin:0 0 8px;background:hsl(var(--border-medium,30 9% 87%))}.gr{display:flex;align-items:center;gap:10px;padding:11px 20px 11px 30px}.gr i{width:18px;height:15px;border-radius:3px;flex:none;background:hsl(var(--surface-tertiary,33 31% 94%))}.gr b{height:11px;border-radius:6px;flex:none;background:hsl(var(--surface-tertiary,33 31% 94%))}'
      +'.hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:5px 12px;border-radius:999px;background:hsl(var(--surface-primary,36 45% 98%));box-shadow:0 0 0 1px hsl(var(--border-medium,30 9% 87%));font-size:12px}'
      +':host([data-ready]) .hint{color:hsl(var(--interactive-positive,125 49% 43%))}:host([data-disabled]) .hint{color:hsl(var(--text-tertiary,30 4% 55%))}'
      +'.shade{position:fixed;inset:var(--app-banner-height,0px) 0 0 0;background:rgb(0 0 0/calc(var(--k)*.8));pointer-events:none;visibility:hidden}'
      +':host([data-drag="pull"]) :is(.ghost,.shade),:host([data-settle]) :is(.ghost,.shade),:host([data-go]) :is(.ghost,.shade){visibility:visible}'
      +':host([data-settle]) .ghost{transition:width .3s cubic-bezier(.2,.9,.3,1)}:host([data-settle]) .shade{transition:background .3s}:host([data-go]) .ghost{transition:width .2s ease-out}:host([data-go]) .shade{transition:background .2s ease-out}'
      +'@media (prefers-reduced-motion:reduce){.tab,.ghost,.shade{transition:none!important;animation:none!important}}',wsRoot);
    const wsShade=el('div','shade',null,wsRoot),wsGhost=el('div','ghost',null,wsRoot),wsTab=el('div','tab',null,wsRoot);
    wsGhost.innerHTML='<div class="gh">'+WS_ICON+'<span>工作区</span></div><div class="gs"></div><div class="gd"></div>'+[62,48,70,40,56,66].map(w=>'<div class="gr"><i></i><b style="width:'+w+'%"></b></div>').join('')+'<span class="hint"></span>';wsTab.innerHTML=WS_ICON;
    wsTab.setAttribute('role','button');wsTab.tabIndex=0;wsTab.setAttribute('aria-label','打开工作区');wsTab.title='工作区：轻点或向左拖出来打开（也可以在对话内容上向左划），上下拖动换位置';
    const wsHint=wsGhost.querySelector('.hint');let wsBtn=null,wsDrag=null,wsSettleT=0;
    const wsOff=b=>!b||b.disabled||b.getAttribute('aria-disabled')==='true';
    // v1.11.72 工作区从右侧滑出：Arena 手机端的工作区是 vaul 底部抽屉（[data-vaul-drawer]）。从把手打开时接管这一个抽屉——
    // 改成贴右侧的整高面板，从预览面板停下的位置接着滑到位（不再从底部升起），遮罩也从拉动时的暗度接着变暗；
    // 面板左边缘有竖向小把手：按住左边缘或标题栏向右划收起（跟手，划过 30% 或甩一下就关，不够就弹回）；点左侧暗处 / 原生 × 照常关闭。
    // 别的方式打开的工作区（例如点消息里的文件）也一样从右侧出来；其他 vaul 抽屉不动。
    let wsExpect=0,wsGoT=0,wsMoT;
    const wsW=()=>Math.round(Math.min(innerWidth*0.92,480));
    // v1.11.75 手机宽度下一律接管工作区：不再要求 Gemini 布局 / 右侧把手 / 顶栏里找到原生按钮
    const wsRightOn=()=>prefs.wsRight!==false&&innerWidth<768;
    const WS_RX=/\bWorkspace\b|工作区|工作空间/i,WS_META=/\d+(?:\.\d+)?\s*[KMGT]?B\s*\/\s*\d+(?:\.\d+)?\s*[KMGT]B/i;
    const wsHead=(d,n)=>{let s='';try{const w=document.createTreeWalker(d,NodeFilter.SHOW_TEXT);while(s.length<n&&w.nextNode())s+=w.currentNode.nodeValue+' ';}catch{}return s;};
    const wsSheet=d=>{const c=d.classList;return c.contains('bottom-0')&&c.contains('inset-x-0');}; // shadcn Sheet side="bottom"
    // 识别工作区：Sheet 的 title 属性就是 Workspace；否则只看底部抽屉（vaul / 底部 Sheet）——标题（aria-labelledby 可能多个 id）/ aria-label /
    // 开头文字里有 Workspace·工作区·工作空间，或同时出现“13.5MB/128.0MB”这类容量和 files、或 Processes + files。居中的普通对话框不碰
    const wsIsWs=d=>{try{if(/^(Workspace|工作区|工作空间)$/i.test((d.getAttribute('title')||'').trim()))return true;if(!d.hasAttribute('data-vaul-drawer')&&!wsSheet(d))return false;
      const ids=(d.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean),lab=ids.map(i=>document.getElementById(i)?.textContent||'').join(' ')+' '+(d.getAttribute('aria-label')||'');if(WS_RX.test(lab))return true;
      const t=wsHead(d,600);return WS_RX.test(t.slice(0,240))||WS_META.test(t)&&/\bfiles?\b|个文件/i.test(t)||/\bProcesses\b/.test(t)&&/\bfiles?\b/i.test(t);}catch{return false;}};
    const wsOv=d=>{for(let n=d.previousElementSibling,i=0;n&&i<4;n=n.previousElementSibling,i++)if(n.matches?.('[data-vaul-overlay],div[data-state]:not([role])'))return n;if(!d.hasAttribute('data-vaul-drawer'))return null;return [...document.querySelectorAll('[data-vaul-overlay]')].filter(o=>o.getAttribute('data-state')!=='closed').pop()||null;};
    function wsClose(d){const x=[...d.querySelectorAll('button')].find(b=>/^(close|关闭)/i.test((b.getAttribute('aria-label')||b.title||'').trim()));if(x){x.click();return;}
      try{(document.activeElement||document.body).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true}));}catch{}}
    function wsSwipe(d){if(d._ampWsSw)return;d._ampWsSw=1;let s=null,noClick=0;
      const hs=el=>{for(let n=el;n&&n!==d;n=n.parentElement)if(n.scrollLeft>0&&n.scrollWidth>n.clientWidth+1)return true;return false;};
      d.addEventListener('pointerdown',e=>{if(e.button>0||!e.isPrimary||d.getAttribute('data-state')==='closed')return;const t=performance.now();s={id:e.pointerId,x:e.clientX,y:e.clientY,w:d.getBoundingClientRect().width||wsW(),mode:'',hs:[[t,e.clientX]],grip:!!e.target.closest?.('[data-amp-wsgrip]')};},true);
      d.addEventListener('pointermove',e=>{if(!s||e.pointerId!==s.id)return;const dx=e.clientX-s.x,dy=e.clientY-s.y;
        if(!s.mode){if(Math.abs(dx)<8&&Math.abs(dy)<8)return;if(dx>0&&dx>Math.abs(dy)*1.2&&(s.grip||!hs(e.target))){s.mode='drag';d.setAttribute('data-amp-ws-drag','');try{getSelection()?.removeAllRanges();}catch{}try{d.setPointerCapture(e.pointerId);}catch{}}else{s=null;return;}}
        s.hs.push([performance.now(),e.clientX]);if(s.hs.length>10)s.hs.shift();
        const x=Math.max(0,Math.round(dx)),o=wsOv(d);d.style.setProperty('--amp-ws-x',x+'px');if(o){o.style.transition='none';o.style.opacity=String(Math.max(0,1-x/s.w).toFixed(3));}
        e.preventDefault();e.stopPropagation();},true);
      const end=e=>{if(!s||e.pointerId!==s.id)return;const st=s;s=null;if(st.mode!=='drag')return;d.removeAttribute('data-amp-ws-drag');noClick=Date.now();
        const now=performance.now(),up=e.type==='pointerup',dx=up?Math.max(0,e.clientX-st.x):0,ref=st.hs.find(h=>now-h[0]<=120)||st.hs.at(-1),v=up&&ref?(e.clientX-ref[1])/Math.max(16,now-ref[0]):0,o=wsOv(d);
        if(dx>st.w*0.3||dx>24&&v>0.35){if(o)o.style.setProperty('--amp-ws-ov1',o.style.opacity||'1');wsClose(d);}
        else{d.style.setProperty('--amp-ws-x','0px');if(o){o.style.transition='opacity .3s';o.style.opacity='';}}};
      d.addEventListener('pointerup',end,true);d.addEventListener('pointercancel',end,true);
      d.addEventListener('click',e=>{if(e.isTrusted&&Date.now()-noClick<350){e.preventDefault();e.stopPropagation();}},true);}
    function wsMark(d,handoff){
      if(d.hasAttribute('data-amp-wsright'))return;const W=wsW();document.documentElement.style.setProperty('--amp-ws-w',W+'px');
      const going=handoff&&wsHost.hasAttribute('data-go');let from=W,k=0;
      if(going){const gw=wsGhost.getBoundingClientRect().width;if(gw>0)from=Math.max(0,Math.round(W-gw));const m=/rgba?\(([^)]*)\)/.exec(getComputedStyle(wsShade).backgroundColor||''),a=m?parseFloat(m[1].split(',')[3]):NaN;k=Math.min(1,Math.max(0,(isNaN(a)?0:a)/0.8));}
      d.style.setProperty('--amp-ws-from',from+'px');d.style.setProperty('--amp-ws-x','0px');d.setAttribute('data-amp-wsright','');d.setAttribute('data-vaul-no-drag','');
      const o=wsOv(d);if(o){o.setAttribute('data-amp-wsright','');o.style.setProperty('--amp-ws-ov0',k.toFixed(3));}
      if(!d.querySelector(':scope > [data-amp-wsgrip]')){const g=document.createElement('div');g.setAttribute('data-amp-wsgrip','');g.setAttribute('data-vaul-no-drag','');g.setAttribute('aria-hidden','true');d.append(g);}
      wsSwipe(d);
      if(going){clearTimeout(wsGoT);wsHost.removeAttribute('data-go');wsPull(0);wsHost.removeAttribute('data-ready');}
      setTimeout(wsSync,0);}
    let wsPend=false; // 有打开着、但还认不出是不是工作区的底部抽屉（内容可能晚一步渲染）→ 之后每次 DOM 变化再认一次
    function wsScan(){wsPend=false;if(!wsRightOn())return;const mine=Date.now()<wsExpect;
      for(const d of document.querySelectorAll('[data-vaul-drawer]:not([data-amp-wsright]),[role="dialog"]:not([data-amp-wsright])')){if(d.getAttribute('data-state')==='closed')continue;
        const bottom=d.hasAttribute('data-vaul-drawer')||wsSheet(d);if(wsIsWs(d)||mine&&bottom){wsMark(d,mine);if(mine)wsExpect=0;}else if(bottom)wsPend=true;}}
    // v1.11.75 抽屉 / Sheet 插在页面任何位置都能在首帧前接管（MutationObserver 回调在绘制前执行）：观察 body 整个子树，
    // 插入的节点本身是对话框 / vaul 抽屉 / 遮罩就立即扫描；只有门户层（body、body 的直接子节点、#root-portal-target）才往里 querySelector
    const wsHit=n=>n.getAttribute('role')==='dialog'||n.hasAttribute('data-vaul-drawer')||n.hasAttribute('data-vaul-overlay');
    const wsMo=new MutationObserver(recs=>{const bd=document.body;for(const r of recs){const t=r.target,top=t===bd||t.parentNode===bd||t.id==='root-portal-target';for(const n of r.addedNodes)if(n.nodeType===1&&(wsHit(n)||top&&n.querySelector?.('[role="dialog"],[data-vaul-drawer]'))){wsScan();return;}}if(wsPend)wsScan();});
    function wsWatch(){if(wsMoT||!document.body)return;wsMoT=1;try{wsMo.observe(document.body,{childList:true,subtree:true});const t=document.getElementById('root-portal-target');if(t&&!document.body.contains(t))wsMo.observe(t,{childList:true,subtree:true});}catch{}}
    function wsPlace(c){const h=innerHeight;c=Math.min(h*0.88,Math.max(h*0.12,c));wsHost.style.setProperty('--y',Math.round(c)+'px');return c;}
    function wsPull(dx,settle){const W=wsW(),w=Math.round(Math.max(0,dx<=W?dx:W+Math.min(24,(dx-W)*0.2)));wsHost.style.setProperty('--w',w+'px');wsHost.style.setProperty('--k',String(Math.min(1,w/W).toFixed(3)));
      const ready=w>=WS_OPEN&&!wsOff(wsBtn);if(ready!==wsHost.hasAttribute('data-ready')){wsHost.toggleAttribute('data-ready',ready);if(ready&&wsDrag)try{navigator.vibrate?.(8);}catch{}}
      wsHint.textContent=wsOff(wsBtn)?'这个对话还没有工作区':ready?'松手打开':'继续向左拉';
      clearTimeout(wsSettleT);if(settle){wsHost.setAttribute('data-settle','');wsSettleT=setTimeout(()=>wsHost.removeAttribute('data-settle'),340);}else wsHost.removeAttribute('data-settle');}
    function wsOpen(){if(!wsBtn?.isConnected)wsSync();const b=wsBtn;
      if(wsOff(b)){wsPull(0,true);wsHost.setAttribute('data-nope','');setTimeout(()=>wsHost.removeAttribute('data-nope'),460);return false;}
      // v1.11.72 松手后预览面板继续滑向整宽，同时立刻点原生按钮；Arena 的抽屉一出现就从预览面板所在的位置接着滑到位（wsMark）
      wsHost.removeAttribute('data-settle');wsHost.setAttribute('data-go','');wsPull(wsW());wsWatch();wsExpect=Date.now()+1800;
      try{b.click();}catch{}
      clearTimeout(wsGoT);wsGoT=setTimeout(()=>{if(!wsHost.hasAttribute('data-go'))return;wsHost.removeAttribute('data-go');wsPull(0);wsHost.removeAttribute('data-ready');wsSync();},700);return true;}
    // 工作区已打开 / 有弹窗 / 输入法弹出 → 把手让开，对话区左划也不接（v1.11.76 抽成函数：左划按下时现算，不依赖上次同步的 data-away）
    // v1.11.75 只在输入法真正弹出时让开（data-amp-kb）；以前输入框有焦点就藏，收起键盘后焦点还在，把手一直看不见
    function wsBusy(b){const lab=b?.getAttribute('aria-label')||'',open=/close|关闭/i.test(lab)||b?.getAttribute('aria-expanded')==='true'||b?.getAttribute('aria-pressed')==='true'||b?.getAttribute('data-state')==='open';
      if(open||document.documentElement.hasAttribute('data-amp-kb'))return true;
      return [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(d=>d.getAttribute('data-state')!=='closed'&&d.getBoundingClientRect().width>0);}
    function wsSync(){
      document.documentElement.toggleAttribute('data-amp-wsr',prefs.wsRight!==false);wsWatch();wsScan(); // v1.11.75 先接管工作区（与把手是否显示无关）
      // v1.11.76 右侧把手或“对话区左划”任一开着就找原生按钮；只开左划（没开 Gemini 布局 / 把手）时不显示把手，顶栏按钮照常显示
      const tabOn=gemOn()&&prefs.wsEdge!==false;let b=null;if((tabOn||wsSwOn())&&document.body)for(const x of document.querySelectorAll(WS_SEL)){const m=x.closest('main'),r=x.getBoundingClientRect();if(m&&r.width>0&&r.height>0&&r.top<m.getBoundingClientRect().top+100){b=x;break;}}
      document.documentElement.toggleAttribute('data-amp-wsedge',!!b&&tabOn);
      if(!b){wsBtn=null;if(wsHost.isConnected&&!wsDrag&&!wsHost.hasAttribute('data-go'))wsHost.remove();return;}
      wsBtn=b;if(!wsHost.isConnected)document.body.append(wsHost);wsHost.toggleAttribute('data-notab',!tabOn);if(!wsDrag)wsPlace(prefs.wsEdgeY*innerHeight);
      wsHost.toggleAttribute('data-away',!wsDrag&&!wsHost.hasAttribute('data-go')&&wsBusy(b));wsHost.toggleAttribute('data-disabled',wsOff(b));
      wsTab.setAttribute('aria-disabled',String(wsOff(b)));
    }
    wsTab.addEventListener('pointerdown',e=>{if(e.button>0||wsHost.hasAttribute('data-go'))return;const r=wsTab.getBoundingClientRect(),t=performance.now();wsDrag={id:e.pointerId,x:e.clientX,y:e.clientY,c:r.top+r.height/2,t,mode:'',hs:[[t,e.clientX]]};try{wsTab.setPointerCapture(e.pointerId);}catch{}});
    wsTab.addEventListener('pointermove',e=>{const d=wsDrag;if(!d||e.pointerId!==d.id)return;const dx=d.x-e.clientX,dy=e.clientY-d.y;
      if(!d.mode){if(Math.abs(dx)<7&&Math.abs(dy)<7)return;d.mode=dx>=Math.abs(dy)?'pull':'move';wsHost.setAttribute('data-drag',d.mode);}
      d.hs.push([performance.now(),e.clientX]);if(d.hs.length>10)d.hs.shift();
      if(d.mode==='pull')wsPull(dx);else wsPlace(d.c+dy);e.preventDefault();});
    const wsEnd=e=>{const d=wsDrag;if(!d||e.pointerId!==d.id)return;wsDrag=null;wsHost.removeAttribute('data-drag');
      if(!d.mode){if(e.type==='pointerup'&&performance.now()-d.t<600)wsOpen();return;}
      if(d.mode==='move'){const r=wsTab.getBoundingClientRect();prefs.wsEdgeY=+((r.top+r.height/2)/innerHeight).toFixed(4);savePrefs();return;}
      // 甩一下也算：看松手前 ~120ms 的速度（px/ms），慢慢拖不够远就弹回
      const dx=d.x-e.clientX,now=performance.now(),ref=d.hs.find(h=>now-h[0]<=120)||d.hs.at(-1),v=ref?(ref[1]-e.clientX)/Math.max(16,now-ref[0]):0;
      if(e.type==='pointerup'&&(dx>=WS_OPEN||dx>=28&&v>0.35))wsOpen();else wsPull(0,true);};
    wsTab.addEventListener('pointerup',wsEnd);wsTab.addEventListener('pointercancel',wsEnd);wsTab.addEventListener('lostpointercapture',wsEnd);
    wsTab.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();wsOpen();}});wsTab.addEventListener('contextmenu',e=>e.preventDefault());
    // v1.11.76 在对话内容上向左划也能把工作区拉出来——和拖右侧把手一样：预览面板跟着手指从右边出来，松手打开，不够远就弹回。
    // 安卓全面屏手势把“从屏幕最边缘开始的左划”当成系统返回，页面根本收不到，所以右侧把手在这类手机上只能轻点、拖不出来；
    // 从屏幕里面开始划就不受影响。只认明显的横向左划（横向 ≥ 纵向 2 倍）；上下滚动、代码块 / 表格等能横向滚动的地方、输入框里开始的手势都不管。
    // 用 touch 事件跟踪：浏览器接手横划时 pointer 事件会被 cancel，touch 事件照样送达；Arena 的对话区是 overscroll-contain，横划不会带动别的东西，
    // 所以不改页面的 touch-action。第二根手指按下、系统接管（touchcancel）、按住超过 0.45 秒才动（长按选字）都当放弃，预览面板弹回。
    // 对话区自己能横向滚动时（内容被撑宽），只有滚到最右边了才接左划。
    let wsSw=null;
    function wsSwOn(){return prefs.wsSwipe!==false&&wsRightOn();}
    const wsSwSkip=(t,log)=>{for(let n=t;n&&n!==document.body;n=n.parentElement){if(n.matches?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),pre,[data-noswipe],[role="slider"],[draggable="true"]'))return true;if(n.scrollWidth>n.clientWidth+2){const ox=getComputedStyle(n).overflowX;if((ox==='auto'||ox==='scroll')&&(n!==log||n.scrollLeft<n.scrollWidth-n.clientWidth-2))return true;}if(n===log)break;}return false;};
    const wsSwTouch=(e,s)=>[...(e.changedTouches||[])].find(t=>t.identifier===s.tid);
    function wsSwEnd(e,ok){const s=wsSw;wsSw=null;if(!s||s.mode!=='pull')return;if(wsDrag===s)wsDrag=null;wsHost.removeAttribute('data-drag');
      const p=e&&wsSwTouch(e,s),x=p?p.clientX:s.lx,dx=s.x-x,now=performance.now(),ref=s.hs.find(h=>now-h[0]<=120)||s.hs.at(-1),v=ref?(ref[1]-x)/Math.max(16,now-ref[0]):0;
      if(ok&&(dx>=WS_OPEN||dx>=28&&v>0.35))wsOpen();else wsPull(0,true);}
    document.addEventListener('touchstart',e=>{
      if(wsSw){if(wsSw.mode==='pull')wsSwEnd(null,false);else wsSw=null;}
      if(e.touches.length!==1||!wsSwOn()||wsDrag||!wsBtn?.isConnected||wsOff(wsBtn)||!wsHost.isConnected||wsHost.hasAttribute('data-go')||wsBusy(wsBtn))return;
      const t=e.target,log=t?.closest?.('main [role="log"]');if(!log||wsSwSkip(t,log))return;
      const p=e.touches[0];wsSw={sw:1,id:'sw',tid:p.identifier,x:p.clientX,y:p.clientY,lx:p.clientX,mode:'',hs:[[performance.now(),p.clientX]]};
    },{capture:true,passive:true});
    document.addEventListener('touchmove',e=>{const s=wsSw;if(!s)return;const p=wsSwTouch(e,s);if(!p)return;const dx=s.x-p.clientX,dy=p.clientY-s.y;s.lx=p.clientX;
      if(!s.mode){if(Math.abs(dx)<10&&Math.abs(dy)<10)return;if(dx>=10&&dx>=Math.abs(dy)*2&&performance.now()-s.hs[0][0]<450&&!wsDrag&&!wsHost.hasAttribute('data-go')){s.mode='pull';wsDrag=s;wsHost.setAttribute('data-drag','pull');try{getSelection()?.removeAllRanges();}catch{}}else{wsSw=null;return;}}
      s.hs.push([performance.now(),p.clientX]);if(s.hs.length>10)s.hs.shift();wsPull(Math.max(0,dx));
    },{capture:true,passive:true});
    document.addEventListener('touchend',e=>{if(wsSw&&wsSwTouch(e,wsSw))wsSwEnd(e,true);},{capture:true,passive:true});
    document.addEventListener('touchcancel',e=>{if(wsSw&&wsSwTouch(e,wsSw))wsSwEnd(e,false);},{capture:true,passive:true});
    document.addEventListener('focusin',()=>{wsScan();if(wsHost.isConnected)wsSync();},true);addEventListener('resize',()=>setTimeout(wsSync,80),{passive:true});document.addEventListener('focusout',()=>{if(wsHost.isConnected)setTimeout(wsSync,0);},true);
    const drawerMo=new MutationObserver(()=>requestAnimationFrame(syncMode));let drawerMoOn=false;
    const panel=el('section','panel',null,root),resizer=el('div','resizer',null,panel);resizer.title='拖动调整宽度，双击恢复';const sheetGrip=el('div','sheet-grip',null,panel);el('i','',null,sheetGrip);sheetGrip.title='上下拖动调整高度（对话像输入法弹出时一样被顶上去，不会被盖住），停在哪都可以：顶到最上面全屏，拉到最底收起；轻点切换全屏';
    dragger(resizer,{start:e=>({x:e.clientX,width:host.getBoundingClientRect().width}),move:(e,s)=>{const w=clamp(s.width+(s.x-e.clientX),280,Math.max(280,Math.min(720,innerWidth-480)),prefs.width);host.style.setProperty('--amp-width',w+'px');prefs.width=w;},end:()=>{savePrefs();paint();},reset:()=>{prefs.width=340;host.style.setProperty('--amp-width','340px');savePrefs();paint();}});
    const grip=el('div','grip',null,gripRoot);grip.hidden=true;grip.title='拖动调整 Arena 会话栏宽度，双击恢复';
    dragger(grip,{start:e=>{const sb=findSidebar();if(!sb?.panel)return null;return {x:e.clientX,width:sidebarWidth(sb)};},move:(e,s)=>{const w=clamp(s.width+(e.clientX-s.x),200,Math.max(200,Math.min(560,innerWidth-640)),s.width);prefs.sidebarWidth=w;applySidebar(w);placeGrip();},end:()=>{savePrefs();log('debug','侧栏','Arena 会话栏宽度 '+prefs.sidebarWidth+'px');paint();},reset:()=>{prefs.sidebarWidth=null;applySidebar(null);savePrefs();placeGrip();},tap:e=>forwardTap(grip,e)});
    function placeGrip(){const sb=innerWidth>=768?applySidebar(prefs.sidebarWidth):null,panelEl=sb?.panel;if(!panelEl||sb.peer&&sb.peer.dataset.state&&sb.peer.dataset.state!=='expanded'){grip.hidden=true;return;}const rect=panelEl.getBoundingClientRect();if(rect.width<120||rect.height<100){grip.hidden=true;return;}grip.hidden=false;grip.style.left=(rect.right-3)+'px';grip.style.top=rect.top+'px';grip.style.height=rect.height+'px';}
    const compactBar=el('div','compact-bar',null,panel),compactTop=el('div','compact-top',null,compactBar),compactName=el('span','compact-name mono','模型信息',compactTop);
    {const eb=button(compactTop,'','导出当前页的记录',()=>void exportView(),'sheet-btn');icon('download',eb);}
    const compactToggle=button(compactTop,'','收起模型信息',()=>{expanded=false;render();},'sheet-btn');icon('close',compactToggle);
    const compactInfo=el('div','compact-info','',compactBar),compactText=el('span','ci-text','',compactInfo),compactChip=button(compactInfo,'','说明',()=>say(chipWhy(),4200),'chip');compactChip.hidden=true;
    // 手机底部抽屉：顶部把手（和标题行）上下拖动调高度，松手停在哪就是哪（不吸附）；顶到最上面 = 全屏，拉到最底 = 收起；轻点把手切换全屏。高度按屏幕比例记住。
    // v1.11.78 不再浮在页面上盖住输入框：始终在页面里占位，再高就把整页往上推（见 applySheet 上面的说明）。
    const SHEET_MIN=96,SHEET_CLOSE=72;
    const sheetAvail=()=>Math.max(260,(window.innerHeight||640)-(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--amp-bar-h'))||0));
    // 不全屏时抽屉在页面里占位，至少给上面留出顶栏 + 输入框 + 一小段对话
    function sheetInflowMax(){const avail=sheetAvail();let need=220;try{const m=document.querySelector('main'),ed=m&&[...m.querySelectorAll('div[contenteditable="true"],textarea')].filter(x=>!x.closest('[role="log"]')&&x.getClientRects().length).pop();if(ed){let c=ed;for(let i=0;i<7&&c.parentElement&&c.parentElement!==m;i++){const cs=getComputedStyle(c);if(parseFloat(cs.borderTopWidth)>=1&&parseFloat(cs.borderTopLeftRadius)>=8)break;c=c.parentElement;}need=Math.max(need,c.getBoundingClientRect().height+130);}}catch{}return Math.round(Math.max(SHEET_MIN,Math.min(avail-need,avail*0.8)));}
    // v1.11.78 抽屉像输入法一样把对话“顶上去”，不再盖住：抽屉始终在页面里占位（main 的最后一块），对话区跟着变矮，
    // 滚动位置同步补上被压掉的高度（贴底的继续贴底），最新内容始终紧挨在输入框 / 抽屉上方；抽屉高到放不下“顶栏 + 输入框 + 一小段对话”时，
    // 整页继续往上推（顶栏先被推出屏幕），输入框始终贴在抽屉上沿。只有“全屏”才整个盖住页面。拖动时每一帧都这样跟手。
    let shiftEl=null,sheetSig='';
    const sheetWrap=()=>{const m=host.parentElement;if(!m||m.tagName!=='MAIN')return null;for(const c of m.children){if(c===host)continue;const cs=getComputedStyle(c);if(cs.display==='none'||cs.position==='absolute'||cs.position==='fixed')continue;return c;}return null;};
    const composerBox=()=>{try{const m=host.parentElement,ed=m&&[...m.querySelectorAll('div[contenteditable="true"],textarea')].filter(x=>!x.closest('[role="log"]')&&x.getClientRects().length).pop();if(!ed)return null;let c=ed;for(let i=0;i<7&&c.parentElement&&c.parentElement!==m;i++){const cs=getComputedStyle(c);if(parseFloat(cs.borderTopWidth)>=1&&parseFloat(cs.borderTopLeftRadius)>=8)break;c=c.parentElement;}return c;}catch{return null;}};
    function sheetShift(h,max){const w=compact&&h>0?sheetWrap():null;let x=w&&max>0?Math.max(0,Math.round(h-max)):0;
      const put=v=>{if(shiftEl&&shiftEl!==w){shiftEl.style.removeProperty('margin-top');shiftEl=null;}if(!w)return;if(v>0){const s=(-v)+'px';if(w.style.getPropertyValue('margin-top')!==s)w.style.setProperty('margin-top',s,'important');shiftEl=w;}else if(shiftEl===w){w.style.removeProperty('margin-top');shiftEl=null;}};
      put(x);if(!w)return;
      // 输入框不在底部、而是居中的页面（新对话页）：按上面算的推完输入框仍被抽屉挡住，就再往上推到它露出来（居中布局推 2 倍才移动 1 倍，最多再试两次）
      const cb=composerBox();if(!cb)return;const top=host.getBoundingClientRect().top;
      for(let i=0;i<2;i++){const over=Math.round(cb.getBoundingClientRect().bottom-(top-6));if(over<=1)break;x=Math.min(Math.round(h),x+over*(i?2:1));put(x);}}
    const chatSc=()=>{let s=null;try{s=errReload.findScroller?.();}catch{}if(s?.isConnected&&s.closest('main'))return s;const l=[...document.querySelectorAll('main [role="log"]')].find(e=>e.getClientRects().length);for(let e=l;e&&e.tagName!=='MAIN'&&e!==document.body;e=e.parentElement){const oy=getComputedStyle(e).overflowY;if(oy==='auto'||oy==='scroll'||oy==='overlay')return e;}return null;};
    function sheetAnchor(fn){const sc=compact?chatSc():null,b=sc?sc.clientHeight:0,st=sc?sc.scrollTop:0,gap=sc?sc.scrollHeight-st-b:0;fn();if(!sc||!sc.isConnected)return;const d=b-sc.clientHeight;if(!d)return;sc._ampAnchorAt=Date.now();sc.scrollTop=gap<2?sc.scrollHeight:Math.max(0,st+d);}
    function applySheet(){if(!compact||!expanded||host.hidden){host.removeAttribute('data-full');host.removeAttribute('data-float');sheetShift(0);return;}if(host.hasAttribute('data-dragging'))return;const full=!!prefs.sheetFull;host.toggleAttribute('data-full',full);host.removeAttribute('data-float');if(full){sheetShift(0);return;}const avail=sheetAvail(),h=Math.round(Math.max(SHEET_MIN,Math.min(avail-8,prefs.sheetH*avail)));const v=h+'px';if(host.style.getPropertyValue('--amp-sheet-h')!==v)host.style.setProperty('--amp-sheet-h',v);sheetShift(h,sheetInflowMax());}
    {let drag=null;
      const down=e=>{if(!compact||!expanded||drag||e.button>0||e.target.closest?.('button,select,input,textarea,a'))return;drag={id:e.pointerId,el:e.currentTarget,y:e.clientY,h:host.getBoundingClientRect().height,moved:false,pts:[[e.clientY,e.timeStamp]]};try{drag.el.setPointerCapture(e.pointerId);}catch{}};
      const move=e=>{if(!drag||e.pointerId!==drag.id)return;const dy=drag.y-e.clientY;if(!drag.moved){if(Math.abs(dy)<5)return;drag.moved=true;drag.max=sheetInflowMax();drag.avail=sheetAvail();host.setAttribute('data-dragging','');}
        const h=Math.max(40,Math.min(drag.avail,drag.h+dy));drag.cur=h;drag.pts.push([e.clientY,e.timeStamp]);if(drag.pts.length>5)drag.pts.shift();sheetAnchor(()=>{host.removeAttribute('data-full');host.removeAttribute('data-float');host.style.setProperty('--amp-sheet-h',Math.round(h)+'px');sheetShift(h,drag.max);});if(e.cancelable)e.preventDefault();};
      const up=e=>{if(!drag||e.pointerId!==drag.id)return;const d=drag;drag=null;try{d.el.releasePointerCapture(e.pointerId);}catch{}host.removeAttribute('data-dragging');
        if(!d.moved){if(d.el===sheetGrip&&e.type==='pointerup'){prefs.sheetFull=!prefs.sheetFull;savePrefs();sheetAnchor(applySheet);}return;}
        const h=d.cur;  // 随停：不看甩动速度、不吸附
        host.removeAttribute('data-float');
        if(h<SHEET_CLOSE){expanded=false;render();return;}
        if(h>=d.avail-8)prefs.sheetFull=true;
        else{prefs.sheetFull=false;prefs.sheetH=Math.min(1,Math.max(SHEET_MIN,h)/d.avail);}
        savePrefs();sheetAnchor(applySheet);};
      for(const hd of [sheetGrip,compactBar]){hd.addEventListener('pointerdown',down);hd.addEventListener('pointermove',move);hd.addEventListener('pointerup',up);hd.addEventListener('pointercancel',up);}
    }
    const head=el('header','head',null,panel),heading=el('div','grow',null,head);el('h2','','模型信息',heading);const numberLabel=el('span','local-number mono','',heading);numberLabel.title='本地会话编号（同一浏览器内统一递增）';
    const headChip=button(heading,'','说明',()=>say(chipWhy(),4200),'chip');headChip.hidden=true;{const eb=button(heading,'','导出当前页的记录',()=>void exportView(),'sheet-btn head-export');icon('download',eb);const hb=button(head,'','收起模型信息（收起后点屏幕右边缘的小按钮展开）',()=>{pref.open=false;persist();render();},'head-fold');el('span','','收起',hb);icon('chevron',hb);}
    const banner=el('div','cache-banner',null,panel),bannerText=el('span','grow','',banner);button(banner,'返回当前','返回当前会话的最新记录',()=>{historyView=null;turnKey=null;selected=null;rawSpan=null;tab=tab==='cache'?'overview':tab;render();},'return-live');
    const nav=el('div','tabs',null,panel);nav.setAttribute('role','tablist');nav.setAttribute('aria-label','模型信息视图');
    // 一级标签一屏放得下：来源 + 原始 合成“数据”，缓存 + 日志 合成“记录”（页内再切）；版本与更新单独放“关于”
    const tabs=[['overview','概览'],['detector','监控'],['hunt','抽卡'],['sources','来源'],['raw','原始'],['cache','缓存'],['logs','日志'],['settings','设置'],['about','关于']];
    const groups=[['overview','概览',['overview']],['detector','监控',['detector']],['hunt','抽卡',['hunt']],['data','数据',['sources','raw']],['records','记录',['cache','logs']],['settings','设置',['settings']],['about','关于',['about']]];
    const groupOf=t=>groups.find(g=>g[2].includes(t))||groups[0],groupLast={};
    const tabButtons=groups.map(([gid,text,leaves])=>{const b=button(nav,text,text,()=>{tab=leaves.includes(groupLast[gid])?groupLast[gid]:leaves[0];render();},'tab');b.setAttribute('role','tab');b.id='amp-tab-'+gid;return b;});
    nav.onkeydown=e=>{let i=groups.indexOf(groupOf(tab));if(e.key==='ArrowRight')i=(i+1)%groups.length;else if(e.key==='ArrowLeft')i=(i+groups.length-1)%groups.length;else if(e.key==='Home')i=0;else if(e.key==='End')i=groups.length-1;else return;e.preventDefault();tabButtons[i].click();tabButtons[i].focus();};
    const subnav=el('div','subtabs',null,panel);subnav.setAttribute('role','group');subnav.hidden=true;let subStamp='';
    const status=el('div','status',null,panel);status.setAttribute('aria-live','polite');
    const pickers=el('div','pickers',null,panel);
    const turnPicker=el('label','call-picker',null,pickers);el('span','','轮次',turnPicker);const turnSelect=el('select','selector',null,turnPicker);turnSelect.setAttribute('aria-label','选择轮次');turnSelect.onchange=()=>{const live=liveKey();turnKey=turnSelect.value===live?null:turnSelect.value;selected=null;rawSpan=null;render();};
    const picker=el('label','call-picker',null,pickers);el('span','','调用',picker);const select=el('select','selector',null,picker);select.setAttribute('aria-label','选择调用');select.onchange=()=>{selected=select.value;rawSpan=null;render();};
    const logBar=el('div','logbar',null,panel),controls=el('div','log-controls',null,logBar);el('h3','','日志详细程度',controls);const level=el('select','selector',null,controls);level.setAttribute('aria-label','日志详细程度');for(const [id,text]of [['info','普通'],['detail','详细'],['debug','调试']]){const o=el('option','',text,level);o.value=id;}level.value=pref.level;level.onchange=()=>{pref.level=level.value;persist();bodyStamp=[];render();};
    const actions=el('div','log-actions',null,logBar),read=button(actions,'重读记录','重新读取当前运行记录',refresh);const clearLogs=button(actions,'清理日志','清理全部本地日志（不影响编号与缓存）',async()=>{if(!confirmLogClear){confirmLogClear=true;render();return;}await catalog.clearLogs();confirmLogClear=false;logKey='';bodyStamp=[];render();}),cancelClear=button(actions,'取消','取消清理日志',()=>{confirmLogClear=false;render();});
    const body=el('div','body',null,panel);
    // 左右滑动切换页面（触屏）：横向位移 > 56px 且明显大于纵向；从可横向滚动的元素、输入框里开始的手势不处理
    {let sw=null;const skip=t=>{for(let n=t;n&&n!==body;n=n.parentElement){if(n.matches?.('input,textarea,select,[contenteditable],[data-noswipe],pre'))return true;if(n.scrollWidth>n.clientWidth+4&&/(auto|scroll)/.test(getComputedStyle(n).overflowX))return true;}return false;};
      const reset=()=>{body.style.transition='transform .2s ease,opacity .2s ease';body.style.transform='';body.style.opacity='';setTimeout(()=>{body.style.transition='';},220);};
      body.addEventListener('touchstart',e=>{if(e.touches.length!==1||skip(e.target)){sw=null;return;}const p=e.touches[0];sw={x:p.clientX,y:p.clientY,t:Date.now(),lock:null,dx:0};},{passive:true});
      body.addEventListener('touchmove',e=>{if(!sw)return;const p=e.touches[0],dx=p.clientX-sw.x,dy=p.clientY-sw.y;if(sw.lock===null&&Math.hypot(dx,dy)>10)sw.lock=Math.abs(dx)>Math.abs(dy)*1.3?'x':'y';if(sw.lock!=='x')return;const i=groups.indexOf(groupOf(tab)),edge=dx>0&&i===0||dx<0&&i===groups.length-1;sw.dx=dx;body.style.transform='translateX('+(dx*(edge?0.12:0.3)).toFixed(1)+'px)';body.style.opacity=String(1-Math.min(0.3,Math.abs(dx)/700));},{passive:true});
      body.addEventListener('touchend',()=>{const g=sw;sw=null;if(!g)return;if(g.lock!=='x'){reset();return;}const i=groups.indexOf(groupOf(tab)),j=i+(g.dx<0?1:-1);if(Math.abs(g.dx)<56||Math.abs(g.dx)<90&&Date.now()-g.t>700||j<0||j>=groups.length){reset();return;}
        body.style.transition='';body.style.transform='';body.style.opacity='';tabButtons[j].click();body.classList.remove('slide-l','slide-r');void body.offsetWidth;body.classList.add(g.dx<0?'slide-l':'slide-r');try{tabButtons[j].scrollIntoView({inline:'center',block:'nearest'});}catch{}},{passive:true});
      body.addEventListener('touchcancel',()=>{if(sw){sw=null;reset();}},{passive:true});
      body.addEventListener('animationend',e=>{if(e.target===body)body.classList.remove('slide-l','slide-r');});}body.setAttribute('role','tabpanel');
    const toast=el('div','toast','',panel);toast.hidden=true;toast.setAttribute('role','status');
    // 版本 / 更新 / 正式版·测试版入口：原来挤在底部，现在放“关于”页（节点常驻，切到“关于”时挂进页面）
    const aboutBox=el('div','upds about-upds');let aboutChannel='';
    async function exportView(){if(tab==='hunt'){download(gacha.state()||{},'arena-gacha-'+Date.now()+'.json');return;}if(tab==='detector'){download({...legacyDisplay.snapshot(),oneClick:force.bySid.get(sidOf(location.href))||null},'arena-independent-detector-'+Date.now()+'.json');return;}const data=exported();data.logs=await catalog.readLogs(data.sid);download(data,'amp-lite-'+(data.sid||'export').slice(0,8)+'-'+Date.now()+'.json');}
    ;(()=>{const cmp=(x,y)=>{const p=String(x).split('.').map(Number),q=String(y).split('.').map(Number);for(let i=0;i<Math.max(p.length,q.length);i++){const d=(p[i]||0)-(q[i]||0);if(d)return d>0?1:-1;}return 0;};const box=aboutBox;const BASE='https://raw.githubusercontent.com/755287249/-/main/test/';const mk=(label,file,getCur)=>{const RAW=BASE+file,CK='amp.native.upd.'+file;let latest=null,busy=false,fresh=null;const ub=el('button','footer-note upd','',box);ub.type='button';ub.dataset.self='1';const paint=(msg)=>{const cur=getCur();ub.dataset.new=cur&&latest&&cmp(latest,cur)>0?'1':'';ub.dataset.miss=cur?'':'1';ub.title=(cur?label+' 当前 v'+cur:label+' 未检测到（未安装或未启用）')+(latest?'，GitHub 最新 v'+latest+(ub.dataset.src?'（'+ub.dataset.src+'）':''):'')+'。点击'+(ub.dataset.new||!cur?'打开安装页':'重新检查');const old=!cur&&file.includes('Switch')&&!!document.querySelector('[data-amp-switch],[data-amp-login],[data-amp-switcher],#amp-switcher-css');const ahead=cur&&latest&&cmp(cur,latest)>0;ub.textContent=label+' '+(msg||(!cur?(old?'旧版（≤1.0.17）· 安装 v'+(latest||'新版'):latest?'未检测到 · 安装 v'+latest:'未检测到 · 安装'):ub.dataset.new?'v'+cur+' → v'+latest+' · 更新':ahead?'v'+cur+' · GitHub 仍是 v'+latest:latest?'v'+cur+' · 已是最新':'v'+cur+' · 检查更新'));if(!cur&&!msg)ub.title=label+' 未检测到版本号：可能是 v1.0.17 及更早的版本（不会上报版本），或未安装/未启用。安装最新版后即可显示。'+(latest?'GitHub 最新 v'+latest+'。':'');if(ahead&&!msg)ub.title=label+' 本地 v'+cur+' 比 GitHub 上的 v'+latest+' 新，请把新版上传到 GitHub。';};const check=async(force)=>{if(busy)return;try{const c=JSON.parse(localStorage.getItem(CK)||'null');if(!force&&c&&Date.now()-c.at<5*60e3&&!(getCur()&&cmp(getCur(),c.v)>0)){latest=c.v;paint();return;}}catch{}busy=true;paint('检查中…');try{const F=window.__ampNativeFetch||fetch,vOf=t=>(String(t).match(/\/\/\s*@version\s+([\d.]+)/)||[])[1]||null,errs=[];let best=null,src='';const take=(v,from)=>{if(v&&(!best||cmp(v,best)>0)){best=v;src=from;}};
          // 1) GitHub API 查这个文件最新提交的 sha，再按 sha 取原文（路径唯一，不会被 CDN/镜像缓存）；2) 兜底直接取 main
          try{const c=await F.call(window,'https://api.github.com/repos/755287249/-/commits?sha=main&per_page=1&path='+encodeURIComponent((/\/test\/$/.test(BASE)?'test/':'')+file),{cache:'no-store',credentials:'omit'});if(!c.ok)throw new Error('API HTTP '+c.status);const sha=(await c.json())?.[0]?.sha;if(!sha)throw new Error('API 无提交');const r=await F.call(window,BASE.replace('/main/','/'+sha+'/')+file,{cache:'no-store',credentials:'omit',headers:{Range:'bytes=0-4095'}});if(!r.ok)throw new Error('sha HTTP '+r.status);take(vOf(await r.text()),'commit '+sha.slice(0,7));fresh=BASE.replace('/main/','/'+sha+'/')+file;}catch(e){errs.push(e.message||String(e));}
          try{const r=await F.call(window,RAW+'?t='+Date.now(),{cache:'no-store',credentials:'omit',headers:{Range:'bytes=0-4095'}});if(!r.ok)throw new Error('raw HTTP '+r.status);take(vOf(await r.text()),'raw');}catch(e){errs.push(e.message||String(e));}
          if(!best)throw new Error(errs.join('；')||'未找到版本号');latest=best;ub.dataset.src=src;try{localStorage.setItem(CK,JSON.stringify({v:latest,at:Date.now()}));}catch{}busy=false;paint();const cu=getCur();if(cu&&cmp(cu,latest)>0&&(check.n=(check.n||0)+1)<=8)setTimeout(()=>void check(true),120e3);}catch(e){busy=false;paint('检查失败 · 重试');ub.title=String(e&&e.message||e);}};ub.onclick=()=>{if(busy)return;const cur=getCur();if(!cur||latest&&cmp(latest,cur)>0){window.open(fresh||RAW,'_blank');paint('请在新标签页确认安装');try{localStorage.removeItem(CK);}catch{}return;}void check(true);};paint();setTimeout(()=>void check(false),1500);return paint;};mk('套件','Arena-Native-Suite.user.js',()=>String(VERSION).replace(/^native-/,''));const sw=mk('账号切换','Arena-Account-Switch.user.js',()=>document.documentElement.dataset.ampSwitchVer||'');      // 测试版入口：正式版里输入密码后显示测试版的安装 / 更新；测试版里显示“正式版入口”（切回正式版，无需密码）。
      // 地址都由 BASE 推出来，发布时替换链接不会影响这里。脚本里只存密码的 SHA-256，不存明文。
      const IS_TEST=/\/test\/$/.test(BASE),CH_BASE=IS_TEST?BASE.replace(/test\/$/,''):BASE+'test/',CH_NAME=IS_TEST?'正式版':'测试版',CH_KEY='amp.native.chan.unlock',CH_HASH='a17502877cfc09fdcfd1c868acc7fb61e1842bb02fd89ffca9451a507f9caa7c';aboutChannel=IS_TEST?'测试版':'正式版';
      const chPaints=[];let chLines=[],chForm=null;
      const chVer=t=>(String(t).match(/\/\/\s*@version\s+([\d.]+)/)||[])[1]||null;
      const chLatest=async file=>{const F=window.__ampNativeFetch||fetch,path=(IS_TEST?'':'test/')+file,errs=[];let best=null,fresh=null;
        try{const c=await F.call(window,'https://api.github.com/repos/755287249/-/commits?sha=main&per_page=1&path='+encodeURIComponent(path),{cache:'no-store',credentials:'omit'});if(!c.ok)throw new Error('API HTTP '+c.status);const sha=(await c.json())?.[0]?.sha;if(!sha)throw new Error('API 无提交');const u=CH_BASE.replace('/main/','/'+sha+'/')+file,r=await F.call(window,u,{cache:'no-store',credentials:'omit',headers:{Range:'bytes=0-4095'}});if(!r.ok)throw new Error('sha HTTP '+r.status);const v=chVer(await r.text());if(v){best=v;fresh=u;}}catch(e){errs.push(e.message||String(e));}
        try{const r=await F.call(window,CH_BASE+file+'?t='+Date.now(),{cache:'no-store',credentials:'omit',headers:{Range:'bytes=0-4095'}});if(!r.ok)throw new Error('raw HTTP '+r.status);const v=chVer(await r.text());if(v&&(!best||cmp(v,best)>0)){best=v;fresh=null;}}catch(e){errs.push(e.message||String(e));}
        if(!best)throw new Error(errs.join('；')||'未找到版本号');return {v:best,fresh};};
      const chLine=(label,file,getCur)=>{let latest=null,fresh=null,busy=false;const b=el('button','footer-note upd',null,box);b.type='button';
        const paint=msg=>{const cur=getCur(),newer=!!latest&&(!cur||cmp(latest,cur)>0),same=!!latest&&!!cur&&cmp(latest,cur)===0;b.dataset.new=newer&&!msg?'1':'';b.textContent=CH_NAME+' '+label+' '+(msg||(latest?'v'+latest+' · '+(newer?'安装':same?'版本相同':'安装（较旧）'):'检查中…'));if(!msg&&latest)b.title=CH_NAME+' '+label+' v'+latest+(cur?'（当前 v'+cur+'）':'')+'。点击打开安装页'+(same?'；版本号相同，安装后会改为跟随'+CH_NAME+'自动更新':'');};
        const check=async()=>{if(busy)return;busy=true;paint('检查中…');try{const r=await chLatest(file);latest=r.v;fresh=r.fresh;busy=false;paint();}catch(e){busy=false;paint('检查失败 · 重试');b.title=String(e&&e.message||e);}};
        b.onclick=()=>{if(busy)return;if(!latest){void check();return;}window.open(fresh||CH_BASE+file,'_blank');paint('请在新标签页确认安装');setTimeout(()=>{if(!busy)paint();},8000);};
        chPaints.push(()=>{if(!busy)paint();});void check();return b;};
      const chEntry=el('button','footer-note upd chentry','',box);chEntry.type='button';
      const chHide=relock=>{for(const b of chLines)b.remove();chLines=[];chPaints.length=0;chForm?.remove();chForm=null;if(relock){try{localStorage.removeItem(CH_KEY);}catch{}}chEntry.textContent=CH_NAME+'入口';chEntry.title=IS_TEST?'显示正式版的安装入口（用于切回正式版）':'输入密码后可安装 / 更新测试版';};
      const chShow=()=>{chHide(false);chLines=[chLine('套件','Arena-Native-Suite.user.js',()=>String(VERSION).replace(/^native-/,'')),chLine('账号切换','Arena-Account-Switch.user.js',()=>document.documentElement.dataset.ampSwitchVer||'')];box.append(chEntry);chEntry.textContent='收起'+CH_NAME;chEntry.title=IS_TEST?'隐藏正式版入口':'隐藏测试版入口（再次打开需要输入密码）';};
      const chAsk=()=>{if(chForm){chForm.remove();chForm=null;return;}chForm=el('div','chform',null,box);const inp=el('input','',null,chForm);inp.type='password';inp.placeholder='测试版密码';inp.autocomplete='off';inp.spellcheck=false;
        const submit=async()=>{const v=inp.value;if(!v){inp.focus();return;}let h='';try{const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));h=[...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('');}catch{}if(h===CH_HASH){try{localStorage.setItem(CH_KEY,'1');}catch{}chShow();}else{inp.value='';inp.placeholder=h?'密码不对':'浏览器不支持验证';inp.removeAttribute('data-bad');void inp.offsetWidth;inp.setAttribute('data-bad','');inp.focus();}};
        button(chForm,'确定','验证密码',()=>void submit());
        for(const t of ['keydown','keyup','keypress','input'])inp.addEventListener(t,e=>{e.stopPropagation();if(t!=='keydown')return;if(e.key==='Enter'){e.preventDefault();void submit();}else if(e.key==='Escape'){e.preventDefault();chForm?.remove();chForm=null;}});
        setTimeout(()=>inp.focus(),0);};
      chEntry.onclick=()=>{if(chLines.length){chHide(!IS_TEST);return;}let ok=IS_TEST;try{ok=ok||localStorage.getItem(CH_KEY)==='1';}catch{}if(ok)chShow();else chAsk();};
      chHide(false);try{if(!IS_TEST&&localStorage.getItem(CH_KEY)==='1')chShow();}catch{}
      try{const mo=new MutationObserver(()=>{sw();chPaints.forEach(f=>f());});mo.observe(document.documentElement,{attributes:true,attributeFilter:['data-amp-switch-ver']});}catch{}})();
    // 有新版本时“关于”标签上亮一个小点
    const aboutDot=()=>{const i=groups.findIndex(g=>g[0]==='about');if(tabButtons[i])tabButtons[i].toggleAttribute('data-dot',!!aboutBox.querySelector('.upd[data-self][data-new="1"]'));};try{new MutationObserver(aboutDot).observe(aboutBox,{subtree:true,childList:true,attributes:true,attributeFilter:['data-new']});}catch{}aboutDot();
    const fmt=v=>v===null||v===undefined?'—':Number(v).toLocaleString('zh-CN');
    const clock=v=>{const t=typeof v==='number'?v:Date.parse(v||'');return Number.isFinite(t)?new Date(t).toLocaleTimeString('zh-CN',{hour12:false}):'--:--:--';};
    const seqLabel=sid=>{const e=catalog.entries.get(sid);return e?(e.temporary?'临时 ':'')+'#'+e.seq:'';};
    const say=(text,ms=2000)=>{toast.textContent=text;toast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.hidden=true;},ms);};
    const liveView=sid=>selectedRun()?.data||catalog.snapshots.get(sid)||history.find(s=>s.sid===sid)||null;
    const liveKey=()=>liveView(sidOf(location.href))?.key||null;
    const view=()=>{if(historyView)return historyView;const sid=sidOf(location.href);if(turnKey){const r=selectedRun();if(r?.data?.key===turnKey)return r.data;const t=catalog.turnCache.get(turnKey);if(t)return t;void catalog.getTurn(turnKey).then(()=>paint());return null;}return liveView(sid);};
    const turnTitle=(t,current)=>turnLabel(t)+' · '+clock(t.startedAt||t.at)+(t.prompt?' · “'+t.prompt+'”':'')+(current?' · 当前':'');
    function row(parent,key,value,mono=true){const r=el('div','row',null,parent);el('span','key',key,r);el('span','value'+(mono?' mono':''),value??'未提供',r);return r;}
    function empty(title,description){const box=el('div','empty',null,body);icon('cube',el('div','empty-icon',null,box));el('strong','',title,box);el('p','',description,box);}
    // 说明文字默认收起：标题旁的 ⓘ 点一下展开、再点收起（展开状态记住，重绘不丢）
    const openInfo=new Set();
    function info(anchor,key,text,after){if(!text||!anchor)return null;const on=openInfo.has(key),b=el('button','info-btn',null,anchor);b.type='button';b.title='说明';b.setAttribute('aria-label','说明');b.setAttribute('aria-expanded',String(on));b.dataset.focus='i:'+key;icon('info',b);const p=el('div','info-text',String(text));p.hidden=!on;let ref=after||anchor;while(ref.nextElementSibling&&ref.nextElementSibling.classList.contains('info-text'))ref=ref.nextElementSibling;ref.after(p);b.onclick=e=>{e.preventDefault();e.stopPropagation();const next=!openInfo.has(key);if(next)openInfo.add(key);else openInfo.delete(key);p.hidden=!next;b.setAttribute('aria-expanded',String(next));};return b;}
    function chipWhy(){return selectedRun()?.data?'上次记录：本轮还没读到新数据，显示的是上一次读取的结果（非本轮结论）。发送新消息后自动更新。':'本地缓存：这个页面还没读到本轮记录，显示的是本机保存的缓存（非本轮结论）。发送新消息后自动更新。';}
    async function copy(text,what='型号'){try{await navigator.clipboard.writeText(String(text));say('已复制'+what);}catch{say('复制不可用，请手动选中复制');}}
    function restoreMark(a,m){m.span.removeAttribute('data-amp-local-title');m.span.removeAttribute('data-amp-short');if(m.tip!==undefined){if(m.tip===null)a.removeAttribute('title');else a.setAttribute('title',m.tip);}if(m.description===null)a.removeAttribute('aria-description');else a.setAttribute('aria-description',m.description);}
    // 自定义/代号型号（如 dxzui）本身看不出厂商：若响应型号/内部名已识别出厂商，就显示成 dxzui-Claude。
    // 显示完整识别型号：dxzui + claude-opus-5-5 → dxzui-claude-opus-5-5（内部名优先，其次响应型号）。
    function modelOf(sid,record){if(record?.vmodel)return record.vmodel;const snap=catalog.snapshots.get(sid)||(sid===sidOf(location.href)?liveView(sid):null);if(!snap)return '';const c=[...servingCalls(snap)].reverse().find(c=>brand.of(c.internal)||brand.of(c.response));return c?(brand.of(c.internal)?c.internal:c.response):((snap.internalNames||[]).find(n=>brand.of(n))||'');}
    function withVendor(sid,record,name){name=String(name||'');if(!name||brand.of(name))return name;
      // dxzui / clzui 请求名：不再有特殊地位，只作为短前缀 dx- / cl- 加上识别到的模型（去厂商名）：dx-opus-5.5
      const zp=name.match(/^(dx|cl)zui\b/i);if(zp){const m=modelOf(sid,record);if(m&&brand.of(m))return zp[1].toLowerCase()+'-'+brand.short(m).replace(/(^|-)(\d{1,2})-(\d{1,2})(?=$|-)/,'$1$2.$3');return zp[1].toLowerCase()+'zui';}const m=modelOf(sid,record);if(m&&brand.of(m)&&!name.includes(m))return name+'-'+m;const v=record?.vendor;return v&&brand.NAME[v]?name+'-'+brand.NAME[v].toLowerCase():name;}
    // 左侧卡片已有厂商图标：文字去掉厂商/系列前缀（gpt-6-luna-max → 6-luna-max，kimi-k3 → K3），悬停显示全称
    function shortModel(n){n=String(n||'');if(!brand.of(n))return n;const m=n.match(/^(?:[\w.-]+\/)?(?:gpt|chatgpt|claude|gemini|grok|kimi|qwen|deepseek|mimo|glm|llama|mistral|doubao|minimax)[-_ ]+(.+)$/i);let r=m?m[1]:(n.match(/^[\w.-]+\/(.+)$/)||[])[1];if(!r||!/[\w]/.test(r))return n;if(/^k\d/.test(r))r='K'+r.slice(1);return r;}
    let titleSyncRaf=0;window.addEventListener('amp-title-sync',()=>{if(titleSyncRaf)return;titleSyncRaf=requestAnimationFrame(()=>{titleSyncRaf=0;try{localTitles();}catch{}try{headerTitle();}catch{}try{window.dispatchEvent(new CustomEvent('amp-native-gacha'));}catch{}try{if(gacha.running())paint();}catch{}});});
    const ltMemo=new WeakMap();
    function localTitles(){
      if(!catalog.persistent||document.readyState!=='complete')return;
      for(const [a,m]of marks){if(!a.isConnected||!m.span.isConnected||a.querySelector('input,textarea,[contenteditable="true"]')){restoreMark(a,m);marks.delete(a);ltMemo.delete(a);}}
      let count=0;
      for(const a of document.querySelectorAll('a[href*="/agent/"]')){
        if(!a.closest('aside,nav,[data-sidebar]')||a.querySelector('input,textarea,[contenteditable="true"]'))continue;
        const hm=/^(?:https:\/\/arena\.ai)?\/agent\/([\w-]{1,128})\/?(?:[?#].*)?$/.exec(a.getAttribute('href')||'');if(!hm)continue;
        const sid=hm[1],own=gacha.ownsTitle(sid),record=own?null:catalog.entries.get(sid);if(record?.temporary){const old=marks.get(a);if(old){restoreMark(a,old);marks.delete(a);}continue;}
        const pr0=a.querySelector('span.truncate,div.truncate'),memoKey=(pr0?pr0.textContent:'')+'|'+(record?.title||'')+'|'+(record?.name?.name||'')+'|'+(own?gacha.pendingTitle(sid)||'':'')+'|'+prefs.showSeq+'|'+vip.rev+'|'+brand.hint.rev(),mm=ltMemo.get(a);
        if(pr0&&mm&&mm.key===memoKey&&mm.pr===pr0&&pr0.isConnected)continue;
        // v1.11.79 抽卡刚定名的卡片：老虎机三格都停下之后再换成新名字（揭晓前不透露）
        if(own&&gacha.pendingTitle(sid)&&(()=>{try{return !!gachaSlot.view(sid);}catch{return false;}})())continue;
        ltMemo.set(a,{key:memoKey,pr:pr0});
        const primary=a.querySelector('span.truncate,div.truncate'),candidates=[...a.querySelectorAll('span')].filter(s=>!s.querySelector('svg,input,button,span,div')&&!s.classList.contains('sr-only')&&s.textContent.trim());const span=primary&&!primary.querySelector('svg,input,button')?primary:candidates.sort((a,b)=>b.textContent.length-a.textContent.length)[0];if(!span||!span.textContent.trim())continue;
        // 默认不显示本地编号 #N（与原标题/进度条挤在一起不好读）；设置里可打开。
        const shownTitle=own&&gacha.pendingTitle(sid)?gacha.pendingTitle(sid):record?.title?withVendor(sid,record,prefs.showSeq?record.title:(record.name?.name||String(record.title).replace(/^#\d+\s*/,''))||record.title):span.textContent.trim();
        const short=shortModel(noVertex(shownTitle));
        if(!record?.title&&short===shownTitle&&shownTitle===span.textContent.trim()){const old=marks.get(a);if(old){restoreMark(a,old);marks.delete(a);}continue;}
        const old=marks.get(a);if(old&&old.span!==span){restoreMark(a,old);marks.delete(a);}if(!marks.has(a))marks.set(a,{span,description:a.getAttribute('aria-description'),tip:a.getAttribute('title')});
        if(span.getAttribute('data-amp-local-title')===shownTitle&&span.getAttribute('data-amp-short')===short)continue;
        span.setAttribute('data-amp-local-title',shownTitle);span.setAttribute('data-amp-short',short);a.setAttribute('aria-description','本地显示 '+shownTitle);
        if(short!==shownTitle)a.setAttribute('title',shownTitle);else{const m=marks.get(a);if(m.tip===null)a.removeAttribute('title');else a.setAttribute('title',m.tip);}count++;
      }
      if(count)log('debug','本地标题','更新 '+count+' 个会话标题的本地显示');
    }
    // 顶部对话名：左侧加厂商 logo；下方小字显示显式档位与 Token；颜色随识别进度 浅色→赭石褐（深色模式 灰→白），识别完成变绿并加粗。
    try{CSS.registerProperty({name:'--amp-hp',syntax:'<percentage>',inherits:false,initialValue:'0%'});}catch{}
    const hdrCSS='[data-amp-horig]{display:none!important}[data-amp-htitle]{max-width:min(52vw,420px)!important;--amp-h-from:#cfc8bd;--amp-h-to:#6a5e54;background-image:linear-gradient(90deg,var(--amp-h-to) 0,var(--amp-h-to) var(--amp-hp,0%),var(--amp-h-from) var(--amp-hp,0%),var(--amp-h-from) 100%);-webkit-background-clip:text;background-clip:text;color:transparent!important;-webkit-text-fill-color:transparent;transition:--amp-hp .6s cubic-bezier(.22,.9,.3,1),font-weight .2s ease;display:inline-block!important;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;line-height:1.2!important;vertical-align:middle}'
      +'[data-amp-htitle] *{color:inherit!important;-webkit-text-fill-color:transparent}'
      +'[data-amp-htitle][data-amp-hdark]{--amp-h-from:#6f7680;--amp-h-to:#ffffff}[data-amp-htitle][data-amp-hdone]{font-weight:700!important}'
      +'[data-amp-htitle]::after{content:attr(data-amp-hsub);display:block;font-size:10px;line-height:1.25;font-weight:400;color:hsl(var(--text-secondary,35 6% 45%));-webkit-text-fill-color:hsl(var(--text-secondary,35 6% 45%));background:none;overflow:hidden;text-overflow:ellipsis;animation:ampWork 1.4s ease-in-out infinite}[data-amp-htitle][data-amp-hsub=""]::after{display:none}@keyframes ampWork{50%{opacity:.45}}'
      +'[data-amp-htitle][data-amp-hfresh]::after{animation:ampFresh 8s ease forwards}@keyframes ampFresh{0%,85%{opacity:1}100%{opacity:0}}'
      +'[data-amp-hlogo]{display:inline-flex!important;align-items:center;justify-content:center;flex:none;width:18px;height:18px;border-radius:50%;background:#fff;color:#111;box-shadow:0 0 0 1px #0000001a;margin-right:6px;vertical-align:middle;animation:ampHLogo .3s ease-out both}[data-amp-hlogo] svg{width:12px;height:12px;color:#111;fill:currentColor}[data-amp-hlogo][data-full]{background:transparent;box-shadow:none}[data-amp-hlogo][data-full] svg{width:18px;height:18px}'
      +'[data-amp-htier]{display:inline-flex!important;align-items:center;flex:none;height:18px;padding:0 7px;margin-left:6px;border-radius:999px;font-size:11px;font-weight:600;line-height:1;vertical-align:middle;color:#6a5e54;background:#6a5e5414;box-shadow:inset 0 0 0 1px #6a5e5433;white-space:nowrap}[data-amp-htier][hidden]{display:none!important}[data-amp-htier][data-hi]{color:#fff;background:#6a5e54;box-shadow:none}'
      +'[data-amp-htier][data-amp-hdark]{color:#d8d3ca;background:#d8d3ca14;box-shadow:inset 0 0 0 1px #d8d3ca33}[data-amp-htier][data-amp-hdark][data-hi]{color:#262522;background:#d8d3ca}[data-amp-htier][data-pop]{animation:ampHLogo .3s cubic-bezier(.3,1.6,.5,1) both}[data-amp-hswap]{display:inline-flex!important;align-items:center;justify-content:center;flex:none;width:20px;height:20px;margin-left:5px;border-radius:50%;color:#fff;background:hsl(var(--syntax-yellow,48 92% 38%));vertical-align:middle;cursor:pointer;animation:ampHLogo .3s cubic-bezier(.3,1.6,.5,1) both}[data-amp-hswap][hidden]{display:none!important}[data-amp-hswap] svg{width:12px;height:12px}[data-amp-hswap][data-tone=suspect]{color:hsl(var(--syntax-yellow,48 92% 38%));background:transparent;box-shadow:inset 0 0 0 1.5px hsl(var(--syntax-yellow,48 92% 38%))}'
      +'[data-amp-htitle][data-amp-hstep]{animation:ampHStep .34s cubic-bezier(.3,1.45,.5,1) both}@keyframes ampHStep{from{opacity:.15;transform:translateY(-30%)}to{opacity:1;transform:none}}'
      +'@keyframes ampHLogo{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}@media (prefers-reduced-motion:reduce){[data-amp-htitle],[data-amp-hlogo]{transition:none!important;animation:none!important}}';
    el('style','',hdrCSS,document.head||document.body);
    let hdr={t:null,logo:null,name:null},hdrStart=new Map(),hdrFull=new Map(),hdrIdle=new Map();
    const isDark=()=>{const d=document.documentElement;return d.dataset.theme==='dark'||d.classList.contains('dark')||(!d.classList.contains('light')&&getComputedStyle(d).colorScheme==='dark');};
    function clearHeader(){hdr.t?.removeAttribute('data-amp-horig');hdr.name?.remove();hdr.logo?.remove();hdr.tier?.remove();hdr.swap?.remove();hdr={t:null,logo:null,name:null,tier:null,swap:null};}
    function findHeaderTitle(sid){
      const main=document.querySelector('main');if(!main)return null;const mr=main.getBoundingClientRect();
      // 消息列表在可滚动容器里；顶部栏不在。任何位于滚动容器内的元素都不是标题（以前会误选到顶部的用户气泡“回复我1”）。
      const inScroller=n=>{for(let p=n.parentElement;p&&p!==main;p=p.parentElement){const cs=getComputedStyle(p);if(/(auto|scroll)/.test(cs.overflowY)&&p.scrollHeight>p.clientHeight+4)return true;}return false;};
      const top=b=>{if(b.closest('form,[role="log"],[data-amp-native-gacha],article,[data-message-id],[data-testid*="message"]'))return false;const r=b.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<mr.top+64&&r.bottom>mr.top-4&&(b.textContent||'').trim().length>0&&!/workspace|工作区|sidebar|侧边栏/i.test(b.getAttribute('aria-label')||'');};
      const hp=[...main.querySelectorAll('button[aria-haspopup]')].filter(b=>top(b)&&b.getBoundingClientRect().left<mr.left+mr.width*.6);
      let cands=hp.filter(b=>!inScroller(b));if(!cands.length)cands=hp;
      if(!cands.length)cands=[...main.querySelectorAll('h1,h2')].filter(b=>top(b)&&!inScroller(b));
      if(!cands.length)return null;
      const best=cands.sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left)[0];
      const leaves=[best,...best.querySelectorAll('*')].filter(n=>!n.closest('[data-amp-hlogo],[data-amp-hname]')&&!(n instanceof SVGElement)&&[...n.childNodes].some(c=>c.nodeType===3&&c.textContent.trim()));
      return leaves.sort((a,b)=>b.textContent.length-a.textContent.length)[0]||null;
    }
    function headerTitle(){
      const sid=sidOf(location.href);if(!sid){clearHeader();return;}
      let t=hdr.t;const tb=t&&t.isConnected&&t.closest('button,h1,h2'),mr_=tb&&t.closest('main')?.getBoundingClientRect();if(!t||!t.isConnected||!t.closest('main')||!tb||!mr_||tb.getBoundingClientRect().top>mr_.top+64||tb.closest('[role="log"],article,[data-message-id]')){clearHeader();t=findHeaderTitle(sid);if(!t)return;hdr.t=t;}
      const r=selectedRun(),live=liveView(sid),c=servingCalls(live).at(-1),meta=catalog.entries.get(sid);
      let p=0,done=false;
      if(r){const k=r.runId+'|'+r.revision;if(!hdrStart.has(k)){hdrStart.set(k,Date.now());if(hdrStart.size>20)hdrStart.delete(hdrStart.keys().next().value);}const el_=(Date.now()-hdrStart.get(k))/1000;
        if(r.data&&['已读取','部分记录','模型已识别 · 详情未提供'].includes(r.phase)&&r.data.revision===r.revision){p=100;done=true;}
        else if(r.data)p=Math.min(92,70+el_*2);
        else p=Math.min(60,(r.phase==='读取 Trace'?30:12)+el_*3);
      }else if(c||meta){p=100;done=true;}
      // 顶部名称与左侧卡片保持一致：取左侧当前对话显示的名字（本地识别名优先），而不是 Arena 自己生成的标题（如“回复1”）。
      const link=document.querySelector('a[href="/agent/'+sid+'"]'),lt=link?.querySelector('[data-amp-local-title]');
      // v1.11.77 抽卡刚定名：直接用抽卡定下的名字（手机上侧栏关着，拿不到左侧卡片的本地标题）
      const gt=(()=>{try{return gacha.ownsTitle(sid)?gacha.pendingTitle(sid):null;}catch{return null;}})();
      // v1.11.78 抽卡的这一轮：不显示“换模型”徽标、不让实时监控的改派结论改写名字（抽卡给出的就是实际回答的那个模型）
      const qt=(()=>{try{return gacha.quietTurn(sid);}catch{return false;}})();
      const shownName=noVertex(lt?.getAttribute('data-amp-local-title')||gt||withVendor(sid,meta,prefs.showSeq?meta?.title:meta?.name?.name)||(link&&link.textContent.trim())||t.textContent||'').trim();
      let nm=hdr.name;
      if(!nm||!nm.isConnected||t.nextElementSibling!==nm){nm?.remove();nm=document.createElement('span');nm.setAttribute('data-amp-hname','');nm.setAttribute('data-amp-htitle','');t.after(nm);hdr.name=nm;}
      t.setAttribute('data-amp-horig','');
      // 三段式：logo（厂商） · 名称（不带厂商前缀，与左侧卡片一致） · 档位小标签
      // v1.11.77 三样只在“完整身份”确定的同一时刻一起出现 / 一起更新（不再先出厂商、再出型号、最后补档位）；老虎机读的就是这里的结果。
      // 识别中：名称位置显示对话原标题、副标题“识别中…”，不出 logo 和档位；本对话之前已有完整结果的，新一轮识别中继续显示旧结果，等新结果完整了再整体换。
      const rc0=servingCalls(r?.data).at(-1),known=!!brand.of(shownName),TSPLIT=/^(.*?)[-\s·]+(none|minimal|low|medium|high|xhigh|max)$/i;
      const split=n=>{n=noVertex(String(n||''));const x=brand.of(n)?brand.short(n):n,m=x.match(TSPLIT);return m&&brand.of(n)?[m[1],m[2].toLowerCase()]:[x,''];};
      const generating=!!document.querySelector('button[aria-label="Stop generating"],button[aria-label="Stop response"],button[aria-label="停止生成"]');
      // “完整”= Trace 已读完且不是部分记录（部分记录里往往只有请求名、没有带档位的内部名）；回复结束 12 秒仍只有部分记录就接受现有结果
      const idleMs=(()=>{if(!r)return 0;const k=r.runId;if(generating){hdrIdle.delete(k);return 0;}if(!hdrIdle.has(k)){hdrIdle.set(k,Date.now());if(hdrIdle.size>30)hdrIdle.delete(hdrIdle.keys().next().value);}return Date.now()-hdrIdle.get(k);})();
      const final=!!r&&done&&(!r.data?.partial||idleMs>12000),recent=!!r&&!!r.submittedAt&&Date.now()-r.submittedAt<600000;
      // 本轮（本页刚发出的这一轮）的目录记录还只是请求名 / 部分数据：不算已知，等完整结果
      const provisional=!!r&&!final&&recent&&!!meta&&meta.runId===r.runId&&(!!meta.partial||meta.name?.source!=='internal');
      let idName='',idNew=false;
      if(gt){idName=gt;idNew=true;}
      else if(known&&!provisional)idName=shownName;
      else if(r){const fin=(rc0?.internal||meta?.name?.name||'').replace(/^未提供$/,''),inOk=!!rc0?.internal&&rc0.internal!=='未提供'&&!r.data?.partial;if(fin&&(final||inOk||done&&!recent)){idName=withVendor(sid,meta,fin);idNew=true;}}
      {const ms0=monState(sid);if(ms0.tone==='switch'&&ms0.to&&!forceEq(ms0.to,shownName)&&!forceEq(ms0.to,idName)&&!qt)idName=ms0.to;}
      if(idName){hdrFull.delete(sid);hdrFull.set(sid,idName);if(hdrFull.size>40)hdrFull.delete(hdrFull.keys().next().value);}else if(hdrFull.has(sid))idName=hdrFull.get(sid);
      const full=!!idName,pending=!full&&((!!r&&!final&&(recent||!done))||generating);
      let fam='',tierTxt='';
      if(full){[fam,tierTxt]=split(idName);if(tierTxt==='none')tierTxt='';}
      // v1.11.79 抽卡老虎机 厂商 → 型号 → 档位 依次停：顶部跟着轮子一格一格亮出——还在转：都不亮（原标题 + 识别中…）；
      // 厂商停下：logo + 厂商名；型号停下：logo + 型号；档位停下：档位标签 + “识别模型为 …”（老虎机收起 / 不在抽卡 / 切到后台就不等）
      const rv=full?(()=>{try{return gachaSlot.reveal(sid,fam+'|'+tierTxt);}catch{return null;}})():null,stg=rv?rv.stage:3,hold=full&&stg<1,showFull=full&&stg>=3;
      const dFam=showFull||full&&stg===2?fam:full&&stg===1?(rv.labels?.[0]||brand.NAME[brand.of(idName)]||fam):((provisional||full?noVertex((link&&link.textContent.trim())||t.textContent||'').trim():shownName)||'识别中…');
      if(showFull&&idNew)p=100;else if(!showFull&&done&&!final)p=Math.min(p,92);
      if(nm.textContent!==dFam){nm.textContent=dFam;if(full&&stg>=1&&stg<3){nm.removeAttribute('data-amp-hstep');void nm.offsetWidth;nm.setAttribute('data-amp-hstep','');}}if(!full||stg>=3)nm.removeAttribute('data-amp-hstep');nm.title=showFull?idName:full?dFam:shownName;hdrShown={sid,fam:full?fam:'',tier:full?tierTxt||'':'',vid:'',full,name:idName,at:Date.now()};
      if(!showFull)tierTxt='';
      let tg=hdr.tier;if(!tg||!tg.isConnected||nm.nextElementSibling!==tg){tg?.remove();tg=document.createElement('span');tg.setAttribute('data-amp-htier','');nm.after(tg);hdr.tier=tg;}
      if(tg.dataset.t!==tierTxt||tg.textContent!==tierTxt){tg.dataset.t=tierTxt;tg.replaceChildren();if(tierTxt){const lv=TIER_LV[tierTxt]??0;tg.dataset.lv=String(lv);tg.append(document.createTextNode(tierTxt));}tg.removeAttribute('data-pop');void tg.offsetWidth;if(tierTxt)tg.setAttribute('data-pop','');}
      tg.hidden=!tierTxt;tg.toggleAttribute('data-hi',/^(max|xhigh|high)$/.test(tierTxt));tg.toggleAttribute('data-amp-hdark',isDark());
      // 换模型徽标：本轮已确认（实心）/ 疑似（描边）；点一下打开“监控”页
      {const ms_=monState(sid),show=(ms_.tone==='switch'||ms_.tone==='suspect')&&!qt;let sw=hdr.swap;if(!sw||!sw.isConnected||tg.nextElementSibling!==sw){sw?.remove();sw=document.createElement('span');sw.setAttribute('data-amp-hswap','');sw.setAttribute('role','button');sw.tabIndex=0;sw.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>';const go=e=>{e.preventDefault();e.stopPropagation();ui?.show('detector');};sw.addEventListener('click',go,true);sw.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')go(e);});tg.after(sw);hdr.swap=sw;}
        sw.hidden=!show;if(show){sw.dataset.tone=ms_.tone;sw.title=ms_.text;sw.setAttribute('aria-label',ms_.text);}}
      nm.style.setProperty('--amp-hp',Math.round(p)+'%');nm.toggleAttribute('data-amp-hdone',(!full||showFull)&&(final||(full&&idNew)||(done&&!recent)));nm.toggleAttribute('data-amp-hdark',isDark());
      // 副标题：识别中… → 识别模型为 claude-opus-5-5（8 秒后淡出）
      // v1.11.77 不再逐步透露“已确定厂商 / 识别：部分型号”：完整结果出来之前一律“识别中…”
      const VN={openai:'GPT',anthropic:'Claude',google:'Gemini',xai:'Grok',moonshot:'Kimi',deepseek:'DeepSeek',qwen:'Qwen',zhipu:'GLM',xiaomi:'MiMo',bytedance:'豆包',minimax:'MiniMax',mistral:'Mistral',meta:'Llama'};
      const rc=servingCalls(r?.data).at(-1),partial=rc?.internal||rc?.response||rc?.request||(rc?.model&&rc.model!=='未提供'?rc.model:'');
      const rn=rc?.response||rc?.request||(rc?.model&&rc.model!=='未提供'?rc.model:''),finalName=(rc?.internal||(rn&&brand.of(rn)&&brand.of(rn)!==brand.of(meta?.name?.name||'')?rn:'')||meta?.name?.name||c?.internal||c?.model||'').replace(/^未提供$/,'');
      let sub='',fresh=false;
      if(r&&showFull&&(done||idNew)){const key=r.runId+'|full';if(!hdrStart.has(key)){hdrStart.set(key,Date.now());if(hdrStart.size>60)hdrStart.delete(hdrStart.keys().next().value);}if(Date.now()-hdrStart.get(key)<8000){sub='识别模型为 '+brand.short(idName);fresh=true;}}
      if(!sub&&(pending||full&&!showFull||generating&&!done))sub='识别中…';
      // v1.11.77 “已被改派：A → B”也只在完整结果亮出之后显示；抽卡发出的那一轮不显示
      const rt=r?.data?.routing||live?.routing;if(rt&&!fresh&&showFull&&!(()=>{try{return gacha.quietTurn(sid);}catch{return false;}})())sub='已被改派：'+(rt.from?brand.short(rt.from):'原模型')+' → '+(rt.to?brand.short(rt.to):'其他模型');
      if(nm.getAttribute('data-amp-hsub')!==sub)nm.setAttribute('data-amp-hsub',sub);nm.toggleAttribute('data-amp-hfresh',fresh);
      const vid=full?(brand.of(idName)||brand.of(finalName)||brand.forSid(sid,'')):pending?'':(brand.of(finalName)||brand.of(shownName)||brand.of(partial)||brand.forSid(sid,''));if(hdrShown&&hdrShown.sid===sid)hdrShown.vid=full?vid||'':'';if(hold){hdr.logo?.remove();hdr.logo=null;return;}
      if(!vid){hdr.logo?.remove();hdr.logo=null;return;}
      if(!hdr.logo||!hdr.logo.isConnected||hdr.logo.nextElementSibling!==t||hdr.logo.dataset.v!==vid){hdr.logo?.remove();const lg=document.createElement('span');lg.setAttribute('data-amp-hlogo','');lg.dataset.v=vid;if(['deepseek','qwen','zhipu','xiaomi','bytedance','minimax','mistral','meta'].includes(vid))lg.setAttribute('data-full','');lg.innerHTML=gachaUi.vendorIcon(vid,12);t.before(lg);hdr.logo=lg;}
    }
    // 输入框里目标按钮左边那个纸张/文档图标按钮：默认隐藏（只隐藏图标按钮，不删节点；设置里可恢复）。
    const DOC_KEY=KEY+'.docIconLabel';
    function docIcon(){
      const shown=[...document.querySelectorAll('[data-amp-doc-hidden]')];
      if(!prefs.hideDocIcon){for(const n of shown)n.removeAttribute('data-amp-doc-hidden');return;}
      const remembered=load(DOC_KEY,'');
      for(const g of document.querySelectorAll('[data-amp-native-gacha="1"]')){
        const prev=g.previousElementSibling;
        const cand=prev&&prev.matches('button')?prev:prev?.querySelector?.(':scope>button:only-child')?prev:null;
        if(!cand||cand.hasAttribute('data-amp-doc-hidden'))continue;
        const btn=cand.matches('button')?cand:cand.querySelector('button');
        const label=(btn.getAttribute('aria-label')||btn.title||'').trim();
        const iconOnly=!(btn.innerText||'').trim()&&!!btn.querySelector('svg');
        if(!iconOnly||/send|stop|发送|停止|model|模型|attach|附件|upload|上传|mic|voice|语音/i.test(label))continue;
        if(remembered&&label&&remembered!==label)continue;
        cand.setAttribute('data-amp-doc-hidden','');if(label&&!remembered){store(DOC_KEY,label);log('debug','界面','已隐藏输入框文档图标：'+label);}
      }
    }
    // v1.11.73 第一帧就隐藏：输入框里发送键（或抽卡按钮）左边那个无标签的文档图标；抽卡兜底开侧栏时侧栏与遮罩透明
    el('style','','[data-amp-doc-hidden]{display:none!important}'
      +'html[data-amp-docpre] main div.flex.items-center.gap-2>:is(div:has(>button:only-child:not([aria-label]) svg),button:not([aria-label]):not([role]):not([aria-haspopup]):has(svg)):has(+:is(button[aria-label="Send message"],button[aria-label="发送消息"],[data-amp-native-gacha="1"])){display:none!important}'
      +'html[data-amp-quietnav] body>[role="dialog"][data-mobile="true"],html[data-amp-quietnav] body>div.bg-black\\/80[data-state]:not([role]){opacity:0!important;transition:none!important;animation:none!important;pointer-events:none!important}',document.head||document.body);
    function attach(){
      if(stopped||!document.body)return;const cooling=Date.now()<cooldown;if(cooling!==lastCooling){lastCooling=cooling;paint();}const main=document.querySelector('main'),ready=document.readyState==='complete'||!!document.querySelector('next-route-announcer'); // v1.11.73 React 水合完成即可（Next.js 在提交后插入 next-route-announcer），不再等 load（手机上常晚好几秒）
      const anchor=ready?[...document.querySelectorAll('main button[aria-label="Toggle workspace sidebar"],main button[aria-label="Open workspace"],main button[aria-label="Close workspace"],main button[aria-label="打开工作区"],main button[aria-label="切换工作区侧边栏"]')].find(b=>{const r=b.getBoundingClientRect(),m=b.closest('main').getBoundingClientRect();return r.width>0&&r.height>0&&r.top<m.top+100;}):null;
      if(anchor){if(entry.parentNode!==anchor.parentNode||entry.nextSibling!==anchor)anchor.before(entry);entry.removeAttribute('data-floating');}else{if(entry.parentNode!==document.body)document.body.append(entry);entry.setAttribute('data-floating','');}
      {const g=gemOn();document.documentElement.toggleAttribute('data-amp-gem',g);document.documentElement.toggleAttribute('data-amp-wsr',prefs.wsRight!==false);document.documentElement.toggleAttribute('data-amp-wspre',g&&prefs.wsEdge!==false);document.documentElement.toggleAttribute('data-amp-docpre',!!prefs.hideDocIcon);if(g&&anchor){if(anchor.nextSibling!==avatarHost)anchor.after(avatarHost);avatarHost.hidden=false;paintAvatar();loadMe();}else if(avatarHost.isConnected)avatarHost.remove();syncMode();wsSync();if(!drawerMoOn&&document.body){drawerMoOn=true;drawerMo.observe(document.body,{childList:true});}}
      if(reloadHost.isConnected)reloadHost.remove();document.documentElement.toggleAttribute('data-amp-glass',!!prefs.glassDrawer);if(ready)pull.bind();
      const eligible=/^\/agent(?:\/|$)/.test(location.pathname);entry.hidden=!eligible;let mode='none';
      if(eligible&&ready&&main){const parent=main.parentElement,p=getComputedStyle(parent),m=getComputedStyle(main),isSibling=host.parentNode===parent&&!host.hidden,available=main.getBoundingClientRect().width+(isSibling?host.getBoundingClientRect().width+(parseFloat(p.columnGap)||0):0),wide=innerWidth>=1024&&available>=900&&p.display.includes('flex')&&p.flexDirection==='row';
        if(wide){mode='wide';if(host.parentNode!==parent||host.previousSibling!==main)main.after(host);compact=false;}
        else if(m.display.includes('flex')&&m.flexDirection==='column'){mode='compact';if(host.parentNode!==main||host!==main.lastChild)main.append(host);compact=true;}
      }
      if(mode!==lastLayout){lastLayout=mode;if(mode==='compact')expanded=false;bodyStamp=[];paint();}
      // v1.11.78 抽屉出现 / 收起 / 换高度时对话区底部保持不动（像输入法弹出、收起一样顶上去、落回来）
      {const hide=!eligible||mode==='none'||!compact&&!pref.open||compact&&!expanded,sig=[compact,expanded,hide,prefs.sheetFull,prefs.sheetH,innerHeight].join('|'),go=()=>{host.toggleAttribute('data-compact',compact);host.toggleAttribute('data-expanded',expanded);host.hidden=hide;foldAt.on=eligible&&mode==='wide';placeFold();applySheet();};
        if(sig!==sheetSig&&(compact||sheetSig)){sheetSig=sig;sheetAnchor(go);}else{sheetSig=sig;go();}}
      if(ready){placeGrip();localTitles();sentTimes();try{headerTitle();}catch{}try{docIcon();}catch{}if(!((attach.n=(attach.n||0)+1)%4))statusBar();}
    }
    function cacheTab(){
      const list=[...catalog.entries.values()].filter(x=>x.models?.length||x.title).sort((a,b)=>(b.at||'').localeCompare(a.at||''));const h=el('div','section-heading',null,body);el('h3','','本地会话缓存',h);el('span','eyebrow',list.length+' 个会话',h);
      if(!list.length){empty('暂无模型缓存','新记录会自动保存。');return;}
      const current=sidOf(location.href);
      for(const e of list.slice(0,cacheLimit)){
        const open=openSid===e.sid;
        const b=button(body,'',(open?'收起':'展开')+' #'+e.seq+' 的轮次',()=>{openSid=open?null:e.sid;if(!open)catalog.turnsOf(e.sid);render();},'history-item');b.toggleAttribute('data-open',open);
        el('span','history-name',(e.temporary?'临时 ':'')+e.title+(e.sid===current?'（当前会话）':''),b);const meta=el('span','history-meta',null,b);el('span','',e.at?new Date(e.at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'',meta);el('span','',(e.turns?e.turns+' 轮 · ':'')+(e.partial?'部分字段':'缓存'),meta);
        if(!open)continue;
        const turns=catalog.turnsOf(e.sid),box=el('div','turn-list',null,body);
        if(!turns.length){el('p','note','正在读取轮次…如无结果说明此会话只有编号记录。',box);const legacy=button(box,'查看最近快照','查看此会话最近一次快照',async()=>{const s=await catalog.getSnapshot(e.sid);if(s){historyView=s;selected=null;rawSpan=null;tab='overview';render();}else say('此会话尚无可用的配置快照');},'clear');legacy.style.marginTop='4px';continue;}
        for(const t of turns.slice().reverse()){
          const tb=button(box,'','查看 '+turnLabel(t),async()=>{const s=await catalog.getTurn(t.key);if(!s){say('此轮快照不可用');return;}historyView=s;selected=null;rawSpan=null;tab='overview';render();},'turn-item');if(historyView?.key===t.key)tb.setAttribute('data-current','');
          el('span','turn-name',turnTitle(t,false),tb);const tm=el('span','turn-meta',null,tb);el('span','',t.count+' 次调用 · '+(t.internal||t.model||'未提供'),tm);el('span','',(t.credits!==null&&t.credits!==undefined?Math.round(t.credits)+' cr · ':'')+'显式 '+(t.effort||'未知'),tm);
        }
      }
      if(list.length>cacheLimit)button(body,'显示更多','显示更多会话缓存',()=>{cacheLimit+=50;render();},'clear');
    }
    function logTab(){
      const allowed=new Set(pref.level==='debug'?['info','warn','error','detail','debug']:pref.level==='detail'?['info','warn','error','detail']:['info','warn','error']),list=logItems.filter(e=>allowed.has(e.level));
      if(!list.length){el('p','note','这个级别下暂无日志。',body);return;}
      for(const e of list.slice(-300).reverse()){const line=el('div','logline '+e.level,null,body),meta=el('div','log-meta',null,line);el('span','',e.stage+' · '+({info:'普通',detail:'详细',debug:'调试',warn:'警告',error:'错误'}[e.level]||e.level),meta);el('time','mono',new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false}),meta);el('p','',e.text,line);if(e.runId||e.spanId){const d=el('details','log-origin',null,line);el('summary','','标识',d);if(e.runId)el('code','',e.runId,d);if(e.spanId)el('code','',e.spanId,d);}}
    }
    function aboutTab(){
      const top=el('div','about-head',null,body);el('div','about-logo','A',top);const tx=el('div','grow',null,top);el('div','about-title','Arena Native Suite',tx);el('div','about-sub',(aboutChannel?aboutChannel+' · ':'')+'v'+String(VERSION).replace(/^native-/,''),tx);
      const vs=el('section','section',null,body),vh=el('div','section-heading',null,vs),vh3=el('h3','','版本与更新',vh);info(vh3,'about:upd','每一行是一个脚本：点一下重新检查；有新版本时这一行变深色，点它在新标签页打开安装页。\n“'+(aboutChannel==='测试版'?'正式版':'测试版')+'入口”用来在正式版和测试版之间切换。',vh);vs.append(aboutBox);
      const ex=el('section','section',null,body),eh=el('div','section-heading',null,ex),eh3=el('h3','','导出',eh);info(eh3,'about:exp','模型信息顶部的下载图标导出当前页；这里可以分别导出。都不含登录令牌。',eh);const acts=el('div','log-actions',null,ex);
      button(acts,'模型记录','导出当前会话的记录、原始数据和日志',async()=>{const data=exported();data.logs=await catalog.readLogs(data.sid);download(data,'amp-lite-'+(data.sid||'export').slice(0,8)+'-'+Date.now()+'.json');});
      button(acts,'独立检测','导出独立检测显示与一键检测结果',()=>download({...legacyDisplay.snapshot(),oneClick:force.bySid.get(sidOf(location.href))||null},'arena-independent-detector-'+Date.now()+'.json'));
      button(acts,'抽卡记录','导出本次抽卡记录（不含令牌）',()=>download(gacha.state()||{},'arena-gacha-'+Date.now()+'.json'));
    }
    function render(){
      if(boundPath!==location.pathname){boundPath=location.pathname;historyView=null;turnKey=null;selected=null;rawSpan=null;tab='overview';bodyStamp=[];logKey='';}
      attach();const sid=sidOf(location.href),r=selectedRun();if(sid&&!catalog.snapshots.has(sid)&&!catalog.loading.has(sid))void catalog.getSnapshot(sid).then(()=>paint());
      if(r&&r.revision!==seenRevision){seenRevision=r.revision;if(!historyView){turnKey=null;selected=null;rawSpan=null;}}
      const s=view(),c=s?.calls.find(x=>x.id===selected)||servingCalls(s).at(-1)||s?.calls.at(-1),live=liveView(sid),liveCall=servingCalls(live).at(-1),meta=catalog.entries.get(sid);
      const originTag=r?.data&&r.data.revision!==r.revision?'上次':!r?.data&&live?'缓存':'';
      const shown=meta?.name?.name||liveCall?.internal||liveCall?.model||'模型信息',eff=liveCall?.effort,effortText=eff?.value||({conflict:'冲突',unsupported:'不支持'}[eff?.status])||'未知';
      triggerLabel.textContent=(prefs.showSeq&&seqLabel(sid)?seqLabel(sid)+' ':'')+shown;mini.textContent=liveCall?(originTag?originTag+' · ':'')+'推理 '+effortText:'';mini.hidden=true;
      compactName.textContent=triggerLabel.textContent;{const st=monState(sid),[,sfx]=famTier(liveCall?.internal||liveCall?.model||''),tier=liveCall?.effort?.value||sfx,rs=liveCall&&liveCall.reasoning.status!=='conflict'?number(liveCall.reasoning.value):null;compactText.textContent=liveCall?[tier?'档位 '+tier:'',rs?'思考 '+spendShort(rs):rs===0?'无思考链':'',st.tone==='idle'?'':st.short].filter(Boolean).join(' · ')||'已识别':'尚无模型记录';compactText.dataset.tone=liveCall?st.tone:'';}numberLabel.textContent=seqLabel(s?.sid||sid);
      // v1.11.79 这一抽还在老虎机里揭晓：模型信息只写已经停下的格子（厂商 → 型号），详情等三格都停下再显示
      const gv=sid?(()=>{try{return gachaSlot.view(sid);}catch{return null;}})():null;if(gv){triggerLabel.textContent=compactName.textContent=gachaSlot.stageName(gv);compactText.textContent='识别中…';compactText.dataset.tone='';}
      const historical=!!historyView||!!turnKey||!r?.data&&!!s||!!r?.data&&r.data.revision!==r.revision,explicitHist=!!historyView||!!turnKey;banner.hidden=!explicitHist||!['overview','sources','raw'].includes(tab);{const ct=!explicitHist&&historical?(r?.data?'上次':'缓存'):'';for(const ch of [compactChip,headChip]){ch.hidden=!ct;if(ch.textContent!==ct)ch.textContent=ct;}}
      bannerText.textContent=historyView?'本地缓存 · '+(seqLabel(historyView.sid)||'')+' · '+turnLabel(historyView):turnKey?'历史轮次 · '+turnLabel(s)+' · 非最新记录':r?.data?'上次记录 · 非本轮结论':'本地缓存 · 非本轮结论';banner.querySelector('button').hidden=!(historyView||turnKey);
      const grp=groupOf(tab);groupLast[grp[0]]=tab;for(let i=0;i<groups.length;i++){const on=groups[i]===grp;tabButtons[i].setAttribute('aria-selected',String(on));tabButtons[i].tabIndex=on?0:-1;}body.setAttribute('aria-labelledby','amp-tab-'+grp[0]);subnav.hidden=grp[2].length<2;if(!subnav.hidden){const k=grp[0]+'|'+tab;if(subStamp!==k){subStamp=k;subnav.replaceChildren();subnav.setAttribute('aria-label',grp[1]);for(const id of grp[2]){const t=(tabs.find(x=>x[0]===id)||[id,id])[1],sb=button(subnav,t,t,()=>{tab=id;render();});sb.setAttribute('aria-pressed',String(id===tab));}}}
      logBar.hidden=tab!=='logs';clearLogs.textContent=confirmLogClear?'确认清理全部日志':'清理日志';cancelClear.hidden=!confirmLogClear;read.disabled=['detector','hunt'].includes(tab)||!!historyView||!!r?.busy||Date.now()<cooldown;
      statusBar();
      const dataTabs=['overview','sources','raw'].includes(tab),turnSid=historyView?.sid||sid,turns=catalog.turnsOf(turnSid),liveData=liveView(turnSid),options=liveData&&!turns.some(t=>t.key===liveData.key)?[...turns,{...liveData,key:liveData.key}]:turns;
      turnPicker.hidden=!dataTabs||options.length<2;
      if(!turnPicker.hidden){const lk=historyView?null:liveKey(),key=options.map(t=>t.key+':'+t.prompt+':'+t.count).join('|')+'|'+lk;if(turnStamp!==key){turnStamp=key;turnSelect.replaceChildren();for(const t of options){const o=el('option','',turnTitle(t,t.key===lk),turnSelect);o.value=t.key;}}turnSelect.value=historyView?.key||turnKey||lk||'';}
      picker.hidden=!c||s.calls.length<2||!dataTabs;if(!picker.hidden){const key=s.calls.map(x=>x.id+':'+x.model+':'+x.tokens.output).join('|');if(pickerStamp!==key){pickerStamp=key;select.replaceChildren();for(const [i,call]of s.calls.entries()){const o=el('option','',(i+1+s.prior)+'. '+clock(call.at)+' · '+call.model+(call.tokens.output!==null?' · 出 '+fmt(call.tokens.output):''),select);o.value=call.id;}}select.value=c.id;}
      pickers.hidden=turnPicker.hidden&&picker.hidden;
      if(tab==='logs'){const logSid=historyView?.sid||sid,key=(logSid||'')+':'+catalog.logRevision;if(logKey!==key){logKey=key;void catalog.readLogs(logSid).then(rows=>{if(logKey!==key)return;logItems=rows;logSerial++;paint();});}}
      if(tab==='settings'&&Date.now()-usageAt>5000){usageAt=Date.now();void catalog.usage().then(u=>{usageInfo=u;settingsSerial++;paint();});}
      const next=[tab,tab==='detector'?legacyDisplay.revision+'|'+force.serial+'|'+(sid||'')+'|'+mon.serial:tab==='hunt'?gacha.revision:0,s,c,historical,moreOpen,tab==='cache'?catalog.revision:0,cacheLimit,openSid,tab==='logs'?logSerial:0,tab==='logs'?pref.level:null,!!r?.busy,Date.now()<cooldown,rawFilter,rawSpan,tab==='raw'?rawStore.get(s?.key)?.spans.size:0,tab==='settings'?settingsSerial:0,confirmRawClear,tab==='settings'?JSON.stringify(prefs):'',tab==='raw'?JSON.stringify(rawOf(s)?.probe&&Object.keys(rawOf(s).probe)):'',tab==='overview'?spendSerial+'|'+mon.serial:0,gv&&['overview','sources','raw'].includes(tab)?'g'+gv.stage:''];
      if(next.some((x,i)=>x!==bodyStamp[i])||!bodyStamp.length){const scroll=body.scrollTop,sameTab=bodyStamp[0]===tab,focus=root.activeElement?.dataset.focus;bodyStamp=next;body.replaceChildren();if(tab==='hunt')huntTab();else if(tab==='detector')detectorTab();else if(tab==='cache')cacheTab();else if(tab==='logs')logTab();else if(tab==='settings')settingsTab();else if(tab==='about')aboutTab();else if(gv)empty('老虎机揭晓中…','厂商 → 型号 → 档位 依次停下后显示这一抽的完整信息。');else if(!c){if(tab==='overview'&&turnSid){liveCard(turnSid,null,!historyView&&!turnKey);spendCard({sid:turnSid});}empty(turnKey?'正在读取此轮缓存':'尚无模型记录',turnKey?'如长时间无内容，说明此轮快照不可用。':'发送一条新消息后，型号与配置会自动填入。');}else if(tab==='sources')sources(s,c);else if(tab==='raw')rawTab(s,c);else overview(s,c);body.scrollTop=sameTab?scroll:0;if(focus)[...body.querySelectorAll('[data-focus]')].find(e=>e.dataset.focus===focus)?.focus({preventScroll:true});}
    }
    // 独立检测页：上半“一键检测”（立刻读取本对话此刻的全部记录，看中途有没有换模型、换成了谁），下半“原脚本检测”（v8.1.0 原样结果，只换排版）
    const posText=c=>!c?'':(c.turn?'第 '+c.turn+' 轮':'未标记轮次')+(c.attempt>1?'（第 '+c.attempt+' 次）':'')+' · 第 '+c.n+' 次调用';
    function vlogo(parent,names){const vid=names.map(n=>brand.of(n)).find(Boolean);if(!vid)return null;let ic='';try{ic=gachaUi.vendorIcon(vid,12);}catch{}if(!ic)return null;const s=el('span','vlogo',null,parent);s.innerHTML=ic;if(!ic.includes('gpVIcon'))s.setAttribute('data-full','');s.title=brand.NAME[vid]||vid;return s;}
    let legacyRawOpen=false;
    function detectorTab(){
      const sid=sidOf(location.href),m=sid?mon.bySid.get(sid):null,busy=force.busy&&force.sid===sid,man=sid?force.bySid.get(sid)||null:null,auto=m?.auto||null;
      const res=man&&(!auto||man.at>=auto.at||(man.calls?.length||0)>=(auto.calls?.length||0))?man:auto||man,calls=res?.calls?.length||0,cur=res?.current,st=monState(sid);
      // ① 监控状态：当前型号 + 结论
      const card=el('section','mc-card mc-hero',null,body),head=el('div','mc-head',null,card);icon('pulse',head,'mc-ic');const h3=el('h3','','实时监控',head);if(prefs.monOn&&m?.busy)el('i','mc-live',null,head);
      el('span','eyebrow',!sid?'未打开对话':res?(res.auto?'自动核对 ':'深度核对 ')+clock(res.at):prefs.monOn?'等待数据':'已关闭',head);
      info(h3,'mon','读取页面上的对话状态（不发请求）：出现新的步骤或思考链变化时，立即补读一次 Trace；每次读到 Trace 都自动逐次调用比对型号。\n· 回复先出正文、过一会儿才出现思考链 → 疑似换模型（弹提示并立即核对）\n· 一开始就在思考不算换模型信号（只记录、补读核对，不弹提示）\n· 抽卡进行中、抽卡开出的对话里由抽卡发出的那一轮：不弹任何换模型提示\n· Trace 里前后型号不同 → 确认换模型\n· 档位 / -vertex 等后缀不同不算换模型，单独标为“档位变化”\n注意：闭源 / 开源与是否显示思考链并不绝对对应，所以只看“变化”，不看有无本身。',head);
      if(cur){const top=el('div','mc-top',null,card),lg=vlogo(top,[cur.name,cur.internal,cur.response,cur.request,cur.pill].filter(Boolean));if(lg)lg.classList.add('mc-big');const nb=el('div','mc-name',null,top),[f1]=famTier(cur.name),[f2,t2]=famTier(cur.internal||'');el('span','mc-fam',f1||f2||cur.name,nb);tierBadge(nb,cur.eff||t2,'档位 '+(cur.eff||t2));
        el('div','mc-sub',[(cur.partial?'正在进行':'最近一次')+' · '+clock(cur.at),posText(cur),cur.local?'本机记录':''].filter(Boolean).join(' · '),card);}
      else if(!res)el('div','mc-sub',!sid?'打开一个对话后开始监控':prefs.monOn?'发送消息后会自动识别并持续核对；也可以点下面的“深度核对”':'实时监控已关闭，可在设置里开启',card);
      const v=el('div','mc-verdict',null,card);v.dataset.tone=busy?'busy':st.tone;icon(busy?'reload':st.icon,v);el('span','',busy?(force.step||'深度核对中')+'…':st.text,v);
      // ② 信号：思考链变化、档位变化、消耗 / 速度突变
      const sig=[];for(const f of (m?.flags||[]).slice(-6).reverse())sig.push([f.kind.startsWith('think-d')||f.kind.startsWith('think-r')?'gauge':'brain',f.text,flagDetail(f),f.status]);
      for(const t of (res?.tiers||[]).slice(-3).reverse())sig.push(['gauge','档位变化 '+t.from+' → '+t.to,[clock(t.at),posText(t)].filter(Boolean).join(' · '),'']);
      if(res?.shift)sig.push(['gauge',res.shift.kind==='drop'?'单次调用消耗骤降 ↓'+Math.round((1-res.shift.ratio)*100)+'%':'单次调用消耗骤增 ×'+(Math.round(res.shift.ratio*10)/10),'本轮中位 '+spendShort(Math.round(res.shift.cur))+' · 此前 '+spendShort(Math.round(res.shift.base))+' token'+(res.shift.same?' · 名称未变，疑似改了档位':''),'']);
      if(res?.speed)sig.push(['bolt','输出速度变化 ×'+(Math.round(res.speed.ratio*10)/10),'本轮 '+Math.round(res.speed.cur)+' · 此前 '+Math.round(res.speed.base)+' tok/s（仅作辅证）','']);
      if(sig.length){const sc=el('section','mc-card',null,body),sh=el('div','mc-head',null,sc);icon('alert',sh,'mc-ic');el('h3','','信号',sh);el('span','eyebrow',sig.length+' 条',sh);const box=el('div','mc-flags',null,sc);for(const x of sig)flagRow(box,...x);}
      // ③ 模型时间线：连续同一模型合为一段，段与段之间标出切换点
      if(res?.groups?.length){const ts=el('section','mc-card',null,body),th=el('div','mc-head',null,ts);icon('layers',th,'mc-ic');el('h3','','模型时间线',th);el('span','eyebrow',res.groups.length+' 段 · '+calls+' 次调用',th);
        const tl=el('div','tl',null,ts),gs=res.groups,shown=gs.slice(-8),off=gs.length-shown.length;if(off)el('div','tl-more','更早 '+off+' 段未显示',tl);
        shown.forEach((g,i)=>{if(i){const ch=res.changes[off+i-1];if(ch){const cr=el('div','tl-change',null,tl);if(ch.tierOnly)cr.dataset.tier='';icon(ch.tierOnly?'gauge':'swap',cr);el('span','',[clock(ch.at),posText(ch)+'起',ch.tierOnly?'档位 '+tierName(ch.from)+' → '+tierName(ch.to)+'（同一模型）':'',...ch.tags].filter(Boolean).join(' · '),cr);}}
          const r_=el('div','tl-row',null,tl),now=i===shown.length-1;if(now)r_.setAttribute('data-current','');el('i','tl-dot',null,r_);const nm=el('div','tl-name',null,r_);vlogo(nm,[g.title.name,g.names.internal,g.names.response,g.names.request,g.names.pill].filter(Boolean));const [f1]=famTier(g.title.name),[,t2]=famTier(g.names.internal||'');el('span','',f1||g.title.name,nm);if(t2)tierBadge(nm,t2);el('span','tl-count','× '+g.count,r_);
          const t=g.turns,turns=t.length?'第 '+(t.length>1?Math.min(...t)+'–'+Math.max(...t):t[0])+' 轮':'';el('div','tl-meta',[clock(g.from)+(g.to&&g.to!==g.from?' – '+clock(g.to):''),turns,g.title.src?'按'+FORCE_SRC_TEXT[g.title.src]:'',g.local?'本机记录':'',now&&g.partial?'进行中':''].filter(Boolean).join(' · '),r_);});}
      // ④ 深度核对：补读变更点前后的调用详情
      const act=el('section','mc-act',null,body),go=button(act,busy?'核对中…':!sid?'打开对话后可用':'深度核对','立刻读取本对话此刻的 Trace 与本机记录，补读变更点前后的调用详情，逐次核对模型',()=>{void forceDetect();},'detect-go');go.disabled=force.busy||!sid;
      el('p','note',res?['依据：'+(res.events?'Trace '+res.events+' 条事件':'本机记录'),calls?calls+' 次调用':'',res.fetched?'补读 '+res.fetched+' 个详情':'',res.localTurns?'本机更早 '+res.localTurns+' 轮':''].filter(Boolean).join(' · '):'实时监控每次读到 Trace 都会自动核对；需要补读更多详情时再点“深度核对”。',act);
      for(const n of man?.notes||[])el('p','note warning',n,act);if(man?.error)el('p','note warning','核对出错：'+man.error,act);
      legacySection(res);
    }
    // 原脚本 v8.1.0：收进可展开的卡片，“Key: value”拆成配置行，原文收进“原始显示”
    let legacyOpen=false;
    function legacySection(res){
      const data=legacyDisplay.snapshot(),text=String(data.text||''),state=data.state||'等待初始化',waiting=text.startsWith(state+'：');
      const ls=el('details','mc-card mc-legacy',null,body);ls.open=legacyOpen;ls.ontoggle=()=>{legacyOpen=ls.open;};
      const sm=el('summary','',null,ls);icon('layers',sm,'mc-ic');el('span','grow','原脚本检测',sm);el('span','eyebrow',(data.at?'更新于 '+clock(data.at):'v8.1.0')+' · '+state,sm);icon('chevron',sm,'mc-chev');
      el('p','note','原脚本 v8.1.0 的检测结果，只看最新一轮；与上面的实时监控互相独立，保留原脚本的 New Chat 自动刷新。',ls);
      const cfg=el('div','config',null,ls),sr=el('div','config-row',null,cfg);el('span','config-label','状态',sr);const sv=el('span','config-value legacy-state',state,sr);if(waiting){const pr=el('div','config-row',null,cfg);el('span','config-label','进度',pr);el('span','config-value legacy-state',text.slice(state.length+1),pr);}sv.dataset.tone=/检测结果/.test(state)?'ok':/进行中/.test(state)?'busy':/错误/.test(state)?'bad':'';
      if(!waiting)for(const line of text.split('\n')){const mm=/^([^:：]{1,24})[:：]\s*(.+)$/.exec(line.trim());if(!mm)continue;const r=el('div','config-row',null,cfg);el('span','config-label',mm[1]==='Model'?'模型':mm[1],r);el('span','config-value',mm[2],r);}
      const raw=el('details','legacy-raw',null,ls),rs=el('summary','',null,raw);icon('chevron',rs);el('span','','原始显示',rs);raw.open=legacyRawOpen;raw.ontoggle=()=>{legacyRawOpen=raw.open;};const pre=el('pre','json',text||'等待发送内容',raw);pre.tabIndex=0;
      const actions=el('div','log-actions',null,ls);button(actions,'复制原始显示','复制原脚本完整显示文本',()=>copy(text,'独立检测信息'));button(actions,'导出本页','导出本页显示与核对结果，不含运行令牌',()=>download({...legacyDisplay.snapshot(),oneClick:res||null},'arena-independent-detector-'+Date.now()+'.json'));
    }
    // 概览第一行“消耗”卡片：当前对话总量 / 最近一次，Token ↔ 美金 切换（选择会记住）。
    // 美金：Arena 费用接口的会话累计计费（含其他设备的消耗）与本轮计费；没有接口数据时用本机记录的每轮 credits 合计（标 ≈）。
    // Token：按本机记录的每轮用量求和（优先 token.usage.recorded，其次各次调用），缺字段或调用数超过保留上限时标 ≈。
    // ---------- 美金估算：Arena 费用接口不开放时，按 token × 模型官方单价估算 ----------
    // 单价（每百万 token 的输入 / 输出价）读 Arena 排行榜页面（同站，24 小时刷新一次，失败 6 小时后再试），读不到时用内置价格表。
    // 缓存读取按输入价的 10% 计；缓存写入 Claude 按 125%、其他按输入价；推理 token 已含在输出里。
    const PRICE_KEY='amp.native.prices.v1',PRICE_DAY=86400000,PRICE_RETRY=21600000,CACHE_READ_RATE=0.1;
    const PRICE_BUILTIN={'gpt-6-astra':[10,50],'gpt-6-sol':[2,10],'gpt-6-luna':[0.1,0.5],'gpt-5.6-sol':[4,20],'gpt-5.6-terra':[2,12],'gpt-5.6-luna':[0.2,1.2],'gpt-5.5':[5,30],'gpt-5.4':[2.5,15],
      'claude-fable-5.1':[10,50],'claude-fable-5':[10,50],'claude-opus-5.5':[4,20],'claude-opus-5':[5,25],'claude-sonnet-5':[2,10],'claude-opus-4-8':[5,25],'claude-sonnet-4-6':[1.5,7.5],
      'gemini-3.8-flash':[0.75,3.75],'gemini-3.1-pro':[1,6],'kimi-k3':[3,15],'grok-4.7':[2,6],'deepseek-v4-pro':[1.32,3.96],'deepseek-v4.1-flash':[0.3,1.2],'glm-5.3':[1.4,4.4],'qwen3.8-max':[1.69,5.07],'minimax-m3':[0.3,1.2],'mimo-v2.6-pro':[0.435,0.87]};
    const PRICE_TAIL=/-(?:max|xhigh|high|medium|low|minimal|none|thinking(?:-\d+k)?|non-thinking|no-thinking|preview|latest|agent|webdev|vertex|bedrock|\d+k|\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/;
    function priceKey(n){
      let s=String(n||'').toLowerCase().replace(/^#\d+\s*/,'').replace(/\s*·\s*\d+\s*$/,'').replace(/\[[^\]]*\]|\([^)]*\)/g,' ').trim();
      s=s.replace(/^[\w.-]+\//,'').replace(/[\s_]+/g,'-').replace(/-{2,}/g,'-').replace(/^-|-$/g,'');
      for(let i=0;i<8&&PRICE_TAIL.test(s);i++)s=s.replace(PRICE_TAIL,'');
      return s.length<=80?s:'';
    }
    let priceMem=null,priceBusy=false;
    const priceSave=()=>{try{ampStore.set(PRICE_KEY,JSON.stringify(priceMem));}catch{}};
    function priceLoad(){if(priceMem)return priceMem;let c=null;try{c=JSON.parse(localStorage.getItem(PRICE_KEY)||'null');}catch{}priceMem=c&&c.map&&typeof c.map==='object'?{at:+c.at||0,tried:+c.tried||0,map:c.map}:{at:0,tried:0,map:{}};return priceMem;}
    function priceOf(name){
      const k=priceKey(name);if(!k)return null;const m=priceLoad().map;
      for(let s=k;s;s=s.includes('-')?s.slice(0,s.lastIndexOf('-')):''){const p=m[s]||PRICE_BUILTIN[s];if(Array.isArray(p)&&p[0]>=0&&p[1]>=0)return {key:s,in:p[0],out:p[1],src:m[s]?'排行榜':'内置'};}
      return null;
    }
    // 排行榜页面里每个模型对象都带 inputPricePerMillion / outputPricePerMillion；名字在同一对象里（modelDisplayName 或 model）
    function priceParse(txt){
      const s=String(txt).slice(0,12e6).replace(/\\"/g,'"'),map={},re=/"inputPricePerMillion":(null|[\d.]+),"outputPricePerMillion":(null|[\d.]+)/g;
      for(let m,n=0;(m=re.exec(s))&&n<5000;n++){
        if(m[1]==='null'||m[2]==='null')continue;const i=+m[1],o=+m[2];if(!(i>=0&&o>=0&&i<1e4&&o<1e4))continue;
        const st=s.lastIndexOf('{',m.index);if(st<0||m.index-st>3000)continue;const obj=s.slice(st,m.index);
        for(const x of obj.matchAll(/"(?:modelDisplayName|model|publicName|displayName)":"([^"]{1,160})"/g)){const k=priceKey(x[1]);if(k&&!map[k])map[k]=[i,o];}
      }
      return map;
    }
    function priceRefresh(){
      const pm=priceLoad(),now=Date.now();
      if(priceBusy||now-pm.at<PRICE_DAY||now-pm.tried<PRICE_RETRY)return;
      priceBusy=true;pm.tried=now;priceSave();
      void rawFetch(location.origin+'/leaderboard',{credentials:'same-origin',cache:'no-store',headers:{Accept:'text/html'}}).then(r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.text();}).then(txt=>{
        const map=priceParse(txt),n=Object.keys(map).length;if(n<5)throw Error('排行榜页面里没有读到单价');
        priceMem={at:Date.now(),tried:pm.tried,map};priceSave();log('info','费用','已从 Arena 排行榜更新 '+n+' 个模型的单价');spendSerial++;paint();
      }).catch(e=>log('debug','费用','读取排行榜单价失败：'+(e?.message||e))).finally(()=>{priceBusy=false;});
    }
    const priceText=p=>p.key+'：输入 $'+p.in+' · 输出 $'+p.out+' / 百万 token（'+p.src+'）';
    function priceWhen(){const pm=priceLoad();return Object.keys(pm.map).length&&pm.at?'Arena 排行榜（'+new Date(pm.at).toLocaleDateString('zh-CN')+' 更新）':'内置价格表（读到 Arena 排行榜后自动更新）';}
    // 一次用量的美金。输入里已含缓存（OpenAI / AI SDK 口径）就扣掉；缓存比输入还多，说明是分开计的（Anthropic 口径）
    function usdOf(p,i,o,cr,cw){i=i||0;o=o||0;cr=cr||0;cw=cw||0;const fresh=cr+cw<=i?i-cr-cw:i,wr=/^claude/.test(p.key)?1.25:1;return (fresh*p.in+cr*p.in*CACHE_READ_RATE+cw*p.in*wr+o*p.out)/1e6;}
    // 卡片只用到这些字段（不把整份快照留在内存里）
    function spendLite(d){
      if(!d)return null;const c=d.credits;
      return {count:d.count,internalNames:d.internalNames||[],credits:c?{usd:c.usd,credits:c.credits}:null,
        costs:(d.costs||[]).map(x=>({fields:(x.fields||[]).filter(f=>f&&/^(chargedUsd|costUsd)$/.test(f.key))})),
        records:(d.records||[]).map(r=>({kind:r.kind,internal:r.internal,input:r.input,output:r.output,cacheRead:r.cacheRead,cacheWrite:r.cacheWrite})),
        calls:(d.calls||[]).map(x=>({internal:x.internal,request:x.request,model:x.model,cost:x.cost,tokens:x.tokens}))};
    }
    const convModel=sid=>{const e=sid&&catalog.entries.get(sid);return e?e.name?.name||(e.models||[])[0]||null:null;};
    // 一轮的美金：Arena 计费（credits）> spend.recorded 计费记录 > 追踪数据里的调用成本 > token × 单价估算
    function turnUsd(s,fb){
      if(!s)return null;
      const cu=spendNum(s.credits?.usd)??(spendNum(s.credits?.credits)!==null?s.credits.credits/CREDITS_PER_USD:null);
      if(cu!==null)return {usd:cu,kind:'credits'};
      const recs=(s.records||[]).filter(r=>r&&r.kind!=='cost'),calls=s.calls||[];
      const fees=(s.costs||[]).map(c=>{const f=k=>(c.fields||[]).find(x=>x.key===k&&typeof x.value==='number'&&x.value>=0)?.value??null;return f('chargedUsd')??f('costUsd');});
      if(fees.length&&fees.every(v=>v!==null)&&fees.length>=(recs.length||1)){const sum=fees.reduce((a,b)=>a+b,0);if(sum>0)return {usd:sum,kind:'record'};}
      if(calls.length&&calls.length>=(s.count||0)&&calls.every(c=>spendNum(c.cost)!==null)){const sum=calls.reduce((a,c)=>a+c.cost,0);if(sum>0)return {usd:sum,kind:'trace'};}
      const turnName=(s.internalNames||[])[0]||calls.find(c=>c.internal)?.internal||calls.find(c=>c.request)?.request||calls.find(c=>c.model&&c.model!=='未提供')?.model||null;
      const src=recs.length?recs.map(r=>({n:r.internal,i:r.input,o:r.output,cr:r.cacheRead,cw:r.cacheWrite})):calls.map(c=>({n:c.internal||c.request||c.model,i:c.tokens?.input,o:c.tokens?.output,cr:c.tokens?.cacheRead,cw:c.tokens?.cacheWrite}));
      let usd=0,have=0,miss=0,noPrice=0,noCache=0;const used=new Map();
      for(const x of src){
        if(spendNum(x.i)===null&&spendNum(x.o)===null){miss++;continue;}
        const p=priceOf(x.n)||priceOf(turnName)||priceOf(fb);if(!p){noPrice++;continue;}
        usd+=usdOf(p,spendNum(x.i),spendNum(x.o),spendNum(x.cr),spendNum(x.cw));have++;used.set(p.key,p);if(spendNum(x.cr)===null)noCache++;
      }
      if(!have)return noPrice?{usd:null,kind:'noprice'}:null;
      const cut=recs.length?recs.length>=TURN_CALL_LIMIT:(s.count||0)>calls.length;
      return {usd,kind:'estimate',partial:miss>0||noPrice>0||cut,noCache:noCache===have,prices:[...used.values()]};
    }
    let spendSerial=0;const spendCache=new Map(),spendRemote=new Map();
    // 美金：读 Arena 费用接口的整段对话累计（includeSession=true）。每个对话最多 60 秒一次，只在卡片需要时触发。
    function spendFetch(sid){
      if(!sid||!costAllowed())return spendRemote.get(sid)||null;
      let r=spendRemote.get(sid);
      if(!r){r={session:null,entries:null,at:0,tried:0,busy:false,error:''};spendRemote.set(sid,r);while(spendRemote.size>12)spendRemote.delete(spendRemote.keys().next().value);}
      if(!r.busy&&Date.now()-r.tried>60000){r.busy=true;r.tried=Date.now();
        void costGet(sid).then(j=>{const sum=costSummary(j);if(sum&&(sum.session||Object.keys(sum.entries||{}).length)){r.session=sum.session;r.entries=sum.entries;r.at=Date.now();r.error='';}else r.error='费用接口没有返回数据';})
          .catch(e=>{r.error=e?.status||e?.known?'费用接口暂不可用':'费用读取失败';}).finally(()=>{r.busy=false;spendSerial++;paint();});}
      return r;
    }
    const spendNum=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
    const spendMoney=v=>v===null?'—':'$'+(Math.abs(v)>=100?v.toFixed(2):Math.abs(v)>=0.01||v===0?v.toFixed(4):v.toFixed(5));
    const spendTok=n=>n>=1e7?(n/1e4).toFixed(n>=1e8?0:1)+' 万':fmt(n);
    const spendShort=n=>n>=1e4?(n/1e4).toFixed(1).replace(/\.0$/,'')+'万':fmt(n);
    function turnTokens(s){
      if(!s)return null;const recs=(s.records||[]).filter(r=>r&&r.kind!=='cost'),calls=s.calls||[];
      const one=(t,i,o,r)=>({t:spendNum(t)??(spendNum(i)!==null&&spendNum(o)!==null?i+o:null),i:spendNum(i),o:spendNum(o),r:spendNum(r)});
      const src=recs.length?recs.map(r=>one(r.total,r.input,r.output,r.reasoning)):calls.map(c=>one(c.tokens?.total,c.tokens?.input,c.tokens?.output,c.reasoning?.value));
      let total=0,input=0,output=0,reasoning=0,have=0,miss=0;
      for(const x of src){if(x.t!==null){total+=x.t;have++;}else miss++;input+=x.i||0;output+=x.o||0;reasoning+=x.r||0;}
      if(!have)return null;
      const cut=recs.length?recs.length>=TURN_CALL_LIMIT:(s.count||0)>calls.length;
      return {total,input,output,reasoning,approx:miss>0||cut};
    }
    const spendLatest=sid=>{const r=sid===sidOf(location.href)?selectedRun()?.data:null;return (r&&r.sid===sid?r:null)||catalog.snapshots.get(sid)||history.find(x=>x.sid===sid)||null;};
    function sessionSpend(sid,latest){
      const turns=catalog.turnsOf(sid),stamp=turns.map(t=>t.key+'@'+t.at).join('|');let hit=spendCache.get(sid);
      if(!hit||hit.stamp!==stamp){
        const h={stamp,byKey:hit?.byKey||null,loading:true};hit=h;spendCache.delete(sid);spendCache.set(sid,h);while(spendCache.size>8)spendCache.delete(spendCache.keys().next().value);
        void catalog.rows('turns','sid',sid,'next',400).then(rows=>{const m=new Map();for(const row of rows){const d=row?.data;if(d?.key)m.set(d.key,{tok:turnTokens(d),credits:spendNum(row.credits??d.credits?.credits),lite:spendLite(d)});}h.byKey=m;h.loading=false;if(spendCache.get(sid)===h){spendSerial++;paint();}}).catch(()=>{h.loading=false;});
      }
      const all=new Map(hit.byKey||[]);if(latest?.key)all.set(latest.key,{tok:turnTokens(latest),credits:spendNum(latest.credits?.credits),lite:spendLite(latest)});
      let total=0,input=0,output=0,have=0,approx=false,credits=0,cHave=0;
      // 美金按轮相加：有 Arena 计费的轮次用计费，其余按 token × 单价估算（渲染时按当前单价算）
      const fb=convModel(sid),usd={usd:0,have:0,estimated:0,partial:false,noPrice:0,noCache:false,prices:[],fb},ps=new Map();
      for(const v of all.values()){
        if(v.tok){total+=v.tok.total;input+=v.tok.input;output+=v.tok.output;have++;if(v.tok.approx)approx=true;}else approx=true;if(v.credits!==null){credits+=v.credits;cHave++;}
        const u=turnUsd(v.lite,fb);if(!u){usd.partial=true;continue;}if(u.usd===null){usd.noPrice++;continue;}
        usd.usd+=u.usd;usd.have++;if(u.kind==='estimate'){usd.estimated++;if(u.partial)usd.partial=true;if(u.noCache)usd.noCache=true;for(const q of u.prices)ps.set(q.key,q);}
      }
      usd.prices=[...ps.values()];
      return {total:have?total:null,input,output,turns:all.size,approx,loading:hit.loading&&!hit.byKey,credits:cHave?credits:null,creditTurns:cHave,usd};
    }
    // 底部信息栏：没有美元额度快照时显示本对话花费（Arena 会话计费 > 本机按轮合计 / token × 单价估算），点开看“消耗”
    let briefMemo={k:'',v:null};
    function spendBrief(){
      const sid=sidOf(location.href);if(!sid)return null;
      const latest=spendLatest(sid),turns=catalog.turnsOf(sid),st=costState.get(sid),rm=spendRemote.get(sid);
      const k=[sid,spendSerial,latest?.key,latest?.at,latest?.credits?.at,turns.length,turns.at(-1)?.at,st?.latest?.at,rm?.at,priceLoad().at].join('|');
      if(briefMemo.k===k)return briefMemo.v;
      const cands=[[latest?.credits?.session,Date.parse(latest?.credits?.at||'')||0],[st?.latest?.summary?.session,st?.latest?.at||0],[rm?.session,rm?.at||0]].filter(x=>x[0]).sort((a,b)=>b[1]-a[1]);
      const money=u=>'$'+(u>=0.1?u.toFixed(2):u.toFixed(4)),su=spendNum(cands[0]?.[0]?.chargedUsd);let v=null;
      if(su!==null)v={text:money(su),title:'本对话累计花费（Arena 会话计费）\n点击查看消耗'};
      else{const eu=sessionSpend(sid,latest).usd;if(eu.have){if(eu.estimated)priceRefresh();v={text:'≈'+money(eu.usd),title:'本对话花费约 $'+eu.usd.toFixed(4)+'（本机记录的 '+eu.have+' 轮'+(eu.estimated?'，其中 '+eu.estimated+' 轮按 token × 单价估算':'')+'）\n其他设备上的轮次不在内 · 点击查看消耗'};}}
      briefMemo={k,v};return v;
    }
    function spendCard(s){
      const sid=s.sid,latest=spendLatest(sid)||s,unit=prefs.spendUnit==='usd'?'usd':'token';
      const sec=el('section','section spend',null,body),head=el('div','section-heading',null,sec);el('h3','','消耗',head);
      const seg=el('div','unit',null,head);seg.setAttribute('role','group');seg.setAttribute('aria-label','显示单位');
      for(const [k,t] of [['token','Token'],['usd','美金']]){const b=button(seg,t,k==='usd'?'按美金（计费）显示':'按 Token 数显示',()=>{if(prefs.spendUnit===k)return;prefs.spendUnit=k;savePrefs();spendSerial++;paint();});b.setAttribute('aria-pressed',String(unit===k));}
      const grid=el('div','spend-grid',null,sec);
      const cell=(label,value,sub,title)=>{const c=el('div','spend-cell',null,grid),lb=el('div','usage-label',label,c);el('div','spend-value',value,c);if(sub){const d=el('div','spend-sub',null,c);String(sub).split(' · ').forEach((part,i)=>{if(i)d.append(' · ');el('span','',part,d);});}if(title){c.title=title;info(lb,'spend:'+label,label+'：'+title,grid);}};
      const tot=sessionSpend(sid,latest);
      if(unit==='token'){
        const lt=turnTokens(latest);
        cell('当前对话',tot.total!==null?(tot.approx?'≈ ':'')+spendTok(tot.total):tot.loading?'读取中…':'—',tot.turns?'本机记录 '+tot.turns+' 轮'+(tot.approx?' · 部分为估算':''):tot.loading?'':'本机暂无记录 · 发消息后开始统计',tot.total!==null?'共 '+fmt(tot.total)+' tokens（输入 '+fmt(tot.input)+' · 输出 '+fmt(tot.output)+'）\n按这个浏览器记录到的每轮用量求和，其他设备上的轮次不在内':'');
        cell('最近一次',lt?(lt.approx?'≈ ':'')+spendTok(lt.total):'—',lt?'输入 '+spendShort(lt.input)+' · 输出 '+spendShort(lt.output)+(lt.reasoning?' · 推理 '+spendShort(lt.reasoning):''):'暂无用量记录',lt?'总 '+fmt(lt.total)+' tokens'+(lt.approx?'（部分调用缺少用量或超过保留上限，为估算值）':''):'');
      }else{
        const st=costState.get(sid),aAt=Date.parse(latest.credits?.at||'')||0,cands=[[latest.credits?.session||null,aAt],[st?.latest?.summary?.session||null,st?.latest?.at||0]].filter(x=>x[0]);
        const newest=cands.reduce((m,x)=>Math.max(m,x[1]),0),rm=!cands.length||Date.now()-newest>600000?spendFetch(sid):spendRemote.get(sid)||null;
        if(rm?.session)cands.push([rm.session,rm.at]);cands.sort((x,y)=>y[1]-x[1]);const sess=cands[0]?.[0]||null,wait=rm?.busy?'正在读取费用接口…':rm?.error||'';
        const su=spendNum(sess?.chargedUsd),cr=latest.credits||null,eu=tot.usd;if(su===null&&eu.estimated)priceRefresh();
        const how=eu.estimated?(eu.estimated===eu.have?'按 token × 单价估算':'其中 '+eu.estimated+' 轮按 token 估算'):'';
        const why=eu.have?[eu.estimated?'没有取得 Arena 的会话计费，按本机记录的每轮相加：有计费数据的轮次直接用，其余按 token 用量 × 模型官方单价估算':'没有取得会话累计，按本机记录的每轮 credits 相加（1 美元 = 1000 credits）',...eu.prices.map(priceText),eu.estimated?'缓存读取按输入价的 10% 计'+(eu.noCache?'；部分调用没有缓存数据，按全价计，可能偏高':''):'',eu.partial?'部分轮次缺少用量记录，未计入':'',eu.noPrice?'有 '+eu.noPrice+' 轮找不到模型单价，未计入':'',eu.estimated?'单价来源：'+priceWhen():'',rm?.error?'费用接口：'+rm.error:'','其他设备上的轮次不在内'].filter(Boolean).join('\n'):'';
        cell('当前对话',su!==null?spendMoney(su):eu.have?'≈ '+spendMoney(eu.usd):rm?.busy?'读取中…':'—',su!==null?[spendNum(sess.messages)!==null?sess.messages+' 条消息':null,spendNum(sess.actualUsd)!==null?'实际成本 '+spendMoney(sess.actualUsd):null].filter(Boolean).join(' · '):eu.have?(how?'本机 '+eu.have+' 轮 · '+how:'本机记录的 '+eu.have+' 轮合计'):eu.noPrice?'没有这个模型的单价':!prefs.showCredits?'费用读取已关闭（设置里开启“本轮消耗”）':wait||'暂无费用数据',su!==null?'Arena 费用接口的会话累计计费，包含其他设备上的消耗':why);
        const local=(latest.calls||[]).length>0;let lc=cr,lu=spendNum(cr?.usd)??(spendNum(cr?.credits)!==null?cr.credits/CREDITS_PER_USD:null),byDom=false,le=null;
        if(lu===null&&rm?.entries){const id=domAssistantId(sid),e=id&&rm.entries[id];const v=e?spendNum(e.usd)??(spendNum(e.credits)!==null?e.credits/CREDITS_PER_USD:null):null;if(v!==null){lu=v;lc=e;byDom=true;}}
        if(lu===null&&local){const u=turnUsd(spendLite(latest),eu.fb);if(u&&u.usd!==null){le=u;lu=u.usd;if(u.kind==='estimate')priceRefresh();}}
        const leSub=le?(le.kind==='estimate'?'按 token 估算'+(le.prices.length===1?' · $'+le.prices[0].in+' / $'+le.prices[0].out:''):le.kind==='record'?'Arena 计费记录':'调用追踪里的成本'):'';
        const leWhy=le?(le.kind==='estimate'?['本轮没有取得 Arena 计费，按 token 用量 × 模型官方单价估算：',...le.prices.map(priceText),'缓存读取按输入价的 10% 计'+(le.noCache?'；本轮没有缓存数据，按全价计，可能偏高':''),le.partial?'部分调用缺少用量或单价，未计入':'','单价来源：'+priceWhen()].filter(Boolean).join('\n'):le.kind==='record'?'本轮 spend.recorded 记录里的计费金额（Arena 服务端写入）':'Trigger 追踪数据里每次模型调用的成本（ai.totalCost）相加'):'';
        cell('最近一次',lu!==null?(le?.kind==='estimate'?'≈ ':'')+spendMoney(lu):'—',lu!==null?(le?leSub:[spendNum(lc?.credits)!==null?Math.round(lc.credits).toLocaleString('zh-CN')+' credits':null,spendNum(lc?.actualUsd)!==null?'实际 '+spendMoney(lc.actualUsd):null].filter(Boolean).join(' · ')):!prefs.showCredits?'费用读取已关闭':local?'等待费用接口（流结束后几秒读取）':wait||(rm?.entries?'费用接口里没找到最后一条回复':'本机暂无这个对话的记录'),lu!==null?(le?leWhy:byDom?'按页面最后一条回复的消息 id 在 Arena 费用接口里查到的计费':'本轮计费（Arena 费用接口）'):'');
      }
    }
    // ---------- 概览（卡片式）：① 身份 ② 本轮实时 ③ 消耗 ④ 技术细节（合并原“更多型号信息 / 推理配置 / 报告用量 / 本轮消耗”） ----------
    function tierBadge(parent,tier,title){if(!tier)return null;const lv=TIER_LV[tier]??0,b=el('span','mc-tier',null,parent);b.dataset.lv=String(lv);el('span','',tier,b);b.title=title||'档位 '+tier;return b;}
    function chipRow(parent){const row_=el('div','mc-chips',null,parent);return (ic,text,tone,title,fn)=>{const b=el(fn?'button':'span','mc-chip',null,row_);if(fn){b.type='button';b.onclick=fn;}if(tone)b.dataset.tone=tone;icon(ic,b);el('span','',text,b);if(title)b.title=title;return b;};}
    function openTech(){moreOpen=true;render();requestAnimationFrame(()=>{const t=body.querySelector('.mc-tech');if(t)body.scrollTo({top:Math.max(0,t.offsetTop-8),behavior:'smooth'});});}
    function heroCard(s,c,live){
      const sid=s.sid,m=mon.bySid.get(sid),best=c.internal||c.response||c.request||c.model,[fam,sfx]=famTier(best),vid=brand.of(best)||brand.of(c.model||'');
      const tier=c.effort?.value||sfx||'';
      const card=el('section','mc-card mc-hero',null,body),top=el('div','mc-top',null,card);
      const lg=vlogo(top,[best,c.model,c.request,c.response].filter(Boolean));if(lg)lg.classList.add('mc-big');
      const nb=el('div','mc-name',null,top);el('span','mc-fam',fam||best,nb);tierBadge(nb,tier,(c.effort?.value?'显式档位参数':'内部名称后缀')+'：'+tier);
      iconButton(top,'copy','复制型号',()=>copy(best));
      el('div','mc-sub',[vid?brand.NAME[vid]||vid:null,turnLabel(s),s.count+' 次调用'+(s.prior?'（此前 '+s.prior+' 次）':'')].filter(Boolean).join(' · '),card);
      const chip=chipRow(card);
      const rs=c.reasoning?.status==='conflict'?null:number(c.reasoning?.value),lc=live&&m?.cur?.n?m.cur:null,think=lc?lc.think>0:rs!==null?rs>0:null;
      if(think!==null){const b=chip('brain',think?(rs?'思考 '+spendShort(rs):'有思考链'):'无思考链',think?'think':'',think?'有可见思考链'+(rs?' · 推理 '+fmt(rs)+' tokens':''):'没有思考链（闭源模型在 Arena 一般不显示）');b.dataset.lv=String(thinkLevel(rs)??(think?2:0));}
      const st=monState(sid);chip(st.icon,st.short,st.tone,st.text,()=>{tab='detector';render();});
      const ac=m?.auto?.calls.find(x=>x.id===c.id);if(ac?.tps)chip('bolt',ac.tps+' tok/s','','输出速度：输出 token ÷ 调用耗时（'+fmt(ac.out)+' tokens / '+((ac.end-ac.at)/1000).toFixed(1)+' 秒）');
      if(s.routing)chip('route','改派','warn',(s.routing.from||'原模型')+' → '+(s.routing.to||'其他模型')+(s.routing.cause?' · '+s.routing.cause:''),openTech);
      if(s.outcome)chip('alert',s.outcome==='failed'?'本轮失败':'空回复','warn',s.outcome==='failed'?'Arena 记录本轮失败':'本轮没有产出回复',openTech);
      const src=el('button','mc-srcs',null,card);src.type='button';src.title='名称来源是否一致（点开看完整名称）';src.onclick=openTech;
      for(const [k,t] of [['request','请求'],['response','响应'],['internal','内部']]){const v=c[k],d=el('span','mc-src',null,src);d.dataset.st=!v?'none':forceEq(v,best)||forceEq(famTier(v)[0],fam)?'ok':'diff';el('i','',null,d);el('span','',t+(v&&d.dataset.st==='diff'?' '+short_(v):''),d);d.title=t+'：'+(v||'未提供');}
    }
    // 本轮步骤条：每根柱 = 一次模型调用，高度 ∝ 消耗（Trace 的输出 + 推理 token，缺时按字数估），深色段 = 思考；颜色区分模型段，⇄ 标出切换点
    function liveCard(sid,s,live){
      const m=sid?mon.bySid.get(sid):null;if(!m||!prefs.monOn)return;
      const auto=m.auto,lc=live&&m.cur?.n?m.cur:null;let tc=[];
      if(auto){const tr=auto.calls.filter(x=>x.src==='trace'),ref=s&&tr.some(x=>x.turn===s.turn&&x.attempt===(s.attempt||1))?{turn:s.turn,attempt:s.attempt||1}:tr.at(-1);if(ref)tc=tr.filter(x=>x.turn===ref.turn&&x.attempt===ref.attempt);}
      if(!lc&&!tc.length)return;
      const card=el('section','mc-card mc-livecard',null,body),head=el('div','mc-head',null,card);icon('pulse',head,'mc-ic');
      el('h3','',live&&m.busy?'本轮实时':'本轮步骤',head);if(live&&m.busy)el('i','mc-live',null,head);
      const n=Math.max(lc?.n||0,tc.length);el('span','eyebrow',n+' 步'+(auto?' · 核对 '+clock(auto.at):''),head);
      const steps=[];
      for(let i=0;i<n;i++){const ls=lc?.steps[i],t=tc[i],tok=t&&Number.isFinite(t.out)?t.out+(Number.isFinite(t.rsn)?t.rsn:0):null,chars=ls?ls.rc+ls.t:null;
        steps.push({v:tok!==null?tok:chars!==null?chars/3.5:0,est:tok===null,rs:tok&&Number.isFinite(t.rsn)?t.rsn/tok:chars?ls.rc/chars:0,think:ls?ls.r>0:!!(t&&t.rsn>0),tools:ls?ls.tools:[],live:!!ls?.live||!!t?.partial,g:t?(auto.callFam||auto.callGroup)?.[t.id]:undefined,tg:t?auto.callGroup?.[t.id]:undefined,name:t?forceBest(t):null});}
      let pg,pt;for(const x of steps){if(x.g===undefined)x.g=pg;else pg=x.g;if(x.tg===undefined)x.tg=pt;else pt=x.tg;}
      const g0=steps.find(x=>x.g!==undefined)?.g??0,max=Math.max(1,...steps.map(x=>x.v)),shown=steps.slice(-48),strip=el('div','mc-strip',null,card);strip.setAttribute('data-noswipe','');if(shown.length<=12)strip.setAttribute('data-few','');
      shown.forEach((x,i)=>{const pv=i?shown[i-1]:null;if(pv&&x.g!==undefined&&pv.g!==undefined&&x.g!==pv.g){const sw=el('span','mc-sw',null,strip);icon('swap',sw);sw.title='在这里换了模型';}else if(pv&&x.tg!==undefined&&pv.tg!==undefined&&x.tg!==pv.tg){const sw=el('span','mc-sw',null,strip);sw.dataset.tier='';icon('gauge',sw);sw.title='同一模型，档位变化';}
        const col=el('div','mc-step',null,strip);col.dataset.g=String((((x.g??g0)-g0)%4+4)%4);if(x.live)col.setAttribute('data-live','');if(x.think)col.setAttribute('data-think','');
        const bar=el('div','bar',null,col),h=Math.max(4,Math.round(46*Math.sqrt(x.v/max)));bar.style.height=h+'px';if(x.rs>0){const r=el('i','',null,bar);r.style.height=Math.max(2,Math.round(h*Math.min(1,x.rs)))+'px';}
        const ic=el('div','mc-step-ic',null,col);if(x.think)icon('brain',ic);else if(x.tools.length)icon('terminal',ic);else el('i','dot',null,ic);
        col.title='第 '+(steps.length-shown.length+i+1)+' 步'+(x.name?' · '+short_(x.name):'')+(x.think?' · 有思考':'')+(x.tools.length?' · 工具 '+x.tools.join(', '):'')+(x.v?' · '+(x.est?'约 ':'')+spendShort(Math.round(x.v))+' token':'');});
      requestAnimationFrame(()=>{strip.scrollLeft=strip.scrollWidth;});
      const st=monState(sid),v=el('div','mc-verdict',null,card);v.dataset.tone=st.tone;icon(st.icon,v);el('span','',st.text,v);
      const fl=lc?m.flags.filter(f=>f.msg===lc.id).slice(-3).reverse():[];
      if(fl.length){const box=el('div','mc-flags',null,card);for(const f of fl)flagRow(box,f.kind.startsWith('think-d')||f.kind.startsWith('think-r')?'gauge':'brain',f.text,flagDetail(f),f.status);}
    }
    const flagDetail=f=>f.status==='confirmed'?'已确认：'+short_(f.from)+' → '+short_(f.to):f.status==='cleared'?'已排除：核对仍是 '+short_(f.same)+'（可能只是档位或思考设置变化）':f.detail;
    function flagRow(box,ic,t,d,st){const r=el('div','mc-flag',null,box);r.dataset.st=st;icon(ic,r);const tx=el('div','grow',null,r);el('div','mc-flag-t',t,tx);if(d)el('div','mc-flag-d',d,tx);el('span','mc-flag-s',{suspect:'核对中',confirmed:'已确认',cleared:'已排除'}[st]||'',r);return r;}
    // 本次调用的 token 构成：缓存读取 / 输入 / 输出 / 推理（推理已含在输出里）
    function callBar(parent,s,c){
      const t=c.tokens||{},inp=number(t.input),out=number(t.output),rs=c.reasoning?.status==='conflict'?null:number(c.reasoning?.value),cr=number(t.cacheRead);if(inp===null&&out===null)return;
      const box=el('div','mc-callbar',null,parent),hd=el('div','mc-callbar-h',null,box);el('span','',s.count>1?'第 '+(s.calls.indexOf(c)+1+s.prior)+' 次调用':'本次调用',hd);el('span','mono',t.total!==null&&t.total!==undefined?fmt(t.total)+' tokens':'',hd);
      const bar=el('div','mc-stack',null,box),seg=(cls,v,title)=>{if(!v||v<0)return;const i=el('i',cls,null,bar);i.style.flexGrow=String(v);i.title=title;};
      if(cr&&inp&&cr<=inp){seg('cache',cr,'缓存读取 '+fmt(cr));seg('in',inp-cr,'输入（未缓存） '+fmt(inp-cr));}else seg('in',inp,'输入 '+fmt(inp));
      const ro=rs&&out&&rs<=out?rs:0;seg('out',(out||0)-ro,'输出 '+fmt((out||0)-ro));seg('rsn',ro||(rs&&rs>(out||0)?rs:0),'推理 '+fmt(rs));
      const lg=el('div','mc-legend',null,box),key=(cls,tt,v)=>{const k=el('span','',null,lg);el('i',cls,null,k);el('span','',tt+' '+(v===null||v===undefined?'—':spendShort(v)),k);};
      key('in','输入',inp);if(cr)key('cache','缓存',cr);key('out','输出',out);key('rsn','推理',rs);
    }
    function techCard(s,c){
      const d=el('details','mc-card mc-tech',null,body);d.open=moreOpen;d.ontoggle=()=>{moreOpen=d.open;};
      const sm=el('summary','',null,d);sm.dataset.focus='技术细节';icon('layers',sm,'mc-ic');el('span','grow','技术细节',sm);el('span','eyebrow','型号来源 · 配置 · 用量 · 标识',sm);icon('chevron',sm,'mc-chev');
      const grp=(ic,t)=>{const x=el('div','mc-group',null,d),h=el('div','mc-gh',null,x);icon(ic,h);el('span','',t,h);return x;};
      const n=grp('cube','型号来源');row(n,'请求型号',c.request);row(n,'响应型号',c.response);
      const later=!c.internal&&s.calls.some(x=>x.internal),internal=c.internal||(s.internalNames.length&&!later?s.internalNames.join(' / '):null),ir=row(n,'内部名称',later?'尚未读到本条消息的记录':internal);if(internal&&(c.internalScope==='turn'||!c.internal)&&s.count>1)el('span','pill','轮次级',ir.lastChild);
      if(!c.request&&c.model&&c.model!=='未提供')row(n,'Trace 标签',c.model);
      if(c.route)row(n,'平台路由',c.route);if(c.adapter)row(n,'协议适配器',c.adapter);if(s.internalNames.length>1)row(n,'本轮内部名',s.internalNames.join('\n'));
      if(s.routing){const rr=row(n,'路由改派',(s.routing.from||'原模型')+' → '+(s.routing.to||'其他模型'),true);el('span','pill',s.routing.cause?(/内容审核/.test(s.routing.cause)?'内容审核拦截':/空内容/.test(s.routing.cause)?'原模型空响应':/首包超时/.test(s.routing.cause)?'首包超时':'原模型失败'):s.routing.waitMs?'原模型 '+Math.round(s.routing.waitMs/1000)+' 秒无输出':'原模型失败',rr.lastChild);if(s.routing.cause)row(n,'改派类型',s.routing.cause);if(s.routing.reason)row(n,'改派原因',s.routing.reason);}
      const e=c.effort,g=grp('gauge','推理配置');row(g,'显式档位',e.value||({conflict:'冲突',unsupported:'不支持'}[e.status])||'未发现');const sx=row(g,'名称后缀',c.hint.value||'—');sx.title=c.hint.status;for(const v of e.budgets)row(g,'推理预算',v===-1?'自动 (-1)':fmt(v)+' tokens');for(const v of e.modes)row(g,'思考模式',v);
      const cn=e.value?(e.evidence.some(x=>x.kind==='effort'&&x.source==='span'&&x.value===e.value)?'档位来自 Span 的明确配置字段。':'档位仅见于页面请求参数。'):e.status==='conflict'?'档位字段存在不同值（'+e.levels.join(' / ')+'）。':e.status==='unsupported'?'档位字段值不在已知枚举内。':'没有明确的档位参数，档位按内部名称后缀显示。';
      el('p','note'+(e.status==='conflict'?' warning':''),cn,g);if(!['内部标签，非显式参数','无后缀','未提供'].includes(c.hint.status))el('p','note warning','后缀：'+c.hint.status,g);
      const u=grp('hash','报告用量'+(s.count>1?' · 第 '+(s.calls.indexOf(c)+1+s.prior)+' 次调用':''));row(u,'输入',fmt(c.tokens.input));row(u,'输出',fmt(c.tokens.output));row(u,'推理',c.reasoning.status==='conflict'?'冲突':fmt(c.reasoning.value));row(u,'总 Token',c.tokens.total!==null?fmt(c.tokens.total):c.totalLabel?'≈ '+c.totalLabel:'—');
      const un={zero:'推理 Token 报告为 0。',missing:'推理 Token 未提供；“—”不是 0。',conflict:'推理 Token 来源冲突，不合并。'}[c.reasoning.status];if(un)el('p','note',un,u);
      if(s.records.length&&(s.count>1||s.records.length>1))for(const rec of s.records)row(u,(s.records.length>1?clock(rec.at)+' ':'')+'本轮记录',['输入 '+fmt(rec.input),'输出 '+fmt(rec.output),'推理 '+fmt(rec.reasoning),'总 '+fmt(rec.total)].join(' · ')+(rec.internal?'\n'+rec.internal:''));
      if(s.outcome){const lc=s.calls.at(-1);row(u,'本轮结果',(s.outcome==='failed'?'Arena 记录失败':'空回复')+(lc?.finish==='length'?' · 推理用尽输出上限':''),false);}
      const i=grp('info','标识');if(s.prompt)row(i,'提问开头','“'+s.prompt+'”',false);if(s.sentAt)row(i,'发送时间',fullStamp(Date.parse(s.sentAt)));row(i,'调用时间',c.at?new Date(c.at).toLocaleString('zh-CN',{hour12:false}):null);row(i,'Run',s.runId);row(i,'Span',c.id);
      creditsSection(s,d);
      if(s.partial)el('p','note warning','部分记录：尚有字段未取得。',d);
    }
    function overview(s,c){
      const live=!historyView&&!turnKey&&liveKey()===s.key;
      heroCard(s,c,live);liveCard(s.sid,s,live);
      spendCard(s);const sp=body.querySelector('.section.spend');if(sp)callBar(sp,s,c);
      techCard(s,c);
    }
    // 本轮消耗：credits 来自页面费用接口；余额变化来自 /api/billing/balance 前后对比（账号级，可能含其他标签页的消耗）
    function creditsSection(s,parent=body){
      if(!prefs.showCredits)return;const cr=s.credits,live=!historyView&&!turnKey&&liveKey()===s.key,st=live?costState.get(s.sid):null;
      const sec=el('section','section credits',null,parent),head=el('div','section-heading',null,sec),crH3=el('h3','','本轮消耗',head);
      const srcText={message:'费用接口 · 按消息 id',new:'费用接口 · 新条目推断',session:'费用接口 · 累计差值'}[cr?.source]||(cr?.balance?'仅余额差值':'');el('span','eyebrow',srcText,head);
      const money=v=>v===null||v===undefined?null:'$'+(+v).toFixed(Math.abs(v)<0.01&&v!==0?5:4);
      if(cr&&cr.credits!==null&&cr.credits!==undefined){
        const values=el('div','usage',null,sec);for(const [k,v]of [['credits',Math.round(cr.credits).toLocaleString('zh-CN')],['计费',money(cr.usd)||'—'],['实际成本',money(cr.actualUsd)||'—']]){const cell=el('div','usage-cell',null,values);el('div','usage-label',k,cell);el('div','usage-value',v,cell);}
        const p=cr.parts[0];if(p&&(p.strategy||p.multiplier!==null||p.margin!==null))row(sec,'定价',[p.strategy,p.multiplier!==null&&p.multiplier!==undefined?'成本 ×'+p.multiplier:null,p.margin!==null&&p.margin!==undefined?'毛利 ×'+p.margin:null,p.fallback?'估算':null].filter(Boolean).join(' · '));
        if(cr.parts.length>1)row(sec,'条目',cr.parts.map(x=>Math.round(x.credits)+' credits').join(' + '));
        if(cr.keys.length)row(sec,'消息 id',cr.keys.join('\n'));
      }else{
        el('p','note',live?(st?.tries?'已读取 '+st.tries+' 次，尚未命中本轮的计费条目；'+(st.tries<COST_DELAYS.length?'稍后继续。':'已停止重试，可点“重读”再试。'):'等待读取（回复结束后约 3 秒）'):'此轮没有取得费用记录。',sec);
      }
      if(cr?.session&&(cr.session.credits!==null||cr.session.chargedUsd!==null))row(sec,'会话累计',(cr.session.credits!==null?Math.round(cr.session.credits).toLocaleString('zh-CN')+' credits':'')+(cr.session.chargedUsd!==null?' · 计费 '+money(cr.session.chargedUsd):'')+(cr.session.actualUsd!==null?' · 实际 '+money(cr.session.actualUsd):'')+(cr.session.messages!==null?' · '+cr.session.messages+' 条消息':''));
      if(cr?.balance)row(sec,'余额变化',cr.balance.before+' → '+cr.balance.after+'（'+(cr.balance.delta>0?'−':cr.balance.delta<0?'+':'')+Math.abs(cr.balance.delta)+'）');
      if(s.costs?.length){const d=el('details','model-more',null,sec),sm=el('summary','',null,d);icon('chevron',sm);el('span','','Trace 花费记录（spend.recorded）',sm);for(const c of s.costs){if(!c.fields.length){el('p','note','该记录里没有识别出费用类字段。',d);continue;}for(const f of c.fields.slice(0,12))row(d,f.key.slice(0,14),String(f.value));}}
      if(cr&&cr.credits!==null&&cr.credits!==undefined&&cr.source!=='message')info(crH3,'credits','推断值：未能按本轮消息 id 命中，改用'+(cr.source==='new'?'基线之后新出现的计费条目':'会话累计的前后差值')+'；若其他标签页同时在此会话发消息，可能不准。',head);
    }
    const SOURCE_TEXT={span:'Span · AI SDK 遥测',record:'用量记录 · token.usage.recorded',providerMetadata:'供应商元数据',页面请求:'页面请求参数'},KIND_TEXT={effort:'显式档位',budget:'预算',mode:'模式',input:'输入 Token',output:'输出 Token',total:'总 Token',reasoning:'推理 Token',token:'Token'};
    function sources(s,c){
      {const srcH=el('h3','section-heading','字段与记录来源',body);info(srcH,'src','路径前缀：\n$.properties.ai.usage.* = AI SDK 字段\n$.properties.gen_ai.usage.* = OpenTelemetry GenAI 标准字段（同一数值的重复上报）\n$.properties.*Tokens（无前缀）= Arena 用量记录，携带内部名称');}
      const ids=el('section','section',null,body);row(ids,'请求型号',c.request);row(ids,'内部名称',c.internal||(s.internalNames.join(' / ')||null));row(ids,'Run',s.runId);row(ids,'Span',c.id);row(ids,'后缀解读',c.hint.status,false);
      const evidence=[...c.effort.evidence,...c.reasoning.evidence,...c.tokenSources],groups=new Map();
      for(const e of evidence){const k=e.source||'span';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(e);}
      for(const [source,items]of groups){el('div','group-title',SOURCE_TEXT[source]||source,body);const seen=new Set();for(const e of items){const k=e.kind+'|'+e.path;if(seen.has(k))continue;seen.add(k);const d=el('div','entry',null,body),top=el('div','entry-top',null,d);el('span','',(KIND_TEXT[e.kind]||'Token')+' · '+(e.value??'不支持的值'),top);el('code','',e.path,d);}}
      if(!groups.has('record')&&s.records.length){el('div','group-title',SOURCE_TEXT.record,body);for(const rec of s.records){for(const [k,v,path]of [['input',rec.input,'inputTokens'],['output',rec.output,'outputTokens'],['reasoning',rec.reasoning,'reasoningTokens'],['total',rec.total,'totalTokens']]){if(v===null)continue;const d=el('div','entry',null,body),top=el('div','entry-top',null,d);el('span','',KIND_TEXT[k]+' · '+v,top);el('span','entry-source',rec.internal||'',top);el('code','','$.properties.'+path,d);}}}
      if(s.costs?.some(c=>c.fields.length)){el('div','group-title','花费记录 · spend.recorded',body);for(const c of s.costs)for(const f of c.fields.slice(0,24)){const d=el('div','entry',null,body),top=el('div','entry-top',null,d);el('span','',f.key+' · '+f.value,top);el('span','entry-source',c.internal||'',top);el('code','',f.path,d);}}
      if(!evidence.length&&!s.records.length)el('p','note','暂无明确配置或用量字段。',body);
      if(Object.keys(c.settings).length){const section=el('section','section',null,body);el('h3','section-heading','其他配置',section);for(const [k,v]of Object.entries(c.settings))row(section,k,v);}
    }
    function rawTab(s,c){
      const raw=rawOf(s),r=selectedRun(),liveRun=r&&r.data?.key===s.key?r:null;
      const h=el('div','section-heading',null,body);el('h3','','原始 Trace 事件',h);el('span','eyebrow',raw.events.length+' 条 · '+(raw.full?'内存完整版':'缓存精简版'),h);
      const ctl=el('div','raw-controls',null,body),filter=el('select','selector',null,ctl);filter.setAttribute('aria-label','筛选事件');for(const [id,text]of [['all','全部事件'],['stream','模型调用'],['usage','用量与花费'],['marker','轮次标记'],['error','错误']]){const o=el('option','',text,filter);o.value=id;}filter.value=rawFilter;filter.onchange=()=>{rawFilter=filter.value;render();};
      button(ctl,'导出本轮','导出本轮原始 Trace 与 Span',()=>{download({tool:'Arena Model Probe Lite',version:VERSION,at:new Date().toISOString(),sid:s.sid,runId:s.runId,turn:s.turn,attempt:s.attempt,full:raw.full,events:raw.events,trace:raw.trace,spans:raw.spans,probe:raw.probe},'amp-lite-raw-'+(s.turn||0)+'-'+Date.now()+'.json');});
      const list=raw.events.filter(e=>rawFilter==='all'||rawFilter==='usage'?rawFilter==='all'||e.kind==='usage'||e.kind==='cost':rawFilter==='error'?e.isError:e.kind===rawFilter);
      const box=el('div','',null,body);if(!list.length)el('p','note','没有匹配的事件。',box);
      for(const e of list.slice(0,400)){const b=button(box,'',e.message||'事件',()=>{if(e.spanId){rawSpan=e.spanId;render();}},'event-row');if(e.kind)b.dataset.kind=e.kind;if(e.spanId&&e.spanId===(rawSpan||c.id))b.setAttribute('data-active','');el('time','',clock(e.at),b);el('span','event-msg',(e.message||'')+(e.model?' · '+e.model:''),b);el('span','event-extra',[e.durationMs!==null&&e.durationMs!==undefined?e.durationMs>=1000?(e.durationMs/1000).toFixed(1)+'s':Math.round(e.durationMs)+'ms':'',e.isPartial?'进行中':'',e.isError?'错误':'',e.isCancelled?'已取消':''].filter(Boolean).join(' '),b);}
      if(list.length>400)el('p','note','仅显示前 400 条；导出可查看全部。',body);
      const spanId=rawSpan||c.id,data=raw.spans[spanId];
      const sh=el('div','section-heading',null,body);sh.style.marginTop='18px';el('h3','','Span 详情',sh);el('code','eyebrow',spanId,sh);
      const sc=el('div','raw-controls',null,body);
      if(data){button(sc,'复制 JSON','复制此 Span 的 JSON',()=>copy(JSON.stringify(data,null,2),'JSON'));const text=JSON.stringify(data,null,2),pre=el('pre','json',text.length>300000?text.slice(0,300000)+'\n…[已截断，导出可查看完整]':text,body);pre.setAttribute('tabindex','0');if(!raw.full)el('p','note','缓存精简版：正文类字段已省略、长字符串已截断。',body);}
      else{el('p','note',liveRun?'此 Span 尚未读取。':'此 Span 的详情不在缓存中。',body);if(liveRun&&liveRun.token)button(sc,'读取此 Span','按需读取此 Span 的详情',()=>{void fetchSpan(liveRun,spanId);say('正在读取…');},'clear');}
      const probe=raw.probe,ph=el('div','section-heading',null,body);ph.style.marginTop='18px';el('h3','','探测：run 记录 / 元数据 / 会话 / 费用',ph);
      const pc=el('div','raw-controls',null,body);if(liveRun?.token)button(pc,'重新探测','用当前令牌重新读取 run 记录、元数据与会话记录',()=>{if(liveRun.probing){say('探测进行中');return;}liveRun.probe=null;void probeRun(liveRun,['run','session','metadata']);say('正在探测…');},'clear');
      if(!probe||!Object.keys(probe).length)el('p','note',liveRun?'尚未探测；读到 Trace 后会自动进行一次。':'此轮没有探测结果。',body);
      else for(const k of ['run','session','metadata','cost']){const v=probe[k];if(!v)continue;const d=el('details','model-more',null,body),sm=el('summary','',null,d);icon('chevron',sm);el('span','',({run:'GET /api/v3/runs/{runId}',session:'GET /api/v1/sessions/{sid}',metadata:'GET /api/v1/runs/{runId}/metadata',cost:'GET /api/chat/{sid}/cost'})[k]+' · HTTP '+(v.status||'—')+(v.error?' · '+v.error:''),sm);if(v.data!==undefined){const text=JSON.stringify(v.data,null,2);el('pre','json probe',text.length>200000?text.slice(0,200000)+'\n…[已截断]':text,d);}}
    }
    // 状态行：新会话限流（create-chat 响应头，localStorage 跨标签页共享）、每日额度、本轮 credits。
    // 限流数字在窗口过后不再隐藏：按上限显示并标注“已重置”（推断值），下次新建会话时更新
    const creditsText=cr=>cr?cr.credits!==null&&cr.credits!==undefined?Math.round(cr.credits).toLocaleString('zh-CN')+' credits':cr.balance&&cr.balance.delta?'余额 '+(cr.balance.delta>0?'−':'+')+Math.abs(cr.balance.delta):null:null;
    function statusBar(){
      const now=Date.now(),items=[],s=view(),sid=sidOf(location.href);
      if(prefs.showQuota){
        for(const [kind,q] of [['chat',quota.chat],['append',quota.append]]){const v=quotaView(q,kind,now,prefs.showQuotaReset);if(!v)continue;const sp=el('span',v.cls);sp.append(v.label+' ');el('strong','',v.value,sp);if(v.tail)sp.append(v.tail);sp.title=v.title;items.push(sp);}
        if(balance){const used=balance.daily?(balance.daily-balance.remaining)/balance.daily:0,stale=balance.refreshAt&&balance.refreshAt<=now,sp=el('span',balance.remaining<=0&&!stale?'blocked':used>=0.5?'low':'');sp.append('额度 ');el('strong','',balance.remaining+(balance.daily!==null?'/'+balance.daily:''),sp);if(balance.refreshAt&&balance.refreshAt>now)sp.append(' · '+until(balance.refreshAt,now)+'重置');else if(stale)sp.append(' · 已到重置时间');sp.title='GET /api/billing/balance · '+new Date(balance.at).toLocaleTimeString('zh-CN',{hour12:false})+' 读取'+(stale?' · 重置时间已过，数字待刷新':'');items.push(sp);}
      }
      if(prefs.showCredits){const r=selectedRun(),hist=!!historyView||!!turnKey,cr=hist?s?.credits:(costState.get(sid)?.credits||s?.credits),text=creditsText(cr);if(text){const sp=el('span','');sp.append(hist?'该轮 ':r?.data&&r.data.revision!==r.revision&&!costState.get(sid)?.credits?'上次 ':'本轮 ');el('strong','',text,sp);sp.title='GET /api/chat/{id}/cost'+(cr.source?' · '+({message:'按本轮消息 id 命中',new:'按新出现的计费条目推断',session:'按会话累计差值推断'}[cr.source]||cr.source):' · 仅余额差值')+(cr.usd!==null&&cr.usd!==undefined?' · 计费 $'+(+cr.usd).toFixed(4):'')+(cr.balance?' · 余额 '+cr.balance.before+' → '+cr.balance.after:'');items.push(sp);}}
      const key=items.map(x=>x.textContent+'|'+x.className+'|'+x.title).join('\n');if(key!==status.dataset.key){status.dataset.key=key;status.replaceChildren(...items);}status.hidden=!items.length||!['overview','sources','raw'].includes(tab);
    }
    function huntTab(){
      const g=gacha.state(),s=gacha.settings(),active=gacha.running();
      const h=el('div','section-heading',null,body),hh3=el('h3','','老虎机抽卡',h);el('span','eyebrow',g?({running:'进行中',stopping:'正在停止',paused:'已停止',stopped:'已停止',hit:'已命中',done:'已完成'}[g.status]||g.status):'未开始',h);
      info(hh3,'hunt','点击发送按钮左侧的厂商名称打开抽卡卡片。\n每抽：新对话 → 发送 → 识别模型 → 改名 → 黑名单归档；未识别时在同一对话重发。\n单标签页运行 · 9.23.2 引擎。',h);
      const cfg=el('div','section',null,body);
      const gs=g?.settings??s;row(cfg,'目标厂商',gs.targetModel||'不限',false);
      row(cfg,'张数',String(gs.maxAttempts));row(cfg,'间隔',(gs.intervalMs/1000)+' 秒');row(cfg,'提示词',gs.prompt,false);
      row(cfg,'归档黑名单',gs.archiveOn?((gs.archiveKeywords||[]).join('、')||'—'):'关闭',false);row(cfg,'路由 Thinking 停止',gs.stopOnThinking?'开启':'关闭',false);
      const ctl=el('div','section',null,body);ctl.style.cssText='display:flex;gap:8px;flex-wrap:wrap';
      button(ctl,'打开抽卡面板','打开发送按钮旁的抽卡面板',()=>window.dispatchEvent(new CustomEvent('amp-native-gacha-open')),'clear');
      if(active)button(ctl,'停止','停止抽卡',()=>{gacha.stop();render();},'clear');
      if(g&&!active)button(ctl,'导出','导出本次抽卡记录（不含令牌）',()=>download(g,'arena-gacha-'+Date.now()+'.json'),'clear');
      if(!g)return;
      const st=el('div','section',null,body);el('h3','section-heading','状态',st);
      row(st,'进度',g.completed+' / '+g.settings.maxAttempts);
      if(g.phase)row(st,'阶段',g.phase,false);if(g.reason)row(st,'原因',g.reason,false);
      const list=el('div','section',null,body);el('h3','section-heading','每一抽',list);
      for(const a of g.attempts.slice().reverse().slice(0,50))row(list,'#'+a.no+' '+new Date(a.at).toLocaleTimeString('zh-CN',{hour12:false}),(a.model||'—')+(a.tier?' · '+a.tier:'')+' · '+({hit:'命中',keep:'保留',archive:a.archived?'已归档':'待归档',other:'保留',skipped:'跳过',error:'中断',cancelled:'取消',abandoned:'中断'}[a.verdict]||'进行中')+(a.resends?' · 重发 '+a.resends:'')+(a.renamed?' · 已改名':'')+(a.note?'\n'+a.note:''));
      const lg=el('details','model-more',null,body),sm=el('summary','',null,lg);icon('chevron',sm);el('span','','运行日志',sm);
      for(const e of g.log.slice(-80).reverse())row(lg,new Date(e.at).toLocaleTimeString('zh-CN',{hour12:false}),e.text,false);
    }
    function settingsTab(){
      const toggle=(parent,title,hint,value,fn)=>{const r=el('div','setting',null,parent),g=el('div','grow',null,r),tt=el('span','setting-title',title,g);if(hint)info(tt,'set:'+title,hint,r);const b=el('button','switch','',r);b.type='button';b.setAttribute('role','switch');b.setAttribute('aria-checked',String(!!value));b.setAttribute('aria-label',title);b.dataset.focus=title;b.onclick=()=>{fn(!value);savePrefs();bodyStamp=[];render();};return b;};
      const sec=el('section','section',null,body);el('h3','section-heading','显示',sec);
      toggle(sec,'隐藏输入框里的文档图标','默认开启：目标按钮左边的纸张图标按钮没什么实际用途，隐藏后更宽松。',prefs.hideDocIcon,v=>{prefs.hideDocIcon=v;if(!v)store(DOC_KEY,'');docIcon();});
      toggle(sec,'长按输入框下拉刷新（手机）','默认开启：长按输入框约 0.3 秒，感到轻震后往下拉，整页跟着往下，顶部圆环随距离画满；画满后松开就刷新，没松手推回去就取消。\n输入框有未发送内容、待发附件、抽卡进行中或本轮还在进行时，圆环变橙色提醒。取代原来左上角的刷新按钮。',prefs.pullRefresh,v=>{prefs.pullRefresh=v;});
      toggle(sec,'手机端 Gemini 风格布局','默认开启，参考 Gemini App（颜色沿用 Arena 原配色）：\n· 顶栏：左上角 ≡ 打开侧栏，旁边是模型名（与左侧卡片一致）；右上角是深色/浅色切换和账号头像；工作区收在右侧屏幕边缘的小把手里（轻点或向左拖出来打开，也可以在对话内容上向左划；上下拖动把手换位置）。\n· 头像外圈是美金余额圆环（剩余 / 总额度）：绿色，低于 20% 变橙，低于 5% 变红。点头像打开账号切换（需账号切换 v1.0.21+），否则打开侧栏。\n· 输入框改成圆角长条：左边 +，右边厂商图标和发送。在厂商图标上上下滑动就是“波轮”：弹出旧版透明样式的厂商滚轮（卡片直接浮在页面上、越往外越淡，没有底板和背景压暗），跟着手指一格格转，松手即选中；抽卡时图标转动、外圈显示进度，每出一张亮出抽到的厂商。\n· 模式切换（Battle / Agent / Side by Side / Direct）挪到左侧抽屉 logo 旁。',prefs.gemLayout,v=>{prefs.gemLayout=v;document.documentElement.toggleAttribute('data-amp-gem',gemOn());if(!v){avatarHost.remove();modeHost.remove();}wsSync();});
      toggle(sec,'工作区收到右侧边缘','默认开启（手机端 Gemini 布局下）：顶栏不再单独放工作区按钮，改成右侧屏幕边缘的小把手。\n· 向左拖出来，或轻点一下，打开工作区：工作区从右侧跟着手指滑出（不再从底部升起）。\n· 收起：在工作区左边缘或标题栏向右划，或点左侧暗处 / ×。\n· 上下拖动把手可以换位置（会记住）。\n· 新对话还没有工作区时把手是灰的；工作区打开、弹窗打开或输入法弹出时，把手自动让开。\n· 安卓全面屏手势会把从屏幕最边缘开始的左划当成“返回”，把手可能拖不动：轻点把手，或者在对话内容上向左划（见下面“对话区向左划拉出工作区”）。\n关闭后恢复顶栏的工作区按钮。',prefs.wsEdge,v=>{prefs.wsEdge=v;wsSync();});
      toggle(sec,'工作区从右侧滑出','默认开启（手机）：工作区一律贴在右侧、从右向左滑出，不再从底部升起——不管是拉右侧把手、点顶栏按钮，还是点消息里的文件打开的，也不管有没有开 Gemini 布局。\n· 收起：在工作区左边缘或标题栏向右划，或点左侧暗处 / ×。\n关闭后恢复 Arena 原来的底部弹出。',prefs.wsRight,v=>{prefs.wsRight=v;wsSync();});
      toggle(sec,'对话区向左划拉出工作区','默认开启（手机）：在对话内容上向左划，工作区就从右侧跟着手指滑出来，松手打开（拉得不够远会弹回去）。\n· 安卓全面屏手势会把从屏幕最边缘开始的左划当成“返回”，右侧把手有时拖不动——从屏幕里面开始划就没这个问题。\n· 只认明显的横向左划：上下滚动、在代码块 / 表格这类能横向滚动的地方、输入框里的手势都照旧。\n· 需要同时开着“工作区从右侧滑出”。',prefs.wsSwipe!==false,v=>{prefs.wsSwipe=v;wsSync();});
      toggle(sec,'输入法弹出时一起上移','默认开启（手机端）：弹出输入法时，对话内容、输入框、底部模型信息栏一起上移——最新的内容跟着输入框推上去，不会被挡住；模型信息栏贴在输入法上方，不再藏起来。\n· 输入框变成多行时，对话内容同样跟着往上推。\n· 关闭后恢复旧行为：打字时隐藏底部信息栏。',prefs.kbResize!==false,v=>{prefs.kbResize=v;try{bar?.sync();}catch{}});
      toggle(sec,'玻璃侧栏（手机）','默认开启：左侧对话列表抽屉变窄，背景改成半透明磨砂玻璃、遮罩调淡，能看到后面的页面。关闭恢复 Arena 原样。',prefs.glassDrawer,v=>{prefs.glassDrawer=v;document.documentElement.toggleAttribute('data-amp-glass',v);});
      toggle(sec,'显示“已重置”的推断限流','默认关闭：如“新会话 10/10 · 已重置”只是按上限推断的数值，不是必要信息。',prefs.showQuotaReset,v=>{prefs.showQuotaReset=v;});
      toggle(sec,'对话名显示本地编号 #N','默认关闭：左侧对话名只显示模型名，避免与加载进度、厂商图标挤在一起。',prefs.showSeq,v=>{prefs.showSeq=v;for(const m of marks.values()){m.span.removeAttribute('data-amp-local-title');m.span.removeAttribute('data-amp-short');}localTitles();});
      toggle(sec,'消息旁显示发送时间','来自消息 id 内的 UUIDv7 时间戳；无法解析时用本机记录的提交时间。',prefs.showSent,v=>{prefs.showSent=v;if(!v)clearSent();});
      toggle(sec,'显示限流与额度状态','新会话限流来自 create-chat 响应头；额度来自 /api/billing/balance。',prefs.showQuota,v=>{prefs.showQuota=v;if(v)void refreshBalance(true);});
      toggle(sec,'读取每轮 credits 消耗','流结束后读取页面自带的费用接口 GET /api/chat/{id}/cost（同源，与页面“N credits”同源数据），并记录提交前后的余额变化。',prefs.showCredits,v=>{prefs.showCredits=v;});
      {const gs=gacha.settings();toggle(sec,'首包看门狗（实验）','默认关闭：发送后 '+gs.watchdogSec+' 秒仍没有任何输出（Arena 约 90 秒会改派别的模型），自动停止并在同一对话重发，最多 '+gs.watchdogRetries+' 次；日志会验证重发后是否仍是原模型。',gs.watchdog,v=>{gacha.saveSettings({watchdog:v});});
        const wr=el('div','setting',null,sec),wg=el('div','grow',null,wr);info(el('span','setting-title','看门狗秒数 / 重试次数',wg),'set:wd','秒数从点发送算起；服务端从开始调用模型才计时（通常晚 5–10 秒），不建议超过 80。',wr);
        const ss=el('select','selector',null,wr);for(const v of [65,70,75,80]){const o=el('option','',v+' 秒',ss);o.value=String(v);}ss.value=String(gs.watchdogSec);ss.onchange=()=>gacha.saveSettings({watchdogSec:+ss.value});
        const rs=el('select','selector',null,wr);for(const v of [1,2,3]){const o=el('option','',v+' 次',rs);o.value=String(v);}rs.value=String(gs.watchdogRetries);rs.onchange=()=>gacha.saveSettings({watchdogRetries:+rs.value});}
      {const gs=gacha.settings();toggle(sec,'首包提示（实验）','默认关闭：手动发送的每条消息末尾自动追加一句，让模型先输出“思考中…”再继续。服务端尽早收到首包就不会因约 90 秒无输出而改派；看门狗也会看到输出而不去停止。抽卡时不追加。代价：模型的隐藏深度思考会变短，分析改为写在正文里；刷新页面后消息里能看到这句。',gs.warmup,v=>{gacha.saveSettings({warmup:v});});
        const pr=el('div','setting',null,sec),pg=el('div','grow',null,pr);el('span','','首包提示内容',pg);const inp=el('textarea','',null,pg);inp.rows=2;inp.value=gs.warmupText;inp.style.cssText='width:100%;margin-top:6px;resize:vertical;font:inherit;font-size:12px;padding:6px 8px;border-radius:8px;border:1px solid var(--amp-line,rgba(128,128,128,.35));background:transparent;color:inherit;box-sizing:border-box';inp.onchange=()=>gacha.saveSettings({warmupText:inp.value.trim()||WARMUP_DEFAULT});inp.onkeydown=e=>e.stopPropagation();}
      toggle(sec,'模型被改派时自动停止生成','默认开启：原模型首包超时被 Arena 换成别的模型后立即停止，避免替补模型长时间推理白白消耗额度；关闭则让替补模型继续回答。\n· 抽卡的那一轮不停：让改派后的模型答完，才能准确识别这一抽是哪个模型。',prefs.stopOnResample,v=>{prefs.stopOnResample=v;savePrefs();});
      toggle(sec,'页面底部信息栏','固定在页面最底部：美金额度、Pulse、credits、限流、当前模型、抽卡进度与更新时间。',prefs.showBar,v=>{prefs.showBar=v;bar?.sync();if(v)void refreshPulse(true);});
      toggle(sec,'为信息栏预留页面空间','把 Arena 的整屏容器高度减去信息栏高度，避免遮挡输入框；遇到布局异常时可关闭。',prefs.barOffset,v=>{prefs.barOffset=v;bar?.sync();});
      const ms=el('section','section',null,body);el('h3','section-heading','实时监控',ms);
      toggle(ms,'实时监控换模型','默认开启：读取页面上的对话状态（不发请求），出现新的步骤或思考链变化时立即补读一次 Trace 核对型号：首步和疑点最短 2.5 秒，普通步骤 5 秒起，长回复逐步放慢到 16 秒，每轮最多 90 次，遇到限流自动暂停。每次读到 Trace 都自动逐次调用比对（不额外请求），换模型会在概览和“监控”页标出。',prefs.monOn,v=>{prefs.monOn=v;savePrefs();mon.serial++;});
      toggle(ms,'疑似换模型时弹出提醒','默认开启：回复先出正文、过一会儿才出现思考链（中途开始思考）这类强信号出现时，顶部弹出“疑似换模型”并立即核对；一开始就在思考不算。抽卡进行中、以及抽卡开出的对话里由抽卡发出的那一轮一律不弹。核对确认后仍由“模型变更提醒”通知，不会重复弹。',prefs.monAlert,v=>{prefs.monAlert=v;savePrefs();});
      toggle(ms,'疑似换模型时自动停止生成','默认关闭：出现强信号时立即停止生成，避免替补模型继续消耗额度。“正文之后才出现思考链”已由抽卡设置里的“路由到 Thinking 时停止”（默认开启）处理，这里额外覆盖“前几步只调用工具、之后才开始思考”等情况（一开始就在思考不算，不会停）。启发式判断，可能误停，确有需要再开启。',prefs.monStop,v=>{prefs.monStop=v;savePrefs();});
      const cloud=el('section','section',null,body);el('h3','section-heading','云端标题',cloud);
      toggle(cloud,'把本地标题同步到 Arena 会话名','使用页面自带的重命名接口（PATCH /api/history/agentic/{id}），会覆盖 Arena 上已有的会话名；每个会话同一标题只发送一次。',prefs.cloudSync,v=>{prefs.cloudSync=v;if(v){const e=catalog.entries.get(sidOf(location.href));if(e)void syncTitle(e);}});
      const fr=el('div','setting',null,cloud),fg=el('div','grow',null,fr);info(el('span','setting-title','同步格式',fg),'set:fmt',prefs.cloudFormat==='name'?'仅内部名称，如 gpt-5.1-codex-high':'编号 + 内部名称，如 #12 gpt-5.1-codex-high',fr);const fs=el('select','selector',null,fr);fs.setAttribute('aria-label','同步格式');for(const [id,text]of [['prefix','#编号 名称'],['name','仅名称']]){const o=el('option','',text,fs);o.value=id;}fs.value=prefs.cloudFormat;fs.onchange=()=>{prefs.cloudFormat=fs.value;savePrefs();bodyStamp=[];render();};
      const cur=catalog.entries.get(sidOf(location.href));const cr=el('div','setting',null,cloud),cg=el('div','grow',null,cr);el('span','','当前会话',cg);el('span','hint',cur?(cur.cloud?.title?'已同步：'+cur.cloud.title:'未同步')+' · 本地：'+cur.title:'尚无本地标题',cg);if(cur)button(cr,'立即同步','把当前会话的本地标题写入 Arena',async()=>{say('正在同步…');const ok=await syncTitle(cur,true);say(ok?'已同步':'未同步，见日志');},'clear').style.marginTop='0';
      const st=el('section','section',null,body),stH=el('h3','section-heading','本地存储',st);const u=usageInfo;info(stH,'set:storage','站点存储总量由浏览器统计，包含 Arena 自身的缓存；本脚本的结构化记录每轮 2–20 KB，日志上限约 1 MB。');
      const grid=el('div','stat-grid',null,st),cell=(label,value,ratio)=>{const c=el('div','stat',null,grid);el('div','stat-label',label,c);el('div','stat-value',value,c);if(ratio!==undefined){const b=el('div','bar',null,c);el('i','',null,b).style.width=Math.min(100,Math.round(ratio*100))+'%';}};
      const mb=v=>v===null||v===undefined?'—':v>=1073741824?(v/1073741824).toFixed(1)+' GB':(v/1048576).toFixed(v>=10485760?0:1)+' MB';
      cell('原始数据（raw 表）',u?mb(u.rawTotal)+' · '+(u.rawCount??'—')+' 轮':'读取中…',u&&u.rawTotal!==null?u.rawTotal/(prefs.rawBudget*1048576):undefined);
      cell('站点存储总量'+(u?.estimate?.quota?' · 上限 '+mb(u.estimate.quota):''),u?.estimate?mb(u.estimate.usage):'—',u?.estimate?.quota?u.estimate.usage/u.estimate.quota:undefined);
      cell('会话 / 轮次',u?(u.counts.sessions??'—')+' / '+(u.counts.turns??'—'):'—');cell('日志 / 发送时间',u?(u.counts.logs??'—')+' / '+(u.counts.sent??'—'):'—');
      const br=el('div','setting',null,st),bg=el('div','grow',null,br);info(el('span','setting-title','原始数据预算',bg),'set:budget','超出后自动删除最旧轮次的原始 Trace 与 Span（结构化记录与标题不受影响）。',br);const bs=el('select','selector',null,br);bs.setAttribute('aria-label','原始数据预算');for(const v of BUDGET_OPTIONS){const o=el('option','',v+' MB',bs);o.value=String(v);}bs.value=String(prefs.rawBudget);bs.onchange=()=>{prefs.rawBudget=Number(bs.value);savePrefs();bodyStamp=[];render();};
      const acts=el('div','log-actions',null,st);acts.style.marginTop='10px';
      const exportAll=async withRaw=>{say('正在整理…');const all=await catalog.exportAll(withRaw);download({tool:'Arena Model Probe Lite',version:VERSION,at:new Date().toISOString(),kind:withRaw?'all-turns-raw':'all-turns',quota,balance,...all},'amp-lite-all-'+(withRaw?'raw-':'')+Date.now()+'.json');say('已导出 '+all.turns.length+' 轮');};
      button(acts,'导出全部轮次','导出所有会话与轮次的结构化记录（不含原始数据）',()=>exportAll(false));button(acts,'导出全部（含原始）','同时附上 raw 表中每轮的原始 Trace 与 Span，文件可能很大',()=>exportAll(true));
      const clr=button(acts,confirmRawClear?'确认清理原始数据':'清理原始数据','删除全部已保存的原始 Trace 与 Span',async()=>{if(!confirmRawClear){confirmRawClear=true;render();return;}await catalog.clearRaw();confirmRawClear=false;usageAt=0;say('已清理');render();});
      if(confirmRawClear)button(acts,'取消','取消清理',()=>{confirmRawClear=false;render();});
    }
    // 用户消息旁的发送时间：写在气泡下方操作格（data-user-message-action，复制按钮所在）的属性上，由 ::before 渲染在按钮左侧；不插入节点
    function clearSent(){for(const [node]of sentMarks){node.removeAttribute('data-amp-sent');node.removeAttribute('title');}sentMarks.clear();}
    function sentTimes(){
      if(!prefs.showSent||document.readyState!=='complete')return;
      for(const [node]of sentMarks)if(!node.isConnected){sentMarks.delete(node);}
      const rows=document.querySelectorAll('[data-chat-message-id] [data-user-message-body-row]'),need=[];let changed=0;
      for(const rowEl of rows){
        const host=rowEl.closest('[data-chat-message-id]'),id=host?.getAttribute('data-chat-message-id'),node=rowEl.querySelector(':scope>[data-user-message-action]')||rowEl;if(!id||sentMarks.has(node))continue;
        const t=uuidTime(id);if(t!==null){apply(node,t,'UUIDv7');continue;}
        if(catalog.sent.has(id)){const at=catalog.sent.get(id);if(at!==null)apply(node,at,'本机记录');continue;}
        if(!sentPending.has(id)){sentPending.add(id);need.push(id);}
      }
      function apply(node,ms,source){const text=stamp(ms);if(!text)return;node.setAttribute('data-amp-sent',text);node.title='发送于 '+fullStamp(ms)+' · '+source;sentMarks.set(node,ms);changed++;}
      if(need.length)void catalog.sentAt(need).then(()=>{for(const id of need)sentPending.delete(id);paint();});
      if(changed)log('debug','发送时间','标注 '+changed+' 条消息');
    }
    ui={host,entry,attach,render,view,spendBrief,show(t){if(typeof t==='string'&&tabs.some(x=>x[0]===t)){tab=t;historyView=null;turnKey=null;}if(compact)expanded=true;else pref.open=true;persist();render();},toggle(){if(compact)expanded=!expanded;else pref.open=!pref.open;persist();render();},destroy(){clearTimeout(toastTimer);try{clearHeader();}catch{}for(const [a,m]of marks)restoreMark(a,m);marks.clear();clearSent();if(aliasSheet)document.adoptedStyleSheets=document.adoptedStyleSheets.filter(s=>s!==aliasSheet);aliasStyle?.remove();applySidebar(null);entry.remove();host.remove();gripHost.remove();foldHost.remove();reloadHost.remove();pull.destroy();glassStyle.remove();document.documentElement.removeAttribute('data-amp-glass');gemStyle.remove();avatarHost.remove();modeHost.remove();drawerMo.disconnect();document.documentElement.removeAttribute('data-amp-gem');document.documentElement.removeAttribute('data-amp-mode-open');}};render();
  }
  // v1.11.73 顶部标题此刻显示的厂商 / 型号 / 档位（老虎机直接用它，保证两边同时、一致）
  let hdrShown=null;
  const mountAll=()=>{mount();mountBar();gachaUi.mount();};
  if(document.body)mountAll();else{const observer=new MutationObserver(()=>{if(document.body){observer.disconnect();mountAll();}});observer.observe(document.documentElement||document,{childList:true,subtree:true});}
  const routeTimer=setInterval(()=>{if(location.pathname!==lastRoute){lastRoute=location.pathname;paint();}ui?.attach();bar?.sync();},500);
  // v1.11.73 启动 / 切换对话时不再干等 500ms 轮询：DOM 一有变化就在下一帧挂载（最多 100ms 一次），页面一次成形，不再一块块跳
  let fastUntil=Date.now()+20000,fastT=0,fastLast=0,fastPath=location.pathname;
  const fastRun=()=>{fastT=0;fastLast=performance.now();try{ui?.attach();}catch{}try{bar?.sync();}catch{}};
  const fastMo=new MutationObserver(()=>{if(location.pathname!==fastPath){fastPath=location.pathname;fastUntil=Date.now()+6000;}if(fastT||Date.now()>fastUntil)return;fastT=setTimeout(()=>requestAnimationFrame(fastRun),Math.max(0,100-(performance.now()-fastLast)));});
  try{fastMo.observe(document.documentElement,{childList:true,subtree:true});}catch{}
  // 状态行里的倒计时与“已重置”切换需要定期重绘；回到前台时顺带刷新额度
  const statusTimer=setInterval(()=>{if(!document.hidden&&(prefs.showQuota||prefs.showCredits))paint();},30000);
  const onVisible=()=>{if(document.hidden)return;paint();if(Date.now()-(balance?.at||0)>BALANCE_INTERVAL)void refreshBalance();};document.addEventListener('visibilitychange',onVisible);
  const resize=()=>{ui?.attach();paint();};window.addEventListener('resize',resize);
  const flushAll=()=>{for(const r of runs.values())if(r.data)save(r.data);void catalog.flush();};window.addEventListener('pagehide',flushAll);
  function stop(){clearInterval(mon.timer);gacha.stop();gacha.setPaint(null);bar?.destroy();bar=null;legacyDisplay.onchange=null;stopped=true;onLog=null;onSnapshot=null;clearInterval(routeTimer);try{fastMo.disconnect();}catch{}clearInterval(routeWatch);clearTimeout(paintTimer);for(const r of runs.values()){clearTimeout(r.timer);r.abort?.abort();r.token=null;}for(const reader of readers){try{reader.cancel().catch(()=>{});}catch{}}if(window.fetch===wrapped)window.fetch=native;if(XO?.open===xhrOpen)XO.open=oldOpen;if(XO?.send===xhrSend)XO.send=oldSend;if(window.EventSource===eventSource)window.EventSource=ES;window.removeEventListener('resize',resize);window.removeEventListener('pagehide',flushAll);window.removeEventListener('storage',onStorage);document.removeEventListener('visibilitychange',onVisible);clearInterval(statusTimer);clearTimeout(balanceTimer);clearTimeout(balanceResetTimer);for(const c of costState.values())clearTimeout(c.timer);ui?.destroy();catalog.destroy();}
  window.__AMP_LITE__={version:VERSION,stop,huntLive(){
    const r=selectedRun();
    const blocks=[quota.chat,quota.append].filter(q=>q?.blocked&&(!q.resetAt||q.resetAt>Date.now()));
    const blocked=Date.now()<cooldown?'接口限流冷却中':blocks.length?'消息额度或速率限制':balance?.remaining===0?'账户剩余额度为零':null;
    return {sid:r?.sid||null,runId:r?.runId||null,submittedAt:r?.submittedAt||0,busy:!!r?.busy,phase:r?.phase||'',finished:!!r?.huntFinishedAt,blocked,
      data:r?.data?{calls:r.data.calls.map(c=>({request:c.request,response:c.response,internal:c.internal,failed:!!c.failed})),internalNames:[...r.data.internalNames],partial:r.data.partial,routing:r.data.routing||null,failover:r.data.failover||null}:null,prompt:r.prompt||null};
  },show(){ui?.show();},snapshot:()=>JSON.parse(JSON.stringify(exported())),exportAll:withRaw=>catalog.exportAll(withRaw===true).then(x=>JSON.parse(JSON.stringify(x)))};
  setTimeout(()=>void refreshBalance(),4000);
  setTimeout(()=>void refreshPulse(),5000);setInterval(()=>{if(!document.hidden)void refreshPulse();},60000);
  gacha.bindCore({rawFetch,runFor,huntLive,clearLimits:()=>{quota={chat:null,append:null};store(KEY+'.quota',quota);cooldown=0;log('info','限流','已更换 IP，清除本地限流记录');paint();},usdQuota:()=>usd,shown:sid=>hdrShown&&hdrShown.sid===sid&&Date.now()-hdrShown.at<5000?hdrShown:null,note:(level,text)=>log(level,'看门狗',text)});
  // 账号切换（配套脚本 Arena-Account-Switch）：限流/脉冲/credits 属于账号，切换后丢弃旧状态并立即重新读取
  function accountReset(reason){
    try{
      quota={chat:null,append:null};store(KEY+'.quota',quota);
      usd=usdShape(load(KEY+'.usd',null));
      pulse=null;try{localStorage.removeItem(KEY+'.pulse');}catch{}
      balance=null;balanceFail=0;try{localStorage.removeItem(KEY+'.balance');}catch{}
      log('info','账号','检测到账号切换（'+reason+'），已清除旧账号的限流状态并重新读取脉冲与额度');paint();
      void refreshPulse(true);void refreshBalance(true);
    }catch(e){log('warn','账号','刷新账号状态失败',e);}
  }
  window.addEventListener('amp:account',()=>accountReset('登录账号变化'));
  try{if(localStorage.getItem('amp.account.dirty')){localStorage.removeItem('amp.account.dirty');setTimeout(()=>accountReset('切换后首次加载'),800);}}catch{}
  window.__AMP_LITE__.mon={state:sid=>mon.bySid.get(sid||sidOf(location.href))||null,verdict:sid=>monState(sid||sidOf(location.href)),tick:monTick,kick:monKick};window.__AMP_LITE__.gacha={start:()=>gacha.start(),stop:gacha.stop,state:gacha.state,peek:gacha.peek,settings:gacha.settings,followModel:gacha.followModel,quietTurn:gacha.quietTurn};window.__AMP_LITE__.usd=()=>usd?{...usd}:null;window.__AMP_LITE__.pulse=()=>pulse?{...pulse}:null;
  log('debug','初始化','v'+VERSION+' 已就绪');
  // 存储自检：写入/读回一个测试键，失败时在日志里给出明确提示（保存无效的常见原因：存储已满、隐私模式、站点数据被清理）。
  try{const t='amp.selftest',v=String(Date.now()),ok=ampStore.set(t,v)&&localStorage.getItem(t)===v;try{localStorage.removeItem(t);}catch{}const u=ampStore.usage();log(ok?'debug':'info','存储',(ok?'本地存储正常':'本地存储不可写，设置将无法保存')+' · 已用约 '+Math.round(u.total/1024)+' KB（本脚本 '+Math.round(u.ours/1024)+' KB）');}catch{}
})();

})();
