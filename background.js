function applyDisplayMode(mode) {
  const isSidePanel = mode === 'sidepanel';
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: isSidePanel })
    .catch((err) => console.error(err));
  chrome.action
    .setPopup({ popup: isSidePanel ? '' : 'sidepanel.html?mode=popup' })
    .catch((err) => console.error(err));
}

chrome.storage.local.get(['displayMode'], (res) => {
  applyDisplayMode(res.displayMode || 'popup');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.displayMode) {
    applyDisplayMode(changes.displayMode.newValue || 'popup');
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'SET_DISPLAY_MODE') {
    const mode = msg.mode === 'sidepanel' ? 'sidepanel' : 'popup';
    applyDisplayMode(mode);
    chrome.storage.local.set({ displayMode: mode }, () => {
      if (mode === 'popup' && chrome.action && typeof chrome.action.openPopup === 'function') {
        setTimeout(() => {
          chrome.action.openPopup().catch(() => {});
        }, 120);
      }
      sendResponse({ ok: true, mode });
    });
    return true;
  }
});

// 插件安装或重载时，自动刷新当前打开的网页以销毁旧版失效的 content.js 上下文
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['displayMode'], (res) => {
    const mode = res.displayMode || 'popup';
    chrome.storage.local.set({ displayMode: mode });
    applyDisplayMode(mode);
  });
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id && (tab.active || (tab.url && tab.url.includes('localhost')))) {
        chrome.tabs.reload(tab.id).catch(() => {});
      }
    });
  });
});
