//
//  PlayerViewController.swift
//  iOS (App)
//
//  The app's own player on iPhone and iPad, opened by kickoff://watch/{slug} (the
//  extension's Watch button in the Player tab): LivePlayback in an
//  AVPlayerViewController (picture in picture, also on leaving the app; AirPlay),
//  with the channel and Chat / Quality / Jump to Live under the video. iPhone in
//  landscape: the video only. In the background without picture in picture, and
//  when locked, the sound keeps playing (iOS pauses a video that's on screen, so
//  the picture is let go of until the app is back) with the stream on the lock screen.
//

import AVKit
import MediaPlayer
import os
import UIKit

final class PlayerViewController: UIViewController, AVPlayerViewControllerDelegate {

    private static weak var shown: PlayerViewController?

    static func show(slug: String, rendition: Rendition?, from window: UIWindow?) {
        if let rendition = rendition { LivePlayback.savedRendition = rendition }
        if let shown = shown, shown.playback.slug == slug {
            if rendition != nil { shown.playback.restart() }
            return
        }
        guard let root = window?.rootViewController else { return }
        let present = {
            let controller = PlayerViewController(slug: slug)
            controller.modalPresentationStyle = .fullScreen
            root.present(controller, animated: true)
        }
        if let presented = root.presentedViewController {
            presented.dismiss(animated: false, completion: present)
        } else {
            present()
        }
    }

    private let playback: LivePlayback
    private var playerController = AVPlayerViewController()
    private var videoDetached = false
    private let videoView = UIView()
    private let panel = UIStackView()
    private let message = UILabel()
    private let nameLabel = UILabel()
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let qualityButton = UIButton(configuration: .gray())
    private var portraitConstraints: [NSLayoutConstraint] = []
    private var landscapeConstraints: [NSLayoutConstraint] = []
    private var pictureInPicture = false
    private var notifications: [NSObjectProtocol] = []
    private var remoteCommands: [(MPRemoteCommand, Any)] = []
    private var artwork: MPMediaItemArtwork?
    private var artworkURL: URL?

    private init(slug: String) {
        playback = LivePlayback(slug: slug)
        super.init(nibName: nil, bundle: nil)
        overrideUserInterfaceStyle = .dark
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        Self.shown = self
        view.backgroundColor = .black

        videoView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(videoView)
        installPlayerController()

        message.textColor = .white
        message.font = .preferredFont(forTextStyle: .headline)
        message.textAlignment = .center
        message.numberOfLines = 0
        message.translatesAutoresizingMaskIntoConstraints = false
        message.isUserInteractionEnabled = false // the player's controls are underneath
        videoView.addSubview(message) // not contentOverlayView: it isn't there yet

        buildPanel()
        layout()

        playback.onMessage = { [weak self] text in
            self?.message.text = text
            self?.message.isHidden = text == nil
        }
        playback.onChannel = { [weak self] channel in self?.showChannel(channel) }
        playback.onStatus = { [weak self] status in
            self?.statusLabel.text = status
            self?.updateNowPlaying()
        }

        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        setUpRemoteCommands()
        observeScene()
        UIApplication.shared.isIdleTimerDisabled = true
        playback.start()
    }

    // MARK: Layout

    private func buildPanel() {
        nameLabel.font = .preferredFont(forTextStyle: .headline)
        nameLabel.textColor = .label
        titleLabel.font = .preferredFont(forTextStyle: .subheadline)
        titleLabel.textColor = .secondaryLabel
        titleLabel.numberOfLines = 2
        statusLabel.font = .monospacedDigitSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
        statusLabel.textColor = .secondaryLabel
        for label in [nameLabel, titleLabel, statusLabel] { label.adjustsFontForContentSizeCategory = true }

        let close = UIButton(type: .close)
        close.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        close.setContentHuggingPriority(.required, for: .horizontal)
        let header = UIStackView(arrangedSubviews: [nameLabel, close])
        header.alignment = .center

        let chat = panelButton(String(localized: "Chat"), symbol: "bubble.left.and.bubble.right") { [weak self] in
            guard let url = self?.playback.chatURL else { return }
            UIApplication.shared.open(url)
        }
        let live = panelButton(String(localized: "Live", comment: "Button: jump to live"), symbol: "dot.radiowaves.left.and.right") { [weak self] in
            self?.playback.jumpToLive()
        }
        qualityButton.configuration?.image = UIImage(systemName: "slider.horizontal.3")
        qualityButton.configuration?.imagePadding = 6
        qualityButton.showsMenuAsPrimaryAction = true
        updateQualityMenu()
        let buttons = UIStackView(arrangedSubviews: [chat, qualityButton, live])
        buttons.spacing = 8
        buttons.distribution = .fillEqually

        for view in [header, titleLabel, statusLabel, buttons] { panel.addArrangedSubview(view) }
        panel.axis = .vertical
        panel.spacing = 8
        panel.setCustomSpacing(16, after: statusLabel)
        panel.isLayoutMarginsRelativeArrangement = true
        panel.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(panel)
    }

    private func panelButton(_ title: String, symbol: String, action: @escaping () -> Void) -> UIButton {
        var configuration = UIButton.Configuration.gray()
        configuration.title = title
        configuration.image = UIImage(systemName: symbol)
        configuration.imagePadding = 6
        configuration.titleLineBreakMode = .byTruncatingTail
        let button = UIButton(configuration: configuration)
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return button
    }

    private func updateQualityMenu() {
        let current = playback.rendition
        qualityButton.configuration?.title = current.title
        qualityButton.menu = UIMenu(title: String(localized: "Quality"), children: Rendition.choices.map { choice in
            UIAction(title: choice.title, state: choice.rendition == current ? .on : .off) { [weak self] _ in
                guard let self = self else { return }
                self.playback.rendition = choice.rendition
                self.updateQualityMenu()
                self.playback.restart()
            }
        })
    }

    // A new one also after the video was let go of in the background: given the
    // player back, the old one stays black.
    private func installPlayerController() {
        let old = playerController
        if old.parent != nil {
            old.willMove(toParent: nil)
            old.view.removeFromSuperview()
            old.removeFromParent()
            playerController = AVPlayerViewController()
        }
        let controller = playerController
        controller.player = playback.player
        controller.delegate = self
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.updatesNowPlayingInfoCenter = false // ours: it stays while the video is let go of
        addChild(controller)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        videoView.insertSubview(controller.view, at: 0) // under the message
        NSLayoutConstraint.activate([
            controller.view.leadingAnchor.constraint(equalTo: videoView.leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: videoView.trailingAnchor),
            controller.view.topAnchor.constraint(equalTo: videoView.topAnchor),
            controller.view.bottomAnchor.constraint(equalTo: videoView.bottomAnchor)
        ])
        controller.didMove(toParent: self)
    }

    // After the phone was locked AVFoundation stops decoding the video and a new view
    // doesn't start it again: no picture soon after coming back means starting the
    // stream again (closer to live too, like Live).
    private func restartIfNoPicture() {
        let controller = playerController
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self, controller === self.playerController, !self.pictureInPicture,
                  !controller.isReadyForDisplay,
                  self.playback.player.currentItem != nil else { return }
            LivePlayback.log.notice("foreground: no picture, starting again")
            self.playback.restart()
        }
    }

    private func layout() {
        let safe = view.safeAreaLayoutGuide
        let aspect = videoView.heightAnchor.constraint(equalTo: videoView.widthAnchor, multiplier: 9.0 / 16.0)
        aspect.priority = .defaultHigh // iPad landscape: the panel keeps its room
        NSLayoutConstraint.activate([
            message.centerXAnchor.constraint(equalTo: videoView.centerXAnchor),
            message.centerYAnchor.constraint(equalTo: videoView.centerYAnchor),
            message.widthAnchor.constraint(lessThanOrEqualTo: videoView.widthAnchor, constant: -32)
        ])
        portraitConstraints = [
            videoView.topAnchor.constraint(equalTo: safe.topAnchor),
            videoView.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            videoView.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            aspect,
            panel.topAnchor.constraint(equalTo: videoView.bottomAnchor),
            panel.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            panel.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            panel.bottomAnchor.constraint(lessThanOrEqualTo: safe.bottomAnchor)
        ]
        landscapeConstraints = [
            videoView.topAnchor.constraint(equalTo: view.topAnchor),
            videoView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            videoView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            videoView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ]
        applyLayout()
        registerForTraitChanges([UITraitVerticalSizeClass.self]) { (self: Self, _) in self.applyLayout() }
    }

    // iPhone in landscape: the video fills the screen.
    private func applyLayout() {
        let videoOnly = traitCollection.verticalSizeClass == .compact
        NSLayoutConstraint.deactivate(videoOnly ? portraitConstraints : landscapeConstraints)
        NSLayoutConstraint.activate(videoOnly ? landscapeConstraints : portraitConstraints)
        panel.isHidden = videoOnly
    }

    private func showChannel(_ channel: KickChannel) {
        nameLabel.text = channel.username
        titleLabel.text = channel.title
        titleLabel.isHidden = channel.title.isEmpty
        loadArtwork(channel.avatar)
        updateNowPlaying()
    }

    // MARK: Background, lock screen

    private func observeScene() {
        let center = NotificationCenter.default
        notifications = [
            // Without picture in picture the video is let go of and the sound plays on.
            // A moment later, and only once the app is fully in the background: while
            // picture in picture runs it isn't, and leaving the app can report picture in
            // picture only after this.
            center.addObserver(forName: UIScene.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    guard let self = self, !self.pictureInPicture,
                          UIApplication.shared.applicationState == .background else { return }
                    LivePlayback.log.notice("background: video let go of")
                    self.playerController.player = nil
                    self.videoDetached = true
                }
            },
            // Back: a new player view only if the video was let go of (given back, the
            // old one stays black); otherwise the view isn't touched (after picture in
            // picture hands the video back, touching it leaves it black). Either way a
            // check for a picture: after locking, iOS stops the video by itself.
            center.addObserver(forName: UIScene.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
                guard let self = self else { return }
                LivePlayback.log.notice("foreground: \(self.videoDetached ? "new player view" : "view kept", privacy: .public)")
                if self.videoDetached {
                    self.videoDetached = false
                    self.installPlayerController()
                }
                self.restartIfNoPicture()
            }
        ]
    }

    private func setUpRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        let player = playback.player
        remoteCommands = [
            (center.playCommand, center.playCommand.addTarget { _ in player.play(); return .success }),
            (center.pauseCommand, center.pauseCommand.addTarget { _ in player.pause(); return .success }),
            (center.togglePlayPauseCommand, center.togglePlayPauseCommand.addTarget { _ in
                if player.timeControlStatus == .paused { player.play() } else { player.pause() }
                return .success
            })
        ]
    }

    private func updateNowPlaying() {
        guard let channel = playback.channel else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: channel.title.isEmpty ? channel.username : channel.title,
            MPMediaItemPropertyArtist: "\(channel.username) · Kick",
            MPNowPlayingInfoPropertyIsLiveStream: true,
            MPNowPlayingInfoPropertyPlaybackRate: playback.player.rate
        ]
        if let artwork = artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func loadArtwork(_ url: URL?) {
        guard let url = url, url != artworkURL else { return }
        artworkURL = url
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data = data, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                self?.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self?.updateNowPlaying()
            }
        }.resume()
    }

    // MARK: Closing

    private func close() {
        dismiss(animated: true)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed else { return }
        playback.stop()
        notifications.forEach(NotificationCenter.default.removeObserver)
        for (command, target) in remoteCommands { command.removeTarget(target) }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        UIApplication.shared.isIdleTimerDisabled = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: AVPlayerViewControllerDelegate

    func playerViewControllerWillStartPictureInPicture(_ playerViewController: AVPlayerViewController) {
        pictureInPicture = true
        LivePlayback.log.notice("picture in picture starting")
    }

    func playerViewControllerDidStopPictureInPicture(_ playerViewController: AVPlayerViewController) {
        pictureInPicture = false
        LivePlayback.log.notice("picture in picture stopped")
    }

    // Back from picture in picture: this screen is still up underneath.
    func playerViewController(_ playerViewController: AVPlayerViewController,
                              restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        completionHandler(true)
    }
}
