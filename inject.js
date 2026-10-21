(function () {
  const STORAGE_KEY = '__QUICK_MOCK_RULES__';

  function getRules() {
    try {
      return window.__QUICK_MOCK_RULES__ || JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
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
  });

  // 当用户在页面上按住快捷键点击 Canvas 图表时，尝试从 ECharts 实例提取特征关键词
  document.addEventListener(
    'mousedown',
    (e) => {
      const target = e.target;
      if (!target || !(target instanceof Element)) return;
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

      notifyCaptured({
        url: fullUrl,
        method,
        status: 200,
        mocked: true,
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
          notifyCaptured({
            url: fullUrl,
            method,
            status: response.status,
            mocked: false,
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
        if (xhr.readyState !== 4) return;

        let rawText = '';
        try {
          if (!xhr.responseType || xhr.responseType === 'text') {
            rawText = xhr.responseText;
          } else if (xhr.responseType === 'json') {
            rawText = JSON.stringify(xhr.response);
          }
        } catch {}

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
