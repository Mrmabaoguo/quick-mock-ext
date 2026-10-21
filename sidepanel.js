let capturedRequests = [];
let mockRules = [];
let selectedReq = null;
let currentTabFilter = 'all'; // 'all' | 'mocked'

const listView = document.getElementById('listView');
const detailView = document.getElementById('detailView');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const reloadPageBtn = document.getElementById('reloadPageBtn');
const tabAll = document.getElementById('tabAll');
const tabMocked = document.getElementById('tabMocked');
const countAll = document.getElementById('countAll');
const countMocked = document.getElementById('countMocked');
const clearRulesBtn = document.getElementById('clearRulesBtn');
const reqListEl = document.getElementById('reqList');

const backToListBtn = document.getElementById('backToListBtn');
const restoreOrigBtn = document.getElementById('restoreOrigBtn');
const matchKeyInput = document.getElementById('matchKeyInput');
const arrayInfoText = document.getElementById('arrayInfoText');
const add1Btn = document.getElementById('add1Btn');
const add5Btn = document.getElementById('add5Btn');
const add10Btn = document.getElementById('add10Btn');
const jsonEditor = document.getElementById('jsonEditor');
const saveMockBtn = document.getElementById('saveMockBtn');
const toastBanner = document.getElementById('toastBanner');

function showToast(text) {
  toastBanner.textContent = text;
  toastBanner.classList.add('show');
  setTimeout(() => {
    toastBanner.classList.remove('show');
  }, 1800);
}

function getShortPath(fullUrl) {
  try {
    const u = new URL(fullUrl);
    return u.pathname + (u.search ? u.search.slice(0, 28) : '');
  } catch {
    return fullUrl;
  }
}

function getDefaultMatchKey(fullUrl) {
  try {
    const u = new URL(fullUrl);
    return u.pathname;
  } catch {
    return fullUrl;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getContentSnippet(bodyText, keyword) {
  if (!keyword || !bodyText) return '';
  const lowerBody = bodyText.toLowerCase();
  const lowerKw = keyword.toLowerCase();
  const idx = lowerBody.indexOf(lowerKw);
  if (idx === -1) return '';

  const start = Math.max(0, idx - 24);
  const end = Math.min(bodyText.length, idx + keyword.length + 32);
  const before = escapeHtml(bodyText.slice(start, idx).replace(/\s+/g, ' '));
  const match = escapeHtml(bodyText.slice(idx, idx + keyword.length));
  const after = escapeHtml(bodyText.slice(idx + keyword.length, end).replace(/\s+/g, ' '));

  return `命中内容: ...${before}<span class="match-mark">${match}</span>${after}...`;
}

function isReqMocked(req) {
  return mockRules.some((r) => r.enabled && r.matchKey && req.url.includes(r.matchKey));
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

function updateArrayInfoLabel() {
  const len = countPrimaryArrayLength(jsonEditor.value);
  if (len >= 0) {
    arrayInfoText.textContent = `检测到数组（当前 ${len} 条）`;
  } else {
    arrayInfoText.textContent = '快速造数（自动识别数组）';
  }
}

function expandArraysInJson(node, addCount = 5, depth = 0) {
  if (depth > 8 || node === null || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    if (node.length > 0) {
      const baseItem = node[node.length - 1];
      const currentLen = node.length;
      for (let i = 1; i <= addCount; i++) {
        const idx = currentLen + i;
        if (typeof baseItem === 'number') {
          node.push(Math.round(baseItem * (0.6 + Math.random() * 0.9) + i * 5));
        } else if (typeof baseItem === 'string') {
          node.push(`${baseItem}_${idx}`);
        } else if (baseItem && typeof baseItem === 'object') {
          const cloned = JSON.parse(JSON.stringify(baseItem));
          Object.keys(cloned).forEach((k) => {
            const val = cloned[k];
            if (typeof val === 'number') {
              if (/id$/i.test(k)) {
                cloned[k] = val + i;
              } else if (!/^(status|type|state|code)$/i.test(k)) {
                cloned[k] = Math.round((val || 50) * (0.5 + Math.random() * 1.1) + i * 3);
              }
            } else if (typeof val === 'string' && val.length < 30) {
              cloned[k] = `${val}_${idx}`;
            }
          });
          node.push(cloned);
        }
      }
    }
    return node;
  }

  Object.keys(node).forEach((key) => {
    node[key] = expandArraysInJson(node[key], addCount, depth + 1);
  });
  return node;
}

// 一键置空接口数据（保留 code/status/msg 外壳，将所有数组清空为 []，将 total 设为 0）
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
  // 若整个 JSON 内没有任何数组，但存在 data/result 字段，则将其置为 []
  if (!foundArray && res && typeof res === 'object' && !Array.isArray(res)) {
    if ('data' in res) res.data = [];
    else if ('result' in res) res.result = [];
  }
  return res;
}

function renderList() {
  const kw = searchInput.value.trim();
  clearSearchBtn.style.display = kw ? 'block' : 'none';
  const lowerKw = kw.toLowerCase();

  const mockedTotal = capturedRequests.filter((item) => isReqMocked(item) || item.mocked).length;
  countAll.textContent = capturedRequests.length;
  countMocked.textContent = mockedTotal;

  const filtered = capturedRequests.filter((item) => {
    const mocked = isReqMocked(item) || item.mocked;
    if (currentTabFilter === 'mocked' && !mocked) return false;
    if (!lowerKw) return true;
    const inUrl = (item.url || '').toLowerCase().includes(lowerKw);
    const inResp = (item.responseBody || '').toLowerCase().includes(lowerKw);
    const inOrig = (item.originalBody || '').toLowerCase().includes(lowerKw);
    return inUrl || inResp || inOrig;
  });

  if (filtered.length === 0) {
    reqListEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">${
          capturedRequests.length === 0 ? '暂未捕获到接口请求' : '没有匹配的接口'
        }</div>
        <div class="empty-desc">${
          capturedRequests.length === 0
            ? '点击右上角“刷新页面”，当前网页发出的所有接口会自动列在这里'
            : `未找到包含 "${escapeHtml(kw)}" 的接口路径或响应文字`
        }</div>
      </div>
    `;
    return;
  }

  reqListEl.innerHTML = '';
  filtered.forEach((item) => {
    const mocked = isReqMocked(item) || item.mocked;
    const card = document.createElement('div');
    card.className = `req-card ${mocked ? 'mocked' : ''}`;

    const snippetHtml = kw
      ? getContentSnippet(item.responseBody || item.originalBody, kw)
      : '';

    const oneLinePreview = escapeHtml(
      (item.responseBody || '').replace(/\s+/g, ' ').slice(0, 88)
    );

    card.innerHTML = `
      <div class="card-row-1">
        <span class="method-badge ${item.method}">${escapeHtml(item.method)}</span>
        <span class="url-text" title="${escapeHtml(item.url)}">${escapeHtml(getShortPath(item.url))}</span>
        ${mocked ? '<span class="status-pill">已改写</span>' : ''}
        <button class="quick-empty-btn" title="免进详情：直接将该接口数据置空并刷新网页">置空</button>
        <button class="quick-plus-btn" title="免进详情：直接将该接口数组扩充5条并刷新网页">+5条</button>
      </div>
      <div class="card-preview">${oneLinePreview}</div>
      ${snippetHtml ? `<div class="match-box">${snippetHtml}</div>` : ''}
    `;

    const quickEmptyBtn = card.querySelector('.quick-empty-btn');
    quickEmptyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      quickEmptyAndSave(item);
    });

    const quickBtn = card.querySelector('.quick-plus-btn');
    quickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      quickExpandAndSave(item, 5);
    });

    card.addEventListener('click', () => openDetailView(item));
    reqListEl.appendChild(card);
  });
}

function quickEmptyAndSave(item) {
  try {
    const savedRule = mockRules.find((r) => r.matchKey && item.url.includes(r.matchKey));
    const sourceText = item.originalBody || (savedRule ? savedRule.mockBody : item.responseBody) || '';
    const parsed = JSON.parse(sourceText);
    const emptied = emptyArraysInJson(parsed);
    const newBody = JSON.stringify(emptied, null, 2);
    const matchKey = savedRule ? savedRule.matchKey : getDefaultMatchKey(item.url);

    saveRuleAndReload(matchKey, newBody, item);
  } catch (err) {
    openDetailView(item);
  }
}

function quickExpandAndSave(item, count) {
  try {
    const savedRule = mockRules.find((r) => r.matchKey && item.url.includes(r.matchKey));
    let sourceText = savedRule ? savedRule.mockBody : (item.responseBody || '');
    // 如果之前被置空了（长度为0），自动基于原始数据扩充
    if (countPrimaryArrayLength(sourceText) === 0 && item.originalBody) {
      sourceText = item.originalBody;
    }
    const parsed = JSON.parse(sourceText);
    const expanded = expandArraysInJson(parsed, count);
    const newBody = JSON.stringify(expanded, null, 2);
    const matchKey = savedRule ? savedRule.matchKey : getDefaultMatchKey(item.url);

    saveRuleAndReload(matchKey, newBody, item);
  } catch (err) {
    openDetailView(item);
  }
}

function openDetailView(item) {
  selectedReq = item;
  const defaultKey = getDefaultMatchKey(item.url);
  const savedRule = mockRules.find((r) => r.matchKey && item.url.includes(r.matchKey));

  matchKeyInput.value = savedRule ? savedRule.matchKey : defaultKey;
  jsonEditor.value = savedRule ? savedRule.mockBody : (item.responseBody || '');
  updateArrayInfoLabel();

  listView.classList.remove('active');
  detailView.classList.add('active');
}

backToListBtn.addEventListener('click', () => {
  detailView.classList.remove('active');
  listView.classList.add('active');
  selectedReq = null;
  renderList();
});

function handleAddRows(count) {
  try {
    let sourceText = jsonEditor.value;
    if (countPrimaryArrayLength(sourceText) === 0 && selectedReq && selectedReq.originalBody) {
      sourceText = selectedReq.originalBody;
    }
    const parsed = JSON.parse(sourceText);
    const expanded = expandArraysInJson(parsed, count);
    jsonEditor.value = JSON.stringify(expanded, null, 2);
    updateArrayInfoLabel();
    showToast(`已追加 ${count} 条数据，点击下方保存即生效`);
  } catch (e) {
    alert('JSON 格式有误，请先检查语法：' + e.message);
  }
}

const emptyDataBtn = document.getElementById('emptyDataBtn');
if (emptyDataBtn) {
  emptyDataBtn.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(jsonEditor.value);
      const emptied = emptyArraysInJson(parsed);
      jsonEditor.value = JSON.stringify(emptied, null, 2);
      updateArrayInfoLabel();
      showToast('已将数据置空，点击下方保存即生效');
    } catch (e) {
      alert('JSON 格式有误，请先检查语法：' + e.message);
    }
  });
}

add1Btn.addEventListener('click', () => handleAddRows(1));
add5Btn.addEventListener('click', () => handleAddRows(5));
add10Btn.addEventListener('click', () => handleAddRows(10));
jsonEditor.addEventListener('input', updateArrayInfoLabel);

function saveRuleAndReload(matchKey, mockBody, reqItem) {
  const idx = mockRules.findIndex((r) => r.matchKey === matchKey);
  const newRule = {
    matchKey,
    method: 'ALL',
    mockBody,
    enabled: true
  };

  if (idx >= 0) {
    mockRules[idx] = newRule;
  } else {
    mockRules.push(newRule);
  }

  if (reqItem) {
    reqItem.responseBody = mockBody;
    reqItem.mocked = true;
  }

  chrome.storage.local.set({ mockRules }, () => {
    showToast('已保存改写并刷新页面');
    renderList();
    reloadActiveTab();
  });
}

saveMockBtn.addEventListener('click', () => {
  const matchKey = matchKeyInput.value.trim();
  const mockBody = jsonEditor.value.trim();
  if (!matchKey) {
    alert('匹配路径不能为空');
    return;
  }
  try {
    JSON.parse(mockBody);
  } catch (e) {
    alert('JSON 格式错误，请检查引号或逗号：\n' + e.message);
    return;
  }
  saveRuleAndReload(matchKey, mockBody, selectedReq);
});

restoreOrigBtn.addEventListener('click', () => {
  if (!selectedReq) return;
  const key = matchKeyInput.value.trim();
  mockRules = mockRules.filter((r) => r.matchKey !== key && !selectedReq.url.includes(r.matchKey));
  if (selectedReq.originalBody) {
    jsonEditor.value = selectedReq.originalBody;
    selectedReq.responseBody = selectedReq.originalBody;
    selectedReq.mocked = false;
  }
  updateArrayInfoLabel();
  chrome.storage.local.set({ mockRules }, () => {
    showToast('已恢复原始数据');
    renderList();
    reloadActiveTab();
  });
});

clearRulesBtn.addEventListener('click', () => {
  mockRules = [];
  capturedRequests.forEach((r) => {
    r.mocked = false;
    if (r.originalBody) r.responseBody = r.originalBody;
  });
  chrome.storage.local.set({ mockRules: [] }, () => {
    showToast('已重置全部改写规则');
    renderList();
    reloadActiveTab();
  });
});

tabAll.addEventListener('click', () => {
  currentTabFilter = 'all';
  tabAll.classList.add('active');
  tabMocked.classList.remove('active');
  renderList();
});

tabMocked.addEventListener('click', () => {
  currentTabFilter = 'mocked';
  tabMocked.classList.add('active');
  tabAll.classList.remove('active');
  renderList();
});

clearSearchBtn.addEventListener('click', () => {
  searchInput.value = '';
  renderList();
  searchInput.focus();
});

function reloadActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      chrome.tabs.reload(tabs[0].id);
    }
  });
}

reloadPageBtn.addEventListener('click', reloadActiveTab);
searchInput.addEventListener('input', renderList);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'NEW_CAPTURED_LIST') {
    capturedRequests = msg.list || [];
    renderList();
  }
});

const hotkeyRecordBtn = document.getElementById('hotkeyRecordBtn');
let currentTriggerKey = 'Shift';
let isRecordingKeyInPanel = false;

function formatKeyName(k) {
  if (k === 'Control') return 'Ctrl';
  if (k === ' ') return 'Space';
  return k || 'Shift';
}

function renderHotkeyBtn() {
  if (!hotkeyRecordBtn) return;
  if (isRecordingKeyInPanel) {
    hotkeyRecordBtn.textContent = '请按任意键... (Esc取消)';
    hotkeyRecordBtn.style.borderColor = '#ef4444';
    hotkeyRecordBtn.style.color = '#dc2626';
  } else {
    hotkeyRecordBtn.textContent = `长按键: ${formatKeyName(currentTriggerKey)} (点击修改)`;
    hotkeyRecordBtn.style.borderColor = 'var(--border-light)';
    hotkeyRecordBtn.style.color = 'var(--text-main)';
  }
}

if (hotkeyRecordBtn) {
  hotkeyRecordBtn.addEventListener('click', () => {
    isRecordingKeyInPanel = true;
    renderHotkeyBtn();
  });
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!isRecordingKeyInPanel) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      isRecordingKeyInPanel = false;
      renderHotkeyBtn();
      return;
    }
    currentTriggerKey = e.key;
    isRecordingKeyInPanel = false;
    renderHotkeyBtn();
    chrome.storage.local.set({ triggerKey: currentTriggerKey });
    showToast(`已将长按触发键设为: ${formatKeyName(currentTriggerKey)}`);
  },
  true
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.triggerKey) {
      currentTriggerKey = changes.triggerKey.newValue || 'Shift';
      renderHotkeyBtn();
    }
    if (changes.mockRules) {
      mockRules = changes.mockRules.newValue || [];
      renderList();
    }
  }
});

chrome.storage.local.get(['mockRules', 'triggerKey'], (res) => {
  mockRules = res.mockRules || [];
  if (res.triggerKey) {
    currentTriggerKey = res.triggerKey;
  }
  renderHotkeyBtn();
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_CAPTURED_LIST' }, (resp) => {
        if (!chrome.runtime.lastError && resp && resp.list) {
          capturedRequests = resp.list;
        }
        renderList();
      });
    } else {
      renderList();
    }
  });
});
