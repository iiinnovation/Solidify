// Development-only, controlled synthetic corpus. Does not modify the original
// failing fixture. All outputs belong in the caller's private test directory.
import AppKit
import CoreGraphics
import CoreText
import Accelerate

guard CommandLine.arguments.count == 2 else { fatalError("Expected a private output directory") }
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let width = 1600
let height = 700
let amounts = [
    ("han", "一百万元"),
    ("financial", "壹佰万元整"),
    ("decimal", "1,234,567.89元"),
    ("currency", "￥98,765.40")
]
let fonts = ["PingFangSC-Regular", "STSongti-SC-Regular", "STHeitiSC-Light"]
var cases: [[String: Any]] = []
var pdfImages: [CGImage] = []
var pdfPages: [[String: Any]] = []

for (fontIndex, name) in fonts.enumerated() {
    guard let font = NSFont(name: name, size: 52) else { fatalError("Missing required font: \(name)") }
    // Refuse silent Chinese font fallback, otherwise a font comparison is false.
    let ctFont = CTFontCreateWithName(font.fontName as CFString, 52, nil)
    for (_, amount) in amounts {
        for character in "项目结算单合同金额中文识别测试" + amount {
            let text = String(character) as CFString
            let resolved = CTFontCreateForString(ctFont, text, CFRange(location: 0, length: CFStringGetLength(text)))
            precondition(CTFontCopyPostScriptName(resolved) as String == font.fontName,
                         "Font fallback for \(character) in \(name)")
        }
    }
    for layout in ["lines", "table"] {
        for (amountId, amount) in amounts {
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            let graphics = NSGraphicsContext(bitmapImageRep: bitmap)!
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = graphics
            NSColor.white.setFill()
            NSRect(x: 0, y: 0, width: width, height: height).fill()
            let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
            let lines = ["项目结算单", "合同金额 " + amount, "中文识别测试", "SOLIDIFY OCR CHECK"]
            for (index, line) in lines.enumerated() {
                let y = 540 - index * 125
                if layout == "table" && index == 1 {
                    ("合同金额" as NSString).draw(at: NSPoint(x: 100, y: y), withAttributes: attributes)
                    (amount as NSString).draw(at: NSPoint(x: 450, y: y), withAttributes: attributes)
                } else {
                    (line as NSString).draw(at: NSPoint(x: 100, y: y), withAttributes: attributes)
                }
            }
            if layout == "table" {
                NSColor.black.setStroke()
                let rules = NSBezierPath()
                rules.lineWidth = 2
                rules.appendRect(NSRect(x: 75, y: 140, width: 1450, height: 500))
                for y in [265, 390, 515] {
                    rules.move(to: NSPoint(x: 75, y: y))
                    rules.line(to: NSPoint(x: 1525, y: y))
                }
                rules.move(to: NSPoint(x: 400, y: 390))
                rules.line(to: NSPoint(x: 400, y: 515))
                rules.stroke()
            }
            graphics.flushGraphics()
            NSGraphicsContext.restoreGraphicsState()
            let sharp = bitmap.cgImage!
            // The blur controls are paired with PingFang sharp cases, not new
            // independent documents. CPU binomial 7x7 kernel, sigma ~1.225 px;
            // no GPU/OpenCL dependency or implicit black-image fallback.
            for degradation in fontIndex == 0 ? ["sharp", "blur-binomial-7"] : ["sharp"] {
                let rendered: CGImage
                if degradation == "sharp" {
                    rendered = sharp
                } else {
                    let blurred = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
                    var source = vImage_Buffer(data: bitmap.bitmapData!, height: vImagePixelCount(height),
                                               width: vImagePixelCount(width), rowBytes: bitmap.bytesPerRow)
                    var target = vImage_Buffer(data: blurred.bitmapData!, height: vImagePixelCount(height),
                                               width: vImagePixelCount(width), rowBytes: blurred.bytesPerRow)
                    let weights: [Int16] = [1, 6, 15, 20, 15, 6, 1]
                    let kernel = weights.flatMap { y in weights.map { x in x * y } }
                    let status = vImageConvolve_ARGB8888(&source, &target, nil, 0, 0,
                        kernel, 7, 7, 4096, nil, vImage_Flags(kvImageEdgeExtend))
                    precondition(status == kvImageNoError, "CPU blur failed: \(status)")
                    rendered = blurred.cgImage!
                }
                let id = "f\(fontIndex)-\(layout)-\(amountId)-\(degradation)"
                let output = NSBitmapImageRep(cgImage: rendered)
                try output.representation(using: .png, properties: [:])!.write(
                    to: directory.appendingPathComponent(id + ".png"), options: .withoutOverwriting)
                let page: [String: Any] = [
                    "id": id, "font": font.fontName, "fontSize": 52, "layout": layout,
                    "amountStyle": amountId, "amount": amount, "degradation": degradation,
                    "controlLines": [lines[0], lines[2], lines[3]]
                ]
                cases.append(["file": id + ".png", "pages": [page]])
                if layout == "lines" && amountId == "han" && degradation == "sharp" {
                    pdfImages.append(sharp)
                    pdfPages.append(page)
                }
            }
        }
    }
}

// Three different raster pages, one per font; paired PDF controls rather than
// three repeats of a page. No embedded text can bypass the OCR pipeline.
var mediaBox = CGRect(x: 0, y: 0, width: 800, height: 350)
let pdfURL = directory.appendingPathComponent("font-controls.pdf")
precondition(!FileManager.default.fileExists(atPath: pdfURL.path))
let consumer = CGDataConsumer(url: pdfURL as CFURL)!
let pdf = CGContext(consumer: consumer, mediaBox: &mediaBox, nil)!
for page in pdfImages {
    pdf.beginPDFPage(nil)
    pdf.draw(page, in: mediaBox)
    pdf.endPDFPage()
}
pdf.closePDF()
cases.append(["file": "font-controls.pdf", "pages": pdfPages])
let manifest: [String: Any] = ["schemaVersion": 1, "width": width, "height": height, "cases": cases]
try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys]).write(
    to: directory.appendingPathComponent("corpus.json"), options: .withoutOverwriting)
