(function () {
  const STORAGE_KEY = '__QUICK_MOCK_RULES__';
  const ENABLED_KEY = '__QUICK_MOCK_ENABLED__';
  const SCHEMA_CACHE_KEY = '__QM_SCHEMA_CACHE__';
  const MAX_SCHEMA_ENTRIES = 100;
  const origJsonParse = JSON.parse;

  // ================= 内存指针级引用追踪 (WeakMap + Proxy 穿透标记) & 调用栈溯源 =================
  const refToUrlMap = new WeakMap();
  const rawTextToUrlMap = new Map();
  const reqMetaMap = new Map(); // fullUrl -> { stackFiles: Set, routeKey: string, time: number }

  function getRouteKey() {
    return location.pathname + location.hash;
  }

  function tagObjectTreeWithUrl(node, url, depth = 0) {
    if (depth > 4 || !node || typeof node !== 'object') return;
    try {
      refToUrlMap.set(node, url);
      if (!Object.prototype.hasOwnProperty.call(node, '__qm_api_url__')) {
        Object.defineProperty(node, '__qm_api_url__', {
          value: url,
          enumerable: false,
          configurable: true
        });
      }
      if (Array.isArray(node)) {
        const len = Math.min(node.length, 15);
        for (let i = 0; i < len; i++) {
          tagObjectTreeWithUrl(node[i], url, depth + 1);
        }
      } else {
        Object.keys(node).slice(0, 20).forEach((k) => {
          tagObjectTreeWithUrl(node[k], url, depth + 1);
        });
      }
    } catch {}
  }

  function rememberRawJsonForUrl(rawText, fullUrl) {
    if (!rawText || typeof rawText !== 'string' || rawText.length < 2) return;
    const trimmed = rawText.trim();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
    rawTextToUrlMap.set(trimmed, fullUrl);
    if (rawTextToUrlMap.size > 80) {
      const oldestKey = rawTextToUrlMap.keys().next().value;
      rawTextToUrlMap.delete(oldestKey);
    }
  }

  // 劫持 JSON.parse：当 axios / 页面代码解析响应文本时，自动为返回对象打上内存引用标记
  JSON.parse = function (text, reviver) {
    const res = origJsonParse.call(this, text, reviver);
    try {
      if (typeof text === 'string' && res && typeof res === 'object') {
        const matchedUrl = rawTextToUrlMap.get(text.trim());
        if (matchedUrl) {
          tagObjectTreeWithUrl(res, matchedUrl, 0);
        }
      }
    } catch {}
    return res;
  };

  // 劫持 Response.prototype.json：当 fetch().then(r => r.json()) 解析时同样打上内存引用标记
  if (typeof Response !== 'undefined' && Response.prototype && Response.prototype.json) {
    const origResJson = Response.prototype.json;
    Response.prototype.json = async function (...args) {
      const res = await origResJson.apply(this, args);
      try {
        const u = this.__qm_full_url__ || (this.url ? normalizeUrl(this.url) : '');
        if (u && res && typeof res === 'object') {
          tagObjectTreeWithUrl(res, u, 0);
        }
      } catch {}
      return res;
    };
  }

  function extractCallerFilesFromStack(stackStr) {
    const files = new Set();
    if (!stackStr) return files;
    const lines = stackStr.split('\n');
    for (const line of lines) {
      if (/node_modules|chunk-vendors|inject\.js|axios|vue\.runtime|react-dom/i.test(line)) continue;
      const m = line.match(/\/([a-zA-Z0-9_.-]+\.(?:vue|tsx|jsx|ts|js))(?:\?|:|\)|$)/i);
      if (m && m[1]) {
        files.add(m[1].toLowerCase());
      }
    }
    return files;
  }

  function recordRequestInitiator(fullUrl) {
    try {
      const stack = new Error().stack || '';
      const stackFiles = extractCallerFilesFromStack(stack);
      reqMetaMap.set(fullUrl, {
        stackFiles,
        routeKey: getRouteKey(),
        time: Date.now()
      });
    } catch {}
  }

  function readTrackedUrlFromValue(val, depth = 0) {
    if (depth > 3 || !val || typeof val !== 'object') return null;
    try {
      if (val.__qm_api_url__) return val.__qm_api_url__;
      if (refToUrlMap.has(val)) return refToUrlMap.get(val);
      // 兼容 Vue 3 Ref (.value)
      if ('value' in val && val.value && typeof val.value === 'object') {
        const u = readTrackedUrlFromValue(val.value, depth + 1);
        if (u) return u;
      }
      if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0] === 'object') {
        return readTrackedUrlFromValue(val[0], depth + 1);
      }
    } catch {}
    return null;
  }

  function scanObjectForTrackedUrls(obj, foundUrls) {
    if (!obj || typeof obj !== 'object') return;
    try {
      const direct = readTrackedUrlFromValue(obj, 0);
      if (direct) foundUrls.add(direct);
      Object.keys(obj).slice(0, 40).forEach((k) => {
        if (k.startsWith('$') || k.startsWith('_')) return;
        let v;
        try {
          v = obj[k];
        } catch {
          return;
        }
        const hit = readTrackedUrlFromValue(v, 0);
        if (hit) foundUrls.add(hit);
      });
    } catch {}
  }

  function isLayoutOrNavElement(el) {
    if (!el || !el.closest) return false;
    return Boolean(
      el.closest(
        'aside, nav, header, .sidebar, .el-aside, .ant-layout-sider, .el-menu, .ant-menu, .navbar, .tags-view-container, [class*="sidebar"], [class*="navbar"], [class*="header-bar"]'
      )
    );
  }

  // 扫描当前页面主视图区正在渲染的接口 URL 集合
  function detectActiveViewUrls() {
    const activeUrls = new Set();
    const viewFiles = new Set();
    const viewCodeSnippets = [];

    try {
      const allEls = document.querySelectorAll('*');
      const limit = Math.min(allEls.length, 600);
      const visitedComps = new Set();

      for (let i = 0; i < limit; i++) {
        const el = allEls[i];
        if (isLayoutOrNavElement(el)) continue;

        // 1. Vue 2 组件实例
        if (el.__vue__) {
          const vm = el.__vue__;
          if (!visitedComps.has(vm)) {
            visitedComps.add(vm);
            scanObjectForTrackedUrls(vm.$data, activeUrls);
            scanObjectForTrackedUrls(vm._props, activeUrls);
            const file = vm.$options && vm.$options.__file;
            if (file) {
              const base = file.split(/[/\\]/).pop().toLowerCase();
              viewFiles.add(base);
            }
            if (vm.$options && vm.$options.methods) {
              Object.values(vm.$options.methods).forEach((fn) => {
                if (typeof fn === 'function') viewCodeSnippets.push(fn.toString());
              });
            }
          }
        }

        // 2. Vue 3 组件实例
        if (el.__vueParentComponent) {
          let comp = el.__vueParentComponent;
          for (let d = 0; d < 3 && comp; d++) {
            if (!visitedComps.has(comp)) {
              visitedComps.add(comp);
              scanObjectForTrackedUrls(comp.setupState, activeUrls);
              scanObjectForTrackedUrls(comp.data, activeUrls);
              scanObjectForTrackedUrls(comp.props, activeUrls);
              const file = comp.type && comp.type.__file;
              if (file) {
                const base = file.split(/[/\\]/).pop().toLowerCase();
                viewFiles.add(base);
              }
              if (comp.type && typeof comp.type.setup === 'function') {
                viewCodeSnippets.push(comp.type.setup.toString());
              }
              if (comp.type && comp.type.methods) {
                Object.values(comp.type.methods).forEach((fn) => {
                  if (typeof fn === 'function') viewCodeSnippets.push(fn.toString());
                });
              }
            }
            comp = comp.parent;
          }
        }

        // 3. React Fiber 实例
        const reactKey = Object.keys(el).find(
          (k) => k.startsWith('__reactProps$') || k.startsWith('__reactFiber$')
        );
        if (reactKey && el[reactKey]) {
          const rNode = el[reactKey];
          scanObjectForTrackedUrls(rNode.memoizedProps || rNode, activeUrls);
        }
      }

      // 4. 针对空数据接口（无内存对象引用），通过组件源码方法名 & 调用栈文件名精准匹配
      const combinedCode = viewCodeSnippets.join('\n');
      const currentRoute = getRouteKey();
      reqMetaMap.forEach((meta, fullUrl) => {
        if (activeUrls.has(fullUrl)) return;
        try {
          const u = new URL(fullUrl, location.origin);
          const segments = u.pathname.split('/').filter(Boolean);
          const lastSeg = segments[segments.length - 1] || '';

          // 匹配 1：当前视图组件的 methods/setup 代码中直接出现了该接口末段名
          if (lastSeg.length >= 4 && combinedCode.includes(lastSeg)) {
            activeUrls.add(fullUrl);
            return;
          }
          // 匹配 2：发起请求时的调用栈文件与当前主视图挂载的组件文件一致
          for (const sf of meta.stackFiles) {
            if (viewFiles.has(sf)) {
              activeUrls.add(fullUrl);
              return;
            }
          }
          // 匹配 3：同路由下发起且非全局权限/菜单/字典类的业务数据接口
          if (
            meta.routeKey === currentRoute &&
            !/\/(login|logout|auth|token|userInfo|getInfo|getRouters|menu|nav|dict|permission|config|unread|notice)\b/i.test(u.pathname)
          ) {
            activeUrls.add(fullUrl);
          }
        } catch {}
      });
    } catch {}

    const list = Array.from(activeUrls);
    try {
      document.documentElement.setAttribute('data-qm-active-urls', JSON.stringify(list));
      window.postMessage(
        {
          source: 'QUICK_MOCK_INJECT',
          type: 'ACTIVE_VIEW_URLS',
          urls: list
        },
        '*'
      );
    } catch {}
    return list;
  }

  function isPluginEnabled() {
    try {
      if (typeof window.__QUICK_MOCK_ENABLED__ === 'boolean') {
        return window.__QUICK_MOCK_ENABLED__;
      }
      return localStorage.getItem(ENABLED_KEY) !== '0';
    } catch {
      return true;
    }
  }

  function getRules() {
    if (!isPluginEnabled()) return [];
    try {
      return window.__QUICK_MOCK_RULES__ || JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  // 读取带 100 条 LRU 限制的接口单条结构缓存
  function getSchemaCache() {
    try {
      return JSON.parse(localStorage.getItem(SCHEMA_CACHE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  // 精简单个样本对象（截断长字符串，控制每个接口模板在 200 字节左右，满 100 个自动淘汰最旧记录）
  function compactSampleItem(item) {
    if (!item || typeof item !== 'object') return item;
    const out = {};
    Object.keys(item).slice(0, 25).forEach((k) => {
      const v = item[k];
      if (typeof v === 'string') {
        out[k] = v.slice(0, 20);
      } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
        out[k] = v;
      } else if (Array.isArray(v)) {
        out[k] = [];
      } else if (typeof v === 'object') {
        out[k] = {};
      }
    });
    return out;
  }

  function recordSchemaIfPresent(fullUrl, jsonText) {
    if (!jsonText) return null;
    try {
      const pathname = new URL(fullUrl, location.origin).pathname;
      const parsed = JSON.parse(jsonText);
      let foundSample = null;

      function walk(node, depth) {
        if (depth > 6 || foundSample || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          if (node.length > 0 && node[0] && typeof node[0] === 'object' && !Array.isArray(node[0])) {
            foundSample = compactSampleItem(node[0]);
          }
          return;
        }
        Object.keys(node).forEach((k) => walk(node[k], depth + 1));
      }
      walk(parsed, 0);

      const cache = getSchemaCache();
      if (foundSample) {
        // 先删后插以更新顺序（LRU）
        delete cache[pathname];
        cache[pathname] = foundSample;
        const keys = Object.keys(cache);
        if (keys.length > MAX_SCHEMA_ENTRIES) {
          delete cache[keys[0]];
        }
        localStorage.setItem(SCHEMA_CACHE_KEY, JSON.stringify(cache));
        return foundSample;
      }
      return cache[pathname] || null;
    } catch {
      return null;
    }
  }

  // 自动从页面上的 Vue (Element Plus / Element UI / AntD Vue) 或 React 表格组件实例中提取字段名 (prop / dataIndex)
  function extractPageComponentFields(targetEl) {
    const fields = new Set();
    const IGNORED_PROPS = new Set([
      'length', 'map', 'forEach', 'filter', 'slice', 'push', 'includes', 'indexOf',
      'toString', 'valueOf', 'join', 'reduce', 'find', 'some', 'every', 'keys', 'values'
    ]);
    try {
      const rootScope =
        (targetEl && targetEl.closest && targetEl.closest('.el-table, .ant-table-wrapper, table, .el-card')) ||
        document;
      const allEls = rootScope.querySelectorAll('*');
      const limit = Math.min(allEls.length, 500);
      const visitedRenderFns = new Set();

      for (let i = 0; i < limit; i++) {
        const el = allEls[i];
        // 1. HTML 属性直接声明的 prop / data-field
        const attrProp = el.getAttribute && (el.getAttribute('prop') || el.getAttribute('data-field'));
        if (attrProp && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(attrProp)) {
          fields.add(attrProp);
        }

        // 2. Vue 2 (__vue__) 组件实例（如 el-table / el-table-column）
        if (el.__vue__) {
          const vm = el.__vue__;
          if (vm.prop && typeof vm.prop === 'string') fields.add(vm.prop);
          if (vm.columnConfig && vm.columnConfig.property) fields.add(vm.columnConfig.property);
          const storeCols =
            vm.columns ||
            (vm.store && vm.store.states && (vm.store.states.columns || vm.store.states._columns));
          if (Array.isArray(storeCols)) {
            storeCols.forEach((col) => {
              const p = col && (col.property || col.prop || col.dataIndex || col.key);
              if (p && typeof p === 'string' && /^[a-zA-Z_]/.test(p)) fields.add(p);
            });
          }
          const renderFn = vm.$options && vm.$options.render;
          if (typeof renderFn === 'function' && !visitedRenderFns.has(renderFn)) {
            visitedRenderFns.add(renderFn);
            extractFieldsFromCodeStr(renderFn.toString(), fields, IGNORED_PROPS);
          }
        }

        // 3. Vue 3 (__vueParentComponent) 组件实例
        if (el.__vueParentComponent) {
          let comp = el.__vueParentComponent;
          for (let d = 0; d < 4 && comp; d++) {
            const props = comp.props || {};
            if (props.prop && typeof props.prop === 'string') fields.add(props.prop);
            if (props.dataIndex && typeof props.dataIndex === 'string') fields.add(props.dataIndex);
            if (Array.isArray(props.columns)) {
              props.columns.forEach((col) => {
                const p = col && (col.dataIndex || col.prop || col.property || col.key);
                if (p && typeof p === 'string' && /^[a-zA-Z_]/.test(p)) fields.add(p);
              });
            }
            const states = comp.ctx && comp.ctx.store && comp.ctx.store.states;
            if (states) {
              const cols =
                (states.columns && (states.columns.value || states.columns)) ||
                (states._columns && (states._columns.value || states._columns));
              if (Array.isArray(cols)) {
                cols.forEach((col) => {
                  const p = col && (col.property || col.prop || col.dataIndex);
                  if (p && typeof p === 'string' && /^[a-zA-Z_]/.test(p)) fields.add(p);
                });
              }
            }
            const renderFn = (comp.type && comp.type.render) || comp.render;
            if (typeof renderFn === 'function' && !visitedRenderFns.has(renderFn)) {
              visitedRenderFns.add(renderFn);
              extractFieldsFromCodeStr(renderFn.toString(), fields, IGNORED_PROPS);
            }
            comp = comp.parent;
          }
        }

        // 4. React Fiber / Props (Ant Design Table columns)
        const reactKey = Object.keys(el).find(
          (k) => k.startsWith('__reactProps$') || k.startsWith('__reactFiber$')
        );
        if (reactKey && el[reactKey]) {
          const rNode = el[reactKey];
          const rProps = rNode.memoizedProps || rNode;
          if (rProps && Array.isArray(rProps.columns)) {
            rProps.columns.forEach((col) => {
              const p = col && (col.dataIndex || col.key);
              if (p && typeof p === 'string' && /^[a-zA-Z_]/.test(p)) fields.add(p);
            });
          }
        }
      }
    } catch {}
    return Array.from(fields).slice(0, 20);
  }

  function extractFieldsFromCodeStr(code, fieldsSet, ignoredSet) {
    if (!code || typeof code !== 'string') return;
    const propRegex = /\b(?:prop|property|dataIndex|field)\s*:\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/g;
    let m;
    while ((m = propRegex.exec(code)) !== null) {
      if (!ignoredSet.has(m[1])) fieldsSet.add(m[1]);
    }
    const rowRegex = /\b(?:row|record)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
    while ((m = rowRegex.exec(code)) !== null) {
      if (!ignoredSet.has(m[1])) fieldsSet.add(m[1]);
    }
  }

  function syncPageFieldsAttr(targetEl) {
    const pageFields = extractPageComponentFields(targetEl || document);
    if (pageFields.length > 0) {
      document.documentElement.setAttribute('data-qm-page-fields', pageFields.join(','));
    }
    return pageFields;
  }

  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'QUICK_MOCK_CONTENT') return;

    if (event.data.type === 'SYNC_RULES') {
      const rules = event.data.rules || [];
      window.__QUICK_MOCK_RULES__ = rules;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
      } catch {}
    }

    if (event.data.type === 'SYNC_ENABLED') {
      const enabled = event.data.enabled !== false;
      window.__QUICK_MOCK_ENABLED__ = enabled;
      try {
        localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
      } catch {}
    }

    if (event.data.type === 'EXTRACT_PAGE_FIELDS') {
      syncPageFieldsAttr(document);
      detectActiveViewUrls();
    }
  });

  // 当用户在页面上按住快捷键点击时，自动提取 ECharts 特征词 + 页面表格组件字段名
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!isPluginEnabled()) return;
      const target = e.target;
      if (!target || !(target instanceof Element)) return;

      // 提取当前区域或页面的 Vue/React 表格字段名供空数据造数使用
      syncPageFieldsAttr(target);

      const echartsDom = target.closest('[_echarts_instance_]');
      if (echartsDom && window.echarts && typeof window.echarts.getInstanceByDom === 'function') {
        try {
          const instance = window.echarts.getInstanceByDom(echartsDom);
          if (instance) {
            const opt = instance.getOption();
            const keywords = [];
            if (opt.xAxis && opt.xAxis[0] && Array.isArray(opt.xAxis[0].data)) {
              opt.xAxis[0].data.slice(0, 3).forEach((v) => v != null && keywords.push(String(v)));
            }
            if (opt.series && Array.isArray(opt.series)) {
              opt.series.forEach((s) => {
                if (s.name) keywords.push(String(s.name));
                if (Array.isArray(s.data) && s.data[0] != null) {
                  const first = s.data[0];
                  if (typeof first === 'object' && first.name) keywords.push(String(first.name));
                  else if (typeof first !== 'object') keywords.push(String(first));
                }
              });
            }
            echartsDom.setAttribute('data-quickmock-keywords', keywords.join('|'));
          }
        } catch {}
      }
    },
    true
  );

  function isStaticAsset(url) {
    return (
      /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)(\?|$)/i.test(url) ||
      url.includes('hot-update') ||
      url.startsWith('chrome-extension://')
    );
  }

  function normalizeUrl(rawUrl) {
    try {
      return new URL(rawUrl, location.origin).href;
    } catch {
      return String(rawUrl || '');
    }
  }

  function findMatchingRule(fullUrl, method) {
    if (!isPluginEnabled()) return null;
    const rules = getRules();
    return rules.find((r) => {
      if (!r.enabled || !r.matchKey) return false;
      const methodMatch =
        !r.method || r.method === 'ALL' || r.method.toUpperCase() === (method || 'GET').toUpperCase();
      return methodMatch && fullUrl.includes(r.matchKey);
    });
  }

  function tryFormatJson(text) {
    if (!text || typeof text !== 'string') return '';
    try {
      return JSON.stringify(origJsonParse(text), null, 2);
    } catch {
      return text;
    }
  }

  let activeDetectTimer = null;
  function scheduleActiveViewDetection() {
    if (activeDetectTimer) clearTimeout(activeDetectTimer);
    activeDetectTimer = setTimeout(() => {
      detectActiveViewUrls();
    }, 280);
  }

  function notifyCaptured(payload) {
    if (!isPluginEnabled()) return;
    if (payload && !payload.schemaSample) {
      const pf = syncPageFieldsAttr(document);
      if (pf.length > 0) payload.pageFields = pf;
      setTimeout(() => syncPageFieldsAttr(document), 350);
    }
    scheduleActiveViewDetection();
    window.postMessage(
      {
        source: 'QUICK_MOCK_INJECT',
        type: 'CAPTURED',
        payload
      },
      '*'
    );
  }

  // 1. 劫持 window.fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    if (!isPluginEnabled()) {
      return origFetch.apply(this, args);
    }

    const input = args[0];
    const init = args[1] || {};
    const rawUrl = typeof input === 'string' ? input : (input && input.url) || String(input);
    const fullUrl = normalizeUrl(rawUrl);
    const method = (init.method || (input && input.method) || 'GET').toUpperCase();

    if (isStaticAsset(fullUrl)) {
      return origFetch.apply(this, args);
    }

    recordRequestInitiator(fullUrl);

    const matchedRule = findMatchingRule(fullUrl, method);
    if (matchedRule) {
      let realBody = matchedRule.mockBody;
      try {
        const realRes = await origFetch.apply(this, args);
        realBody = await realRes.clone().text();
      } catch {}

      rememberRawJsonForUrl(matchedRule.mockBody, fullUrl);
      const schemaSample = recordSchemaIfPresent(fullUrl, realBody);
      notifyCaptured({
        url: fullUrl,
        method,
        status: 200,
        mocked: true,
        schemaSample,
        originalBody: tryFormatJson(realBody),
        responseBody: tryFormatJson(matchedRule.mockBody),
        time: new Date().toLocaleTimeString()
      });

      const mockResp = new Response(matchedRule.mockBody, {
        status: 200,
        statusText: 'OK (QuickMock)',
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
      try {
        Object.defineProperty(mockResp, '__qm_full_url__', { value: fullUrl, enumerable: false });
      } catch {}
      return mockResp;
    }

    const response = await origFetch.apply(this, args);
    try {
      Object.defineProperty(response, '__qm_full_url__', { value: fullUrl, enumerable: false });
      const cloned = response.clone();
      cloned
        .text()
        .then((text) => {
          if (!text || text.length > 3 * 1024 * 1024) return;
          rememberRawJsonForUrl(text, fullUrl);
          const schemaSample = recordSchemaIfPresent(fullUrl, text);
          notifyCaptured({
            url: fullUrl,
            method,
            status: response.status,
            mocked: false,
            schemaSample,
            originalBody: tryFormatJson(text),
            responseBody: tryFormatJson(text),
            time: new Date().toLocaleTimeString()
          });
        })
        .catch(() => {});
    } catch {}

    return response;
  };

  // 2. 劫持 XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const xhr = this;
    const fullUrl = normalizeUrl(url);
    const reqMethod = (method || 'GET').toUpperCase();

    if (!isStaticAsset(fullUrl)) {
      recordRequestInitiator(fullUrl);
      xhr.addEventListener('readystatechange', function () {
        if (!isPluginEnabled() || xhr.readyState !== 4) return;

        let rawText = '';
        try {
          if (!xhr.responseType || xhr.responseType === 'text') {
            rawText = xhr.responseText;
          } else if (xhr.responseType === 'json') {
            rawText = JSON.stringify(xhr.response);
            if (xhr.response && typeof xhr.response === 'object') {
              tagObjectTreeWithUrl(xhr.response, fullUrl, 0);
            }
          }
        } catch {}

        rememberRawJsonForUrl(rawText, fullUrl);
        const schemaSample = recordSchemaIfPresent(fullUrl, rawText);
        const matchedRule = findMatchingRule(fullUrl, reqMethod);
        if (matchedRule) {
          const mockStr = matchedRule.mockBody;
          rememberRawJsonForUrl(mockStr, fullUrl);
          Object.defineProperty(xhr, 'responseText', {
            configurable: true,
            get: () => mockStr
          });
          Object.defineProperty(xhr, 'response', {
            configurable: true,
            get: () => {
              if (xhr.responseType === 'json') {
                try {
                  const parsedMock = origJsonParse(mockStr);
                  tagObjectTreeWithUrl(parsedMock, fullUrl, 0);
                  return parsedMock;
                } catch {
                  return mockStr;
                }
              }
              return mockStr;
            }
          });
          Object.defineProperty(xhr, 'status', {
            configurable: true,
            get: () => 200
          });

          notifyCaptured({
            url: fullUrl,
            method: reqMethod,
            status: 200,
            mocked: true,
            schemaSample,
            originalBody: tryFormatJson(rawText || mockStr),
            responseBody: tryFormatJson(matchedRule.mockBody),
            time: new Date().toLocaleTimeString()
          });
          return;
        }

        if (rawText && rawText.length <= 3 * 1024 * 1024) {
          notifyCaptured({
            url: fullUrl,
            method: reqMethod,
            status: xhr.status,
            mocked: false,
            schemaSample,
            originalBody: tryFormatJson(rawText),
            responseBody: tryFormatJson(rawText),
            time: new Date().toLocaleTimeString()
          });
        }
      });
    }

    return origOpen.call(this, method, url, ...rest);
  };
})();
