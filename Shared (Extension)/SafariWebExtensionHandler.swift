//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by Marcin Śmigielski on 06/10/2026.
//

import SafariServices
import os.log

// iCloud sync for background.js (browser.runtime.sendNativeMessage), because
// Safari's storage.sync doesn't sync between devices. Values live in iCloud's
// key-value store, shared by the Mac and iOS extensions (same bundle ID). Each is
// a JSON string { updatedAt, value } written by background.js; this side only
// stores and returns them, the merging happens in JavaScript.
//
//   { type: "sync:pull" }                      -> { settings, messages, emoteUsage, notes: String? }
//   { type: "sync:push", key, value: String }  -> { ok: true }
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let syncedKeys = ["settings", "messages", "emoteUsage", "notes"]

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        let reply = handle(message as? [String: Any] ?? [:])

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: reply]
        } else {
            response.userInfo = ["message": reply]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    private func handle(_ message: [String: Any]) -> [String: Any] {
        let store = NSUbiquitousKeyValueStore.default
        switch message["type"] as? String {
        case "sync:pull":
            store.synchronize()
            var values: [String: Any] = [:]
            for key in Self.syncedKeys {
                values[key] = store.string(forKey: key) ?? NSNull()
            }
            return values
        case "sync:push":
            guard let key = message["key"] as? String, Self.syncedKeys.contains(key),
                  let value = message["value"] as? String else {
                return ["error": "bad push"]
            }
            store.set(value, forKey: key)
            store.synchronize()
            return ["ok": true]
        default:
            os_log(.error, "Kickoff: unknown native message %@", String(describing: message))
            return ["error": "unknown message"]
        }
    }

}
