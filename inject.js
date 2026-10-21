(function () {
  const STORAGE_KEY = '__QUICK_MOCK_RULES__';
  const ENABLED_KEY = '__QUICK_MOCK_ENABLED__';
  const SCHEMA_CACHE_KEY = '__QM_SCHEMA_CACHE__';
  const MAX_SCHEMA_ENTRIES = 100;

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
    try {
      const rootScope =
        (targetEl && targetEl.closest && targetEl.closest('.el-table, .ant-table-wrapper, table, .el-card')) ||
        document;
      const allEls = rootScope.querySelectorAll('*');
      const limit = Math.min(allEls.length, 400);

      for (let i = 0; i < limit; i++) {
        const el = allEls[i];
        // 1. HTML 属性直接声明的 prop / data-field
        const attrProp = el.getAttribute && (el.getAttribute('prop') || el.getAttribute('data-field'));
        if (attrProp && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(attrProp)) {
          fields.add(attrProp);
        }

        // 2. Vue 2 (__vue__) 组件实例（如 el-table-column）
        if (el.__vue__) {
          const vm = el.__vue__;
          if (vm.prop && typeof vm.prop === 'string') fields.add(vm.prop);
          if (vm.columnConfig && vm.columnConfig.property) fields.add(vm.columnConfig.property);
          if (Array.isArray(vm.columns)) {
            vm.columns.forEach((col) => {
              const p = col && (col.property || col.prop || col.dataIndex || col.key);
              if (p && typeof p === 'string' && /^[a-zA-Z_]/.test(p)) fields.add(p);
            });
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
  });

  // 当用户在页面上按住快捷键点击时，自动提取 ECharts 特征词 + 页面表格组件字段名
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!isPluginEnabled()) return;
      const target = e.target;
      if (!target || !(target instanceof Element)) return;

      // 提取当前区域或页面的 Vue/React 表格字段名供空数据造数使用
      const pageFields = extractPageComponentFields(target);
      if (pageFields.length > 0) {
        document.documentElement.setAttribute('data-qm-page-fields', pageFields.join(','));
      }

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
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  function notifyCaptured(payload) {
    if (!isPluginEnabled()) return;
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

    const matchedRule = findMatchingRule(fullUrl, method);
    if (matchedRule) {
      let realBody = matchedRule.mockBody;
      try {
        const realRes = await origFetch.apply(this, args);
        realBody = await realRes.clone().text();
      } catch {}

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

      return new Response(matchedRule.mockBody, {
        status: 200,
        statusText: 'OK (QuickMock)',
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const response = await origFetch.apply(this, args);
    try {
      const cloned = response.clone();
      cloned
        .text()
        .then((text) => {
          if (!text || text.length > 3 * 1024 * 1024) return;
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
      xhr.addEventListener('readystatechange', function () {
        if (!isPluginEnabled() || xhr.readyState !== 4) return;

        let rawText = '';
        try {
          if (!xhr.responseType || xhr.responseType === 'text') {
            rawText = xhr.responseText;
          } else if (xhr.responseType === 'json') {
            rawText = JSON.stringify(xhr.response);
          }
        } catch {}

        const schemaSample = recordSchemaIfPresent(fullUrl, rawText);
        const matchedRule = findMatchingRule(fullUrl, reqMethod);
        if (matchedRule) {
          const mockStr = matchedRule.mockBody;
          Object.defineProperty(xhr, 'responseText', {
            configurable: true,
            get: () => mockStr
          });
          Object.defineProperty(xhr, 'response', {
            configurable: true,
            get: () => {
              if (xhr.responseType === 'json') {
                try {
                  return JSON.parse(mockStr);
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
