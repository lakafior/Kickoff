//
//  AppDelegate.swift
//  macOS (App)
//
//  Created by Marcin Śmigielski on 06/10/2026.
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {

    func applicationDidFinishLaunching(_ notification: Notification) {
        addPlaybackMenu()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    // kickoff://watch/… (WatchLink), from the extension's Watch button.
    func application(_ application: NSApplication, open urls: [URL]) {
        for case let (slug, rendition)? in urls.map(WatchLink.parse) {
            PlayerWindowController.show(slug: slug, rendition: rendition)
        }
        // Opened for a stream: the setup window isn't wanted (closed after the player
        // is up, or closing the last window would quit the app).
        guard PlayerWindowController.hasWindows else { return }
        for window in NSApp.windows where window.contentViewController is ViewController {
            window.close()
        }
    }

    // MARK: Playback menu (actions go to PlayerWindowController.current, so they work
    // while the key window is AVKit's full screen or picture in picture)

    @objc func setQuality(_ sender: NSMenuItem) { PlayerWindowController.current?.setQuality(sender) }
    @objc func toggleFloatOnTop(_ sender: Any?) { PlayerWindowController.current?.toggleFloatOnTop(sender) }
    @objc func openChat(_ sender: Any?) { PlayerWindowController.current?.openChat(sender) }
    @objc func jumpToLive(_ sender: Any?) { PlayerWindowController.current?.jumpToLive(sender) }
    @objc func reloadStream(_ sender: Any?) { PlayerWindowController.current?.reloadStream(sender) }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let player = PlayerWindowController.current else { return false }
        return player.validateMenuItem(menuItem)
    }

    private func addPlaybackMenu() {
        guard let mainMenu = NSApp.mainMenu else { return }
        let menu = NSMenu(title: String(localized: "Playback"))

        let quality = NSMenu(title: String(localized: "Quality"))
        for choice in Rendition.choices {
            let item = NSMenuItem(title: choice.title, action: #selector(AppDelegate.setQuality(_:)), keyEquivalent: "")
            item.representedObject = choice.rendition.stored
            quality.addItem(item)
        }
        menu.addItem(withTitle: String(localized: "Quality"), action: nil, keyEquivalent: "").submenu = quality

        menu.addItem(.separator())
        let float = NSMenuItem(title: String(localized: "Float on Top"), action: #selector(AppDelegate.toggleFloatOnTop(_:)), keyEquivalent: "t")
        float.keyEquivalentModifierMask = [.command, .option]
        menu.addItem(float)
        let chat = NSMenuItem(title: String(localized: "Open Chat in Browser"), action: #selector(AppDelegate.openChat(_:)), keyEquivalent: "c")
        chat.keyEquivalentModifierMask = [.command, .option]
        menu.addItem(chat)
        menu.addItem(NSMenuItem(title: String(localized: "Jump to Live"), action: #selector(AppDelegate.jumpToLive(_:)), keyEquivalent: "l"))
        menu.addItem(NSMenuItem(title: String(localized: "Reload Stream"), action: #selector(AppDelegate.reloadStream(_:)), keyEquivalent: "r"))

        for item in menu.items + quality.items where item.action != nil { item.target = self }

        let item = NSMenuItem(title: String(localized: "Playback"), action: nil, keyEquivalent: "")
        item.submenu = menu
        let windowIndex = NSApp.windowsMenu.map { mainMenu.indexOfItem(withSubmenu: $0) } ?? -1
        mainMenu.insertItem(item, at: windowIndex >= 0 ? windowIndex : mainMenu.numberOfItems)
    }

}
