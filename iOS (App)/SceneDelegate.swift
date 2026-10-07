//
//  SceneDelegate.swift
//  iOS (App)
//
//  Created by Marcin Śmigielski on 06/10/2026.
//

import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?
    private var pendingURL: URL? // opened before the window was up

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let _ = (scene as? UIWindowScene) else { return }
        pendingURL = connectionOptions.urlContexts.first?.url
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        guard let url = pendingURL else { return }
        pendingURL = nil
        open(url)
    }

    // kickoff://watch/… (WatchLink), from the extension's Watch button.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        URLContexts.forEach { open($0.url) }
    }

    private func open(_ url: URL) {
        guard let (slug, rendition) = WatchLink.parse(url) else { return }
        PlayerViewController.show(slug: slug, rendition: rendition, from: window)
    }

}
