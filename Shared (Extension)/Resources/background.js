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
      files: ['strings.js', 'content.js']
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

// ---- iCloud sync ---------------------------------------------------------------
// Safari's storage.sync doesn't sync between devices, so settings and saved
// messages go through iCloud's key-value store in the native handler
// (SafariWebExtensionHandler.swift), shared by the Mac and iOS extensions. Each
// side is { updatedAt, value }; the newer one wins. Changes made here are pushed
// right away; the other devices pull when a Kick tab opens or comes back to the
// front (content.js asks), since Safari doesn't keep this script running.
// Text size stays on each device: a size that suits a Mac rarely suits a phone.
// 7TV emote usage and notes about users are merged instead (`union`): every
// device's uses are kept, and per user the newest note wins.
const MESSAGES_KEY = 'kickoffMessages';
const USAGE_KEY = 'kickoffEmoteUsage'; // written by content.js from page-hook.js
const USAGE_LIMIT = 200;
const NOTES_KEY = 'kickoffNotes'; // { lower-case name: { name, text, updatedAt } }, '' text = deleted
const NOTE_TOMBSTONE_MS = 180 * 24 * 60 * 60 * 1000; // deleted notes are forgotten after this
const SYNC_META_KEY = 'kickoffSync'; // { settings|messages: { updatedAt, json } } of the last synced version
const SYNC_PULL_MS = 15 * 1000; // at most one pull per this long
const LOCAL_ONLY_SETTINGS = ['fontSize'];

const SYNCED = {
  settings: {
    storageKey: SETTINGS_KEY,
    pick(value) {
      const shared = { ...(value || {}) };
      for (const key of LOCAL_ONLY_SETTINGS) delete shared[key];
      return shared;
    },
    merge(remote, local) {
      const merged = { ...remote };
      for (const key of LOCAL_ONLY_SETTINGS) {
        if (local && key in local) merged[key] = local[key];
      }
      return merged;
    }
  },
  messages: {
    storageKey: MESSAGES_KEY,
    pick: value => (Array.isArray(value) ? value : []),
    merge: remote => remote
  },
  emoteUsage: {
    storageKey: USAGE_KEY,
    union: true,
    // Sorted, so the same usage always gives the same JSON.
    pick: value => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {})
      .filter(([, entry]) => Number.isFinite(entry?.count) && Number.isFinite(entry?.last))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    merge: (remote, local) => mergeUsage(SYNCED.emoteUsage.pick(remote), SYNCED.emoteUsage.pick(local))
  },
  notes: {
    storageKey: NOTES_KEY,
    union: true,
    // Sorted, so the same notes always give the same JSON; old deletions dropped.
    pick: value => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {})
      .filter(([, note]) => typeof note?.name === 'string' && typeof note.text === 'string'
        && Number.isFinite(note.updatedAt) && (note.text || Date.now() - note.updatedAt < NOTE_TOMBSTONE_MS))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    merge(remote, local) {
      const merged = SYNCED.notes.pick(remote);
      for (const [key, note] of Object.entries(SYNCED.notes.pick(local))) {
        if (!merged[key] || note.updatedAt > merged[key].updatedAt) merged[key] = note;
      }
      return SYNCED.notes.pick(merged);
    }
  }
};

// Same merge as content.js and page-hook.js: per emote the higher count and the
// latest use, then the USAGE_LIMIT most recent.
function mergeUsage(a, b) {
  const merged = { ...a };
  for (const [name, entry] of Object.entries(b)) {
    const mine = merged[name];
    merged[name] = mine
      ? { count: Math.max(mine.count, entry.count), last: Math.max(mine.last, entry.last) }
      : entry;
  }
  const names = Object.keys(merged);
  if (names.length > USAGE_LIMIT) {
    names.sort((x, y) => merged[x].last - merged[y].last)
      .slice(0, names.length - USAGE_LIMIT)
      .forEach(old => delete merged[old]);
  }
  return merged;
}

let syncQueue = Promise.resolve();
let lastPull = 0;

// One sync step at a time, so a pull and a push can't interleave.
function queueSync(task) {
  syncQueue = syncQueue.then(task).catch(error => console.error('Kickoff: iCloud sync', error));
  return syncQueue;
}

function native(message) {
  return browser.runtime.sendNativeMessage('net.smigi.Kickoff.Extension', message);
}

function parseEntry(json) {
  try {
    const entry = JSON.parse(json);
    return entry && Number.isFinite(entry.updatedAt) ? entry : null;
  } catch {
    return null;
  }
}

async function readSyncState() {
  const keys = [SYNC_META_KEY, ...Object.values(SYNCED).map(spec => spec.storageKey)];
  const stored = await browser.storage.local.get(keys);
  return { stored, meta: stored[SYNC_META_KEY] || {} };
}

async function push(name, value, meta) {
  const spec = SYNCED[name];
  const shared = spec.pick(value);
  const updatedAt = Date.now();
  const reply = await native({ type: 'sync:push', key: name, value: JSON.stringify({ updatedAt, value: shared }) });
  if (!reply?.ok) throw new Error(reply?.error || 'push failed');
  meta[name] = { updatedAt, json: JSON.stringify(shared) };
}

async function pull() {
  lastPull = Date.now();
  const remote = await native({ type: 'sync:pull' });
  if (!remote || remote.error) throw new Error(remote?.error || 'pull failed');
  const { stored, meta } = await readSyncState();
  const writes = {};
  for (const [name, spec] of Object.entries(SYNCED)) {
    const local = stored[spec.storageKey];
    const localJson = JSON.stringify(spec.pick(local));
    const known = meta[name] || { updatedAt: 0, json: null };
    const entry = parseEntry(remote[name]);
    if (entry && entry.updatedAt > known.updatedAt) {
      // Another device changed it since we last synced: take theirs.
      const json = JSON.stringify(spec.pick(entry.value));
      meta[name] = { updatedAt: entry.updatedAt, json };
      if (json === localJson) continue;
      const merged = spec.merge(entry.value, local);
      writes[spec.storageKey] = merged;
      // A union keeps what only this device had: send the combined version back.
      if (spec.union && JSON.stringify(spec.pick(merged)) !== json) await push(name, merged, meta);
    } else if (local !== undefined && localJson !== known.json) {
      // Changed here while nothing newer arrived (or never uploaded): send ours.
      await push(name, local, meta);
    }
  }
  await browser.storage.local.set({ ...writes, [SYNC_META_KEY]: meta });
  // Safari doesn't fire storage.onChanged in the script that wrote, so the
  // blocking rules are updated here; the Kick tabs get onChanged as usual.
  if (SETTINGS_KEY in writes) await syncBlocking();
}

function requestPull() {
  if (Date.now() - lastPull < SYNC_PULL_MS) return;
  queueSync(pull);
}

// A change made in a Kick tab: push it, unless it's only text size (or the
// version we just pulled, which matches what's already in iCloud).
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [name, spec] of Object.entries(SYNCED)) {
    if (!(spec.storageKey in changes)) continue;
    // A union is never overwritten blindly: pull, merge, and push the result.
    if (spec.union) {
      queueSync(pull);
      continue;
    }
    queueSync(async () => {
      const { stored, meta } = await readSyncState();
      const value = stored[spec.storageKey];
      if (JSON.stringify(spec.pick(value)) === meta[name]?.json) return;
      await push(name, value, meta);
      await browser.storage.local.set({ [SYNC_META_KEY]: meta });
    });
  }
});

browser.runtime.onMessage.addListener(message => {
  if (message?.type === 'kickoff:sync') requestPull();
});
requestPull();
