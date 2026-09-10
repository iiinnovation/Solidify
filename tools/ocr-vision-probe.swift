// Development-only candidate engine, never registered as a production tool.
import Foundation
import Vision
import ImageIO

guard CommandLine.arguments.count == 2 ||
    (CommandLine.arguments.count == 3 && CommandLine.arguments[2] == "--rgba") else {
    fatalError("Expected one staged image and optional --rgba")
}
let rawPixels = CommandLine.arguments.count == 3
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let started = ProcessInfo.processInfo.systemUptime
let request = VNRecognizeTextRequest()
request.revision = VNRecognizeTextRequestRevision3
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
request.automaticallyDetectsLanguage = false
request.minimumTextHeight = 0
request.usesCPUOnly = true
var result: [String: Any] = [
    "schemaVersion": 1,
    "engine": "Apple Vision",
    "inputEncoding": rawPixels ? "rgba8-1600x700" : "png-data",
    "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
    "requestRevision": request.revision,
    "recognitionLevel": "accurate",
    "recognitionLanguages": request.recognitionLanguages,
    "usesLanguageCorrection": request.usesLanguageCorrection,
    "automaticallyDetectsLanguage": request.automaticallyDetectsLanguage,
    "minimumTextHeight": request.minimumTextHeight,
    "usesCPUOnly": request.usesCPUOnly,
    "modelSource": "OS-managed Vision assets; independent model hash unavailable"
]
var status: Int32 = 0
do {
    let languages = try request.supportedRecognitionLanguages()
    result["supportedLanguages"] = languages
    guard request.recognitionLanguages.allSatisfy(languages.contains) else {
        throw NSError(domain: "SolidifyVisionProbe", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Requested languages unavailable"])
    }
    let bytes = try Data(contentsOf: input)
    let handler: VNImageRequestHandler
    if rawPixels {
        guard bytes.count == 1600 * 700 * 4,
              let provider = CGDataProvider(data: bytes as CFData),
              let image = CGImage(width: 1600, height: 700, bitsPerComponent: 8, bitsPerPixel: 32,
                  bytesPerRow: 1600 * 4, space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                  provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
            throw NSError(domain: "SolidifyVisionProbe", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Invalid fixed-size raw pixels"])
        }
        handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    } else {
        handler = VNImageRequestHandler(data: bytes, orientation: .up, options: [:])
    }
    try handler.perform([request])
    let observations: [[String: Any]] = (request.results ?? []).map { observation in
        guard let candidate = observation.topCandidates(1).first else {
            return ["text": "", "confidence": 0]
        }
        let box = observation.boundingBox
        return ["text": candidate.string, "confidence": candidate.confidence,
                "boundingBox": [box.origin.x, box.origin.y, box.width, box.height]]
    }
    result["observations"] = observations
    result["text"] = observations.map { $0["text"] as! String }.joined(separator: "\n") + "\n"
    result["success"] = true
} catch {
    let error = error as NSError
    result["success"] = false
    result["error"] = ["domain": error.domain, "code": error.code,
                       "description": error.localizedDescription]
    status = 1
}
result["durationMs"] = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([10]))
exit(status)
