//
//  LiveStream.swift
//  Shared (App)
//
//  Kick's live stream for the app's own player.
//
//  Kick's media playlists say #EXT-X-TARGETDURATION:6 whatever the segments are
//  (1 s or ~4 s, depending on the streamer's encoder), and AVFoundation starts 3
//  target durations from the live end: 18 s, plus its buffer. The playlists go
//  through LivePlaylistLoader, which states the real target duration. With a fixed
//  quality it also lists the two #EXT-X-PREFETCH segments (still being made, which
//  is how Kick's own player stays close) as ordinary ones, so AVPlayer loads them as
//  they're made, and asks to start 3 s from the end (#EXT-X-START, PRECISE so not
//  only at a segment's start). Where it lands still depends on how far the segment
//  being made is: with 4 s segments, measured 1.7 s behind when it's ~1 s in, up to
//  3.7 s later in it, and 4.5 s (a whole segment back) right after a new one starts.
//  So media playlists are held until ~1 s into a segment (startPhase): measured
//  1.8–2.6 s behind on every start, at the cost of up to one segment's wait. Only the playlists pass through the loader; segments load
//  straight from Kick's CDN.
//

import AVFoundation
import Foundation

struct KickChannel {
    let slug: String
    let username: String
    let title: String
    let avatar: URL?
    let playbackURL: URL? // nil while offline
}

enum KickAPI {
    static let origin = "https://kick.com"
    static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

    static func request(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        return request
    }

    static func load(_ url: URL, completion: @escaping (Result<Data, Error>) -> Void) {
        URLSession.shared.dataTask(with: request(url)) { data, response, error in
            if let error = error { return completion(.failure(error)) }
            guard let data = data, (response as? HTTPURLResponse)?.statusCode == 200 else {
                return completion(.failure(URLError(.badServerResponse)))
            }
            completion(.success(data))
        }.resume()
    }

    static func channel(_ slug: String, completion: @escaping (Result<KickChannel, Error>) -> Void) {
        let url = URL(string: "\(origin)/api/v2/channels/\(slug)")!
        load(url) { result in
            completion(result.flatMap { data in
                Result {
                    let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
                    let user = json["user"] as? [String: Any]
                    let livestream = json["livestream"] as? [String: Any]
                    let live = livestream?["is_live"] as? Bool ?? false
                    return KickChannel(
                        slug: slug,
                        username: user?["username"] as? String ?? slug,
                        title: livestream?["session_title"] as? String ?? "",
                        avatar: (user?["profile_pic"] as? String).flatMap(URL.init(string:)),
                        playbackURL: live ? (json["playback_url"] as? String).flatMap(URL.init(string:)) : nil
                    )
                }
            })
        }
    }
}

/// Which renditions the master playlist keeps: the best video one, the one closest
/// to a height (1080, 720…), all video ones (AVFoundation switches quality, so no
/// prefetch: segments arriving as they're made look like a slow connection to it,
/// and it drops to 160p), or the audio-only one. Stored as best / 720 / auto / audio, the same values as the
/// extension's appQuality setting and kickoff://watch/{slug}?quality=.
enum Rendition: Equatable {
    case best, auto, audioOnly, height(Int)

    static let choices: [(title: String, rendition: Rendition)] = [
        (String(localized: "Best"), .best), ("1080p", .height(1080)), ("720p", .height(720)), ("480p", .height(480)),
        ("360p", .height(360)), ("160p", .height(160)), (String(localized: "Auto (More Delay)"), .auto),
        (String(localized: "Audio Only"), .audioOnly)
    ]

    init?(stored: String?) {
        switch stored {
        case "best": self = .best
        case "auto": self = .auto
        case "audio": self = .audioOnly
        case let value?:
            guard let height = Int(value), height > 0 else { return nil }
            self = .height(height)
        case nil: return nil
        }
    }

    var stored: String {
        switch self {
        case .best: return "best"
        case .auto: return "auto"
        case .audioOnly: return "audio"
        case .height(let height): return String(height)
        }
    }

    var title: String {
        Self.choices.first { $0.rendition == self }?.title ?? "\(stored)p"
    }
}

final class LivePlaylistLoader: NSObject, AVAssetResourceLoaderDelegate {
    static let scheme = "kickoff-hls"
    private static let queue = DispatchQueue(label: "net.smigi.Kickoff.playlists")

    static let prefetchSegments = 2
    static let startOffset = 3.0
    /// How far into the segment being made playback starts best (measured, 4 s
    /// segments); a little later is still fine, earlier lands a whole segment back.
    static let startPhase = 1.0
    static let startWindow = 0.6

    let rendition: Rendition
    var prefetch: Bool { rendition != .auto }
    /// Durations already given to AVFoundation, by media sequence number. A prefetch
    /// segment's is a guess (the previous one's); when it shows up for real it must
    /// keep the same value (4.166 vs 4.167 is enough for AVFoundation to stop).
    private var announced: [Int: String] = [:]
    private var startAt: Date? // when media playlists start being answered

    init(rendition: Rendition) {
        self.rendition = rendition
    }

    func asset(for master: URL) -> AVURLAsset {
        let asset = AVURLAsset(url: Self.swapScheme(master, to: Self.scheme))
        asset.resourceLoader.setDelegate(self, queue: Self.queue)
        return asset
    }

    private static func swapScheme(_ url: URL, to scheme: String) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.scheme = scheme
        return components.url!
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest) -> Bool {
        guard let url = loadingRequest.request.url, url.scheme == Self.scheme else { return false }
        respond(to: loadingRequest, from: Self.swapScheme(url, to: "https"))
        return true
    }

    private func respond(to loadingRequest: AVAssetResourceLoadingRequest, from real: URL) {
        KickAPI.load(real) { [weak self] result in
            Self.queue.async {
                guard let self = self else { return loadingRequest.finishLoading(with: URLError(.cancelled)) }
                switch result {
                case .failure(let error):
                    loadingRequest.finishLoading(with: error)
                case .success(let data):
                    let text = String(decoding: data, as: UTF8.self)
                    // Media playlists wait for a good moment to start (set by the first one;
                    // AVFoundation asks more than once), then are fetched again.
                    if self.prefetch, !text.contains("#EXT-X-STREAM-INF") {
                        let now = Date()
                        if self.startAt == nil {
                            self.startAt = now.addingTimeInterval(Self.waitForStart(text) ?? 0)
                        }
                        if let startAt = self.startAt, startAt > now {
                            Self.queue.asyncAfter(deadline: .now() + startAt.timeIntervalSince(now)) {
                                self.respond(to: loadingRequest, from: real)
                            }
                            return
                        }
                    }
                    let body = text.contains("#EXT-X-STREAM-INF") ? self.master(text, base: real) : self.media(text)
                    let out = Data(body.utf8)
                    if let info = loadingRequest.contentInformationRequest {
                        info.contentType = "public.m3u-playlist"
                        info.contentLength = Int64(out.count)
                        info.isByteRangeAccessSupported = false
                    }
                    loadingRequest.dataRequest?.respond(with: out)
                    loadingRequest.finishLoading()
                }
            }
        }
    }

    // Seconds until startPhase into the segment being made (it began where the last
    // listed one ends, by the timestamps); nil with short segments (it hardly matters
    // there), no timestamps, or a clock that's clearly off.
    private static func waitForStart(_ text: String) -> TimeInterval? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var end: Date?
        var segment = 0.0
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("#EXT-X-PROGRAM-DATE-TIME:") {
                end = formatter.date(from: String(line.dropFirst(25)))
            } else if line.hasPrefix("#EXTINF:"), let duration = Double(line.dropFirst(8).prefix { $0 != "," }) {
                end = end?.addingTimeInterval(duration)
                segment = duration
            }
        }
        guard segment >= 2, let end = end else { return nil }
        let phase = Date().timeIntervalSince(end)
        guard phase > -1, phase < segment + 1 else { return nil }
        if phase >= startPhase && phase <= startPhase + startWindow { return 0 }
        return phase < startPhase ? startPhase - phase : segment - phase + startPhase
    }

    // Master playlist: the renditions we want, their playlists back through us.
    private func master(_ text: String, base: URL) -> String {
        var header: [String] = []
        var variants: [(height: Int, bandwidth: Int, audio: Bool, lines: [String])] = []
        var tags: [String] = []
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            if line.hasPrefix("#") {
                if tags.isEmpty && !line.hasPrefix("#EXT-X-MEDIA:") && !line.hasPrefix("#EXT-X-STREAM-INF:") {
                    header.append(line)
                } else {
                    tags.append(line)
                }
                continue
            }
            guard let absolute = URL(string: line, relativeTo: base)?.absoluteURL else { tags = []; continue }
            let info = tags.first { $0.hasPrefix("#EXT-X-STREAM-INF:") } ?? ""
            let height = Self.attribute("RESOLUTION", in: info)?.split(separator: "x").last.flatMap { Int($0) } ?? 0
            let bandwidth = Self.attribute("BANDWIDTH", in: info).flatMap { Int($0) } ?? 0
            let name = tags.lazy.compactMap { Self.attribute("NAME", in: $0) }.first
            let audio = name == "audio_only" || !(Self.attribute("CODECS", in: info) ?? "avc").contains("avc")
            variants.append((height, bandwidth, audio, tags + [Self.swapScheme(absolute, to: Self.scheme).absoluteString]))
            tags = []
        }

        // Kick lists the renditions in a random order.
        let video = variants.filter { !$0.audio }.sorted { $0.bandwidth > $1.bandwidth }
        let kept: [(height: Int, bandwidth: Int, audio: Bool, lines: [String])]
        switch rendition {
        case .auto:
            kept = video
        case .best:
            kept = Array(video.prefix(1))
        case .audioOnly:
            kept = Array(variants.filter(\.audio).prefix(1))
        case .height(let wanted):
            // That height (its best frame rate), else the next one down, else the lowest.
            kept = Array((video.first { $0.height <= wanted } ?? video.last).map { [$0] } ?? [])
        }
        let lines = (kept.isEmpty ? Array(video.prefix(1)) : kept).flatMap(\.lines)
        return (header + (lines.isEmpty ? variants.flatMap(\.lines) : lines)).joined(separator: "\n") + "\n"
    }

    // Media playlist: the real target duration (the longest segment, rounded), and with
    // a fixed quality the prefetch segments as ordinary ones and the start point.
    private func media(_ text: String) -> String {
        let lines = text.components(separatedBy: "\n")
        let durations = lines.compactMap { line -> Double? in
            guard line.hasPrefix("#EXTINF:") else { return nil }
            return Double(line.dropFirst(8).prefix { $0 != "," })
        }
        let target = max(1, Int((durations.max() ?? 1).rounded()))
        let guess = String(format: "%.3f", durations.last ?? 1)
        let first = lines.first { $0.hasPrefix("#EXT-X-MEDIA-SEQUENCE:") }.flatMap { Int($0.dropFirst(22)) }

        var out: [String] = []
        var sequence = first ?? 0
        var prefetched = 0
        for line in lines {
            if line.hasPrefix("#EXT-X-TARGETDURATION:") {
                out.append("#EXT-X-TARGETDURATION:\(target)")
            } else if prefetch, first != nil, line.hasPrefix("#EXTINF:") {
                let duration = announced[sequence] ?? String(line.dropFirst(8).prefix { $0 != "," })
                announced[sequence] = duration
                out.append("#EXTINF:\(duration),live")
            } else if line.hasPrefix("#EXT-X-PREFETCH:") {
                prefetched += 1
                guard prefetch, first != nil, prefetched <= Self.prefetchSegments else { continue }
                let duration = announced[sequence] ?? guess
                announced[sequence] = duration
                out.append("#EXTINF:\(duration),live")
                out.append(String(line.dropFirst(16)))
                sequence += 1
            } else {
                out.append(line)
                if !line.isEmpty && !line.hasPrefix("#") { sequence += 1 }
            }
        }
        if let first = first { announced = announced.filter { $0.key >= first } }
        if prefetch, first != nil, let header = out.firstIndex(of: "#EXTM3U") {
            out.insert(String(format: "#EXT-X-START:TIME-OFFSET=-%.1f,PRECISE=YES", Self.startOffset), at: header + 1)
        }
        return out.joined(separator: "\n")
    }

    private static func attribute(_ name: String, in line: String) -> String? {
        guard let range = line.range(of: "\(name)=") else { return nil }
        let rest = line[range.upperBound...]
        if rest.hasPrefix("\"") {
            return rest.dropFirst().split(separator: "\"", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init)
        }
        return rest.split(separator: ",", maxSplits: 1).first.map(String.init)
    }
}
