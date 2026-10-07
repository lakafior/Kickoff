//
//  PlayerWindowController.swift
//  macOS (App)
//
//  The app's own player for a Kick channel, opened by kickoff://watch/{slug} (the
//  extension's Watch button in the Player tab, with ?quality=). AVPlayer with
//  LivePlaylistLoader: about as close to live as Kick's player. Chat stays in Safari.
//

import AVKit
import Cocoa
import os

final class PlayerWindowController: NSWindowController, NSWindowDelegate, NSMenuItemValidation {

    private static var open: [String: PlayerWindowController] = [:]
    private static weak var lastActive: PlayerWindowController?
    private static let log = Logger(subsystem: "net.smigi.Kickoff", category: "player")

    /// The Playback menu's window: the key one, else the last one in front (the key
    /// window can be AVKit's full screen or another app's), else any.
    static var current: PlayerWindowController? {
        (NSApp.keyWindow?.windowController as? PlayerWindowController) ?? lastActive ?? open.values.first
    }

    static var hasWindows: Bool { !open.isEmpty }

    static func show(slug: String, rendition: Rendition?) {
        let existing = open[slug]
        let controller = existing ?? PlayerWindowController(slug: slug, rendition: rendition)
        open[slug] = controller
        if let existing = existing, let rendition = rendition, rendition != existing.rendition {
            existing.rendition = rendition
            existing.restart()
        }
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private enum Key {
        static let rendition = "playerRendition"
        static let floats = "playerFloats"
        static let volume = "playerVolume"
    }

    private static let retryDelay: TimeInterval = 3
    private static let slowRetryDelay: TimeInterval = 30
    private static let quickRetries = 5
    private static let offlineRecheck: TimeInterval = 60
    // A start that landed a segment further back than usual (fixed quality: ~2–4 s
    // behind normally, sometimes ~7 s with 4 s segments) is reloaded once, which
    // re-rolls where it lands.
    private static let lateStartCheck: TimeInterval = 3
    private static let lateStartLimit: TimeInterval = 6
    // AVPlayer can't get closer to live once playing (no faster playback for these
    // streams; a seek forward stalls and lands further back), so after a stall left it
    // behind where it started, the stream is started again: more than catchUpMargin
    // behind for catchUpAfter, at most once per catchUpInterval. Only after a stall:
    // a pause or a seek back from the controls is the viewer's choice.
    private static let catchUpMargin: TimeInterval = 3
    private static let catchUpAfter: TimeInterval = 5
    private static let catchUpInterval: TimeInterval = 120

    let slug: String
    private let player = AVPlayer()
    private let playerView = AVPlayerView()
    private let message = NSTextField(labelWithString: "")
    private var loader: LivePlaylistLoader?
    private var channel: KickChannel?
    private var itemObservations: [NSKeyValueObservation] = []
    private var observations: [NSKeyValueObservation] = []
    private var notifications: [NSObjectProtocol] = []
    private var itemNotifications: [NSObjectProtocol] = []
    private var timer: Timer?
    private var retryWork: DispatchWorkItem?
    private var retries = 0
    private var checkStart = false   // the current item's first play is still to be checked
    private var lateStartRetried = false
    private var startDelay: TimeInterval?  // behind live once the start was checked
    private var behindSince: Date?
    private var stalled = false
    private var lastCatchUp: Date?

    private var rendition: Rendition {
        get { Rendition(stored: UserDefaults.standard.string(forKey: Key.rendition)) ?? .best }
        set { UserDefaults.standard.set(newValue.stored, forKey: Key.rendition) }
    }

    private init(slug: String, rendition: Rendition?) {
        self.slug = slug
        if let rendition = rendition {
            UserDefaults.standard.set(rendition.stored, forKey: Key.rendition)
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = slug
        window.backgroundColor = .black
        window.contentMinSize = NSSize(width: 320, height: 180)
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("KickoffPlayer")
        window.level = UserDefaults.standard.bool(forKey: Key.floats) ? .floating : .normal
        super.init(window: window)
        window.delegate = self

        playerView.player = player
        playerView.controlsStyle = .floating
        playerView.allowsPictureInPicturePlayback = true
        playerView.showsFullScreenToggleButton = true
        playerView.translatesAutoresizingMaskIntoConstraints = false

        message.textColor = .white
        message.font = .systemFont(ofSize: 15, weight: .medium)
        message.alignment = .center
        message.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.addSubview(playerView)
        content.addSubview(message)
        NSLayoutConstraint.activate([
            playerView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            playerView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            playerView.topAnchor.constraint(equalTo: content.topAnchor),
            playerView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            message.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            message.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            message.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -32)
        ])
        window.contentView = content

        if UserDefaults.standard.object(forKey: Key.volume) != nil {
            player.volume = UserDefaults.standard.float(forKey: Key.volume)
        }
        player.allowsExternalPlayback = true
        observations = [
            // AirPlay: the receiver loads the stream itself and can't go through our
            // loader, so it gets Kick's playlists as they are.
            player.observe(\.isExternalPlaybackActive, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.reload() }
            },
            player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
                DispatchQueue.main.async {
                    if player.timeControlStatus == .playing {
                        self?.retries = 0
                        self?.scheduleStartCheck()
                    } else if player.timeControlStatus == .paused, player.currentItem != nil {
                        self?.startDelay = nil // paused from the controls: no catching up
                    }
                }
            },
            player.observe(\.volume, options: [.new]) { player, _ in
                UserDefaults.standard.set(player.volume, forKey: Key.volume)
            }
        ]
        // AVFoundation gave up on the stream by itself (not a pause from the controls).
        notifications.append(NotificationCenter.default.addObserver(forName: AVPlayer.rateDidChangeNotification, object: player, queue: .main) { [weak self] note in
            guard let reason = note.userInfo?[AVPlayer.rateDidChangeReasonKey] as? AVPlayer.RateDidChangeReason,
                  reason == .setRateFailed else { return }
            self?.failed()
        })
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updateSubtitle() }

        showMessage(String(localized: "Loading…"))
        load()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    // MARK: Stream

    private func load() {
        retryWork?.cancel()
        KickAPI.channel(slug) { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self else { return }
                switch result {
                case .failure:
                    self.showMessage(String(localized: "Can't reach Kick. Trying again…"))
                    self.retry()
                case .success(let channel):
                    self.channel = channel
                    self.window?.title = channel.username
                    if let url = channel.playbackURL {
                        self.play(master: url)
                    } else {
                        self.player.replaceCurrentItem(with: nil)
                        self.showMessage(String(format: String(localized: "%@ is offline"), channel.username))
                        self.retry(after: Self.offlineRecheck)
                    }
                }
            }
        }
    }

    private func play(master: URL) {
        var components = URLComponents(url: master, resolvingAgainstBaseURL: false)!
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "allow_audio_only", value: "true")]
        let url = components.url!

        let item: AVPlayerItem
        if player.isExternalPlaybackActive {
            loader = nil
            item = AVPlayerItem(url: url)
        } else {
            let loader = LivePlaylistLoader(rendition: rendition)
            self.loader = loader
            item = AVPlayerItem(asset: loader.asset(for: url))
        }
        // Helps after a stall, but doesn't always get back (see catchUpIfBehind).
        item.automaticallyPreservesTimeOffsetFromLive = true

        itemObservations = [
            item.observe(\.status, options: [.new]) { [weak self] item, _ in
                DispatchQueue.main.async {
                    guard let self = self, item === self.player.currentItem else { return }
                    if item.status == .readyToPlay { self.hideMessage() }
                    if item.status == .failed { self.failed() }
                }
            }
        ]
        itemNotifications.forEach(NotificationCenter.default.removeObserver)
        itemNotifications = [
            NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                self?.failed()
            },
            NotificationCenter.default.addObserver(forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main) { [weak self] _ in
                self?.stalled = true
                Self.log.notice("playback stalled")
            },
            // The stream ended (the playlist got #EXT-X-ENDLIST): offline, or a new
            // broadcast with a new link.
            NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                self?.load()
            }
        ]
        checkStart = true
        startDelay = nil
        behindSince = nil
        stalled = false
        player.replaceCurrentItem(with: item)
        player.play()
    }

    // Errors are usually an expired link (they last minutes): fetch a new one.
    private func failed() {
        Self.log.notice("\(self.slug, privacy: .public): playback failed, reconnecting")
        showMessage(String(localized: "Reconnecting…"))
        retry()
    }

    private func retry(after delay: TimeInterval? = nil) {
        retries += 1
        let wait = delay ?? (retries <= Self.quickRetries ? Self.retryDelay : Self.slowRetryDelay)
        let work = DispatchWorkItem { [weak self] in self?.load() }
        retryWork?.cancel()
        retryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: work)
    }

    private func reload() {
        retries = 0
        load()
    }

    // Asked for (Watch, Quality, Reload Stream): a late start may be retried again.
    private func restart() {
        lateStartRetried = false
        reload()
    }

    // A few seconds into playing: a late start (fixed quality) is retried once,
    // otherwise this delay is what catchUpIfBehind keeps to.
    private func scheduleStartCheck() {
        guard checkStart, let item = player.currentItem else { return }
        checkStart = false
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.lateStartCheck) { [weak self, weak item] in
            guard let self = self, let item = item, item === self.player.currentItem,
                  self.player.timeControlStatus == .playing, let date = item.currentDate() else { return }
            let delay = Date().timeIntervalSince(date)
            if delay > Self.lateStartLimit, self.loader?.prefetch == true, !self.lateStartRetried {
                Self.log.notice("\(self.slug, privacy: .public): late start \(delay, format: .fixed(precision: 2)) s, reloading once")
                self.lateStartRetried = true
                self.reload()
            } else {
                Self.log.notice("\(self.slug, privacy: .public): started \(delay, format: .fixed(precision: 2)) s behind (\(self.rendition.stored, privacy: .public))")
                self.startDelay = delay
            }
        }
    }

    // Every second (with the subtitle).
    private func catchUpIfBehind(delay: TimeInterval?) {
        guard stalled, let start = startDelay, let delay = delay, delay > start + Self.catchUpMargin else {
            behindSince = nil
            return
        }
        let now = Date()
        let since = behindSince ?? now
        behindSince = since
        guard now.timeIntervalSince(since) >= Self.catchUpAfter,
              lastCatchUp.map({ now.timeIntervalSince($0) >= Self.catchUpInterval }) ?? true else { return }
        lastCatchUp = now
        Self.log.notice("\(self.slug, privacy: .public): \(delay, format: .fixed(precision: 2)) s behind after a stall (started \(start, format: .fixed(precision: 2))), catching up")
        restart()
    }

    private func showMessage(_ text: String) {
        message.stringValue = text
        message.isHidden = false
    }

    private func hideMessage() {
        message.isHidden = true
    }

    // Distance from the newest segment's timestamp; the encoder adds its own couple
    // of seconds before that.
    private func updateSubtitle() {
        guard let window = window else { return }
        var parts: [String] = []
        var delay: TimeInterval?
        if let date = player.currentItem?.currentDate(), player.timeControlStatus == .playing {
            delay = Date().timeIntervalSince(date)
            parts.append(String(format: String(localized: "%.1f s behind live"), delay!))
        }
        catchUpIfBehind(delay: delay)
        if player.isExternalPlaybackActive {
            parts.append("AirPlay")
        } else {
            parts.append(rendition.title)
        }
        if let title = channel?.title, !title.isEmpty { parts.append(title) }
        window.subtitle = parts.joined(separator: " · ")
    }

    // MARK: Menu actions (Playback menu, see AppDelegate)

    @objc func setQuality(_ sender: NSMenuItem) {
        guard let value = Rendition(stored: sender.representedObject as? String) else { return }
        rendition = value
        restart()
    }

    @objc func toggleFloatOnTop(_ sender: Any?) {
        let floats = !UserDefaults.standard.bool(forKey: Key.floats)
        UserDefaults.standard.set(floats, forKey: Key.floats)
        for controller in Self.open.values {
            controller.window?.level = floats ? .floating : .normal
        }
    }

    @objc func openChat(_ sender: Any?) {
        guard let url = URL(string: "https://kick.com/popout/\(slug)/chat") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc func jumpToLive(_ sender: Any?) {
        Self.log.notice("\(self.slug, privacy: .public): jump to live")
        showMessage(String(localized: "Jumping to live…"))
        restart()
    }

    @objc func reloadStream(_ sender: Any?) {
        showMessage(String(localized: "Loading…"))
        restart()
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(setQuality(_:)):
            menuItem.state = (menuItem.representedObject as? String) == rendition.stored ? .on : .off
        case #selector(toggleFloatOnTop(_:)):
            menuItem.state = UserDefaults.standard.bool(forKey: Key.floats) ? .on : .off
        default:
            break
        }
        return true
    }

    // MARK: NSWindowDelegate

    func windowDidBecomeKey(_ notification: Notification) {
        Self.lastActive = self
    }

    func windowWillClose(_ notification: Notification) {
        timer?.invalidate()
        retryWork?.cancel()
        player.pause()
        player.replaceCurrentItem(with: nil)
        (notifications + itemNotifications).forEach(NotificationCenter.default.removeObserver)
        Self.open[slug] = nil
    }
}
