//
//  LivePlayback.swift
//  Shared (App)
//
//  One channel's live stream in an AVPlayer, without UI: loading (with a fresh link
//  after errors, they expire in minutes), the start check, catching up after stalls
//  and the status line. PlayerWindowController (macOS) and PlayerViewController (iOS)
//  put it on screen. Used on the main thread.
//

import AVFoundation
import os

final class LivePlayback {

    static let log = Logger(subsystem: "net.smigi.Kickoff", category: "player")
    private static let renditionKey = "playerRendition"

    private static let retryDelay: TimeInterval = 3
    private static let slowRetryDelay: TimeInterval = 30
    private static let quickRetries = 5
    private static let offlineRecheck: TimeInterval = 60
    // A start that landed a segment further back than usual is reloaded once, which
    // re-rolls where it lands (LivePlaylistLoader times starts, so this is rare).
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
    private static let infoInterval: TimeInterval = 60 // viewers, title, category

    /// The quality the app plays (the extension's Watch link sets it too).
    static var savedRendition: Rendition {
        get { Rendition(stored: UserDefaults.standard.string(forKey: renditionKey)) ?? .best }
        set { UserDefaults.standard.set(newValue.stored, forKey: renditionKey) }
    }

    let slug: String
    let player = AVPlayer()
    private(set) var channel: KickChannel?
    /// Seconds behind the newest segment while playing (nil otherwise), every second.
    private(set) var delay: TimeInterval?

    /// Text over the video ("Loading…", "… is offline"); nil hides it.
    var onMessage: ((String?) -> Void)?
    /// The channel's name, title and stream info, when (re)loaded and every minute.
    var onChannel: ((KickChannel) -> Void)?
    /// The status line, every second: "2.1 s behind live · Best".
    var onStatus: ((String) -> Void)?

    private var loader: LivePlaylistLoader?
    private var itemObservations: [NSKeyValueObservation] = []
    private var observations: [NSKeyValueObservation] = []
    private var notifications: [NSObjectProtocol] = []
    private var itemNotifications: [NSObjectProtocol] = []
    private var timer: Timer?
    private var infoTimer: Timer?
    private var retryWork: DispatchWorkItem?
    private var retries = 0
    private var checkStart = false   // the current item's first play is still to be checked
    private var lateStartRetried = false
    private var startDelay: TimeInterval?  // behind live once the start was checked
    private var behindSince: Date?
    private var stalled = false
    private var lastCatchUp: Date?
    private var stopped = false

    var rendition: Rendition {
        get { Self.savedRendition }
        set { Self.savedRendition = newValue }
    }

    init(slug: String) {
        self.slug = slug
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
            }
        ]
        // AVFoundation gave up on the stream by itself (not a pause from the controls).
        notifications.append(NotificationCenter.default.addObserver(forName: AVPlayer.rateDidChangeNotification, object: player, queue: .main) { [weak self] note in
            guard let reason = note.userInfo?[AVPlayer.rateDidChangeReasonKey] as? AVPlayer.RateDidChangeReason,
                  reason == .setRateFailed else { return }
            self?.failed()
        })
    }

    deinit {
        (notifications + itemNotifications).forEach(NotificationCenter.default.removeObserver)
    }

    func start() {
        stopped = false
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        infoTimer?.invalidate()
        infoTimer = Timer.scheduledTimer(withTimeInterval: Self.infoInterval, repeats: true) { [weak self] _ in self?.refreshInfo() }
        onMessage?(String(localized: "Loading…"))
        load()
    }

    func stop() {
        stopped = true
        timer?.invalidate()
        infoTimer?.invalidate()
        retryWork?.cancel()
        player.pause()
        player.replaceCurrentItem(with: nil)
    }

    /// Asked for (Watch, Quality, Reload): a late start may be retried again.
    func restart(message: String = String(localized: "Loading…")) {
        onMessage?(message)
        lateStartRetried = false
        reload()
    }

    func jumpToLive() {
        Self.log.notice("\(self.slug, privacy: .public): jump to live")
        restart(message: String(localized: "Jumping to live…"))
    }

    var chatURL: URL? { URL(string: "https://kick.com/popout/\(slug)/chat") }

    // MARK: Loading

    // The channel again, for its info only: playing carries on.
    private func refreshInfo() {
        guard player.timeControlStatus == .playing else { return }
        KickAPI.channel(slug) { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self, !self.stopped, case .success(let channel) = result else { return }
                self.channel = channel
                self.onChannel?(channel)
            }
        }
    }

    private func load() {
        retryWork?.cancel()
        KickAPI.channel(slug) { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self, !self.stopped else { return }
                switch result {
                case .failure:
                    self.onMessage?(String(localized: "Can't reach Kick. Trying again…"))
                    self.retry()
                case .success(let channel):
                    self.channel = channel
                    self.onChannel?(channel)
                    if let url = channel.playbackURL {
                        self.play(master: url)
                    } else {
                        self.player.replaceCurrentItem(with: nil)
                        self.onMessage?(String(format: String(localized: "%@ is offline"), channel.username))
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
                    if item.status == .readyToPlay { self.onMessage?(nil) }
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

    // Errors are usually an expired link: fetch a new one.
    private func failed() {
        guard !stopped else { return }
        Self.log.notice("\(self.slug, privacy: .public): playback failed, reconnecting")
        onMessage?(String(localized: "Reconnecting…"))
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
        guard !stopped else { return }
        retries = 0
        load()
    }

    // MARK: Staying close to live

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
        restart(message: String(localized: "Jumping to live…"))
    }

    // Distance from the newest segment's timestamp; the encoder adds its own couple
    // of seconds before that.
    private func tick() {
        var parts: [String] = []
        var delay: TimeInterval?
        if let date = player.currentItem?.currentDate(), player.timeControlStatus == .playing {
            delay = Date().timeIntervalSince(date)
            parts.append(String(format: String(localized: "%.1f s behind live"), delay!))
        }
        self.delay = delay
        catchUpIfBehind(delay: delay)
        parts.append(player.isExternalPlaybackActive ? "AirPlay" : rendition.title)
        onStatus?(parts.joined(separator: " · "))
    }
}
