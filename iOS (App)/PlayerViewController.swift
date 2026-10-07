//
//  PlayerViewController.swift
//  iOS (App)
//
//  The app's own player on iPhone and iPad, opened by kickoff://watch/{slug} (the
//  extension's Watch button in the Player tab): LivePlayback in an
//  AVPlayerViewController (picture in picture, also on leaving the app; AirPlay).
//  Portrait: the video, a glass card with the channel, the live line and the stream
//  info, and glass Chat / Quality / Live buttons, over the streamer's picture blurred.
//  Landscape: the video only. In the background without picture in picture, and
//  when locked, the sound keeps playing (iOS pauses a video that's on screen, so
//  the picture is let go of until the app is back) with the stream on the lock screen.
//

import AVKit
import MediaPlayer
import os
import UIKit

final class PlayerViewController: UIViewController, AVPlayerViewControllerDelegate {

    private static weak var shown: PlayerViewController?
    // Turning the audio session on and off can block for a while: not on the main
    // thread. One queue, so on and off keep their order.
    private static let audioSessionQueue = DispatchQueue(label: "net.smigi.Kickoff.audioSession")

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
    private let backdrop = UIImageView()     // the streamer's picture, blurred
    private let backdropBlur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterialDark))
    private let videoView = UIView()
    private let content = UIStackView()      // the card and the buttons
    private let message = UILabel()
    private let avatarView = UIImageView()
    private let nameLabel = UILabel()
    private let liveLabel = UILabel()
    private let titleLabel = UILabel()
    private let chips = UIStackView()
    private let viewersChip = PlayerViewController.chip(symbol: "eye")
    private let uptimeChip = PlayerViewController.chip(symbol: "clock")
    private let categoryChip = PlayerViewController.chip(symbol: "square.grid.2x2")
    private let qualityButton = PlayerViewController.glassButton()
    private var startedAt: Date?
    private var videoOnly = false
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
    override var prefersStatusBarHidden: Bool { videoOnly }
    override var prefersHomeIndicatorAutoHidden: Bool { videoOnly }

    override func viewDidLoad() {
        super.viewDidLoad()
        Self.shown = self
        view.backgroundColor = .black

        for backdropView in [backdrop, backdropBlur] {
            backdropView.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(backdropView)
        }
        backdrop.contentMode = .scaleAspectFill
        backdrop.clipsToBounds = true

        videoView.translatesAutoresizingMaskIntoConstraints = false
        videoView.backgroundColor = .black
        videoView.clipsToBounds = true
        videoView.layer.cornerCurve = .continuous
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
        playback.onStatus = { [weak self] _ in
            self?.updateLiveLine()
            self?.updateUptime()
            self?.updateNowPlaying()
        }

        Self.audioSessionQueue.async {
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try? AVAudioSession.sharedInstance().setActive(true)
        }
        setUpRemoteCommands()
        observeScene()
        UIApplication.shared.isIdleTimerDisabled = true
        playback.start()
    }

    // MARK: Layout

    private func buildPanel() {
        // Card: avatar, name and live line, close; the title; info chips.
        avatarView.contentMode = .scaleAspectFill
        avatarView.clipsToBounds = true
        avatarView.layer.cornerRadius = 22
        avatarView.backgroundColor = UIColor.white.withAlphaComponent(0.1)
        NSLayoutConstraint.activate([
            avatarView.widthAnchor.constraint(equalToConstant: 44),
            avatarView.heightAnchor.constraint(equalToConstant: 44)
        ])
        nameLabel.font = Self.font(.title3, weight: .semibold)
        nameLabel.textColor = .label
        liveLabel.font = .monospacedDigitSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .medium)
        liveLabel.textColor = .secondaryLabel
        let names = UIStackView(arrangedSubviews: [nameLabel, liveLabel])
        names.axis = .vertical
        names.spacing = 2

        var closeConfiguration = Self.glassConfiguration()
        closeConfiguration.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(textStyle: .subheadline, scale: .medium))
        closeConfiguration.cornerStyle = .capsule
        closeConfiguration.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10)
        let close = UIButton(configuration: closeConfiguration)
        close.accessibilityLabel = String(localized: "Close")
        close.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        close.setContentHuggingPriority(.required, for: .horizontal)

        let header = UIStackView(arrangedSubviews: [avatarView, names, close])
        header.alignment = .center
        header.spacing = 12

        titleLabel.font = .preferredFont(forTextStyle: .subheadline)
        titleLabel.textColor = .secondaryLabel
        titleLabel.numberOfLines = 3
        for label in [nameLabel, liveLabel, titleLabel] { label.adjustsFontForContentSizeCategory = true }

        chips.addArrangedSubview(viewersChip)
        chips.addArrangedSubview(uptimeChip)
        chips.addArrangedSubview(categoryChip)
        chips.addArrangedSubview(UIView()) // keeps the chips on the left
        chips.spacing = 8
        chips.alignment = .center

        let cardStack = UIStackView(arrangedSubviews: [header, titleLabel, chips])
        cardStack.axis = .vertical
        cardStack.spacing = 12
        cardStack.translatesAutoresizingMaskIntoConstraints = false
        let card = Self.glassView(cornerRadius: 28)
        card.contentView.addSubview(cardStack)
        NSLayoutConstraint.activate([
            cardStack.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 16),
            cardStack.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -16),
            cardStack.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 16),
            cardStack.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -16)
        ])

        // Buttons.
        let chat = Self.glassButton(String(localized: "Chat"), symbol: "bubble.left.and.bubble.right") { [weak self] in
            guard let url = self?.playback.chatURL else { return }
            UIApplication.shared.open(url)
        }
        let live = Self.glassButton(String(localized: "Live", comment: "Button: jump to live"), symbol: "dot.radiowaves.left.and.right") { [weak self] in
            self?.playback.jumpToLive()
        }
        qualityButton.configuration?.image = UIImage(systemName: "slider.horizontal.3")
        qualityButton.showsMenuAsPrimaryAction = true
        updateQualityMenu()
        let buttons = UIStackView(arrangedSubviews: [chat, qualityButton, live])
        buttons.spacing = 10
        buttons.distribution = .fillEqually

        content.addArrangedSubview(card)
        content.addArrangedSubview(buttons)
        content.axis = .vertical
        content.spacing = 12
        content.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content)
        updateLiveLine()
    }

    // Liquid Glass on iOS 26, the closest material before.
    private static func glassView(cornerRadius: CGFloat) -> UIVisualEffectView {
        let view: UIVisualEffectView
        if #available(iOS 26.0, *) {
            view = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
            view.cornerConfiguration = .corners(radius: .fixed(cornerRadius))
        } else {
            view = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
            view.layer.cornerRadius = cornerRadius
            view.layer.cornerCurve = .continuous
            view.clipsToBounds = true
        }
        return view
    }

    private static func glassConfiguration() -> UIButton.Configuration {
        if #available(iOS 26.0, *) { return .glass() }
        var configuration = UIButton.Configuration.gray()
        configuration.baseForegroundColor = .label
        return configuration
    }

    private static func glassButton(_ title: String = "", symbol: String = "", action: (() -> Void)? = nil) -> UIButton {
        var configuration = glassConfiguration()
        configuration.title = title
        configuration.image = symbol.isEmpty ? nil : UIImage(systemName: symbol)
        configuration.imagePadding = 6
        configuration.cornerStyle = .capsule
        configuration.titleLineBreakMode = .byTruncatingTail
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 12, bottom: 14, trailing: 12)
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = font(.subheadline, weight: .semibold)
            return attributes
        }
        let button = UIButton(configuration: configuration)
        if let action = action { button.addAction(UIAction { _ in action() }, for: .touchUpInside) }
        return button
    }

    // A small capsule with an icon and a short text (live time, category).
    private static func chip(symbol: String) -> UILabel {
        let label = PaddedLabel()
        label.font = .preferredFont(forTextStyle: .footnote)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .label
        label.backgroundColor = UIColor.white.withAlphaComponent(0.12)
        label.layer.cornerRadius = 13
        label.layer.cornerCurve = .continuous
        label.clipsToBounds = true
        label.accessibilityIdentifier = symbol
        label.isHidden = true
        return label
    }

    private static func chipText(symbol: String, text: String) -> NSAttributedString {
        let result = NSMutableAttributedString()
        if let image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(textStyle: .caption1))?
            .withTintColor(.secondaryLabel, renderingMode: .alwaysOriginal) {
            result.append(NSAttributedString(attachment: NSTextAttachment(image: image)))
            result.append(NSAttributedString(string: "  "))
        }
        result.append(NSAttributedString(string: text))
        return result
    }

    private static func font(_ style: UIFont.TextStyle, weight: UIFont.Weight) -> UIFont {
        let size = UIFont.preferredFont(forTextStyle: style).pointSize
        return UIFontMetrics(forTextStyle: style).scaledFont(for: .systemFont(ofSize: size, weight: weight))
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
        // One centred column: the full width on iPhone, at most 720 points on iPad.
        let column = UILayoutGuide()
        view.addLayoutGuide(column)
        let columnWidth = column.widthAnchor.constraint(equalTo: safe.widthAnchor, constant: -24)
        columnWidth.priority = .defaultHigh
        let aspect = videoView.heightAnchor.constraint(equalTo: videoView.widthAnchor, multiplier: 9.0 / 16.0)
        aspect.priority = .defaultHigh
        NSLayoutConstraint.activate([
            backdrop.topAnchor.constraint(equalTo: view.topAnchor),
            backdrop.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            backdrop.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            backdrop.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            backdropBlur.topAnchor.constraint(equalTo: view.topAnchor),
            backdropBlur.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            backdropBlur.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            backdropBlur.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            column.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
            column.widthAnchor.constraint(lessThanOrEqualToConstant: 720),
            columnWidth,
            message.centerXAnchor.constraint(equalTo: videoView.centerXAnchor),
            message.centerYAnchor.constraint(equalTo: videoView.centerYAnchor),
            message.widthAnchor.constraint(lessThanOrEqualTo: videoView.widthAnchor, constant: -32)
        ])
        portraitConstraints = [
            videoView.topAnchor.constraint(equalTo: safe.topAnchor, constant: 8),
            videoView.leadingAnchor.constraint(equalTo: column.leadingAnchor),
            videoView.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            aspect,
            content.topAnchor.constraint(equalTo: videoView.bottomAnchor, constant: 12),
            content.leadingAnchor.constraint(equalTo: column.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            content.bottomAnchor.constraint(lessThanOrEqualTo: safe.bottomAnchor, constant: -8)
        ]
        landscapeConstraints = [
            videoView.topAnchor.constraint(equalTo: view.topAnchor),
            videoView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            videoView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            videoView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ]
        applyLayout(videoOnly: false)
    }

    // Wider than tall (iPhone or iPad in landscape): the video fills the screen, like
    // full screen. Split View and Slide Over columns stay in the layout with the card.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let wide = view.bounds.width > view.bounds.height
        if wide != videoOnly { applyLayout(videoOnly: wide) }
    }

    private func applyLayout(videoOnly: Bool) {
        self.videoOnly = videoOnly
        NSLayoutConstraint.deactivate(videoOnly ? portraitConstraints : landscapeConstraints)
        NSLayoutConstraint.activate(videoOnly ? landscapeConstraints : portraitConstraints)
        content.isHidden = videoOnly
        backdrop.isHidden = videoOnly
        backdropBlur.isHidden = videoOnly
        videoView.layer.cornerRadius = videoOnly ? 0 : 20
        setNeedsStatusBarAppearanceUpdate()
        setNeedsUpdateOfHomeIndicatorAutoHidden()
    }

    private static let viewerCount: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter
    }()

    private static let duration: DateComponentsFormatter = {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.hour, .minute]
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    private func showChannel(_ channel: KickChannel) {
        nameLabel.text = channel.username
        titleLabel.text = channel.title
        titleLabel.isHidden = channel.title.isEmpty
        if let viewers = channel.viewers, let count = Self.viewerCount.string(from: NSNumber(value: viewers)) {
            viewersChip.attributedText = Self.chipText(symbol: "eye", text: count)
            viewersChip.accessibilityLabel = String(format: String(localized: "%@ watching"), count)
        }
        viewersChip.isHidden = channel.viewers == nil
        if let category = channel.category {
            categoryChip.attributedText = Self.chipText(symbol: "square.grid.2x2", text: category)
        }
        categoryChip.isHidden = channel.category == nil
        startedAt = channel.startedAt
        updateUptime()
        updateLiveLine()
        loadArtwork(channel.avatar)
        updateNowPlaying()
    }

    // "● LIVE  ·  1.9 s behind"
    private func updateLiveLine() {
        let line = NSMutableAttributedString(string: "● " + String(localized: "LIVE", comment: "Badge: the stream is live"),
                                             attributes: [.foregroundColor: UIColor.systemRed,
                                                          .font: Self.font(.footnote, weight: .bold)])
        if let delay = playback.delay {
            line.append(NSAttributedString(string: "  ·  " + String(format: String(localized: "%.1f s behind"), delay)))
        }
        liveLabel.attributedText = line
    }

    private func updateUptime() {
        guard let startedAt = startedAt,
              let text = Self.duration.string(from: max(60, Date().timeIntervalSince(startedAt))) else {
            uptimeChip.isHidden = true
            return
        }
        uptimeChip.attributedText = Self.chipText(symbol: "clock", text: text)
        uptimeChip.accessibilityLabel = String(format: String(localized: "Live for %@"), text)
        uptimeChip.isHidden = false
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
                self?.avatarView.image = image
                self?.backdrop.image = image
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
        Self.audioSessionQueue.async {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
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

// A label with room around its text, for the info chips.
private final class PaddedLabel: UILabel {
    private let insets = UIEdgeInsets(top: 5, left: 10, bottom: 5, right: 10)

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: insets))
    }

    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + insets.left + insets.right, height: size.height + insets.top + insets.bottom)
    }
}
