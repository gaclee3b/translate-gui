# translate-gui — cross-platform translation + TTS GUI

Type text → hear it spoken + translated. Uses Apple `say` and the Translation framework on macOS; `pyttsx3` + `argos-translate` on Windows. Optional Google engine for better translation quality and audio.

## What it does

- **Type text** in the input box and press **Say** (or Enter)
- The app **speaks** the text using the selected voice
- Optionally **translates** to a target language first (offline or via Google)
- Shows the translated text in the output box
- Maintains a collapsible **history** of recent utterances

## Platform Support

| Platform | Status | Engine |
|----------|--------|--------|
| macOS    | ✅ Full | Apple `say` + Translation framework (Swift helper) |
| Windows  | ✅ Full | pyttsx3 (SAPI5) + argos-translate |
| Linux    | ❌ Unsupported | — |

## Features

- **Local offline engine** — translation and TTS work without internet
  - macOS: Apple Translation framework (neural, on-device)
  - Windows: argos-translate + pyttsx3
- **Google online engine** — better translation quality + natural TTS audio
  - Uses free unofficial endpoints (no API key required, needs internet)
  - Audio cache with LRFU eviction (configurable size, default 100 MB)
  - Cache location: `~/Library/Caches/translate-gui/` (macOS) / `%LOCALAPPDATA%\translate-gui\cache\` (Windows)
  - Configurable cache max via GUI; clear-cache button
  - Automatic fallback to Local engine on network failure
- **Voice selection** — dropdown lists all installed system voices
- **Speed control** — slider (80–500 wpm for Local; 0.5–1.0× for Google)
- **Translation target** — dropdown filtered to your keyboard input languages
- **History** — collapsible list of last 20 utterances

## Install

### macOS

No dependencies beyond Python 3 + tkinter.

```bash
# Check dependencies
python3 translate_gui_general.py --check

# Build the Swift translation helper (first run only)
bash build_helper.sh

# Launch
python3 translate_gui_general.py
```

> **tkinter** must be installed. If missing:
> - Conda: `conda install -n py-opencode tk`
> - Homebrew: `brew install python-tk@3.14`
> - python.org: reinstall Python with "Install Tk 8.6" checked

### Windows

```bash
pip install pyttsx3 argos-translate playsound
```

Install argos-translate language models (example: English → Korean):

```python
from argostranslate import package
package.update_package_index()
pkg = next(p for p in package.get_available_packages()
           if p.from_code == 'en' and p.to_code == 'ko')
package.install_from_path(pkg.download())
```

Repeat for each language pair you want.

```bash
python translate_gui_general.py
```

## Google Engine Notes

- Uses free unofficial Google Translate / TTS endpoints (`client=gtx` / `client=tw-ob`)
- No API key required; requires internet connection
- Audio is cached to disk to reduce repeated fetches
- Cache uses LRFU (Least Recently / Frequently Used) eviction when the size limit is reached
- Cache location:
  - macOS: `~/Library/Caches/translate-gui/`
  - Windows: `%LOCALAPPDATA%\translate-gui\cache\`
- Cache size is configurable in the GUI (10–1000 MB, default 100 MB)
- If Google fails (network error, timeout), the app automatically falls back to the Local engine

## Usage

```bash
# Cross-platform (recommended)
python3 translate_gui_general.py
python3 translate_gui_general.py --check   # dependency check only

# macOS-only version (no Windows support)
python3 translate_gui.py

# macOS TTS-only (no translation)
python3 say_gui.py
```

## AI-Generated Disclosure

This project was generated with AI assistance. Code reviewed by human.

## License

MIT — see [LICENSE](LICENSE)

---

## Web version (browser)

A browser version of the same idea lives in [`docs/index.html`](docs/index.html) and is served by
GitHub Pages:

**<https://gaclee3b.github.io/translate-gui/>**

It is a single self-contained HTML file — no build step, no server, no dependencies, no CDN. Open it
and it works.

### What it does differently

| | Desktop app | Web version |
|---|---|---|
| Translation | Offline **or** Google | **Google only** |
| Speech | `say` / pyttsx3 (offline) | Browser `speechSynthesis` (offline) **or** Google TTS |
| Audio cache | LRFU on disk | Translation cache in `localStorage` (audio cannot be cached cross-origin) |
| Targets | Filtered to your keyboard layouts | All 19 target languages |
| Install | Python + tkinter | None |

The offline engines are gone by design. Apple's Translation framework, `say` and argos-translate are
local programs and cannot run in a browser. That is the trade for needing no server, no model
download and no maintenance. **Use the desktop app when you need offline translation.**

### Enabling Pages (one-time, manual)

1. Repo → **Settings** → **Pages**
2. **Source:** Deploy from a branch
3. **Branch:** `main` · **Folder:** `/docs`
4. Save — the site is live in about a minute

### Running the tests

[`docs/selftest.js`](docs/selftest.js) is an offline fixture harness — 122 assertions, no network,
no browser:

```bash
curl -sO https://raw.githubusercontent.com/gaclee3b/translate-gui/main/docs/index.html
curl -sO https://raw.githubusercontent.com/gaclee3b/translate-gui/main/docs/selftest.js
node selftest.js     # PASS  122 checks, 0 failures
```

It covers the parts that are easy to get quietly wrong: the 8000-character **encoded** request
budget (CJK percent-encodes 9×, so a plain character cap fails), code-point-safe splitting, strict
response parsing, the timeout-versus-cancellation distinction, and the rule that a partial Google-TTS
failure replays only the unplayed remainder.

### Notes and honest limitations

- Text is sent to **Google** for both translation and speech. There is no server in between, so there
  is nothing here that logs it beyond what Google itself does.
- Google's free endpoints are unofficial and rate-limit by IP. The page fails over between endpoints
  automatically. `translate.google.com/translate_a/single?client=dict-chrome-ex` is **not** used as a
  browser fallback because it sends no `Access-Control-Allow-Origin` header, so a page cannot fetch it.
- The page has been verified by its offline test suite and static analysis. It has not been verified
  in a real browser in CI, so audio autoplay policy and voice-list loading are worth a manual check.
