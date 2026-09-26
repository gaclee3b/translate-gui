# Roadmap

## Mobile app (planned — not started)
Turn translate-gui into a phone app. Idea recorded 2026-09-15.

### Options considered
- **iOS native (SwiftUI)** — recommended. Reuses Apple Translation framework (same API as translate_helper.swift), AVSpeechSynthesizer for TTS, offline-capable, no Google 429 risk. Requires Mac + Xcode; App Store needs $99/yr Apple Developer account, sideload is free.
- **Android native (Kotlin)** — Google ML Kit translation (on-device, free), Android TextToSpeech.
- **Flutter** — one codebase for iOS + Android (google_mlkit_translation, flutter_tts), higher effort.
- **PWA** — lowest effort, but no offline, TTS quality varies.

### Open questions (decide before starting)
1. Platform: iOS only / Android only / both (Flutter)?
2. Distribution: App Store / TestFlight / sideload?
3. Offline requirement: must translation work without internet?
4. v1 scope: same features (translate + speak + history + cache) or trimmed?

### Technical notes for the port
- Apple Translation framework: same quirks as desktop (en_GB not en_US model, model download via system settings, async calls must stay on main actor)
- Google engine on mobile: prefer official ML Kit over the unofficial translate endpoints (anti-bot 429 risk)
- Audio cache: port the LRFU cache (count / (1 + age_hours) eviction, size limit, atomic metadata writes)
- TTS: AVSpeechSynthesizer (iOS) / Android TextToSpeech; Google TTS endpoint optional

## Web version — SHIPPED 2026-09-25
`docs/index.html`, one self-contained static page served by GitHub Pages. Google translate + Google
TTS, with the browser's own `speechSynthesis` for offline speech. No server, no build, no CDN.
Deliberately drops the offline engines: Apple's Translation framework, `say` and argos-translate are
local programs and cannot run in a browser. The desktop app remains the offline tool.

Architecture notes for whoever extends it:
- Translation and TTS sit behind one thin `PROVIDERS` registry in the page. Google is the only entry.
  **A second online provider is a new registry entry plus its own parse function** — the chunking,
  budget, cancellation, cache and UI layers must not learn about it. Candidates: LibreTranslate,
  MyMemory, DeepL, Edge/Bing TTS.
- The request budget is on the **percent-encoded** query (8000 chars), not the character count. CJK
  encodes 9×, so 2000 CJK characters is 18000 encoded and Google answers HTTP 400. Getting this
  wrong is the single easiest way to break CJK input.
- Cancellation uses a monotonic generation counter (`opGen`) plus an explicit `beginUserOperation()`
  that pauses prior audio. The generation check stops stale callbacks; only the explicit pause stops
  sound that is already playing.
- Only endpoints that actually send `Access-Control-Allow-Origin` are usable from a page. Two of the
  three Google translate endpoints qualify today.

## Mobile app (superseded in part by the web version)
The web page is now the cheapest path to "in my pocket" — it already works on a phone with no
install. A native app is still the only route to **offline** translation on a phone, so this section
stands if that requirement matters.
