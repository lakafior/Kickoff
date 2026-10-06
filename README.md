# Kickoff

**A better Kick.com chat in Safari** on Mac, iPhone and iPad.

Kickoff is a Safari extension that makes chat on [kick.com](https://kick.com) better: it
keeps your screen awake while you watch, shows messages moderators deleted, previews
links, adds 7TV emotes and gives the chat Apple's fonts. It works on stream pages
and on the chat-only popout.

Every feature can be switched on or off: tap the **rocket** at the top of the chat.

> Kickoff is an independent project and is not affiliated with or endorsed by Kick.

## Features

### Chat
- **Keep screen awake**: your Mac, iPhone or iPad won't dim or lock while you watch.
- **Deleted messages stay visible**, greyed out, instead of “Deleted by a moderator”,
  including messages of users who were timed out or banned.
- **Link previews** for images, YouTube, TikTok and X/Twitter links.
- **7TV emotes**, with name paints and badges, an emote picker, autocomplete and
  a card that opens when you tap an emote.
- **Mentions inbox (@)**: the messages that mention you or your chosen words, so you
  can catch up later and jump back to them.
- **Chat search**, including `from:name` to search one person's messages.
- **Highlights**: mentions of you, words you choose and the streamer stand out.
- **Saved messages**: keep phrases you type often and send them in one tap.
- **Tidier chat**: collapse muted users, repeated messages (shown once with ×N) and
  emote-only messages, or hide messages containing words you choose.
- **Fonts and size**: Kick's font or Apple's San Francisco, New York or SF Mono, plus
  adjustable text size.
- **Catch up after sleep**: messages missed while the page was asleep are filled in.
- **iOS-style message box** on iPhone and iPad.

### Player
- **Native player** on channel pages, played by Safari itself: smooth on iPhone,
  picture in picture, AirPlay, a “behind live” indicator and Mac keyboard shortcuts.
- **Keeps playing when locked** (audio only), with the stream on the lock screen.
- **Listen button** in the popout chat: audio only, with a sleep timer.
- **Compact channel info** under the player on channel pages.

### Kick
- **Ad & tracker blocking** on kick.com.

Kickoff speaks **English and Polish**, following your device's language.

## Where it works

| | Stream page | Popout chat |
|---|---|---|
| Mac (Safari) | ✓ | ✓ |
| iPhone (Safari) | ✓ | ✓ |
| iPad (Safari) | ✓ | ✓ |

## Getting started

Kickoff is coming to the App Store. Website: [kickoff.smigi.net](https://kickoff.smigi.net).

**iPhone & iPad**
1. Install Kickoff and open **Settings › Apps › Safari › Extensions** (on iOS 17:
   Settings › Safari › Extensions).
2. Tap **Kickoff**, turn it on and set **kick.com** to **Allow**.
3. Open a stream on kick.com and tap the **rocket** at the top of the chat.

**Mac**
1. Install Kickoff, open it and click **Open Safari Settings**, then turn on
   **Kickoff**.
2. On kick.com, click the Kickoff button in Safari's toolbar and choose
   **Always Allow on This Website**.
3. Click the **rocket** at the top of the chat.

## Privacy

Full policy: [kickoff.smigi.net/privacy](https://kickoff.smigi.net/privacy/).

Kickoff collects no data. There are no accounts, analytics or servers of its own.
Your settings, saved messages and mentions inbox stay in Safari's storage on your
device.

To do its job, the extension connects from your browser to:
- **Kick** (`kick.com`, `web.kick.com`, `files.kick.com`) for stream info, chat
  history and the video stream;
- **7TV** (`7tv.io`) for emotes, name paints and badges;
- **YouTube, TikTok and FxTwitter** (`api.fxtwitter.com`) for link previews;
- the site hosting an image someone links in chat, to show its preview.

It blocks requests to ad and tracking services on kick.com, such as Google ads and
analytics, Datadog and Mux.

## Building from source

Requirements: Xcode 26 or later.

```sh
git clone https://github.com/lakafior/Kickoff.git
open Kickoff.xcodeproj
```

- The extension lives in `Shared (Extension)/Resources/`: `manifest.json`,
  `background.js` (ad blocking, toolbar button), `content.js` (settings panel,
  player, wake lock), `page-hook.js` (chat features that need Kick's page data) and
  `kickoff.css`.
- `Shared (App)/` is the container app that explains how to turn the extension on.
- Run the **Kickoff (macOS)** scheme, then enable Kickoff in Safari ▸ Settings ▸
  Extensions. Local builds may need Safari ▸ Settings ▸ Developer ▸ **Allow unsigned
  extensions**.
- Run the **Kickoff (iOS)** scheme on a device or simulator, then enable it in
  Settings.

## License

[Mozilla Public License 2.0](LICENSE).

Rocket icon by its creator on the Noun Project, used under a royalty-free licence.
