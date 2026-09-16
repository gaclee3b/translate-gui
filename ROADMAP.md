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
