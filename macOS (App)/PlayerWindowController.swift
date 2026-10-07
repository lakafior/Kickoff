//
//  PlayerWindowController.swift
//  macOS (App)
//
//  The app's own player for a Kick channel, opened by kickoff://watch/{slug} (Player
//  in the extension's view switcher, with ?quality=): a window around LivePlayback,
//  about as close to live as Kick's player. Chat stays in Safari. The toolbar has the
//  same Stream | Chat | Player switcher as the extension, with Player current.
//

import AVKit
import Cocoa

final class PlayerWindowController: NSWindowController, NSWindowDelegate, NSMenuItemValidation, NSToolbarDelegate {

    private static var open: [String: PlayerWindowController] = [:]
    private static weak var lastActive: PlayerWindowController?

    /// The Playback menu's window: the key one, else the last one in front (the key
    /// window can be AVKit's full screen or another app's), else any.
    static var current: PlayerWindowController? {
        (NSApp.keyWindow?.windowController as? PlayerWindowController) ?? lastActive ?? open.values.first
    }

    static var hasWindows: Bool { !open.isEmpty }

    static func show(slug: String, rendition: Rendition?) {
        if let rendition = rendition { LivePlayback.savedRendition = rendition }
        if let existing = open[slug] {
            if rendition != nil { existing.playback.restart() }
            existing.showWindow(nil)
            existing.window?.makeKeyAndOrderFront(nil)
        } else {
            let controller = PlayerWindowController(slug: slug)
            open[slug] = controller
            controller.showWindow(nil)
            controller.window?.makeKeyAndOrderFront(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    private enum Key {
        static let floats = "playerFloats"
        static let volume = "playerVolume"
    }

    private static let viewsItem = NSToolbarItem.Identifier("views")
    private static let kickGreen = NSColor(srgbRed: 0x53 / 255.0, green: 0xfc / 255.0, blue: 0x18 / 255.0, alpha: 1)

    private let playback: LivePlayback
    private let playerView = AVPlayerView()
    private let message = NSTextField(labelWithString: "")
    private var volumeObservation: NSKeyValueObservation?
    private var status = ""

    private init(slug: String) {
        playback = LivePlayback(slug: slug)
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

        let toolbar = NSToolbar(identifier: "KickoffPlayer")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        if #available(macOS 13.0, *) { toolbar.centeredItemIdentifiers = [Self.viewsItem] }
        window.toolbar = toolbar
        window.toolbarStyle = .unified

        playerView.player = playback.player
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
            playback.player.volume = UserDefaults.standard.float(forKey: Key.volume)
        }
        volumeObservation = playback.player.observe(\.volume, options: [.new]) { player, _ in
            UserDefaults.standard.set(player.volume, forKey: Key.volume)
        }

        playback.onMessage = { [weak self] text in
            self?.message.stringValue = text ?? ""
            self?.message.isHidden = text == nil
        }
        playback.onChannel = { [weak self] channel in
            self?.window?.title = channel.username
            self?.updateSubtitle()
        }
        playback.onStatus = { [weak self] status in
            self?.status = status
            self?.updateSubtitle()
        }
        playback.start()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func updateSubtitle() {
        let title = playback.channel?.title ?? ""
        window?.subtitle = [status, title].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Menu actions (Playback menu, see AppDelegate)

    @objc func setQuality(_ sender: NSMenuItem) {
        guard let value = Rendition(stored: sender.representedObject as? String) else { return }
        playback.rendition = value
        playback.restart()
    }

    @objc func toggleFloatOnTop(_ sender: Any?) {
        let floats = !UserDefaults.standard.bool(forKey: Key.floats)
        UserDefaults.standard.set(floats, forKey: Key.floats)
        for controller in Self.open.values {
            controller.window?.level = floats ? .floating : .normal
        }
    }

    @objc func openChat(_ sender: Any?) {
        guard let url = playback.chatURL else { return }
        NSWorkspace.shared.open(url)
    }

    // Kick's own page has its own player: this window closes so it isn't heard twice.
    @objc func openStream(_ sender: Any?) {
        guard let url = playback.streamURL else { return }
        window?.close()
        NSWorkspace.shared.open(url)
    }

    // MARK: View switcher (toolbar)

    // Stream | Chat | Player, like the extension's switcher when open; Player stays
    // selected, the other two act and leave it so.
    @objc private func switchView(_ sender: NSSegmentedControl) {
        let view = WatchView.allCases[sender.selectedSegment]
        sender.selectedSegment = WatchView.allCases.firstIndex(of: .player)!
        switch view {
        case .stream: openStream(sender)
        case .chat: openChat(sender)
        case .player: break
        }
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, Self.viewsItem]
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        if #available(macOS 13.0, *) { return [Self.viewsItem] }
        return [.flexibleSpace, Self.viewsItem, .flexibleSpace]
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard itemIdentifier == Self.viewsItem else { return nil }
        let views = WatchView.allCases
        let control = NSSegmentedControl(labels: views.map(\.title), trackingMode: .selectOne,
                                         target: self, action: #selector(switchView(_:)))
        for (index, view) in views.enumerated() {
            control.setImage(NSImage(systemSymbolName: view.symbol, accessibilityDescription: nil), forSegment: index)
            control.setImageScaling(.scaleProportionallyDown, forSegment: index)
            control.setToolTip(view.title, forSegment: index)
        }
        control.selectedSegment = views.firstIndex(of: .player)!
        control.selectedSegmentBezelColor = Self.kickGreen.withAlphaComponent(0.35)
        control.setAccessibilityLabel(String(localized: "View", comment: "View switcher: accessibility name of the group"))
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        item.view = control
        item.label = String(localized: "View", comment: "View switcher: accessibility name of the group")
        return item
    }

    @objc func jumpToLive(_ sender: Any?) {
        playback.jumpToLive()
    }

    @objc func reloadStream(_ sender: Any?) {
        playback.restart()
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(setQuality(_:)):
            menuItem.state = (menuItem.representedObject as? String) == playback.rendition.stored ? .on : .off
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
        playback.stop()
        Self.open[playback.slug] = nil
    }
}
