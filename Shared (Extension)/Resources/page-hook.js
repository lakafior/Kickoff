// Runs in the page's own JS world (injected by content.js) because content
// scripts can't see React's data. Kick's chat is a TanStack virtualized list
// whose rows carry no message id in the DOM, but each row's React props hold the
// full message ({ id, content, sender }). We use that to:
//   - restore the original text of messages replaced with "Deleted by a moderator",
//     and show again the messages Kick removes when someone is timed out or banned
//   - add link previews (images, YouTube, X, TikTok, Kick clips, Instagram)
//   - show 7TV emotes (global + the channel's set), with a tap card (name, copy,
//     insert), autocomplete and a picker
//   - saved messages ("pastas"): a list to insert from, saved from chat or typed
//   - highlights (also collected in the mentions inbox, stored by content.js),
//     and a mute list (muted users' messages collapse to one line)
//   - chat search: the last 1000 messages are kept in memory (read from Kick's own
//     message list, so also ones never drawn); content.js shows the search UI
//   - jump to a message (from the inbox or search) while Kick still lists it
//   - 7TV name paints and badges
//   - replies: tapping "Replying to…" jumps to the original (or shows it if gone)
//   - optionally hide messages that are only emotes (Kick and 7TV)
//   - repeated messages: a run of identical messages shows once, with ×N
//   - Kick's channel point rewards, subs and gifts: as Kick shows them, one line, or hidden
//   - channel "!commands": learned when a bot answers them, suggested as you type
//
// Each feature follows an html attribute set by content.js from the user's settings.
(() => {
  if (window.__kickoffHook) return;
  window.__kickoffHook = true;

  // On-screen text: strings.js was injected just before this script, and
  // content.js put Safari's language on our script tag.
  const t = kickoffStrings(document.currentScript?.dataset.lang);

  const RESTORE_ATTR = 'data-ka-restore';
  const PREVIEWS_ATTR = 'data-ka-link-previews';
  const FONT_SIZE_ATTR = 'data-ka-font-size';
  const CHAT_FONT_ATTR = 'data-ka-font'; // a different font changes row heights too
  const SEVENTV_ATTR = 'data-ka-7tv';
  const MESSAGES_ATTR = 'data-ka-messages';
  const HIGHLIGHT_ATTR = 'data-ka-highlights';
  const HIGHLIGHT_WORDS_ATTR = 'data-ka-highlight-words';
  const STREAMER_ATTR = 'data-ka-streamer';
  const HIDE_WORDS_ATTR = 'data-ka-hide-words';
  const MUTE_ATTR = 'data-ka-mute';
  const MUTED_USERS_ATTR = 'data-ka-muted-users';
  const BOTS_ATTR = 'data-ka-bots';
  const READABLE_NAMES_ATTR = 'data-ka-readable-names';
  const MENTIONS_ATTR = 'data-ka-mentions'; // @names in messages open that user's card
  const STRIPES_ATTR = 'data-ka-stripes';
  const BOT_NAMES = new Set(['botrix', 'kickbot', 'streamelements', 'fossabot']); // lower case
  const HIGHLIGHT_USERS_ATTR = 'data-ka-highlight-users';
  const NOTED_USERS_ATTR = 'data-ka-noted-users'; // names you wrote a note about (content.js has the notes)
  const BOT_USERS_ATTR = 'data-ka-bot-users'; // the user's own list of chat bots, added to BOT_NAMES
  const REPEATS_ATTR = 'data-ka-repeats';
  const REWARD_EVENTS_ATTR = 'data-ka-reward-events'; // 'compact' or 'hide'; none = Kick's own
  const SUB_EVENTS_ATTR = 'data-ka-sub-events';       // same, for subs and gifts
  const COMMANDS_ATTR = 'data-ka-commands';
  const LIST_SELECTOR = '#chatroom-messages';
  const ROW_SELECTOR = '[data-index]';
  const DELETED_TEXT = 'Deleted by a moderator'; // fallback only, see findDeletedLabel
  const HISTORY_LIMIT = 1000; // messages kept in memory (search, deleted-message restore); Kick keeps 300
  const PREVIEW_CACHE_LIMIT = 200;
  const MAX_PREVIEWS_PER_MESSAGE = 2;
  const LIST_POLL_MS = 1500;
  const BATCH_MS = 50;
  const EMOTE_TOKEN = /\[emote:(\d+):([^\]]*)\]/g;
  const ZERO_WIDTH_FLAG = 1 << 8; // 7TV emote data flag: overlay on the previous emote
  const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu; // invisible chars other clients append

  const history = new Map(); // message id -> { id, content, username, at, channel }, oldest first
  const userColors = new Map(); // lowercased username -> Kick's name colour, last seen last
  const USER_COLOR_LIMIT = 3000;

  // ---- Ads in Kick's own player ----------------------------------------------------
  // Kick's player asks web.kick.com/api/v1/stream/{id}/playback (POST) for its stream
  // link and which SDKs to start. That "live" link carries Amazon IVS ad parameters
  // (ads stitched into the stream); the link from /api/v2/channels/{slug} (also used by
  // our native player) has an ads opt-out instead. With the setting on, the answer is
  // rewritten: the opt-out link (or none, so Kick falls back to its "dvr" link), auto
  // ads off, and the ad and analytics SDKs (Google IMA, PAL, Datazoom, Mux) not started.
  // Only for requests made after this script loads (it comes in at document_idle).

  const BLOCK_ADS_ATTR = 'data-ka-block-ads';
  const PLAYBACK_REQUEST = /^https:\/\/web\.kick\.com\/api\/v1\/stream\/[^/?#]+\/playback(?:[?#]|$)/;
  const PLAYER_SDKS = ['google_ads_sdk', 'pal_sdk', 'datazoom_sdk', 'mux_sdk'];
  const nativeFetch = window.fetch;
  let adsRemoved = 0; // player answers rewritten (status line)

  window.fetch = function (input, init) {
    const response = nativeFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!document.documentElement.hasAttribute(BLOCK_ADS_ATTR) || !PLAYBACK_REQUEST.test(url)) return response;
    return response.then(original => withoutPlayerAds(original, init?.body));
  };

  function requestSlug(body) {
    try {
      const slug = JSON.parse(body)?.video_session?.url_path;
      if (typeof slug === 'string' && /^[\w-]{1,64}$/.test(slug)) return slug.toLowerCase();
    } catch (err) { /* not JSON */ }
    return channelSlug();
  }

  async function adFreeLink(slug) {
    if (!slug) return null;
    try {
      const response = await nativeFetch(`/api/v2/channels/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' } });
      const link = response.ok ? (await response.json())?.playback_url : null;
      return typeof link === 'string' && link.startsWith('https://') ? link : null;
    } catch (err) {
      return null;
    }
  }

  async function withoutPlayerAds(response, body) {
    if (!response.ok) return response;
    try {
      const data = await response.clone().json();
      const sdks = data?.video_player;
      for (const key of PLAYER_SDKS) {
        if (sdks?.[key]) sdks[key] = { ...sdks[key], sdk_available: false, initiate_sdk: false };
      }
      if (data?.video_session) data.video_session.auto_ads_enabled = false;
      if (data?.playback_url?.live) data.playback_url.live = await adFreeLink(requestSlug(body));
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      adsRemoved++;
      return new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers });
    } catch (err) {
      lastError = `player ads: ${err?.message || err}`;
      return response;
    }
  }

  let list = null;
  let listObserver = null;
  let scheduled = false;

  const restoreEnabled = () => document.documentElement.hasAttribute(RESTORE_ATTR);
  const previewsEnabled = () => document.documentElement.hasAttribute(PREVIEWS_ATTR);
  const sevenTvEnabled = () => document.documentElement.hasAttribute(SEVENTV_ATTR);
  const messagesEnabled = () => document.documentElement.hasAttribute(MESSAGES_ATTR);
  const highlightsEnabled = () => document.documentElement.hasAttribute(HIGHLIGHT_ATTR);
  const streamerEnabled = () => document.documentElement.hasAttribute(STREAMER_ATTR);
  const muteEnabled = () => document.documentElement.hasAttribute(MUTE_ATTR);
  const botsEnabled = () => document.documentElement.hasAttribute(BOTS_ATTR);
  const readableNamesEnabled = () => document.documentElement.hasAttribute(READABLE_NAMES_ATTR);
  const mentionsEnabled = () => document.documentElement.hasAttribute(MENTIONS_ATTR);
  const stripesEnabled = () => document.documentElement.hasAttribute(STRIPES_ATTR);
  const repeatsEnabled = () => document.documentElement.hasAttribute(REPEATS_ATTR);

  function remember(message) {
    if (history.has(message.id)) return;
    rememberColor(message.sender);
    history.set(message.id, {
      id: message.id,
      content: message.content,
      username: message.sender?.username || '',
      at: Date.parse(message.created_at) || Date.now(),
      channel: channelSlug()
    });
    if (history.size > HISTORY_LIMIT) {
      history.delete(history.keys().next().value);
    }
  }

  function rowFiber(row) {
    const key = Object.keys(row).find(k => k.startsWith('__reactFiber'));
    return key ? row[key] : null;
  }

  // Kick's chat entries live in its store, which the list component reads through
  // useSyncExternalStore; that hook keeps getSnapshot, which always returns the
  // newest entries. A row's own fiber can be React's stale copy: Kick swaps your
  // sent message's optimistic copy for the confirmed one (and marks deletions)
  // under the same row key, and the stale copy then keeps the old message for good.
  let entriesReader = null; // { list, read }

  const isEntryList = value => Array.isArray(value) && value.length > 0
    && typeof value[0]?.id === 'string' && typeof value[0]?.type === 'string';

  function findEntriesReader() {
    let fiber = list && rowFiber(list);
    for (let depth = 0; fiber && depth < 15; depth++, fiber = fiber.return) {
      for (let hook = fiber.memoizedState, n = 0; hook && typeof hook === 'object' && n < 60; hook = hook.next, n++) {
        const read = hook.queue?.getSnapshot;
        if (typeof read !== 'function') continue;
        try {
          if (isEntryList(read())) return read;
        } catch (err) { /* not ours */ }
      }
    }
    return null;
  }

  function storeEntries() {
    if (!list) return null;
    // Looked up again while not found (Kick's list starts empty).
    if (entriesReader?.list !== list || !entriesReader.read) entriesReader = { list, read: findEntriesReader() };
    try {
      const entries = entriesReader.read?.();
      return Array.isArray(entries) ? entries : null;
    } catch (err) {
      entriesReader = null;
      return null;
    }
  }

  // The store entry drawn in a row (its index in the list), checked against the
  // row's React key so a list that changed meanwhile can't give the wrong one.
  function readEntry(row) {
    const key = rowFiber(row)?.key;
    const entry = key != null ? storeEntries()?.[Number(row.dataset.index)] : null;
    return entry?.id === key ? entry : null;
  }

  // Falls back to the row element's React fiber, which has the chat entry a level
  // or two below it (also for rows outside the main list).
  function readMessage(row) {
    const entry = readEntry(row);
    if (entry) return entry.type === 'message' && entry.data?.id && 'content' in entry.data ? entry.data : null;
    let fiber = rowFiber(row);
    for (let depth = 0; fiber && depth < 6; depth++, fiber = fiber.child) {
      const props = fiber.memoizedProps;
      const message = props?.chatEntry?.data || props?.message;
      if (message?.id && 'content' in message) return message;
    }
    return null;
  }

  // Name colours of everyone who wrote, for their @mentions.
  function rememberColor(sender) {
    const name = sender?.username?.toLowerCase();
    const color = sender?.identity?.color;
    if (!name || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return;
    userColors.delete(name);
    userColors.set(name, color);
    if (userColors.size > USER_COLOR_LIMIT) userColors.delete(userColors.keys().next().value);
  }

  // Rows are absolutely positioned at measured offsets. After we change a row's
  // height, call the virtualizer's measure ref so rows below move instead of overlapping.
  function remeasure(row) {
    const ref = rowFiber(row)?.ref;
    if (typeof ref === 'function' && row.isConnected) {
      try { ref(row); } catch (err) { /* virtualizer internals changed */ }
    }
  }

  // Kick's whole message list (last 300, oldest first): read from its store, else
  // from the prop of the component around #chatroom-messages; only ~30 of them are
  // drawn as rows. React keeps two copies of each fiber (current and alternate),
  // so then take the newer list.
  let harvested = null;

  function kickMessages() {
    const entries = storeEntries();
    if (entries) return entries;
    const owner = list && rowFiber(list)?.return;
    const newest = messages => (Array.isArray(messages) && messages.length
      ? Date.parse(messages[messages.length - 1]?.data?.created_at) || 0
      : -1);
    const lists = [owner?.memoizedProps?.messages, owner?.alternate?.memoizedProps?.messages];
    const best = lists.sort((a, b) => newest(b) - newest(a))[0];
    return Array.isArray(best) ? best : null;
  }

  function harvest() {
    const messages = kickMessages();
    if (!messages || messages === harvested) return;
    const previous = harvested;
    harvested = messages;
    for (const entry of messages) {
      const data = entry?.data;
      if (!data?.id || typeof data.content !== 'string') continue;
      const seenBefore = history.has(data.id);
      remember(data);
      if (!seenBefore) guarded('commands', () => learnCommands(data));
    }
    noteSeen(messages);
    if (previous && restoreEnabled()) guarded('removed', () => findRemoved(previous, messages));
  }

  // ---- Search (UI in content.js) -----------------------------------------------
  // Words must all appear (any case, Polish letters folded: "zolw" finds "żółw");
  // "from:name" (or Polish "od:name") keeps messages from users whose name starts with name.

  const SEARCH_LIMIT = 100;

  function fold(text) {
    return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();
  }

  function searchHistory(query) {
    guarded('history', harvest);
    let from = '';
    const words = [];
    for (const part of String(query || '').trim().split(/\s+/)) {
      const match = part.match(/^(?:from|od):@?(.*)$/i); // od: is Polish for from:
      if (match) from = fold(match[1]);
      else if (part) words.push(fold(part));
    }
    const slug = channelSlug();
    const entries = [...history.values()]
      .filter(entry => entry.channel === slug && !collapsedUser(entry.username))
      .sort((a, b) => a.at - b.at);
    const results = [];
    if (from || words.length) {
      for (let i = entries.length - 1; i >= 0 && results.length < SEARCH_LIMIT; i--) {
        const entry = entries[i];
        if (from && !fold(entry.username).startsWith(from)) continue;
        const text = fold(plainText(entry.content).replace(TAG_CHARS, ''));
        if (words.every(word => text.includes(word))) results.push(entry);
      }
    }
    return { results, total: entries.length, since: entries[0]?.at || null };
  }

  // ---- Jump to a message ---------------------------------------------------------
  // Kick's chat is a TanStack virtualizer (a hook state of a component above the
  // list); its item keys are Kick's entry ids, "<n>-<message id>", plus extras such
  // as "divider". Kick's own scrollToIndex wrapper sometimes only queues the
  // request, and the virtualizer's scrolling waits for animation frames, so we
  // set scrollTop ourselves and correct it once the row is drawn.

  const JUMP_PASSES = 8;
  const JUMP_PASS_MS = 120;
  const JUMP_FLASH_MS = 2200;

  function chatVirtualizer() {
    let fiber = list && rowFiber(list);
    for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return) {
      for (let hook = fiber.memoizedState, n = 0; hook && n < 60; hook = hook.next, n++) {
        for (const value of [hook.memoizedState, hook.memoizedState?.current]) {
          if (value && typeof value === 'object' && typeof value.options?.getItemKey === 'function'
            && typeof value.scrollToIndex === 'function' && !('scrollToBottom' in value)) return value;
        }
      }
    }
    return null;
  }

  function itemIndex(virtualizer, id) {
    for (let i = virtualizer.options.count - 1; i >= 0; i--) {
      const key = virtualizer.options.getItemKey(i);
      if (typeof key === 'string' && (key === id || key.endsWith(`-${id}`))) return i;
    }
    return -1;
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Scrolls the chat so the message is centred; returns the row, or null.
  async function scrollToMessage(id) {
    let row = null;
    for (let pass = 0; pass < JUMP_PASSES; pass++) {
      const virtualizer = chatVirtualizer();
      let index = virtualizer ? itemIndex(virtualizer, id) : -1;
      if (index < 0) return null; // trimmed from Kick's list meanwhile
      row = list.querySelector(`${ROW_SELECTOR}[data-index="${index}"]`);
      // A hidden copy in a run of repeats: go to the run's visible (last) row.
      while (row?.hasAttribute('data-ka-dup') || row?.hasAttribute('data-ka-hidden-row')) {
        index++;
        row = list.querySelector(`${ROW_SELECTOR}[data-index="${index}"]`);
      }
      if (!row) {
        const offset = virtualizer.getOffsetForIndex?.(index, 'center')?.[0]
          ?? (virtualizer.measurementsCache?.[index]?.start ?? 0) - list.clientHeight / 2;
        list.scrollTop = Math.max(0, offset);
      } else {
        const box = list.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        const delta = rect.top + rect.height / 2 - (box.top + box.height / 2);
        if (Math.abs(delta) < 4) break;
        list.scrollTop += delta;
      }
      await sleep(JUMP_PASS_MS);
    }
    return row?.isConnected ? row : null;
  }

  function flashRow(row) {
    const id = row.dataset.kaId;
    row.removeAttribute('data-ka-jump');
    void row.offsetWidth; // restart the animation
    row.setAttribute('data-ka-jump', '');
    setTimeout(() => {
      if (row.dataset.kaId === id) row.removeAttribute('data-ka-jump');
    }, JUMP_FLASH_MS);
  }

  // Answers right away (found or not), so content.js can close its panel before
  // the chat scrolls; then scrolls once that has happened.
  function jumpTo(id, requestId) {
    const virtualizer = chatVirtualizer();
    const found = Boolean(list && virtualizer && itemIndex(virtualizer, id) >= 0);
    sendToExtension('jump:result', { requestId, id, found, reason: !virtualizer ? 'unavailable' : found ? '' : 'gone' });
    if (!found) return;
    setTimeout(() => {
      scrollToMessage(id).then(row => {
        if (row) flashRow(row);
      }).catch(err => {
        lastError = `jump: ${err?.message || err}`;
      });
    }, 80);
  }

  // ---- Deleted messages ------------------------------------------------------

  // Kick marks deletions in the message data, not just the text: ui_metadata.deleted
  // is "user_deleted" for viewers who can't moderate (the text is replaced by a
  // label) and "mod_deleted" / "mod_ban" / "mod_timeout" for moderators (text kept,
  // struck through). The content stays in the data. So the label is found by its
  // place (inside the message text span), whatever language or wording it has;
  // the English text is only a fallback in case Kick drops ui_metadata.
  function findDeletedLabel(row, message) {
    if (message?.ui_metadata?.deleted === 'user_deleted') {
      const text = row.querySelector('span[aria-hidden="true"] + span');
      const label = text && [...text.querySelectorAll('span'), text]
        .find(span => !span.firstElementChild && !span.closest('[data-ka-restored]') && span.textContent.trim());
      if (label) return label;
    }
    for (const span of row.querySelectorAll('span')) {
      if (!span.firstElementChild && span.textContent.trim() === DELETED_TEXT) return span;
    }
    return null;
  }

  // Message content is user input: build nodes, never innerHTML.
  function renderContent(content) {
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of content.matchAll(EMOTE_TOKEN)) {
      if (match.index > last) appendText(fragment, content.slice(last, match.index));
      const img = document.createElement('img');
      img.src = `https://files.kick.com/emotes/${match[1]}/fullsize`;
      img.alt = match[2];
      img.className = 'ka-emote';
      fragment.append(img);
      last = match.index + match[0].length;
    }
    if (last < content.length) appendText(fragment, content.slice(last));
    return fragment;
  }

  function appendText(parent, text) {
    if (sevenTvEnabled() && emotes.size) appendEmoteText(parent, text);
    else parent.append(text);
  }

  function clearRestore(row) {
    row.querySelectorAll('[data-ka-restored]').forEach(node => node.remove());
    row.querySelectorAll('[data-ka-hidden]').forEach(node => node.removeAttribute('data-ka-hidden'));
    row.removeAttribute('data-ka-deleted');
  }

  // ---- Timeouts and bans --------------------------------------------------------------
  // For viewers who can't moderate, Kick removes every message of a timed-out or
  // banned user from its list (moderators see them struck through). We notice that
  // when comparing Kick's list with the previous one (harvest): messages of one
  // sender gone from the middle, not just the oldest dropping off. Their text is in
  // our memory, so each is shown again where it was, attached under the message
  // before it (like link previews). The reason comes from Kick's own
  // UserBannedEvent, which we also listen to; without it the tag says "removed".

  const REMOVED_MAX = 100;          // more at once = not a timeout (e.g. clear chat)
  const BAN_REASON_MS = 10 * 1000;  // how long a ban event explains a removal
  const ghosts = new Map();         // message id -> removed messages shown under it
  const banReasons = new Map();     // Kick user id -> { reason, at }
  let banScope = null;
  let banUnsubscribe = null;

  // Kick's realtime store (its getState is in a useMemo dependency list above the
  // chat): { scope: 'chatrooms.<id>.v2', handle: { subscribe(scope, event, cb) } }.
  function chatRealtime() {
    let fiber = list && rowFiber(list);
    for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
      for (let hook = fiber.memoizedState, n = 0; hook && n < 80; hook = hook.next, n++) {
        const deps = Array.isArray(hook.memoizedState) && Array.isArray(hook.memoizedState[1]) ? hook.memoizedState[1] : null;
        for (const candidate of deps || []) {
          if (typeof candidate !== 'function' || candidate.length > 0) continue;
          try {
            const state = candidate();
            if (typeof state?.scope === 'string' && typeof state.handle?.subscribe === 'function') return state;
          } catch (err) { /* not it */ }
        }
      }
    }
    return null;
  }

  function listenForBans() {
    if (!restoreEnabled() || !list) return;
    const realtime = chatRealtime();
    if (!realtime || realtime.scope === banScope) return;
    banUnsubscribe?.();
    banScope = realtime.scope;
    const unsubscribe = realtime.handle.subscribe(banScope, 'App\\Events\\UserBannedEvent', event => {
      if (event?.user?.id == null) return;
      banReasons.set(String(event.user.id), { reason: event.expires_at ? t('removed.timeout') : t('removed.ban'), at: Date.now() });
    });
    banUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null;
  }

  // previous/next: Kick's entry lists (oldest first) before and after a change.
  function findRemoved(previous, next) {
    const nextIds = new Set(next.map(entry => entry.id));
    const firstKept = previous.findIndex(entry => nextIds.has(entry.id));
    if (firstKept < 0) return; // a different list (channel switch, clear chat)
    let lastKept = previous.length - 1;
    while (lastKept > firstKept && !nextIds.has(previous[lastKept].id)) lastKept--;
    const removed = [];
    for (let i = firstKept + 1; i < previous.length; i++) {
      const entry = previous[i];
      if (!nextIds.has(entry.id) && entry.type === 'message' && entry.data?.id && entry.data.sender?.id != null) removed.push(i);
    }
    if (!removed.length || removed.length > REMOVED_MAX) return;
    const senderId = previous[removed[0]].data.sender.id;
    if (removed.some(i => previous[i].data.sender.id !== senderId)) return; // not one user's timeout
    const ban = banReasons.get(String(senderId));
    const banned = Boolean(ban && Date.now() - ban.at < BAN_REASON_MS);
    const reason = banned ? ban.reason : t('removed.other');
    // Your own message being replaced (sent → confirmed) also leaves the list.
    const replaced = entry => next.some(other => other.data?.sender?.id === senderId && other.data?.content === entry.data.content);
    for (const i of removed) {
      const entry = previous[i];
      // Gone from the very end without a ban event: more likely an older copy of
      // Kick's list than a removal, so leave it.
      if (replaced(entry) || (i > lastKept && !banned)) continue;
      let j = i - 1;
      while (j >= 0 && !(nextIds.has(previous[j].id) && previous[j].type === 'message' && previous[j].data?.id)) j--;
      if (j < 0) continue;
      const anchorId = previous[j].data.id;
      const shown = ghosts.get(anchorId) || [];
      if (shown.some(ghost => ghost.id === entry.data.id)) continue;
      shown.push({
        id: entry.data.id,
        username: entry.data.sender.username || '',
        content: history.get(entry.data.id)?.content ?? entry.data.content ?? '',
        reason
      });
      ghosts.set(anchorId, shown);
      if (ghosts.size > HISTORY_LIMIT) ghosts.delete(ghosts.keys().next().value);
    }
    schedule();
  }

  function clearGhosts(row) {
    row.querySelectorAll('.ka-ghosts').forEach(node => node.remove());
  }

  function applyGhosts(row, message) {
    const shown = restoreEnabled() ? ghosts.get(message.id) : null;
    const existing = row.querySelector('.ka-ghosts');
    if (!shown?.length) {
      if (existing) {
        existing.remove();
        remeasure(row);
      }
      return;
    }
    if (existing?.dataset.count === String(shown.length)) return;
    existing?.remove();
    const box = el('div', 'ka-ghosts');
    box.dataset.count = String(shown.length);
    for (const ghost of shown) {
      const line = el('div', 'ka-ghost');
      line.append(el('span', 'ka-ghost-name', ghost.username), ': ', renderContent(ghost.content));
      const tag = el('span', 'ka-deleted-tag', ghost.reason);
      line.append(tag);
      box.append(line);
    }
    (row.firstElementChild || row).append(box);
    remeasure(row);
  }

  // Returns the original content if the row shows a deleted message.
  function restoreDeleted(row, message) {
    const label = findDeletedLabel(row, message);
    if (!label) {
      if (row.hasAttribute('data-ka-deleted')) clearRestore(row);
      return message.content;
    }

    const original = history.get(message.id)?.content ?? message.content;
    if (!original || row.querySelector(`[data-ka-restored="${CSS.escape(message.id)}"]`)) {
      return original;
    }

    const restored = document.createElement('span');
    restored.setAttribute('data-ka-restored', message.id);
    restored.append(renderContent(original));

    const tag = document.createElement('span');
    tag.className = 'ka-deleted-tag';
    tag.textContent = t('deleted.tag');
    restored.append(tag);

    label.setAttribute('data-ka-hidden', '');
    label.after(restored);
    row.setAttribute('data-ka-deleted', '');
    remeasure(row);
    return original;
  }

  // ---- Link previews ---------------------------------------------------------

  const previewCache = new Map(); // normalized url -> Promise<preview | null>

  const URL_CANDIDATE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi;
  const IMAGE_PATH = /\.(jpe?g|png|gif|webp|avif)$/i;

  const hostIs = (url, ...hosts) =>
    hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host));

  // Kick's own API gets the page's cookies (Cloudflare may refuse requests
  // without them); other sites get none.
  async function getJson(url) {
    const sameSite = url.startsWith(location.origin);
    const response = await fetch(url, { credentials: sameSite ? 'same-origin' : 'omit' });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.json();
  }

  // Each provider returns a loader for URLs it handles, or null.
  // A loader resolves to { kind: 'image', src } or
  // { kind: 'card', site, title, text, thumb }.
  const providers = [
    function image(url) {
      if (!IMAGE_PATH.test(url.pathname)) return null;
      return async () => ({ kind: 'image', src: url.href });
    },

    function youtube(url) {
      let id = null;
      if (hostIs(url, 'youtu.be')) id = url.pathname.slice(1).split('/')[0];
      else if (hostIs(url, 'youtube.com')) {
        id = url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/)?.[1];
      }
      if (!id || !/^[\w-]{6,}$/.test(id)) return null;

      return async () => {
        const card = { kind: 'card', site: 'YouTube', title: '', text: '', thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
        try {
          const watchUrl = `https://www.youtube.com/watch?v=${id}`;
          const data = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`);
          card.title = data.title || '';
          card.site = data.author_name ? `YouTube · ${data.author_name}` : 'YouTube';
        } catch (err) { /* thumbnail alone is still useful */ }
        return card;
      };
    },

    function x(url) {
      if (!hostIs(url, 'x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com')) return null;
      const match = url.pathname.match(/^\/(\w+)\/status(?:es)?\/(\d+)/);
      if (!match) return null;

      return async () => {
        const { tweet } = await getJson(`https://api.fxtwitter.com/${match[1]}/status/${match[2]}`);
        const media = tweet.media?.all?.[0];
        const thumb = media?.thumbnail_url || (media?.type === 'photo' ? media.url.replace('name=orig', 'name=small') : '');
        return {
          kind: 'card',
          site: `X · ${tweet.author?.name || ''} @${tweet.author?.screen_name || match[1]}`,
          title: '',
          text: tweet.text || '',
          thumb
        };
      };
    },

    function tiktok(url) {
      if (!hostIs(url, 'tiktok.com')) return null;
      if (!/\/video\/\d+|\/photo\/\d+/.test(url.pathname) && !hostIs(url, 'vm.tiktok.com', 'vt.tiktok.com')) return null;

      return async () => {
        const data = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url.href)}`);
        return {
          kind: 'card',
          site: data.author_name ? `TikTok · ${data.author_name}` : 'TikTok',
          title: '',
          text: data.title || '',
          thumb: data.thumbnail_url || ''
        };
      };
    },

    function kickClip(url) {
      if (!hostIs(url, 'kick.com')) return null;
      const id = url.pathname.match(/\/clips\/(clip_\w+)/)?.[1] || url.searchParams.get('clip');
      if (!id || !/^clip_\w+$/.test(id)) return null;

      return async () => {
        const { clip } = await getJson(`https://kick.com/api/v2/clips/${id}`);
        const channel = clip.channel?.username || clip.channel?.slug;
        return {
          kind: 'card',
          site: channel ? t('preview.kickClipBy', { channel }) : t('preview.kickClip'),
          title: clip.title || '',
          text: clip.views != null ? t('preview.views', { count: Number(clip.views) }) : '',
          thumb: clip.thumbnail_url || ''
        };
      };
    },

    // Instagram has no public preview API; show a labelled link card.
    function instagram(url) {
      if (!hostIs(url, 'instagram.com')) return null;
      const match = url.pathname.match(/^\/(?:([\w.]+)\/)?(p|reels?|tv|stories)\/([\w-]+)/);
      if (!match) return null;
      const kind = match[2] === 'p' ? t('preview.igPost') : match[2] === 'stories' ? t('preview.igStory') : t('preview.igReel');

      return async () => ({
        kind: 'card',
        site: 'Instagram',
        title: match[1] ? t('preview.igBy', { kind, user: match[1] }) : kind,
        text: '',
        thumb: ''
      });
    }
  ];

  function findLinks(content) {
    const links = [];
    const seen = new Set();
    for (const [raw] of content.replace(EMOTE_TOKEN, ' ').matchAll(URL_CANDIDATE)) {
      let url;
      try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      } catch (err) {
        continue;
      }
      url.hash = '';
      url.pathname = url.pathname.replace(/[).,!?\]]+$/, '');
      if (seen.has(url.href)) continue;

      for (const provider of providers) {
        const load = provider(url);
        if (load) {
          seen.add(url.href);
          links.push({ url, load });
          break;
        }
      }
      if (links.length >= MAX_PREVIEWS_PER_MESSAGE) break;
    }
    return links;
  }

  function getPreview({ url, load }) {
    if (!previewCache.has(url.href)) {
      previewCache.set(url.href, load().catch(err => {
        console.debug('Kickoff: no preview for', url.href, err);
        return null;
      }));
      if (previewCache.size > PREVIEW_CACHE_LIMIT) {
        previewCache.delete(previewCache.keys().next().value);
      }
    }
    return previewCache.get(url.href);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // Fixed-size media boxes keep the row height stable while images load.
  function renderPreview(url, preview) {
    const link = el('a', `ka-preview ka-preview--${preview.kind}`);
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('data-prevent-expand', 'true');

    if (preview.kind === 'image') {
      const img = el('img', 'ka-preview-image');
      img.src = preview.src;
      img.alt = '';
      img.loading = 'lazy';
      link.append(img);
      return link;
    }

    if (preview.thumb) {
      const img = el('img', 'ka-preview-thumb');
      img.src = preview.thumb;
      img.alt = '';
      img.loading = 'lazy';
      link.append(img);
    }
    const body = el('span', 'ka-preview-body');
    body.append(el('span', 'ka-preview-site', preview.site));
    if (preview.title) body.append(el('span', 'ka-preview-title', preview.title));
    if (preview.text) body.append(el('span', 'ka-preview-text', preview.text));
    link.append(body);
    return link;
  }

  function clearPreviews(row) {
    row.querySelectorAll('[data-ka-previews]').forEach(node => node.remove());
  }

  function addPreviews(row, messageId, content) {
    if (!content || row.querySelector(`[data-ka-previews="${CSS.escape(messageId)}"]`)) return;
    const links = findLinks(content);
    if (!links.length) return;

    const container = el('div', 'ka-previews');
    container.setAttribute('data-ka-previews', messageId);
    (row.firstElementChild?.firstElementChild || row).append(container);

    for (const link of links) {
      getPreview(link).then(preview => {
        if (!preview || !container.isConnected || !previewsEnabled()) return;
        container.append(renderPreview(link.url, preview));
        remeasure(row);
      });
    }
  }


  // ---- 7TV emotes ------------------------------------------------------------

  let sevenTvGlobal = null;          // Promise<Map>
  const sevenTvChannels = new Map(); // channel slug -> Promise<Map>
  let emotes = new Map();            // emote name -> emote, for the current channel
  let emotesSlug = null;
  let emoteError = '';               // last failed load, shown in the status line
  let emoteLoadStarted = 0;          // while a load is in progress (status line)
  let emoteCounts = { global: 0, channel: 0 };
  let emotesRetryAt = 0;
  const EMOTES_RETRY_MS = 30 * 1000;
  let emoteIndex = [];               // emotes sorted for autocomplete (shortest first)

  function channelSlug() {
    const parts = location.pathname.split('/').filter(Boolean);
    return (parts[0] === 'popout' ? parts[1] : parts[0])?.toLowerCase() || null;
  }

  function toEmoteMap(set, scope) {
    const map = new Map();
    for (const emote of set?.emotes || []) {
      const host = emote.data?.host;
      const files = host?.files || [];
      const file = files.find(f => f.name === '2x.webp') || files.find(f => f.name === '1x.webp');
      if (!host?.url || !file?.width || !file?.height) continue;
      map.set(emote.name, {
        name: emote.name,
        src: `https:${host.url}/${file.name}`,
        ratio: file.width / file.height,
        zeroWidth: Boolean((emote.data?.flags ?? 0) & ZERO_WIDTH_FLAG),
        scope
      });
    }
    return map;
  }

  async function loadChannelEmotes(slug) {
    const channel = await getJson(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`);
    try {
      const user = await getJson(`https://7tv.io/v3/users/kick/${channel.user_id}`);
      return toEmoteMap(user.emote_set, 'channel');
    } catch (err) {
      if (String(err.message).startsWith('404')) return new Map(); // no 7TV account: cache "none"
      throw err;
    }
  }

  async function loadGlobalEmotes() {
    return toEmoteMap(await getJson('https://7tv.io/v3/emote-sets/global'), 'global');
  }

  // ---- 7TV emote cache ---------------------------------------------------------
  // The 7TV API answers with megabytes per channel (2.4 MB / ~3 s for xqc); we
  // keep only what we use (~100 KB) in localStorage. Cached emotes are used right
  // away and refreshed in the background once they're older than 6 hours.

  const EMOTE_CACHE_PREFIX = 'kickoff:7tv:';
  const EMOTE_CACHE_VERSION = 1;
  const EMOTE_CACHE_FRESH_MS = 6 * 60 * 60 * 1000;

  function readEmoteCache(key) {
    try {
      const cached = JSON.parse(localStorage.getItem(EMOTE_CACHE_PREFIX + key));
      if (cached?.version !== EMOTE_CACHE_VERSION) return null;
      return { at: cached.at, map: new Map(cached.emotes.map(emote => [emote.name, emote])) };
    } catch (err) {
      return null;
    }
  }

  function writeEmoteCache(key, map) {
    const value = JSON.stringify({ version: EMOTE_CACHE_VERSION, at: Date.now(), emotes: [...map.values()] });
    try {
      localStorage.setItem(EMOTE_CACHE_PREFIX + key, value);
    } catch (err) {
      // Storage full: drop other channels' caches and try once more.
      for (const stored of Object.keys(localStorage)) {
        if (stored.startsWith(EMOTE_CACHE_PREFIX) && stored !== EMOTE_CACHE_PREFIX + key) localStorage.removeItem(stored);
      }
      try { localStorage.setItem(EMOTE_CACHE_PREFIX + key, value); } catch (err2) { /* not cached */ }
    }
  }

  // Resolves with cached emotes when there are any (any age), else fetches.
  // Stale caches are refreshed in the background, then onRefresh() re-applies.
  function loadEmoteSet(key, load, onRefresh) {
    const fetchFresh = () => load().then(map => {
      writeEmoteCache(key, map);
      return map;
    });
    const cached = readEmoteCache(key);
    if (!cached) return fetchFresh();
    if (Date.now() - cached.at > EMOTE_CACHE_FRESH_MS) {
      fetchFresh().then(onRefresh, () => { /* keep using the stale cache */ });
    }
    return Promise.resolve(cached.map);
  }

  // Load global + channel emotes (cached per channel), then re-render rows.
  async function syncEmotes() {
    const slug = channelSlug();
    if (slug === emotesSlug && emotes.size) return;
    emotesSlug = slug;

    // After a background refresh, forget the in-memory set and apply the new one.
    const refreshed = forget => () => {
      forget();
      if (channelSlug() === slug) {
        emotesSlug = null;
        syncEmotes();
      }
    };
    // A failed load is reported and forgotten, so the next attempt retries it.
    const failed = (what, forget) => err => {
      emoteError = `${what}: ${err?.message || err}`;
      forget();
      return new Map();
    };
    sevenTvGlobal ||= loadEmoteSet('global', loadGlobalEmotes, refreshed(() => { sevenTvGlobal = null; }))
      .catch(failed('7TV global emotes', () => { sevenTvGlobal = null; }));
    if (slug && !sevenTvChannels.has(slug)) {
      sevenTvChannels.set(slug, loadEmoteSet(`channel:${slug}`, () => loadChannelEmotes(slug), refreshed(() => sevenTvChannels.delete(slug)))
        .catch(failed(`7TV emotes for ${slug}`, () => sevenTvChannels.delete(slug))));
    }
    emoteLoadStarted = Date.now();
    const [global, channel] = await Promise.all([sevenTvGlobal, sevenTvChannels.get(slug) || new Map()]);
    emoteLoadStarted = 0;
    emoteCounts = { global: global.size, channel: channel.size };
    if (slug !== emotesSlug) return; // channel switched meanwhile
    emotes = new Map([...global, ...channel]); // channel emotes win on name clashes
    if (emotes.size) emoteError = '';
    emoteIndex = [...emotes.values()].sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));

    document.querySelectorAll('[data-ka-id]').forEach(row => {
      clear7tv(row);
      clearRestore(row);
    });
    syncToolbar();
    if (picker?.isConnected) renderPickerGrid();
    schedule();
  }

  function emoteImage(emote) {
    const img = document.createElement('img');
    img.src = emote.src;
    img.alt = emote.name;
    img.title = emote.name;
    img.className = 'ka-7tv-emote';
    img.style.aspectRatio = String(emote.ratio); // width known before load: no reflow
    return img;
  }

  const EMOTE_NODE = '.ka-7tv-emote, .ka-7tv-stack, .ka-emote, [data-emote-id]';

  // The emote right before the insertion point (skipping spaces), to stack a
  // zero-width emote onto: first in what we've built, else before the text node.
  function previousEmote(parent, before) {
    let node = parent.lastChild || before;
    while (node && node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) {
      node = node.previousSibling || (node.parentNode === parent ? before : null);
    }
    return node?.nodeType === Node.ELEMENT_NODE && node.matches(EMOTE_NODE) ? node : null;
  }

  function stackOnto(base, img) {
    let stack = base;
    if (!base.classList.contains('ka-7tv-stack')) {
      stack = document.createElement('span');
      stack.className = 'ka-7tv-stack';
      base.replaceWith(stack);
      stack.append(base);
    }
    img.classList.add('ka-7tv-zero-width');
    stack.append(img);
  }

  // "@name", also with punctuation around it ("(@name)", "@name,"). Kick names are
  // 3-25 letters, digits and underscores.
  const MENTION_WORD = /^([^\w@]*)@(\w{3,25})([^\w@]*)$/;

  const emotesShown = () => sevenTvEnabled() && emotes.size > 0;

  // The mentioned user's name colour, once they've written in this visit.
  function mentionColor(username) {
    const hex = userColors.get(username.toLowerCase());
    if (!hex) return '';
    const rgb = `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    return (readableNamesEnabled() && readableColor(rgb)) || rgb;
  }

  function mentionButton(username) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ka-mention';
    button.dataset.user = username; // taps are handled in handleTap()
    button.textContent = `@${username}`;
    const color = mentionColor(username);
    if (color) button.style.color = color;
    return button;
  }

  // Appends text to parent with 7TV emote names (exact, case-sensitive words)
  // swapped for images and, with `mentions`, @names for buttons that open the
  // user's card. `before` is the node preceding parent's insertion point.
  function appendEmoteText(parent, text, before = null, mentions = false) {
    const withEmotes = emotesShown();
    for (const part of text.replace(TAG_CHARS, '').split(/(\s+)/)) {
      if (!part) continue;
      const emote = withEmotes && emotes.get(part);
      if (emote) {
        const base = emote.zeroWidth && previousEmote(parent, before);
        if (base) stackOnto(base, emoteImage(emote));
        else parent.append(emoteImage(emote));
        continue;
      }
      const mention = mentions && part.match(MENTION_WORD);
      if (mention) {
        parent.append(mention[1], mentionButton(mention[2]), mention[3]);
        continue;
      }
      parent.append(part);
    }
  }

  // A word our copy of the message would draw differently: a 7TV emote or an @name.
  function hasRichWord(text, mentions = mentionsEnabled()) {
    const withEmotes = emotesShown();
    if (!withEmotes && !mentions) return false;
    return text.replace(TAG_CHARS, '').split(/\s+/)
      .some(word => (withEmotes && emotes.has(word)) || (mentions && MENTION_WORD.test(word)));
  }

  function clear7tv(row) {
    row.querySelectorAll('[data-ka-7tv]').forEach(node => node.remove());
    row.querySelectorAll('[data-ka-7tv-hidden]').forEach(node => node.removeAttribute('data-ka-7tv-hidden'));
  }

  // Never edit React's nodes: render a copy of the message text with emotes and
  // @mentions, and hide the original (removed again if the message changes, e.g.
  // gets deleted). Named for 7TV, which it was first made for.
  function apply7tv(row) {
    const content = row.querySelector('span[aria-hidden="true"] + span');
    if (!content || content.hasAttribute('data-ka-7tv-hidden')) return;
    if (!hasRichWord(content.textContent)) return;

    const copy = content.cloneNode(true);
    copy.setAttribute('data-ka-7tv', '');
    const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const textNode of textNodes) {
      const mentions = mentionsEnabled() && !textNode.parentElement?.closest('a'); // no button inside a link
      if (!hasRichWord(textNode.textContent, mentions)) continue;
      const fragment = document.createDocumentFragment();
      appendEmoteText(fragment, textNode.textContent, textNode.previousSibling, mentions);
      textNode.replaceWith(fragment);
    }

    copy.querySelectorAll('.ka-7tv-emote').forEach(img => {
      img.addEventListener('load', () => remeasure(row), { once: true });
    });
    content.setAttribute('data-ka-7tv-hidden', '');
    content.after(copy);
    remeasure(row);
  }


  // ---- 7TV name paints and badges ------------------------------------------------
  // Chatters' 7TV cosmetics come from 7TV's GraphQL API in two steps: which paint
  // and badge each chatter has (40 per request; 7TV refuses bigger queries), then
  // the full definitions only for paints/badges not seen before (5 users per
  // request). Definitions never change and are cached; chatters for 12 hours.
  // A paint is a stylesheet rule for html[data-ka-7tv-cosmetics] [data-ka-paint=id]
  // on the name; a badge is an image put before the name.

  const COSMETICS_ATTR = 'data-ka-7tv-cosmetics';
  const EMOTE_ONLY_ATTR = 'data-ka-emote-only';
  const COSMETICS_KEY = 'kickoff:7tv:cosmetics';
  const COSMETICS_VERSION = 1;
  const COSMETICS_USER_TTL_MS = 12 * 60 * 60 * 1000;
  const COSMETICS_USER_LIMIT = 3000;
  const COSMETICS_LOOKUP_BATCH = 40;
  const COSMETICS_DETAIL_BATCH = 5;
  const COSMETICS_GAP_MS = 1000;
  const COSMETICS_RETRY_MS = 30 * 1000;
  const SEVENTV_GQL = 'https://7tv.io/v4/gql';
  const SEVENTV_CDN = /^https:\/\/cdn\.7tv\.app\/[\w/.-]+$/;
  const SAFE_ID = /^[\w-]{1,64}$/;

  const cosmeticsEnabled = () => document.documentElement.hasAttribute(COSMETICS_ATTR);

  const cosmetics = readCosmetics(); // { users: { kickId: [paintId, badgeId, at] }, paints: { id: css }, badges: { id: { name, src } } }
  const cosmeticsQueue = new Set();  // Kick user ids to look up
  let cosmeticsBusy = false;
  let cosmeticsPauseUntil = 0;
  let paintStyle = null;
  let paintStyleCount = -1;

  function readCosmetics() {
    try {
      const stored = JSON.parse(localStorage.getItem(COSMETICS_KEY));
      if (stored?.version === COSMETICS_VERSION) return stored;
    } catch (err) { /* start over */ }
    return { version: COSMETICS_VERSION, users: {}, paints: {}, badges: {} };
  }

  let cosmeticsSaveTimer = null;
  function saveCosmetics() {
    clearTimeout(cosmeticsSaveTimer);
    cosmeticsSaveTimer = setTimeout(() => {
      const ids = Object.keys(cosmetics.users);
      if (ids.length > COSMETICS_USER_LIMIT) {
        ids.sort((a, b) => cosmetics.users[a][2] - cosmetics.users[b][2])
          .slice(0, ids.length - COSMETICS_USER_LIMIT)
          .forEach(id => delete cosmetics.users[id]);
      }
      try {
        localStorage.setItem(COSMETICS_KEY, JSON.stringify(cosmetics));
      } catch (err) { /* storage full: kept in memory only */ }
    }, 2000);
  }

  async function sevenTvGql(query) {
    const response = await fetch(SEVENTV_GQL, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query })
    });
    if (!response.ok) throw new Error(`7TV ${response.status}`);
    const json = await response.json();
    if (json.errors?.length) throw new Error(`7TV: ${json.errors[0].message}`);
    return json.data;
  }

  const byConnection = (ids, fields) => `query { users { ${ids
    .map((id, i) => `u${i}: userByConnection(platform: KICK, platformId: "${id}") { ${fields} }`).join(' ')} } }`;

  const COLOR_FIELDS = 'r g b a';
  const STOP_FIELDS = `stops { at color { ${COLOR_FIELDS} } }`;
  const DETAIL_FIELDS = `style { activePaint { id data { layers { opacity ty { __typename `
    + `... on PaintLayerTypeSingleColor { color { ${COLOR_FIELDS} } } `
    + `... on PaintLayerTypeLinearGradient { angle repeating ${STOP_FIELDS} } `
    + `... on PaintLayerTypeRadialGradient { repeating shape ${STOP_FIELDS} } `
    + `... on PaintLayerTypeImage { images { url mime scale } } } } `
    + `shadows { color { ${COLOR_FIELDS} } offsetX offsetY blur } } } `
    + `activeBadge { id name images { url mime scale } } }`;

  const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  function rgba(color, opacity = 1) {
    const channel = value => Math.min(255, Math.max(0, Math.round(num(value))));
    const alpha = Math.min(1, Math.max(0, (num(color?.a, 255) / 255) * opacity));
    return `rgba(${channel(color?.r)}, ${channel(color?.g)}, ${channel(color?.b)}, ${alpha.toFixed(3)})`;
  }

  function stopList(stops, opacity) {
    return (stops || []).map(stop => `${rgba(stop.color, opacity)} ${(num(stop.at) * 100).toFixed(1)}%`).join(', ');
  }

  // Prefer a static 1x WebP (fine for text and badges, cheap to load).
  function pickImage(images) {
    const usable = (images || []).filter(image => SEVENTV_CDN.test(image.url || ''));
    const rank = image => (image.mime === 'image/webp' ? 0 : image.mime === 'image/png' ? 1 : 2) * 10 + Math.abs(num(image.scale, 1) - 2);
    return usable.sort((a, b) => rank(a) - rank(b))[0]?.url || null;
  }

  // A paint's CSS declarations, or null if it has nothing we can draw.
  function paintCss(paint) {
    const backgrounds = [];
    const sizes = [];
    for (const layer of paint?.data?.layers || []) {
      const ty = layer.ty || {};
      const opacity = Math.min(1, Math.max(0, num(layer.opacity, 1)));
      if (ty.__typename === 'PaintLayerTypeSingleColor') {
        backgrounds.push(`linear-gradient(${rgba(ty.color, opacity)}, ${rgba(ty.color, opacity)})`);
        sizes.push('100% 100%');
      } else if (ty.__typename === 'PaintLayerTypeLinearGradient' && ty.stops?.length) {
        backgrounds.push(`${ty.repeating ? 'repeating-' : ''}linear-gradient(${num(ty.angle)}deg, ${stopList(ty.stops, opacity)})`);
        sizes.push('100% 100%');
      } else if (ty.__typename === 'PaintLayerTypeRadialGradient' && ty.stops?.length) {
        const shape = String(ty.shape || '').toLowerCase() === 'circle' ? 'circle' : 'ellipse';
        backgrounds.push(`${ty.repeating ? 'repeating-' : ''}radial-gradient(${shape}, ${stopList(ty.stops, opacity)})`);
        sizes.push('100% 100%');
      } else if (ty.__typename === 'PaintLayerTypeImage') {
        const url = pickImage(ty.images);
        if (url) {
          backgrounds.push(`url("${url}")`);
          sizes.push('cover');
        }
      }
    }
    if (!backgrounds.length) return null;
    const shadows = (paint.data.shadows || []).slice(0, 4)
      .map(shadow => `drop-shadow(${num(shadow.offsetX).toFixed(2)}px ${num(shadow.offsetY).toFixed(2)}px ${Math.max(0, num(shadow.blur)).toFixed(2)}px ${rgba(shadow.color)})`);
    return [
      `background-image: ${backgrounds.join(', ')}`,
      `background-size: ${sizes.join(', ')}`,
      '-webkit-background-clip: text',
      'background-clip: text',
      '-webkit-text-fill-color: transparent',
      'color: transparent !important',
      shadows.length ? `filter: ${shadows.join(' ')}` : ''
    ].filter(Boolean).join('; ');
  }

  function renderPaintStyles() {
    const ids = Object.keys(cosmetics.paints);
    if (ids.length === paintStyleCount && paintStyle?.isConnected) return;
    paintStyleCount = ids.length;
    if (!paintStyle) {
      paintStyle = document.createElement('style');
      paintStyle.dataset.kickoff = '7tv-paints';
    }
    if (!paintStyle.isConnected) (document.head || document.documentElement).append(paintStyle);
    paintStyle.textContent = ids
      .filter(id => SAFE_ID.test(id) && cosmetics.paints[id])
      .map(id => `html[${COSMETICS_ATTR}] [data-ka-paint="${id}"] { ${cosmetics.paints[id]} }`)
      .join('\n');
  }

  // Looks up the chatters queued so far, one request at a time.
  async function flushCosmetics() {
    if (cosmeticsBusy || !cosmeticsQueue.size || Date.now() < cosmeticsPauseUntil || !cosmeticsEnabled()) return;
    cosmeticsBusy = true;
    const ids = [...cosmeticsQueue].slice(0, COSMETICS_LOOKUP_BATCH);
    try {
      const data = await sevenTvGql(byConnection(ids, 'style { activePaint { id } activeBadge { id } }'));
      const needDetails = [];
      ids.forEach((id, i) => {
        const style = data?.users?.[`u${i}`]?.style;
        const paint = SAFE_ID.test(style?.activePaint?.id || '') ? style.activePaint.id : null;
        const badge = SAFE_ID.test(style?.activeBadge?.id || '') ? style.activeBadge.id : null;
        cosmetics.users[id] = [paint, badge, Date.now()];
        cosmeticsQueue.delete(id);
        if ((paint && !(paint in cosmetics.paints)) || (badge && !(badge in cosmetics.badges))) needDetails.push(id);
      });
      for (let i = 0; i < needDetails.length; i += COSMETICS_DETAIL_BATCH) {
        const chunk = needDetails.slice(i, i + COSMETICS_DETAIL_BATCH);
        const details = await sevenTvGql(byConnection(chunk, DETAIL_FIELDS));
        chunk.forEach((id, k) => {
          const style = details?.users?.[`u${k}`]?.style;
          const paint = style?.activePaint;
          if (paint && SAFE_ID.test(paint.id || '')) cosmetics.paints[paint.id] = paintCss(paint);
          const badge = style?.activeBadge;
          if (badge && SAFE_ID.test(badge.id || '')) {
            const src = pickImage(badge.images);
            cosmetics.badges[badge.id] = src ? { name: String(badge.name || '7TV badge').slice(0, 100), src } : null;
          }
        });
      }
      saveCosmetics();
      renderPaintStyles();
      schedule();
    } catch (err) {
      cosmeticsPauseUntil = Date.now() + COSMETICS_RETRY_MS;
      emoteError = `7TV paints & badges: ${err?.message || err}`;
    } finally {
      cosmeticsBusy = false;
      if (cosmeticsQueue.size) setTimeout(() => guarded('7TV cosmetics', flushCosmetics), COSMETICS_GAP_MS);
    }
  }

  // The chatter's cosmetics if known; otherwise queues a lookup.
  function cosmeticUser(kickId) {
    const id = String(kickId);
    if (!/^\d{1,12}$/.test(id)) return null;
    const user = cosmetics.users[id];
    if (user && Date.now() - user[2] < COSMETICS_USER_TTL_MS) return { paint: user[0], badge: user[1] };
    if (!cosmeticsQueue.has(id)) {
      cosmeticsQueue.add(id);
      setTimeout(() => guarded('7TV cosmetics', flushCosmetics), 300); // gather a batch first
    }
    return user ? { paint: user[0], badge: user[1] } : null; // stale is fine meanwhile
  }

  function nameButton(row) {
    return row.querySelector('button[data-prevent-expand][style*="color"]');
  }

  function clearCosmetics(row) {
    row.querySelectorAll('.ka-7tv-badge').forEach(node => node.remove());
    row.querySelectorAll('[data-ka-paint]').forEach(node => node.removeAttribute('data-ka-paint'));
  }

  function applyCosmetics(row, message) {
    const name = nameButton(row);
    const user = cosmeticsEnabled() && name && message.sender?.id != null ? cosmeticUser(message.sender.id) : null;
    if (!user) {
      if (row.querySelector('.ka-7tv-badge, [data-ka-paint]')) {
        clearCosmetics(row);
        remeasure(row);
      }
      return;
    }
    const paint = user.paint && cosmetics.paints[user.paint] ? user.paint : null;
    if ((name.getAttribute('data-ka-paint') || null) !== paint) {
      if (paint) name.setAttribute('data-ka-paint', paint);
      else name.removeAttribute('data-ka-paint');
    }
    const badge = user.badge && cosmetics.badges[user.badge];
    let img = row.querySelector('.ka-7tv-badge');
    if (img && (!badge || img.dataset.badge !== user.badge || img.nextElementSibling !== name)) {
      img.remove();
      img = null;
    }
    if (badge && !img) {
      img = document.createElement('img');
      img.className = 'ka-7tv-badge';
      img.src = badge.src;
      img.alt = '';
      img.title = badge.name;
      img.dataset.badge = user.badge;
      name.before(img);
      remeasure(row);
    }
  }

  // ---- Emote usage (recents and ranking) --------------------------------------
  // Counted when an emote is inserted from the picker, the emote card or
  // autocomplete; kept in localStorage, shared across channels. Also synced to the
  // user's other devices: sent to content.js a few seconds after a use (and once
  // on load), and merged back in when content.js passes on what iCloud brought.

  const USAGE_KEY = 'kickoff:7tv:usage';
  const USAGE_LIMIT = 200; // most recently used names kept
  const RECENT_COUNT = 24;
  const USAGE_SEND_MS = 3000;
  let usageSendTimer = null;

  let usage = readUsage(); // name -> { count, last }

  function readUsage() {
    try {
      return JSON.parse(localStorage.getItem(USAGE_KEY)) || {};
    } catch (err) {
      return {};
    }
  }

  function recordUsage(name) {
    usage = readUsage(); // another tab may have recorded some too
    usage[name] = { count: (usage[name]?.count || 0) + 1, last: Date.now() };
    const names = Object.keys(usage);
    if (names.length > USAGE_LIMIT) {
      names.sort((a, b) => usage[a].last - usage[b].last)
        .slice(0, names.length - USAGE_LIMIT)
        .forEach(old => delete usage[old]);
    }
    writeUsage();
    clearTimeout(usageSendTimer);
    usageSendTimer = setTimeout(() => sendToExtension('usage:set', { usage }), USAGE_SEND_MS);
  }

  function writeUsage() {
    try {
      localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
    } catch (err) { /* storage full: ranking just won't learn */ }
  }

  // Same merge as content.js and background.js: per emote the higher count and
  // the latest use, then the USAGE_LIMIT most recent.
  function mergeUsage(a, b) {
    const merged = { ...a };
    for (const [name, entry] of Object.entries(b || {})) {
      if (!Number.isFinite(entry?.count) || !Number.isFinite(entry?.last)) continue;
      const mine = merged[name];
      merged[name] = mine
        ? { count: Math.max(mine.count, entry.count), last: Math.max(mine.last, entry.last) }
        : { count: entry.count, last: entry.last };
    }
    const names = Object.keys(merged);
    if (names.length > USAGE_LIMIT) {
      names.sort((x, y) => merged[x].last - merged[y].last)
        .slice(0, names.length - USAGE_LIMIT)
        .forEach(old => delete merged[old]);
    }
    return merged;
  }

  // Most recently used first, limited to emotes this channel has.
  function recentEmotes() {
    return Object.entries(usage)
      .sort((a, b) => b[1].last - a[1].last)
      .map(([name]) => emotes.get(name))
      .filter(Boolean)
      .slice(0, RECENT_COUNT);
  }

  // More often used first, then more recently used; unused keep their order.
  function byUsage(a, b) {
    const ua = usage[a.name];
    const ub = usage[b.name];
    return (ub?.count || 0) - (ua?.count || 0) || (ub?.last || 0) - (ua?.last || 0);
  }

  // ---- Emote card (tap an emote) ---------------------------------------------

  let card = null;

  function closeCard() {
    card?.remove();
    card = null;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Older Safari: copy via a temporary textarea.
      const area = el('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0;';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  }

  function chatInput() {
    return document.querySelector('[data-testid="chat-input"][contenteditable="true"]');
  }

  // Appends text to the message. Preferably through Lexical's own update API,
  // which edits the message without focusing the editor (so the phone keyboard
  // doesn't pop up for every emote). If Kick's editor internals change, fall
  // back to typing it in with execCommand, which needs focus.
  function insertAtEnd(text) {
    const input = chatInput();
    if (!input) return false;
    const before = input.textContent;

    const editor = input.__lexicalEditor;
    if (editor?.update) {
      try {
        editor.update(() => {
          const root = editor._pendingEditorState._nodeMap.get('root');
          const needsSpace = /\S$/.test(root.getTextContent());
          root.selectEnd().insertText(`${needsSpace ? ' ' : ''}${text} `);
        }, { discrete: true });
      } catch (err) { /* fall through */ }
      if (input.textContent !== before) return true;
    }

    const attempt = () => {
      // The caret must be inside Lexical's last paragraph (at the end of its
      // last text), not after it, or Lexical ignores the insert.
      const paragraph = input.querySelector('p:last-of-type') || input;
      let last = paragraph.lastChild;
      while (last && last.nodeType !== Node.TEXT_NODE) last = last.lastChild;
      const range = document.createRange();
      if (last) range.setStart(last, last.textContent.length);
      else range.setStart(paragraph, 0);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const needsSpace = /\S$/.test(input.innerText.replace(/\n$/, ''));
      document.execCommand('insertText', false, `${needsSpace ? ' ' : ''}${text} `);
    };
    input.focus();
    attempt();
    // Lexical can drop the first insert right after the editor gains focus.
    setTimeout(() => {
      if (input.textContent === before) attempt();
    }, 50);
    return true;
  }

  function cardRow(emote) {
    const row = el('div', 'ka-card-row');
    const img = el('img', 'ka-card-image');
    img.src = emote.src;
    img.alt = emote.name;
    img.style.aspectRatio = String(emote.ratio);

    const info = el('div', 'ka-card-info');
    info.append(el('div', 'ka-card-name', emote.name));
    const meta = [emote.scope === 'channel' ? t('emote.channel') : t('emote.global')];
    if (emote.zeroWidth) meta.push(t('emote.zeroWidth'));
    info.append(el('div', 'ka-card-meta', meta.join(' · ')));

    const actions = el('div', 'ka-card-actions');
    const copy = el('button', 'ka-card-button', t('card.copy'));
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      copy.textContent = (await copyText(emote.name)) ? t('card.copied') : t('card.copyFailed');
    });
    actions.append(copy);
    if (chatInput()) {
      const insert = el('button', 'ka-card-button', t('card.insert'));
      insert.type = 'button';
      insert.addEventListener('click', () => {
        if (insertAtEnd(emote.name)) {
          recordUsage(emote.name);
          closeCard();
        }
      });
      actions.append(insert);
    }
    info.append(actions);

    row.append(img, info);
    return row;
  }

  function openCard(target) {
    closeCard();
    const images = target.classList.contains('ka-7tv-stack')
      ? [...target.querySelectorAll('img.ka-7tv-emote')]
      : [target];
    const list7tv = images.map(img => emotes.get(img.alt)).filter(Boolean);
    if (!list7tv.length) return;

    showCard(target, t('card.emote'), list7tv.map(cardRow));
  }

  // A small card next to `target`: above it if there is room, else below; kept
  // inside the viewport.
  function showCard(target, label, children) {
    closeCard();
    card = el('div', 'ka-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', label);
    card.append(...children);
    document.body.append(card);

    const anchor = target.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const margin = 8;
    let top = anchor.top - box.height - margin;
    if (top < margin) top = anchor.bottom + margin;
    const left = Math.min(Math.max(margin, anchor.left + anchor.width / 2 - box.width / 2), innerWidth - box.width - margin);
    card.style.top = `${Math.max(margin, Math.min(top, innerHeight - box.height - margin))}px`;
    card.style.left = `${left}px`;
  }

  // Handles a tap on one of our elements; returns true if it did. Taps on cards'
  // own buttons are left to their click handlers.
  function handleTap(target) {
    if (card?.contains(target)) return false;

    const repeat = target.closest?.('.ka-repeat');
    if (repeat) {
      openRepeatCard(repeat);
      return true;
    }

    const mutedLine = target.closest?.('.ka-muted-line, .ka-event-line');
    if (mutedLine) {
      toggleRevealed(mutedLine.dataset.id);
      return true;
    }

    if (target.closest?.('.ka-7tv-button')) {
      togglePicker();
      return true;
    }
    if (target.closest?.('.ka-messages-button')) {
      toggleMessages();
      return true;
    }
    const proxy = target.closest?.('.ka-proxy');
    if (proxy && proxyTargets.get(proxy)?.isConnected) {
      pressKickButton(proxyTargets.get(proxy));
      return true;
    }
    if (target.closest?.('.ka-collapse-button')) {
      setInputHidden(true);
      return true;
    }
    if (target.closest?.('.ka-catchup')) {
      openCatchupNotice(target);
      return true;
    }
    if (target.closest?.('.ka-reveal')) {
      setInputHidden(false);
      return true;
    }

    // Saved messages panel: inserting is handled here (no focus change, so the
    // phone keyboard stays as it is); its other buttons have their own handlers.
    const savedRow = target.closest?.('.ka-msg-insert');
    if (savedRow && messagesPanel?.contains(savedRow)) {
      insertSavedMessage(savedRow.dataset.id, savedRow);
      return true;
    }
    if (messagesPanel?.contains(target)) return false;

    const pick = target.closest?.('.ka-picker-emote');
    if (pick && picker?.contains(pick)) {
      if (insertAtEnd(pick.dataset.name)) {
        recordUsage(pick.dataset.name);
        flash(pick);
      }
      return true;
    }
    if (target.closest?.('.ka-picker-close')) {
      closePicker();
      return true;
    }
    if (picker?.contains(target)) return false; // e.g. the search field

    const chip = target.closest?.('.ka-ac-chip');
    if (chip && acBar?.contains(chip)) {
      commitSuggestion(acMatches[Number(chip.dataset.index)]);
      return true;
    }

    const emote = sevenTvEnabled() && target.closest?.(`${LIST_SELECTOR} .ka-7tv-stack, ${LIST_SELECTOR} .ka-7tv-emote`);
    if (emote) {
      openCard(emote.closest('.ka-7tv-stack') || emote);
      return true;
    }

    const mention = mentionsEnabled() && target.closest?.(`${LIST_SELECTOR} .ka-mention`);
    if (mention) {
      closeCard();
      openUserCardFor(mention.dataset.user, mention.closest(ROW_SELECTOR));
      return true;
    }

    // "Replying to …": jump to the original message.
    const reply = replyHeaderAt(target);
    if (reply) {
      openReplyOriginal(reply.element, reply.original);
      return true;
    }

    // A tap on a message's text (not a name, link, emote or button): offer to save
    // it or mute its sender.
    const text = (messagesEnabled() || muteEnabled()) && messageTextAt(target);
    if (text) {
      openMessageCard(text.row, text.message);
      return true;
    }

    closeCard();
    return false;
  }

  // Capture phase so Kick's own row handlers don't also react to the tap.
  document.addEventListener('click', event => {
    if (handleTap(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  // iOS: Kick's chat rows handle touches themselves, so a tap on an emote may
  // never become a 'click'; and tapping a suggestion would move focus off the
  // editor (closing the keyboard). Detect taps from touch events instead, and
  // cancel the touch when we handle it (no focus change, no follow-up click).
  let touchStart = null;
  document.addEventListener('touchstart', event => {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    touchStart = touch && { x: touch.clientX, y: touch.clientY, time: Date.now(), target: event.target };
  }, { capture: true, passive: true });

  document.addEventListener('touchend', event => {
    const start = touchStart;
    touchStart = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    const moved = Math.hypot(touch.clientX - start.x, touch.clientY - start.y);
    if (moved > 10 || Date.now() - start.time > 500) return; // a scroll or long-press
    if (handleTap(start.target)) {
      event.preventDefault();
      // Chat rows must still get the touchend: on phones Kick starts a 300 ms
      // long-press timer on touchstart (its message action menu, e.g. "Show full
      // thread") and only cancels it on touchend.
      if (!start.target.closest?.(LIST_SELECTOR)) event.stopPropagation();
    }
  }, { capture: true, passive: false });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeCard();
      closePicker();
      closeMessages();
    }
  });
  // Close when the user scrolls, not on 'scroll': Kick scrolls the list itself on
  // every new message, which would close the card right away in a busy chat.
  document.addEventListener('touchmove', event => {
    if (!card?.contains(event.target)) closeCard();
  }, { capture: true, passive: true });
  document.addEventListener('wheel', closeCard, { capture: true, passive: true });

  // ---- Channel commands -------------------------------------------------------------
  // Channels have their own commands answered by a bot ("!chill" → "chill level
  // 7/10"). "!" is the usual prefix, but some bots let the streamer pick another
  // (StreamElements) or use their own ("$"), so any of COMMAND_PREFIXES counts. A
  // "!word" counts as a command once a bot answers it within a few seconds: the
  // answer mentions or replies to the asker, or nobody else asked something
  // meanwhile. Learned from every message Kick lists (see harvest), kept per
  // channel (names with their prefix, "!chill") in kick.com's localStorage, and
  // suggested when a message starts with a prefix. Synced like emote usage: sent to content.js after a change (and once
  // on load), merged with what comes back from iCloud.

  const COMMANDS_KEY = 'kickoff:commands';
  const COMMAND_PREFIXES = '!?$%#&~.+'; // "/" is Kick's own (never sent), "@" a mention
  const COMMAND = /^([!?$%#&~.+][\p{L}\p{N}_-]{1,30})(?=\s|$)/u;
  const COMMAND_NAME = /^[!?$%#&~.+][\p{L}\p{N}_-]{1,30}$/u; // stored names (mergeCommands)
  const COMMAND_ANSWER_MS = 10 * 1000;     // a bot's answer naming the asker
  const COMMAND_UNADDRESSED_MS = 5 * 1000; // an answer naming nobody
  const COMMANDS_PER_CHANNEL = 50;
  const COMMAND_CHANNELS = 20;      // channels kept (most recently answered)
  const COMMAND_ANSWER_LENGTH = 100;
  const COMMANDS_SAVE_MS = 2000;

  const commandsEnabled = () => document.documentElement.hasAttribute(COMMANDS_ATTR);
  let commands = readCommands(); // channel -> { name -> { uses, at, answer } }
  let commandsSaveTimer = 0;
  const askedCommands = []; // { channel, name, user, at }, newest last

  function readCommands() {
    try {
      const value = JSON.parse(localStorage.getItem(COMMANDS_KEY));
      return value && typeof value === 'object' ? value : {};
    } catch (err) {
      return {};
    }
  }

  function saveCommandsSoon() {
    clearTimeout(commandsSaveTimer);
    commandsSaveTimer = setTimeout(() => {
      commands = mergeCommands(readCommands(), commands); // other tabs learn too
      writeCommands();
      sendToExtension('commands:set', { commands }); // on to iCloud
    }, COMMANDS_SAVE_MS);
  }

  // Same merge as content.js and background.js (iCloud sync): per channel and
  // command the higher use count, and the newest answer; then the
  // COMMANDS_PER_CHANNEL newest per channel, in the COMMAND_CHANNELS newest channels.
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

  function writeCommands() {
    try {
      localStorage.setItem(COMMANDS_KEY, JSON.stringify(commands));
    } catch (err) { /* storage full: they just aren't kept */ }
  }

  // Kick's bot badge, a name on your bot list or BOT_NAMES, or a name ending in "bot".
  function isBotMessage(message) {
    const username = message.sender?.username || '';
    const badges = [...(message.sender?.identity?.badges || []), ...(message.sender?.identity?.badges_v2 || [])];
    return isBot(username) || /bot$/i.test(username) || badges.some(badge => /bot/i.test(`${badge?.type || ''} ${badge?.name || ''}`));
  }

  function learnCommands(message) {
    if (!commandsEnabled()) return;
    const channel = channelSlug();
    const at = Date.parse(message.created_at) || Date.now();
    while (askedCommands.length && (at - askedCommands[0].at > COMMAND_ANSWER_MS || askedCommands[0].channel !== channel)) askedCommands.shift();
    const text = plainText(message.content).replace(INVISIBLE_CHARS, '').trim();
    const user = (message.sender?.username || '').toLowerCase();
    if (!channel || !text) return;
    if (!isBotMessage(message)) {
      const match = text.match(COMMAND);
      if (match) askedCommands.push({ channel, name: match[1].toLowerCase(), user, at });
      return;
    }
    if (!askedCommands.length) return;
    const words = new Set(text.toLowerCase().split(/\s+/).map(word => word.replace(/^@/, '').replace(/[^\p{L}\p{N}_]+$/u, '')));
    const repliedTo = message.metadata?.original_sender?.username?.toLowerCase();
    const asker = [...askedCommands].reverse().find(asked => asked.user && (asked.user === repliedTo || words.has(asked.user)));
    // Not addressed to anyone: only right after a single command (bots also post
    // timed messages, like a Discord link, which mustn't make "!discord" a command).
    const names = new Set(askedCommands.map(asked => asked.name));
    const last = askedCommands[askedCommands.length - 1];
    const asked = asker || (names.size === 1 && at - last.at <= COMMAND_UNADDRESSED_MS ? last : null);
    if (!asked) return;
    askedCommands.splice(askedCommands.indexOf(asked), 1);
    const known = (commands[channel] ||= {});
    const before = known[asked.name];
    known[asked.name] = { uses: (before?.uses || 0) + 1, at, answer: asOneLine(text).slice(0, COMMAND_ANSWER_LENGTH) };
    saveCommandsSoon();
  }

  // The channel's commands starting with query (prefix included), most used first.
  function searchCommands(query) {
    const known = commands[channelSlug()] || {};
    const lower = query.toLowerCase();
    return Object.entries(known)
      .filter(([name]) => name.startsWith(lower))
      .sort((a, b) => b[1].uses - a[1].uses || b[1].at - a[1].at)
      .slice(0, AC_MAX_RESULTS)
      .map(([name, info]) => ({ command: true, name, answer: info.answer }));
  }

  // ---- Autocomplete ------------------------------------------------------------

  const AC_MIN_CHARS = 2;
  const AC_MAX_RESULTS = 20;

  let acInput = null;   // the editor we're attached to
  let acBar = null;     // the suggestion strip
  let acMatches = [];
  let acSelected = -1;  // keyboard selection; -1 = none

  // The text node and offset of the caret, resolving element positions Lexical
  // sometimes reports (e.g. right after an insert).
  function caretPosition() {
    const selection = getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    let node = range.startContainer;
    let offset = range.startOffset;
    if (!acInput?.contains(node)) return null;
    if (node.nodeType !== Node.TEXT_NODE) {
      node = node.childNodes[offset - 1];
      while (node && node.nodeType !== Node.TEXT_NODE) node = node.lastChild;
      if (!node) return null;
      offset = node.textContent.length;
    }
    return { node, offset };
  }

  function currentWord() {
    const caret = caretPosition();
    if (!caret) return null;
    const before = caret.node.textContent.slice(0, caret.offset);
    const match = before.match(/(\S+)$/);
    if (!match) return null;
    return { ...caret, start: caret.offset - match[1].length, word: match[1] };
  }

  // Exact-case prefix first, then any-case prefix, then contains. Within each,
  // emotes you use most come first, the rest shortest first (emoteIndex order).
  function searchEmotes(query) {
    const lower = query.toLowerCase();
    const exact = [], prefix = [], contains = [];
    for (const emote of emoteIndex) {
      if (emote.name.startsWith(query)) exact.push(emote);
      else {
        const name = emote.name.toLowerCase();
        if (name.startsWith(lower)) prefix.push(emote);
        else if (name.includes(lower)) contains.push(emote);
      }
    }
    return [exact, prefix, contains].flatMap(tier => tier.sort(byUsage)).slice(0, AC_MAX_RESULTS);
  }

  function hideSuggestions() {
    acBar?.remove();
    acBar = null;
    acMatches = [];
    acSelected = -1;
  }

  function commitSuggestion(emote) {
    const word = currentWord();
    if (!word) return hideSuggestions();
    const range = document.createRange();
    range.setStart(word.node, word.start);
    range.setEnd(word.node, word.offset);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, `${emote.name} `);
    if (!emote.command) recordUsage(emote.name);
    hideSuggestions();
  }

  function renderSuggestions() {
    if (!acMatches.length) return hideSuggestions();
    if (!acBar) {
      acBar = el('div', 'ka-ac');
      acBar.setAttribute('role', 'listbox');
      // Keep focus (and the phone keyboard) in the editor while tapping.
      acBar.addEventListener('pointerdown', event => event.preventDefault());
      acBar.addEventListener('mousedown', event => event.preventDefault());
    }
    if (!placeSuggestions()) return hideSuggestions();
    acBar.replaceChildren(...acMatches.map((emote, index) => {
      const chip = el('button', 'ka-ac-chip');
      chip.type = 'button';
      chip.tabIndex = -1;
      chip.setAttribute('role', 'option');
      chip.setAttribute('aria-selected', String(index === acSelected));
      if (emote.command) {
        chip.classList.add('ka-ac-command');
        chip.title = emote.answer || '';
        chip.append(el('span', 'ka-ac-name', emote.name));
      } else {
        const img = el('img', 'ka-ac-image');
        img.src = emote.src;
        img.alt = '';
        img.style.aspectRatio = String(emote.ratio);
        chip.append(img, el('span', 'ka-ac-name', emote.name));
      }
      chip.dataset.index = String(index); // taps are handled in handleTap()
      return chip;
    }));
    acBar.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // Suggestions and the picker go into the chat column, between the messages
  // and the input footer, so they're laid out right above the message box.
  // Fixed positioning put them at the top of the screen on iOS while the
  // keyboard was open.
  function inputFooter() {
    const messageArea = document.querySelector(LIST_SELECTOR)?.parentElement;
    const input = chatInput();
    if (!messageArea || !input) return null;
    let footer = input;
    while (footer.parentElement && !footer.parentElement.contains(messageArea)) footer = footer.parentElement;
    return footer.parentElement ? footer : null;
  }

  function placeAboveInput(node) {
    const footer = inputFooter();
    if (!footer) return false;
    if (node.nextElementSibling !== footer) footer.before(node);
    return true;
  }

  function placeSuggestions() {
    return placeAboveInput(acBar);
  }

  // A "!word" (or another prefix) at the start of the message: the channel's
  // learned commands with that prefix, from the prefix alone.
  function commandSuggestions(word) {
    if (!commandsEnabled() || !COMMAND_PREFIXES.includes(word.word[0])) return null;
    if (!(acInput.textContent || '').trimStart().startsWith(word.word)) return null;
    const matches = searchCommands(word.word);
    return matches.length ? matches : null;
  }

  function updateSuggestions() {
    const word = !picker && !messagesPanel ? currentWord() : null;
    const commandMatches = word && commandSuggestions(word);
    if (commandMatches) {
      acMatches = commandMatches;
      acSelected = -1;
      renderSuggestions();
      return;
    }
    const query = sevenTvEnabled() && emoteIndex.length ? word?.word.replace(/^:/, '') : null;
    if (!query || query.length < AC_MIN_CHARS) return hideSuggestions();
    acMatches = searchEmotes(query);
    acSelected = -1;
    renderSuggestions();
  }

  function onInputKeydown(event) {
    if (!acBar) return;
    if (event.key === 'Tab') {
      event.preventDefault();
      commitSuggestion(acMatches[Math.max(acSelected, 0)]);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      acSelected = (acSelected + step + acMatches.length) % acMatches.length;
      renderSuggestions();
    } else if (event.key === 'Enter') {
      // Only take Enter when a suggestion was picked with the arrows; otherwise
      // let the message send (Kick then clears the editor without an input event).
      if (acSelected >= 0) {
        event.preventDefault();
        event.stopPropagation();
        commitSuggestion(acMatches[acSelected]);
      } else {
        hideSuggestions();
      }
    } else if (event.key === 'Escape') {
      hideSuggestions();
    }
  }

  // The editor is re-created on channel switches; keep attached to the current one.
  function syncAutocomplete() {
    const input = chatInput();
    if (input === acInput) return;
    hideSuggestions();
    acInput = input;
    if (!input) return;
    // Lexical applies typing itself, so the DOM 'input' event often never fires;
    // its update listener runs after every change. Keep the DOM events as fallback.
    input.__lexicalEditor?.registerUpdateListener?.(() => {
      if (input === acInput) updateSuggestions();
    });
    input.addEventListener('input', updateSuggestions);
    input.addEventListener('keyup', event => {
      // Lexical handles deletions itself, so 'input' doesn't always fire for them.
      if (event.key === 'Backspace' || event.key === 'Delete') updateSuggestions();
    });
    input.addEventListener('keydown', onInputKeydown, true);
    input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
  }

  // ---- 7TV picker (button next to Kick's emote button) -----------------------

  // A channel can have ~1000 emotes: build buttons in batches as the grid is
  // scrolled, and only load images about to come into view.
  const PICKER_BATCH = 120;

  let picker = null;
  let pickerButton = null;
  let pickerQueue = [];        // emotes/titles not rendered yet
  let pickerImages = null;     // IntersectionObserver: set img src when near view
  let pickerMore = null;       // IntersectionObserver: render next batch at the end

  function flash(node) {
    node.classList.add('ka-flash');
    setTimeout(() => node.classList.remove('ka-flash'), 250);
  }

  function pickerEmoteButton(emote) {
    const button = el('button', 'ka-picker-emote');
    button.type = 'button';
    button.title = emote.name;
    button.dataset.name = emote.name; // taps are handled in handleTap()
    const img = el('img');
    img.dataset.src = emote.src;
    img.alt = emote.name;
    img.style.aspectRatio = String(emote.ratio); // size known before the image loads
    button.append(img);
    pickerImages.observe(img);
    return button;
  }

  function appendPickerBatch() {
    const grid = picker.querySelector('.ka-picker-grid');
    grid.querySelector('.ka-picker-sentinel')?.remove();
    let section = grid.lastElementChild?.classList.contains('ka-picker-section') ? grid.lastElementChild : null;
    for (let count = 0; count < PICKER_BATCH && pickerQueue.length;) {
      const item = pickerQueue.shift();
      if (item.title) {
        grid.append(el('div', 'ka-picker-title', item.title));
        section = el('div', 'ka-picker-section');
        grid.append(section);
      } else {
        section.append(pickerEmoteButton(item));
        count++;
      }
    }
    if (pickerQueue.length) {
      const sentinel = el('div', 'ka-picker-sentinel');
      grid.append(sentinel);
      pickerMore.observe(sentinel);
    }
  }

  function renderPickerGrid() {
    const grid = picker.querySelector('.ka-picker-grid');
    const query = picker.querySelector('.ka-picker-search').value.trim().replace(/^:/, '');
    const sections = [];
    usage = readUsage(); // pick up emotes used in other tabs
    if (query) {
      const lower = query.toLowerCase();
      sections.push([t('picker.results'), emoteIndex.filter(emote => emote.name.toLowerCase().includes(lower)).sort(byUsage)]);
    } else {
      const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      const all = [...emotes.values()];
      sections.push([t('picker.recent'), recentEmotes()]);
      sections.push([t('picker.channel'), all.filter(emote => emote.scope === 'channel').sort(byName)]);
      sections.push([t('picker.global'), all.filter(emote => emote.scope === 'global').sort(byName)]);
    }

    pickerImages?.disconnect();
    pickerMore?.disconnect();
    pickerImages = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.src = entry.target.dataset.src;
        pickerImages.unobserve(entry.target);
      }
    }, { root: grid, rootMargin: '150px 0px' });
    pickerMore = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) appendPickerBatch();
    }, { root: grid, rootMargin: '300px 0px' });

    pickerQueue = [];
    for (const [title, list] of sections) {
      if (list.length) pickerQueue.push({ title: `${title} · ${list.length}` }, ...list);
    }
    grid.replaceChildren();
    grid.scrollTop = 0;
    if (pickerQueue.length) appendPickerBatch();
    else grid.append(el('div', 'ka-picker-empty', query ? t('picker.noMatch') : t('picker.none')));
  }

  function openPicker() {
    closeMessages();
    hideSuggestions();
    if (!picker) {
      picker = el('div', 'ka-picker');
      const head = el('div', 'ka-picker-head');
      const search = el('input', 'ka-picker-search');
      search.type = 'search';
      search.placeholder = t('picker.search');
      search.autocomplete = 'off';
      search.spellcheck = false;
      search.addEventListener('input', renderPickerGrid);
      const close = el('button', 'ka-picker-close', '✕');
      close.type = 'button';
      close.setAttribute('aria-label', t('picker.close'));
      head.append(search, close);
      picker.append(head, el('div', 'ka-picker-grid'));
    }
    if (!placeAboveInput(picker)) return;
    renderPickerGrid();
    pickerButton?.setAttribute('aria-pressed', 'true');
  }

  function closePicker() {
    pickerImages?.disconnect();
    pickerMore?.disconnect();
    pickerQueue = [];
    picker?.remove();
    picker = null;
    pickerButton?.setAttribute('aria-pressed', 'false');
  }

  function togglePicker() {
    if (picker?.isConnected) closePicker();
    else openPicker();
  }

  // ---- Toolbar (7TV + saved messages buttons) ----------------------------------
  // Our buttons go into Kick's toolbar row under the message box (where channel
  // points and Kicks sit), in a group of their own, keeping the input row free.

  let toolbar = null;

  function kickToolbar() {
    // The row holding Kick's settings button; its right part is "ml-auto".
    const settings = inputFooter()?.querySelector('button svg[data-ds-icon="Settings"]')?.closest('button');
    const rightGroup = settings?.closest('.ml-auto');
    return rightGroup?.parentElement ? { row: rightGroup.parentElement, rightGroup } : null;
  }

  function toolbarButton(className, label, text) {
    const button = el('button', `ka-toolbar-button ${className}`, text);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', 'false');
    // Don't take focus from the editor (keeps the phone keyboard as it is).
    button.addEventListener('mousedown', event => event.preventDefault());
    return button;
  }

  function syncToolbar() {
    const want7tv = sevenTvEnabled() && emotes.size > 0;
    const wantMessages = messagesEnabled();
    if (!sevenTvEnabled()) closePicker();
    if (!wantMessages) closeMessages();

    const kick = kickToolbar();
    // Fallback if Kick's toolbar row isn't recognised: next to its emote button.
    const smile = !kick && inputFooter()?.querySelector('button svg[data-ds-icon="Smile"]')?.closest('button');
    const anchor = kick?.rightGroup || smile;
    if (!anchor || !(want7tv || wantMessages)) {
      clearProxies();
      toolbar?.remove();
      setInputHidden(false, { remember: false });
      return;
    }
    if (!toolbar) {
      toolbar = el('div', 'ka-toolbar');
      pickerButton = toolbarButton('ka-7tv-button', t('toolbar.emotes'), '7TV');
      messagesButton = toolbarButton('ka-messages-button', t('toolbar.messages'), '📋');
      const collapse = toolbarButton('ka-collapse-button', t('toolbar.hideInput'), '⌄');
      toolbar.append(pickerButton, messagesButton, collapse);
    }
    pickerButton.hidden = !want7tv;
    messagesButton.hidden = !wantMessages;
    toolbar.classList.toggle('ka-toolbar--inline', !kick);
    if (toolbar.nextElementSibling !== anchor) anchor.before(toolbar);
    if (kick) syncProxies();
    else clearProxies();
    if (picker && !picker.isConnected) placeAboveInput(picker);
    if (messagesPanel && !messagesPanel.isConnected) placeAboveInput(messagesPanel);
    if (revealBar && !revealBar.isConnected) placeAboveInput(revealBar);
  }

  // ---- Kick's input-row buttons, shown in our toolbar --------------------------
  // The identity badge and emote picker buttons live inside the message box.
  // Moving Kick's own (React-rendered) buttons would break them, so the toolbar
  // gets look-alike proxies that press the originals. The originals stay where
  // they are, invisible (kickoff.css), so Kick's popups still have an anchor.

  const proxies = new Map();          // Kick button -> our proxy
  const proxyTargets = new WeakMap(); // our proxy -> Kick button

  // Kick's buttons in the message box row, in order (identity badge, emote picker).
  function kickInputButtons() {
    const input = chatInput();
    const smile = inputFooter()?.querySelector('button svg[data-ds-icon="Smile"]')?.closest('button');
    const row = smile?.parentElement;
    if (!input || !row?.contains(input)) return [];
    return [...row.children]
      .filter(child => !child.contains(input) && !child.classList.contains('ka-toolbar'))
      .map(child => (child.matches('button') ? child : child.querySelector('button')))
      .filter(Boolean);
  }

  function clearProxies() {
    proxies.forEach(proxy => proxy.remove());
    proxies.clear();
  }

  function syncProxies() {
    const originals = kickInputButtons();
    for (const [original, proxy] of proxies) {
      if (!originals.includes(original)) {
        proxy.remove();
        proxies.delete(original);
      }
    }
    const nodes = originals.map(original => {
      let proxy = proxies.get(original);
      if (!proxy) {
        proxy = toolbarButton('ka-proxy', original.getAttribute('aria-label') || '', '');
        proxies.set(original, proxy);
        proxyTargets.set(proxy, original);
      }
      // Which icon the iOS-style row draws for it (kickoff.css).
      const kind = original.querySelector('[data-testid^="identity-badge"]') ? 'identity'
        : original.querySelector('svg[data-ds-icon="Smile"]') ? 'emotes' : '';
      if ((proxy.dataset.kind || '') !== kind) {
        if (kind) proxy.dataset.kind = kind;
        else delete proxy.dataset.kind;
      }
      // Same icon as Kick's button (the badge can change), copied when it changes.
      const look = original.innerHTML;
      if (proxy.dataset.look !== look) {
        proxy.replaceChildren(...[...original.childNodes].map(node => node.cloneNode(true)));
        proxy.dataset.look = look;
      }
      return proxy;
    });
    if (nodes.some((node, index) => toolbar.children[index] !== node)) toolbar.prepend(...nodes);
  }

  // Popover triggers open on pointerdown (menus) or on click; try the first and
  // fall back to a click if nothing opened.
  function pressKickButton(button) {
    const open = () => button.getAttribute('data-state') === 'open' || button.getAttribute('aria-expanded') === 'true';
    const before = open();
    const options = { bubbles: true, cancelable: true, view: window, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    button.dispatchEvent(new PointerEvent('pointerdown', options));
    button.dispatchEvent(new PointerEvent('pointerup', options));
    if (open() === before) button.click();
  }

  // ---- Hide the message box (read-only mode) -----------------------------------

  const INPUT_HIDDEN_ATTR = 'data-ka-input-hidden';
  const INPUT_HIDDEN_KEY = 'kickoff:inputHidden';

  let revealBar = null;

  function setInputHidden(hidden, { remember = true } = {}) {
    document.documentElement.toggleAttribute(INPUT_HIDDEN_ATTR, hidden);
    if (remember) {
      try {
        if (hidden) localStorage.setItem(INPUT_HIDDEN_KEY, '1');
        else localStorage.removeItem(INPUT_HIDDEN_KEY);
      } catch (err) { /* not remembered */ }
    }
    if (hidden) {
      closePicker();
      closeMessages();
      hideSuggestions();
      if (!revealBar) {
        revealBar = el('button', 'ka-reveal', t('toolbar.showInput'));
        revealBar.type = 'button';
        revealBar.addEventListener('mousedown', event => event.preventDefault());
      }
      placeAboveInput(revealBar);
    } else {
      revealBar?.remove();
      revealBar = null;
    }
  }

  function rememberedInputHidden() {
    try {
      return localStorage.getItem(INPUT_HIDDEN_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  // ---- Saved messages ------------------------------------------------------------
  // Stored by content.js (extension storage); we get the list via postMessage.
  // Each: { id, text, channel (slug, or null for all channels), created, used }.

  const PAGE_SOURCE = 'kickoff:page';
  const EXT_SOURCE = 'kickoff:ext';
  const MESSAGE_LIMIT = 500; // Kick's maximum message length
  const UNDO_MS = 5000;

  let savedMessages = [];
  let messagesPanel = null;
  let messagesButton = null;
  let messagesEditMode = false;
  let messageDraft = null;  // { id, text, channel, created } while the editor is open
  let undoItem = null;      // the last deleted message, while "Undo" is offered
  let undoTimer = null;

  function sendToExtension(type, data = {}) {
    window.postMessage({ source: PAGE_SOURCE, type, ...data }, location.origin);
  }

  // Saves resolve once the stored list comes back containing them.
  const pendingSaves = new Map(); // id -> resolve(boolean)
  const SAVE_TIMEOUT_MS = 3000;

  window.addEventListener('message', event => {
    // The origin, not event.source: Safari's content script posts from its own
    // window object, so `event.source === window` would reject it.
    if (event.origin !== location.origin || event.data?.source !== EXT_SOURCE) return;
    if (event.data.type === 'messages' && Array.isArray(event.data.items)) {
      savedMessages = event.data.items;
      for (const [id, resolve] of pendingSaves) {
        if (savedMessages.some(item => item.id === id)) {
          pendingSaves.delete(id);
          resolve(true);
        }
      }
      if (messagesPanel?.isConnected && !messageDraft) renderMessages();
    } else if (event.data.type === 'usage' && event.data.usage && typeof event.data.usage === 'object') {
      usage = mergeUsage(readUsage(), event.data.usage);
      writeUsage();
    } else if (event.data.type === 'commands' && event.data.commands && typeof event.data.commands === 'object') {
      commands = mergeCommands(readCommands(), event.data.commands);
      writeCommands();
    } else if (event.data.type === 'jump' && typeof event.data.id === 'string') {
      guarded('jump', () => jumpTo(event.data.id, event.data.requestId));
    } else if (event.data.type === 'search') {
      const { results, total, since } = searchHistory(event.data.query);
      sendToExtension('search:results', { requestId: event.data.requestId, results, total, since });
    }
  });

  // Resolves true when stored, false if the extension didn't confirm in time.
  function saveMessage(item) {
    return new Promise(resolve => {
      pendingSaves.set(item.id, resolve);
      sendToExtension('messages:save', { item });
      setTimeout(() => {
        if (pendingSaves.delete(item.id)) resolve(false);
      }, SAVE_TIMEOUT_MS);
    });
  }
  sendToExtension('messages:get');
  sendToExtension('usage:set', { usage: readUsage() }); // content.js answers with the merged list
  sendToExtension('commands:set', { commands: readCommands() }); // same

  function newId() {
    return crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  // What shows in chat: Kick emote tokens as their names.
  function plainText(content) {
    return content.replace(EMOTE_TOKEN, (match, id, name) => name);
  }

  // Kick sends one line; newlines become spaces.
  function asOneLine(text) {
    return text.replace(/\s*\n\s*/g, ' ').trim();
  }

  function insertSavedMessage(id, node) {
    const item = savedMessages.find(message => message.id === id);
    if (!item || !insertAtEnd(asOneLine(item.text))) return;
    sendToExtension('messages:used', { id });
    flash(node);
  }

  // Newest-used first, then newest saved.
  function sortMessages(list) {
    return [...list].sort((a, b) => (b.used || 0) - (a.used || 0) || b.created - a.created);
  }

  function messageRow(item) {
    const row = el('div', 'ka-msg-row');
    const insert = el('button', 'ka-msg-insert');
    insert.type = 'button';
    insert.dataset.id = item.id; // taps are handled in handleTap()
    const text = el('span', 'ka-msg-text');
    text.append(renderContent(item.text));
    insert.append(text);
    row.append(insert);

    if (messagesEditMode) {
      const edit = el('button', 'ka-msg-action', '✎');
      edit.type = 'button';
      edit.setAttribute('aria-label', t('messages.editOne'));
      edit.addEventListener('click', () => openEditor(item));
      const remove = el('button', 'ka-msg-action ka-msg-delete', '✕');
      remove.type = 'button';
      remove.setAttribute('aria-label', t('messages.deleteOne'));
      remove.addEventListener('click', () => deleteMessage(item));
      row.append(edit, remove);
    }
    return row;
  }

  function renderMessages() {
    if (!messagesPanel) return;
    const body = messagesPanel.querySelector('.ka-msg-body');
    const editToggle = messagesPanel.querySelector('.ka-msg-edit-toggle');
    const search = messagesPanel.querySelector('.ka-msg-search');
    editToggle.textContent = messagesEditMode ? t('messages.done') : t('messages.edit');
    editToggle.setAttribute('aria-pressed', String(messagesEditMode));

    if (messageDraft) {
      search.hidden = true;
      body.replaceChildren(buildEditor());
      body.querySelector('.ka-msg-input').focus();
      return;
    }
    search.hidden = false;

    const slug = channelSlug();
    const query = search.value.trim().toLowerCase();
    const visible = savedMessages.filter(item => (!item.channel || item.channel === slug)
      && (!query || plainText(item.text).toLowerCase().includes(query)));
    const nodes = [];

    if (undoItem) {
      const undo = el('div', 'ka-msg-undo');
      const button = el('button', 'ka-msg-undo-button', t('messages.undo'));
      button.type = 'button';
      button.addEventListener('click', () => {
        saveMessage(undoItem);
        clearUndo();
      });
      undo.append(el('span', null, t('messages.deleted')), button);
      nodes.push(undo);
    }
    if (messagesEditMode) {
      const add = el('button', 'ka-msg-new', t('messages.new'));
      add.type = 'button';
      add.addEventListener('click', () => openEditor(null));
      nodes.push(add);
    }

    const sections = [
      [slug ? t('messages.thisChannelNamed', { channel: slug }) : t('messages.thisChannel'), visible.filter(item => item.channel)],
      [t('messages.allChannels'), visible.filter(item => !item.channel)]
    ];
    for (const [title, list] of sections) {
      if (!list.length) continue;
      nodes.push(el('div', 'ka-picker-title', `${title} · ${list.length}`));
      nodes.push(...sortMessages(list).map(messageRow));
    }
    if (!visible.length && !undoItem) {
      nodes.push(el('div', 'ka-picker-empty', query
        ? t('messages.noMatch')
        : t('messages.empty')));
    }
    body.replaceChildren(...nodes);
  }

  function buildEditor() {
    const draft = messageDraft;
    const form = el('div', 'ka-msg-editor');
    const input = el('textarea', 'ka-msg-input');
    input.rows = 4;
    input.value = draft.text;
    input.placeholder = t('messages.placeholder');
    const counter = el('div', 'ka-msg-counter');
    const updateCounter = () => {
      const length = asOneLine(input.value).length;
      counter.textContent = `${length}/${MESSAGE_LIMIT}`;
      counter.classList.toggle('ka-msg-counter--over', length > MESSAGE_LIMIT);
      save.disabled = !input.value.trim();
    };
    input.addEventListener('input', () => {
      draft.text = input.value;
      updateCounter();
    });

    const scope = el('div', 'ka-msg-scope');
    const slug = channelSlug();
    const options = slug
      ? [[slug, t('messages.thisChannelOption', { channel: slug })], [null, t('messages.allChannels')]]
      : [[null, t('messages.allChannels')]];
    if (!slug && draft.channel === undefined) draft.channel = null;
    for (const [value, label] of options) {
      const option = el('button', 'ka-msg-scope-option', label);
      option.type = 'button';
      option.setAttribute('aria-pressed', String(draft.channel === value));
      option.addEventListener('click', () => {
        draft.channel = value;
        scope.querySelectorAll('.ka-msg-scope-option').forEach(node => node.setAttribute('aria-pressed', String(node === option)));
      });
      scope.append(option);
    }

    const actions = el('div', 'ka-msg-editor-actions');
    const cancel = el('button', 'ka-card-button', t('messages.cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      messageDraft = null;
      renderMessages();
    });
    const save = el('button', 'ka-card-button ka-card-button--primary', t('messages.save'));
    save.type = 'button';
    const status = el('div', 'ka-msg-status');
    save.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) return;
      save.disabled = true;
      save.textContent = t('card.saving');
      status.textContent = '';
      const saved = await saveMessage({ ...draft, text });
      if (messageDraft !== draft) return; // editor closed meanwhile
      if (saved) {
        messageDraft = null;
        renderMessages();
      } else {
        save.disabled = false;
        save.textContent = t('messages.save');
        status.textContent = t('messages.saveFailed');
      }
    });
    actions.append(cancel, save);

    form.append(input, counter, scope, status, actions);
    updateCounter();
    return form;
  }

  function openEditor(item) {
    messageDraft = item
      ? { ...item }
      : { id: newId(), text: '', channel: channelSlug(), created: Date.now(), used: 0 };
    renderMessages();
  }

  function clearUndo() {
    clearTimeout(undoTimer);
    undoItem = null;
    undoTimer = null;
    renderMessages();
  }

  function deleteMessage(item) {
    sendToExtension('messages:delete', { id: item.id });
    clearTimeout(undoTimer);
    undoItem = item;
    undoTimer = setTimeout(clearUndo, UNDO_MS);
    savedMessages = savedMessages.filter(message => message.id !== item.id);
    renderMessages();
  }

  function openMessages() {
    closePicker();
    hideSuggestions();
    if (!messagesPanel) {
      messagesPanel = el('div', 'ka-picker ka-messages');
      const head = el('div', 'ka-picker-head');
      const search = el('input', 'ka-picker-search ka-msg-search');
      search.type = 'search';
      search.placeholder = t('messages.search');
      search.autocomplete = 'off';
      search.addEventListener('input', renderMessages);
      const editToggle = el('button', 'ka-msg-edit-toggle', t('messages.edit'));
      editToggle.type = 'button';
      editToggle.addEventListener('click', () => {
        messagesEditMode = !messagesEditMode;
        messageDraft = null;
        renderMessages();
      });
      const close = el('button', 'ka-picker-close', '✕');
      close.type = 'button';
      close.setAttribute('aria-label', t('messages.close'));
      close.addEventListener('click', closeMessages);
      head.append(search, editToggle, close);
      messagesPanel.append(head, el('div', 'ka-picker-grid ka-msg-body'));
    }
    if (!placeAboveInput(messagesPanel)) return;
    renderMessages();
    messagesButton?.setAttribute('aria-pressed', 'true');
  }

  function closeMessages() {
    messagesPanel?.remove();
    messagesPanel = null;
    messagesEditMode = false;
    messageDraft = null;
    messagesButton?.setAttribute('aria-pressed', 'false');
  }

  function toggleMessages() {
    if (messagesPanel?.isConnected) closeMessages();
    else openMessages();
  }

  // ---- Save a message from chat --------------------------------------------------

  // The chat message whose text was tapped, if the tap was on plain message text.
  function messageTextAt(target) {
    if (!target.closest?.(LIST_SELECTOR)) return null;
    if (getSelection()?.toString()) return null; // selecting text (desktop), not tapping
    if (target.closest('a, button, img, [data-emote-id], .ka-previews, .ka-deleted-tag, .ka-repeat')) return null;
    const textArea = target.closest('span[data-ka-7tv], [data-ka-restored], span[aria-hidden="true"] + span');
    const row = textArea?.closest(ROW_SELECTOR);
    const message = row && readMessage(row);
    return message?.content ? { row, message } : null;
  }

  function openMessageCard(row, message) {
    const slug = channelSlug();
    const preview = el('div', 'ka-card-message');
    preview.append(renderContent(message.content));

    const actions = el('div', 'ka-card-actions ka-card-actions--wrap');
    const saveButton = (label, channel) => {
      const button = el('button', 'ka-card-button', label);
      button.type = 'button';
      button.addEventListener('click', async () => {
        actions.querySelectorAll('button').forEach(node => { node.disabled = true; });
        button.textContent = t('card.saving');
        const saved = await saveMessage({ id: newId(), text: message.content, channel, created: Date.now(), used: 0 });
        if (saved) {
          button.textContent = t('card.saved');
          setTimeout(closeCard, 900);
        } else {
          button.textContent = t('card.notSaved');
          actions.querySelectorAll('button').forEach(node => { node.disabled = false; });
        }
      });
      return button;
    };
    if (messagesEnabled()) {
      if (slug) actions.append(saveButton(t('card.saveHere'), slug));
      actions.append(saveButton(t('card.saveEverywhere'), null));
    }
    const copy = el('button', 'ka-card-button', t('card.copy'));
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      copy.textContent = (await copyText(plainText(message.content))) ? t('card.copied') : t('card.copyFailed');
    });
    actions.append(copy);

    const username = message.sender?.username;
    const self = selfUsername(row);
    if (muteEnabled() && username && username.toLowerCase() !== self?.toLowerCase()) {
      const mute = el('button', 'ka-card-button ka-card-button--mute', t('card.mute', { name: username }));
      mute.type = 'button';
      mute.addEventListener('click', () => {
        sendToExtension('mute:add', { username });
        mute.disabled = true;
        mute.textContent = t('card.muted');
        setTimeout(closeCard, 700);
      });
      actions.append(mute);
    }

    const head = el('div', 'ka-card-meta', username ? t('card.messageFrom', { name: username }) : t('card.messageFromChat'));
    showCard(row.querySelector('span[aria-hidden="true"] + span, [data-ka-7tv], [data-ka-restored]') || row, t('card.saveMessage'), [head, preview, actions]);
  }


  // ---- Highlights (mentions of you, chosen words, the streamer) -------------------
  // Whole words, any case, Unicode-aware (Polish letters count as letters).

  const wordLists = new Map(); // html attribute -> { raw, patterns }
  const mentionPatterns = new Map(); // username -> RegExp

  function wordPattern(word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
  }

  // Patterns for a JSON word list in an html attribute (cached until it changes).
  function wordPatterns(attr) {
    const raw = document.documentElement.getAttribute(attr) || '[]';
    if (wordLists.get(attr)?.raw !== raw) {
      let words = [];
      try {
        words = JSON.parse(raw);
      } catch (err) { /* none */ }
      wordLists.set(attr, {
        raw,
        patterns: (Array.isArray(words) ? words : []).map(word => String(word).trim()).filter(Boolean).map(wordPattern)
      });
    }
    return wordLists.get(attr).patterns;
  }

  // The channel owner: same slug as the channel, or Kick's broadcaster badge.
  function fromStreamer(message) {
    const sender = message.sender;
    if (!sender) return false;
    const slug = channelSlug();
    return Boolean(slug && (sender.slug || sender.username || '').toLowerCase() === slug)
      || (sender.identity?.badges || []).some(badge => badge?.type === 'broadcaster');
  }

  // Kick passes the logged-in username to each chat row's component.
  function selfUsername(row) {
    let fiber = rowFiber(row);
    for (let depth = 0; fiber && depth < 4; depth++, fiber = fiber.child) {
      const name = fiber.memoizedProps?.selfUsername;
      if (typeof name === 'string' && name) return name;
    }
    return null;
  }

  // Mentions of you win; then the streamer; then users you highlight; then your
  // words (unless the message also has a word to hide). Only mentions and words go
  // to the inbox.
  function highlightKind(row, message) {
    const text = plainText(message.content);
    const self = selfUsername(row);
    const fromSelf = self && message.sender?.username?.toLowerCase() === self.toLowerCase();
    if (highlightsEnabled() && self && !fromSelf) {
      if (!mentionPatterns.has(self)) mentionPatterns.set(self, wordPattern(self));
      if (mentionPatterns.get(self).test(text)) return 'mention';
    }
    if (streamerEnabled() && fromStreamer(message)) return 'streamer';
    if (highlightsEnabled() && isHighlightedUser(message.sender?.username)) return 'user';
    if (highlightsEnabled() && !fromSelf && !hasHiddenWord(message)
      && wordPatterns(HIGHLIGHT_WORDS_ATTR).some(pattern => pattern.test(text))) return 'keyword';
    return null;
  }

  // Highlighted messages go to the mentions inbox (content.js keeps them). Each
  // message once; a spam run of the same text counts once.
  const INBOX_REPEAT_MS = 2 * 60 * 1000;
  const reported = new Set();
  let lastReported = { key: '', at: 0 };

  function reportMention(message, kind) {
    if (reported.has(message.id)) return;
    reported.add(message.id);
    if (reported.size > HISTORY_LIMIT) reported.delete(reported.values().next().value);
    const channel = channelSlug();
    const at = Date.parse(message.created_at) || Date.now();
    const key = repeatKey(message.content);
    if (!channel || (key === lastReported.key && Math.abs(at - lastReported.at) < INBOX_REPEAT_MS)) return;
    lastReported = { key, at };
    sendToExtension('inbox:add', {
      item: { id: message.id, channel, username: message.sender?.username || '?', content: message.content, kind, at }
    });
  }

  function applyHighlight(row, message) {
    const kind = row.hasAttribute('data-ka-muted') ? null : highlightKind(row, message);
    if (kind === 'mention' || kind === 'keyword') reportMention(message, kind);
    if ((row.dataset.kaHighlight || null) === kind) return;
    if (kind) row.dataset.kaHighlight = kind;
    else delete row.dataset.kaHighlight;
  }

  // ---- Mute list ---------------------------------------------------------------
  // Muted users (all channels, any case) come from content.js in an html
  // attribute. Their messages collapse to one line; tapping it shows the message.
  // Known chat bots (BOT_NAMES) collapse the same way when that switch is on.

  const nameLists = new Map(); // html attribute -> { raw, names: Set of lower-case names }
  const revealed = new Set(); // message ids shown anyway
  const REVEALED_LIMIT = 300;

  // A JSON username list from content.js in an html attribute (cached until it changes).
  function inNameList(attr, username) {
    const raw = document.documentElement.getAttribute(attr) || '[]';
    if (nameLists.get(attr)?.raw !== raw) {
      let names = [];
      try {
        names = JSON.parse(raw);
      } catch (err) { /* none */ }
      nameLists.set(attr, { raw, names: new Set((Array.isArray(names) ? names : []).map(name => String(name).toLowerCase())) });
    }
    return Boolean(username) && nameLists.get(attr).names.has(username.toLowerCase());
  }

  const isMuted = username => inNameList(MUTED_USERS_ATTR, username);
  const isHighlightedUser = username => inNameList(HIGHLIGHT_USERS_ATTR, username);

  const isBot = username => Boolean(username) && (BOT_NAMES.has(username.toLowerCase()) || inNameList(BOT_USERS_ATTR, username));

  // 'muted', 'bot' or null: why this user's messages are collapsed.
  function collapsedUser(username) {
    if (muteEnabled() && isMuted(username)) return 'muted';
    if (botsEnabled() && isBot(username)) return 'bot';
    return null;
  }

  function clearMute(row) {
    row.querySelectorAll(':scope > .ka-muted-line').forEach(node => node.remove());
    row.removeAttribute('data-ka-muted');
    row.removeAttribute('data-ka-revealed');
  }

  function toggleRevealed(id) {
    if (!id) return;
    if (revealed.has(id)) revealed.delete(id);
    else {
      revealed.add(id);
      if (revealed.size > REVEALED_LIMIT) revealed.delete(revealed.values().next().value);
    }
    schedule();
  }

  // Returns true while the row is collapsed.
  function applyMute(row, message) {
    const username = message.sender?.username;
    const reason = collapsedUser(username);
    if (!reason) {
      if (row.hasAttribute('data-ka-muted')) {
        clearMute(row);
        remeasure(row);
      }
      return false;
    }
    const shown = revealed.has(message.id);
    let line = row.querySelector(':scope > .ka-muted-line');
    if (!line) {
      // A span, so Kick-row rules written for divs don't apply to it.
      line = el('span', 'ka-muted-line');
      row.prepend(line);
    }
    line.dataset.id = message.id;
    const label = t(`${reason}.${shown ? 'lineShown' : 'line'}`, { name: username });
    if (line.textContent !== label) line.textContent = label;
    const changed = !row.hasAttribute('data-ka-muted') || row.hasAttribute('data-ka-revealed') !== shown;
    row.setAttribute('data-ka-muted', '');
    row.toggleAttribute('data-ka-revealed', shown);
    if (changed) remeasure(row);
    return !shown;
  }

  // ---- Repeated messages -----------------------------------------------------------
  // A run of consecutive identical messages (from anyone) shows only its newest
  // copy, with ×N; the earlier copies are hidden (zero-height rows, which the
  // virtualizer handles fine). "Identical" ignores case, spacing and the invisible
  // characters people add to get past Kick's duplicate-message check. Rows in the
  // list have consecutive data-index values, so runs are found from the DOM.

  const INVISIBLE_CHARS = /[\u{E0000}-\u{E007F}\u034F\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2060-\u2064\u3164\uFEFF\uFFA0]/gu;

  function repeatKey(content) {
    return plainText(content).replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // ---- Replies ----------------------------------------------------------------------
  // Kick's reply header component gets the original as props (originalMessageId,
  // originalContent, originalSenderUsername), so it's found through React, not by
  // its text. Kick's own tap opens a thread panel, which never fires on iOS (taps
  // on chat rows don't become clicks); we jump to the original instead.

  function replyHeaderAt(target) {
    if (!target.closest?.(LIST_SELECTOR)) return null;
    const row = target.closest(ROW_SELECTOR);
    for (let node = target; node && node !== row; node = node.parentElement) {
      let fiber = rowFiber(node);
      for (let depth = 0; fiber && depth < 3; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (typeof props?.originalMessageId === 'string') {
          return {
            element: node,
            original: {
              id: props.originalMessageId,
              content: typeof props.originalContent === 'string' ? props.originalContent : '',
              username: typeof props.originalSenderUsername === 'string' ? props.originalSenderUsername : ''
            }
          };
        }
      }
    }
    return null;
  }

  function openReplyOriginal(element, original) {
    closeCard();
    const virtualizer = chatVirtualizer();
    if (virtualizer && itemIndex(virtualizer, original.id) >= 0) {
      scrollToMessage(original.id).then(row => {
        if (row) flashRow(row);
      }).catch(err => {
        lastError = `reply: ${err?.message || err}`;
      });
      return;
    }
    const content = original.content || history.get(original.id)?.content || '';
    const preview = el('div', 'ka-card-message');
    if (content) preview.append(renderContent(content));
    else preview.textContent = t('reply.deleted');
    showCard(element, t('reply.original'), [
      el('div', 'ka-card-meta', t('reply.gone', { name: original.username || t('reply.original') })),
      preview
    ]);
  }

  // ---- Hidden messages (emote-only, words to hide) -------------------------------------
  // With the setting on, messages made only of emotes (Kick's, and 7TV's while 7TV
  // emotes are on) are hidden like the earlier copies of a repeat; so are messages
  // with a word to hide. Your own messages and mentions of you stay.

  const emoteOnlyEnabled = () => document.documentElement.hasAttribute(EMOTE_ONLY_ATTR);

  function isEmoteOnly(content) {
    if (!content) return false;
    const words = content.replace(EMOTE_TOKEN, ' ').replace(INVISIBLE_CHARS, '').split(/\s+/).filter(Boolean);
    if (!words.length) return content.includes('[emote:');
    return sevenTvEnabled() && emotes.size > 0 && words.every(word => emotes.has(word));
  }

  function hasHiddenWord(message) {
    const patterns = wordPatterns(HIDE_WORDS_ATTR);
    if (!patterns.length || !message.content) return false;
    const text = plainText(message.content);
    return patterns.some(pattern => pattern.test(text));
  }

  function applyHidden(row, message) {
    const self = selfUsername(row);
    const kind = row.dataset.kaHighlight;
    const hide = !row.hasAttribute('data-ka-muted')
      && kind !== 'mention'
      && !(self && message.sender?.username?.toLowerCase() === self.toLowerCase())
      && ((emoteOnlyEnabled() && !kind && isEmoteOnly(message.content)) || hasHiddenWord(message));
    if (row.hasAttribute('data-ka-hidden-row') === hide) return;
    row.toggleAttribute('data-ka-hidden-row', hide);
    remeasure(row);
  }

  function clearRepeat(row) {
    row.querySelectorAll('.ka-repeat').forEach(node => node.remove());
    row.removeAttribute('data-ka-dup');
  }

  function setRepeat(row, hidden, count) {
    let changed = row.hasAttribute('data-ka-dup') !== hidden;
    row.toggleAttribute('data-ka-dup', hidden);
    let badge = row.querySelector('.ka-repeat');
    if (count > 1) {
      if (!badge) {
        const anchor = row.querySelector('[data-ka-restored], [data-ka-7tv]') || row.querySelector('span[aria-hidden="true"] + span');
        if (!anchor) {
          if (changed) remeasure(row);
          return;
        }
        badge = el('span', 'ka-repeat');
        badge.setAttribute('role', 'button');
        anchor.after(badge);
        changed = true;
      }
      const label = `×${count}`;
      if (badge.textContent !== label) badge.textContent = label;
    } else if (badge) {
      badge.remove();
      changed = true;
    }
    if (changed) remeasure(row);
  }

  // Every pass looks at every row here, so keep each message's key.
  const repeatKeys = new WeakMap(); // Kick's message object -> repeatKey

  function messageRepeatKey(message) {
    let key = repeatKeys.get(message);
    if (key === undefined) {
      key = repeatKey(message.content);
      repeatKeys.set(message, key);
    }
    return key;
  }

  function collapseRepeats() {
    const enabled = repeatsEnabled();
    const entries = [...list.querySelectorAll(ROW_SELECTOR)].map(row => {
      const message = enabled && !row.hasAttribute('data-ka-muted') ? readMessage(row) : null;
      return { row, index: Number(row.dataset.index), key: message?.content ? messageRepeatKey(message) : '' };
    }).sort((a, b) => a.index - b.index);

    // Rows hidden by Kickoff (emote-only, words to hide, Kick events) don't split a
    // run; a row that isn't drawn does (segment: a stretch of consecutive indexes).
    const shown = [];
    let segment = 0;
    entries.forEach((entry, i) => {
      if (i > 0 && entry.index !== entries[i - 1].index + 1) segment++;
      entry.segment = segment;
      if (entry.row.hasAttribute('data-ka-hidden-row')) guarded('repeats', () => setRepeat(entry.row, false, 1));
      else shown.push(entry);
    });

    const sameAsNext = (entry, next) => Boolean(entry.key) && next?.key === entry.key && next.segment === entry.segment;
    let count = 0;
    shown.forEach((entry, i) => {
      count = i > 0 && sameAsNext(shown[i - 1], entry) ? count + 1 : 1;
      const hidden = sameAsNext(entry, shown[i + 1]);
      guarded('repeats', () => setRepeat(entry.row, hidden, hidden ? 1 : count));
    });
  }

  // Who sent the copies of a run (the badge's row and the hidden rows before it).
  function openRepeatCard(badge) {
    const row = badge.closest(ROW_SELECTOR);
    if (!row) return;
    const senders = new Map();
    let message = null;
    for (let node = row, index = Number(row.dataset.index); node; ) {
      const data = node.hasAttribute('data-ka-hidden-row') ? null : readMessage(node);
      if (data) {
        message ||= data;
        const name = data.sender?.username || '?';
        senders.set(name, (senders.get(name) || 0) + 1);
      }
      index--;
      node = list?.querySelector(`${ROW_SELECTOR}[data-index="${index}"]`);
      if (node && !node.hasAttribute('data-ka-dup') && !node.hasAttribute('data-ka-hidden-row')) node = null;
    }
    const total = [...senders.values()].reduce((sum, n) => sum + n, 0);
    const preview = el('div', 'ka-card-message');
    if (message) preview.append(renderContent(message.content));
    const who = [...senders].sort((a, b) => b[1] - a[1]).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
    showCard(badge, t('repeat.title'), [
      el('div', 'ka-card-meta', t('repeat.sent', { count: total })),
      preview,
      el('div', 'ka-card-meta ka-repeat-senders', t('repeat.by', { who }))
    ]);
  }

  // ---- Kick events (point rewards, subs, gifts) ---------------------------------------
  // Kick draws these as big cards. With the setting on 'compact' they become one
  // line the height of a message (tap it to see Kick's card); on 'hide' the row
  // is hidden like an emote-only message. Read from the store entry: types
  // "rewards", "subscriptions" (subscribed / gifted), "kicks_gift", and messages of
  // type "celebration" (a resub with its message).

  function eventKind(entry) {
    if (entry.type === 'rewards') return 'reward';
    if (entry.type === 'subscriptions' || entry.type === 'kicks_gift') return 'sub';
    if (entry.type === 'message' && entry.data?.type === 'celebration') return 'sub';
    return null;
  }

  function eventMode(kind) {
    return document.documentElement.getAttribute(kind === 'reward' ? REWARD_EVENTS_ATTR : SUB_EVENTS_ATTR) || 'full';
  }

  // What the compact line says, and its colour (the reward's own, else the user's).
  function eventSummary(entry) {
    const data = entry.data || {};
    const withText = (text, extra) => (extra && extra.trim() ? `${text}: ${asOneLine(plainText(extra))}` : text);
    if (entry.type === 'rewards') {
      return {
        text: withText(t('event.reward', { name: data.username || '?', reward: data.reward_title || '' }), data.user_input),
        color: data.reward_background_color
      };
    }
    if (entry.type === 'kicks_gift') {
      return {
        text: withText(t('event.kicks', { name: data.sender?.username || '?', gift: data.gift?.name || '', count: Number(data.gift?.amount) || 0 }), data.message),
        color: data.sender?.identity?.color
      };
    }
    if (entry.type === 'message') {
      const months = Number(data.metadata?.celebration?.total_months) || 0;
      return {
        text: withText(t(months > 1 ? 'event.resub' : 'event.sub', { name: data.sender?.username || '?', count: months }), data.content),
        color: data.sender?.identity?.color
      };
    }
    if (data.action === 'gifted') {
      const count = Number(data.gifted_total) || data.gifted_usernames?.length || 0;
      return { text: t('event.gifted', { name: data.username || '?', count }), color: null };
    }
    const months = Number(data.months) || 0;
    return { text: withText(t(months > 1 ? 'event.resub' : 'event.sub', { name: data.username || '?', count: months }), data.custom_message), color: null };
  }

  // data-ka-event is 'compact' or 'hide' (then the row also has data-ka-hidden-row,
  // which applyHidden may set for other reasons, so it's only removed if ours).
  function clearEvent(row) {
    row.querySelectorAll(':scope > .ka-event-line').forEach(node => node.remove());
    if (row.getAttribute('data-ka-event') === 'hide') row.removeAttribute('data-ka-hidden-row');
    row.removeAttribute('data-ka-event');
    row.removeAttribute('data-ka-event-open');
  }

  // Returns true while Kick's card is out of sight (compact and closed, or hidden).
  function applyEvent(row, entry, kind) {
    const mode = eventMode(kind);
    if (mode !== 'compact' && mode !== 'hide') {
      if (row.hasAttribute('data-ka-event')) {
        clearEvent(row);
        remeasure(row);
      }
      return false;
    }
    const compact = mode === 'compact';
    const open = compact && revealed.has(entry.id);
    let changed = row.getAttribute('data-ka-event') !== mode
      || row.hasAttribute('data-ka-hidden-row') === compact
      || row.hasAttribute('data-ka-event-open') !== open;
    let line = row.querySelector(':scope > .ka-event-line');
    if (compact) {
      if (!line) {
        line = el('span', 'ka-event-line');
        line.setAttribute('role', 'button');
        line.append(el('span', 'ka-event-icon', kind === 'reward' ? '★' : '✦'), el('span', 'ka-event-text'));
        row.prepend(line);
        changed = true;
      }
      line.dataset.id = entry.id;
      const { text, color } = eventSummary(entry);
      const label = line.querySelector('.ka-event-text');
      if (label.textContent !== text) label.textContent = text;
      line.title = text;
      if (color) line.style.setProperty('--ka-event-color', color);
      else line.style.removeProperty('--ka-event-color');
    } else if (line) {
      line.remove();
    }
    row.setAttribute('data-ka-event', mode);
    row.toggleAttribute('data-ka-hidden-row', !compact);
    row.toggleAttribute('data-ka-event-open', open);
    if (changed) remeasure(row);
    return !open;
  }

  // ---- Readable name colours ---------------------------------------------------
  // Kick sets each name's colour inline; some (dark blue, purple) are hard to read
  // on the dark chat. Those get a lighter shade of the same hue in --ka-name-color,
  // which kickoff.css applies; Kick's inline colour is left alone.

  const MIN_NAME_LUMINANCE = 0.2; // about 4.5:1 contrast on Kick's near-black chat
  const nameColors = new Map(); // Kick's colour -> lighter colour, or '' when fine

  function luminance([r, g, b]) {
    const channel = value => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function hslToRgb([h, s, l]) {
    if (!s) return [l, l, l].map(v => Math.round(v * 255));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = t => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map(v => Math.round(v * 255));
  }

  function readableColor(color) {
    if (nameColors.has(color)) return nameColors.get(color);
    const rgb = color.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number);
    let fixed = '';
    if (rgb?.length === 3 && luminance(rgb) < MIN_NAME_LUMINANCE) {
      const [h, s, l] = rgbToHsl(rgb);
      let lighter = rgb;
      for (let step = l; step <= 1 && luminance(lighter) < MIN_NAME_LUMINANCE; step += 0.04) {
        lighter = hslToRgb([h, s, Math.min(step, 1)]);
      }
      fixed = `rgb(${lighter.join(', ')})`;
    }
    nameColors.set(color, fixed);
    return fixed;
  }

  // ✎ after the names of people you wrote a note about (kickoff.css draws it).
  function applyNoted(row, message) {
    const name = nameButton(row);
    if (!name) return;
    const noted = inNameList(NOTED_USERS_ATTR, message.sender?.username);
    if (name.hasAttribute('data-ka-noted') !== noted) name.toggleAttribute('data-ka-noted', noted);
  }

  function applyNameColor(row) {
    const name = nameButton(row);
    if (!name) return;
    const fixed = readableNamesEnabled() ? readableColor(name.style.color) : '';
    if ((name.style.getPropertyValue('--ka-name-color') || '') === fixed) return;
    if (fixed) name.style.setProperty('--ka-name-color', fixed);
    else name.style.removeProperty('--ka-name-color');
  }

  // ---- Alternating backgrounds ---------------------------------------------------
  // Each shown row gets the other shade from the shown row above it. Shades are kept
  // per message, so they don't all flip when Kick drops the oldest rows; rows hidden
  // by Kickoff (repeats, hidden words, emote-only) are skipped.

  const shades = new Map(); // message id -> 0 | 1

  function stripeRows() {
    const enabled = stripesEnabled();
    const rows = [...list.querySelectorAll(ROW_SELECTOR)].sort((a, b) => a.dataset.index - b.dataset.index);
    let previous = null; // shade of the last shown row, null after a gap
    let drawn = NaN;     // index of the last drawn row
    for (const row of rows) {
      const id = row.dataset.kaId;
      const index = Number(row.dataset.index);
      // A gap in the drawn rows: start again from what's known.
      if (index !== drawn + 1) previous = null;
      drawn = index;
      const hidden = row.hasAttribute('data-ka-hidden-row') || row.hasAttribute('data-ka-dup');
      if (!enabled || !id || hidden) {
        row.removeAttribute('data-ka-alt');
        continue;
      }
      const shade = previous != null ? 1 - previous : shades.get(id) ?? Math.abs(index) % 2;
      if (shades.get(id) !== shade) {
        shades.set(id, shade);
        if (shades.size > HISTORY_LIMIT) shades.delete(shades.keys().next().value);
      }
      row.toggleAttribute('data-ka-alt', shade === 1);
      previous = shade;
    }
  }

  // ---- Kick's user card ------------------------------------------------------------
  // Tapping a name opens Kick's card, added to <body> and removed on close: a popup
  // (#user-identity) on wide screens, a bottom sheet (a Vaul drawer dialog) on
  // phones. Both hold a link to the user's channel with their name as its title.
  // Below Kick's own buttons we add: @ mention, highlight and mute toggles, and that
  // user's messages from this visit (tap one to jump to it). content.js adds your
  // note about them above that.

  const USER_CARD_SELECTOR = '#user-identity, [role="dialog"][data-vaul-drawer]';
  const USER_NAME_LINK = 'a[title][href^="https://kick.com/"]';
  const USER_CARD_ATTR = 'data-ka-user-card';
  const userCardEnabled = () => document.documentElement.hasAttribute(USER_CARD_ATTR);
  const USER_HISTORY_LIMIT = 50;
  let userCardObserver = null;

  // The open card: the one with a name link, else one still loading (no link yet).
  function findUserCard() {
    const cards = [...document.querySelectorAll(USER_CARD_SELECTOR)];
    return cards.find(card => card.querySelector(USER_NAME_LINK)) || cards.find(card => card.id === 'user-identity') || null;
  }

  function userCardName(card) {
    return card.querySelector(USER_NAME_LINK)?.title || null;
  }

  // Kick opens its card from a name's click handler, which takes the name from the
  // message's sender when clicked. For an @mentioned name: call the handler of the
  // mention's own row (so the popup sits by it) with the sender's name swapped for
  // that moment, put back before anything else runs. Any other row will do too.
  function openUserCardFor(username, row) {
    for (const candidate of [row, ...(list?.querySelectorAll(ROW_SELECTOR) || [])]) {
      const button = candidate && nameButton(candidate);
      const propsKey = button && Object.keys(button).find(key => key.startsWith('__reactProps'));
      const onClick = propsKey && button[propsKey]?.onClick;
      let fiber = button && rowFiber(button);
      for (let depth = 0; fiber && !fiber.memoizedProps?.sender && depth < 6; depth++) fiber = fiber.return;
      const sender = fiber?.memoizedProps?.sender;
      if (typeof onClick !== 'function' || typeof sender?.username !== 'string') continue;
      const own = sender.username;
      sender.username = username;
      try {
        onClick({ stopPropagation() {}, preventDefault() {}, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false });
      } finally {
        sender.username = own;
      }
      return true;
    }
    return false;
  }

  // The popup has a close button; the bottom sheet closes on Escape.
  function closeUserCard() {
    const close = findUserCard()?.querySelector('svg[data-ds-icon="Cross"]')?.closest('button');
    if (close) close.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }

  function timeAgo(at) {
    const minutes = Math.floor((Date.now() - at) / 60000);
    if (minutes < 1) return t('ago.now');
    if (minutes < 60) return t('ago.minutes', { n: minutes });
    return t('ago.hours', { n: Math.floor(minutes / 60) });
  }

  function userHistory(username) {
    const slug = channelSlug();
    const lower = username.toLowerCase();
    return [...history.values()]
      .filter(entry => entry.channel === slug && entry.username.toLowerCase() === lower)
      .sort((a, b) => b.at - a.at)
      .slice(0, USER_HISTORY_LIMIT);
  }

  function userCardButton(label, onClick, extra = '') {
    const button = el('button', `ka-card-button ${extra}`.trim(), label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function buildUserTools(username) {
    const tools = el('div', 'ka-user-tools');
    tools.dataset.user = username;
    tools.setAttribute('data-vaul-no-drag', ''); // scrolling the list mustn't pull the sheet down
    const self = selfUsername(list?.querySelector(ROW_SELECTOR));
    const isSelf = Boolean(self) && self.toLowerCase() === username.toLowerCase();

    const actions = el('div', 'ka-card-actions ka-card-actions--wrap');
    if (!isSelf) {
      actions.append(userCardButton(t('user.mention'), () => {
        insertAtEnd(`@${username}`);
        closeUserCard();
      }));
      if (highlightsEnabled()) {
        const on = isHighlightedUser(username);
        actions.append(userCardButton(t(on ? 'user.unhighlight' : 'user.highlight'), () => {
          sendToExtension(on ? 'highlight:remove' : 'highlight:add', { username });
        }, on ? 'ka-card-button--on' : ''));
      }
      if (muteEnabled()) {
        const on = isMuted(username);
        actions.append(userCardButton(t(on ? 'user.unmute' : 'user.mute'), () => {
          sendToExtension(on ? 'mute:remove' : 'mute:add', { username });
        }, on ? 'ka-card-button--on' : 'ka-card-button--mute'));
      }
      // Your list of chat bots: their answers teach !commands, and they collapse with the bots.
      if (commandsEnabled() || botsEnabled()) {
        const on = inNameList(BOT_USERS_ATTR, username);
        actions.append(userCardButton(t(on ? 'user.unbot' : 'user.bot'), () => {
          sendToExtension(on ? 'bot:remove' : 'bot:add', { username });
        }, on ? 'ka-card-button--on' : ''));
      }
    }

    const messages = userHistory(username);
    const head = el('div', 'ka-card-meta', messages.length
      ? t('user.messages', { count: messages.length })
      : t('user.noMessages'));
    const items = el('div', 'ka-user-history');
    for (const entry of messages) {
      const item = el('button', 'ka-user-message');
      item.type = 'button';
      item.append(el('span', 'ka-user-message-time', timeAgo(entry.at)), renderContent(entry.content));
      item.addEventListener('click', () => {
        closeUserCard();
        scrollToMessage(entry.id).then(row => row && flashRow(row)).catch(() => {});
      });
      items.append(item);
    }
    tools.append(...(actions.childElementCount ? [actions] : []), head, items);
    return tools;
  }

  // Adds (or redraws) our part of the card; also after Kick re-renders the card.
  function syncUserCard(redraw = false) {
    const card = findUserCard();
    if (!card) {
      userCardObserver?.disconnect();
      userCardObserver = null;
      return;
    }
    if (userCardObserver?.card !== card) {
      userCardObserver?.disconnect();
      userCardObserver = new MutationObserver(() => guarded('user card', () => syncUserCard()));
      userCardObserver.card = card;
      userCardObserver.observe(card, { childList: true, subtree: true });
    }
    const current = card.querySelector('.ka-user-tools');
    if (!userCardEnabled()) {
      current?.remove();
      return;
    }
    const username = userCardName(card);
    if (!username) return;
    if (current && current.dataset.user === username && !redraw) return;
    const box = card.querySelector(USER_NAME_LINK).parentElement?.parentElement || card;
    const tools = buildUserTools(username);
    if (current) current.replaceWith(tools);
    else box.append(tools);
  }

  // The card is a direct child of <body>, so watching only <body>'s children is cheap.
  new MutationObserver(() => guarded('user card', () => syncUserCard()))
    .observe(document.body, { childList: true });

  // ---- Row processing --------------------------------------------------------

  function clearRow(row) {
    clearRestore(row);
    clearPreviews(row);
    clear7tv(row);
    clearMute(row);
    clearRepeat(row);
    clearCosmetics(row);
    clearGhosts(row);
    clearEvent(row);
    row.removeAttribute('data-ka-hidden-row');
  }

  // Every pass does every drawn row. Skipping rows whose React props looked unchanged
  // missed deletions (tried in 6.1: the row's fiber can be the stale copy), so don't.
  let rowsWaiting = false; // a pass was skipped while the page was hidden

  function processRow(row) {
    const entry = readEntry(row);
    const kind = entry && eventKind(entry);
    const message = readMessage(row);
    const id = message?.id || (kind ? entry.id : null);
    if (!id) return;

    // Rows are recycled while scrolling: drop anything added for a previous message.
    if (row.dataset.kaId !== id) {
      clearRow(row);
      row.dataset.kaId = id;
    }
    // A resub with a message is a message too, but nothing else applies while
    // it's a line or hidden.
    if (kind && (applyEvent(row, entry, kind) || !message)) return;

    remember(message);
    const deleted = Boolean(findDeletedLabel(row, message));
    if (deleted) clear7tv(row); // the 7TV copy would hide the deletion
    const content = restoreEnabled() ? restoreDeleted(row, message) : message.content;
    if (!deleted) apply7tv(row); // 7TV emotes and @mentions
    const collapsed = applyMute(row, message);
    if (previewsEnabled() && !collapsed) addPreviews(row, message.id, content);
    applyHighlight(row, message);
    applyHidden(row, message);
    applyCosmetics(row, message);
    applyNameColor(row);
    applyNoted(row, message);
    applyGhosts(row, message);
  }

  function processAll() {
    scheduled = false;
    if (!list) return;
    guarded('history', harvest); // also while hidden: keeps text for restore and search
    // Nobody sees the rows of a hidden page: do them all when it's shown again.
    if (document.hidden) {
      rowsWaiting = true;
      return;
    }
    // One broken row must not stop the rest.
    list.querySelectorAll(ROW_SELECTOR).forEach(row => guarded('message', () => processRow(row)));
    guarded('repeats', collapseRepeats);
    guarded('stripes', stripeRows);
  }

  // Batch bursts of chat mutations. Not requestAnimationFrame: it pauses while the
  // page is hidden, and the deleted messages' text must still be harvested.
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(processAll, BATCH_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !rowsWaiting) return;
    rowsWaiting = false;
    schedule();
  });

  // Our own nodes inside rows. Changes to them (ours, or a link preview arriving)
  // don't need another pass.
  const OWN_NODE = '[data-ka-restored], [data-ka-previews], [data-ka-7tv], .ka-ghosts, .ka-muted-line, .ka-event-line, .ka-repeat, .ka-7tv-badge';

  // Only inside the list: settings put the same attributes on <html> (data-ka-7tv).
  function isOwnNode(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const own = element?.closest(OWN_NODE);
    return Boolean(own && list?.contains(own) && own !== list);
  }

  const isRow = node => node.nodeType === Node.ELEMENT_NODE && node.matches(ROW_SELECTOR);

  // A pass only when Kick changed something. New rows get it right away: observer
  // callbacks run before the browser paints, so a new copy of a repeat (or a
  // hidden row) never shows for a frame. Waiting for the batch made emote spam
  // jump: each new copy drew in full, then the one before it disappeared.
  function onListMutations(records) {
    const kick = records.some(record => !isOwnNode(record.target)
      && !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(isOwnNode)));
    if (!kick) return;
    if (!document.hidden && records.some(record => [...record.addedNodes].some(isRow))) processAll();
    else schedule();
  }

  let lastCopyMode = '';

  // Settings changed: drop what was switched off and re-measure every row, since
  // heights change (also when the text size changes).
  function onSettingsChange() {
    // Our copies of message text are redrawn when what they show changes.
    const copyMode = [sevenTvEnabled(), mentionsEnabled(), readableNamesEnabled()].join();
    const redrawCopies = copyMode !== lastCopyMode;
    lastCopyMode = copyMode;
    document.querySelectorAll('[data-ka-id]').forEach(row => {
      if (!restoreEnabled()) clearRestore(row);
      if (!previewsEnabled()) clearPreviews(row);
      if (redrawCopies) clear7tv(row);
      if (!highlightsEnabled() && !streamerEnabled()) delete row.dataset.kaHighlight;
      if (!muteEnabled() && !botsEnabled()) clearMute(row);
      remeasure(row);
    });
    if (!sevenTvEnabled()) {
      closeCard();
      hideSuggestions();
    }
    syncToolbar();
    if (sevenTvEnabled()) syncEmotes();
    guarded('user card', () => syncUserCard(true)); // mute / highlight labels
    schedule();
  }

  // Kick is an SPA: the chat list is replaced on channel switches.
  function syncList() {
    const current = document.querySelector(LIST_SELECTOR);
    if (current === list) return;
    if (listObserver) listObserver.disconnect();
    list = current;
    listObserver = null;
    if (!list) return;
    listObserver = new MutationObserver(onListMutations);
    listObserver.observe(list, { childList: true, subtree: true, characterData: true });
    if (sevenTvEnabled()) syncEmotes(); // may be a different channel now
    schedule();
  }

  new MutationObserver(onSettingsChange).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [RESTORE_ATTR, PREVIEWS_ATTR, SEVENTV_ATTR, MESSAGES_ATTR, HIGHLIGHT_ATTR, HIGHLIGHT_WORDS_ATTR, STREAMER_ATTR, HIDE_WORDS_ATTR, MUTE_ATTR, MUTED_USERS_ATTR, HIGHLIGHT_USERS_ATTR, NOTED_USERS_ATTR, BOT_USERS_ATTR, USER_CARD_ATTR, BOTS_ATTR, READABLE_NAMES_ATTR, MENTIONS_ATTR, STRIPES_ATTR, REPEATS_ATTR, FONT_SIZE_ATTR, CHAT_FONT_ATTR, COSMETICS_ATTR, EMOTE_ONLY_ATTR, REWARD_EVENTS_ATTR, SUB_EVENTS_ATTR, COMMANDS_ATTR]
  });

  // ---- Catching up after the page slept ----------------------------------------
  // iOS freezes a background tab. When it wakes, Kick reconnects but doesn't load
  // what was said meanwhile (its history load runs once per page); when iOS reloads
  // the tab instead, Kick starts again from its last ~25 messages. Either way we
  // know the newest message seen before (kept per channel in localStorage, so it
  // survives a reload), read Kick's history forward from it, and rebuild Kick's list
  // in time order with its own reset + hydrateFromHistory. A notice offers a jump
  // to the first missed message, then a way back to the newest; × closes it.
  // History: web.kick.com/api/v1/chat/{channel id}/history?start_time=ISO returns
  // every message of the 5-second window (aligned to :00, :05 …) holding that time.
  // (Its `cursor` skips ahead; not used. Without start_time: the newest ~25.)

  const SEEN_KEY = 'kickoff:lastSeen';
  const CATCHUP_GAP_MS = 15 * 1000;        // timers stopped this long = the page slept
  const CATCHUP_MAX_AGE_MS = 60 * 60 * 1000; // longer away: Kick's fresh list is enough
  const CATCHUP_WINDOW_MS = 5000;          // one request = 5 seconds of chat
  const CATCHUP_MAX_SPAN_MS = 10 * 60 * 1000; // at most the last 10 minutes (120 requests)
  const CATCHUP_PARALLEL = 6;
  const CATCHUP_SETTLE_MS = 2500;          // let Kick reconnect / load its history first
  const CATCHUP_LIST_LIMIT = 300;          // Kick keeps about this many
  const CATCHUP_NOTICE_MS = 20 * 1000;

  let seen = readSeen(channelSlug()); // { channel, id, at } of the newest message seen
  let savedSeenAt = seen?.at || 0;
  let lastTickAt = Date.now();
  let catchingUp = false;
  let catchupNotice = null;
  let catchupNoticeTimer = 0;

  function readSeen(channel) {
    try {
      const all = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
      const item = channel && all[channel];
      return item && Date.now() - item.at < CATCHUP_MAX_AGE_MS ? { channel, ...item } : null;
    } catch (err) {
      return null;
    }
  }

  function saveSeen() {
    if (!seen || seen.at === savedSeenAt) return;
    savedSeenAt = seen.at;
    try {
      const all = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
      all[seen.channel] = { id: seen.id, at: seen.at };
      for (const [channel, item] of Object.entries(all)) {
        if (!(Date.now() - item?.at < CATCHUP_MAX_AGE_MS)) delete all[channel];
      }
      localStorage.setItem(SEEN_KEY, JSON.stringify(all));
    } catch (err) { /* not kept */ }
  }

  // Called from harvest with Kick's list (oldest first).
  function noteSeen(messages) {
    const channel = channelSlug();
    for (let i = messages.length - 1; i >= 0; i--) {
      const data = messages[i]?.data;
      if (messages[i]?.type !== 'message' || !data?.id) continue;
      const at = Date.parse(data.created_at) || 0;
      if (seen?.channel !== channel || at > seen.at) seen = { channel, id: data.id, at };
      return;
    }
  }

  // A Kick store (Zustand) getState: a 0-arg function in a useMemo dependency list
  // above the chat, whose state passes `test`.
  function findStore(test) {
    let fiber = list && rowFiber(list);
    for (let depth = 0; fiber && depth < 80; depth++, fiber = fiber.return) {
      for (let hook = fiber.memoizedState, n = 0; hook && n < 80; hook = hook.next, n++) {
        const deps = Array.isArray(hook.memoizedState) && Array.isArray(hook.memoizedState[1]) ? hook.memoizedState[1] : null;
        for (const candidate of deps || []) {
          if (typeof candidate !== 'function' || candidate.length > 0) continue;
          try {
            if (test(candidate())) return candidate;
          } catch (err) { /* not it */ }
        }
      }
    }
    return null;
  }

  // The chat store: the message list, with hydrateFromHistory.
  function chatStore() {
    return findStore(state => typeof state?.hydrateFromHistory === 'function' && typeof state.reset === 'function' && Array.isArray(state.entries));
  }

  // Two ids: the history API wants the channel id (messages from history carry it
  // as chat_id), the store the chatroom id (live messages: chatroom_id; the store's
  // currentChatroomId is 0 in the popout). Kick's channel API has both.
  const channelIds = new Map(); // slug -> { channel, chatroom }

  async function chatIds(slug) {
    if (!channelIds.has(slug)) {
      const response = await fetch(`/api/v2/channels/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`channel ${response.status}`);
      const data = await response.json();
      if (!data?.id || !data.chatroom?.id) return null;
      channelIds.set(slug, { channel: data.id, chatroom: data.chatroom.id });
    }
    return channelIds.get(slug);
  }

  async function historyWindow(id, at) {
    const response = await fetch(`https://web.kick.com/api/v1/chat/${id}/history?start_time=${encodeURIComponent(new Date(at).toISOString())}`, {
      credentials: 'include',
      cache: 'no-cache',
      headers: { Accept: 'application/json', 'x-app-platform': 'web' }
    });
    if (!response.ok) throw new Error(`history ${response.status}`);
    const messages = (await response.json())?.data?.messages;
    return Array.isArray(messages) ? messages : [];
  }

  async function catchUp(from) {
    if (catchingUp || !from || from.channel !== channelSlug()) return;
    const getState = chatStore();
    if (!getState) return;
    catchingUp = true;
    try {
      const ids = await chatIds(from.channel);
      if (!ids) return;
      const now = Date.now();
      const begin = Math.max(from.at, now - CATCHUP_MAX_SPAN_MS);
      let complete = begin === from.at;
      const windows = [];
      for (let at = begin - begin % CATCHUP_WINDOW_MS; at < now; at += CATCHUP_WINDOW_MS) windows.push(at);
      const fetched = [];
      for (let i = 0; i < windows.length; i += CATCHUP_PARALLEL) {
        const batch = await Promise.all(windows.slice(i, i + CATCHUP_PARALLEL).map(at => historyWindow(ids.channel, at).catch(() => null)));
        if (batch.includes(null)) complete = false;
        const messages = batch.flat().filter(Boolean);
        fetched.push(...messages);
        // Reached what Kick already shows (arrived live after it reconnected).
        const shown = new Set(getState().entries.map(entry => entry?.data?.id));
        if (messages.length && messages.every(message => shown.has(message.id) || message.id === from.id)
          && messages.some(message => (Date.parse(message.created_at) || 0) > from.at)) break;
      }
      mergeMissed(getState, ids.chatroom, from, fetched, complete);
    } finally {
      catchingUp = false;
    }
  }

  function mergeMissed(getState, chatroomId, from, fetched, complete) {
    const state = getState();
    if (from.channel !== channelSlug()) return;
    const kept = state.entries.filter(entry => entry?.type === 'message' && entry.data?.id).map(entry => entry.data);
    const shown = new Set(kept.map(message => message.id));
    const missed = fetched.filter(message => message?.id && !shown.has(message.id)
      && message.id !== from.id && (Date.parse(message.created_at) || 0) >= from.at);
    if (!missed.length) return;
    // Time order; equal times keep Kick's order (missed ones after).
    const merged = [...kept, ...missed]
      .map((message, index) => ({ message, index, at: Date.parse(message.created_at) || 0 }))
      .sort((a, b) => a.at - b.at || a.index - b.index)
      .slice(-CATCHUP_LIST_LIMIT)
      .map(item => item.message);
    // reset only clears once the store has a chatroom id (the popout leaves it 0).
    if (!getState().currentChatroomId) getState().reset(chatroomId);
    getState().reset(chatroomId);
    getState().hydrateFromHistory(merged.slice().reverse()); // it expects newest first
    missed.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    showCatchupNotice(missed.length, missed[0].id, complete);
    schedule();
  }

  // A pill above the message box: its label (jump up, or back down) and ×.
  function setCatchupNotice(label, id) {
    if (!catchupNotice) {
      catchupNotice = el('div', 'ka-catchup');
      const main = el('button', 'ka-catchup-main');
      const close = el('button', 'ka-catchup-close', '×');
      main.type = close.type = 'button';
      close.setAttribute('aria-label', t('catchup.dismiss'));
      catchupNotice.append(main, close);
      catchupNotice.addEventListener('mousedown', event => event.preventDefault());
    }
    catchupNotice.dataset.id = id || '';
    catchupNotice.firstChild.textContent = label;
    placeAboveInput(catchupNotice);
  }

  function showCatchupNotice(count, firstId, complete) {
    closeCatchupNotice();
    setCatchupNotice(t('catchup.missed', { count }) + (complete ? '' : t('catchup.partial')), firstId);
    catchupNoticeTimer = setTimeout(closeCatchupNotice, CATCHUP_NOTICE_MS);
  }

  function closeCatchupNotice() {
    clearTimeout(catchupNoticeTimer);
    list?.removeEventListener('scroll', onCatchupScroll);
    catchupNotice?.remove();
    catchupNotice = null;
  }

  const AT_BOTTOM_PX = 40;
  const atBottom = () => Boolean(list) && list.scrollHeight - list.scrollTop - list.clientHeight < AT_BOTTOM_PX;

  // Back at the newest (scrolled there by hand): the way back isn't needed.
  function onCatchupScroll() {
    if (atBottom()) closeCatchupNotice();
  }

  // Jump up to the first missed message; the pill then offers the way back
  // down and stays until used, closed or the chat is scrolled to the bottom.
  async function openCatchupNotice(target) {
    if (target.closest('.ka-catchup-close')) return closeCatchupNotice();
    const id = catchupNotice?.dataset.id;
    if (!id) return scrollToNewest();
    clearTimeout(catchupNoticeTimer);
    setCatchupNotice(t('catchup.newest'), '');
    const row = await scrollToMessage(id).catch(() => null);
    if (row) flashRow(row);
    if (!catchupNotice) return;
    // After the jump has settled, so its own scrolling doesn't close the pill.
    if (atBottom()) closeCatchupNotice();
    else list?.addEventListener('scroll', onCatchupScroll, { passive: true });
  }

  // The virtualizer measures rows as they're drawn, so the end moves: a few passes.
  async function scrollToNewest() {
    closeCatchupNotice();
    for (let pass = 0; pass < JUMP_PASSES && list; pass++) {
      list.scrollTop = list.scrollHeight;
      await sleep(JUMP_PASS_MS);
      if (atBottom()) break;
    }
  }

  // From tick, before harvest: a long gap since the last tick means the page was
  // frozen (or just loaded with an earlier visit remembered).
  function checkCatchup() {
    const now = Date.now();
    const slept = now - lastTickAt > CATCHUP_GAP_MS;
    lastTickAt = now;
    if (slept && seen) {
      const from = { ...seen };
      setTimeout(() => catchUp(from).catch(err => { lastError = `catch-up: ${err?.message || err}`; }), CATCHUP_SETTLE_MS);
    }
  }

  // Page load: wait for Kick's own history, then fill the gap from the last visit.
  function catchupAfterLoad(from, tries = 0) {
    const state = chatStore()?.();
    if (!state?.hydratedFromHistory || !state.entries.length) {
      if (tries < 20) setTimeout(() => catchupAfterLoad(from, tries + 1), 1000);
      return;
    }
    catchUp(from).catch(err => { lastError = `catch-up: ${err?.message || err}`; });
  }

  if (seen) {
    const from = { ...seen };
    setTimeout(() => catchupAfterLoad(from), CATCHUP_SETTLE_MS);
  }

  window.addEventListener('pagehide', saveSeen);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveSeen();
  });

  // ---- Keeping the chat connected -----------------------------------------------
  // Kick's chat socket (Centrifugo, realtime.*.platform.kick.com) lives in a store
  // above the chat: { app, scope, handle, connectionState, failedApp, connect, … }.
  // When the server closes it as "not recoverable", Kick keeps that server as
  // failedApp and won't connect to it again, so the chat freezes ("Connection to
  // chat failed") until a reload. We remember the server and scope while connected
  // and, once it's been down a while, ask Kick to connect again (backing off), then
  // fill the gap from history like after sleep.

  const RECONNECT_AFTER_MS = 10 * 1000; // Kick often recovers by itself before this
  const RECONNECT_MAX_MS = 60 * 1000;

  let realtime = null;      // { app, scope, channel } of the last good connection
  let realtimeState = '';   // status line
  let downSince = 0;
  let downFrom = null;      // newest message seen when it went down
  let reconnectAt = 0;
  let reconnectDelay = RECONNECT_AFTER_MS;
  let reconnects = 0;

  function connectionStore() {
    return findStore(state => typeof state?.connect === 'function' && 'connectionState' in state && 'failedApp' in state);
  }

  // From tick.
  function keepConnected() {
    const getState = connectionStore();
    if (!getState) return;
    const state = getState();
    realtimeState = state.connectionState;
    if (state.connectionState === 'connected') {
      if (state.app && state.scope) realtime = { app: state.app, scope: state.scope, channel: channelSlug() };
      if (downSince && downFrom) {
        const from = downFrom;
        setTimeout(() => catchUp(from).catch(err => { lastError = `catch-up: ${err?.message || err}`; }), CATCHUP_SETTLE_MS);
      }
      downSince = 0;
      downFrom = null;
      reconnectDelay = RECONNECT_AFTER_MS;
      return;
    }
    // Kick leaving the chat also says "disconnected", but drops its handle.
    const down = state.connectionState === 'degraded' || (state.connectionState === 'disconnected' && state.handle);
    if (!down) return;
    const now = Date.now();
    if (!downSince) {
      downSince = now;
      downFrom = seen ? { ...seen } : null;
      reconnectAt = now + reconnectDelay;
      return;
    }
    const app = state.app || realtime?.app;
    const scope = state.scope || realtime?.scope;
    if (now < reconnectAt || !app || !scope || realtime?.channel !== channelSlug()) return;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    reconnectAt = now + reconnectDelay;
    reconnects++;
    state.connect(app, scope);
  }

  // ---- Bringing a crashed chat back ----------------------------------------------
  // The whole chat (list, banners, message box) sits in one react-error-boundary
  // (Kick's ChatExperience). When anything inside throws, it shows "We are sorry,
  // but something went wrong" in an otherwise empty sidebar, and stays so until a
  // reload: it has no reset keys. We keep the boundary found above the list and,
  // when it has caught, reset it (backing off if it keeps crashing), which mounts
  // the chat again; then fill the gap from history.

  const CRASH_RESET_MS = 2000;
  const CRASH_RESET_MAX_MS = 60 * 1000;
  const CRASH_CALM_MS = 60 * 1000;    // up this long: the next crash starts the backoff over

  let chatBoundary = null;
  let boundaryList = null;  // the list chatBoundary was found from
  let crashSeen = false;
  let crashFrom = null;
  let crashResetAt = 0;
  let crashResetDelay = CRASH_RESET_MS;
  let lastResetAt = 0;
  let crashes = 0;
  let crashMessage = '';

  // From tick, while the list is there.
  function findChatBoundary() {
    let fiber = rowFiber(list);
    for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
      const node = fiber.stateNode;
      if (typeof node?.resetErrorBoundary === 'function' && node.state && 'didCatch' in node.state) {
        chatBoundary = node;
        return;
      }
    }
  }

  function reviveChat() {
    if (list) {
      if (boundaryList !== list) {
        boundaryList = list;
        chatBoundary = null;
        findChatBoundary();
      }
      return;
    }
    if (!chatBoundary?.state?.didCatch) return;
    const now = Date.now();
    if (!crashSeen) {
      crashSeen = true;
      crashes++;
      crashMessage = String(chatBoundary.state.error?.message || chatBoundary.state.error || 'unknown').slice(0, 200);
      console.error('Kickoff: Kick\'s chat crashed:', chatBoundary.state.error);
      crashFrom = seen ? { ...seen } : null;
      if (now - lastResetAt > CRASH_CALM_MS) crashResetDelay = CRASH_RESET_MS;
      crashResetAt = now + crashResetDelay;
      return;
    }
    if (now < crashResetAt) return;
    crashSeen = false;
    lastResetAt = now;
    crashResetDelay = Math.min(crashResetDelay * 3, CRASH_RESET_MAX_MS);
    chatBoundary.resetErrorBoundary();
    if (crashFrom) {
      const from = crashFrom;
      setTimeout(() => catchupAfterLoad(from), CATCHUP_SETTLE_MS);
    }
    crashFrom = null;
  }

  // ---- Status (shown in the settings panel by content.js) -----------------------
  // A failing step must not stop the others, and the last error is reported in
  // html[data-ka-status] so problems are visible on the phone.

  let lastError = '';

  function guarded(name, step) {
    try {
      step();
    } catch (err) {
      lastError = `${name}: ${err?.message || err}`;
      console.error('Kickoff:', lastError, err);
    }
  }

  function publishStatus() {
    document.documentElement.dataset.kaStatus = JSON.stringify({
      rows: list ? list.querySelectorAll(ROW_SELECTOR).length : 0,
      readable: list ? [...list.querySelectorAll(ROW_SELECTOR)].filter(readMessage).length : 0,
      emotes: emotes.size,
      emoteCounts,
      emoteLoading: emoteLoadStarted ? Math.round((Date.now() - emoteLoadStarted) / 1000) : null,
      inputs: document.querySelectorAll('[data-testid="chat-input"]').length,
      editableInput: Boolean(chatInput()),
      footer: Boolean(inputFooter()),
      kickToolbar: Boolean(kickToolbar()),
      emoteButton: Boolean(inputFooter()?.querySelector('button svg[data-ds-icon="Smile"]')),
      ourToolbar: Boolean(toolbar?.isConnected),
      channel: channelSlug(),
      realtime: realtimeState,
      reconnects,
      crashes,
      crash: crashMessage,
      adsRemoved,
      error: [lastError, emoteError].filter(Boolean).join('\n')
    });
  }

  window.addEventListener('error', event => {
    if (String(event.filename || '').includes('page-hook')) lastError = event.message;
  });
  window.addEventListener('unhandledrejection', event => {
    if (String(event.reason?.stack || '').includes('page-hook')) lastError = `async: ${event.reason.message}`;
  });

  // Retry 7TV emotes that failed to load (they're otherwise only loaded when the
  // chat element changes).
  function retryEmotes() {
    if (!sevenTvEnabled() || emotes.size || !list || Date.now() < emotesRetryAt) return;
    emotesRetryAt = Date.now() + EMOTES_RETRY_MS;
    emotesSlug = null;
    syncEmotes();
  }

  function tick() {
    guarded('catch-up', checkCatchup);
    guarded('chat', syncList);
    guarded('crash', reviveChat);
    guarded('connection', keepConnected);
    guarded('history', harvest);
    guarded('bans', listenForBans);
    guarded('catch-up', saveSeen);
    if (document.hidden) return; // the rest only matters on screen
    guarded('7TV', retryEmotes);
    guarded('7TV cosmetics', () => {
      renderPaintStyles();
      flushCosmetics(); // e.g. chatters queued while the setting was off
    });
    guarded('autocomplete', syncAutocomplete);
    guarded('toolbar', syncToolbar);
    guarded('status', publishStatus);
  }

  tick();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
  if (rememberedInputHidden()) setTimeout(() => toolbar && setInputHidden(true, { remember: false }), 2000);
  setInterval(tick, LIST_POLL_MS);
})();
