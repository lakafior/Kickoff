// Per-feature settings live in browser.storage.local (`kickoffSettings`), all on
// by default, and are edited from a collapsible bar placed above the chat
// messages (in the layout, so it never covers polls or pinned messages). Each
// feature is exposed as an html attribute that kickoff.css and page-hook.js
// follow; the wake lock is handled here.
(() => {
  if (window.kickoff) return; // already loaded in this tab

  // On-screen text in Safari's language (strings.js, loaded just before this).
  const t = kickoffStrings(browser.i18n?.getUILanguage?.() || navigator.language);

  const SETTINGS_KEY = 'kickoffSettings';
  // Set once the settings panel has been opened; until then the rocket button
  // in the strip carries a green dot so people find it.
  const SETTINGS_SEEN_KEY = 'kickoffSettingsSeen';
  const DEFAULTS = {
    wakeLock: true,
    chatFont: 'sf', // one of CHAT_FONTS
    chatOnly: true,
    restoreDeleted: true,
    linkPreviews: true,
    sevenTv: true,
    streamInfo: true,
    savedMessages: true,
    highlights: true,
    highlightWords: [],
    highlightStreamer: true,
    hideWords: [], // messages containing these are hidden
    muteUsers: true,
    mutedUsers: [], // usernames as shown in chat; matched in any case
    collapseRepeats: true,
    sevenTvCosmetics: true,
    hideEmoteOnly: false,
    hideBots: true,
    iosInput: true,
    fontSize: null, // null = Kick's own size
    nativePlayer: true,
    backgroundAudio: true,
    popoutAudio: true,
    channelStrip: true,
    blockAds: true
  };

  // Feature -> html attribute it switches on.
  const FEATURE_ATTRS = {
    chatOnly: 'data-ka-chatonly',
    restoreDeleted: 'data-ka-restore',
    linkPreviews: 'data-ka-link-previews',
    sevenTv: 'data-ka-7tv',
    savedMessages: 'data-ka-messages',
    highlights: 'data-ka-highlights',
    highlightStreamer: 'data-ka-streamer',
    muteUsers: 'data-ka-mute',
    collapseRepeats: 'data-ka-repeats',
    sevenTvCosmetics: 'data-ka-7tv-cosmetics',
    hideEmoteOnly: 'data-ka-emote-only',
    hideBots: 'data-ka-bots',
    iosInput: 'data-ka-ios',
    blockAds: 'data-ka-block-ads' // page-hook.js rewrites Kick's player answer
  };

  // Settings panel tabs, in order. Each lists its rows: a setting key is a switch,
  // the other names are the rows buildBar makes itself.
  const SETTINGS_TABS = {
    general: ['wakeLock', 'chatOnly', 'streamInfo', 'channelStrip', 'blockAds'],
    chat: ['font', 'size', 'sevenTv', 'sevenTvCosmetics', 'linkPreviews', 'restoreDeleted', 'savedMessages', 'iosInput'],
    filters: ['highlights', 'highlightWords', 'highlightStreamer', 'hideWords', 'hideEmoteOnly', 'collapseRepeats', 'hideBots', 'muteUsers', 'mutedUsers'],
    player: ['nativePlayer', 'backgroundAudio', 'popoutAudio']
  };
  const SETTINGS_TAB_KEY = 'kickoff:settingsTab'; // last open tab, in kick.com localStorage

  // Network blocking runs in background.js, which reports here how it went.
  const BLOCK_STATUS_KEY = 'kickoffBlockStatus';
  const BLOCK_HINTS = {
    active: '',
    off: '',
    unavailable: t('block.unavailable')
  };

  // Chat font: Kick's own, or Apple's San Francisco, New York (serif) or SF Mono.
  const CHAT_FONT_ATTR = 'data-ka-font';
  const CHAT_FONTS = [['kick', 'Kick'], ['sf', 'SF'], ['serif', t('font.serif')], ['mono', t('font.mono')]];
  const POPOUT_ATTR = 'data-ka-popout'; // the stream info line is popout-only
  const CHANNEL_STRIP_ATTR = 'data-ka-channel-strip'; // kickoff.css hides Kick's channel info
  const POPOUT_PATH = /^\/popout\/([^/]+)\/chat\/?$/;
  const FONT_SIZE_ATTR = 'data-ka-font-size'; // page-hook.js remeasures rows when it changes
  const HIGHLIGHT_WORDS_ATTR = 'data-ka-highlight-words'; // JSON list, read by page-hook.js
  const HIDE_WORDS_ATTR = 'data-ka-hide-words'; // JSON list, read by page-hook.js
  const MUTED_USERS_ATTR = 'data-ka-muted-users'; // JSON list, read by page-hook.js
  const USERNAME = /^[\w.-]{1,40}$/;
  const ROCKET_PATHS = [
    'm217.2 1005.6c-12 0-22.801-9.6016-22.801-22.801 0-21.602 2.3984-58.801 9.6016-100.8l-64.801-66c-94.801 111.6-105.6 271.2-106.8 328.8 0 12 9.6016 22.801 22.801 22.801 57.602-1.1992 217.2-12 328.8-106.8l-66-64.801c-42 7.1992-79.199 8.3984-100.8 9.6016z',
    'm918 756-2.3984-6c268.8-284.4 264-578.4 252-678-2.3984-21.602-19.199-38.398-40.801-40.801-99.602-12-393.6-16.801-678 252l-4.8008-1.1992c-93.602-43.199-202.8-22.801-276 49.199l-104.4 104.4c-24 24-16.801 63.602 13.199 76.801l169.2 78-57.602 91.199c-13.199 21.602-10.801 50.398 8.3984 69.602l252 252c18 18 46.801 21.602 69.602 8.3984l91.199-57.602 78 169.2c14.398 30 54 37.199 76.801 13.199l104.4-104.4c73.203-73.195 92.402-183.6 49.203-276zm-238.8-235.2c-50.398-50.398-50.398-130.8 0-181.2 50.398-50.398 130.8-50.398 181.2 0 50.398 50.398 49.199 130.8 0 181.2-49.199 49.199-130.8 49.199-181.2 0z'
  ];
  const FONT_SIZE_MIN = 10;
  const FONT_SIZE_MAX = 24;
  const BAR_POLL_MS = 1500;
  const STREAM_REFRESH_MS = 60 * 1000; // viewers/title from Kick's channel API
  const STREAM_TICK_MS = 30 * 1000;    // uptime counts up locally in between

  const state = {
    settings: { ...DEFAULTS },
    wakeLock: null,
    wakeLockPending: false,
    bar: null,
    settingsSeen: null, // null until read from storage, so the dot doesn't flash
    fontStyle: null,
    stream: null, // { live: true, channel, viewers, startedAt, title, category, categorySlug } | { live: false, channel }
    streamSlug: undefined // channel the stream info is for
  };
  window.kickoff = state;

  const root = document.documentElement;
  const popoutSlug = location.pathname.match(POPOUT_PATH)?.[1] || null;

  function saveSettings(changes) {
    const settings = { ...state.settings, ...changes };
    applySettings(settings);
    browser.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  // ---- Page hook -------------------------------------------------------------

  // Deleted-message restore and link previews need React's message data, which
  // only the page's own JS world can read, so load page-hook.js there.
  // strings.js goes first (same text table as here), then page-hook.js, which
  // reads the language from its script tag. async = false keeps that order.
  function injectPageHook() {
    if (document.querySelector('script[data-kickoff-hook]')) return;
    for (const file of ['strings.js', 'page-hook.js']) {
      const script = document.createElement('script');
      script.src = browser.runtime.getURL(file);
      script.async = false;
      if (file === 'page-hook.js') {
        script.dataset.kickoffHook = '';
        script.dataset.lang = t.lang;
      }
      (document.head || root).append(script);
    }
  }

  // ---- Saved messages: storage for page-hook.js --------------------------------
  // The list (UI in page-hook.js) is kept in the extension's storage, so it
  // survives clearing Kick's site data. page-hook.js runs in the page's world and
  // talks to this script with window.postMessage.

  const MESSAGES_KEY = 'kickoffMessages';
  const MESSAGE_MAX_LENGTH = 2000;
  const PAGE_SOURCE = 'kickoff:page';
  const EXT_SOURCE = 'kickoff:ext';

  async function readMessages() {
    const result = await browser.storage.local.get(MESSAGES_KEY);
    return Array.isArray(result[MESSAGES_KEY]) ? result[MESSAGES_KEY] : [];
  }

  function postMessages(items) {
    window.postMessage({ source: EXT_SOURCE, type: 'messages', items }, location.origin);
  }

  // ---- 7TV emote usage: synced copy for background.js ---------------------------
  // page-hook.js keeps usage ({ name: { count, last } }) in Kick's localStorage and
  // sends it here; the merged copy in extension storage is what background.js
  // syncs through iCloud, and what comes back from there is passed to the page.

  const USAGE_KEY = 'kickoffEmoteUsage';
  const USAGE_LIMIT = 200;

  function postUsage(usage) {
    window.postMessage({ source: EXT_SOURCE, type: 'usage', usage }, location.origin);
  }

  function cleanUsage(usage) {
    const clean = {};
    if (!usage || typeof usage !== 'object') return clean;
    for (const [name, entry] of Object.entries(usage)) {
      const count = Number(entry?.count);
      const last = Number(entry?.last);
      if (name.length <= 100 && count > 0 && Number.isFinite(count) && Number.isFinite(last)) clean[name] = { count, last };
    }
    return clean;
  }

  // Same merge as page-hook.js and background.js: per emote the higher count and
  // the latest use, then the USAGE_LIMIT most recent.
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

  async function storeUsage(incoming) {
    const stored = cleanUsage((await browser.storage.local.get(USAGE_KEY))[USAGE_KEY]);
    const merged = mergeUsage(stored, cleanUsage(incoming));
    if (JSON.stringify(merged) !== JSON.stringify(stored)) await browser.storage.local.set({ [USAGE_KEY]: merged });
    postUsage(merged); // the page may be missing what other devices added
  }

  function cleanMessage(item) {
    const valid = item && typeof item.id === 'string' && typeof item.text === 'string'
      && item.text.trim() && item.text.length <= MESSAGE_MAX_LENGTH
      && (item.channel === null || typeof item.channel === 'string');
    if (!valid) return null;
    return {
      id: item.id,
      text: item.text,
      channel: item.channel,
      created: Number(item.created) || Date.now(),
      used: Number(item.used) || 0
    };
  }

  async function handlePageRequest({ type, item, id, username, usage }) {
    if (type === 'usage:set') {
      await storeUsage(usage);
      return;
    }
    if (type === 'mute:add') {
      addMuted([username]);
      return;
    }
    if (type === 'inbox:add') {
      await addMention(item);
      return;
    }
    if (type === 'messages:get') {
      postMessages(await readMessages());
      return;
    }
    let items = await readMessages();
    if (type === 'messages:save') {
      const clean = cleanMessage(item);
      if (!clean) return;
      const index = items.findIndex(existing => existing.id === clean.id);
      if (index >= 0) items[index] = { ...clean, created: items[index].created };
      else items.push(clean);
    } else if (type === 'messages:delete' && typeof id === 'string') {
      items = items.filter(existing => existing.id !== id);
    } else if (type === 'messages:used' && typeof id === 'string') {
      items = items.map(existing => (existing.id === id ? { ...existing, used: Date.now() } : existing));
    } else {
      return;
    }
    await browser.storage.local.set({ [MESSAGES_KEY]: items });
    // Answer directly: Safari doesn't fire storage.onChanged in the script that
    // made the change (other tabs still get it through onChanged).
    postMessages(items);
  }

  // ---- Mentions inbox ---------------------------------------------------------------
  // page-hook.js reports highlighted messages (mentions of you, chosen words); the
  // last 50 per channel are kept in `kickoffInbox` = { channel: { items, seen } },
  // where `seen` is the newest message time seen when the inbox was last opened.

  const INBOX_KEY = 'kickoffInbox';
  const INBOX_LIMIT = 50;
  const INBOX_CHANNELS = 30;
  state.inbox = {};

  function currentChannel() {
    const parts = location.pathname.split('/').filter(Boolean);
    return (parts[0] === 'popout' ? parts[1] : parts[0])?.toLowerCase() || null;
  }

  async function readInbox() {
    const value = (await browser.storage.local.get(INBOX_KEY))[INBOX_KEY];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  async function writeInbox(inbox) {
    // Forget the channels with the oldest mentions beyond the limit.
    const latest = channel => Math.max(0, ...inbox[channel].items.map(item => item.at));
    Object.keys(inbox).sort((a, b) => latest(b) - latest(a)).slice(INBOX_CHANNELS).forEach(channel => delete inbox[channel]);
    await browser.storage.local.set({ [INBOX_KEY]: inbox });
    applyInbox(inbox); // storage.onChanged doesn't fire in this script
  }

  function cleanMention(item) {
    const valid = item && typeof item.id === 'string' && typeof item.channel === 'string' && item.channel
      && typeof item.username === 'string' && typeof item.content === 'string'
      && item.content.length <= MESSAGE_MAX_LENGTH && (item.kind === 'mention' || item.kind === 'keyword');
    if (!valid) return null;
    const { id, channel, username, content, kind } = item;
    return { id, channel, username, content, kind, at: Number(item.at) || Date.now() };
  }

  async function addMention(item) {
    const clean = cleanMention(item);
    if (!clean) return;
    const inbox = await readInbox();
    const entry = inbox[clean.channel] || { items: [], seen: 0 };
    if (entry.items.some(existing => existing.id === clean.id)) return;
    entry.items = [...entry.items, clean].sort((a, b) => a.at - b.at).slice(-INBOX_LIMIT);
    inbox[clean.channel] = entry;
    await writeInbox(inbox);
  }

  async function markInboxSeen(channel) {
    const inbox = await readInbox();
    const entry = inbox[channel];
    if (!entry?.items.length) return;
    const newest = Math.max(...entry.items.map(item => item.at));
    if (entry.seen >= newest) return;
    entry.seen = newest;
    await writeInbox(inbox);
  }

  async function clearInbox(channel) {
    const inbox = await readInbox();
    if (!inbox[channel]) return;
    inbox[channel] = { items: [], seen: inbox[channel].seen };
    await writeInbox(inbox);
  }

  // Same one-at-a-time queue as the page's requests (defined below).
  const inboxTask = task => {
    messageQueue = messageQueue.then(task).catch(err => console.error('Kickoff: inbox error', err));
  };

  // ---- Mute list -----------------------------------------------------------------
  // Usernames in settings (all channels); page-hook.js collapses their messages.

  function cleanUsername(name) {
    const clean = String(name ?? '').trim().replace(/^@/, '');
    return USERNAME.test(clean) ? clean : null;
  }

  function addMuted(names) {
    const list = [...state.settings.mutedUsers];
    for (const name of names) {
      const clean = cleanUsername(name);
      if (clean && !list.some(existing => existing.toLowerCase() === clean.toLowerCase())) list.push(clean);
    }
    if (list.length !== state.settings.mutedUsers.length) saveSettings({ mutedUsers: list });
  }

  function removeMuted(name) {
    saveSettings({ mutedUsers: state.settings.mutedUsers.filter(existing => existing !== name) });
  }

  // One request at a time, so quick edits can't overwrite each other. The first
  // waits for the stored settings, so a mute can't save over them with defaults.
  let messageQueue = new Promise(resolve => { state.settingsLoaded = resolve; });
  window.addEventListener('message', event => {
    // Check the origin, not event.source: in Safari the content script's window
    // isn't the same object as the page's, so `event.source === window` fails.
    if (event.origin !== location.origin || event.data?.source !== PAGE_SOURCE) return;
    const request = event.data;
    if (request.type === 'search:results') {
      renderSearchResults(request);
      return;
    }
    if (request.type === 'jump:result') {
      onJumpResult(request);
      return;
    }
    messageQueue = messageQueue.then(() => handlePageRequest(request)).catch(err => {
      console.error('Kickoff: saved messages error', err);
    });
  });

  // ---- Wake lock -----------------------------------------------------------

  async function acquireWakeLock() {
    if (!state.settings.wakeLock || state.wakeLock || state.wakeLockPending) return;
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;

    state.wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!state.settings.wakeLock) {
        await lock.release(); // switched off while the request was in flight
        return;
      }
      state.wakeLock = lock;
      // The browser drops the lock when the tab is hidden; forget it so we re-acquire.
      lock.addEventListener('release', () => {
        if (state.wakeLock === lock) state.wakeLock = null;
        renderStatus();
      });
    } catch (err) {
      // Safari refuses requests that don't come from a tap (page load, unlock);
      // the next tap anywhere on the page retries.
      if (err.name !== 'NotAllowedError') console.error('Kickoff: wake lock error', err);
    } finally {
      state.wakeLockPending = false;
      renderStatus();
    }
  }

  async function releaseWakeLock() {
    const lock = state.wakeLock;
    state.wakeLock = null;
    if (lock) {
      try { await lock.release(); } catch (err) { /* already released */ }
    }
    renderStatus();
  }

  // A tap is a user gesture, which is what Safari needs to grant the lock again
  // after a reload or unlocking the phone. Cheap no-op while the lock is held.
  for (const type of ['click', 'touchend', 'keydown']) {
    document.addEventListener(type, () => acquireWakeLock(), { capture: true, passive: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquireWakeLock();
  });

  // ---- Font size -------------------------------------------------------------

  // Kick sets --chatroom-font-size inline on <html>; override it for the chat only.
  function applyFontSize(size) {
    if (size == null) {
      state.fontStyle?.remove();
      state.fontStyle = null;
      root.removeAttribute(FONT_SIZE_ATTR);
      return;
    }
    if (!state.fontStyle) {
      state.fontStyle = document.createElement('style');
      state.fontStyle.dataset.kickoff = 'font-size';
      (document.head || root).append(state.fontStyle);
    }
    state.fontStyle.textContent = `#channel-chatroom { --chatroom-font-size: ${size}px !important; }`;
    root.setAttribute(FONT_SIZE_ATTR, String(size));
  }

  function currentFontSize() {
    if (state.settings.fontSize != null) return state.settings.fontSize;
    return parseInt(getComputedStyle(root).getPropertyValue('--chatroom-font-size'), 10) || 14;
  }

  // ---- Settings bar ----------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function buildBar() {
    const bar = el('div', 'ka-settings');
    bar.dataset.kickoff = 'settings';

    const toggle = el('button', 'ka-settings-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const ident = el('span', 'ka-channel');
    ident.append(el('img', 'ka-channel-avatar'), el('span', 'ka-channel-name'));
    toggle.append(
      el('span', 'ka-settings-title', 'Kickoff'),
      ident,
      el('span', 'ka-stream'),
      el('span', 'ka-settings-status'),
      el('span', 'ka-settings-chevron', '▾')
    );
    toggle.addEventListener('click', () => setPanelOpen(!isPanelOpen()));

    const panel = el('div', 'ka-settings-panel');
    panel.hidden = true;
    const details = el('div', 'ka-stream-details');
    details.hidden = true;

    const switchRow = key => {
      const row = el('label', 'ka-settings-row');
      const input = el('input', 'ka-switch');
      input.type = 'checkbox';
      input.setAttribute('role', 'switch');
      input.dataset.setting = key;
      input.addEventListener('change', () => saveSettings({ [key]: input.checked }));
      const text = el('span', 'ka-settings-label', t(`setting.${key}`));
      if (key === 'wakeLock') text.append(el('span', 'ka-wake-hint'));
      if (key === 'blockAds') text.append(el('span', 'ka-wake-hint ka-block-hint'));
      row.append(text, input);
      return row;
    };

    // Word lists (highlight, hide): comma-separated, saved when the field is left or on Enter.
    const wordsRow = (key, label, placeholder) => {
      const row = el('label', 'ka-settings-row ka-words-row');
      const input = el('input', 'ka-words-input');
      input.type = 'text';
      input.placeholder = placeholder;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.dataset.words = key;
      input.addEventListener('change', () => {
        const list = [...new Set(input.value.split(',').map(word => word.trim()).filter(Boolean))];
        if (JSON.stringify(list) !== JSON.stringify(state.settings[key] || [])) saveSettings({ [key]: list });
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') input.blur();
      });
      row.append(el('span', 'ka-settings-label', label), input);
      return row;
    };

    // Muted users: chips to unmute, and a field to add names (comma-separated).
    const mutedRows = () => {
      const row = el('label', 'ka-settings-row ka-words-row');
      const input = el('input', 'ka-words-input ka-mute-input');
      input.type = 'text';
      input.placeholder = t('mute.add');
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.addEventListener('change', () => {
        addMuted(input.value.split(','));
        input.value = '';
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') input.blur();
      });
      row.append(el('span', 'ka-settings-label', t('mute.label')), input);
      return [row, el('div', 'ka-mute-list')];
    };

    const fontRow = () => {
      const row = el('div', 'ka-settings-row');
      const fonts = el('span', 'ka-size-controls ka-font-choice');
      for (const [value, label] of CHAT_FONTS) {
        const option = el('button', 'ka-size-button ka-font-option', label);
        option.type = 'button';
        option.dataset.font = value;
        option.addEventListener('click', () => saveSettings({ chatFont: value }));
        fonts.append(option);
      }
      row.append(el('span', 'ka-settings-label', t('font.label')), fonts);
      return row;
    };

    const sizeRow = () => {
      const row = el('div', 'ka-settings-row');
      const controls = el('span', 'ka-size-controls');
      const minus = el('button', 'ka-size-button', '−');
      const value = el('span', 'ka-size-value');
      const plus = el('button', 'ka-size-button', '+');
      const reset = el('button', 'ka-size-reset', t('size.reset'));
      for (const button of [minus, plus, reset]) button.type = 'button';
      minus.setAttribute('aria-label', t('size.smaller'));
      plus.setAttribute('aria-label', t('size.larger'));
      minus.addEventListener('click', () => stepFontSize(-1));
      plus.addEventListener('click', () => stepFontSize(1));
      reset.addEventListener('click', () => saveSettings({ fontSize: null }));
      controls.append(minus, value, plus, reset);
      row.append(el('span', 'ka-settings-label', t('size.label')), controls);
      return row;
    };

    const ROWS = {
      font: fontRow,
      size: sizeRow,
      highlightWords: () => wordsRow('highlightWords', t('words.highlight'), t('words.highlightExample')),
      hideWords: () => wordsRow('hideWords', t('words.hide'), t('words.hideExample')),
      mutedUsers: mutedRows
    };

    // Segmented control on top, one page of rows per tab.
    const tabs = el('div', 'ka-settings-tabs');
    tabs.setAttribute('role', 'tablist');
    panel.append(details, tabs);
    for (const [name, rows] of Object.entries(SETTINGS_TABS)) {
      const tab = el('button', 'ka-settings-tab', t(`tab.${name}`));
      tab.type = 'button';
      tab.id = `ka-tab-${name}`;
      tab.dataset.tab = name;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `ka-page-${name}`);
      tab.addEventListener('click', () => showSettingsTab(name));
      tab.addEventListener('keydown', event => {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
        if (!step) return;
        const names = Object.keys(SETTINGS_TABS);
        const next = names[(names.indexOf(name) + step + names.length) % names.length];
        showSettingsTab(next);
        tabs.querySelector(`[data-tab="${next}"]`).focus();
      });
      tabs.append(tab);
      const page = el('div', 'ka-settings-page');
      page.id = `ka-page-${name}`;
      page.dataset.tab = name;
      page.setAttribute('role', 'tabpanel');
      page.setAttribute('aria-labelledby', tab.id);
      for (const row of rows) page.append(...[].concat(ROWS[row] ? ROWS[row]() : switchRow(row)));
      panel.append(page);
    }
    // Shown only when the page script has trouble, so it stays below every tab.
    const health = el('div', 'ka-health');
    health.hidden = true;
    panel.append(health);

    // Mentions inbox: button next to the strip, list opens below it.
    const inboxButton = el('button', 'ka-strip-button ka-inbox-button');
    inboxButton.type = 'button';
    inboxButton.setAttribute('aria-expanded', 'false');
    inboxButton.append(el('span', 'ka-inbox-at', '@'), el('span', 'ka-inbox-count'));
    inboxButton.addEventListener('click', () => setInboxOpen(!isInboxOpen()));
    const searchButton = el('button', 'ka-strip-button ka-search-button');
    searchButton.type = 'button';
    searchButton.setAttribute('aria-label', t('strip.search'));
    searchButton.setAttribute('aria-expanded', 'false');
    searchButton.append(searchIcon());
    searchButton.addEventListener('click', () => setSearchOpen(!isSearchOpen()));
    const listenButton = el('button', 'ka-strip-button ka-listen-button');
    listenButton.type = 'button';
    listenButton.setAttribute('aria-label', t('strip.listen'));
    listenButton.append(playerIcon('headphones'));
    listenButton.addEventListener('click', toggleListen);
    const settingsButton = el('button', 'ka-strip-button ka-settings-button');
    settingsButton.type = 'button';
    settingsButton.title = t('strip.settings');
    settingsButton.setAttribute('aria-label', t('strip.settings'));
    settingsButton.setAttribute('aria-expanded', 'false');
    settingsButton.append(rocketIcon());
    settingsButton.addEventListener('click', () => setPanelOpen(!isPanelOpen()));
    const head = el('div', 'ka-settings-head');
    const actions = el('div', 'ka-channel-actions');
    actions.hidden = true;
    const listenSleep = sleepControl();
    listenSleep.classList.add('ka-listen-sleep');
    head.append(toggle, actions, listenButton, listenSleep, searchButton, inboxButton, settingsButton);

    // Chat search: field, a summary line, results.
    const search = el('div', 'ka-search');
    search.hidden = true;
    const field = el('input', 'ka-words-input ka-search-input');
    field.type = 'search';
    field.placeholder = t('search.placeholder');
    field.autocomplete = 'off';
    field.autocapitalize = 'off';
    field.spellcheck = false;
    let searchTimer = null;
    field.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 150);
    });
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter') field.blur(); // closes the phone keyboard
    });
    const results = el('div', 'ka-inbox-list ka-search-results');
    // Tapping a name searches that user's messages.
    // Tapping a message jumps to it in chat.
    results.addEventListener('click', event => {
      const name = event.target.closest('.ka-inbox-user')?.textContent;
      if (name) {
        field.value = `${t('search.from')}${name}`;
        runSearch();
        return;
      }
      const item = event.target.closest('.ka-inbox-item');
      if (item) requestJump(item);
    });
    search.append(field, el('div', 'ka-search-summary'), results);

    const inbox = el('div', 'ka-inbox');
    inbox.hidden = true;
    const inboxHead = el('div', 'ka-inbox-head');
    const clear = el('button', 'ka-size-reset ka-inbox-clear', t('inbox.clear'));
    clear.type = 'button';
    clear.addEventListener('click', () => {
      const channel = currentChannel();
      if (channel) inboxTask(() => clearInbox(channel));
    });
    inboxHead.append(el('span', 'ka-inbox-title'), clear);
    const inboxList = el('div', 'ka-inbox-list');
    inboxList.addEventListener('click', event => {
      const item = event.target.closest('.ka-inbox-item');
      if (item) requestJump(item);
    });
    inbox.append(inboxHead, inboxList);

    bar.append(head, search, inbox, panel);
    return bar;
  }

  function stepFontSize(delta) {
    const size = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, currentFontSize() + delta));
    saveSettings({ fontSize: size });
  }

  function savedSettingsTab() {
    try {
      const name = localStorage.getItem(SETTINGS_TAB_KEY);
      if (name in SETTINGS_TABS) return name;
    } catch (err) { /* storage blocked */ }
    return Object.keys(SETTINGS_TABS)[0];
  }

  function showSettingsTab(name) {
    if (!state.bar) return;
    for (const tab of state.bar.querySelectorAll('.ka-settings-tab')) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const page of state.bar.querySelectorAll('.ka-settings-page')) page.hidden = page.dataset.tab !== name;
    state.bar.querySelector('.ka-settings-panel').scrollTop = 0;
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, name);
    } catch (err) { /* storage blocked */ }
  }

  function isPanelOpen() {
    return Boolean(state.bar && !state.bar.querySelector('.ka-settings-panel').hidden);
  }

  // What page-hook.js reports in html[data-ka-status]: whether it runs, how many
  // chat rows it can read, 7TV emotes loaded, and its last error. Shown only when
  // something is wrong, to keep the panel short.
  function renderHealth() {
    const health = state.bar?.querySelector('.ka-health');
    if (!health) return;
    let status = null;
    try {
      status = JSON.parse(root.dataset.kaStatus || 'null');
    } catch (err) { /* treated as not running */ }
    if (!status) {
      health.textContent = 'Page script: not running';
      health.dataset.state = 'error';
      health.hidden = false;
      return;
    }
    const parts = [`Page script: running`, `${status.readable}/${status.rows} messages readable`];
    if (state.settings.sevenTv) parts.push(`${status.emotes} 7TV emotes`);
    if (status.channel) parts.push(status.channel);
    const yes = value => (value ? 'yes' : 'NO');
    const loading = status.emoteLoading != null ? `, loading ${status.emoteLoading}s` : '';
    const details = [
      `Message box: ${status.inputs} found, editable ${yes(status.editableInput)}, input area ${yes(status.footer)}`,
      `Kick toolbar ${yes(status.kickToolbar)}, emote button ${yes(status.emoteButton)}, our buttons ${yes(status.ourToolbar)}`,
      `7TV: global ${status.emoteCounts?.global ?? '?'}, channel ${status.emoteCounts?.channel ?? '?'}${loading}`,
      `Chat connection: ${status.realtime || '?'}, reconnected ${status.reconnects ?? 0}×`,
      `Chat crashes: ${status.crashes ?? 0}${status.crash ? ` (last: ${status.crash})` : ''}`
    ];
    health.textContent = [parts.join(' · '), ...details].join('\n') + (status.error ? `\nLast error: ${status.error}` : '');
    health.dataset.state = status.error || (status.rows && !status.readable) ? 'error' : 'ok';
    health.hidden = health.dataset.state === 'ok' && !status.crashes && !status.reconnects;
  }

  function setPanelOpen(open) {
    placeBar();
    if (!state.bar) return;
    if (open) {
      setInboxOpen(false);
      setSearchOpen(false);
      renderHealth();
    }
    state.bar.querySelector('.ka-settings-panel').hidden = !open;
    state.bar.querySelector('.ka-settings-toggle').setAttribute('aria-expanded', String(open));
    state.bar.querySelector('.ka-settings-button').setAttribute('aria-expanded', String(open));
    if (open && state.settingsSeen === false) {
      state.settingsSeen = true;
      browser.storage.local.set({ [SETTINGS_SEEN_KEY]: true });
      renderSettingsHint();
    }
    state.bar.toggleAttribute('data-open', open);
    fitPanel();
  }

  // The switch is the preference; this shows whether the lock is actually held.
  // Safari drops it on reload or when the phone locks and only grants it again
  // after a tap, so "on but not held" is a real, visible state.
  function renderStatus() {
    if (!state.bar) return;
    const wakeState = !state.settings.wakeLock ? 'off' : state.wakeLock ? 'active' : 'waiting';
    const status = state.bar.querySelector('.ka-settings-status');
    status.dataset.state = wakeState;
    // Next to the stream line there's only room for an icon.
    const compact = state.bar.hasAttribute('data-stream');
    status.textContent = compact
      ? { off: '', active: '☀', waiting: t('wake.waitingShort') }[wakeState]
      : { off: '', active: t('wake.active'), waiting: t('wake.waiting') }[wakeState];
    status.title = { off: '', active: t('wake.activeTitle'), waiting: t('wake.waitingTitle') }[wakeState];
    state.bar.querySelector('.ka-wake-hint').textContent =
      { off: '', active: t('wake.activeHint'), waiting: t('wake.waitingHint') }[wakeState];
  }

  function renderBar() {
    if (!state.bar) return;
    for (const input of state.bar.querySelectorAll('input[data-setting]')) {
      input.checked = Boolean(state.settings[input.dataset.setting]);
    }
    state.bar.querySelector('.ka-size-value').textContent = `${currentFontSize()}px`;
    for (const words of state.bar.querySelectorAll('.ka-words-input[data-words]')) {
      if (document.activeElement !== words) words.value = (state.settings[words.dataset.words] || []).join(', ');
    }
    state.bar.querySelector('[data-words="highlightWords"]').disabled = !state.settings.highlights;
    renderMuted();
    for (const option of state.bar.querySelectorAll('.ka-font-option')) {
      option.setAttribute('aria-pressed', String(option.dataset.font === state.settings.chatFont));
    }
    state.bar.querySelector('.ka-size-reset').hidden = state.settings.fontSize == null;
    renderStream();
    renderInbox();
    renderListen();
    renderChannelActions();
    renderBlockHint();
    renderSettingsHint();
  }

  function renderBlockHint() {
    const hint = state.bar?.querySelector('.ka-block-hint');
    if (!hint) return;
    const status = state.settings.blockAds ? state.blockStatus || '' : 'off';
    hint.textContent = BLOCK_HINTS[status] ?? (status.startsWith('error') ? t('block.error', { error: status.slice(7) }) : '');
  }

  // The panel scrolls itself: on iOS the chat column (and the page) can't be
  // scrolled to reach the rows at its end. It ends above the message box, or at
  // the bottom of the screen when the chat column is taller than that.
  const PANEL_MIN_HEIGHT = 160;

  function fitPanel() {
    const panel = state.bar?.querySelector('.ka-settings-panel');
    if (!panel || panel.hidden) return;
    const viewport = window.visualViewport;
    const screenBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const chatBottom = document.querySelector('#channel-chatroom')?.getBoundingClientRect().bottom ?? screenBottom;
    const footer = document.querySelector('#chatroom-footer')?.offsetHeight || 0;
    const space = Math.floor(Math.min(screenBottom, chatBottom) - footer - panel.getBoundingClientRect().top - 8);
    panel.style.maxHeight = `${Math.max(PANEL_MIN_HEIGHT, space)}px`;
  }

  // ---- Mentions inbox UI -------------------------------------------------------------

  function isInboxOpen() {
    return Boolean(state.bar && !state.bar.querySelector('.ka-inbox').hidden);
  }

  function setInboxOpen(open) {
    placeBar();
    if (!state.bar) return;
    const channel = currentChannel();
    if (open) {
      setPanelOpen(false);
      setSearchOpen(false);
      // Unread when opened stay marked "new" until the inbox is closed.
      state.inboxNewSince = state.inbox[channel]?.seen || 0;
      if (channel) inboxTask(() => markInboxSeen(channel));
    }
    state.bar.querySelector('.ka-inbox').hidden = !open;
    state.bar.querySelector('.ka-inbox-button').setAttribute('aria-expanded', String(open));
    renderInbox();
  }

  // ---- Chat search UI (the messages are kept by page-hook.js) ---------------------

  let searchRequest = 0;

  function renderSettingsHint() {
    state.bar?.querySelector('.ka-settings-button').toggleAttribute('data-hint', state.settingsSeen === false);
  }

  // Kickoff's logo, the same rocket as the toolbar and app icon.
  function rocketIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 1200 1200');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ka-rocket-icon');
    for (const d of ROCKET_PATHS) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('fill', 'currentColor');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function searchIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', '6.5');
    circle.setAttribute('cy', '6.5');
    circle.setAttribute('r', '4.75');
    const line = document.createElementNS(ns, 'path');
    line.setAttribute('d', 'M10 10l4.5 4.5');
    for (const shape of [circle, line]) {
      shape.setAttribute('fill', 'none');
      shape.setAttribute('stroke', 'currentColor');
      shape.setAttribute('stroke-width', '2');
      shape.setAttribute('stroke-linecap', 'round');
      svg.append(shape);
    }
    return svg;
  }

  function isSearchOpen() {
    return Boolean(state.bar && !state.bar.querySelector('.ka-search').hidden);
  }

  function setSearchOpen(open) {
    placeBar();
    if (!state.bar) return;
    if (open) {
      setPanelOpen(false);
      setInboxOpen(false);
    }
    state.bar.querySelector('.ka-search').hidden = !open;
    state.bar.querySelector('.ka-search-button').setAttribute('aria-expanded', String(open));
    if (open) {
      runSearch();
      state.bar.querySelector('.ka-search-input').focus();
    }
  }

  function runSearch() {
    if (!isSearchOpen()) return;
    const query = state.bar.querySelector('.ka-search-input').value;
    window.postMessage({ source: EXT_SOURCE, type: 'search', query, requestId: ++searchRequest }, location.origin);
  }

  function renderSearchResults({ requestId, results, total, since }) {
    if (!isSearchOpen() || requestId !== searchRequest || !Array.isArray(results)) return;
    const query = state.bar.querySelector('.ka-search-input').value.trim();
    const span = since ? t('search.since', { time: new Date(since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : '';
    state.bar.querySelector('.ka-search-summary').textContent = query
      ? t('search.found', { found: results.length === 100 ? '100+' : results.length, total, since: span })
      : t('search.idle', { total, since: span });
    const list = state.bar.querySelector('.ka-search-results');
    // Re-render only when the results changed (keeps the scroll position).
    const signature = results.map(item => item.id).join();
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    const newQuery = list.dataset.query !== query;
    list.dataset.query = query;
    list.replaceChildren(...results.map(item => {
      const row = el('div', 'ka-inbox-item ka-search-item');
      row.dataset.id = item.id;
      const meta = el('div', 'ka-inbox-meta');
      meta.append(el('span', 'ka-inbox-user', item.username), el('span', 'ka-inbox-ago', formatAgo(item.at)));
      const text = el('div', 'ka-inbox-text');
      text.append(renderMessageText(String(item.content)));
      row.append(meta, text);
      return row;
    }));
    if (newQuery) list.scrollTop = 0;
  }

  // ---- Jump to a message (done by page-hook.js) -----------------------------------

  let jumpRequest = 0;
  let jumpItem = null;

  function requestJump(item) {
    if (!item.dataset.id) return;
    jumpItem = item;
    window.postMessage({ source: EXT_SOURCE, type: 'jump', id: item.dataset.id, requestId: ++jumpRequest }, location.origin);
  }

  function onJumpResult({ requestId, found, reason }) {
    if (requestId !== jumpRequest || !jumpItem) return;
    const item = jumpItem;
    jumpItem = null;
    if (found) {
      // Close first, so the chat is at its full height when page-hook.js scrolls.
      setInboxOpen(false);
      setSearchOpen(false);
      return;
    }
    item.setAttribute('data-gone', '');
    item.querySelector('.ka-inbox-ago').textContent =
      reason === 'unavailable' ? t('jump.unavailable') : t('jump.gone');
  }

  function applyInbox(inbox) {
    state.inbox = inbox && typeof inbox === 'object' ? inbox : {};
    renderInbox();
  }

  function formatAgo(at) {
    const minutes = Math.floor((Date.now() - at) / 60000);
    if (minutes < 1) return t('ago.now');
    if (minutes < 60) return t('ago.minutes', { n: minutes });
    if (minutes < 24 * 60) return t('ago.hours', { n: Math.floor(minutes / 60) });
    return new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  // Kick emote tokens as images; everything else as text.
  function renderMessageText(content) {
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of content.matchAll(/\[emote:(\d+):([^\]]*)\]/g)) {
      if (match.index > last) fragment.append(content.slice(last, match.index));
      const img = el('img', 'ka-emote');
      img.src = `https://files.kick.com/emotes/${match[1]}/fullsize`;
      img.alt = match[2];
      fragment.append(img);
      last = match.index + match[0].length;
    }
    if (last < content.length) fragment.append(content.slice(last));
    return fragment;
  }

  function renderInbox() {
    if (!state.bar) return;
    const button = state.bar.querySelector('.ka-inbox-button');
    const channel = currentChannel();
    const entry = (channel && state.inbox[channel]) || { items: [], seen: 0 };
    const open = isInboxOpen();
    button.hidden = !state.settings.highlights;
    if (button.hidden && open) state.bar.querySelector('.ka-inbox').hidden = true;

    const unread = open ? 0 : entry.items.filter(item => item.at > entry.seen).length;
    button.querySelector('.ka-inbox-count').textContent = unread ? String(unread) : '';
    button.toggleAttribute('data-unread', unread > 0);
    button.setAttribute('aria-label', unread ? t('inbox.labelUnread', { count: unread }) : t('inbox.label'));
    if (!open) return;

    state.bar.querySelector('.ka-inbox-title').textContent =
      `${t('inbox.title')}${channel ? ` · ${channel}` : ''}`;
    state.bar.querySelector('.ka-inbox-clear').hidden = !entry.items.length;
    const list = state.bar.querySelector('.ka-inbox .ka-inbox-list');
    if (!entry.items.length) {
      list.replaceChildren(el('div', 'ka-inbox-empty',
        t('inbox.empty')));
      return;
    }
    list.replaceChildren(...[...entry.items].reverse().map(item => {
      const row = el('div', 'ka-inbox-item');
      row.dataset.id = item.id;
      row.dataset.kind = item.kind;
      row.toggleAttribute('data-new', item.at > (state.inboxNewSince || 0));
      const meta = el('div', 'ka-inbox-meta');
      meta.append(el('span', 'ka-inbox-user', item.username), el('span', 'ka-inbox-ago', formatAgo(item.at)));
      const text = el('div', 'ka-inbox-text');
      text.append(renderMessageText(item.content));
      row.append(meta, text);
      return row;
    }));
  }


  function renderMuted() {
    const list = state.bar.querySelector('.ka-mute-list');
    const names = state.settings.mutedUsers;
    if (!names.length) {
      list.replaceChildren(el('span', 'ka-mute-empty', t('mute.empty')));
      return;
    }
    list.replaceChildren(...[...names].sort((a, b) => a.localeCompare(b)).map(name => {
      const chip = el('button', 'ka-mute-chip', `${name} ✕`);
      chip.type = 'button';
      chip.setAttribute('aria-label', t('mute.unmute', { name }));
      chip.addEventListener('click', () => removeMuted(name));
      return chip;
    }));
  }

  // ---- Stream info (popout, and channel pages) -----------------------------------
  // The popout shows no stream at all, so the strip carries a one-line summary. On a
  // channel page (compact channel info) the strip also takes over Kick's channel info
  // block under the video: avatar, name, the summary, and copies of Kick's buttons
  // (follow, subscribe, and when logged in the bell and gift subs).

  // kick.com/{slug} with its chat on the page.
  function channelPageSlug() {
    if (popoutSlug) return null;
    const parts = location.pathname.split('/').filter(Boolean);
    return parts.length === 1 && document.querySelector('#channel-content') ? parts[0].toLowerCase() : null;
  }

  // Whose stream the strip shows, if any.
  function streamSlug() {
    if (popoutSlug) return popoutSlug;
    return state.settings.channelStrip ? channelPageSlug() : null;
  }

  function showsStream() {
    return popoutSlug ? state.settings.streamInfo : Boolean(streamSlug());
  }

  function formatCount(count) {
    if (count >= 1e6) return `${(count / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (count >= 1e4) return `${Math.round(count / 1e3)}K`;
    if (count >= 1e3) return `${(count / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
    return String(count);
  }

  function formatUptime(ms) {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
  }

  async function refreshStream() {
    const slug = streamSlug();
    const { popoutAudio } = state.settings;
    if (!slug || !(showsStream() || (popoutSlug && popoutAudio))) return;
    if (document.visibilityState !== 'visible' && !isListening()) return;
    try {
      const data = await fetchChannel(slug);
      if (popoutSlug && popoutAudio) await updateListen(data);
      if (!showsStream() || streamSlug() !== slug) return;
      const { livestream } = data;
      const channel = { name: data.user?.username || slug, avatar: data.user?.profile_pic || '' };
      const category = livestream?.categories?.[0];
      state.stream = livestream?.is_live
        ? {
            live: true,
            channel,
            viewers: livestream.viewer_count ?? 0,
            // "2026-10-02 16:04:09" in UTC
            startedAt: Date.parse(`${livestream.start_time.replace(' ', 'T')}Z`),
            title: livestream.session_title || '',
            category: category?.name || '',
            categorySlug: category?.slug || ''
          }
        : { live: false, channel };
    } catch (err) {
      // Keep showing the last known state.
    }
    renderStream();
  }

  // SPA navigation: another channel (or none) → start over.
  function syncStreamSlug() {
    const slug = streamSlug();
    applyAttributes();
    if (slug === state.streamSlug) return;
    state.streamSlug = slug;
    restoreChannelButtons();
    state.stream = null;
    renderStream();
    if (slug) refreshStream();
  }

  function renderStream() {
    if (!state.bar) return;
    const stream = showsStream() ? state.stream : null;
    state.bar.toggleAttribute('data-stream', Boolean(stream));
    const line = state.bar.querySelector('.ka-stream');
    const details = state.bar.querySelector('.ka-stream-details');

    // Channel page: avatar and name instead of "Kickoff".
    const channel = !popoutSlug && streamSlug() ? stream?.channel || { name: streamSlug(), avatar: '' } : null;
    state.bar.toggleAttribute('data-channel', Boolean(channel));
    const ident = state.bar.querySelector('.ka-channel');
    if (channel) {
      const avatar = ident.querySelector('.ka-channel-avatar');
      if (channel.avatar && avatar.getAttribute('src') !== channel.avatar) avatar.src = channel.avatar;
      avatar.hidden = !channel.avatar;
      ident.querySelector('.ka-channel-name').textContent = channel.name;
    }

    if (!stream) {
      line.replaceChildren();
      details.replaceChildren();
      details.hidden = true;
    } else if (!stream.live) {
      line.replaceChildren(el('span', 'ka-offline', t('stream.offline')));
      details.replaceChildren();
      details.hidden = true;
    } else {
      const uptime = Number.isNaN(stream.startedAt) ? '' : ` · ${formatUptime(Date.now() - stream.startedAt)}`;
      line.replaceChildren(
        el('span', 'ka-live', t('stream.live')),
        el('span', 'ka-stream-meta', `${formatCount(stream.viewers)}${uptime}`),
        el('span', 'ka-stream-title', stream.title)
      );
      const since = Number.isNaN(stream.startedAt)
        ? ''
        : t('stream.liveSince', { time: new Date(stream.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
      const meta = el('div', 'ka-stream-details-meta');
      if (stream.category && stream.categorySlug && !popoutSlug) {
        const link = el('a', 'ka-stream-category', stream.category);
        link.href = `/category/${encodeURIComponent(stream.categorySlug)}`;
        meta.append(link, ' · ');
      } else if (stream.category) {
        meta.append(`${stream.category} · `);
      }
      meta.append([t('stream.viewers', { count: stream.viewers }), since].filter(Boolean).join(' · '));
      details.replaceChildren(el('div', 'ka-stream-details-title', stream.title), meta);
      details.hidden = false;
    }
    renderStatus();
  }

  // Kick's channel buttons, wherever they are (its info block stays mounted, hidden).
  function kickChannelButtons() {
    const follow = document.querySelector('#channel-content [data-testid="follow-button"]');
    const sub = document.querySelector('#channel-content [data-testid="sub-button"]');
    const first = follow || sub;
    if (!first) return [];
    let group = first.parentElement;
    while (group && !(group.contains(follow || sub) && group.contains(sub || follow))) group = group.parentElement;
    return group ? [...group.querySelectorAll('button')] : [];
  }

  function channelButtonLabel(button) {
    return button.getAttribute('aria-label') || button.textContent.trim() || t('strip.channelButton');
  }

  // Kick's subscribe/bell menus are popovers placed next to their button, so the
  // (invisible) button is moved under our copy first; then they open below the strip.
  const movedButtons = new Set();

  function pressChannelButton(index, copy) {
    const button = kickChannelButtons()[index];
    if (!button) return;
    const rect = copy.getBoundingClientRect();
    Object.assign(button.style, {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      minWidth: '0',
      margin: '0'
    });
    movedButtons.add(button);
    button.click();
  }

  // Compact info switched off or another page: Kick's buttons back in their place.
  function restoreChannelButtons() {
    for (const button of movedButtons) {
      for (const property of ['position', 'left', 'top', 'width', 'height', 'min-width', 'margin']) {
        button.style.removeProperty(property);
      }
    }
    movedButtons.clear();
  }

  // Our copies: same icon (cloned), same label; a tap presses Kick's button. Rebuilt
  // when Kick's change (followed, logged in…).
  function renderChannelActions() {
    const actions = state.bar?.querySelector('.ka-channel-actions');
    if (!actions) return;
    const buttons = state.bar.hasAttribute('data-channel') ? kickChannelButtons() : [];
    const signature = buttons.map(button => [
      button.querySelector('svg')?.dataset.dsIcon || '', channelButtonLabel(button), button.disabled
    ].join(':')).join('|');
    actions.hidden = !buttons.length;
    if (actions.dataset.signature === signature) return;
    actions.dataset.signature = signature;
    actions.replaceChildren(...buttons.map((button, index) => {
      const copy = el('button', 'ka-strip-button ka-channel-action');
      copy.type = 'button';
      const label = channelButtonLabel(button);
      copy.setAttribute('aria-label', label);
      copy.title = label;
      copy.disabled = button.disabled;
      const testId = button.dataset.testid;
      copy.dataset.kind = testId === 'sub-button' ? 'sub' : testId === 'follow-button' ? 'follow' : '';
      const icon = button.querySelector('svg');
      if (icon) {
        const clone = icon.cloneNode(true);
        clone.removeAttribute('class');
        clone.setAttribute('aria-hidden', 'true');
        copy.append(clone);
      } else {
        copy.textContent = label;
      }
      copy.addEventListener('click', () => pressChannelButton(index, copy));
      return copy;
    }));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshStream();
  });

  // Sit directly above the message area (a flex item, so the chat shrinks instead
  // of being covered). Kick is an SPA and re-renders the chat, so keep checking.
  function placeBar() {
    const messageArea = document.querySelector('#chatroom-messages')?.parentElement;
    if (!messageArea) return;
    if (!state.bar) {
      state.bar = buildBar();
      showSettingsTab(savedSettingsTab());
    }
    if (state.bar.nextElementSibling !== messageArea) {
      messageArea.before(state.bar);
      renderBar();
    }
  }

  // ---- Native player -------------------------------------------------------------
  // On a live channel page Kick's player is hidden (and kept paused) and a plain
  // <video> plays Kick's HLS stream, which Safari plays natively; a bar under it has
  // the controls. Kick's player stays mounted so its Clip and Theatre buttons can be
  // pressed for us. With allow_audio_only=true the stream also lists an audio-only
  // rendition: used for "Audio only", for the popout's listen button, and while the
  // page is in the background (iOS pauses video on the lock screen, not audio).

  const PLAYER_ATTR = 'data-ka-player'; // kickoff.css hides Kick's player
  // Phones: Kick's player box is a fixed 16:9 (inline height) and Kick hides the
  // channel info under it while the video plays untouched. We do the same: after
  // IDLE_MS of playing, the bar and the channel info fold away until a tap.
  const IDLE_ATTR = 'data-ka-player-idle';
  const IDLE_MS = 3000;
  const PLAYER_PREFS_KEY = 'kickoff:player'; // { volume, muted } in kick.com localStorage
  const PLAYER_RECHECK_MS = 60 * 1000; // offline channel, stream links
  const PLAYER_RETRY_MS = 3000;
  const PLAYER_RETRIES = 3; // then Kick's own player comes back
  const LIVE_EDGE_S = 6; // further behind than this = not live
  const AUTO = 'auto';
  const AUDIO_ONLY = 'audio';

  const ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
    volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z',
    muted: 'M3 9v6h4l5 5V4L7 9H3zm11.3.4l1.4-1.4 2.3 2.3 2.3-2.3 1.4 1.4-2.3 2.3 2.3 2.3-1.4 1.4-2.3-2.3-2.3 2.3-1.4-1.4 2.3-2.3z',
    clip: 'M9.64 7.64c.23-.5.36-1.05.36-1.64a4 4 0 1 0-4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36A3.9 3.9 0 0 0 6 14a4 4 0 1 0 4 4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 12a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM19 3l-6 6 2 2 7-7V3z',
    airplay: 'M6 22h12l-6-6zM21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4v-2H3V5h18v12h-4v2h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z',
    pip: 'M19 7h-8v6h8V7zm2-4H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18v14z',
    theatre: 'M19 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 12H5V7h14v10z',
    fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    exitFullscreen: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
    sleep: 'M12.34 2.02C6.59 1.82 2 6.42 2 12c0 5.52 4.48 10 10 10 3.71 0 6.93-2.02 8.66-5.02-7.51-.25-12.09-8.43-8.32-14.96z',
    headphones: 'M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z'
  };

  function playerIcon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ka-player-icon');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function setIcon(button, name) {
    if (button.dataset.icon === name) return;
    button.dataset.icon = name;
    button.replaceChildren(playerIcon(name));
  }

  async function fetchChannel(slug) {
    const response = await fetch(`/api/v2/channels/${encodeURIComponent(slug)}`, { credentials: 'omit' });
    if (!response.ok) throw new Error(`channel ${response.status}`);
    return response.json();
  }

  function streamInfo(data) {
    return {
      live: Boolean(data.livestream?.is_live && data.playback_url),
      playbackUrl: data.playback_url,
      title: data.livestream?.session_title || '',
      username: data.user?.username || data.slug || '',
      avatar: data.user?.profile_pic || ''
    };
  }

  // The renditions in the stream's master playlist: [{ id, name, url }], best first;
  // id is the NAME ("1080p", "720p60"…) or AUDIO_ONLY. The links are signed and
  // expire after a few minutes, so they're fetched again before every switch.
  async function fetchVariants(playbackUrl) {
    const url = `${playbackUrl}${playbackUrl.includes('?') ? '&' : '?'}allow_audio_only=true`;
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`playlist ${response.status}`);
    const variants = [];
    let name = null;
    let pending = null;
    for (const line of (await response.text()).split('\n').map(text => text.trim())) {
      if (line.startsWith('#EXT-X-MEDIA:')) {
        name = line.match(/NAME="([^"]+)"/)?.[1] || null;
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const height = line.match(/RESOLUTION=\d+x(\d+)/)?.[1];
        const bandwidth = Number(line.match(/BANDWIDTH=(\d+)/)?.[1]) || 0;
        const label = name || (height ? `${height}p` : 'audio_only');
        pending = label === 'audio_only'
          ? { id: AUDIO_ONLY, name: t('player.audioOnly'), bandwidth }
          : { id: label.toLowerCase(), name: label, bandwidth };
        name = null;
      } else if (line && !line.startsWith('#') && pending) {
        variants.push({ ...pending, url: new URL(line, url).href });
        pending = null;
      }
    }
    return variants.sort((a, b) => b.bandwidth - a.bandwidth);
  }

  function sourceFor(quality, info, variants) {
    if (quality === AUTO) return info.playbackUrl; // Safari picks (no audio-only in this list)
    return variants.find(variant => variant.id === quality)?.url || info.playbackUrl;
  }

  function setMediaSession(media, info, pause = () => media.pause()) {
    if (!('mediaSession' in navigator) || !info) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: info.title || info.username,
        artist: `${info.username} · Kick`,
        artwork: info.avatar ? [{ src: info.avatar, sizes: '256x256' }] : []
      });
      navigator.mediaSession.setActionHandler('play', () => media.play().catch(() => {}));
      navigator.mediaSession.setActionHandler('pause', pause);
    } catch (err) { /* metadata isn't essential */ }
  }

  // Lock screen / Control Center: the player or the popout's audio (also while
  // paused, so it can be resumed there), with the latest title (re-read every
  // minute); nothing once neither is on.
  function refreshMediaSession() {
    if (!('mediaSession' in navigator)) return;
    if (player.video) setMediaSession(player.video, player.info, pauseByUser);
    else if (isListening()) setMediaSession(listen.audio, listen.info);
    else {
      try { navigator.mediaSession.metadata = null; } catch (err) { /* not essential */ }
    }
  }

  // ---- Sleep timer -----------------------------------------------------------------
  // Stops the player and the popout's audio after the chosen time. Checked by a timer
  // and also on every timeupdate, in case iOS holds back timers on the lock screen.

  const SLEEP_CHOICES = [[0, t('sleep.off')], [15, t('sleep.minutes', { n: 15 })], [30, t('sleep.minutes', { n: 30 })], [60, t('sleep.hour')], [90, t('sleep.hourHalf')]];
  const sleep = { minutes: 0, until: 0, timer: null };

  function setSleep(minutes) {
    clearTimeout(sleep.timer);
    sleep.minutes = minutes;
    sleep.until = minutes ? Date.now() + minutes * 60000 : 0;
    if (minutes) sleep.timer = setTimeout(checkSleep, minutes * 60000 + 500);
    renderSleep();
  }

  function checkSleep() {
    if (!sleep.until || Date.now() < sleep.until) return;
    setSleep(0);
    if (player.video) pauseByUser();
    stopListen();
  }

  function sleepControl() {
    const control = el('label', 'ka-sleep');
    control.title = t('sleep.title');
    const select = el('select', 'ka-sleep-select');
    select.setAttribute('aria-label', t('sleep.title'));
    for (const [minutes, label] of SLEEP_CHOICES) {
      const option = el('option', '', label);
      option.value = String(minutes);
      select.append(option);
    }
    select.addEventListener('change', () => setSleep(Number(select.value)));
    select.addEventListener('click', event => event.stopPropagation());
    control.append(playerIcon('sleep'), el('span', 'ka-sleep-left'), select);
    return control;
  }

  function renderSleep() {
    const left = sleep.until ? Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000)) : 0;
    for (const control of document.querySelectorAll('.ka-sleep')) {
      control.toggleAttribute('data-active', Boolean(left));
      const text = left ? `${left}m` : '';
      const leftNode = control.querySelector('.ka-sleep-left');
      if (leftNode.textContent !== text) leftNode.textContent = text;
      control.title = left ? t('sleep.stopsIn', { n: left }) : t('sleep.title');
      const select = control.querySelector('select');
      if (document.activeElement !== select) select.value = String(sleep.minutes);
    }
  }

  // iOS ignores volume (hardware buttons only), so the slider is left out there.
  const volumeSettable = (() => {
    const probe = document.createElement('video');
    probe.volume = 0.5;
    return probe.volume === 0.5;
  })();

  function readPlayerPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(PLAYER_PREFS_KEY) || '{}');
      return { volume: Number.isFinite(prefs.volume) ? Math.min(1, Math.max(0, prefs.volume)) : 1, muted: prefs.muted === true };
    } catch (err) {
      return { volume: 1, muted: false };
    }
  }

  function savePlayerPrefs(media) {
    try {
      localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify({ volume: media.volume, muted: media.muted }));
    } catch (err) { /* private mode */ }
  }

  const player = {
    slug: null,
    info: null,
    variants: [],
    quality: AUTO,        // chosen in the menu
    background: false,    // switched to audio only because the page is hidden
    autoMuted: false,     // muted only because Safari refused autoplay with sound
    wantPlay: false,      // playing unless you paused it (iOS also pauses on its own)
    load: 0,              // newest source switch, so slow fetches can't win
    checking: false,
    offline: null,        // { slug, at } of the last "not live" answer
    refreshedAt: 0,
    retryTimer: null,
    retries: 0,           // failed loads since it last played
    idleTimer: null,
    failed: null,         // slug our player gave up on (until the page changes)
    wrap: null,
    video: null
  };

  function kickPlayer() {
    return document.querySelector('#injected-channel-player');
  }

  function kickButton(name) {
    return kickPlayer()?.querySelector(`[data-testid="video-player-${name}"]`) || null;
  }

  // Live channel page (kick.com/{slug}) with Kick's player on it, setting on.
  function playerTarget() {
    if (popoutSlug || !state.settings.nativePlayer) return null;
    const parts = location.pathname.split('/').filter(Boolean);
    const kick = kickPlayer();
    return parts.length === 1 && kick ? { slug: parts[0].toLowerCase(), kick } : null;
  }

  async function syncPlayer() {
    const target = playerTarget();
    if (!target || (player.wrap && player.slug !== target.slug)) unmountPlayer();
    if (target?.slug !== player.failed) player.failed = null;
    if (!target) return;
    if (player.wrap) {
      // Kick re-renders; stay right before its (hidden) player.
      if (player.wrap.nextElementSibling !== target.kick) target.kick.before(player.wrap);
      // Also while it plays on the lock screen (new title for Control Center).
      if (Date.now() - player.refreshedAt > PLAYER_RECHECK_MS && (document.visibilityState === 'visible' || player.wantPlay)) refreshSource();
      renderPlayer();
      return;
    }
    const { offline } = player;
    if (player.failed === target.slug) return;
    if (player.checking || (offline?.slug === target.slug && Date.now() - offline.at < PLAYER_RECHECK_MS)) return;
    player.checking = true;
    try {
      const info = streamInfo(await fetchChannel(target.slug));
      const variants = info.live ? await fetchVariants(info.playbackUrl) : [];
      const now = playerTarget();
      if (now?.slug !== target.slug || player.wrap) return; // navigated away meanwhile
      if (!info.live) {
        player.offline = { slug: target.slug, at: Date.now() };
        return;
      }
      mountPlayer(now, info, variants);
    } catch (err) {
      player.offline = { slug: target.slug, at: Date.now() };
      console.error('Kickoff: player', err);
    } finally {
      player.checking = false;
    }
  }

  function mountPlayer(target, info, variants) {
    player.slug = target.slug;
    player.info = info;
    player.variants = variants;
    player.quality = AUTO;
    player.background = false;
    player.refreshedAt = Date.now();
    player.offline = null;
    player.retries = 0;
    player.wantPlay = true;
    buildPlayer();
    target.kick.before(player.wrap);
    root.setAttribute(PLAYER_ATTR, '');
    pauseKickPlayer();
    const prefs = readPlayerPrefs();
    const video = player.video;
    video.volume = prefs.volume;
    video.muted = prefs.muted;
    video.src = sourceFor(AUTO, info, variants);
    startPlayback(true);
    renderPlayer();
  }

  function unmountPlayer() {
    clearTimeout(player.retryTimer);
    if (!player.wrap) return;
    const video = player.video;
    video.pause();
    video.removeAttribute('src');
    video.load(); // stops downloading
    player.wrap.remove();
    player.wrap = null;
    player.video = null;
    player.slug = null;
    player.load++;
    player.wantPlay = false;
    root.removeAttribute(PLAYER_ATTR);
    showControls(false);
    refreshMediaSession();
  }

  function isPhoneLayout() {
    return Boolean(player.wrap?.parentElement?.style.height.includes('56.25'));
  }

  // Show the bar (and Kick's channel info); fold them away again after a while
  // when the video plays on a phone.
  function showControls(restart = true) {
    clearTimeout(player.idleTimer);
    root.removeAttribute(IDLE_ATTR);
    if (restart && isPhoneLayout() && player.video && !player.video.paused) {
      player.idleTimer = setTimeout(hideControls, IDLE_MS);
    }
  }

  function hideControls() {
    clearTimeout(player.idleTimer);
    if (isPhoneLayout() && player.video && !player.video.paused) root.setAttribute(IDLE_ATTR, '');
  }

  // Kick's player keeps trying to play (autoplay, its own retries); keep it quiet.
  function pauseKickPlayer() {
    for (const media of kickPlayer()?.querySelectorAll('video, audio') || []) {
      media.muted = true;
      if (!media.paused) media.pause();
    }
  }

  document.addEventListener('play', event => {
    if (root.hasAttribute(PLAYER_ATTR) && event.target !== player.video && event.target.closest?.('#injected-channel-player')) {
      pauseKickPlayer();
    }
  }, true);

  // Safari may refuse sound without a tap (page load): then play muted and show
  // "Tap to unmute".
  function startPlayback(fromLoad = false) {
    const video = player.video;
    if (!video) return;
    // Refused (no tap yet, Low Power Mode): it stays paused until you press play.
    const refused = err => {
      if (err.name === 'NotAllowedError') player.wantPlay = false;
    };
    video.play().catch(err => {
      if (err.name !== 'NotAllowedError' || !fromLoad || video.muted) return refused(err);
      video.muted = true;
      player.autoMuted = true;
      return video.play().catch(refused);
    }).finally(renderPlayer);
  }

  // Load another rendition (or fresh links for the same one). `fresh` fetches new
  // signed links first; in the background there may be no time for that.
  async function switchSource(quality, { fresh = true } = {}) {
    const video = player.video;
    if (!video) return;
    const load = ++player.load;
    if (fresh) {
      try {
        const info = streamInfo(await fetchChannel(player.slug));
        if (load !== player.load) return;
        if (!info.live) {
          endStream();
          return;
        }
        player.variants = await fetchVariants(info.playbackUrl);
        player.info = info;
        player.refreshedAt = Date.now();
      } catch (err) {
        console.error('Kickoff: player links', err);
      }
      if (load !== player.load) return;
    }
    video.src = sourceFor(quality, player.info, player.variants);
    if (player.wantPlay) startPlayback();
    renderPlayer();
  }

  // Fresh links for the background switch, without touching what's playing.
  async function refreshSource() {
    player.refreshedAt = Date.now();
    try {
      const info = streamInfo(await fetchChannel(player.slug));
      if (!player.wrap) return;
      if (!info.live) return; // the video's own error/ended handling decides
      player.variants = await fetchVariants(info.playbackUrl);
      player.info = info;
      renderPlayer();
      refreshMediaSession();
    } catch (err) { /* try again next time */ }
  }

  function endStream() {
    const slug = player.slug;
    unmountPlayer();
    player.offline = { slug, at: Date.now() };
  }

  // A few tries with fresh links (switchSource also notices a stream that ended);
  // if it still won't play, hand back to Kick's player.
  function retryPlayer() {
    clearTimeout(player.retryTimer);
    if (++player.retries > PLAYER_RETRIES) {
      console.error('Kickoff: native player failed, using Kick\'s player', player.video?.error);
      const slug = player.slug;
      unmountPlayer();
      player.failed = slug;
      return;
    }
    player.retryTimer = setTimeout(() => {
      if (player.wrap) switchSource(currentQuality());
    }, PLAYER_RETRY_MS * player.retries);
  }

  function currentQuality() {
    return player.background ? AUDIO_ONLY : player.quality;
  }

  function isPictureInPicture(video) {
    return video.webkitPresentationMode === 'picture-in-picture' || document.pictureInPictureElement === video;
  }

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function liveEdge(video) {
    const { seekable } = video;
    return seekable.length ? seekable.end(seekable.length - 1) : null;
  }

  function isBehindLive(video) {
    const edge = liveEdge(video);
    return edge != null && edge - video.currentTime > LIVE_EDGE_S;
  }

  function goLive() {
    const video = player.video;
    const edge = video && liveEdge(video);
    if (edge != null) video.currentTime = Math.max(0, edge - 2);
    if (video?.paused) startPlayback();
  }

  // Background audio: the lock screen (and a hidden tab) switches to the
  // audio-only rendition and back. Not while the picture is still shown somewhere
  // (picture in picture, AirPlay).
  document.addEventListener('visibilitychange', () => {
    const video = player.video;
    if (!video) return;
    if (document.visibilityState === 'hidden') {
      if (!state.settings.backgroundAudio || !player.wantPlay || player.quality === AUDIO_ONLY || player.background
        || isPictureInPicture(video) || video.webkitCurrentPlaybackTargetIsWireless) return;
      player.background = true;
      switchSource(AUDIO_ONLY, { fresh: false });
    } else if (player.background) {
      player.background = false;
      switchSource(player.quality);
    }
  });

  function playerButton(name, label, onClick) {
    const button = el('button', `ka-player-button ka-player-${name}`);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    setIcon(button, name);
    button.addEventListener('mousedown', event => event.preventDefault()); // keep keyboard focus off
    button.addEventListener('click', event => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function buildPlayer() {
    const wrap = el('div', 'ka-player');
    wrap.dataset.kickoff = 'player';
    const stage = el('div', 'ka-player-stage');
    const video = el('video', 'ka-player-video');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('x-webkit-airplay', 'allow');
    video.preload = 'auto';
    const audioCard = el('div', 'ka-player-audio-card');
    audioCard.append(el('img', 'ka-player-avatar'), el('span', 'ka-player-audio-label', t('player.audioOnly')));
    const unmute = el('button', 'ka-player-unmute', t('player.tapToUnmute'));
    unmute.type = 'button';
    stage.append(video, audioCard, unmute);

    const unmuteNow = () => {
      video.muted = false;
      player.autoMuted = false;
      savePlayerPrefs(video);
      if (video.paused) startPlayback();
    };
    unmute.addEventListener('click', event => {
      event.stopPropagation();
      unmuteNow();
    });
    stage.addEventListener('click', () => {
      if (player.autoMuted) unmuteNow();
      else if (isPhoneLayout() && !video.paused) {
        // Phones: a tap shows or hides the controls (pause is in the bar), like Kick.
        if (root.hasAttribute(IDLE_ATTR)) showControls();
        else hideControls();
      }
      else if (video.paused) playOrLive();
      else pauseByUser();
    });
    stage.addEventListener('dblclick', toggleFullscreen);

    const bar = el('div', 'ka-player-bar');
    const play = playerButton('play', t('player.play'), () => (video.paused ? playOrLive() : pauseByUser()));
    const mute = playerButton('volume', t('player.mute'), () => {
      if (player.autoMuted || video.muted) unmuteNow();
      else {
        video.muted = true;
        savePlayerPrefs(video);
      }
    });
    mute.classList.add('ka-player-mute');
    const volume = el('input', 'ka-player-slider');
    volume.type = 'range';
    volume.min = '0';
    volume.max = '1';
    volume.step = '0.05';
    volume.setAttribute('aria-label', t('player.volume'));
    volume.hidden = !volumeSettable;
    volume.addEventListener('input', () => {
      video.volume = Number(volume.value);
      video.muted = video.volume === 0;
      player.autoMuted = false;
      savePlayerPrefs(video);
    });
    const live = el('button', 'ka-player-live');
    live.append(el('span', 'ka-player-live-label', t('player.live')), el('span', 'ka-player-live-delay'));
    live.type = 'button';
    live.title = t('player.goLiveTitle');
    live.addEventListener('click', event => {
      event.stopPropagation();
      goLive();
    });
    const quality = el('select', 'ka-player-quality');
    quality.setAttribute('aria-label', t('player.quality'));
    quality.addEventListener('change', () => {
      player.quality = quality.value;
      player.background = false;
      switchSource(player.quality);
    });
    const clip = playerButton('clip', t('player.clip'), () => kickButton('clip')?.click());
    const airplay = playerButton('airplay', 'AirPlay', () => video.webkitShowPlaybackTargetPicker?.());
    airplay.hidden = true;
    video.addEventListener('webkitplaybacktargetavailabilitychanged', event => {
      airplay.hidden = event.availability !== 'available';
    });
    const pip = playerButton('pip', t('player.pip'), togglePictureInPicture);
    pip.hidden = !(video.webkitSupportsPresentationMode?.('picture-in-picture') || document.pictureInPictureEnabled);
    const theatre = playerButton('theatre', t('player.theatre'), () => {
      kickButton('theatre-mode')?.click();
      setTimeout(renderPlayer, 100);
    });
    const fullscreen = playerButton('fullscreen', t('player.fullscreen'), toggleFullscreen);
    bar.append(play, mute, volume, live, el('span', 'ka-player-spacer'), sleepControl(), quality, clip, airplay, pip, theatre, fullscreen);
    wrap.append(stage, bar);
    bar.addEventListener('click', () => showControls());
    bar.addEventListener('change', () => showControls());

    for (const type of ['play', 'pause', 'volumechange', 'playing', 'waiting', 'loadedmetadata']) {
      video.addEventListener(type, renderPlayer);
    }
    video.addEventListener('play', () => {
      player.wantPlay = true;
      setMediaSession(video, player.info, pauseByUser);
    });
    video.addEventListener('timeupdate', renderLive);
    video.addEventListener('timeupdate', checkSleep);
    video.addEventListener('playing', () => { player.retries = 0; });
    video.addEventListener('playing', () => showControls());
    video.addEventListener('pause', () => showControls(false));
    video.addEventListener('resize', () => renderPlayer()); // Auto shows the picked size
    video.addEventListener('error', retryPlayer);
    video.addEventListener('ended', retryPlayer); // stream ended or a hiccup; the retry checks

    player.wrap = wrap;
    player.video = video;
  }

  document.addEventListener('fullscreenchange', () => renderPlayer());
  document.addEventListener('webkitfullscreenchange', () => renderPlayer());

  function pauseByUser() {
    player.wantPlay = false;
    player.video?.pause();
  }

  // Mac keyboard: Space/K play-pause, M mute, F fullscreen, T theatre, L live, ↑/↓
  // volume (with the pointer over the player). Not while typing.
  document.addEventListener('keydown', event => {
    const { wrap, video } = player;
    if (!wrap || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target.isContentEditable || target.closest?.('input, textarea, select, button, [contenteditable]')) return;
    const press = name => wrap.querySelector(`.ka-player-${name}`)?.click();
    const volumeStep = step => {
      if (!volumeSettable || !wrap.matches(':hover')) return false;
      video.volume = Math.min(1, Math.max(0, Math.round((video.volume + step) * 20) / 20));
      video.muted = video.volume === 0;
      player.autoMuted = false;
      savePlayerPrefs(video);
      return true;
    };
    const actions = {
      ' ': () => press('play'),
      k: () => press('play'),
      m: () => press('mute'),
      f: () => toggleFullscreen(),
      t: () => press('theatre'),
      l: () => goLive(),
      arrowup: () => volumeStep(0.05),
      arrowdown: () => volumeStep(-0.05)
    };
    const action = actions[event.key.toLowerCase()];
    if (!action || action() === false) return;
    event.preventDefault();
    event.stopPropagation();
    showControls();
  }, true);

  // After a pause, playing again goes back to live (there's no seeking).
  function playOrLive() {
    const video = player.video;
    if (video && isBehindLive(video)) goLive();
    else startPlayback();
  }

  function togglePictureInPicture() {
    const video = player.video;
    if (!video) return;
    if (video.webkitSupportsPresentationMode?.('picture-in-picture')) {
      video.webkitSetPresentationMode(isPictureInPicture(video) ? 'inline' : 'picture-in-picture');
    } else if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    } else {
      video.requestPictureInPicture?.().catch(() => {});
    }
  }

  // Fullscreen the player with our bar where Safari allows it (Mac, iPad); the
  // iPhone only does the video itself, with Apple's controls.
  function toggleFullscreen() {
    const { wrap, video } = player;
    if (!wrap) return;
    if (fullscreenElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
      (wrap.requestFullscreen || wrap.webkitRequestFullscreen).call(wrap);
    } else {
      video.webkitEnterFullscreen?.();
    }
  }

  // Seconds behind the streamer: the stream stamps every segment with its broadcast
  // time (EXT-X-PROGRAM-DATE-TIME), which Safari gives as the date of time 0. Without
  // it, the distance from the newest buffered moment.
  function liveDelay(video) {
    const start = video.getStartDate?.().getTime();
    const delay = Number.isFinite(start) && start > 0
      ? (Date.now() - start) / 1000 - video.currentTime
      : (liveEdge(video) ?? NaN) - video.currentTime;
    return delay >= 0 && delay < 6 * 3600 ? delay : null;
  }

  function formatDelay(seconds) {
    if (seconds < 9.95) return `${seconds.toFixed(1)}s`;
    const whole = Math.round(seconds);
    if (whole < 60) return `${whole}s`;
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  // LIVE + the delay; grey "Go live" when paused or behind (tap jumps to live).
  function renderLive() {
    const live = player.wrap?.querySelector('.ka-player-live');
    if (!live) return;
    const video = player.video;
    const behind = video.paused || isBehindLive(video);
    const delay = video.paused || video.readyState < 2 ? null : liveDelay(video);
    const text = delay == null ? '' : formatDelay(delay);
    live.toggleAttribute('data-behind', behind);
    const label = behind ? t('player.goLive') : t('player.live');
    const labelNode = live.querySelector('.ka-player-live-label');
    if (labelNode.textContent !== label) labelNode.textContent = label;
    const delayNode = live.querySelector('.ka-player-live-delay');
    if (delayNode.textContent !== text) delayNode.textContent = text;
    live.title = behind
      ? (text ? t('player.jumpToLiveBehind', { delay: text }) : t('player.jumpToLive'))
      : (text ? t('player.behind', { delay: text }) : t('player.liveTitle'));
  }

  function renderPlayer() {
    const { wrap, video, info } = player;
    if (!wrap) return;
    const audioOnly = currentQuality() === AUDIO_ONLY;
    wrap.toggleAttribute('data-audio', audioOnly);
    wrap.toggleAttribute('data-waiting', video.readyState < 3 && !video.paused);
    const avatar = wrap.querySelector('.ka-player-avatar');
    if (info?.avatar && avatar.getAttribute('src') !== info.avatar) avatar.src = info.avatar;
    avatar.hidden = !info?.avatar;
    wrap.querySelector('.ka-player-unmute').hidden = !player.autoMuted;

    const play = wrap.querySelector('.ka-player-play');
    setIcon(play, video.paused ? 'play' : 'pause');
    play.setAttribute('aria-label', video.paused ? t('player.play') : t('player.pause'));
    const mute = wrap.querySelector('.ka-player-mute');
    setIcon(mute, video.muted ? 'muted' : 'volume');
    mute.setAttribute('aria-label', video.muted ? t('player.unmute') : t('player.mute'));
    mute.title = mute.getAttribute('aria-label');
    const slider = wrap.querySelector('.ka-player-slider');
    if (document.activeElement !== slider) slider.value = String(video.muted ? 0 : video.volume);

    const quality = wrap.querySelector('.ka-player-quality');
    const size = player.quality === AUTO && !audioOnly && video.videoHeight ? ` · ${video.videoHeight}p` : '';
    const options = [[AUTO, `${t('player.auto')}${size}`], ...player.variants.filter(v => v.id !== AUDIO_ONLY).map(v => [v.id, v.name])];
    if (player.variants.some(v => v.id === AUDIO_ONLY)) options.push([AUDIO_ONLY, t('player.audioOnly')]);
    const signature = options.map(([id, name]) => `${id}=${name}`).join();
    if (quality.dataset.signature !== signature) {
      quality.dataset.signature = signature;
      quality.replaceChildren(...options.map(([id, name]) => {
        const option = el('option', '', name);
        option.value = id;
        return option;
      }));
    }
    quality.value = player.quality;

    const clip = kickButton('clip');
    const ourClip = wrap.querySelector('.ka-player-clip');
    ourClip.hidden = !clip;
    ourClip.disabled = Boolean(clip?.disabled);
    const theatre = wrap.querySelector('.ka-player-theatre');
    theatre.hidden = !kickButton('theatre-mode') || Boolean(fullscreenElement());
    theatre.setAttribute('aria-pressed', String(document.querySelector('[data-theatre]')?.dataset.theatre === 'true'));
    wrap.querySelector('.ka-player-pip').disabled = audioOnly;
    const fullscreen = wrap.querySelector('.ka-player-fullscreen');
    setIcon(fullscreen, fullscreenElement() ? 'exitFullscreen' : 'fullscreen');
    renderLive();
    renderSleep();
  }

  // ---- Listen button (popout) ------------------------------------------------------
  // Audio-only stream in an <audio> element: keeps playing on the lock screen and
  // shows there with the channel's name and picture. The link is fetched ahead
  // (with the stream info), so a tap can start playback right away: iOS only
  // allows starting sound directly from a tap.

  const listen = { audio: null, url: null, info: null, retried: false };

  async function updateListen(data) {
    const info = streamInfo(data);
    listen.info = info;
    if (isListening()) refreshMediaSession();
    if (!info.live) {
      listen.url = null;
    } else {
      try {
        listen.url = (await fetchVariants(info.playbackUrl)).find(variant => variant.id === AUDIO_ONLY)?.url || info.playbackUrl;
      } catch (err) {
        listen.url = info.playbackUrl; // the full stream still gives sound
      }
    }
    renderListen();
  }

  function listenAudio() {
    if (listen.audio) return listen.audio;
    const audio = new Audio();
    audio.preload = 'none';
    for (const type of ['play', 'pause', 'playing', 'waiting']) audio.addEventListener(type, () => renderListen());
    audio.addEventListener('play', () => setMediaSession(audio, listen.info));
    audio.addEventListener('timeupdate', checkSleep);
    audio.addEventListener('playing', () => { listen.retried = false; });
    // Old link or a hiccup: fetch a new link and try once more.
    audio.addEventListener('error', async () => {
      if (!audio.getAttribute('src') || listen.retried) {
        stopListen();
        return;
      }
      listen.retried = true;
      try {
        await updateListen(await fetchChannel(popoutSlug));
      } catch (err) { /* stop below */ }
      if (!listen.url) {
        stopListen();
        return;
      }
      audio.src = listen.url;
      audio.play().catch(stopListen);
    });
    listen.audio = audio;
    return audio;
  }

  function toggleListen() {
    const audio = listenAudio();
    if (audio.getAttribute('src')) {
      stopListen();
      return;
    }
    if (!listen.url) {
      // Offline or not loaded yet: check now (the tap may no longer count by then).
      refreshStream();
      renderListen(true);
      return;
    }
    listen.retried = false;
    audio.src = listen.url;
    audio.play().catch(err => {
      console.error('Kickoff: listen', err);
      stopListen();
    });
    renderListen();
  }

  function stopListen() {
    const audio = listen.audio;
    if (!audio?.getAttribute('src')) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load(); // stops downloading
    renderListen();
    refreshMediaSession();
  }

  // Listening is on (playing or paused from the lock screen).
  function isListening() {
    return Boolean(listen.audio?.getAttribute('src'));
  }

  function renderListen(flash = false) {
    const button = state.bar?.querySelector('.ka-listen-button');
    if (!button) return;
    button.hidden = !popoutSlug || !state.settings.popoutAudio;
    const audio = listen.audio;
    const on = Boolean(audio?.getAttribute('src'));
    button.dataset.state = !on ? (listen.info && !listen.info.live ? 'offline' : '')
      : audio.paused ? 'paused' : audio.readyState < 3 ? 'loading' : 'playing';
    button.setAttribute('aria-pressed', String(on));
    state.bar.querySelector('.ka-listen-sleep').hidden = button.hidden || (!on && !sleep.until);
    const label = on ? t('listen.stop') : listen.info && !listen.info.live ? t('listen.offline') : t('listen.start');
    button.setAttribute('aria-label', label);
    button.title = label;
    if (flash) {
      button.setAttribute('data-flash', '');
      setTimeout(() => button.removeAttribute('data-flash'), 600);
    }
  }

  // ---- Apply -------------------------------------------------------------------

  // Our html attributes are how kickoff.css and page-hook.js know which
  // features are on. Kick's framework can re-render the <html> element and drop
  // them (seen on the iOS channel page), so they're re-applied whenever <html>'s
  // attributes change. Only differences are written, so this can't loop.
  function setAttr(name, on, value = '') {
    if (on ? root.getAttribute(name) !== value : root.hasAttribute(name)) {
      if (on) root.setAttribute(name, value);
      else root.removeAttribute(name);
    }
  }

  function applyAttributes() {
    for (const [key, attr] of Object.entries(FEATURE_ATTRS)) setAttr(attr, Boolean(state.settings[key]));
    setAttr(CHAT_FONT_ATTR, state.settings.chatFont !== 'kick', state.settings.chatFont);
    setAttr(POPOUT_ATTR, Boolean(popoutSlug));
    setAttr(CHANNEL_STRIP_ATTR, Boolean(streamSlug() && !popoutSlug));
    const size = state.settings.fontSize;
    setAttr(FONT_SIZE_ATTR, size != null, String(size));
    const words = state.settings.highlightWords || [];
    setAttr(HIGHLIGHT_WORDS_ATTR, words.length > 0, JSON.stringify(words));
    const hidden = state.settings.hideWords || [];
    setAttr(HIDE_WORDS_ATTR, hidden.length > 0, JSON.stringify(hidden));
    const muted = state.settings.mutedUsers;
    setAttr(MUTED_USERS_ATTR, muted.length > 0, JSON.stringify(muted));
    if (state.fontStyle && !state.fontStyle.isConnected) (document.head || root).append(state.fontStyle);
  }

  new MutationObserver(applyAttributes).observe(root, { attributes: true });

  function applySettings(settings) {
    state.settings = { ...DEFAULTS, ...settings };
    if (!Array.isArray(state.settings.mutedUsers)) state.settings.mutedUsers = [];
    // Before the font choice there was only the SF switch (sfFont).
    if (!CHAT_FONTS.some(([value]) => value === settings.chatFont)) {
      state.settings.chatFont = settings.sfFont === false ? 'kick' : 'sf';
    }

    applyFontSize(state.settings.fontSize);
    applyAttributes();

    if (state.settings.wakeLock) acquireWakeLock();
    else releaseWakeLock();

    const streamWasOff = !state.stream;
    renderBar();
    if ((state.settings.streamInfo && streamWasOff) || (state.settings.popoutAudio && !listen.url)) refreshStream();
    syncStreamSlug();
    if (!state.settings.popoutAudio) stopListen();
    syncPlayer();
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (SETTINGS_KEY in changes) applySettings(changes[SETTINGS_KEY].newValue || {});
    if (MESSAGES_KEY in changes) postMessages(changes[MESSAGES_KEY].newValue || []);
    if (USAGE_KEY in changes) postUsage(cleanUsage(changes[USAGE_KEY].newValue));
    if (INBOX_KEY in changes) applyInbox(changes[INBOX_KEY].newValue || {});
    if (BLOCK_STATUS_KEY in changes) {
      state.blockStatus = changes[BLOCK_STATUS_KEY].newValue;
      renderBlockHint();
    }
  });

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'kickoff:ping') return Promise.resolve(true);
    if (message?.type === 'kickoff:togglePanel') {
      setPanelOpen(!isPanelOpen());
      return Promise.resolve(true);
    }
  });

  applySettings(DEFAULTS); // defaults right away; stored settings follow
  injectPageHook();
  placeBar();
  function poll() {
    checkSleep(); // also while hidden (locked phone, audio playing)
    if (document.hidden) {
      // The rest is what's on screen (caught up when shown), except fresh stream
      // links and the lock screen title while our player plays.
      if (player.wantPlay) syncPlayer();
      return;
    }
    placeBar();
    syncPlayer();
    syncStreamSlug();
    renderChannelActions();
    renderSleep();
    if (isPanelOpen()) {
      renderHealth();
      fitPanel(); // Kick's layout moves (channel info folding, keyboard)
    }
    runSearch(); // new messages come in while the search is open
  }

  setInterval(poll, BAR_POLL_MS);
  // Settings and saved messages changed on another device arrive through
  // background.js (iCloud), which pulls when asked: on load and on coming back.
  const requestSync = () => browser.runtime.sendMessage({ type: 'kickoff:sync' }).catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      poll();
      renderStream();
      requestSync();
    }
  });
  requestSync();
  setInterval(refreshStream, STREAM_REFRESH_MS); // nothing to do without a stream to show
  setInterval(() => document.hidden || renderStream(), STREAM_TICK_MS);

  browser.storage.local.get(SETTINGS_KEY).then(result => {
    applySettings(result[SETTINGS_KEY] || {});
  }).finally(() => state.settingsLoaded());
  readMessages().then(postMessages); // in case page-hook.js asked before we were listening
  readInbox().then(applyInbox);
  browser.storage.local.get(SETTINGS_SEEN_KEY).then(result => {
    state.settingsSeen = Boolean(result[SETTINGS_SEEN_KEY]);
    renderSettingsHint();
  });
  browser.storage.local.get(BLOCK_STATUS_KEY).then(result => {
    state.blockStatus = result[BLOCK_STATUS_KEY];
    renderBlockHint();
  });
  window.visualViewport?.addEventListener('resize', fitPanel);
  window.addEventListener('resize', fitPanel);
})();
