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
