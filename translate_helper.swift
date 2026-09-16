// translate_helper.swift — offline translation via Apple Translation framework.
//
// Protocol (one JSON line on stdin, one JSON line on stdout):
//   in:  {"text": "...", "source": "en_US"|null, "target": "fr_FR", "timeout": 20}
//   out: {"ok": true, "text": "...", "source": "...", "target": "..."}
//        {"ok": false, "error": "..."}
// Exit: 0 on success, 1 on error.
//
// Compile: swiftc -O -parse-as-library translate_helper.swift -o translate_helper
//
// Notes:
// - The Translation framework's async calls hang when run off the main actor,
//   so the whole program is an async @main entry point (runs on the main actor).
// - The LanguageAvailability.status(from:to:) gate is NOT used — it hangs on
//   some machines. Session/translate errors surface directly instead.
// - On this machine the installed English model is en_GB, not en_US, so
//   en_US requests fall back to en_GB when the model is missing.

import Foundation
import NaturalLanguage
import Translation

// MARK: - JSON output helpers

struct Output: Codable {
    let ok: Bool
    let text: String?
    let source: String?
    let target: String?
    let error: String?
}

func printJSON(_ output: Output) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(output) else { return }
    var out = data
    out.append(0x0A) // trailing newline
    FileHandle.standardOutput.write(out)
}

func fail(_ error: String) -> Never {
    printJSON(Output(ok: false, text: nil, source: nil, target: nil, error: error))
    exit(1)
}

// MARK: - NLLanguage -> locale string mapping

func localeString(for lang: NLLanguage) -> String? {
    switch lang {
    case .english: return "en_GB" // installed model on this machine is en_GB
    case .french: return "fr_FR"
    case .german: return "de_DE"
    case .spanish: return "es_ES"
    case .italian: return "it_IT"
    case .japanese: return "ja_JP"
    case .korean: return "ko_KR"
    case .simplifiedChinese: return "zh_CN"
    case .traditionalChinese: return "zh_TW"
    case .portuguese: return "pt_BR"
    case .russian: return "ru_RU"
    case .arabic: return "ar_AE"
    case .dutch: return "nl_NL"
    case .hindi: return "hi_IN"
    case .indonesian: return "id_ID"
    case .thai: return "th_TH"
    case .turkish: return "tr_TR"
    case .ukrainian: return "uk_UA"
    case .vietnamese: return "vi_VN"
    case .polish: return "pl_PL"
    default: return nil
    }
}

// MARK: - Error mapping

func mapError(_ error: Error) -> String {
    if let te = error as? TranslationError {
        switch te {
        case .nothingToTranslate: return "empty-text"
        case .notInstalled: return "models-not-downloaded"
        case .unsupportedSourceLanguage, .unsupportedTargetLanguage, .unsupportedLanguagePairing:
            return "unsupported-language-pair"
        case .unableToIdentifyLanguage: return "unable-to-detect-source"
        default: return "translation-failed"
        }
    }
    return "translation-failed"
}

// MARK: - Input

struct Input: Codable {
    let text: String
    let source: String?
    let target: String
    let timeout: Int?
}

// MARK: - Timeout

struct TimeoutError: Error {}

// MARK: - Main (async entry point runs on the main actor)

@main
struct TranslateHelper {
    static func main() async {
        let stdinData = FileHandle.standardInput.readDataToEndOfFile()
        let input: Input
        do {
            input = try JSONDecoder().decode(Input.self, from: stdinData)
        } catch {
            fail("invalid-input")
        }

        let text = input.text
        let target = input.target

        // Empty / whitespace-only text.
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            fail("empty-text")
        }

        // Detect source language if not provided.
        var source = input.source
        if source == nil {
            let recognizer = NLLanguageRecognizer()
            recognizer.processString(text)
            if let lang = recognizer.dominantLanguage, let loc = localeString(for: lang) {
                source = loc
            } else {
                fail("unable-to-detect-source")
            }
        }
        let src = source!

        // Same-language no-op.
        if src == target {
            printJSON(Output(ok: true, text: text, source: src, target: target, error: nil))
            exit(0)
        }

        // Timeout (default 20s, clamped to [5, 600]).
        let timeoutSeconds = min(max(input.timeout ?? 20, 5), 600)

        // Candidate sources: only en_GB is installed on this machine, so an
        // explicit en_US request falls back to en_GB when the model is missing.
        let candidates: [String] = (src == "en_US" || src == "en_GB") ? ["en_GB", "en_US"] : [src]

        let result: Output
        do {
            result = try await withThrowingTaskGroup(of: Output.self) { group in
                group.addTask {
                    var lastError = "translation-failed"
                    for cand in candidates {
                        do {
                            let session = TranslationSession(
                                installedSource: Locale.Language(identifier: cand),
                                target: Locale.Language(identifier: target))
                            let response = try await session.translate(text)
                            return Output(ok: true, text: response.targetText,
                                          source: cand, target: target, error: nil)
                        } catch {
                            let mapped = mapError(error)
                            if mapped == "models-not-downloaded" {
                                lastError = mapped
                                continue // try next candidate source
                            }
                            return Output(ok: false, text: nil, source: nil, target: nil, error: mapped)
                        }
                    }
                    return Output(ok: false, text: nil, source: nil, target: nil, error: lastError)
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                    throw TimeoutError()
                }
                let first = try await group.next()!
                group.cancelAll() // cancel the losing task (sleep or translate)
                return first
            }
        } catch {
            // TimeoutError (or cancellation) — the translate task was cancelled
            // when the group scope exited, so no late write can happen.
            result = Output(ok: false, text: nil, source: nil, target: nil, error: "timeout")
        }

        printJSON(result)
        exit(result.ok ? 0 : 1)
    }
}
