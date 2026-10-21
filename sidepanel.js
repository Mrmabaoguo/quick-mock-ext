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

function buildTemplateFromFieldNames(fieldNames) {
  const obj = {};
  fieldNames.forEach((rawKey) => {
    const k = String(rawKey || '').trim();
    if (!k) return;
    if (/^(id|.*Id|.*No|key)$/i.test(k)) {
      obj[k] = 1001;
    } else if (/time|date|day/i.test(k)) {
      obj[k] = '2026-10-21';
    } else if (/num|count|sum|use|amount|price|total|val|rate|qty|weight|score|age|money|angle|height|speed|power|temp|calibration/i.test(k)) {
      obj[k] = 120;
    } else if (/status|state|type/i.test(k)) {
      obj[k] = 1;
    } else {
      obj[k] = '测试数据';
    }
  });
  return obj;
}

function resolveFallbackTemplate(reqItem) {
  if (reqItem && reqItem.schemaSample && typeof reqItem.schemaSample === 'object') {
    return reqItem.schemaSample;
  }
  const pf =
    (reqItem && Array.isArray(reqItem.pageFields) && reqItem.pageFields.length > 0
      ? reqItem.pageFields
      : null) ||
    (capturedRequests.find((r) => Array.isArray(r.pageFields) && r.pageFields.length > 0) || {}).pageFields;
  if (Array.isArray(pf) && pf.length > 0) {
    return buildTemplateFromFieldNames(pf);
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

function expandArraysInJson(rootNode, addCount = 5, reqItem = null) {
  const fallbackTemplate = resolveFallbackTemplate(reqItem);
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
  // 如果原 JSON 里连空数组 [] 或 data 字段都没有（例如 {code: 0, msg: "没有相关数据"}），自动补齐 data 数组结构
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
        const refWithData = capturedRequests.find((r) => r !== reqItem && countPrimaryArrayLength(r.responseBody) > 0);
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
      let nestedListKey = null;
      if (reqItem && /page|Page/.test(reqItem.url)) {
        for (const r of capturedRequests) {
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
  // 若整个 JSON 内没有任何数组，自动将 data/result 设为 []
  if (!foundArray && res && typeof res === 'object' && !Array.isArray(res)) {
    if ('result' in res) res.result = [];
    else res.data = [];
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
    if (countPrimaryArrayLength(sourceText) === 0 && item.originalBody && countPrimaryArrayLength(item.originalBody) > 0) {
      sourceText = item.originalBody;
    }
    const parsed = JSON.parse(sourceText);
    const expanded = expandArraysInJson(parsed, count, item);
    const newBody = JSON.stringify(expanded, null, 2);
    const matchKey = savedRule ? savedRule.matchKey : getDefaultMatchKey(item.url);

    saveRuleAndReload(matchKey, newBody, item);
  } catch (err) {
    openDetailView(item);
  }
}

const jsonTreeView = document.getElementById('jsonTreeView');
const modeTreeBtn = document.getElementById('modeTreeBtn');
const modeRawBtn = document.getElementById('modeRawBtn');
const expandAllBtn = document.getElementById('expandAllBtn');
const collapseAllBtn = document.getElementById('collapseAllBtn');
const openJsonSearchBtn = document.getElementById('openJsonSearchBtn');
const jsonSearchBar = document.getElementById('jsonSearchBar');
const jsonSearchInput = document.getElementById('jsonSearchInput');
const jsonSearchCount = document.getElementById('jsonSearchCount');
const jsonSearchPrevBtn = document.getElementById('jsonSearchPrevBtn');
const jsonSearchNextBtn = document.getElementById('jsonSearchNextBtn');
const jsonSearchCloseBtn = document.getElementById('jsonSearchCloseBtn');

let currentEditorMode = 'raw'; // 'raw' (原本 JSON 文本模式) | 'tree' (树形折叠可改值模式)
let currentTreeData = null;
let searchMatches = [];
let currentMatchIndex = -1;

function setEditorMode(mode) {
  currentEditorMode = mode;
  if (mode === 'tree') {
    modeTreeBtn.classList.add('active');
    modeRawBtn.classList.remove('active');
    jsonTreeView.classList.add('active');
    jsonEditor.classList.remove('active');
    expandAllBtn.style.display = '';
    collapseAllBtn.style.display = '';
    renderJsonTree();
  } else {
    modeRawBtn.classList.add('active');
    modeTreeBtn.classList.remove('active');
    jsonEditor.classList.add('active');
    jsonTreeView.classList.remove('active');
    expandAllBtn.style.display = 'none';
    collapseAllBtn.style.display = 'none';
  }
  if (jsonSearchBar.classList.contains('open') && jsonSearchInput.value.trim()) {
    performJsonSearch(false);
  }
}

if (modeTreeBtn) modeTreeBtn.addEventListener('click', () => setEditorMode('tree'));
if (modeRawBtn) modeRawBtn.addEventListener('click', () => setEditorMode('raw'));

function setByPath(root, path, newVal) {
  let curr = root;
  for (let i = 0; i < path.length - 1; i++) {
    curr = curr[path[i]];
  }
  curr[path[path.length - 1]] = newVal;
}

function renameKeyAtPath(root, path, newKey) {
  if (!newKey || path.length === 0) return false;
  let parent = root;
  for (let i = 0; i < path.length - 1; i++) {
    parent = parent[path[i]];
  }
  const oldKey = path[path.length - 1];
  if (oldKey === newKey || typeof parent !== 'object' || Array.isArray(parent)) return false;
  const entries = Object.entries(parent);
  Object.keys(parent).forEach((k) => delete parent[k]);
  entries.forEach(([k, v]) => {
    parent[k === oldKey ? newKey : k] = v;
  });
  path[path.length - 1] = newKey;
  return true;
}

function parseEditedPrimitive(rawText, origType) {
  const trimmed = rawText.trim();
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (origType === 'number') {
    if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
    return rawText;
  }
  if (origType !== 'string' && trimmed !== '' && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  return rawText;
}

function buildObjectSummary(val, isArr) {
  if (isArr) {
    return `共 ${val.length} 条`;
  }
  const keys = Object.keys(val);
  if (keys.length === 0) return '空对象';
  const preview = keys.slice(0, 2).map((k) => {
    const v = val[k];
    if (v === null) return `${k}: null`;
    if (typeof v === 'object') return `${k}: ${Array.isArray(v) ? '[...]' : '{...}'}`;
    if (typeof v === 'string') return `${k}: "${v.slice(0, 10)}"`;
    return `${k}: ${v}`;
  });
  return preview.join(', ') + (keys.length > 2 ? ', ...' : '');
}

function createTreeNodeDom(keyName, value, path, isLast, depth) {
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
        keyEl.contentEditable = 'true';
        keyEl.spellcheck = false;
        keyEl.textContent = keyName;
        keyEl.title = '点击可修改字段名';
        keyEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            keyEl.blur();
          }
        });
        keyEl.addEventListener('blur', () => {
          const nk = keyEl.textContent.trim();
          if (nk && renameKeyAtPath(currentTreeData, path, nk)) {
            jsonEditor.value = JSON.stringify(currentTreeData, null, 2);
          } else {
            keyEl.textContent = String(path[path.length - 1]);
          }
        });
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
    lineEl.appendChild(inlineCloseEl);

    if (entries.length === 0) {
      inlineCloseEl.style.display = 'inline';
    }

    const toggleCollapse = (e) => {
      e.stopPropagation();
      if (entries.length === 0) return;
      const collapsed = nodeEl.classList.toggle('collapsed');
      toggleEl.textContent = collapsed ? '▶' : '▼';
      if (collapsed) {
        summaryEl.textContent = buildObjectSummary(value, isArr);
      }
    };

    toggleEl.addEventListener('click', toggleCollapse);
    summaryEl.addEventListener('click', toggleCollapse);

    nodeEl.appendChild(lineEl);

    if (entries.length > 0) {
      const childrenEl = document.createElement('div');
      childrenEl.className = 'jt-children';
      entries.forEach(([k, v], idx) => {
        childrenEl.appendChild(createTreeNodeDom(k, v, [...path, k], idx === entries.length - 1, depth + 1));
      });
      nodeEl.appendChild(childrenEl);

      const closeLineEl = document.createElement('div');
      closeLineEl.className = 'jt-line jt-close-line';
      closeLineEl.innerHTML = `<span style="display:inline-block;width:16px;"></span><span class="jt-bracket">${closeB}</span>${isLast ? '' : '<span class="jt-comma">,</span>'}`;
      nodeEl.appendChild(closeLineEl);
    }

    return nodeEl;
  }

  // 基本类型节点（支持直接点击修改）
  const lineEl = document.createElement('div');
  lineEl.className = 'jt-line';

  const spacer = document.createElement('span');
  spacer.style.cssText = 'display:inline-block;width:16px;';
  lineEl.appendChild(spacer);

  if (keyName !== null && typeof keyName === 'string') {
    const keyEl = document.createElement('span');
    keyEl.className = 'jt-key';
    keyEl.contentEditable = 'true';
    keyEl.spellcheck = false;
    keyEl.textContent = keyName;
    keyEl.title = '点击可修改字段名';
    keyEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        keyEl.blur();
      }
    });
    keyEl.addEventListener('blur', () => {
      const nk = keyEl.textContent.trim();
      if (nk && renameKeyAtPath(currentTreeData, path, nk)) {
        jsonEditor.value = JSON.stringify(currentTreeData, null, 2);
      } else {
        keyEl.textContent = String(path[path.length - 1]);
      }
    });
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
  valEl.title = '点击直接修改数值';
  valEl.textContent = value === null ? 'null' : String(value);

  valEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      valEl.blur();
    }
  });

  valEl.addEventListener('input', () => {
    const newVal = parseEditedPrimitive(valEl.textContent, currentType);
    setByPath(currentTreeData, path, newVal);
    jsonEditor.value = JSON.stringify(currentTreeData, null, 2);
    updateArrayInfoLabel();
  });

  valEl.addEventListener('blur', () => {
    const newVal = parseEditedPrimitive(valEl.textContent, currentType);
    currentType = newVal === null ? 'null' : typeof newVal;
    valEl.className = `jt-val jt-val-${currentType}`;
    valEl.textContent = newVal === null ? 'null' : String(newVal);
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

function renderJsonTree() {
  if (!jsonTreeView) return;
  try {
    currentTreeData = JSON.parse(jsonEditor.value);
    jsonTreeView.innerHTML = '';
    const dom = createTreeNodeDom(null, currentTreeData, [], true, 0);
    jsonTreeView.appendChild(dom);
    if (jsonSearchBar.classList.contains('open') && jsonSearchInput.value.trim()) {
      performJsonSearch(false);
    }
  } catch (e) {
    jsonTreeView.innerHTML = `<div style="color:#dc2626;padding:12px;font-size:12px;">当前内容不是有效 JSON，请切换到「JSON 源码」检查语法：<br/>${escapeHtml(e.message)}</div>`;
  }
}

function syncEditorAndTree(newJsonStr) {
  jsonEditor.value = newJsonStr;
  updateArrayInfoLabel();
  if (currentEditorMode === 'tree') {
    renderJsonTree();
  }
}

if (expandAllBtn) {
  expandAllBtn.addEventListener('click', () => {
    jsonTreeView.querySelectorAll('.jt-node.collapsed').forEach((n) => {
      n.classList.remove('collapsed');
      const t = n.querySelector(':scope > .jt-line > .jt-toggle');
      if (t) t.textContent = '▼';
    });
  });
}

if (collapseAllBtn) {
  collapseAllBtn.addEventListener('click', () => {
    const nodes = Array.from(jsonTreeView.querySelectorAll('.jt-node')).filter(
      (n) => Number(n.getAttribute('data-depth') || 0) >= 1
    );
    const allCollapsed = nodes.length > 0 && nodes.every((n) => n.classList.contains('collapsed'));
    nodes.forEach((n) => {
      const depth = Number(n.getAttribute('data-depth') || 0);
      if (allCollapsed ? depth >= 2 : depth >= 1) {
        n.classList.add('collapsed');
        const t = n.querySelector(':scope > .jt-line > .jt-toggle');
        if (t && t.textContent) t.textContent = '▶';
      } else {
        n.classList.remove('collapsed');
        const t = n.querySelector(':scope > .jt-line > .jt-toggle');
        if (t && t.textContent) t.textContent = '▼';
      }
    });
  });
}

// ================= Ctrl+F JSON 内置搜索 =================
function openSearchBar() {
  jsonSearchBar.classList.add('open');
  jsonSearchInput.focus();
  jsonSearchInput.select();
  if (jsonSearchInput.value.trim()) {
    performJsonSearch(true);
  }
}

function closeSearchBar() {
  jsonSearchBar.classList.remove('open');
  clearTreeHighlights();
  searchMatches = [];
  currentMatchIndex = -1;
  jsonSearchCount.textContent = '0/0';
}

function clearTreeHighlights() {
  if (!jsonTreeView) return;
  jsonTreeView.querySelectorAll('.jt-hit, .jt-hit-active').forEach((el) => {
    el.classList.remove('jt-hit', 'jt-hit-active');
  });
}

function performJsonSearch(scrollToMatch = true) {
  const kw = jsonSearchInput.value.trim().toLowerCase();
  clearTreeHighlights();
  searchMatches = [];
  currentMatchIndex = -1;

  if (!kw) {
    jsonSearchCount.textContent = '0/0';
    return;
  }

  if (currentEditorMode === 'tree') {
    const candidates = jsonTreeView.querySelectorAll('.jt-key, .jt-val');
    candidates.forEach((el) => {
      if ((el.textContent || '').toLowerCase().includes(kw)) {
        el.classList.add('jt-hit');
        searchMatches.push(el);
        // 自动展开包含命中项的所有父级折叠节点
        let parent = el.parentElement;
        while (parent && parent !== jsonTreeView) {
          if (parent.classList.contains('jt-node') && parent.classList.contains('collapsed')) {
            parent.classList.remove('collapsed');
            const t = parent.querySelector(':scope > .jt-line > .jt-toggle');
            if (t && t.textContent) t.textContent = '▼';
          }
          parent = parent.parentElement;
        }
      }
    });

    if (searchMatches.length > 0) {
      currentMatchIndex = 0;
      highlightCurrentMatch(scrollToMatch);
    } else {
      jsonSearchCount.textContent = '0/0';
    }
  } else {
    const text = jsonEditor.value.toLowerCase();
    let pos = 0;
    while (pos < text.length) {
      const idx = text.indexOf(kw, pos);
      if (idx === -1) break;
      searchMatches.push(idx);
      pos = idx + kw.length;
    }
    if (searchMatches.length > 0) {
      currentMatchIndex = 0;
      highlightCurrentMatch(scrollToMatch);
    } else {
      jsonSearchCount.textContent = '0/0';
    }
  }
}

function highlightCurrentMatch(scrollToMatch = true) {
  if (searchMatches.length === 0 || currentMatchIndex < 0) {
    jsonSearchCount.textContent = '0/0';
    return;
  }
  jsonSearchCount.textContent = `${currentMatchIndex + 1}/${searchMatches.length}`;

  if (currentEditorMode === 'tree') {
    searchMatches.forEach((el, i) => {
      el.classList.toggle('jt-hit-active', i === currentMatchIndex);
    });
    const targetEl = searchMatches[currentMatchIndex];
    if (scrollToMatch && targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } else {
    const kwLen = jsonSearchInput.value.trim().length;
    const startIdx = searchMatches[currentMatchIndex];
    if (scrollToMatch) {
      const linesBefore = jsonEditor.value.slice(0, startIdx).split('\n').length;
      jsonEditor.scrollTop = Math.max(0, (linesBefore - 5) * 19);
    }
  }
}

function navigateSearch(step) {
  if (searchMatches.length === 0) {
    performJsonSearch(true);
    return;
  }
  currentMatchIndex = (currentMatchIndex + step + searchMatches.length) % searchMatches.length;
  highlightCurrentMatch(true);
}

if (openJsonSearchBtn) openJsonSearchBtn.addEventListener('click', openSearchBar);
if (jsonSearchCloseBtn) jsonSearchCloseBtn.addEventListener('click', closeSearchBar);
if (jsonSearchPrevBtn) jsonSearchPrevBtn.addEventListener('click', () => navigateSearch(-1));
if (jsonSearchNextBtn) jsonSearchNextBtn.addEventListener('click', () => navigateSearch(1));

if (jsonSearchInput) {
  jsonSearchInput.addEventListener('input', () => performJsonSearch(true));
  jsonSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateSearch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchBar();
    }
  });
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    if (detailView.classList.contains('active')) {
      e.preventDefault();
      e.stopPropagation();
      openSearchBar();
    }
  }
});

function openDetailView(item) {
  selectedReq = item;
  const defaultKey = getDefaultMatchKey(item.url);
  const savedRule = mockRules.find((r) => r.matchKey && item.url.includes(r.matchKey));

  matchKeyInput.value = savedRule ? savedRule.matchKey : defaultKey;
  syncEditorAndTree(savedRule ? savedRule.mockBody : (item.responseBody || ''));

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
    if (
      countPrimaryArrayLength(sourceText) === 0 &&
      selectedReq &&
      selectedReq.originalBody &&
      countPrimaryArrayLength(selectedReq.originalBody) > 0
    ) {
      sourceText = selectedReq.originalBody;
    }
    const parsed = JSON.parse(sourceText);
    const expanded = expandArraysInJson(parsed, count, selectedReq);
    syncEditorAndTree(JSON.stringify(expanded, null, 2));
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
      syncEditorAndTree(JSON.stringify(emptied, null, 2));
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
    syncEditorAndTree(selectedReq.originalBody);
    selectedReq.responseBody = selectedReq.originalBody;
    selectedReq.mocked = false;
  } else {
    updateArrayInfoLabel();
  }
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
const powerToggleBtn = document.getElementById('powerToggleBtn');
const powerBtnText = document.getElementById('powerBtnText');
const powerDot = document.getElementById('powerDot');
const powerStatusLabel = document.getElementById('powerStatusLabel');

let currentTriggerKey = 'Shift';
let isRecordingKeyInPanel = false;
let isPluginEnabled = true;

function renderPowerState() {
  if (!powerToggleBtn) return;
  if (isPluginEnabled) {
    powerToggleBtn.classList.remove('off');
    powerDot.classList.remove('off');
    powerStatusLabel.textContent = '插件运行中';
    powerBtnText.textContent = '已开启 (点击关闭)';
  } else {
    powerToggleBtn.classList.add('off');
    powerDot.classList.add('off');
    powerStatusLabel.textContent = '插件已关闭';
    powerBtnText.textContent = '已关闭 (点击开启)';
  }
}

if (powerToggleBtn) {
  powerToggleBtn.addEventListener('click', () => {
    isPluginEnabled = !isPluginEnabled;
    renderPowerState();
    chrome.storage.local.set({ pluginEnabled: isPluginEnabled }, () => {
      showToast(isPluginEnabled ? '插件已开启，正在刷新网页生效' : '插件已关闭，正在刷新恢复原始请求');
      reloadActiveTab();
    });
  });
}

function formatKeyName(k) {
  if (k === 'Control') return 'Ctrl';
  if (k === ' ') return 'Space';
  return k || 'Shift';
}

function renderHotkeyBtn() {
  if (!hotkeyRecordBtn) return;
  if (isRecordingKeyInPanel) {
    hotkeyRecordBtn.textContent = '请按任意键...';
    hotkeyRecordBtn.style.borderColor = '#ef4444';
    hotkeyRecordBtn.style.color = '#dc2626';
  } else {
    hotkeyRecordBtn.textContent = `长按键: ${formatKeyName(currentTriggerKey)}`;
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
    if (changes.pluginEnabled) {
      isPluginEnabled = changes.pluginEnabled.newValue !== false;
      renderPowerState();
    }
    if (changes.mockRules) {
      mockRules = changes.mockRules.newValue || [];
      renderList();
    }
  }
});

chrome.storage.local.get(['mockRules', 'triggerKey', 'pluginEnabled'], (res) => {
  mockRules = res.mockRules || [];
  if (res.triggerKey) {
    currentTriggerKey = res.triggerKey;
  }
  if (typeof res.pluginEnabled === 'boolean') {
    isPluginEnabled = res.pluginEnabled;
  }
  renderHotkeyBtn();
  renderPowerState();
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
