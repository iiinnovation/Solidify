// Development-only fixture generator. Writes synthetic content exclusively to
// the caller's private test directory; no business files or downloaded fonts.
import AppKit
import CoreGraphics

guard CommandLine.arguments.count == 2 else { fatalError("Expected a private output directory") }
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let width = 1600
let height = 700
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
let graphics = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = graphics
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 52), .foregroundColor: NSColor.black
]
for (index, line) in ["项目验收报告", "中文识别测试", "合同金额一百万元", "SOLIDIFY OCR VALIDATION"].enumerated() {
    (line as NSString).draw(at: NSPoint(x: 100, y: 540 - index * 125), withAttributes: attributes)
}
graphics.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("chinese.png"), options: .withoutOverwriting)
try bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.95])!.write(to: directory.appendingPathComponent("chinese.jpg"), options: .withoutOverwriting)

// Raster-only PDF: no embedded text layer that could bypass actual OCR.
var page = CGRect(x: 0, y: 0, width: 800, height: 350)
let consumer = CGDataConsumer(url: directory.appendingPathComponent("chinese-scan.pdf") as CFURL)!
let pdf = CGContext(consumer: consumer, mediaBox: &page, nil)!
for _ in 0..<2 {
    pdf.beginPDFPage(nil)
    pdf.draw(bitmap.cgImage!, in: page)
    pdf.endPDFPage()
}
pdf.closePDF()
