const KICK_URL = /^https?:\/\/([^/]+\.)?kick\.com\//;

// Toolbar click opens/closes the settings bar in the Kick tab. Features are
// configured there, each on by default.
browser.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab?.id) return;
    // Safari hides tab.url until the site is allowed, so only skip known non-Kick tabs.
    if (tab.url && !KICK_URL.test(tab.url)) return;

    await ensureContentScript(tab.id);
    await browser.tabs.sendMessage(tab.id, { type: 'kickoff:togglePanel' });
  } catch (error) {
    console.error('Kickoff: could not open settings', error);
  }
});

// Tabs opened before the extension was enabled have no content script yet.
async function ensureContentScript(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, { type: 'kickoff:ping' });
  } catch {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  }
}

// ---- Blocking ads & trackers on kick.com --------------------------------------
const SETTINGS_KEY = 'kickoffSettings';
const BLOCK_STATUS_KEY = 'kickoffBlockStatus';
const RULE_ID_BASE = 1000;
const BLOCKED_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'imasdk.googleapis.com',
  'amazon-adsystem.com',
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'datadoghq-browser-agent.com',
  'datadoghq.com',
  'datazoom.io',
  'litix.io',
  'mux.com'
];

const RESOURCE_TYPES = ['script', 'xmlhttprequest', 'image', 'media', 'sub_frame', 'stylesheet', 'font', 'ping', 'websocket', 'other'];
const SCOPES = [
  { initiatorDomains: ['kick.com'] },
  { domains: ['kick.com'] },
  { domains: ['kick.com'], resourceTypes: RESOURCE_TYPES }
];

function blockRules(scope) {
  const filters = BLOCKED_HOSTS.map(host => `||${host}^`);
  filters.push('||kick.com/datazoom/');
  return filters.map((urlFilter, i) => ({
    id: RULE_ID_BASE + i,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter, ...scope }
  }));
}

async function applyRules(dnr, on) {
  const ours = (await dnr.getDynamicRules()).map(rule => rule.id).filter(id => id >= RULE_ID_BASE && id < RULE_ID_BASE + 1000);
  if (!on) {
    if (ours.length) await dnr.updateDynamicRules({ removeRuleIds: ours });
    return 'off';
  }
  
  for (const scope of SCOPES) {
    try {
      await dnr.updateDynamicRules({ removeRuleIds: ours, addRules: blockRules(scope) });
      return 'active';
    } catch (error) {
      // Ignore fallback errors
    }
  }
  return 'error';
}

async function syncBlocking() {
  const { [SETTINGS_KEY]: settings = {}, [BLOCK_STATUS_KEY]: previous } =
    await browser.storage.local.get([SETTINGS_KEY, BLOCK_STATUS_KEY]);
  const on = settings.blockAds !== false;
  const dnr = browser.declarativeNetRequest;
  let status;
  if (!dnr?.updateDynamicRules) {
    status = on ? 'unavailable' : 'off';
  } else {
    status = await applyRules(dnr, on);
  }
  if (status !== previous) await browser.storage.local.set({ [BLOCK_STATUS_KEY]: status });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
  const was = changes[SETTINGS_KEY].oldValue?.blockAds !== false;
  const now = changes[SETTINGS_KEY].newValue?.blockAds !== false;
  if (was !== now) syncBlocking().catch(error => console.error('Kickoff: blocking', error));
});
browser.runtime.onStartup?.addListener(() => syncBlocking().catch(() => {}));
browser.runtime.onInstalled?.addListener(() => syncBlocking().catch(() => {}));
syncBlocking().catch(error => console.error('Kickoff: blocking', error));
