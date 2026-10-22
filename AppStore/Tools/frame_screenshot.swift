/// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import CoreGraphics
import CoreImage
import CoreText
import Foundation

// ---- args ----
// Copied from Dutch (Screenshots/Tools), with Kickon's gradients added.
// frame_screenshot.swift <bezel.png> <screenshot.png> <out.png> <headline> <subhead>
//                        [bg] [tiltDeg] [widthFrac] [offsetXFrac] [offsetYFrac]
//
// The whole app screenshot is ALWAYS shown uncropped inside the bezel. Variety comes from how the
// device sits on the canvas: tilt, how big it is (widthFrac), and where it sits (offsetX/offsetY).
let args = CommandLine.arguments
let bezelPath = args[1]
let shotPath  = args[2]
let outPath   = args[3]
let headline  = args.count > 4 ? args[4] : "Your whole world, one map"
let subhead   = args.count > 5 ? args[5] : "Every country you've touched, on a living map"
let bgPath    = args.count > 6 ? args[6] : "gradient"   // photo path or "gradient"
// tilt in degrees; positive = counter-clockwise. Useful range roughly -10…+10.
let tiltDeg: CGFloat = args.count > 7 ? CGFloat(Double(args[7]) ?? 4.0) : 4.0
// device width as a fraction of canvas width. <0.85 = pulled back, >1.0 = zoomed in / bleeding off the sides.
let widthFrac: CGFloat = args.count > 8 ? CGFloat(Double(args[8]) ?? 0.92) : 0.92
// device centre as a fraction of canvas size (0.5 = centred; y measured from the bottom).
let offsetXFrac: CGFloat = args.count > 9 ? CGFloat(Double(args[9]) ?? 0.50) : 0.50
let offsetYFrac: CGFloat = args.count > 10 ? CGFloat(Double(args[10]) ?? 0.385) : 0.385
// Canvas size. Defaults to the ASC iPhone 6.9" canvas; iPad landscape is 2752x2064.
let CW = args.count > 11 ? (Int(args[11]) ?? 1320) : 1320
let CH = args.count > 12 ? (Int(args[12]) ?? 2868) : 2868
// Multiplies the caption type sizes. A wider canvas needs bigger text to read at the same scale.
let typeScale: CGFloat = args.count > 13 ? CGFloat(Double(args[13]) ?? 1.0) : 1.0
// Everything tuned by eye on the 1320-wide iPhone canvas scales from it.
let canvasScale = CGFloat(CW) / 1320.0

let CS = CGColorSpaceCreateDeviceRGB()

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: CS, components: [r, g, b, a])!
}

func loadCG(_ path: String) -> CGImage {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("failed to load \(path)\n".data(using: .utf8)!)
        exit(1)
    }
    return cg
}

func makeCtx(_ w: Int, _ h: Int) -> CGContext {
    CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
              space: CS, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func rgba(_ cg: CGImage) -> (w: Int, h: Int, data: [UInt8]) {
    let w = cg.width, h = cg.height
    var data = [UInt8](repeating: 0, count: w * h * 4)
    data.withUnsafeMutableBytes { p in
        let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8,
                            bytesPerRow: w * 4, space: CS,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return (w, h, data)
}

func blurred(_ cg: CGImage, radius: Double) -> CGImage {
    let ci = CIImage(cgImage: cg).clampedToExtent()
    let f = CIFilter(name: "CIGaussianBlur")!
    f.setValue(ci, forKey: kCIInputImageKey)
    f.setValue(radius, forKey: kCIInputRadiusKey)
    let out = f.outputImage!
    let cictx = CIContext(options: nil)
    let extent = CGRect(x: 0, y: 0, width: cg.width, height: cg.height)
    return cictx.createCGImage(out, from: extent)!
}

// ---- detect the transparent screen cutout inside the bezel ----
// CGContext pixel space: row 0 = BOTTOM. We stay in this space throughout.
let bezelCG = loadCG(bezelPath)
let (bw, bh, bd) = rgba(bezelCG)
@inline(__always) func alpha(_ x: Int, _ y: Int) -> UInt8 { bd[(y * bw + x) * 4 + 3] }

var rowMin = [Int](repeating: Int.max, count: bh)
var rowMax = [Int](repeating: -1, count: bh)
var colMin = [Int](repeating: Int.max, count: bw)
var colMax = [Int](repeating: -1, count: bw)
for y in 0..<bh {
    for x in 0..<bw where alpha(x, y) > 128 {
        if x < rowMin[y] { rowMin[y] = x }
        if x > rowMax[y] { rowMax[y] = x }
        if y < colMin[x] { colMin[x] = y }
        if y > colMax[x] { colMax[x] = y }
    }
}
// screen = transparent pixels fully enclosed by opaque body on all four sides
//
// `screenMask` records the shape itself, not just its bounds. Filling the
// bounding box and trusting the bezel to mask the rounded screen corners does
// not work: the screen's corner radius and the device's are concentric and only
// ~75px apart, so the box's extreme corners fall *outside the device body
// altogether*, where the bezel is transparent and masks nothing. The screenshot
// then pokes out past the silhouette as four bright slivers — invisible on a
// dark app screen, glaring on a white one.
var sx0 = bw, sy0 = bh, sx1 = 0, sy1 = 0
var screenMask = [UInt8](repeating: 0, count: bw * bh)
for y in 0..<bh {
    for x in 0..<bw where alpha(x, y) < 40 {
        if x > rowMin[y] && x < rowMax[y] && y > colMin[x] && y < colMax[x] {
            if x < sx0 { sx0 = x }; if y < sy0 { sy0 = y }
            if x > sx1 { sx1 = x }; if y > sy1 { sy1 = y }
            screenMask[y * bw + x] = 255
        }
    }
}
let cut = CGRect(x: sx0, y: sy0, width: sx1 - sx0, height: sy1 - sy0)

// Grayscale, not a CGImageMask: as a plain gray image the value acts as an
// alpha, so 255 paints and 0 does not.
let maskImage: CGImage = {
    let provider = CGDataProvider(data: Data(screenMask) as CFData)!
    return CGImage(width: bw, height: bh, bitsPerComponent: 8, bitsPerPixel: 8,
                   bytesPerRow: bw, space: CGColorSpaceCreateDeviceGray(),
                   bitmapInfo: CGBitmapInfo(rawValue: 0), provider: provider,
                   decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
}()
FileHandle.standardError.write("bezel \(bw)x\(bh)  cutout x=\(sx0) y=\(sy0) w=\(Int(cut.width)) h=\(Int(cut.height)) aspect=\(String(format: "%.4f", cut.width/cut.height))\n".data(using: .utf8)!)

// ---- build the device image: screenshot aspect-filled into cutout, bezel on top ----
let shotCG = loadCG(shotPath)
let dctx = makeCtx(bw, bh)
dctx.interpolationQuality = .high
dctx.saveGState()
// Clip to the screen shape measured off the bezel's own alpha, not to a guessed
// corner radius and not to the cutout's bounding box. A guessed radius was tried
// first and it over-shot on iPad and MacBook while under-shooting on iPhone; the
// bounding box leaks at the corners (see `screenMask`). The bezel knows its own
// geometry, so ask it.
dctx.clip(to: CGRect(x: 0, y: 0, width: bw, height: bh), mask: maskImage)
let sAspect = max(cut.width / CGFloat(shotCG.width), cut.height / CGFloat(shotCG.height))
let dw = CGFloat(shotCG.width) * sAspect, dh = CGFloat(shotCG.height) * sAspect
dctx.draw(shotCG, in: CGRect(x: cut.midX - dw/2, y: cut.midY - dh/2, width: dw, height: dh))
dctx.restoreGState()
dctx.draw(bezelCG, in: CGRect(x: 0, y: 0, width: bw, height: bh))
let deviceImg = dctx.makeImage()!

// ---- caption layout (auto-fit: shrink, then wrap to 2 lines, for long localized strings) ----
// Laid out before the device is placed so the device can be pushed clear of a tall caption.
// Text stays centred on the canvas even when the device is offset.
let textCenterX = CGFloat(CW) * 0.5
let maxTextWidth = CGFloat(CW) * 0.88

// The colour must be baked into the line's attributes — CTLineDraw ignores the context fill colour.
func measure(_ s: String, size: CGFloat, weight: NSFont.Weight, tracking: CGFloat,
             color: CGColor) -> (CTLine, CGFloat) {
    let font = NSFont.systemFont(ofSize: size, weight: weight) as CTFont
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .kern: tracking, .foregroundColor: color]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
    var asc: CGFloat = 0, desc: CGFloat = 0, lead: CGFloat = 0
    let width = CGFloat(CTLineGetTypographicBounds(line, &asc, &desc, &lead))
    return (line, width)
}

// splits near the middle on a space, for a balanced 2-line wrap
func wrapNearMiddle(_ s: String) -> [String] {
    let words = s.split(separator: " ")
    guard words.count > 1 else { return [s] }
    var best = 1, bestDelta = Int.max, running = 0
    for i in 0..<(words.count - 1) {
        running += words[i].count + 1
        let delta = abs(running - s.count / 2)
        if delta < bestDelta { bestDelta = delta; best = i + 1 }
    }
    return [words[0..<best].joined(separator: " "), words[best...].joined(separator: " ")]
}

struct CaptionLayout {
    var lines: [CTLine]
    var widths: [CGFloat]
    var size: CGFloat
    var lineHeight: CGFloat
    var height: CGFloat
}

/// Shrinks to fit; if it still overflows at minSize, wraps to two lines and shrinks those instead.
func layoutFitted(_ s: String, baseSize: CGFloat, minSize: CGFloat,
                  weight: NSFont.Weight, tracking: CGFloat, color: CGColor) -> CaptionLayout {
    var size = baseSize
    var (line, width) = measure(s, size: size, weight: weight, tracking: tracking, color: color)
    while width > maxTextWidth && size > minSize {
        size -= 2 * typeScale
        (line, width) = measure(s, size: size, weight: weight, tracking: tracking, color: color)
    }
    var lines = [line], widths = [width]
    if width > maxTextWidth {
        let parts = wrapNearMiddle(s)
        if parts.count == 2 {
            size = baseSize
            var results = parts.map { measure($0, size: size, weight: weight, tracking: tracking, color: color) }
            while results.contains(where: { $0.1 > maxTextWidth }) && size > minSize {
                size -= 2 * typeScale
                results = parts.map { measure($0, size: size, weight: weight, tracking: tracking, color: color) }
            }
            lines = results.map { $0.0 }
            widths = results.map { $0.1 }
        }
    }
    let font = NSFont.systemFont(ofSize: size, weight: weight) as CTFont
    let lineHeight = CTFontGetAscent(font) + CTFontGetDescent(font) + CTFontGetLeading(font)
    return CaptionLayout(lines: lines, widths: widths, size: size,
                         lineHeight: lineHeight, height: lineHeight * CGFloat(lines.count))
}

// ---- place device (scaled + tilted) on a canvas-sized transparent layer ----
let scale = (CGFloat(CW) * widthFrac) / CGFloat(bw)
let centerX = CGFloat(CW) * offsetXFrac

// The caption is laid out FIRST, because long localized strings wrap to two lines and a tall
// caption block would otherwise collide with the device (Greek/Portuguese hit this). If the
// device's top edge would overlap the caption, it gets pushed down.
let captionTopY: CGFloat = CGFloat(CH) * (205.0 / 2868.0)
let captionGap: CGFloat = 20 * typeScale        // headline → subhead
let captionClearance: CGFloat = 56 * typeScale  // breathing room between caption and device

let headlineLayout = layoutFitted(headline, baseSize: 100 * typeScale, minSize: 76 * typeScale,
                                  weight: .heavy, tracking: -1 * typeScale, color: rgb(1, 1, 1))
let subheadLayout = layoutFitted(subhead, baseSize: 54 * typeScale, minSize: 46 * typeScale,
                                 weight: .semibold, tracking: 0, color: rgb(1, 1, 1, 0.92))
let captionBottomFromTop = captionTopY + headlineLayout.height + captionGap + subheadLayout.height

// Rotation makes the device's bounding box taller than bh*scale; account for it.
let tiltRad = abs(tiltDeg) * .pi / 180
let deviceHalfHeight = (CGFloat(bh) * cos(tiltRad) + CGFloat(bw) * sin(tiltRad)) * scale / 2
let maxCenterY = CGFloat(CH) - deviceHalfHeight - captionBottomFromTop - captionClearance
let centerY = min(CGFloat(CH) * offsetYFrac, maxCenterY)  // from bottom; low values bleed off the bottom

let pctx = makeCtx(CW, CH)
pctx.interpolationQuality = .high
pctx.saveGState()
pctx.translateBy(x: centerX, y: centerY)
pctx.rotate(by: tiltDeg * .pi / 180)
pctx.scaleBy(x: scale, y: scale)
pctx.draw(deviceImg, in: CGRect(x: -CGFloat(bw)/2, y: -CGFloat(bh)/2, width: CGFloat(bw), height: CGFloat(bh)))
pctx.restoreGState()
let placedImg = pctx.makeImage()!

// ---- final canvas ----
let ctx = makeCtx(CW, CH)
ctx.interpolationQuality = .high

// Gradient variants, so consecutive screens don't read as one repeated block.
//
// All of them are the app icon's own two colours pushed darker — the icon runs
// blue (0.384, 0.647, 1.000) into mint (0.259, 0.945, 0.745), which at full
// brightness is far too light to sit behind Dutch's screenshots. The app's UI is
// almost entirely white and pale grey, so a pale backdrop would leave the device
// with nothing to separate it from the canvas. Deepened, the same hues read as
// the same brand and the phone lifts off the page.
//
// Keep them in this family. The icon is the only visual identity a small app
// has, and a backdrop from some other palette quietly spends it.
func brandGradient(_ name: String) -> (CGGradient, CGPoint, CGPoint) {
    switch name {
    case "gradient-kick":
        // Kickon: near-black with the rocket's green coming up from one corner.
        let g = CGGradient(colorsSpace: CS, colors: [
            rgb(0.13, 0.36, 0.08), rgb(0.07, 0.16, 0.06),
            rgb(0.04, 0.06, 0.06), rgb(0.03, 0.04, 0.05)
        ] as CFArray, locations: [0.0, 0.34, 0.70, 1.0])!
        return (g, CGPoint(x: 0, y: 0), CGPoint(x: CGFloat(CW), y: CGFloat(CH)))
    case "gradient-kick-r":
        // The same, with the green coming up from the other corner, so
        // neighbouring frames don't read as one block.
        let g = CGGradient(colorsSpace: CS, colors: [
            rgb(0.13, 0.36, 0.08), rgb(0.07, 0.16, 0.06),
            rgb(0.04, 0.06, 0.06), rgb(0.03, 0.04, 0.05)
        ] as CFArray, locations: [0.0, 0.34, 0.70, 1.0])!
        return (g, CGPoint(x: CGFloat(CW), y: 0), CGPoint(x: 0, y: CGFloat(CH)))
    case "gradient-mint":
        // mint -> blue: the icon's ring gradient, darkened. The warmest variant.
        let g = CGGradient(colorsSpace: CS, colors: [
            rgb(0.16, 0.72, 0.62), rgb(0.14, 0.58, 0.68),
            rgb(0.14, 0.42, 0.78), rgb(0.12, 0.30, 0.66)
        ] as CFArray, locations: [0.0, 0.36, 0.74, 1.0])!
        return (g, CGPoint(x: CGFloat(CW) * 0.2, y: CGFloat(CH)), CGPoint(x: CGFloat(CW) * 0.8, y: 0))
    case "gradient-deep":
        // The darkest variant, for screens that are mostly white — the share
        // sheet in particular, which would otherwise float on a bright field.
        let g = CGGradient(colorsSpace: CS, colors: [
            rgb(0.13, 0.34, 0.66), rgb(0.10, 0.26, 0.56),
            rgb(0.08, 0.20, 0.44), rgb(0.06, 0.14, 0.32)
        ] as CFArray, locations: [0.0, 0.38, 0.74, 1.0])!
        return (g, CGPoint(x: CGFloat(CW), y: CGFloat(CH)), CGPoint(x: 0, y: 0))
    case "gradient-sky":
        // Near-vertical, a different axis from the default diagonal.
        let g = CGGradient(colorsSpace: CS, colors: [
            rgb(0.26, 0.60, 0.96), rgb(0.18, 0.46, 0.88),
            rgb(0.13, 0.34, 0.74), rgb(0.11, 0.24, 0.56)
        ] as CFArray, locations: [0.0, 0.40, 0.76, 1.0])!
        return (g, CGPoint(x: CGFloat(CW) * 0.5, y: CGFloat(CH)), CGPoint(x: CGFloat(CW) * 0.5, y: 0))
    default:
        // Default: blue -> mint -> deep blue, diagonal. The icon read left to right.
        let g = CGGradient(colorsSpace: CS, colors: [
            rgb(0.22, 0.56, 0.94), rgb(0.16, 0.60, 0.82),
            rgb(0.14, 0.42, 0.76), rgb(0.11, 0.26, 0.58)
        ] as CFArray, locations: [0.0, 0.40, 0.76, 1.0])!
        return (g, CGPoint(x: 0, y: CGFloat(CH)), CGPoint(x: CGFloat(CW), y: 0))
    }
}

let isGradient = bgPath.hasPrefix("gradient")

if !isGradient, FileManager.default.fileExists(atPath: bgPath) {
    // Photo backdrop: aspect-fill (cover). Only a whisper of blur — enough to keep the photo from
    // competing with the device, but the subject must stay clearly readable.
    let bg = blurred(loadCG(bgPath), radius: 3 * Double(canvasScale))
    let s = max(CGFloat(CW) / CGFloat(bg.width), CGFloat(CH) / CGFloat(bg.height))
    let bwd = CGFloat(bg.width) * s, bhd = CGFloat(bg.height) * s
    ctx.draw(bg, in: CGRect(x: (CGFloat(CW) - bwd)/2, y: (CGFloat(CH) - bhd)/2, width: bwd, height: bhd))
    // Very light brand tint — just enough to tie the photo to the palette, not to recolour it.
    ctx.setFillColor(rgb(0.14, 0.30, 0.74, 0.10))
    ctx.fill(CGRect(x: 0, y: 0, width: CW, height: CH))
    // Darken ONLY behind the caption (top) so text stays crisp; the photo reads clearly below it.
    let capScrim = CGGradient(colorsSpace: CS, colors: [
        rgb(0.05, 0.09, 0.24, 0.72), rgb(0.05, 0.09, 0.24, 0.0)
    ] as CFArray, locations: [0.0, 1.0])!
    ctx.drawLinearGradient(capScrim, start: CGPoint(x: 0, y: CH),
                           end: CGPoint(x: 0, y: CGFloat(CH) * 0.70), options: [])
    // Gentle floor scrim to ground the device where it bleeds off the bottom.
    let floorScrim = CGGradient(colorsSpace: CS, colors: [
        rgb(0.05, 0.09, 0.24, 0.42), rgb(0.05, 0.09, 0.24, 0.0)
    ] as CFArray, locations: [0.0, 1.0])!
    ctx.drawLinearGradient(floorScrim, start: CGPoint(x: 0, y: 0),
                           end: CGPoint(x: 0, y: CGFloat(CH) * 0.20), options: [])
} else {
    let (grad, gStart, gEnd) = brandGradient(bgPath)
    // Extend both ends, or any gradient whose axis doesn't span the full canvas
    // diagonal leaves the corners beyond it unpainted — a raw grey wedge in the
    // top-left of every `gradient-mint` frame. Endpoints are chosen for the
    // *direction* of the sweep; clamping is what makes that safe.
    ctx.drawLinearGradient(grad, start: gStart, end: gEnd,
                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    // Light caption scrim on gradients too — the brighter variants (teal/dusk) would otherwise
    // wash out the white headline.
    let capScrim = CGGradient(colorsSpace: CS, colors: [
        rgb(0.05, 0.10, 0.28, 0.42), rgb(0.05, 0.10, 0.28, 0.0)
    ] as CFArray, locations: [0.0, 1.0])!
    ctx.drawLinearGradient(capScrim, start: CGPoint(x: 0, y: CH),
                           end: CGPoint(x: 0, y: CGFloat(CH) * 0.72), options: [])
}

// soft radial glow behind the device
let glowY = centerY + CGFloat(CH) * 0.12
let glow = CGGradient(colorsSpace: CS, colors: [
    rgb(1, 1, 1, 0.22), rgb(1, 1, 1, 0.0)
] as CFArray, locations: [0.0, 1.0])!
ctx.drawRadialGradient(glow, startCenter: CGPoint(x: centerX, y: glowY), startRadius: 0,
                       endCenter: CGPoint(x: centerX, y: glowY), endRadius: 900 * canvasScale, options: [])

// device with a soft drop shadow (downward = -y in bottom-left space)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -34 * canvasScale), blur: 72 * canvasScale, color: rgb(0, 0, 0, 0.38))
ctx.draw(placedImg, in: CGRect(x: 0, y: 0, width: CW, height: CH))
ctx.restoreGState()

// ---- draw the captions laid out earlier ----
func draw(_ layout: CaptionLayout, topY: CGFloat) {
    var y = topY
    for (i, ln) in layout.lines.enumerated() {
        var asc: CGFloat = 0, desc: CGFloat = 0, lead: CGFloat = 0
        _ = CTLineGetTypographicBounds(ln, &asc, &desc, &lead)
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -3 * canvasScale), blur: 14 * canvasScale, color: rgb(0, 0, 0, 0.28))
        ctx.textPosition = CGPoint(x: textCenterX - layout.widths[i] / 2,
                                   y: CGFloat(CH) - (y + asc))
        CTLineDraw(ln, ctx)
        ctx.restoreGState()
        y += layout.lineHeight
    }
}

draw(headlineLayout, topY: captionTopY)
draw(subheadLayout, topY: captionTopY + headlineLayout.height + captionGap)

// ---- export ----
// Opaque: App Store Connect's screenshot spec says images "can't include alpha channels or
// transparencies". Every pixel here is already opaque, but the RGBA context still wrote an
// alpha channel into the PNG — which is what the spec checks, not the pixel values.
let opaqueCtx = CGContext(data: nil, width: CW, height: CH, bitsPerComponent: 8, bytesPerRow: 0,
                          space: CS, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
opaqueCtx.draw(ctx.makeImage()!, in: CGRect(x: 0, y: 0, width: CW, height: CH))
let outImg = opaqueCtx.makeImage()!
let rep = NSBitmapImageRep(cgImage: outImg)
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: outPath))
FileHandle.standardError.write("wrote \(outPath) (\(CW)x\(CH))\n".data(using: .utf8)!)
