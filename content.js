(function () {
  const capturedList = [];
  let mockRules = [];
  let pluginEnabled = localStorage.getItem('__QUICK_MOCK_ENABLED__') !== '0';
  // 默认长按触发键为 Shift，支持用户按键录制自定义任意键（如 Shift, Alt, Control, KeyQ, Backquote, F2 等）
  let triggerKey = localStorage.getItem('__QM_TRIGGER_KEY__') || 'Shift';
  let isHoldingTrigger = false;
  let isRecordingHotkey = false;
  let hoveredEl = null;
  let shadowRoot = null;
  let highlightBox = null;
  let highlightTag = null;
  let modalBackdrop = null;
  let currentEditingReq = null;

  // 安全检查扩展上下文，彻底杜绝 "Extension context invalidated" 报错
  function isExtContextValid() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
  }

  function safeStorageGet(keys, cb) {
    if (!isExtContextValid()) {
      cb({});
      return;
    }
    try {
      chrome.storage.local.get(keys, (res) => {
        if (chrome.runtime.lastError) {
          cb({});
          return;
        }
        cb(res || {});
      });
    } catch {
      cb({});
    }
  }

  function safeStorageSet(obj, cb) {
    if (obj.triggerKey) {
      try {
        localStorage.setItem('__QM_TRIGGER_KEY__', obj.triggerKey);
      } catch {}
    }
    if (obj.mockRules) {
      try {
        localStorage.setItem('__QUICK_MOCK_RULES__', JSON.stringify(obj.mockRules));
      } catch {}
    }
    if (typeof obj.pluginEnabled === 'boolean') {
      try {
        localStorage.setItem('__QUICK_MOCK_ENABLED__', obj.pluginEnabled ? '1' : '0');
      } catch {}
    }
    if (!isExtContextValid()) {
      if (cb) cb();
      return;
    }
    try {
      chrome.storage.local.set(obj, () => {
        if (cb) cb();
      });
    } catch {
      if (cb) cb();
    }
  }

  function safeSendMessage(msg) {
    if (!isExtContextValid()) return;
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    } catch {}
  }

  function syncRulesToPage(rules) {
    mockRules = rules || [];
    window.postMessage(
      {
        source: 'QUICK_MOCK_CONTENT',
        type: 'SYNC_RULES',
        rules: mockRules
      },
      '*'
    );
  }

  function syncEnabledToPage(enabled) {
    pluginEnabled = enabled !== false;
    try {
      localStorage.setItem('__QUICK_MOCK_ENABLED__', pluginEnabled ? '1' : '0');
    } catch {}
    window.postMessage(
      {
        source: 'QUICK_MOCK_CONTENT',
        type: 'SYNC_ENABLED',
        enabled: pluginEnabled
      },
      '*'
    );
    if (!pluginEnabled) {
      isHoldingTrigger = false;
      hideHighlight();
    }
  }

  safeStorageGet(['mockRules', 'triggerKey', 'pluginEnabled'], (res) => {
    syncRulesToPage(res.mockRules || []);
    if (typeof res.pluginEnabled === 'boolean') {
      syncEnabledToPage(res.pluginEnabled);
    } else {
      syncEnabledToPage(true);
    }
    if (res.triggerKey) {
      triggerKey = res.triggerKey;
      try {
        localStorage.setItem('__QM_TRIGGER_KEY__', triggerKey);
      } catch {}
    }
  });

  if (isExtContextValid()) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (!isExtContextValid() || area !== 'local') return;
        if (changes.mockRules) {
          syncRulesToPage(changes.mockRules.newValue || []);
        }
        if (changes.pluginEnabled) {
          syncEnabledToPage(changes.pluginEnabled.newValue !== false);
        }
        if (changes.triggerKey) {
          triggerKey = changes.triggerKey.newValue || 'Shift';
          try {
            localStorage.setItem('__QM_TRIGGER_KEY__', triggerKey);
          } catch {}
          updateHotkeyBtnText();
        }
      });

      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!isExtContextValid()) return;
        if (msg && msg.type === 'GET_CAPTURED_LIST') {
          window.postMessage({ source: 'QUICK_MOCK_CONTENT', type: 'EXTRACT_PAGE_FIELDS' }, '*');
          const pf = (document.documentElement.getAttribute('data-qm-page-fields') || '')
            .split(',')
            .filter(Boolean);
          if (pf.length > 0) {
            capturedList.forEach((item) => {
              if (!item.pageFields || item.pageFields.length === 0) item.pageFields = pf;
            });
          }
          sendResponse({ list: capturedList });
          return true;
        }
      });
    } catch {}
  }

  function onWindowMessage(event) {
    if (!isExtContextValid()) {
      window.removeEventListener('message', onWindowMessage);
      return;
    }
    if (!event.data || event.data.source !== 'QUICK_MOCK_INJECT' || event.data.type !== 'CAPTURED') {
      return;
    }
    const item = event.data.payload;
    if (!item || !item.url) return;

    const pf = (document.documentElement.getAttribute('data-qm-page-fields') || '')
      .split(',')
      .filter(Boolean);
    if (pf.length > 0 && (!item.pageFields || item.pageFields.length === 0)) {
      item.pageFields = pf;
    }

    const existingIdx = capturedList.findIndex(
      (x) => x.url === item.url && x.method === item.method
    );
    if (existingIdx >= 0) {
      capturedList[existingIdx] = item;
    } else {
      capturedList.unshift(item);
      if (capturedList.length > 150) capturedList.pop();
    }

    safeSendMessage({
      type: 'NEW_CAPTURED_LIST',
      list: capturedList
    });
  }

  window.addEventListener('message', onWindowMessage);

  function formatKeyLabel(keyName) {
    if (keyName === 'Control') return 'Ctrl';
    if (keyName === ' ') return 'Space';
    return keyName;
  }

  function updateHotkeyBtnText() {
    if (!shadowRoot) return;
    const btn = shadowRoot.getElementById('qmHotkeyRecordBtn');
    if (btn && !isRecordingHotkey) {
      btn.textContent = `长按 [${formatKeyLabel(triggerKey)}] (点击更换按键)`;
      btn.classList.remove('recording');
    }
  }

  // ================= 页面内 Shadow DOM 悬浮窗与长按高亮器 =================
  function ensureShadowUI() {
    if (shadowRoot) return;
    const host = document.createElement('div');
    host.id = '__quick_mock_shadow_host__';
    host.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);
    shadowRoot = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .qm-highlight {
        position: fixed;
        pointer-events: none;
        border: 2px solid #2563eb;
        background: rgba(37, 99, 235, 0.08);
        border-radius: 5px;
        z-index: 2147483645;
        display: none;
        transition: all 0.05s ease-out;
      }
      .qm-tag {
        position: fixed;
        pointer-events: none;
        background: #0f172a;
        color: #f8fafc;
        font-size: 12px;
        font-weight: 500;
        padding: 5px 10px;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(15, 23, 42, 0.22);
        z-index: 2147483646;
        display: none;
        white-space: nowrap;
        max-width: 480px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .qm-tag-match {
        color: #60a5fa;
        font-weight: 600;
        margin-left: 6px;
      }
      .qm-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.35);
        backdrop-filter: blur(2px);
        z-index: 2147483647;
        display: none;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }
      .qm-backdrop.open {
        display: flex;
      }
      .qm-modal {
        width: 780px;
        max-width: 94vw;
        height: 600px;
        max-height: 88vh;
        background: #ffffff;
        color: #0f172a;
        border-radius: 12px;
        border: 1px solid #e2e8f0;
        box-shadow: 0 20px 45px rgba(15, 23, 42, 0.18);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .qm-header {
        padding: 12px 16px;
        background: #f8fafc;
        border-bottom: 1px solid #e2e8f0;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .qm-title {
        font-size: 14px;
        font-weight: 600;
        color: #0f172a;
      }
      .qm-header-right {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .qm-label {
        font-size: 12px;
        color: #475569;
        font-weight: 500;
        white-space: nowrap;
      }
      .qm-hotkey-btn {
        height: 28px;
        padding: 0 10px;
        border-radius: 6px;
        border: 1px solid #cbd5e1;
        background: #ffffff;
        color: #0f172a;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
      }
      .qm-hotkey-btn:hover {
        border-color: #2563eb;
        color: #2563eb;
      }
      .qm-hotkey-btn.recording {
        background: #fef2f2;
        border-color: #ef4444;
        color: #dc2626;
        font-weight: 600;
      }
      .qm-select, .qm-input {
        height: 30px;
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 0 8px;
        font-size: 12px;
        color: #0f172a;
        outline: none;
      }
      .qm-select:focus, .qm-input:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.12);
      }
      .qm-close {
        width: 28px;
        height: 28px;
        border: 1px solid #e2e8f0;
        background: #ffffff;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        color: #64748b;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .qm-close:hover {
        background: #f1f5f9;
        color: #0f172a;
      }
      .qm-body {
        flex: 1;
        padding: 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-height: 0;
      }
      .qm-row {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .qm-api-select {
        flex: 1;
        height: 32px;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      .qm-quick-bar {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 8px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px 14px;
        flex-wrap: wrap;
      }
      .qm-replace-group {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .qm-input-sm {
        width: 100px;
        height: 28px;
      }
      .qm-btn {
        height: 28px;
        padding: 0 10px;
        border-radius: 6px;
        border: 1px solid #cbd5e1;
        background: #ffffff;
        color: #0f172a;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.12s;
        white-space: nowrap;
      }
      .qm-btn:hover {
        background: #f1f5f9;
      }
      .qm-btn-soft {
        background: #eff6ff;
        border-color: #bfdbfe;
        color: #2563eb;
        font-weight: 600;
      }
      .qm-btn-soft:hover {
        background: #dbeafe;
      }
      .qm-btn-warn {
        background: #fff7ed;
        border-color: #fed7aa;
        color: #ea580c;
        font-weight: 600;
      }
      .qm-btn-warn:hover {
        background: #ffedd5;
      }
      .qm-textarea {
        flex: 1;
        width: 100%;
        background: #ffffff;
        color: #0f172a;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        padding: 12px;
        font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Consolas, monospace;
        font-size: 12.5px;
        line-height: 1.55;
        resize: none;
        outline: none;
        display: none;
      }
      .qm-textarea.active {
        display: block;
      }
      .qm-textarea:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
      }
      .qm-editor-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .qm-mode-switch {
        display: inline-flex;
        background: #f1f5f9;
        padding: 2px;
        border-radius: 6px;
        gap: 2px;
      }
      .qm-mode-btn {
        border: none;
        background: transparent;
        color: #475569;
        padding: 3px 10px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .qm-mode-btn.active {
        background: #ffffff;
        color: #2563eb;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
      }
      .qm-search-bar {
        display: none;
        align-items: center;
        gap: 6px;
        background: #ffffff;
        border: 1px solid #2563eb;
        border-radius: 6px;
        padding: 4px 10px;
      }
      .qm-search-bar.open {
        display: flex;
      }
      .qm-search-input {
        flex: 1;
        border: none;
        outline: none;
        font-size: 12px;
        color: #0f172a;
      }
      .qm-search-count {
        font-size: 11.5px;
        color: #64748b;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      .qm-tree-view {
        flex: 1;
        width: 100%;
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        padding: 10px 12px;
        font-family: ui-monospace, SFMono-Regular, "JetBrains Mono", Consolas, monospace;
        font-size: 12px;
        line-height: 1.65;
        overflow: auto;
        display: none;
      }
      .qm-tree-view.active {
        display: block;
      }
      .jt-children {
        padding-left: 16px;
        border-left: 1px dashed #e2e8f0;
        margin-left: 6px;
      }
      .jt-node.collapsed > .jt-children,
      .jt-node.collapsed > .jt-close-line {
        display: none;
      }
      .jt-summary {
        display: none;
        color: #94a3b8;
        font-size: 11px;
        background: #f1f5f9;
        padding: 0 6px;
        border-radius: 4px;
        margin: 0 4px;
        cursor: pointer;
        user-select: none;
      }
      .jt-node.collapsed > .jt-line > .jt-summary {
        display: inline-block;
      }
      .jt-node.collapsed > .jt-line > .jt-inline-close {
        display: inline;
      }
      .jt-inline-close {
        display: none;
      }
      .jt-line {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        padding: 1px 4px;
        border-radius: 4px;
      }
      .jt-line:hover {
        background: #f8fafc;
      }
      .jt-toggle {
        display: inline-block;
        width: 14px;
        color: #94a3b8;
        cursor: pointer;
        user-select: none;
        font-size: 10px;
        text-align: center;
        margin-right: 2px;
      }
      .jt-key {
        color: #0f172a;
        font-weight: 600;
        padding: 0 2px;
      }
      .jt-colon {
        color: #94a3b8;
        margin-right: 6px;
      }
      .jt-val {
        padding: 0 4px;
        border-radius: 3px;
        border: 1px solid transparent;
        outline: none;
        min-width: 14px;
        display: inline-block;
        word-break: break-all;
        cursor: text;
      }
      .jt-val:hover {
        border-color: #cbd5e1;
        background: #f8fafc;
      }
      .jt-val:focus {
        border-color: #2563eb;
        background: #ffffff;
        box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
      }
      .jt-val-string { color: #059669; }
      .jt-val-string::before, .jt-val-string::after { content: '"'; color: #94a3b8; }
      .jt-val-number { color: #2563eb; font-weight: 600; }
      .jt-val-boolean { color: #d97706; font-weight: 600; }
      .jt-val-null { color: #94a3b8; font-style: italic; }
      .jt-bracket { color: #64748b; font-weight: 600; }
      .jt-comma { color: #94a3b8; }
      .jt-hit { background: #fef08a !important; color: #0f172a !important; border-radius: 3px; }
      .jt-hit-active { background: #fb923c !important; color: #ffffff !important; border-radius: 3px; }
      .qm-footer {
        padding: 12px 16px;
        background: #f8fafc;
        border-top: 1px solid #e2e8f0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
      }
      .qm-path-box {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
      }
      .qm-path-input {
        flex: 1;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      .qm-btn-primary {
        height: 36px;
        padding: 0 18px;
        background: #2563eb;
        border-color: #2563eb;
        color: #ffffff;
        font-size: 13px;
        font-weight: 600;
      }
      .qm-btn-primary:hover {
        background: #1d4ed8;
      }
    `;

    highlightBox = document.createElement('div');
    highlightBox.className = 'qm-highlight';

    highlightTag = document.createElement('div');
    highlightTag.className = 'qm-tag';

    modalBackdrop = document.createElement('div');
    modalBackdrop.className = 'qm-backdrop';
    modalBackdrop.innerHTML = `
      <div class="qm-modal" id="qmModal">
        <div class="qm-header">
          <div class="qm-title">接口数据直接改写</div>
          <div class="qm-header-right">
            <span class="qm-label">触发方式:</span>
            <button id="qmHotkeyRecordBtn" class="qm-hotkey-btn" title="点击后按键盘任意键即可自定义长按触发键">
              长按 [${formatKeyLabel(triggerKey)}] (点击更换按键)
            </button>
            <button id="qmCloseBtn" class="qm-close" title="关闭 (Esc)">✕</button>
          </div>
        </div>

        <div class="qm-body">
          <div class="qm-row">
            <span class="qm-label">匹配接口:</span>
            <select id="qmApiSelect" class="qm-select qm-api-select"></select>
            <button id="qmRestoreBtn" class="qm-btn">恢复原始数据</button>
          </div>

          <div class="qm-quick-bar">
            <div class="qm-replace-group">
              <span class="qm-label">选中值替换:</span>
              <input id="qmFindInput" class="qm-input qm-input-sm" type="text" placeholder="原文本/数值" />
              <span class="qm-label">→</span>
              <input id="qmReplaceInput" class="qm-input qm-input-sm" type="text" placeholder="改为新内容" />
              <button id="qmDoReplaceBtn" class="qm-btn qm-btn-soft">替换到 JSON</button>
            </div>
            <div class="qm-row">
              <span class="qm-label" id="qmArrayCountLabel">数组扩充:</span>
              <button id="qmEmptyBtn" class="qm-btn qm-btn-warn" title="将数组清空为 [] 并将 total 设为 0">置空数据</button>
              <button id="qmAdd1Btn" class="qm-btn qm-btn-soft">+1 条</button>
              <button id="qmAdd5Btn" class="qm-btn qm-btn-soft">+5 条</button>
              <button id="qmAdd10Btn" class="qm-btn qm-btn-soft">+10 条</button>
            </div>
          </div>

          <div class="qm-editor-toolbar">
            <div class="qm-mode-switch">
              <button id="qmModeRawBtn" class="qm-mode-btn active">JSON 文本 (原本模式)</button>
              <button id="qmModeTreeBtn" class="qm-mode-btn">树形预览 (可收起/改值)</button>
            </div>
            <div class="qm-row">
              <button id="qmExpandAllBtn" class="qm-btn" style="display:none;">展开</button>
              <button id="qmCollapseAllBtn" class="qm-btn" style="display:none;">收起</button>
              <button id="qmOpenSearchBtn" class="qm-btn">搜索 (Ctrl+F)</button>
            </div>
          </div>

          <div id="qmSearchBar" class="qm-search-bar">
            <input id="qmSearchInput" class="qm-search-input" type="text" placeholder="搜索键名或数值 (Enter 下一处 / Esc 关闭)..." />
            <span id="qmSearchCount" class="qm-search-count">0/0</span>
            <button id="qmSearchPrevBtn" class="qm-btn">↑</button>
            <button id="qmSearchNextBtn" class="qm-btn">↓</button>
            <button id="qmSearchCloseBtn" class="qm-btn">×</button>
          </div>

          <textarea id="qmJsonTextarea" class="qm-textarea active" spellcheck="false"></textarea>
          <div id="qmTreeView" class="qm-tree-view"></div>
        </div>

        <div class="qm-footer">
          <div class="qm-path-box">
            <span class="qm-label">拦截路径:</span>
            <input id="qmMatchKeyInput" class="qm-input qm-path-input" type="text" />
          </div>
          <button id="qmSaveReloadBtn" class="qm-btn qm-btn-primary">保存改写并刷新页面生效</button>
        </div>
      </div>
    `;

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(highlightBox);
    shadowRoot.appendChild(highlightTag);
    shadowRoot.appendChild(modalBackdrop);

    bindModalEvents();
  }

  function getShortPath(fullUrl) {
    try {
      const u = new URL(fullUrl);
      return u.pathname + (u.search ? u.search.slice(0, 30) : '');
    } catch {
      return fullUrl;
    }
  }

  function getDefaultMatchKey(fullUrl) {
    try {
      return new URL(fullUrl).pathname;
    } catch {
      return fullUrl;
    }
  }

  function extractTokensAndFindMatches(el) {
    const selectedText = (window.getSelection && window.getSelection().toString().trim()) || '';
    const tokens = [];

    if (selectedText && selectedText.length <= 60) {
      tokens.push(selectedText);
    }

    if (el) {
      const echartsDom = el.closest && el.closest('[_echarts_instance_]');
      if (echartsDom) {
        const kwAttr = echartsDom.getAttribute('data-quickmock-keywords');
        if (kwAttr) {
          kwAttr.split('|').forEach((k) => k.trim() && tokens.push(k.trim()));
        }
      }

      const rawText = (el.innerText || el.textContent || el.value || '').trim();
      if (rawText) {
        const parts = rawText
          .split(/[\r\n\t,，;；:：|\s]+/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 1 && s.length <= 45);
        parts.slice(0, 8).forEach((p) => {
          if (!tokens.includes(p)) tokens.push(p);
        });
      }
    }

    const scored = [];
    let bestMatchedToken = tokens[0] || '';

    capturedList.forEach((req) => {
      const body = (req.responseBody || req.originalBody || '').toLowerCase();
      if (!body) return;
      let score = 0;
      let firstHitToken = '';
      tokens.forEach((tk, idx) => {
        const lowerTk = tk.toLowerCase();
        if (lowerTk && body.includes(lowerTk)) {
          score += idx === 0 ? 10 : 3;
          if (!firstHitToken) firstHitToken = tk;
        }
      });
      if (score > 0) {
        scored.push({ req, score, hitToken: firstHitToken });
      }
    });

    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0 && scored[0].hitToken) {
      bestMatchedToken = scored[0].hitToken;
    }

    return {
      primaryToken: bestMatchedToken,
      matchedReqs: scored.map((s) => s.req)
    };
  }

  function hideHighlight() {
    if (highlightBox) highlightBox.style.display = 'none';
    if (highlightTag) highlightTag.style.display = 'none';
  }

  function updateHoverHighlight(el) {
    ensureShadowUI();
    if (
      !pluginEnabled ||
      !isHoldingTrigger ||
      !el ||
      triggerKey === 'None' ||
      (modalBackdrop && modalBackdrop.classList.contains('open'))
    ) {
      hideHighlight();
      return;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      hideHighlight();
      return;
    }

    highlightBox.style.display = 'block';
    highlightBox.style.top = `${rect.top}px`;
    highlightBox.style.left = `${rect.left}px`;
    highlightBox.style.width = `${rect.width}px`;
    highlightBox.style.height = `${rect.height}px`;

    const { primaryToken, matchedReqs } = extractTokensAndFindMatches(el);
    const shortToken = primaryToken ? `"${primaryToken.slice(0, 18)}"` : '当前区域';
    const matchInfo =
      matchedReqs.length > 0
        ? `匹配到 ${matchedReqs.length} 个接口 (${getShortPath(matchedReqs[0].url)})`
        : capturedList.length > 0
        ? '左键点击打开改写窗'
        : '请先按 F5 刷新捕获接口';

    highlightTag.innerHTML = `[长按 ${formatKeyLabel(triggerKey)} 点选] ${shortToken} <span class="qm-tag-match">${matchInfo}</span>`;
    highlightTag.style.display = 'block';
    const tagTop = Math.max(6, rect.top - 32);
    const tagLeft = Math.min(window.innerWidth - 340, Math.max(6, rect.left));
    highlightTag.style.top = `${tagTop}px`;
    highlightTag.style.left = `${tagLeft}px`;
  }

  function isSameKey(eventKey, targetKey) {
    if (!eventKey || !targetKey || targetKey === 'None') return false;
    return eventKey.toLowerCase() === targetKey.toLowerCase();
  }

  function isTypingInInput(e) {
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
  }

  // 严格的长按（Hold）监听：按住不放激活选区，松手立即退出
  window.addEventListener(
    'keydown',
    (e) => {
      // 如果正在录制自定义快捷键，捕获用户按下的任意键
      if (isRecordingHotkey) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          isRecordingHotkey = false;
          updateHotkeyBtnText();
          return;
        }
        triggerKey = e.key;
        isRecordingHotkey = false;
        safeStorageSet({ triggerKey });
        updateHotkeyBtnText();
        return;
      }

      if (e.key === 'Escape' && modalBackdrop && modalBackdrop.classList.contains('open')) {
        closeModal();
        return;
      }

      if (!pluginEnabled || isTypingInInput(e)) return;

      if (isSameKey(e.key, triggerKey)) {
        if (!isHoldingTrigger) {
          isHoldingTrigger = true;
          if (hoveredEl) updateHoverHighlight(hoveredEl);
        }
      }
    },
    true
  );

  window.addEventListener(
    'keyup',
    (e) => {
      if (isSameKey(e.key, triggerKey)) {
        isHoldingTrigger = false;
        hideHighlight();
      }
    },
    true
  );

  window.addEventListener('blur', () => {
    isHoldingTrigger = false;
    hideHighlight();
  });

  window.addEventListener(
    'mousemove',
    (e) => {
      hoveredEl = e.target;
      // 針對 Shift/Alt/Control 修饰键同步校验物理按键状态，防止失焦漏判
      if (triggerKey === 'Shift' && !e.shiftKey) isHoldingTrigger = false;
      if (triggerKey === 'Alt' && !e.altKey) isHoldingTrigger = false;
      if (triggerKey === 'Control' && !e.ctrlKey) isHoldingTrigger = false;

      if (isHoldingTrigger) {
        updateHoverHighlight(hoveredEl);
      } else {
        hideHighlight();
      }
    },
    true
  );

  // 长按快捷键不放 + 鼠标左键点击（或长按快捷键框选文字松开鼠标）触发弹窗
  window.addEventListener(
    'click',
    (e) => {
      if (!isHoldingTrigger) return;
      if (e.target && e.target.id === '__quick_mock_shadow_host__') return;

      e.preventDefault();
      e.stopPropagation();

      isHoldingTrigger = false;
      hideHighlight();

      openModalForElement(e.target);
    },
    true
  );

  // 根据字段名列表自动推断类型并生成单条模拟对象
  function buildTemplateFromFieldNames(fieldNames) {
    const obj = {};
    fieldNames.forEach((rawKey) => {
      const k = rawKey.trim();
      if (!k) return;
      if (/^(id|.*Id|.*No|key)$/i.test(k)) {
        obj[k] = 1001;
      } else if (/time|date|day/i.test(k)) {
        obj[k] = '2026-10-21';
      } else if (/num|count|sum|use|amount|price|total|val|rate|qty|weight|score|age|money/i.test(k)) {
        obj[k] = 120;
      } else if (/status|state|type/i.test(k)) {
        obj[k] = 1;
      } else {
        obj[k] = '测试数据';
      }
    });
    return obj;
  }

  // 获取空数组的造数模板（优先级：1.接口历史结构缓存 -> 2.页面Vue/React表格列字段 -> 3.通用图表/列表全能模板）
  function resolveFallbackTemplate(reqItem) {
    if (reqItem && reqItem.schemaSample && typeof reqItem.schemaSample === 'object') {
      return reqItem.schemaSample;
    }
    try {
      const cache = JSON.parse(localStorage.getItem('__QM_SCHEMA_CACHE__') || '{}');
      if (reqItem && reqItem.url) {
        const pathname = new URL(reqItem.url, location.origin).pathname;
        if (cache[pathname]) return cache[pathname];
      }
    } catch {}

    const pageFieldsAttr = document.documentElement.getAttribute('data-qm-page-fields') || '';
    if (pageFieldsAttr) {
      const fields = pageFieldsAttr.split(',').filter(Boolean);
      if (fields.length > 0) {
        return buildTemplateFromFieldNames(fields);
      }
    }

    return {
      id: 1,
      name: '测试数据',
      label: '分类项',
      value: 120,
      count: 65,
      createTime: '2026-10-21'
    };
  }

  function cloneAndVaryItem(baseItem, idx) {
    if (typeof baseItem === 'number') {
      return Math.round((baseItem || 50) * (0.6 + Math.random() * 0.9) + idx * 5);
    }
    if (typeof baseItem === 'string') {
      return `${baseItem}_${idx}`;
    }
    if (baseItem && typeof baseItem === 'object') {
      const cloned = JSON.parse(JSON.stringify(baseItem));
      Object.keys(cloned).forEach((k) => {
        const val = cloned[k];
        if (typeof val === 'number') {
          if (/id$/i.test(k)) {
            cloned[k] = val + idx;
          } else if (!/^(status|type|state|code)$/i.test(k)) {
            cloned[k] = Math.round((val || 50) * (0.5 + Math.random() * 1.1) + idx * 3);
          }
        } else if (typeof val === 'string' && val.length < 30) {
          if (/^\d{4}-\d{2}-\d{2}/.test(val)) {
            const day = String(((idx % 28) + 1)).padStart(2, '0');
            cloned[k] = val.replace(/-\d{2}(\s|$)/, `-${day}$1`);
          } else {
            cloned[k] = `${val.replace(/_\d+$/, '')}_${idx}`;
          }
        }
      });
      return cloned;
    }
    return baseItem;
  }

  function expandArraysInJson(rootNode, addCount = 5) {
    const fallbackTemplate = resolveFallbackTemplate(currentEditingReq);
    let expandedAnyArray = false;

    function walk(node, depth) {
      if (depth > 8 || node === null || typeof node !== 'object') return node;

      if (Array.isArray(node)) {
        expandedAnyArray = true;
        const baseItem = node.length > 0 ? node[node.length - 1] : fallbackTemplate;
        const currentLen = node.length;
        for (let i = 1; i <= addCount; i++) {
          node.push(cloneAndVaryItem(baseItem, currentLen + i));
        }
        return node;
      }

      let latestArrayLen = -1;
      Object.keys(node).forEach((key) => {
        node[key] = walk(node[key], depth + 1);
        if (Array.isArray(node[key])) {
          latestArrayLen = node[key].length;
        }
      });

      // 自动同步更新同级的 total / totalCount / count 分页总数
      if (latestArrayLen >= 0) {
        Object.keys(node).forEach((k) => {
          if (typeof node[k] === 'number' && /^(total|totalCount|count|totalElements|recordsTotal)$/i.test(k)) {
            node[k] = Math.max(node[k], latestArrayLen);
          }
        });
      }
      return node;
    }

    const res = walk(rootNode, 0);
    // 如果原 JSON 里连空数组 [] 都没有（例如 {code: 0, msg: "没有相关数据"} 或 data: null），自动补齐 data 数组结构
    if (!expandedAnyArray && res && typeof res === 'object' && !Array.isArray(res)) {
      const arr = [];
      for (let i = 1; i <= addCount; i++) {
        arr.push(cloneAndVaryItem(fallbackTemplate, i));
      }

      // 若 msg 为空数据提示语，自动改为成功提示，并对齐同站有数据接口的成功状态码
      const msgKey = 'msg' in res ? 'msg' : 'message' in res ? 'message' : null;
      if (msgKey && typeof res[msgKey] === 'string' && /没有|暂无|无数据|空|失败|error|fail/i.test(res[msgKey])) {
        res[msgKey] = '操作成功';
        if ('code' in res) {
          const refWithData = capturedList.find((r) => r !== currentEditingReq && countPrimaryArrayLength(r.responseBody) > 0);
          if (refWithData) {
            try {
              const refObj = JSON.parse(refWithData.responseBody);
              if ('code' in refObj && refObj.code !== undefined) res.code = refObj.code;
            } catch {}
          }
        }
      }

      const targetKey = 'result' in res ? 'result' : 'data';
      const existingTarget = res[targetKey];

      if (existingTarget && typeof existingTarget === 'object' && !Array.isArray(existingTarget) && Object.keys(existingTarget).length > 0) {
        // 如果 data 已经是分页对象（如 { total: 0, current: 1 }），在其内部挂载数组
        const listKey =
          'records' in existingTarget || 'current' in existingTarget || 'pages' in existingTarget
            ? 'records'
            : 'rows' in existingTarget
              ? 'rows'
              : 'list';
        existingTarget[listKey] = arr;
        Object.keys(existingTarget).forEach((k) => {
          if (typeof existingTarget[k] === 'number' && /^(total|totalCount|count|totalElements|recordsTotal)$/i.test(k)) {
            existingTarget[k] = arr.length;
          }
        });
      } else {
        // 检查同站其他分页接口是否采用 data.records 或 data.list 结构
        let nestedListKey = null;
        if (currentEditingReq && /page|Page/.test(currentEditingReq.url)) {
          for (const r of capturedList) {
            if (!r.responseBody) continue;
            try {
              const parsedR = JSON.parse(r.responseBody);
              const d = parsedR && (parsedR.data || parsedR.result);
              if (d && typeof d === 'object' && !Array.isArray(d)) {
                if (Array.isArray(d.records)) { nestedListKey = 'records'; break; }
                if (Array.isArray(d.list)) { nestedListKey = 'list'; break; }
                if (Array.isArray(d.rows)) { nestedListKey = 'rows'; break; }
              }
            } catch {}
          }
        }
        if (nestedListKey === 'records') {
          res[targetKey] = { records: arr, total: arr.length, size: Math.max(10, arr.length), current: 1 };
        } else if (nestedListKey === 'list') {
          res[targetKey] = { list: arr, total: arr.length, pageNum: 1, pageSize: Math.max(10, arr.length) };
        } else if (nestedListKey === 'rows') {
          res[targetKey] = { rows: arr, total: arr.length };
        } else {
          res[targetKey] = arr;
        }
      }
    }
    return res;
  }

  function countPrimaryArrayLength(jsonStr) {
    try {
      const obj = JSON.parse(jsonStr);
      let maxLen = -1;
      function walk(node, depth) {
        if (depth > 6 || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          if (node.length > maxLen) maxLen = node.length;
          return;
        }
        Object.keys(node).forEach((k) => walk(node[k], depth + 1));
      }
      walk(obj, 0);
      return maxLen;
    } catch {
      return -1;
    }
  }

  function updateModalArrayLabel() {
    const textarea = shadowRoot.getElementById('qmJsonTextarea');
    const label = shadowRoot.getElementById('qmArrayCountLabel');
    const len = countPrimaryArrayLength(textarea.value);
    label.textContent = len >= 0 ? `数组(${len}条):` : '数组扩充:';
  }

  let modalEditorMode = 'raw';
  let modalTreeData = null;
  let modalSearchMatches = [];
  let modalMatchIndex = -1;

  function setByPath(root, path, newVal) {
    let curr = root;
    for (let i = 0; i < path.length - 1; i++) curr = curr[path[i]];
    curr[path[path.length - 1]] = newVal;
  }

  function parseEditedPrimitive(rawText, origType) {
    const trimmed = rawText.trim();
    if (trimmed === 'null') return null;
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (origType === 'number' && trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
    if (origType !== 'string' && trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
    return rawText;
  }

  function buildObjectSummary(val, isArr) {
    if (isArr) return `共 ${val.length} 条`;
    const keys = Object.keys(val);
    if (keys.length === 0) return '空对象';
    return keys
      .slice(0, 2)
      .map((k) => {
        const v = val[k];
        if (v === null) return `${k}: null`;
        if (typeof v === 'object') return `${k}: ${Array.isArray(v) ? '[...]' : '{...}'}`;
        return `${k}: ${typeof v === 'string' ? `"${v.slice(0, 10)}"` : v}`;
      })
      .join(', ') + (keys.length > 2 ? ', ...' : '');
  }

  function createModalTreeDom(keyName, value, path, isLast, depth) {
    const textarea = shadowRoot.getElementById('qmJsonTextarea');
    if (value !== null && typeof value === 'object') {
      const isArr = Array.isArray(value);
      const openB = isArr ? '[' : '{';
      const closeB = isArr ? ']' : '}';
      const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);

      const nodeEl = document.createElement('div');
      nodeEl.className = 'jt-node';
      nodeEl.setAttribute('data-depth', String(depth));

      const lineEl = document.createElement('div');
      lineEl.className = 'jt-line';

      const toggleEl = document.createElement('span');
      toggleEl.className = 'jt-toggle';
      toggleEl.textContent = entries.length > 0 ? '▼' : '';
      lineEl.appendChild(toggleEl);

      if (keyName !== null) {
        if (typeof keyName === 'string') {
          const keyEl = document.createElement('span');
          keyEl.className = 'jt-key';
          keyEl.textContent = keyName;
          lineEl.appendChild(keyEl);
          const colonEl = document.createElement('span');
          colonEl.className = 'jt-colon';
          colonEl.textContent = ':';
          lineEl.appendChild(colonEl);
        } else {
          const idxEl = document.createElement('span');
          idxEl.style.cssText = 'color:#94a3b8;margin-right:6px;font-size:11px;user-select:none;';
          idxEl.textContent = `#${keyName}`;
          lineEl.appendChild(idxEl);
        }
      }

      const openBracketEl = document.createElement('span');
      openBracketEl.className = 'jt-bracket';
      openBracketEl.textContent = openB;
      lineEl.appendChild(openBracketEl);

      const summaryEl = document.createElement('span');
      summaryEl.className = 'jt-summary';
      summaryEl.textContent = buildObjectSummary(value, isArr);
      lineEl.appendChild(summaryEl);

      const inlineCloseEl = document.createElement('span');
      inlineCloseEl.className = 'jt-bracket jt-inline-close';
      inlineCloseEl.textContent = closeB + (isLast ? '' : ',');
      if (entries.length === 0) inlineCloseEl.style.display = 'inline';
      lineEl.appendChild(inlineCloseEl);

      const toggleCollapse = (e) => {
        e.stopPropagation();
        if (entries.length === 0) return;
        const collapsed = nodeEl.classList.toggle('collapsed');
        toggleEl.textContent = collapsed ? '▶' : '▼';
      };
      toggleEl.addEventListener('click', toggleCollapse);
      summaryEl.addEventListener('click', toggleCollapse);
      nodeEl.appendChild(lineEl);

      if (entries.length > 0) {
        const childrenEl = document.createElement('div');
        childrenEl.className = 'jt-children';
        entries.forEach(([k, v], idx) => {
          childrenEl.appendChild(createModalTreeDom(k, v, [...path, k], idx === entries.length - 1, depth + 1));
        });
        nodeEl.appendChild(childrenEl);

        const closeLineEl = document.createElement('div');
        closeLineEl.className = 'jt-line jt-close-line';
        closeLineEl.innerHTML = `<span style="display:inline-block;width:16px;"></span><span class="jt-bracket">${closeB}</span>${isLast ? '' : '<span class="jt-comma">,</span>'}`;
        nodeEl.appendChild(closeLineEl);
      }
      return nodeEl;
    }

    const lineEl = document.createElement('div');
    lineEl.className = 'jt-line';
    const spacer = document.createElement('span');
    spacer.style.cssText = 'display:inline-block;width:16px;';
    lineEl.appendChild(spacer);

    if (keyName !== null && typeof keyName === 'string') {
      const keyEl = document.createElement('span');
      keyEl.className = 'jt-key';
      keyEl.textContent = keyName;
      lineEl.appendChild(keyEl);
      const colonEl = document.createElement('span');
      colonEl.className = 'jt-colon';
      colonEl.textContent = ':';
      lineEl.appendChild(colonEl);
    }

    let currentType = value === null ? 'null' : typeof value;
    const valEl = document.createElement('span');
    valEl.className = `jt-val jt-val-${currentType}`;
    valEl.contentEditable = 'true';
    valEl.spellcheck = false;
    valEl.textContent = value === null ? 'null' : String(value);

    valEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        valEl.blur();
      }
    });
    valEl.addEventListener('input', () => {
      const newVal = parseEditedPrimitive(valEl.textContent, currentType);
      setByPath(modalTreeData, path, newVal);
      textarea.value = JSON.stringify(modalTreeData, null, 2);
      updateModalArrayLabel();
    });
    lineEl.appendChild(valEl);

    if (!isLast) {
      const commaEl = document.createElement('span');
      commaEl.className = 'jt-comma';
      commaEl.textContent = ',';
      lineEl.appendChild(commaEl);
    }
    return lineEl;
  }

  function renderModalTree() {
    if (!shadowRoot) return;
    const treeView = shadowRoot.getElementById('qmTreeView');
    const textarea = shadowRoot.getElementById('qmJsonTextarea');
    if (!treeView || !textarea) return;
    try {
      modalTreeData = JSON.parse(textarea.value);
      treeView.innerHTML = '';
      treeView.appendChild(createModalTreeDom(null, modalTreeData, [], true, 0));
    } catch (e) {
      treeView.innerHTML = `<div style="color:#dc2626;padding:12px;">JSON 语法有误，请切换至「JSON 源码」修复：${e.message}</div>`;
    }
  }

  function syncModalEditorAndTree(jsonStr) {
    const textarea = shadowRoot.getElementById('qmJsonTextarea');
    textarea.value = jsonStr;
    updateModalArrayLabel();
    if (modalEditorMode === 'tree') renderModalTree();
  }

  function selectRequestInModal(req, highlightWord) {
    currentEditingReq = req;
    const matchKeyInput = shadowRoot.getElementById('qmMatchKeyInput');
    const textarea = shadowRoot.getElementById('qmJsonTextarea');
    const findInput = shadowRoot.getElementById('qmFindInput');
    const replaceInput = shadowRoot.getElementById('qmReplaceInput');

    if (!req) {
      matchKeyInput.value = '';
      syncModalEditorAndTree('// 当前页面尚未捕获到请求，请先按 F5 刷新一次页面');
      return;
    }

    const savedRule = mockRules.find((r) => r.matchKey && req.url.includes(r.matchKey));
    matchKeyInput.value = savedRule ? savedRule.matchKey : getDefaultMatchKey(req.url);
    syncModalEditorAndTree(savedRule ? savedRule.mockBody : req.responseBody || '');

    if (highlightWord) {
      findInput.value = highlightWord;
      replaceInput.value = '';
    }
  }

  function openModalForElement(el) {
    ensureShadowUI();
    const { primaryToken, matchedReqs } = extractTokensAndFindMatches(el);

    const apiSelect = shadowRoot.getElementById('qmApiSelect');
    updateHotkeyBtnText();

    const orderedReqs = [...matchedReqs];
    capturedList.forEach((r) => {
      if (!orderedReqs.includes(r)) orderedReqs.push(r);
    });

    apiSelect.innerHTML = '';
    orderedReqs.forEach((r, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      const isHit = matchedReqs.includes(r);
      opt.textContent = `${isHit ? '[命中该处数据] ' : ''}[${r.method}] ${getShortPath(r.url)}`;
      apiSelect.appendChild(opt);
    });

    apiSelect.onchange = () => {
      const chosen = orderedReqs[Number(apiSelect.value)];
      selectRequestInModal(chosen, primaryToken);
    };

    modalBackdrop.classList.add('open');
    selectRequestInModal(orderedReqs[0] || null, primaryToken);
  }

  function closeModal() {
    isRecordingHotkey = false;
    updateHotkeyBtnText();
    if (modalBackdrop) modalBackdrop.classList.remove('open');
  }

  function bindModalEvents() {
    const modal = shadowRoot.getElementById('qmModal');
    const closeBtn = shadowRoot.getElementById('qmCloseBtn');
    const hotkeyRecordBtn = shadowRoot.getElementById('qmHotkeyRecordBtn');
    const doReplaceBtn = shadowRoot.getElementById('qmDoReplaceBtn');
    const findInput = shadowRoot.getElementById('qmFindInput');
    const replaceInput = shadowRoot.getElementById('qmReplaceInput');
    const textarea = shadowRoot.getElementById('qmJsonTextarea');
    const treeView = shadowRoot.getElementById('qmTreeView');
    const modeTreeBtn = shadowRoot.getElementById('qmModeTreeBtn');
    const modeRawBtn = shadowRoot.getElementById('qmModeRawBtn');
    const expandAllBtn = shadowRoot.getElementById('qmExpandAllBtn');
    const collapseAllBtn = shadowRoot.getElementById('qmCollapseAllBtn');
    const openSearchBtn = shadowRoot.getElementById('qmOpenSearchBtn');
    const searchBar = shadowRoot.getElementById('qmSearchBar');
    const searchInput = shadowRoot.getElementById('qmSearchInput');
    const searchCount = shadowRoot.getElementById('qmSearchCount');
    const searchPrevBtn = shadowRoot.getElementById('qmSearchPrevBtn');
    const searchNextBtn = shadowRoot.getElementById('qmSearchNextBtn');
    const searchCloseBtn = shadowRoot.getElementById('qmSearchCloseBtn');
    const emptyBtn = shadowRoot.getElementById('qmEmptyBtn');
    const add1Btn = shadowRoot.getElementById('qmAdd1Btn');
    const add5Btn = shadowRoot.getElementById('qmAdd5Btn');
    const add10Btn = shadowRoot.getElementById('qmAdd10Btn');
    const restoreBtn = shadowRoot.getElementById('qmRestoreBtn');
    const saveReloadBtn = shadowRoot.getElementById('qmSaveReloadBtn');
    const matchKeyInput = shadowRoot.getElementById('qmMatchKeyInput');

    modal.addEventListener('click', (e) => e.stopPropagation());
    modalBackdrop.addEventListener('click', closeModal);
    closeBtn.addEventListener('click', closeModal);

    modeTreeBtn.addEventListener('click', () => {
      modalEditorMode = 'tree';
      modeTreeBtn.classList.add('active');
      modeRawBtn.classList.remove('active');
      treeView.classList.add('active');
      textarea.classList.remove('active');
      expandAllBtn.style.display = '';
      collapseAllBtn.style.display = '';
      renderModalTree();
    });
    modeRawBtn.addEventListener('click', () => {
      modalEditorMode = 'raw';
      modeRawBtn.classList.add('active');
      modeTreeBtn.classList.remove('active');
      textarea.classList.add('active');
      treeView.classList.remove('active');
      expandAllBtn.style.display = 'none';
      collapseAllBtn.style.display = 'none';
    });

    expandAllBtn.addEventListener('click', () => {
      treeView.querySelectorAll('.jt-node.collapsed').forEach((n) => {
        n.classList.remove('collapsed');
        const t = n.querySelector(':scope > .jt-line > .jt-toggle');
        if (t) t.textContent = '▼';
      });
    });

    collapseAllBtn.addEventListener('click', () => {
      treeView.querySelectorAll('.jt-node').forEach((n) => {
        if (Number(n.getAttribute('data-depth') || 0) >= 1) {
          n.classList.add('collapsed');
          const t = n.querySelector(':scope > .jt-line > .jt-toggle');
          if (t && t.textContent) t.textContent = '▶';
        }
      });
    });

    function runModalSearch() {
      const kw = searchInput.value.trim().toLowerCase();
      treeView.querySelectorAll('.jt-hit, .jt-hit-active').forEach((el) => el.classList.remove('jt-hit', 'jt-hit-active'));
      modalSearchMatches = [];
      modalMatchIndex = -1;
      if (!kw) {
        searchCount.textContent = '0/0';
        return;
      }
      treeView.querySelectorAll('.jt-key, .jt-val').forEach((el) => {
        if ((el.textContent || '').toLowerCase().includes(kw)) {
          el.classList.add('jt-hit');
          modalSearchMatches.push(el);
          let p = el.parentElement;
          while (p && p !== treeView) {
            if (p.classList.contains('jt-node') && p.classList.contains('collapsed')) {
              p.classList.remove('collapsed');
              const t = p.querySelector(':scope > .jt-line > .jt-toggle');
              if (t && t.textContent) t.textContent = '▼';
            }
            p = p.parentElement;
          }
        }
      });
      if (modalSearchMatches.length > 0) {
        modalMatchIndex = 0;
        focusModalMatch();
      } else {
        searchCount.textContent = '0/0';
      }
    }

    function focusModalMatch() {
      if (modalSearchMatches.length === 0) return;
      searchCount.textContent = `${modalMatchIndex + 1}/${modalSearchMatches.length}`;
      modalSearchMatches.forEach((el, i) => el.classList.toggle('jt-hit-active', i === modalMatchIndex));
      modalSearchMatches[modalMatchIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    openSearchBtn.addEventListener('click', () => {
      searchBar.classList.add('open');
      searchInput.focus();
      searchInput.select();
    });
    searchCloseBtn.addEventListener('click', () => {
      searchBar.classList.remove('open');
      treeView.querySelectorAll('.jt-hit, .jt-hit-active').forEach((el) => el.classList.remove('jt-hit', 'jt-hit-active'));
      searchCount.textContent = '0/0';
    });
    searchInput.addEventListener('input', runModalSearch);
    searchPrevBtn.addEventListener('click', () => {
      if (modalSearchMatches.length > 0) {
        modalMatchIndex = (modalMatchIndex - 1 + modalSearchMatches.length) % modalSearchMatches.length;
        focusModalMatch();
      }
    });
    searchNextBtn.addEventListener('click', () => {
      if (modalSearchMatches.length > 0) {
        modalMatchIndex = (modalMatchIndex + 1) % modalSearchMatches.length;
        focusModalMatch();
      }
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && modalSearchMatches.length > 0) {
        e.preventDefault();
        modalMatchIndex = (modalMatchIndex + (e.shiftKey ? -1 : 1) + modalSearchMatches.length) % modalSearchMatches.length;
        focusModalMatch();
      } else if (e.key === 'Escape') {
        searchCloseBtn.click();
      }
    });

    modal.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        searchBar.classList.add('open');
        searchInput.focus();
        searchInput.select();
      }
    });

    // 点击按钮录制任意按键
    hotkeyRecordBtn.addEventListener('click', () => {
      isRecordingHotkey = true;
      hotkeyRecordBtn.textContent = '请按下键盘任意键... (Esc取消)';
      hotkeyRecordBtn.classList.add('recording');
    });

    doReplaceBtn.addEventListener('click', () => {
      const findStr = findInput.value;
      const repStr = replaceInput.value;
      if (!findStr) return;
      syncModalEditorAndTree(textarea.value.split(findStr).join(repStr));
      findInput.value = repStr;
    });

    function emptyArraysInJson(node) {
      let foundArray = false;
      function walk(curr, depth) {
        if (depth > 8 || curr === null || typeof curr !== 'object') return curr;
        if (Array.isArray(curr)) {
          foundArray = true;
          return [];
        }
        Object.keys(curr).forEach((k) => {
          const val = curr[k];
          if (Array.isArray(val)) {
            foundArray = true;
            curr[k] = [];
          } else if (typeof val === 'number' && /^(total|totalCount|count|totalElements|recordsTotal)$/i.test(k)) {
            curr[k] = 0;
          } else if (val && typeof val === 'object') {
            curr[k] = walk(val, depth + 1);
          }
        });
        return curr;
      }
      const res = walk(node, 0);
      if (!foundArray && res && typeof res === 'object' && !Array.isArray(res)) {
        if ('result' in res) res.result = [];
        else res.data = [];
      }
      return res;
    }

    if (emptyBtn) {
      emptyBtn.addEventListener('click', () => {
        try {
          const parsed = JSON.parse(textarea.value);
          const emptied = emptyArraysInJson(parsed);
          syncModalEditorAndTree(JSON.stringify(emptied, null, 2));
        } catch (e) {
          alert('JSON 语法错误，请检查引号或逗号：' + e.message);
        }
      });
    }

    function addRowsInModal(count) {
      try {
        let sourceText = textarea.value;
        if (
          countPrimaryArrayLength(sourceText) === 0 &&
          currentEditingReq &&
          currentEditingReq.originalBody &&
          countPrimaryArrayLength(currentEditingReq.originalBody) > 0
        ) {
          sourceText = currentEditingReq.originalBody;
        }
        const parsed = JSON.parse(sourceText);
        const expanded = expandArraysInJson(parsed, count);
        syncModalEditorAndTree(JSON.stringify(expanded, null, 2));
      } catch (e) {
        alert('JSON 语法错误，请检查引号或逗号：' + e.message);
      }
    }

    add1Btn.addEventListener('click', () => addRowsInModal(1));
    add5Btn.addEventListener('click', () => addRowsInModal(5));
    add10Btn.addEventListener('click', () => addRowsInModal(10));
    textarea.addEventListener('input', updateModalArrayLabel);

    restoreBtn.addEventListener('click', () => {
      if (!currentEditingReq) return;
      const key = matchKeyInput.value.trim();
      const updated = mockRules.filter(
        (r) => r.matchKey !== key && !currentEditingReq.url.includes(r.matchKey)
      );
      syncRulesToPage(updated);
      safeStorageSet({ mockRules: updated }, () => {
        location.reload();
      });
    });

    saveReloadBtn.addEventListener('click', () => {
      const matchKey = matchKeyInput.value.trim();
      const mockBody = textarea.value.trim();
      if (!matchKey) {
        alert('拦截路径不能为空');
        return;
      }
      try {
        JSON.parse(mockBody);
      } catch (e) {
        alert('JSON 格式错误，请检查引号或逗号：\n' + e.message);
        return;
      }

      const updated = [...mockRules];
      const idx = updated.findIndex((r) => r.matchKey === matchKey);
      const newRule = { matchKey, method: 'ALL', mockBody, enabled: true };
      if (idx >= 0) updated[idx] = newRule;
      else updated.push(newRule);

      syncRulesToPage(updated);
      safeStorageSet({ mockRules: updated }, () => {
        location.reload();
      });
    });
  }
})();
