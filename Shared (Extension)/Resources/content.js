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
    chatLinks: 'tab', // one of LINK_MODES
    sevenTv: true,
    streamInfo: true, // the strip shows the stream (popout and channel pages alike)
    donateLinks: {}, // channel slug -> donate URL set by hand; else one found among the channel's links
    savedMessages: true,
    highlights: true,
    highlightWords: [],
    highlightStreamer: true,
    hideWords: [], // messages containing these are hidden
    muteUsers: true,
    mutedUsers: [], // usernames as shown in chat; matched in any case
    highlightUsers: [], // same, their messages are highlighted
    botUsers: [], // same, chat bots: added to the known ones (collapsing, learning !commands)
    collapseRepeats: true,
    rewardEvents: 'full', // Kick's point rewards: one of EVENT_MODES
    subEvents: 'full',    // subs, gifted subs, Kicks gifts: same
    chatCommands: true,
    sevenTvCosmetics: true,
    hideEmoteOnly: false,
    hideBots: true,
    readableNames: true,
    chatMentions: true,
    userCard: true,
    chatStripes: false,
    iosInput: true,
    fontSize: null, // null = Kick's own size
    theatreMode: true, // Kick's theatre mode switched on when a channel opens
    startUnmuted: true, // Kick's player unmuted when a channel opens
    nativePlayer: false, // off: HLS in Safari sits ~30 s behind live vs ~5 s in Kick's player
    backgroundAudio: true,
    popoutAudio: true,
    appQuality: 'best', // Kickoff app player: best, 1080…160 (height), auto, audio
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
    chatCommands: 'data-ka-commands',
    sevenTvCosmetics: 'data-ka-7tv-cosmetics',
    hideEmoteOnly: 'data-ka-emote-only',
    hideBots: 'data-ka-bots',
    readableNames: 'data-ka-readable-names',
    chatMentions: 'data-ka-mentions',
    userCard: 'data-ka-user-card',
    chatStripes: 'data-ka-stripes',
    iosInput: 'data-ka-ios',
    blockAds: 'data-ka-block-ads' // page-hook.js rewrites Kick's player answer
  };

  // Settings panel tabs, in order. Each lists its rows: a setting key is a switch,
  // the other names are the rows buildBar makes itself.
  const SETTINGS_TABS = {
    general: ['wakeLock', 'chatOnly', 'streamInfo', 'donate', 'blockAds'],
    chat: ['font', 'size', 'readableNames', 'chatMentions', 'chatStripes', 'sevenTv', 'sevenTvCosmetics', 'linkPreviews', 'chatLinks', 'restoreDeleted', 'savedMessages', 'chatCommands', 'userCard', 'iosInput'],
    filters: ['highlights', 'highlightWords', 'highlightUsers', 'highlightStreamer', 'hideWords', 'hideEmoteOnly', 'collapseRepeats', 'rewardEvents', 'subEvents', 'hideBots', 'botUsers', 'muteUsers', 'mutedUsers', 'notes'],
    player: ['theatreMode', 'startUnmuted', 'appPlayer', 'nativePlayer', 'backgroundAudio', 'popoutAudio']
  };
  // Switches that only do something while another one is on; dimmed otherwise.
  const SETTING_NEEDS = {
    backgroundAudio: 'nativePlayer'
  };
  const SETTINGS_TAB_KEY = 'kickoff:settingsTab'; // last open tab, in kick.com localStorage
  const TOOLS_FOLDED_KEY = 'kickoff:toolsFolded'; // strip's button row folded, same

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
  // Kick's event cards (point rewards; subs and gifts): as Kick draws them, one
  // line, or hidden. page-hook.js follows these attributes (none = full).
  const EVENT_MODES = [['full', t('events.full')], ['compact', t('events.compact')], ['hide', t('events.hide')]];
  // Links in chat: in front as Kick opens them, in a tab behind, or in a window of
  // their own (background.js opens the last two).
  const LINK_MODES = [['tab', t('links.tab')], ['background', t('links.background')], ['window', t('links.window')]];
  const EVENT_ATTRS = { rewardEvents: 'data-ka-reward-events', subEvents: 'data-ka-sub-events' };
  // Kickoff app player qualities; the app takes the closest rendition the stream has.
  // Auto lets the app switch, which costs it a few seconds of delay.
  const APP_QUALITIES = [
    ['best', t('app.best')], ['1080', '1080p'], ['720', '720p'], ['480', '480p'],
    ['360', '360p'], ['160', '160p'], ['auto', t('app.auto')], ['audio', t('player.audioOnly')]
  ];
  const CHANNEL_STRIP_ATTR = 'data-ka-channel-strip'; // kickoff.css hides Kick's channel info
  const POPOUT_PATH = /^\/popout\/([^/]+)\/chat\/?$/;
  const FONT_SIZE_ATTR = 'data-ka-font-size'; // page-hook.js remeasures rows when it changes
  const HIGHLIGHT_WORDS_ATTR = 'data-ka-highlight-words'; // JSON list, read by page-hook.js
  const HIDE_WORDS_ATTR = 'data-ka-hide-words'; // JSON list, read by page-hook.js
  const MUTED_USERS_ATTR = 'data-ka-muted-users'; // JSON list, read by page-hook.js
  const HIGHLIGHT_USERS_ATTR = 'data-ka-highlight-users'; // JSON list, read by page-hook.js
  const BOT_USERS_ATTR = 'data-ka-bot-users'; // JSON list, read by page-hook.js
  // Username lists edited in the panel (chips + a field) and from Kick's user card.
  const USER_LISTS = {
    mutedUsers: { label: 'mute.label', empty: 'mute.empty', remove: 'mute.unmute' },
    highlightUsers: { label: 'users.highlight', empty: 'users.highlightEmpty', remove: 'users.unhighlight' },
    botUsers: { label: 'bots.label', empty: 'bots.empty', remove: 'bots.remove' }
  };
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
    toolsFolded: readToolsFolded(),
    donateFound: {}, // channel slug -> donate URL among its links, or null; once per page
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

  // ---- Channel !commands: synced copy for background.js --------------------------
  // The same round trip as emote usage. page-hook.js keeps { channel: { name:
  // { uses, at, answer } } } in Kick's localStorage.

  const COMMANDS_KEY = 'kickoffCommands';
  const COMMANDS_PER_CHANNEL = 50;
  const COMMAND_CHANNELS = 20;
  const COMMAND_ANSWER_LENGTH = 100;
  const COMMAND_NAME = /^[!?$%#&~.+][\p{L}\p{N}_-]{1,30}$/u; // with its prefix: "!chill"

  function postCommands(commands) {
    window.postMessage({ source: EXT_SOURCE, type: 'commands', commands }, location.origin);
  }

  // Same merge as page-hook.js and background.js: per channel and command the
  // higher use count, and the newest answer; then the COMMANDS_PER_CHANNEL newest
  // per channel, in the COMMAND_CHANNELS newest channels. Also cleans what came in.
  function mergeCommands(a, b) {
    const merged = {};
    for (const source of [a, b]) {
      for (const [channel, known] of Object.entries(source && typeof source === 'object' ? source : {})) {
        if (!known || typeof known !== 'object') continue;
        for (const [name, entry] of Object.entries(known)) {
          const uses = Number(entry?.uses);
          const at = Number(entry?.at);
          if (!(uses > 0) || !Number.isFinite(at) || !COMMAND_NAME.test(name)) continue;
          const answer = String(entry.answer ?? '').slice(0, COMMAND_ANSWER_LENGTH);
          const mine = (merged[channel] ||= {})[name];
          merged[channel][name] = !mine ? { uses, at, answer }
            : { uses: Math.max(mine.uses, uses), at: Math.max(mine.at, at), answer: at > mine.at ? answer : mine.answer };
        }
      }
    }
    const newest = known => Math.max(0, ...Object.values(known).map(entry => entry.at));
    for (const known of Object.values(merged)) {
      const names = Object.keys(known);
      if (names.length <= COMMANDS_PER_CHANNEL) continue;
      names.sort((x, y) => known[x].at - known[y].at)
        .slice(0, names.length - COMMANDS_PER_CHANNEL)
        .forEach(old => delete known[old]);
    }
    const channels = Object.keys(merged);
    if (channels.length > COMMAND_CHANNELS) {
      channels.sort((x, y) => newest(merged[x]) - newest(merged[y]))
        .slice(0, channels.length - COMMAND_CHANNELS)
        .forEach(old => delete merged[old]);
    }
    return merged;
  }

  async function storeCommands(incoming) {
    const stored = mergeCommands((await browser.storage.local.get(COMMANDS_KEY))[COMMANDS_KEY], {});
    const merged = mergeCommands(stored, incoming);
    if (JSON.stringify(merged) !== JSON.stringify(stored)) await browser.storage.local.set({ [COMMANDS_KEY]: merged });
    postCommands(merged); // the page may be missing what other devices learned
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

  async function handlePageRequest({ type, item, id, username, usage, commands }) {
    if (type === 'usage:set') {
      await storeUsage(usage);
      return;
    }
    if (type === 'commands:set') {
      await storeCommands(commands);
      return;
    }
    // From Kick's user card (page-hook.js): mute / highlight, and undo.
    const userList = { mute: 'mutedUsers', highlight: 'highlightUsers', bot: 'botUsers' }[String(type).split(':')[0]];
    if (userList && type.endsWith(':add')) {
      addUsers(userList, [username]);
      return;
    }
    if (userList && type.endsWith(':remove')) {
      removeUser(userList, username);
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

  function addUsers(key, names) {
    const list = [...state.settings[key]];
    for (const name of names) {
      const clean = cleanUsername(name);
      if (clean && !list.some(existing => existing.toLowerCase() === clean.toLowerCase())) list.push(clean);
    }
    if (list.length !== state.settings[key].length) saveSettings({ [key]: list });
  }

  function removeUser(key, name) {
    const lower = String(name ?? '').replace(/^@/, '').toLowerCase();
    const list = state.settings[key].filter(existing => existing.toLowerCase() !== lower);
    if (list.length !== state.settings[key].length) saveSettings({ [key]: list });
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

  // ---- Notes about users ---------------------------------------------------------
  // Your own notes about chatters, for every channel: { lower-case name: { name,
  // text, updatedAt } }. A deleted note stays as empty text, so the delete reaches
  // your other devices (background.js merges per user, newest wins, over iCloud).
  // Shown and edited in Kick's user card, drawn from here so the notes never go
  // to the page; only the names with a note do (for the ✎ next to them in chat).
  const NOTES_KEY = 'kickoffNotes';
  const NOTE_MAX = 500;
  const NOTED_USERS_ATTR = 'data-ka-noted-users'; // JSON list, read by page-hook.js
  // Kick's user card: a popup on wide screens, a bottom sheet on phones (see page-hook.js).
  const USER_CARD_SELECTOR = '#user-identity, [role="dialog"][data-vaul-drawer]';
  const USER_NAME_LINK = 'a[title][href^="https://kick.com/"]';
  state.notes = {};

  function cleanNotes(value) {
    const notes = {};
    for (const [key, note] of Object.entries(value && typeof value === 'object' ? value : {})) {
      if (typeof note?.name === 'string' && typeof note.text === 'string' && Number.isFinite(note.updatedAt)) {
        notes[key] = { name: note.name, text: note.text.slice(0, NOTE_MAX), updatedAt: note.updatedAt };
      }
    }
    return notes;
  }

  function noteFor(username) {
    const note = state.notes[String(username).toLowerCase()];
    return note?.text ? note : null;
  }

  function notedNames() {
    return Object.values(state.notes).filter(note => note.text).map(note => note.name);
  }

  function applyNotes(value) {
    state.notes = cleanNotes(value);
    applyAttributes();
    syncNoteCard(true);
    renderNotesList();
  }

  // ---- Notes list (settings panel, Filters tab) ----
  // Every note, by name, with search once there are a few. Edit in place; delete
  // asks for a second tap.
  const NOTES_SEARCH_FROM = 6; // notes before the search field shows
  const DELETE_CONFIRM_MS = 3000;
  state.noteEditing = null; // name whose note is open for editing in the list
  state.notesQuery = '';

  function renderNotesList() {
    const list = state.bar?.querySelector('.ka-notes-list');
    if (!list) return;
    // Don't redraw over a note being typed (a sync can arrive meanwhile).
    if (state.noteEditing && list.querySelector('.ka-user-note-field')) return;
    const notes = Object.values(state.notes).filter(note => note.text)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    state.bar.querySelector('.ka-notes-count').textContent = notes.length ? String(notes.length) : '';
    const search = state.bar.querySelector('.ka-notes-search');
    search.hidden = notes.length < NOTES_SEARCH_FROM;
    const query = search.hidden ? '' : state.notesQuery.trim().toLowerCase();
    const shown = query
      ? notes.filter(note => note.name.toLowerCase().includes(query) || note.text.toLowerCase().includes(query))
      : notes;
    if (!notes.length || !shown.length) {
      list.replaceChildren(el('span', 'ka-mute-empty', t(notes.length ? 'notes.noMatch' : 'notes.empty')));
      return;
    }
    list.replaceChildren(...shown.map(note => {
      const item = el('div', 'ka-note-item');
      const head = el('div', 'ka-note-head');
      head.append(el('span', 'ka-note-name', note.name));
      if (state.noteEditing?.toLowerCase() === note.name.toLowerCase()) {
        item.append(head, ...noteEditor(note.name, () => {
          state.noteEditing = null;
          renderNotesList();
        }));
        return item;
      }
      const editButton = el('button', 'ka-note-action', t('note.edit'));
      const deleteButton = el('button', 'ka-note-action ka-note-delete', t('notes.delete'));
      editButton.type = deleteButton.type = 'button';
      editButton.addEventListener('click', () => {
        state.noteEditing = note.name;
        renderNotesList();
      });
      let confirmTimer = 0;
      deleteButton.addEventListener('click', () => {
        if (deleteButton.dataset.confirm) {
          clearTimeout(confirmTimer);
          saveNote(note.name, '');
          return;
        }
        deleteButton.dataset.confirm = 'true';
        deleteButton.textContent = t('notes.deleteConfirm');
        confirmTimer = setTimeout(() => {
          delete deleteButton.dataset.confirm;
          deleteButton.textContent = t('notes.delete');
        }, DELETE_CONFIRM_MS);
      });
      head.append(editButton, deleteButton);
      item.append(head, el('div', 'ka-note-text', note.text));
      return item;
    }));
  }

  async function saveNote(username, text) {
    const stored = cleanNotes((await browser.storage.local.get(NOTES_KEY))[NOTES_KEY]);
    stored[username.toLowerCase()] = { name: username, text: text.trim().slice(0, NOTE_MAX), updatedAt: Date.now() };
    await browser.storage.local.set({ [NOTES_KEY]: stored });
    if (state.noteEditing?.toLowerCase() === username.toLowerCase()) state.noteEditing = null;
    applyNotes(stored); // onChanged doesn't fire in the script that wrote
    drawNote(username, false);
  }

  function findUserCard() {
    const cards = [...document.querySelectorAll(USER_CARD_SELECTOR)];
    return cards.find(card => card.querySelector(USER_NAME_LINK)) || cards.find(card => card.id === 'user-identity') || null;
  }

  function noteCardName(card) {
    return card.querySelector(USER_NAME_LINK)?.title || null;
  }

  // Text field with Save / Cancel (⌘↩ / Esc), for the card and the panel's list.
  function noteEditor(username, onCancel) {
    const field = el('textarea', 'ka-user-note-field');
    field.value = noteFor(username)?.text || '';
    field.maxLength = NOTE_MAX;
    field.rows = 3;
    field.placeholder = t('note.placeholder', { name: username });
    // Kick's keyboard shortcuts must not see what's typed here.
    for (const type of ['keydown', 'keyup', 'keypress']) field.addEventListener(type, event => event.stopPropagation());
    const save = el('button', 'ka-card-button ka-card-button--primary', t('note.save'));
    const cancel = el('button', 'ka-card-button', t('note.cancel'));
    save.type = cancel.type = 'button';
    save.addEventListener('click', () => saveNote(username, field.value));
    cancel.addEventListener('click', onCancel);
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save.click();
      if (event.key === 'Escape') cancel.click();
    });
    const actions = el('div', 'ka-card-actions');
    actions.append(save, cancel);
    setTimeout(() => field.focus(), 0);
    return [field, actions];
  }

  function buildNote(username, editing) {
    const box = el('div', 'ka-user-note');
    box.dataset.user = username;
    box.setAttribute('data-vaul-no-drag', ''); // selecting text mustn't pull the phone's sheet down
    box.dataset.state = editing ? 'edit' : 'view';
    const note = noteFor(username);
    if (editing) {
      box.append(...noteEditor(username, () => drawNote(username, false)));
    } else if (note) {
      const text = el('div', 'ka-user-note-text', note.text);
      const edit = el('button', 'ka-user-note-edit', t('note.edit'));
      edit.type = 'button';
      edit.addEventListener('click', () => drawNote(username, true));
      box.append(el('div', 'ka-card-meta', t('note.label')), text, edit);
    } else {
      const add = el('button', 'ka-user-note-add', t('note.add'));
      add.type = 'button';
      add.addEventListener('click', () => drawNote(username, true));
      box.append(add);
    }
    return box;
  }

  function drawNote(username, editing) {
    const card = findUserCard();
    const current = card?.querySelector('.ka-user-note');
    if (!card) return;
    const box = buildNote(username, editing);
    if (current) current.replaceWith(box);
    else placeNote(card, box);
  }

  // Under Kick's own buttons, above page-hook.js's tools (whichever comes first).
  function placeNote(card, box) {
    const tools = card.querySelector('.ka-user-tools');
    if (tools) tools.before(box);
    else (card.querySelector(USER_NAME_LINK)?.parentElement?.parentElement || card).append(box);
  }

  let noteCardObserver = null;

  function syncNoteCard(redraw = false) {
    const card = findUserCard();
    if (!card) {
      noteCardObserver?.disconnect();
      noteCardObserver = null;
      return;
    }
    if (noteCardObserver?.card !== card) {
      noteCardObserver?.disconnect();
      noteCardObserver = new MutationObserver(() => syncNoteCard());
      noteCardObserver.card = card;
      noteCardObserver.observe(card, { childList: true, subtree: true });
    }
    const current = card.querySelector('.ka-user-note');
    const username = noteCardName(card);
    if (!state.settings.userCard || !username) {
      current?.remove();
      return;
    }
    // Never redraw over a note being typed.
    if (current?.dataset.user === username && (!redraw || current.dataset.state === 'edit')) return;
    if (current && current.dataset.user !== username) current.remove();
    drawNote(username, false);
  }

  // The card is a direct child of <body>, so watching only <body>'s children is cheap.
  new MutationObserver(() => syncNoteCard()).observe(document.body || root, { childList: true });

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
    // Channel page: the channel's picture and name, a link to its videos and clips
    // (while it's live, kick.com/{slug} is the stream itself).
    const ident = el('a', 'ka-channel');
    ident.append(el('img', 'ka-channel-avatar'), el('span', 'ka-channel-name'));
    toggle.append(
      el('span', 'ka-settings-title', 'Kickoff'),
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
      if (key === 'nativePlayer') text.append(el('span', 'ka-wake-hint', t('setting.nativePlayerHint')));
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

    // Muted / highlighted users: chips to remove, and a field to add names (comma-separated).
    const userRows = key => {
      const row = el('label', 'ka-settings-row ka-words-row');
      const input = el('input', 'ka-words-input ka-mute-input');
      input.type = 'text';
      input.placeholder = t('mute.add');
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.dataset.users = key;
      input.addEventListener('change', () => {
        addUsers(key, input.value.split(','));
        input.value = '';
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') input.blur();
      });
      row.append(el('span', 'ka-settings-label', t(USER_LISTS[key].label)), input);
      const list = el('div', 'ka-mute-list');
      list.dataset.users = key;
      return [row, list];
    };

    // Notes about users: a count, a search field (when there are a few) and the list.
    function notesRows() {
      const head = el('div', 'ka-settings-row');
      const label = el('span', 'ka-settings-label', t('notes.label'));
      label.append(el('span', 'ka-notes-count'));
      head.append(label);
      const search = el('input', 'ka-words-input ka-notes-search');
      search.type = 'search';
      search.placeholder = t('notes.search');
      search.autocomplete = 'off';
      search.spellcheck = false;
      search.hidden = true;
      search.addEventListener('input', () => {
        state.notesQuery = search.value;
        renderNotesList();
      });
      return [head, search, el('div', 'ka-notes-list')];
    }

    // A label and a few buttons, one of them pressed (the setting's value).
    const choiceRow = (key, label, choices) => {
      const row = el('div', 'ka-settings-row');
      const options = el('span', 'ka-size-controls ka-choice');
      for (const [value, text] of choices) {
        const option = el('button', 'ka-size-button ka-choice-option', text);
        option.type = 'button';
        option.dataset.setting = key;
        option.dataset.value = value;
        option.addEventListener('click', () => saveSettings({ [key]: value }));
        options.append(option);
      }
      row.append(el('span', 'ka-settings-label', label), options);
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

    // Quality for the Kickoff app's player (opened from the view switcher).
    const appPlayerRow = () => {
      const row = el('div', 'ka-settings-row');
      const label = el('span', 'ka-settings-label', t('app.label'));
      label.append(el('span', 'ka-wake-hint', t('app.hint')));
      const controls = el('span', 'ka-size-controls');
      const quality = el('select', 'ka-player-quality ka-app-quality');
      quality.setAttribute('aria-label', t('app.quality'));
      for (const [value, text] of APP_QUALITIES) {
        const option = el('option', '', text);
        option.value = value;
        quality.append(option);
      }
      quality.addEventListener('change', () => saveSettings({ appQuality: quality.value }));
      controls.append(quality);
      row.append(label, controls);
      return row;
    };

    // The current channel's donate link (the strip's donate button), by hand or,
    // left empty, the one found among the channel's links (the placeholder).
    const donateRow = () => {
      const row = el('label', 'ka-settings-row ka-words-row ka-donate-row');
      const label = el('span', 'ka-settings-label', t('donate.label'));
      label.append(el('span', 'ka-wake-hint ka-donate-hint'));
      const input = el('input', 'ka-words-input ka-donate-input');
      input.type = 'url';
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.addEventListener('change', () => setDonateLink(input.value));
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') input.blur();
      });
      row.append(label, input);
      return row;
    };

    const ROWS = {
      appPlayer: appPlayerRow,
      donate: donateRow,
      font: () => choiceRow('chatFont', t('font.label'), CHAT_FONTS),
      rewardEvents: () => choiceRow('rewardEvents', t('setting.rewardEvents'), EVENT_MODES),
      subEvents: () => choiceRow('subEvents', t('setting.subEvents'), EVENT_MODES),
      chatLinks: () => choiceRow('chatLinks', t('setting.chatLinks'), LINK_MODES),
      size: sizeRow,
      highlightWords: () => wordsRow('highlightWords', t('words.highlight'), t('words.highlightExample')),
      hideWords: () => wordsRow('hideWords', t('words.hide'), t('words.hideExample')),
      mutedUsers: () => userRows('mutedUsers'),
      highlightUsers: () => userRows('highlightUsers'),
      botUsers: () => userRows('botUsers'),
      notes: notesRows
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
    // With stream info the buttons get a row of their own (data-tools-row), which
    // the "…" button folds away.
    const tools = el('div', 'ka-strip-tools');
    const links = el('div', 'ka-channel-links');
    for (const [kind, icon] of [['videos', 'videos'], ['clips', 'clip'], ['donate', 'donate']]) {
      const link = el('a', 'ka-strip-button ka-channel-link');
      link.dataset.link = kind;
      link.append(playerIcon(icon));
      links.append(link);
    }
    // No donate link yet: the button opens the field for one.
    links.querySelector('[data-link="donate"]').addEventListener('click', event => {
      if (event.currentTarget.hasAttribute('data-empty')) {
        event.preventDefault();
        openDonateField();
      }
    });
    tools.append(actions, links, el('span', 'ka-strip-spacer'), listenButton, listenSleep, searchButton, inboxButton, settingsButton);
    const toolsToggle = el('button', 'ka-strip-button ka-tools-toggle');
    toolsToggle.type = 'button';
    toolsToggle.append(moreIcon());
    toolsToggle.addEventListener('click', () => setToolsFolded(!state.toolsFolded));
    head.append(buildViews(), ident, toggle, toolsToggle, tools);

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
      const key = input.dataset.setting;
      input.checked = Boolean(state.settings[key]);
      const off = key in SETTING_NEEDS && !state.settings[SETTING_NEEDS[key]];
      input.disabled = off;
      input.closest('.ka-settings-row').toggleAttribute('data-off', off);
    }
    state.bar.querySelector('.ka-size-value').textContent = `${currentFontSize()}px`;
    for (const words of state.bar.querySelectorAll('.ka-words-input[data-words]')) {
      if (document.activeElement !== words) words.value = (state.settings[words.dataset.words] || []).join(', ');
    }
    state.bar.querySelector('[data-words="highlightWords"]').disabled = !state.settings.highlights;
    state.bar.querySelector('input[data-users="highlightUsers"]').disabled = !state.settings.highlights;
    for (const key of Object.keys(USER_LISTS)) renderUserList(key);
    renderNotesList();
    for (const option of state.bar.querySelectorAll('.ka-choice-option')) {
      option.setAttribute('aria-pressed', String(option.dataset.value === state.settings[option.dataset.setting]));
    }
    state.bar.querySelector('.ka-size-reset').hidden = state.settings.fontSize == null;
    const appQuality = state.bar.querySelector('.ka-app-quality');
    if (appQuality) appQuality.value = state.settings.appQuality;
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
    renderTools();
  }

  // The strip's second row (channel buttons, listen, search, inbox, settings),
  // folded or not; remembered per device in kick.com localStorage.
  function readToolsFolded() {
    try {
      return localStorage.getItem(TOOLS_FOLDED_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function setToolsFolded(folded) {
    state.toolsFolded = folded;
    try {
      if (folded) localStorage.setItem(TOOLS_FOLDED_KEY, '1');
      else localStorage.removeItem(TOOLS_FOLDED_KEY);
    } catch (err) {
      // Private browsing: just for this page.
    }
    if (folded) {
      setInboxOpen(false);
      setSearchOpen(false);
    }
    renderTools();
  }

  function renderTools() {
    const bar = state.bar;
    if (!bar) return;
    const row = bar.hasAttribute('data-stream') || bar.hasAttribute('data-channel');
    bar.toggleAttribute('data-tools-row', row);
    bar.toggleAttribute('data-tools-folded', row && state.toolsFolded);
    const toggle = bar.querySelector('.ka-tools-toggle');
    const label = t(state.toolsFolded ? 'strip.showTools' : 'strip.hideTools');
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', String(!state.toolsFolded));
    // Folded, the dot tells about what the hidden buttons would show.
    const unread = bar.querySelector('.ka-inbox-button').hasAttribute('data-unread');
    toggle.toggleAttribute('data-unread', unread);
    toggle.toggleAttribute('data-hint', !unread && state.settingsSeen === false);
  }

  function moreIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ka-more-icon');
    for (const cx of [5, 12, 19]) {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', 12);
      dot.setAttribute('r', 2);
      dot.setAttribute('fill', 'currentColor');
      svg.append(dot);
    }
    return svg;
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
    renderTools();
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


  function renderUserList(key) {
    const list = state.bar.querySelector(`.ka-mute-list[data-users="${key}"]`);
    const names = state.settings[key];
    if (!names.length) {
      list.replaceChildren(el('span', 'ka-mute-empty', t(USER_LISTS[key].empty)));
      return;
    }
    list.replaceChildren(...[...names].sort((a, b) => a.localeCompare(b)).map(name => {
      const chip = el('button', 'ka-mute-chip', `${name} ✕`);
      chip.type = 'button';
      chip.setAttribute('aria-label', t(USER_LISTS[key].remove, { name }));
      chip.addEventListener('click', () => removeUser(key, name));
      return chip;
    }));
  }

  // ---- Stream info (popout and channel pages) ------------------------------------
  // The same strip on both: the channel's avatar and name, a one-line summary, and
  // the buttons. On a channel page it also takes over Kick's channel info block
  // under the video, so it carries copies of Kick's buttons too (follow, subscribe,
  // and when logged in the bell and gift subs); the popout has none to copy.

  // kick.com/{slug} with its chat on the page.
  function channelPageSlug() {
    if (popoutSlug) return null;
    const parts = location.pathname.split('/').filter(Boolean);
    return parts.length === 1 && document.querySelector('#channel-content') ? parts[0].toLowerCase() : null;
  }

  // Whose stream the strip shows, if any. The popout's is fetched even with stream
  // info off, for the listen button.
  function streamSlug() {
    if (popoutSlug) return popoutSlug;
    return state.settings.streamInfo ? channelPageSlug() : null;
  }

  function showsStream() {
    return state.settings.streamInfo && Boolean(streamSlug());
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
      const channel = { name: data.user?.username || slug, avatar: data.user?.profile_pic || '', vods: data.vod_enabled !== false };
      loadDonateLink(slug);
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
    renderViews(stream);
    const line = state.bar.querySelector('.ka-stream');
    const details = state.bar.querySelector('.ka-stream-details');

    // Avatar and name instead of "Kickoff".
    const channel = showsStream() ? stream?.channel || { name: streamSlug(), avatar: '' } : null;
    state.bar.toggleAttribute('data-channel', Boolean(channel));
    renderTools();
    const ident = state.bar.querySelector('.ka-channel');
    if (channel) {
      const avatar = ident.querySelector('.ka-channel-avatar');
      if (channel.avatar && avatar.getAttribute('src') !== channel.avatar) avatar.src = channel.avatar;
      avatar.hidden = !channel.avatar;
      ident.querySelector('.ka-channel-name').textContent = channel.name;
      ident.href = `/${encodeURIComponent(streamSlug())}/about`;
      openInNewTab(ident);
      ident.title = t('strip.channelPage', { name: channel.name });
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
      if (stream.category && stream.categorySlug) {
        const link = el('a', 'ka-stream-category', stream.category);
        link.href = `/category/${encodeURIComponent(stream.categorySlug)}`;
        openInNewTab(link);
        meta.append(link, ' · ');
      } else if (stream.category) {
        meta.append(`${stream.category} · `);
      }
      meta.append([t('stream.viewers', { count: stream.viewers }), since].filter(Boolean).join(' · '));
      details.replaceChildren(el('div', 'ka-stream-details-title', stream.title), meta);
      details.hidden = false;
    }
    renderChannelLinks(channel);
    renderStatus();
  }

  // ---- Channel links: videos, clips, donate (the strip's button row) ---------------
  // Donate: the link set by hand for the channel (settings.donateLinks, synced with
  // the other settings), else a tip/donation page among the channel's own links.
  const DONATE_SITES = /streamelements\.com\/[^/]+\/tip|streamlabs\.com\/[^/]+\/tip|tipply\.pl|tipeeestream\.com|ko-fi\.com|buymeacoffee\.com|paypal\.(me|com\/donate)|patronite\.pl|zrzutka\.pl|suppi\.pl|donationalerts\.com|throne\.com/i;
  const DONATE_WORDS = /donat|\btip|napiwek|wesprzyj|wsparcie/i;

  async function loadDonateLink(slug) {
    if (slug in state.donateFound) return;
    state.donateFound[slug] = null;
    try {
      const response = await fetch(`/api/v2/channels/${encodeURIComponent(slug)}/links`, { credentials: 'omit' });
      const list = response.ok ? await response.json() : [];
      const links = Array.isArray(list) ? list.filter(item => /^https?:\/\//i.test(item?.link || '')) : [];
      const found = links.find(item => DONATE_SITES.test(item.link))
        || links.find(item => DONATE_WORDS.test(`${item.title || ''} ${item.description || ''}`));
      state.donateFound[slug] = found?.link || null;
    } catch (err) {
      // No links: the button asks for one.
    }
    renderStream();
  }

  function donateLink(slug) {
    return state.settings.donateLinks[slug] || state.donateFound[slug] || null;
  }

  // Typed in the panel: kept for the current channel; empty goes back to the found one.
  function setDonateLink(value) {
    const slug = showsStream() ? streamSlug() : null;
    if (!slug) return;
    let url = value.trim();
    if (url && !/^[a-z][a-z\d+.-]*:/i.test(url)) url = `https://${url}`;
    // Not a web link: ignored, the field shows the saved one again.
    if (url && !/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(url)) return renderStream();
    const donateLinks = { ...state.settings.donateLinks };
    if (url) donateLinks[slug] = url;
    else delete donateLinks[slug];
    saveSettings({ donateLinks });
  }

  function openDonateField() {
    setPanelOpen(true);
    showSettingsTab('general');
    const input = state.bar.querySelector('.ka-donate-input');
    input.scrollIntoView({ block: 'nearest' });
    input.focus();
  }

  function renderChannelLinks(channel) {
    const links = state.bar.querySelector('.ka-channel-links');
    const row = state.bar.querySelector('.ka-donate-row');
    const slug = channel ? streamSlug() : null;
    links.hidden = !slug;
    row.hidden = !slug;
    if (!slug) return;
    const path = `/${encodeURIComponent(slug)}`;
    const videos = links.querySelector('[data-link="videos"]');
    videos.href = `${path}/videos`;
    videos.hidden = channel.vods === false;
    const clips = links.querySelector('[data-link="clips"]');
    clips.href = `${path}/clips`;
    for (const [link, key] of [[videos, 'links.videos'], [clips, 'links.clips']]) {
      link.title = t(key);
      link.setAttribute('aria-label', t(key));
      openInNewTab(link);
    }
    const url = donateLink(slug);
    const donate = links.querySelector('[data-link="donate"]');
    donate.toggleAttribute('data-empty', !url);
    if (url) {
      donate.href = url;
      donate.target = '_blank';
      donate.rel = 'noopener noreferrer';
    } else {
      donate.href = '#';
      donate.removeAttribute('target');
    }
    const label = url ? t('links.donate', { name: channel.name }) : t('donate.set');
    donate.title = label;
    donate.setAttribute('aria-label', label);
    const input = row.querySelector('.ka-donate-input');
    if (document.activeElement !== input) input.value = state.settings.donateLinks[slug] || '';
    input.placeholder = state.donateFound[slug] || 'https://…';
    row.querySelector('.ka-donate-hint').textContent = t('donate.hint', { name: channel.name });
  }

  // The strip's links (channel, category, videos, clips) open in a new tab, so the
  // stream and chat stay where they are.
  function openInNewTab(link) {
    link.target = '_blank';
    link.rel = 'noopener';
  }

  // The stream in the Kickoff app's own player, about as close to live as Kick's
  // (Shared (App)/LiveStream.swift), at the quality chosen in the Player tab.
  // This page goes quiet so it isn't heard twice; chat stays here.
  function appPlayerSlug() {
    return popoutSlug || channelPageSlug();
  }

  function watchInApp() {
    const slug = appPlayerSlug();
    if (!slug) return;
    for (const video of document.querySelectorAll('video')) video.pause();
    if (isListening()) stopListen();
    const quality = encodeURIComponent(state.settings.appQuality);
    location.href = `kickoff://watch/${encodeURIComponent(slug)}?quality=${quality}`;
  }

  // ---- View switcher (Stream · Chat · Player) ------------------------------------
  // A glass pill at the start of the strip, the same in the popout and on channel
  // pages. Closed it shows the current view's icon; tapped it opens to all three.
  // Stream and Chat are kick.com pages (same tab), Player is the Kickoff app. It
  // folds back after a few seconds, on a tap elsewhere, or when the chat is scrolled.
  const VIEWS = ['stream', 'chat', 'player'];
  const VIEW_ICONS = {
    stream: ['M4.5 4h15A2.5 2.5 0 0 1 22 6.5v10a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 16.5v-10A2.5 2.5 0 0 1 4.5 4z', 'M15 4v15', 'M6.5 9.5l4 2-4 2z'],
    chat: ['M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M8 9h8M8 12.5h5'],
    player: ['M5 4h14a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 19 17H5a2.5 2.5 0 0 1-2.5-2.5v-8A2.5 2.5 0 0 1 5 4z', 'M10 8l5 2.5-5 2.5z', 'M8 21h8']
  };
  const VIEWS_CLOSE_DELAY = 2500;
  let viewsTimer = null;

  function currentView() {
    return popoutSlug ? 'chat' : 'stream';
  }

  function viewIcon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('ka-view-icon');
    VIEW_ICONS[name].forEach((d, index) => {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      // The play triangles are filled; everything else is a line.
      path.setAttribute('fill', /z$/.test(d) && index > 0 ? 'currentColor' : 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.9');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
    });
    return svg;
  }

  function buildViews() {
    const views = el('div', 'ka-views');
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', t('views.label'));
    for (const view of VIEWS) {
      const button = el('button', 'ka-view');
      button.type = 'button';
      button.dataset.view = view;
      button.title = t(`views.${view}`);
      button.setAttribute('aria-label', t(`views.${view}`));
      button.append(viewIcon(view));
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (!views.hasAttribute('data-open')) setViewsOpen(true);
        else if (view === currentView()) setViewsOpen(false);
        else openView(view);
      });
      views.append(button);
    }
    views.addEventListener('pointermove', () => {
      if (views.hasAttribute('data-open')) armViewsClose();
    });
    views.addEventListener('keydown', event => {
      if (event.key === 'Escape') setViewsOpen(false);
    });
    views.addEventListener('focusout', event => {
      if (!views.contains(event.relatedTarget)) setViewsOpen(false);
    });
    return views;
  }

  function armViewsClose() {
    clearTimeout(viewsTimer);
    viewsTimer = setTimeout(() => setViewsOpen(false), VIEWS_CLOSE_DELAY);
  }

  function setViewsOpen(open) {
    const views = state.bar?.querySelector('.ka-views');
    if (!views || views.hasAttribute('data-open') === open) return;
    views.toggleAttribute('data-open', open);
    state.bar.toggleAttribute('data-views-open', open);
    renderViews();
    if (open) armViewsClose();
    else clearTimeout(viewsTimer);
  }

  // Hidden where there's no channel to switch between (e.g. a chat-less page).
  function renderViews(stream = showsStream() ? state.stream : null) {
    const views = state.bar?.querySelector('.ka-views');
    if (!views) return;
    views.hidden = !appPlayerSlug();
    const open = views.hasAttribute('data-open');
    for (const button of views.querySelectorAll('.ka-view')) {
      const current = button.dataset.view === currentView();
      if (current) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
      // Closed, only the current view's icon is reachable (by tap or Tab).
      button.tabIndex = open || current ? 0 : -1;
      if (button.dataset.view === 'player') button.disabled = stream?.live === false;
    }
  }

  function openView(view) {
    const slug = appPlayerSlug();
    setViewsOpen(false);
    if (!slug) return;
    if (view === 'player') return watchInApp();
    location.href = view === 'chat' ? `/popout/${encodeURIComponent(slug)}/chat` : `/${encodeURIComponent(slug)}`;
  }

  // A tap elsewhere or scrolling the chat (by hand: new messages scroll it too) folds it.
  document.addEventListener('click', event => {
    if (!event.target.closest?.('.ka-views')) setViewsOpen(false);
  }, true);
  for (const type of ['wheel', 'touchmove']) {
    document.addEventListener(type, event => {
      if (event.target.closest?.('#chatroom-messages')) setViewsOpen(false);
    }, { capture: true, passive: true });
  }

  // ---- Chat links ------------------------------------------------------------------
  // Kick opens them in a tab in front (from the popout, in the stream's window, over
  // the stream). Unless that's the setting, background.js opens them instead; a
  // click with a modifier key still does what Safari does with it.
  window.addEventListener('click', event => {
    const mode = state.settings.chatLinks;
    if (mode === 'tab' || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('#chatroom-messages a[href]');
    if (!link || link.matches(USER_NAME_LINK) || !/^https?:$/.test(link.protocol)) return;
    event.preventDefault();
    event.stopPropagation();
    browser.runtime.sendMessage({ type: 'kickoff:openLink', url: link.href, mode }).catch(() => {
      window.open(link.href, '_blank', 'noopener');
    });
  }, true);

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
    videos: 'M4 6H2v14a2 2 0 0 0 2 2h14v-2H4V6zm16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-8 12.5v-9l6 4.5-6 4.5z',
    donate: 'M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z',
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

  // ---- Theatre mode on opening a channel -------------------------------------
  // Kick's theatre button exists only while its controls show (mouse over the
  // player): a pointer move on the video brings them up, and the next poll presses
  // it. Once per channel visit, so turning it off again lasts until the next channel.
  // Phones have no theatre button: given up after a few polls.
  const THEATRE_TRIES = 8;
  const theatre = { slug: null, done: false, tries: 0 };

  function hoverVideo(video, enter) {
    const box = video.getBoundingClientRect();
    const at = { bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, pointerType: 'mouse' };
    const types = enter
      ? ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']
      : ['pointerout', 'pointerleave', 'mouseout', 'mouseleave'];
    for (const type of types) {
      video.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, at) : new MouseEvent(type, at));
    }
  }

  // kick.com/{slug} (not the popout chat), or null.
  function channelPageSlug() {
    const parts = location.pathname.split('/').filter(Boolean);
    return !popoutSlug && parts.length === 1 ? parts[0].toLowerCase() : null;
  }

  function syncTheatre() {
    const slug = channelPageSlug();
    if (slug !== theatre.slug) Object.assign(theatre, { slug, done: false, tries: 0 });
    if (!slug || theatre.done || !state.settings.theatreMode) return;
    const page = document.querySelector('[data-theatre]');
    const video = kickPlayer()?.querySelector('video');
    if (!page || !video) return; // still loading (or offline: no player)
    if (page.dataset.theatre === 'true' || ++theatre.tries > THEATRE_TRIES) {
      theatre.done = true;
      return;
    }
    const button = kickButton('theatre-mode');
    if (!button) {
      hoverVideo(video, true);
      return;
    }
    button.click();
    hoverVideo(video, false); // let Kick's controls fade as usual
    theatre.done = true;
  }

  // ---- Sound on when a stream opens -------------------------------------------
  // Kick starts its player muted (browsers autoplay only muted video). Its own sound
  // button is pressed, so its icon and volume stay right (Kick puts back a volume
  // set on the video directly); like theatre mode, its controls are brought up
  // first. Safari may refuse sound without a tap and stop the stream: then it's
  // muted and played again, and the sound comes on with your first tap or key on
  // the page. WebKit counts a short timer started in a tap as part of that tap.
  const SOUND_TRIES = 4; // presses that changed nothing (no controls, e.g. phones)
  const sound = { slug: null, step: 'wait', tries: 0 }; // wait → pressed → done, or → tap → done

  const isSilent = video => video.muted || video.volume === 0;

  function kickControl(icon) {
    return kickPlayer()?.querySelector(`button svg[data-ds-icon="${icon}"]`)?.closest('button') || null;
  }

  // Kick's sound button (icon SoundOff while muted); also its play button when the
  // stream was stopped.
  function pressKickSound(video, play = false) {
    hoverVideo(video, true);
    setTimeout(() => {
      kickPlayer()?.querySelector('button svg[data-ds-icon^="Sound"]')?.closest('button')?.click();
      if (play && video.paused) kickControl('Play')?.click();
      hoverVideo(video, false);
    }, 150);
  }

  function syncSound() {
    const slug = channelPageSlug();
    if (slug !== sound.slug) Object.assign(sound, { slug, step: 'wait', tries: 0 });
    if (!slug || !state.settings.startUnmuted) return;
    const video = kickPlayer()?.querySelector('video');
    if (!video) return;
    if (sound.step === 'wait') {
      if (video.paused || video.readyState < 2) return; // not playing yet
      if (!isSilent(video)) {
        sound.step = 'done';
        return;
      }
      pressKickSound(video);
      sound.step = 'pressed';
    } else if (sound.step === 'pressed') { // a poll later: heard, refused, or nothing happened?
      if (!video.paused && !isSilent(video)) sound.step = 'done';
      else if (video.paused && !isSilent(video)) { // Safari stopped it
        pressKickSound(video, true);
        sound.step = 'tap';
      } else sound.step = ++sound.tries < SOUND_TRIES ? 'wait' : 'tap';
    }
  }

  function onFirstTap(event) {
    if (sound.step !== 'tap' || sound.slug !== channelPageSlug() || !state.settings.startUnmuted) return;
    sound.step = 'done';
    if (event.target.closest?.('#injected-channel-player button')) return; // Kick's own controls
    const video = kickPlayer()?.querySelector('video');
    if (video && isSilent(video)) pressKickSound(video);
  }
  for (const type of ['click', 'touchend', 'keydown']) document.addEventListener(type, onFirstTap, true);

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
    for (const [key, attr] of Object.entries(EVENT_ATTRS)) setAttr(attr, state.settings[key] !== 'full', state.settings[key]);
    setAttr(CHANNEL_STRIP_ATTR, Boolean(streamSlug() && !popoutSlug));
    const size = state.settings.fontSize;
    setAttr(FONT_SIZE_ATTR, size != null, String(size));
    const words = state.settings.highlightWords || [];
    setAttr(HIGHLIGHT_WORDS_ATTR, words.length > 0, JSON.stringify(words));
    const hidden = state.settings.hideWords || [];
    setAttr(HIDE_WORDS_ATTR, hidden.length > 0, JSON.stringify(hidden));
    const muted = state.settings.mutedUsers;
    setAttr(MUTED_USERS_ATTR, muted.length > 0, JSON.stringify(muted));
    const highlighted = state.settings.highlightUsers;
    setAttr(HIGHLIGHT_USERS_ATTR, highlighted.length > 0, JSON.stringify(highlighted));
    const bots = state.settings.botUsers;
    setAttr(BOT_USERS_ATTR, bots.length > 0, JSON.stringify(bots));
    const noted = notedNames();
    setAttr(NOTED_USERS_ATTR, noted.length > 0, JSON.stringify(noted));
    if (state.fontStyle && !state.fontStyle.isConnected) (document.head || root).append(state.fontStyle);
  }

  new MutationObserver(applyAttributes).observe(root, { attributes: true });

  function applySettings(settings) {
    state.settings = { ...DEFAULTS, ...settings };
    for (const key of Object.keys(USER_LISTS)) {
      if (!Array.isArray(state.settings[key])) state.settings[key] = [];
    }
    // Before the font choice there was only the SF switch (sfFont).
    if (!CHAT_FONTS.some(([value]) => value === settings.chatFont)) {
      state.settings.chatFont = settings.sfFont === false ? 'kick' : 'sf';
    }
    if (!state.settings.donateLinks || typeof state.settings.donateLinks !== 'object' || Array.isArray(state.settings.donateLinks)) {
      state.settings.donateLinks = {};
    }
    for (const key of Object.keys(EVENT_ATTRS)) {
      if (!EVENT_MODES.some(([value]) => value === state.settings[key])) state.settings[key] = 'full';
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
    syncNoteCard(true);
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (SETTINGS_KEY in changes) applySettings(changes[SETTINGS_KEY].newValue || {});
    if (MESSAGES_KEY in changes) postMessages(changes[MESSAGES_KEY].newValue || []);
    if (USAGE_KEY in changes) postUsage(cleanUsage(changes[USAGE_KEY].newValue));
    if (COMMANDS_KEY in changes) postCommands(mergeCommands(changes[COMMANDS_KEY].newValue, {}));
    if (INBOX_KEY in changes) applyInbox(changes[INBOX_KEY].newValue || {});
    if (NOTES_KEY in changes) applyNotes(changes[NOTES_KEY].newValue);
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
    syncTheatre();
    syncSound();
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
  browser.storage.local.get(NOTES_KEY).then(result => applyNotes(result[NOTES_KEY]));
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
