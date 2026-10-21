chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));

// 插件安装或重载时，自动刷新当前打开的网页以销毁旧版失效的 content.js 上下文
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id && (tab.active || (tab.url && tab.url.includes('localhost')))) {
        chrome.tabs.reload(tab.id).catch(() => {});
      }
    });
  });
});
