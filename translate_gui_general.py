#!/usr/bin/env python3
"""Adaptive cross-platform translation GUI.

macOS:  `say` subprocess TTS + Swift translate_helper binary (Apple Translation
        framework, offline models).
Windows: pyttsx3 TTS (SAPI5) + argos-translate (offline neural models).

Layout mirrors scripts/translate_gui.py (the macOS reference implementation).
"""
import sys

IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform.startswith("win")

if not (IS_MAC or IS_WIN):
    print("translate_gui_general.py: unsupported platform — this tool supports "
          "macOS and Windows only.", file=sys.stderr)
    sys.exit(1)

try:
    import tkinter as tk
    from tkinter import ttk, messagebox
except ImportError:
    tk = None

import hashlib
import importlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

if IS_MAC:
    import plistlib
if IS_WIN:
    import winreg

# ── Platform-aware dependency check ───────────────────────────────────
CRITICAL_MODULES = ["tkinter"]
REQUIRED_MODULES = ["json", "os", "subprocess", "threading", "re",
                    "importlib", "shutil", "sys"]
if IS_MAC:
    REQUIRED_MODULES.append("plistlib")

EXTERNAL_BINARIES: dict[str, str] = {}   # macOS only
PIP_MODULES: dict[str, str] = {}         # Windows only
INSTALL_HINTS: dict[str, str] = {
    "tkinter": "conda: `conda install -n py-opencode tk` | Homebrew: `brew install python-tk@3.14` | python.org: reinstall with 'Install Tk 8.6' checked",
}

if IS_MAC:
    EXTERNAL_BINARIES = {"swiftc": "translation (compiles helper)",
                         "say": "speech output"}
    INSTALL_HINTS["swiftc"] = "`xcode-select --install` (Command Line Tools)"
    INSTALL_HINTS["say"] = "part of macOS — should never be missing"

if IS_WIN:
    PIP_MODULES = {"pyttsx3": "speech output",
                   "argostranslate": "translation",
                   "playsound": "Google TTS playback (online engine)"}
    INSTALL_HINTS["pyttsx3"] = "`pip install pyttsx3`"
    INSTALL_HINTS["argostranslate"] = "`pip install argos-translate`"
    INSTALL_HINTS["playsound"] = "`pip install playsound`"
    INSTALL_HINTS["argos-translate models"] = (
        "install models via the official API:\n"
        "  from argostranslate import package\n"
        "  package.update_package_index()\n"
        "  pkg = next(p for p in package.get_available_packages()\n"
        "             if p.from_code == 'en' and p.to_code == 'ko')\n"
        "  package.install_from_path(pkg.download())"
    )


def check_dependencies():
    """Check runtime dependencies; print a report to stderr.

    Returns (missing_critical, missing_required, missing_external,
             missing_pip, missing_models).
    """
    missing_critical: list[str] = []
    missing_required: list[str] = []
    missing_external: list[str] = []
    missing_pip: list[str] = []
    missing_models: list[str] = []

    for mod in CRITICAL_MODULES + REQUIRED_MODULES:
        try:
            importlib.import_module(mod)
        except ImportError:
            (missing_critical if mod in CRITICAL_MODULES else missing_required).append(mod)

    for bin_name in EXTERNAL_BINARIES:
        if shutil.which(bin_name) is None:
            missing_external.append(bin_name)

    if IS_WIN:
        for mod in PIP_MODULES:
            try:
                importlib.import_module(mod)
            except ImportError:
                missing_pip.append(mod)
        if "argostranslate" not in missing_pip:
            try:
                from argostranslate import translate as at
                if not at.get_installed_languages():
                    missing_models.append("argos-translate models")
            except Exception:
                missing_models.append("argos-translate models")

    print("translate_gui_general.py dependency check:", file=sys.stderr)
    if missing_critical or missing_required or missing_external or missing_pip or missing_models:
        for mod in missing_critical:
            print(f"MISSING (fatal): {mod} — GUI cannot start", file=sys.stderr)
            print(f"  Fix: {INSTALL_HINTS.get(mod, 'install the missing package')}", file=sys.stderr)
        for mod in missing_required:
            print(f"MISSING (fatal): {mod} — required module", file=sys.stderr)
            print(f"  Fix: {INSTALL_HINTS.get(mod, 'install the missing package')}", file=sys.stderr)
        for bin_name in missing_external:
            print(f"MISSING (warning): {bin_name} — {EXTERNAL_BINARIES[bin_name]}", file=sys.stderr)
            print(f"  Fix: {INSTALL_HINTS.get(bin_name, 'install the missing package')}", file=sys.stderr)
        for mod in missing_pip:
            print(f"MISSING (warning): {mod} — {PIP_MODULES[mod]}", file=sys.stderr)
            print(f"  Fix: {INSTALL_HINTS.get(mod, 'install the missing package')}", file=sys.stderr)
        for mod in missing_models:
            print(f"MISSING (warning): {mod} — translation models not installed", file=sys.stderr)
            print(f"  Fix: {INSTALL_HINTS.get(mod, 'install the missing package')}", file=sys.stderr)
    else:
        print("All dependencies present.", file=sys.stderr)

    return missing_critical, missing_required, missing_external, missing_pip, missing_models

# Apple "Novelty" voices — sound effects layered over base voices, not clean speech.
NOVELTY_VOICES = frozenset({
    "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos",
    "Good News", "Jester", "Organ", "Superstar", "Trinoids",
    "Whisper", "Wobble", "Zarvox",
})

# ── Translation target locales (shared by both platforms) ─────────────
# Ordered (locale, display) pairs for the target-language dropdown.
TRANSLATION_LOCALES = [
    ("ar_AE", "Arabic"),
    ("de_DE", "German"),
    ("en_GB", "English (UK)"),
    ("en_US", "English (US)"),
    ("es_ES", "Spanish"),
    ("fr_FR", "French"),
    ("hi_IN", "Hindi"),
    ("id_ID", "Indonesian"),
    ("it_IT", "Italian"),
    ("ja_JP", "Japanese"),
    ("ko_KR", "Korean"),
    ("nl_NL", "Dutch"),
    ("pl_PL", "Polish"),
    ("pt_BR", "Portuguese"),
    ("ru_RU", "Russian"),
    ("th_TH", "Thai"),
    ("tr_TR", "Turkish"),
    ("uk_UA", "Ukrainian"),
    ("vi_VN", "Vietnamese"),
    ("zh_CN", "Chinese (Simplified)"),
    ("zh_TW", "Chinese (Traditional)"),
]

# Native-language targets are pointless — keeps model downloads limited to zh/ko.
EXCLUDED_TARGETS = {"en_US", "en_GB"}

# Reverse map: argos 2-letter code -> display name (first locale wins; zh → Simplified).
ARGOS_CODE_TO_DISPLAY = {}
for _loc, _disp in TRANSLATION_LOCALES:
    ARGOS_CODE_TO_DISPLAY.setdefault(_loc.split("_")[0], _disp)

# ── Google (online) engine ───────────────────────────────────────────
# Locale -> Google Translate/TTS language code.
LOCALE_TO_GOOGLE_CODE = {
    "ar_AE": "ar", "de_DE": "de", "en_GB": "en-GB", "en_US": "en",
    "es_ES": "es", "fr_FR": "fr", "hi_IN": "hi", "id_ID": "id",
    "it_IT": "it", "ja_JP": "ja", "ko_KR": "ko", "nl_NL": "nl",
    "pl_PL": "pl", "pt_BR": "pt", "ru_RU": "ru", "th_TH": "th",
    "tr_TR": "tr", "uk_UA": "uk", "vi_VN": "vi", "zh_CN": "zh-CN",
    "zh_TW": "zh-TW",
}

GOOGLE_UA = "Mozilla/5.0"
GOOGLE_TIMEOUT = 10
GOOGLE_SPEED_BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
TTS_CHUNK_LIMIT = 200

# Google Translate endpoints, tried in order (translate.googleapis.com is
# frequently 429-blocked from some networks; the others are alternates).
# All three return the same JSON shape: data[0] = list of segments
# (seg[0] = text), data[2] = detected source code.
GOOGLE_TRANSLATE_ENDPOINTS = [
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={tl}&dt=t&q={q}",
    "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl={tl}&q={q}",
    "https://translate.google.com/translate_a/single?client=dict-chrome-ex&sl=auto&tl={tl}&dt=t&q={q}",
]
GOOGLE_TRANSLATE_RETRIES = 2          # retries per endpoint, after the first attempt
GOOGLE_TRANSLATE_BACKOFF = [1.0, 2.0]  # seconds to sleep between retries


def clamp(value, lo, hi):
    return max(lo, min(hi, value))


def speed_to_bucket(wpm: int) -> float:
    """Map the wpm slider (80–500) to the nearest Google ttsspeed bucket (0.5–1.0)."""
    frac = (wpm - 80) / (500 - 80)
    idx = round(frac * (len(GOOGLE_SPEED_BUCKETS) - 1))
    idx = max(0, min(idx, len(GOOGLE_SPEED_BUCKETS) - 1))
    return GOOGLE_SPEED_BUCKETS[idx]


def chunk_text_for_tts(text: str, limit: int = TTS_CHUNK_LIMIT):
    """Split text into chunks <= limit chars on sentence boundaries (delimiters kept).

    Returns a list of chunks, or None when a single sentence exceeds the limit
    (Google TTS cannot be chunked safely then — caller falls back to Local).
    """
    if len(text) <= limit:
        return [text]
    parts = [p for p in re.split(r"(?<=[。！？.!?])", text) if p]
    chunks: list[str] = []
    current = ""
    for part in parts:
        if len(part) > limit:
            return None
        if len(current) + len(part) <= limit:
            current += part
        else:
            if current:
                chunks.append(current)
            current = part
    if current:
        chunks.append(current)
    return chunks


def cache_key(text: str, lang: str, bucket: float) -> str:
    """Cache key: sha1 of json.dumps([text, lang, bucket]) — json.dumps avoids
    separator collisions (e.g. ("a,b", "c") vs ("a", "b,c"))."""
    payload = json.dumps([text, lang, bucket])
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def google_translate(text: str, target_code: str) -> tuple[str, str]:
    """Google Translate with endpoint failover + retry/backoff.

    Tries GOOGLE_TRANSLATE_ENDPOINTS in order; each endpoint gets
    GOOGLE_TRANSLATE_RETRIES retries with GOOGLE_TRANSLATE_BACKOFF sleep
    between attempts. All endpoints return the same shape: data[0] is a list
    of segments (seg[0] = text, joined), data[2] is the detected source code.

    Returns (translated, detected_source_code). Raises on total failure —
    caller falls back to Local.
    """
    q = urllib.parse.quote(text, safe='')
    tl = urllib.parse.quote(target_code, safe='')
    last_err: Exception | None = None
    for template in GOOGLE_TRANSLATE_ENDPOINTS:
        url = template.format(tl=tl, q=q)
        for attempt in range(GOOGLE_TRANSLATE_RETRIES + 1):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": GOOGLE_UA})
                with urllib.request.urlopen(req, timeout=GOOGLE_TIMEOUT) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                segments = data[0] if data and data[0] else []
                if segments and isinstance(segments[0], str):
                    # Flat shape (clients5.google.com dict-chrome-ex):
                    # data[0] = [translated_text, detected_source]
                    translated = segments[0]
                    detected = segments[1] if len(segments) > 1 else ""
                else:
                    # Segment shape (translate_a/single): data[0] = list of
                    # segments (seg[0] = text), data[2] = detected source.
                    translated = "".join(seg[0] for seg in segments if seg and seg[0])
                    detected = data[2] if len(data) > 2 and data[2] else ""
                return translated, detected
            except Exception as e:
                last_err = e
                if attempt < GOOGLE_TRANSLATE_RETRIES:
                    time.sleep(GOOGLE_TRANSLATE_BACKOFF[attempt])
    if last_err is not None:
        raise last_err
    raise RuntimeError("google translate failed")


def google_tts_fetch(text: str, lang: str, bucket: float) -> bytes:
    """Google TTS (client=tw-ob). Returns MP3 bytes (possibly empty = error)."""
    url = ("https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob"
           f"&tl={urllib.parse.quote(lang, safe='')}"
           f"&q={urllib.parse.quote(text, safe='')}"
           f"&ttsspeed={bucket}")
    req = urllib.request.Request(url, headers={"User-Agent": GOOGLE_UA})
    with urllib.request.urlopen(req, timeout=GOOGLE_TIMEOUT) as resp:
        return resp.read()


# ── Config ───────────────────────────────────────────────────────────
DEFAULT_CONFIG = {"engine": "local", "cache_max_mb": 100}


def config_path() -> str:
    if IS_MAC:
        return os.path.join(os.path.expanduser("~/.config/translate-gui"), "config.json")
    if IS_WIN:
        base = os.environ.get("APPDATA")
        if base:
            return os.path.join(base, "translate-gui", "config.json")
    return os.path.join(os.path.expanduser("~/.config/translate-gui"), "config.json")


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(config_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            if data.get("engine") in ("local", "google"):
                cfg["engine"] = data["engine"]
            mb = data.get("cache_max_mb")
            if isinstance(mb, (int, float)) and not isinstance(mb, bool):
                cfg["cache_max_mb"] = int(clamp(mb, 10, 1000))
    except Exception:
        pass
    return cfg


def save_config(cfg: dict) -> None:
    try:
        d = os.path.dirname(config_path())
        os.makedirs(d, exist_ok=True)
        with open(config_path(), "w", encoding="utf-8") as f:
            json.dump(cfg, f)
    except Exception:
        pass


# ── Audio cache (hybrid LRFU, disk-backed) ───────────────────────────
class AudioCache:
    """Disk cache for Google TTS MP3s with hybrid LRFU eviction.

    One threading.Lock guards ALL metadata read/write/prune operations
    (TTS worker thread + GUI thread both touch it). Metadata writes are
    atomic: write cache_meta.json.tmp then os.replace().
    """

    def __init__(self, max_mb: int, cache_dir: str | None = None):
        self.max_bytes = max_mb * 1024 * 1024
        self._lock = threading.Lock()
        self._meta: dict | None = None  # lazy-loaded under lock
        self._dir = cache_dir if cache_dir is not None else self._resolve_dir()
        self._usable = self._dir is not None
        self._meta_path = os.path.join(self._dir, "cache_meta.json") if self._usable else None

    # -- paths --------------------------------------------------------
    @staticmethod
    def _resolve_dir() -> str | None:
        if IS_MAC:
            base = os.path.expanduser("~/Library/Caches/translate-gui")
        elif IS_WIN:
            base = os.path.join(os.environ.get("LOCALAPPDATA", ""), "translate-gui", "cache")
            if not os.environ.get("LOCALAPPDATA"):
                base = os.path.expanduser("~/.cache/translate-gui")
        else:
            base = os.path.expanduser("~/.cache/translate-gui")
        try:
            os.makedirs(base, exist_ok=True)
            return base
        except Exception:
            return None  # caching disabled gracefully; fetch→temp→play continues

    def _path_for(self, key: str) -> str:
        return os.path.join(self._dir, key + ".mp3")

    def is_cached_path(self, path: str) -> bool:
        return self._usable and path.startswith(self._dir)

    # -- metadata -----------------------------------------------------
    def _load_meta_locked(self) -> dict:
        if self._meta is None:
            self._meta = self._read_meta_file()
        return self._meta

    def _read_meta_file(self) -> dict:
        try:
            with open(self._meta_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                cleaned = {}
                for k, v in data.items():
                    if (isinstance(v, dict)
                            and isinstance(v.get("count"), int)
                            and isinstance(v.get("last_access"), (int, float))
                            and isinstance(v.get("size"), int)):
                        cleaned[k] = v
                return cleaned
        except Exception:
            pass
        return {}

    def _save_meta_locked(self, meta: dict) -> None:
        if not self._usable:
            return
        tmp = self._meta_path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(meta, f)
            os.replace(tmp, self._meta_path)
        except Exception:
            pass

    # -- LRFU eviction ------------------------------------------------
    def _prune_locked(self, meta: dict) -> bool:
        """Evict lowest-score entries until total size <= max_bytes.

        score = count / (1 + age_hours). Returns True if anything was evicted.
        """
        total = sum(m["size"] for m in meta.values())
        if total <= self.max_bytes:
            return False
        now = time.time()
        scored = sorted(
            meta.items(),
            key=lambda kv: kv[1]["count"] / (1 + (now - kv[1]["last_access"]) / 3600.0),
        )
        for key, m in scored:
            if total <= self.max_bytes:
                break
            meta.pop(key)
            total -= m["size"]
            try:
                os.remove(self._path_for(key))
            except OSError:
                pass
        return True

    # -- public API ---------------------------------------------------
    def get_audio(self, text: str, lang: str, bucket: float) -> tuple[str | None, str | None]:
        """Return (path, None) on success; (None, error) on failure.

        Cache hit: bump count/last_access under lock, return cached file.
        Miss: fetch MP3; empty body = error (never cached); write file + meta.
        When the cache dir is unusable: fetch → temp file → play, no cache write.
        """
        key = cache_key(text, lang, bucket)
        if self._usable:
            path = self._path_for(key)
            with self._lock:
                meta = self._load_meta_locked()
                if key in meta:
                    meta[key]["count"] += 1
                    meta[key]["last_access"] = time.time()
                    self._save_meta_locked(meta)
                    return path, None
        try:
            data = google_tts_fetch(text, lang, bucket)
        except Exception as e:
            return None, f"Google TTS failed ({e})"
        if len(data) == 0:
            return None, "Google TTS failed (empty response)"
        if self._usable:
            with self._lock:
                try:
                    with open(path, "wb") as f:
                        f.write(data)
                except Exception:
                    return None, "cache write failed"
                meta = self._load_meta_locked()
                meta[key] = {"count": 1, "last_access": time.time(), "size": len(data)}
                self._prune_locked(meta)
                self._save_meta_locked(meta)
            return path, None
        # caching disabled → temp file
        try:
            fd, tmp = tempfile.mkstemp(suffix=".mp3", prefix="tts-")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            return tmp, None
        except Exception as e:
            return None, f"temp file failed ({e})"

    def set_max_mb(self, mb: int) -> None:
        self.max_bytes = mb * 1024 * 1024
        if not self._usable:
            return
        with self._lock:
            meta = self._load_meta_locked()
            if self._prune_locked(meta):
                self._save_meta_locked(meta)

    def prune_startup(self) -> None:
        """Background startup prune — never blocks GUI startup."""
        if not self._usable:
            return
        with self._lock:
            meta = self._load_meta_locked()
            if self._prune_locked(meta):
                self._save_meta_locked(meta)

    def clear(self) -> int | None:
        """Delete all cached MP3s + metadata. Returns file count, or None if unusable."""
        if not self._usable:
            return None
        with self._lock:
            meta = self._load_meta_locked()
            n = len(meta)
            for key in meta:
                try:
                    os.remove(self._path_for(key))
                except OSError:
                    pass
            self._meta = {}
            self._save_meta_locked({})
            return n

# ── macOS: keyboard layout name -> locale (com.apple.HIToolbox) ───────
KEYBOARD_LAYOUT_TO_LOCALE = {
    "U.S.": "en_US", "ABC": "en_US",
    "British": "en_GB",
    "French": "fr_FR",
    "German": "de_DE",
    "Spanish": "es_ES",
    "Italian": "it_IT",
    "Portuguese": "pt_BR",
    "Dutch": "nl_NL",
    "Russian": "ru_RU",
    "Ukrainian": "uk_UA",
    "Polish": "pl_PL",
    "Turkish": "tr_TR",
    "Thai": "th_TH",
    "Vietnamese": "vi_VN",
    "Arabic": "ar_AE",
    "Hindi": "hi_IN",
    "Indonesian": "id_ID",
    "Korean": "ko_KR",
    "Japanese": "ja_JP",
    "Pinyin-Simplified": "zh_CN", "Chinese-Simplified": "zh_CN",
    "Pinyin-Traditional": "zh_TW", "Chinese-Traditional": "zh_TW",
}

# macOS: input method bundle ID / input mode -> locale.
INPUT_METHOD_TO_LOCALE = {
    "com.apple.inputmethod.Korean": "ko_KR",
    "com.apple.inputmethod.Japanese": "ja_JP",
    "com.apple.inputmethod.SCIM": "zh_CN",
    "com.apple.inputmethod.TCIM": "zh_TW",
    "com.apple.inputmethod.Roman": "en_US",
    "com.apple.inputmethod.TCIM.Pinyin": "zh_TW",
    "com.apple.inputmethod.SCIM.ITABC": "zh_CN",
}

# ── Windows: HKCU\Keyboard Layout\Preload LCID -> locale ──────────────
LCID_TO_LOCALE = {
    0x0409: "en_US", 0x0412: "ko_KR", 0x0804: "zh_CN", 0x0404: "zh_TW",
    0x040C: "fr_FR", 0x0407: "de_DE", 0x0410: "it_IT", 0x0411: "ja_JP",
    0x0413: "nl_NL", 0x0415: "pl_PL", 0x0416: "pt_BR", 0x0419: "ru_RU",
    0x041E: "th_TH", 0x041F: "tr_TR", 0x0422: "uk_UA", 0x042A: "vi_VN",
    0x3801: "ar_AE", 0x0439: "hi_IN", 0x0421: "id_ID", 0x0C0A: "es_ES",
}


def parse_lcid_values(values):
    """Map raw HKCU\\Keyboard Layout\\Preload values to locales.

    Values are 8-char hex LCID STRINGS (e.g. "00000412"); unsupported LCIDs
    are silently skipped.
    """
    locales: list[str] = []
    for v in values:
        try:
            lcid = int(v, 16)
        except (ValueError, TypeError):
            continue
        loc = LCID_TO_LOCALE.get(lcid)
        if loc and loc not in locales:
            locales.append(loc)
    return locales


# ── Windows: pyttsx3 voice locale normalization ───────────────────────
_LOCALE_RE = re.compile(r"([a-zA-Z]{2,3})[-_]([A-Za-z]{2})(?![A-Za-z])")
_KNOWN_LANGS = frozenset({"en", "fr", "de", "es", "it", "ja", "ko", "zh", "pt",
                          "ru", "ar", "nl", "hi", "id", "th", "tr", "uk", "vi", "pl"})


def locale_from_id(s):
    """Extract a locale like 'en_US' from a raw voice id/name string.

    SAPI5 ids look like '...TTS_MS_EN-US_DAVID_11.0' — prefer the match whose
    first group is a known language code (e.g. 'EN-US' over 'MS_EN').
    """
    best = None
    for m in _LOCALE_RE.finditer(s or ""):
        lang = m.group(1).lower()
        if lang in _KNOWN_LANGS:
            return f"{lang}_{m.group(2).upper()}"
        if best is None:
            best = m
    if best:
        return f"{best.group(1).lower()}_{best.group(2).upper()}"
    return None


def normalize_voice_locale(langs, vid="", name=""):
    """Normalize a pyttsx3 voice's locale: 'en-US' -> 'en_US'.

    Falls back to parsing the raw voice id / name when the languages list is
    empty (common on SAPI5 drivers).
    """
    if langs:
        return str(langs[0]).replace("-", "_")
    return locale_from_id(vid) or locale_from_id(name) or ""


# ── Windows: argos-translate core call ────────────────────────────────
def argos_translate(text, src_code, tgt_code, langs):
    """Core argos-translate call.

    langs = argostranslate.translate.get_installed_languages().
    Returns the translated string, or None when either model is not installed.
    """
    src_lang = next((l for l in langs if l.code == src_code), None)
    tgt_lang = next((l for l in langs if l.code == tgt_code), None)
    if src_lang is None or tgt_lang is None:
        return None
    return src_lang.get_translation(tgt_lang).translate(text)


class TranslateGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("Translate & Speak")
        self.root.minsize(500, 0)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self.history: list[str] = []
        self.history_visible = False
        self.current_proc: subprocess.Popen | None = None  # macOS `say`
        self.helper_proc: subprocess.Popen | None = None   # macOS helper
        self._compile_thread: threading.Thread | None = None
        self._translate_gen = 0   # supersede stale translate results
        self._tts_gen = 0         # Windows cancel flag (generation token)
        self._tts_thread: threading.Thread | None = None
        self._playback_proc: subprocess.Popen | None = None  # Google MP3 player
        self._google_gen = 0      # Google playback cancel token

        self.config = load_config()
        self.cache = AudioCache(self.config["cache_max_mb"])
        threading.Thread(target=self.cache.prune_startup, daemon=True).start()

        if IS_WIN:
            self._init_pyttsx3()

        self.voices = self._load_voices()  # [(display, raw_id), ...]
        self._build_ui()

    # ------------------------------------------------------------------
    def _init_pyttsx3(self):
        """Single engine instance for the whole session (SAPI5 leaks COM objects otherwise)."""
        self.tts_engine = None
        try:
            import pyttsx3
            self.tts_engine = pyttsx3.init()
        except Exception:
            self.tts_engine = None

    # ------------------------------------------------------------------
    def _load_voices(self) -> list[tuple[str, str]]:
        if IS_MAC:
            return self._load_voices_mac()
        return self._load_voices_win()

    def _load_voices_mac(self) -> list[tuple[str, str]]:
        try:
            out = subprocess.check_output(["say", "-v", "?"], text=True,
                                          stderr=subprocess.DEVNULL, timeout=10)
        except Exception:
            return [("Default", "")]
        entries = []
        seen = set()
        for line in out.splitlines():
            head = line.partition("#")[0].strip()  # drop demo text
            if not head:
                continue
            name, _, locale = head.rpartition(" ")  # locale is always the last token
            name = name.strip()
            if not name or not locale:
                continue
            if name in NOVELTY_VOICES:
                continue
            pair = (name, locale)
            if pair in seen:
                continue
            seen.add(pair)
            display = f"{name} ({locale})"
            entries.append((display, name))
        entries.sort(key=lambda x: x[0].lower())
        return entries if entries else [("Default", "")]

    def _load_voices_win(self) -> list[tuple[str, str]]:
        if self.tts_engine is None:
            return [("Default", "")]
        entries = []
        seen = set()
        try:
            voices = self.tts_engine.getProperty("voices")
        except Exception:
            return [("Default", "")]
        for v in voices:
            try:
                name = getattr(v, "name", "") or ""
                vid = getattr(v, "id", "") or ""
                langs = getattr(v, "languages", None) or []
                locale = normalize_voice_locale(langs, vid, name)
                if not locale:
                    continue
                pair = (name, locale)
                if pair in seen:
                    continue
                seen.add(pair)
                entries.append((f"{name} ({locale})", vid))
            except Exception:
                continue
        entries.sort(key=lambda x: x[0].lower())
        return entries if entries else [("Default", "")]

    # ------------------------------------------------------------------
    def _build_ui(self):
        pad = {"padx": 8, "pady": 4}

        # ── Row 1: engine + voice + speed ───────────────────────────
        row1 = tk.Frame(self.root)
        row1.pack(fill="x", **pad)

        tk.Label(row1, text="Engine:").pack(side="left")
        self.engine_var = tk.StringVar(value="Local (offline)")
        engine_menu = ttk.Combobox(row1, textvariable=self.engine_var,
                                   values=["Local (offline)", "Google (online)"],
                                   state="readonly", width=13)
        engine_menu.pack(side="left", padx=(2, 12))
        engine_menu.bind("<<ComboboxSelected>>", self._on_engine_change)

        tk.Label(row1, text="Voice:").pack(side="left")
        display_names = [d for d, _ in self.voices]
        self.voice_var = tk.StringVar(value=display_names[0])
        prefs = ("Alex (en_US)", "Albert (en_US)") if IS_MAC else (
            "Microsoft David Desktop (en_US)", "Microsoft Zira Desktop (en_US)",
            "Microsoft Hazel Desktop (en_GB)")
        for pref in prefs:
            if pref in display_names:
                self.voice_var.set(pref)
                break
        self.voice_menu = ttk.Combobox(row1, textvariable=self.voice_var,
                                       values=display_names, state="readonly", width=28)
        self.voice_menu.pack(side="left", padx=(2, 16))

        tk.Label(row1, text="Speed:").pack(side="left")
        self.speed_var = tk.DoubleVar(value=200)
        speed_scale = ttk.Scale(row1, from_=80, to=500, orient="horizontal",
                                variable=self.speed_var, length=180,
                                command=self._on_speed)
        speed_scale.pack(side="left", padx=(2, 6))
        self.speed_label = tk.Label(row1, text="200 wpm", width=8, anchor="w")
        self.speed_label.pack(side="left")
        self._on_speed()  # sync label to initial value

        # ── Row 2: text entry + say button ───────────────────────────
        row2 = tk.Frame(self.root)
        row2.pack(fill="x", **pad)

        self.text_var = tk.StringVar()
        self.entry = tk.Entry(row2, textvariable=self.text_var, font=("", 13))
        self.entry.pack(side="left", fill="x", expand=True, padx=(0, 8))
        self.entry.bind("<Return>", lambda e: self._speak())
        self.entry.focus_set()

        say_btn = ttk.Button(row2, text="Say", command=self._speak)
        say_btn.pack(side="left")

        # ── Row 2b: translate target + status ────────────────────────
        row2b = tk.Frame(self.root)
        row2b.pack(fill="x", **pad)

        tk.Label(row2b, text="Translate to:").pack(side="left")
        self.target_var = tk.StringVar(value="(none)")
        enabled = self._enabled_input_locales()
        target_values = ["(none)"] + [f"{d} ({l})" for l, d in TRANSLATION_LOCALES
                                      if l in enabled and l not in EXCLUDED_TARGETS]
        target_menu = ttk.Combobox(row2b, textvariable=self.target_var,
                                   values=target_values, state="readonly", width=28)
        target_menu.pack(side="left", padx=(2, 16))

        self.status_label = tk.Label(row2b, text="", anchor="w", fg="#555")
        self.status_label.pack(side="left", fill="x", expand=True)

        # ── Row 2c: translation output ───────────────────────────────
        row2c = tk.Frame(self.root)
        row2c.pack(fill="x", **pad)

        tk.Label(row2c, text="Translation:").pack(side="left", anchor="n")
        self.translation_box = tk.Text(row2c, height=3, state="disabled", wrap="word",
                                       font=("", 11), relief="solid", borderwidth=1)
        self.translation_box.pack(side="left", fill="x", expand=True, padx=(2, 0))

        # ── Row 2d: cache controls ───────────────────────────────────
        row2d = tk.Frame(self.root)
        row2d.pack(fill="x", **pad)

        tk.Label(row2d, text="Cache max (MB):").pack(side="left")
        self.cache_mb_var = tk.StringVar(value=str(self.config["cache_max_mb"]))
        cache_entry = ttk.Entry(row2d, textvariable=self.cache_mb_var, width=6)
        cache_entry.pack(side="left", padx=(2, 4))
        cache_entry.bind("<FocusOut>", self._on_cache_mb_change)
        cache_entry.bind("<Return>", self._on_cache_mb_change)
        ttk.Button(row2d, text="Clear cache",
                   command=self._clear_cache).pack(side="left", padx=(4, 0))

        # ── Row 3: history toggle ─────────────────────────────────────
        row3 = tk.Frame(self.root)
        row3.pack(fill="x", padx=8, pady=(0, 2))

        self.toggle_btn = ttk.Button(row3, text="▶ History (0)",
                                     command=self._toggle_history)
        self.toggle_btn.pack(side="left")

        # ── Row 4: collapsible history frame ─────────────────────────
        self.hist_frame = tk.Frame(self.root)
        # not packed initially (hidden)

        self.listbox = tk.Listbox(self.hist_frame, height=1,
                                  font=("Menlo", 11), activestyle="none",
                                  selectbackground="#cde", selectforeground="#000")
        self.scrollbar = ttk.Scrollbar(self.hist_frame, orient="vertical",
                                       command=self.listbox.yview)
        self.listbox.configure(yscrollcommand=self.scrollbar.set)
        self.scrollbar.pack(side="right", fill="y")
        self.listbox.pack(side="left", fill="both", expand=True)

        # ── apply persisted engine mode ──────────────────────────────
        if self.config["engine"] == "google":
            self.engine_var.set("Google (online)")
        self._apply_engine_mode()

    # ------------------------------------------------------------------
    def _on_speed(self, *_):
        if self.engine_var.get() == "Google (online)":
            self.speed_label.config(text=f"{self._current_speed_bucket():.1f}x")
        else:
            self.speed_label.config(text=f"{int(self.speed_var.get())} wpm")

    def _current_speed_bucket(self) -> float:
        return speed_to_bucket(int(self.speed_var.get()))

    # ------------------------------------------------------------------
    def _on_engine_change(self, *_):
        self.config["engine"] = "google" if self.engine_var.get() == "Google (online)" else "local"
        save_config(self.config)
        self._apply_engine_mode()

    def _apply_engine_mode(self):
        if self.engine_var.get() == "Google (online)":
            self.voice_menu.config(state="disabled")
            self.speed_label.config(text=f"{self._current_speed_bucket():.1f}x")
        else:
            self.voice_menu.config(state="readonly")
            self._on_speed()

    def _on_cache_mb_change(self, *_):
        try:
            val = int(self.cache_mb_var.get().strip())
        except ValueError:
            self.status_label.config(text="Cache max must be an integer (10–1000)")
            self.cache_mb_var.set(str(self.config["cache_max_mb"]))
            return
        if not 10 <= val <= 1000:
            self.status_label.config(text="Cache max clamped to 10–1000 MB")
            val = clamp(val, 10, 1000)
        self.config["cache_max_mb"] = val
        self.cache_mb_var.set(str(val))
        self.cache.set_max_mb(val)
        save_config(self.config)
        self.status_label.config(text=f"Cache max set to {val} MB")

    def _clear_cache(self):
        threading.Thread(target=self._clear_cache_worker, daemon=True).start()

    def _clear_cache_worker(self):
        n = self.cache.clear()
        self.root.after(0, lambda: self.status_label.config(
            text=f"Cache cleared ({n} files)" if n is not None else "Cache unavailable"))

    # ------------------------------------------------------------------
    def _speak(self):
        text = self.text_var.get().strip()
        if not text:
            return
        display = self.voice_var.get()
        raw_id = next((r for d, r in self.voices if d == display), display)
        speed = int(self.speed_var.get())

        # terminate/cancel prior in-flight call before starting a new one
        if IS_MAC:
            if self.current_proc and self.current_proc.poll() is None:
                self.current_proc.terminate()
        else:
            self._tts_gen += 1  # cancel any in-flight pyttsx3 utterance
        if self._playback_proc and self._playback_proc.poll() is None:
            self._playback_proc.terminate()
        self._google_gen += 1  # cancel any in-flight Google playback

        if self.engine_var.get() == "Google (online)":
            self._speak_google(text, speed)
            return

        target = self.target_var.get()
        if target == "(none)":
            self._clear_translation_box()
            self.status_label.config(text="")
            self._speak_text(text, raw_id, display, speed)
            return

        locale = self._locale_from_selection(target)
        if locale is None:
            self.status_label.config(text=f"unknown target: {target}")
            self._speak_text(text, raw_id, display, speed)
            return

        if IS_MAC and not self._ensure_helper():
            self.status_label.config(text="compiling translation support…")
            self._speak_text(text, raw_id, display, speed)
            return

        if IS_MAC:
            # kill prior helper process
            if self.helper_proc and self.helper_proc.poll() is None:
                self.helper_proc.terminate()

        self._translate_gen += 1
        gen = self._translate_gen
        self.status_label.config(text="translating…")
        t = threading.Thread(target=self._run_translate,
                             args=(text, locale, raw_id, display, speed, gen),
                             daemon=True)
        t.start()

    # ------------------------------------------------------------------
    def _speak_text(self, text, raw_id, display, speed):
        if IS_MAC:
            self._speak_text_mac(text, raw_id, display, speed)
        else:
            self._speak_text_win(text, raw_id, display, speed)

    def _speak_text_mac(self, text, raw_name, display, speed):
        cmd = ["say", "-r", str(speed)]
        if raw_name:
            cmd += ["-v", raw_name]
        cmd.append(text)

        proc = subprocess.Popen(cmd)
        self.current_proc = proc

        t = threading.Thread(target=self._run_say,
                             args=(proc, raw_name or display, speed, text),
                             daemon=True)
        t.start()

    def _speak_text_win(self, text, raw_id, display, speed):
        if self.tts_engine is None:
            self.status_label.config(text="pyttsx3 not available — pip install pyttsx3")
            return
        self._tts_gen += 1  # cancel any in-flight utterance
        gen = self._tts_gen
        prev = self._tts_thread
        t = threading.Thread(target=self._run_tts_win,
                             args=(text, raw_id, display, speed, gen, prev),
                             daemon=True)
        self._tts_thread = t
        t.start()

    def _run_tts_win(self, text, raw_id, display, speed, gen, prev):
        # Serialize engine access: wait for the prior utterance thread to wind down.
        if prev is not None and prev.is_alive():
            prev.join()
        if gen != self._tts_gen:
            return  # superseded while waiting — do not start
        try:
            if raw_id:
                self.tts_engine.setProperty("voice", raw_id)
            self.tts_engine.setProperty("rate", speed)
            self.tts_engine.say(text)
            self.tts_engine.runAndWait()
        except Exception:
            return
        if gen != self._tts_gen:
            # Superseded mid-speech: engine.stop() is NOT cross-thread safe,
            # so call it from within this thread.
            try:
                self.tts_engine.stop()
            except Exception:
                pass
            return
        self.root.after(0, lambda: self._add_history(display, speed, text))

    # ------------------------------------------------------------------
    # Google (online) engine
    # ------------------------------------------------------------------
    def _speak_google(self, text, speed):
        ggen = self._google_gen
        target = self.target_var.get()
        if target == "(none)":
            self._clear_translation_box()
            self.status_label.config(text="")
            self._google_speak_text(text, self._google_tts_lang(), speed, ggen)
            return
        locale = self._locale_from_selection(target)
        if locale is None:
            self.status_label.config(text=f"unknown target: {target}")
            self._google_speak_text(text, self._google_tts_lang(), speed, ggen)
            return
        self._translate_gen += 1
        gen = self._translate_gen
        self.status_label.config(text="translating…")
        t = threading.Thread(target=self._run_google_translate,
                             args=(text, locale, speed, gen, ggen), daemon=True)
        t.start()

    @staticmethod
    def _google_code(locale: str) -> str:
        """Locale ('ko_KR') or bare code ('ko') -> Google language code."""
        return LOCALE_TO_GOOGLE_CODE.get(locale, locale.split("_")[0])

    def _google_tts_lang(self) -> str:
        """TTS language for untranslated speech: from the selected voice's locale."""
        display = self.voice_var.get()
        if display.endswith(")"):
            locale = display.rsplit("(", 1)[-1][:-1]
            code = LOCALE_TO_GOOGLE_CODE.get(locale)
            if code:
                return code
            base = locale.split("_")[0]
            if base in LOCALE_TO_GOOGLE_CODE.values():
                return base
        return "en"

    def _run_google_translate(self, text, locale, speed, gen, ggen):
        tgt_code = self._google_code(locale)
        try:
            translated, detected = google_translate(text, tgt_code)
        except Exception as e:
            if gen != self._translate_gen or ggen != self._google_gen:
                return
            self.root.after(0, lambda: self._google_fallback(
                f"Google failed ({e}), trying Local…", text, locale, speed, gen, ggen))
            return
        if gen != self._translate_gen or ggen != self._google_gen:
            return
        self.root.after(0, lambda: self._handle_google_translate_result(
            translated, detected, tgt_code, locale, text, speed, gen, ggen))

    def _handle_google_translate_result(self, translated, detected, tgt_code,
                                        locale, text, speed, gen, ggen):
        if gen != self._translate_gen or ggen != self._google_gen:
            return
        if detected and detected == tgt_code:
            # same-language no-op: speak the original text
            self._clear_translation_box()
            lang = ARGOS_CODE_TO_DISPLAY.get(tgt_code.split("-")[0], tgt_code)
            self.status_label.config(text=f"already {lang}")
            self._google_speak_text(text, tgt_code, speed, ggen)
            return
        self._set_translation_box(translated)
        self.status_label.config(text=f"Translated from {detected or 'auto'} to {tgt_code}")
        self._google_speak_text(translated, tgt_code, speed, ggen)

    def _google_fallback(self, msg, text, locale, speed, gen, ggen):
        """Google translate blocked → run the existing Local translate path, but
        keep Google TTS for speech (the translate endpoint is blocked while the
        TTS endpoint still works)."""
        if gen != self._translate_gen or ggen != self._google_gen:
            return
        self.status_label.config(text="Google translate blocked (429), using Local translation…")
        display = self.voice_var.get()
        raw_id = next((r for d, r in self.voices if d == display), display)
        if IS_MAC and not self._ensure_helper():
            self.status_label.config(text="compiling translation support…")
            self._google_speak_text(text, self._google_tts_lang(), speed, ggen, blocked=True)
            return
        t = threading.Thread(target=self._run_translate,
                             args=(text, locale, raw_id, display, speed, gen, ggen, True),
                             daemon=True)
        t.start()

    def _google_speak_text(self, text, lang, speed, ggen, blocked=False):
        if ggen != self._google_gen:
            return
        t = threading.Thread(target=self._run_google_tts,
                             args=(text, lang, speed, ggen, blocked), daemon=True)
        t.start()

    def _run_google_tts(self, text, lang, speed, ggen, blocked=False):
        bucket = speed_to_bucket(speed)
        chunks = chunk_text_for_tts(text)
        if chunks is None:
            if ggen != self._google_gen:
                return
            self.root.after(0, lambda: self._google_tts_fallback(
                text, lang, speed, ggen, "text too long to chunk", blocked))
            return
        for chunk in chunks:
            if ggen != self._google_gen:
                return
            path, err = self.cache.get_audio(chunk, lang, bucket)
            if path is None:
                if ggen != self._google_gen:
                    return
                self.root.after(0, lambda: self._google_tts_fallback(
                    text, lang, speed, ggen, err, blocked))
                return
            if ggen != self._google_gen:
                self._cleanup_audio(path)
                return
            self._play_mp3(path, ggen)
            self._cleanup_audio(path)

    def _google_tts_fallback(self, text, lang, speed, ggen, err=None, blocked=False):
        if ggen != self._google_gen:
            return
        note = f" ({err})" if err else ""
        if blocked:
            # Google translate was already blocked — keep that note in the
            # final status so the user knows why Local speech was used.
            self.status_label.config(
                text=f"Google TTS failed{note} — Google translate blocked, using Local speech")
        else:
            self.status_label.config(text=f"Google TTS failed{note}, trying Local…")
        display = self.voice_var.get()
        raw_id = next((r for d, r in self.voices if d == display), display)
        self._speak_text(text, raw_id, display, speed)

    def _play_mp3(self, path, ggen):
        if ggen != self._google_gen:
            return
        if IS_WIN:
            try:
                import playsound
            except ImportError:
                self.root.after(0, lambda: self.status_label.config(
                    text="playsound not installed — pip install playsound"))
                return
            try:
                playsound.playsound(path)
            except Exception as e:
                self.root.after(0, lambda: self.status_label.config(
                    text=f"Audio player failed (playsound: {e})"))
            return
        mpv = shutil.which("mpv")
        cmd = [mpv, "--no-video", "--really-quiet", path] if mpv else ["afplay", path]
        try:
            proc = subprocess.Popen(cmd)
        except Exception as e:
            self.root.after(0, lambda: self.status_label.config(
                text=f"Audio player failed (mpv/afplay missing?) — {e}"))
            return
        self._playback_proc = proc
        try:
            proc.wait()
        except Exception:
            pass

    def _cleanup_audio(self, path):
        if self.cache.is_cached_path(path):
            return
        try:
            os.remove(path)
        except OSError:
            pass

    # ------------------------------------------------------------------
    # Translation support
    # ------------------------------------------------------------------
    def _helper_path(self) -> str:
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "translate_helper")

    def _ensure_helper(self) -> bool:
        """True if the helper binary is ready; otherwise starts a background compile."""
        if os.path.exists(self._helper_path()):
            return True
        if self._compile_thread is not None and self._compile_thread.is_alive():
            return False
        self._compile_thread = threading.Thread(target=self._compile_helper, daemon=True)
        self._compile_thread.start()
        return False

    def _compile_helper(self):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        try:
            subprocess.run(["swiftc", "-O", "-parse-as-library", "translate_helper.swift",
                            "-o", "translate_helper"],
                           cwd=script_dir, timeout=30, capture_output=True, text=True)
        except Exception:
            pass
        ok = os.path.exists(self._helper_path())
        self.root.after(0, lambda: self.status_label.config(
            text="translation support ready" if ok else "translation compile failed"))

    def _run_translate(self, text, locale, raw_id, display, speed, gen,
                       ggen=None, google_tts=False):
        if IS_MAC:
            result = self._translate_mac(text, locale)
        else:
            result = self._translate_win(text, locale)
        if gen != self._translate_gen:
            return  # superseded by a newer translate — skip UI updates
        self.root.after(0, lambda: self._handle_translate_result(
            result, locale, text, raw_id, display, speed, ggen, google_tts))

    def _translate_mac(self, text, locale):
        """Call the Swift helper. Returns a result tuple, or None if superseded."""
        payload = json.dumps({"text": text, "source": None, "target": locale,
                              "timeout": 20})  # helper clamps to [5, 600]
        proc = subprocess.Popen([self._helper_path()],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True)
        self.helper_proc = proc
        try:
            out, _ = proc.communicate(input=payload, timeout=25)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
            if self.helper_proc is not proc:
                return None  # superseded — skip UI updates
            return ("error", "Translation timed out — models not downloaded yet "
                             "(first use needs internet)")
        if self.helper_proc is not proc:
            return None  # superseded by a newer translate — skip UI updates
        try:
            resp = json.loads(out.strip()) if out.strip() else {}
        except json.JSONDecodeError:
            resp = {}
        if resp.get("ok") is not True:
            err = resp.get("error", "translation-failed")
            if err == "timeout":
                msg = "Translation timed out — models not downloaded yet (first use needs internet)"
            elif err == "empty-text":
                msg = "Nothing to translate"
            else:
                msg = err
            return ("error", msg)
        translated = resp.get("text", "")
        src = resp.get("source", "")
        tgt = resp.get("target", "")
        if src == tgt:
            # helper no-op: text is already in the target language
            return ("noop", tgt)
        return ("ok", translated, src, tgt)

    def _translate_win(self, text, locale):
        try:
            from argostranslate import translate as at
            langs = at.get_installed_languages()
        except Exception:
            return ("error", "argos-translate not installed — run: pip install argos-translate")
        src_code = self._argos_source_code(text)
        tgt_code = self._argos_target_code(locale)
        if src_code == tgt_code:
            return ("noop", locale)  # same-language no-op
        try:
            translated = argos_translate(text, src_code, tgt_code, langs)
        except Exception as e:
            return ("error", f"translation failed: {e}")
        if translated is None:
            return ("error", "models-not-installed — install argos models (see --check)")
        return ("ok", translated, src_code, tgt_code)

    def _argos_source_code(self, text) -> str:
        """Detect source language via argostranslate.detect (v1.9+); fallback 'en'."""
        try:
            from argostranslate import detect
            code = detect.detect_language(text)
            if code:
                return self._argos_normalize_code(str(code))
        except Exception:
            pass
        return "en"

    @staticmethod
    def _argos_normalize_code(code: str) -> str:
        # argos expects 2-letter ISO 639-1 codes; strip any _XX country suffix.
        # en_US/en_GB → en, zh_CN/zh_TW → zh, ko_KR → ko; bare "ko" stays "ko".
        return code.replace("-", "_").split("_")[0]

    @staticmethod
    def _argos_target_code(locale: str) -> str:
        # argos expects 2-letter ISO 639-1 codes; strip the _XX country suffix.
        # en_US/en_GB → en, zh_CN/zh_TW → zh (argos zh = Simplified).
        return locale.split("_")[0]

    def _handle_translate_result(self, result, locale, text, raw_id, display, speed,
                                 ggen=None, google_tts=False):
        if result is None:
            return  # superseded
        kind = result[0]
        if kind == "ok":
            _, translated, src, tgt = result
            self._translation_success(translated, src, tgt, locale, raw_id, display,
                                      speed, ggen, google_tts)
        elif kind == "noop":
            _, tgt = result
            self._translation_noop(text, raw_id, display, speed, tgt, ggen, google_tts)
        else:
            _, msg = result
            self._translation_failed(msg, text, raw_id, display, speed, ggen, google_tts)

    def _translation_success(self, translated, src, tgt, locale, raw_id, display,
                             speed, ggen=None, google_tts=False):
        self._set_translation_box(translated)
        note = " (Traditional → Simplified)" if locale == "zh_TW" else ""
        if google_tts:
            # Google translate blocked → Local translated, but keep Google TTS
            # (the TTS endpoint still works). Final status keeps the note.
            self.status_label.config(
                text=f"Translated from {src} to {tgt}{note} "
                     "(Google translate blocked — Local used, Google TTS)")
            self._google_speak_text(translated, self._google_code(tgt), speed, ggen,
                                    blocked=True)
            return
        self.status_label.config(text=f"Translated from {src} to {tgt}{note}")
        self._speak_text(translated, raw_id, display, speed)

    def _translation_noop(self, text, raw_id, display, speed, tgt,
                          ggen=None, google_tts=False):
        self._clear_translation_box()
        lang = ARGOS_CODE_TO_DISPLAY.get(tgt, tgt)
        if google_tts:
            self.status_label.config(
                text=f"already {lang} (Google translate blocked — Local used, Google TTS)")
            self._google_speak_text(text, self._google_code(tgt), speed, ggen,
                                    blocked=True)
            return
        self.status_label.config(text=f"already {lang}")
        self._speak_text(text, raw_id, display, speed)

    def _translation_failed(self, msg, text, raw_id, display, speed,
                            ggen=None, google_tts=False):
        self._clear_translation_box()
        if google_tts:
            self.status_label.config(
                text="Google translate blocked, Local translate failed — "
                     "speaking original via Google TTS")
            self._google_speak_text(text, self._google_tts_lang(), speed, ggen,
                                    blocked=True)
            return
        self.status_label.config(text=msg)
        self._speak_text(text, raw_id, display, speed)

    def _set_translation_box(self, text):
        self.translation_box.config(state="normal")
        self.translation_box.delete("1.0", "end")
        self.translation_box.insert("1.0", text)
        self.translation_box.config(state="disabled")

    def _clear_translation_box(self):
        self.translation_box.config(state="normal")
        self.translation_box.delete("1.0", "end")
        self.translation_box.config(state="disabled")

    # ------------------------------------------------------------------
    def _enabled_input_locales(self) -> list[str]:
        """Locales for the user's enabled keyboard input sources; full list on failure."""
        if IS_MAC:
            return self._enabled_input_locales_mac()
        return self._enabled_input_locales_win()

    def _enabled_input_locales_mac(self) -> list[str]:
        try:
            out = subprocess.check_output(["defaults", "export", "com.apple.HIToolbox", "-"],
                                          timeout=5, stderr=subprocess.DEVNULL)
            data = plistlib.loads(out)
        except Exception:
            return [loc for loc, _ in TRANSLATION_LOCALES if loc not in EXCLUDED_TARGETS]
        sources = data.get("AppleEnabledInputSources", []) if isinstance(data, dict) else []
        locales: list[str] = []
        has_tcim = False
        for src in sources:
            if not isinstance(src, dict):
                continue
            kind = src.get("InputSourceKind", "")
            loc = None
            if kind == "Keyboard Layout":
                loc = KEYBOARD_LAYOUT_TO_LOCALE.get(src.get("KeyboardLayout Name", ""))
            elif kind in ("Keyboard Input Method", "Input Mode"):
                loc = INPUT_METHOD_TO_LOCALE.get(src.get("Input Mode", ""))
                if loc is None:
                    loc = INPUT_METHOD_TO_LOCALE.get(src.get("Bundle ID", ""))
            if loc and loc not in locales:
                locales.append(loc)
            if "TCIM" in str(src.get("Bundle ID", "")) or "TCIM" in str(src.get("Input Mode", "")):
                has_tcim = True
        if has_tcim:
            for extra in ("zh_CN", "zh_TW"):
                if extra not in locales:
                    locales.append(extra)
        result = locales if locales else [loc for loc, _ in TRANSLATION_LOCALES]
        return [loc for loc in result if loc not in EXCLUDED_TARGETS]

    def _enabled_input_locales_win(self) -> list[str]:
        fallback = [loc for loc, _ in TRANSLATION_LOCALES if loc not in EXCLUDED_TARGETS]
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Keyboard Layout\Preload")
            values = []
            i = 0
            while True:
                try:
                    _, v, _ = winreg.EnumValue(key, i)
                    values.append(v)
                    i += 1
                except OSError:
                    break
            winreg.CloseKey(key)
        except Exception:
            return fallback
        locales = parse_lcid_values(values)
        result = locales if locales else fallback
        return [loc for loc in result if loc not in EXCLUDED_TARGETS]

    def _locale_from_selection(self, selection: str) -> str | None:
        if selection.endswith(")"):
            loc = selection.rsplit("(", 1)[-1][:-1]
            if loc in dict(TRANSLATION_LOCALES):
                return loc
        return None

    def _run_say(self, proc, voice, speed, text):
        try:
            proc.wait()
        except Exception:
            return  # wait failed — skip history, keep app running
        if self.current_proc is not proc:
            return  # was superseded — skip history
        self.root.after(0, lambda: self._add_history(voice, speed, text))

    # ------------------------------------------------------------------
    def _add_history(self, voice: str, speed: int, text: str):
        if len(self.history) >= 20:
            self.history.pop(0)
        self.history.append(f"[{voice}] @{speed}wpm: {text}")
        self._refresh_listbox()
        self._update_toggle_text()

    def _refresh_listbox(self):
        self.listbox.delete(0, "end")
        for entry in self.history:
            self.listbox.insert("end", entry)
        h = max(1, min(len(self.history), 10))
        self.listbox.config(height=h)
        self.listbox.yview_moveto(1.0)  # scroll to bottom

    def _update_toggle_text(self):
        n = len(self.history)
        arrow = "▼" if self.history_visible else "▶"
        self.toggle_btn.config(text=f"{arrow} History ({n})")

    # ------------------------------------------------------------------
    def _toggle_history(self):
        self.history_visible = not self.history_visible
        if self.history_visible:
            self.hist_frame.pack(fill="x", padx=8, pady=(0, 8))
        else:
            self.hist_frame.pack_forget()
        self._update_toggle_text()

    # ------------------------------------------------------------------
    def _on_close(self):
        if self._playback_proc and self._playback_proc.poll() is None:
            self._playback_proc.terminate()
        if IS_MAC:
            if self.current_proc and self.current_proc.poll() is None:
                self.current_proc.terminate()
            if self.helper_proc and self.helper_proc.poll() is None:
                self.helper_proc.terminate()
        else:
            self._tts_gen += 1  # cancel any in-flight pyttsx3 utterance
        self.root.destroy()


if __name__ == "__main__":
    if "--check" in sys.argv:
        missing_critical, missing_required, *_ = check_dependencies()
        sys.exit(1 if (missing_critical or missing_required) else 0)

    missing_critical, missing_required, *_ = check_dependencies()
    if missing_critical or missing_required:
        sys.exit(1)
    # external/pip-only missing → continue launching (GUI works, degraded features)

    root = tk.Tk()
    TranslateGUI(root)
    root.mainloop()
