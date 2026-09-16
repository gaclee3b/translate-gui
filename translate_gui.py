#!/usr/bin/env python3
try:
    import tkinter as tk
    from tkinter import ttk, messagebox
except ImportError:
    tk = None
import json, os, plistlib, subprocess, threading, re
import importlib, shutil, sys

# ── Startup dependency check ───────────────────────────────────────
CRITICAL_MODULES = ["tkinter"]
REQUIRED_MODULES = ["json", "os", "plistlib", "subprocess", "threading", "time"]
EXTERNAL_BINARIES = {"swiftc": "translation (compiles helper)", "say": "speech output"}
INSTALL_HINTS = {
    "tkinter": "conda: `conda install -n py-opencode tk` | Homebrew: `brew install python-tk@3.14` | python.org: reinstall with 'Install Tk 8.6' checked",
    "swiftc": "`xcode-select --install` (Command Line Tools)",
    "say": "part of macOS — should never be missing",
}


def check_dependencies():
    """Check runtime dependencies; print a report to stderr.

    Returns (missing_critical, missing_required, missing_external).
    """
    missing_critical: list[str] = []
    missing_required: list[str] = []
    missing_external: list[str] = []

    for mod in CRITICAL_MODULES + REQUIRED_MODULES:
        try:
            importlib.import_module(mod)
        except ImportError:
            (missing_critical if mod in CRITICAL_MODULES else missing_required).append(mod)

    for bin_name in EXTERNAL_BINARIES:
        if shutil.which(bin_name) is None:
            missing_external.append(bin_name)

    print("say_gui.py dependency check:", file=sys.stderr)
    if missing_critical or missing_required or missing_external:
        for mod in missing_critical:
            print(f"MISSING (fatal): {mod} — GUI cannot start", file=sys.stderr)
            print(f"  Fix: {INSTALL_HINTS.get(mod, 'install the missing package')}", file=sys.stderr)
        for mod in missing_required:
            print(f"MISSING (fatal): {mod} — required module", file=sys.stderr)
            print(f"  Fix: {INSTALL_HINTS.get(mod, 'install the missing package')}", file=sys.stderr)
        for bin_name in missing_external:
            print(f"MISSING (warning): {bin_name} — {EXTERNAL_BINARIES[bin_name]}", file=sys.stderr)
            print(f"  Fix: {INSTALL_HINTS.get(bin_name, 'install the missing package')}", file=sys.stderr)
    else:
        print("All dependencies present.", file=sys.stderr)

    return missing_critical, missing_required, missing_external

# Apple "Novelty" voices — sound effects layered over base voices, not clean speech.
NOVELTY_VOICES = frozenset({
    "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos",
    "Good News", "Jester", "Organ", "Superstar", "Trinoids",
    "Whisper", "Wobble", "Zarvox",
})

# ── Offline translation (Apple Translation framework via scripts/translate_helper) ──
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

# Keyboard layout name -> locale (from com.apple.HIToolbox AppleEnabledInputSources).
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

# Input method bundle ID / input mode -> locale.
INPUT_METHOD_TO_LOCALE = {
    "com.apple.inputmethod.Korean": "ko_KR",
    "com.apple.inputmethod.Japanese": "ja_JP",
    "com.apple.inputmethod.SCIM": "zh_CN",
    "com.apple.inputmethod.TCIM": "zh_TW",
    "com.apple.inputmethod.Roman": "en_US",
    "com.apple.inputmethod.TCIM.Pinyin": "zh_TW",
    "com.apple.inputmethod.SCIM.ITABC": "zh_CN",
}


class SayGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("say — Text to Speech")
        self.root.minsize(500, 0)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self.history: list[str] = []
        self.history_visible = False
        self.current_proc: subprocess.Popen | None = None
        self.helper_proc: subprocess.Popen | None = None
        self._compile_thread: threading.Thread | None = None

        self.voices = self._load_voices()  # [(display, raw_name), ...]
        self._build_ui()

    # ------------------------------------------------------------------
    def _load_voices(self) -> list[tuple[str, str]]:
        try:
            out = subprocess.check_output(["say", "-v", "?"], text=True, stderr=subprocess.DEVNULL, timeout=10)
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

    # ------------------------------------------------------------------
    def _build_ui(self):
        pad = {"padx": 8, "pady": 4}

        # ── Row 1: voice + speed ──────────────────────────────────────────────
        row1 = tk.Frame(self.root)
        row1.pack(fill="x", **pad)

        tk.Label(row1, text="Voice:").pack(side="left")
        display_names = [d for d, _ in self.voices]
        self.voice_var = tk.StringVar(value=display_names[0])
        # prefer Alex or Albert as default
        for pref in ("Alex (en_US)", "Albert (en_US)"):
            if pref in display_names:
                self.voice_var.set(pref)
                break
        voice_menu = ttk.Combobox(row1, textvariable=self.voice_var,
                                  values=display_names, state="readonly", width=28)
        voice_menu.pack(side="left", padx=(2, 16))

        tk.Label(row1, text="Speed:").pack(side="left")
        self.speed_var = tk.DoubleVar(value=200)
        speed_scale = ttk.Scale(row1, from_=80, to=500, orient="horizontal",
                                variable=self.speed_var, length=180,
                                command=self._on_speed)
        speed_scale.pack(side="left", padx=(2, 6))
        self.speed_label = tk.Label(row1, text="200 wpm", width=8, anchor="w")
        self.speed_label.pack(side="left")
        self._on_speed()  # sync label to initial value

        # ── Row 2: text entry + say button ─────────────────────────────────────
        row2 = tk.Frame(self.root)
        row2.pack(fill="x", **pad)

        self.text_var = tk.StringVar()
        self.entry = tk.Entry(row2, textvariable=self.text_var, font=("", 13))
        self.entry.pack(side="left", fill="x", expand=True, padx=(0, 8))
        self.entry.bind("<Return>", lambda e: self._speak())
        self.entry.focus_set()

        say_btn = ttk.Button(row2, text="Say", command=self._speak)
        say_btn.pack(side="left")

        # ── Row 2b: translate target + status ────────────────────────────────────
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

        # ── Row 2c: translation output ────────────────────────────────────────
        row2c = tk.Frame(self.root)
        row2c.pack(fill="x", **pad)

        tk.Label(row2c, text="Translation:").pack(side="left", anchor="n")
        self.translation_box = tk.Text(row2c, height=3, state="disabled", wrap="word",
                                       font=("", 11), relief="solid", borderwidth=1)
        self.translation_box.pack(side="left", fill="x", expand=True, padx=(2, 0))

        # ── Row 3: history toggle ──────────────────────────────────────────────
        row3 = tk.Frame(self.root)
        row3.pack(fill="x", padx=8, pady=(0, 2))

        self.toggle_btn = ttk.Button(row3, text="▶ History (0)",
                                     command=self._toggle_history)
        self.toggle_btn.pack(side="left")

        # ── Row 4: collapsible history frame ─────────────────────────────────────
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

    # ------------------------------------------------------------------
    def _on_speed(self, *_):
        self.speed_label.config(text=f"{int(self.speed_var.get())} wpm")

    # ------------------------------------------------------------------
    def _speak(self):
        text = self.text_var.get().strip()
        if not text:
            return
        display = self.voice_var.get()
        raw_name = next((r for d, r in self.voices if d == display), display)
        speed = int(self.speed_var.get())

        # kill prior say process
        if self.current_proc and self.current_proc.poll() is None:
            self.current_proc.terminate()

        target = self.target_var.get()
        if target == "(none)":
            self._clear_translation_box()
            self.status_label.config(text="")
            self._speak_text(text, raw_name, display, speed)
            return

        locale = self._locale_from_selection(target)
        if locale is None:
            self.status_label.config(text=f"unknown target: {target}")
            self._speak_text(text, raw_name, display, speed)
            return

        if not self._ensure_helper():
            self.status_label.config(text="compiling translation support…")
            self._speak_text(text, raw_name, display, speed)
            return

        # kill prior helper process
        if self.helper_proc and self.helper_proc.poll() is None:
            self.helper_proc.terminate()

        self.status_label.config(text="translating…")
        t = threading.Thread(target=self._run_translate,
                             args=(text, locale, raw_name, display, speed),
                             daemon=True)
        t.start()

    def _speak_text(self, text, raw_name, display, speed):
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
            subprocess.run(["swiftc", "-O", "-parse-as-library", "translate_helper.swift", "-o", "translate_helper"],
                           cwd=script_dir, timeout=30, capture_output=True, text=True)
        except Exception:
            pass
        ok = os.path.exists(self._helper_path())
        self.root.after(0, lambda: self.status_label.config(
            text="translation support ready" if ok else "translation compile failed"))

    def _run_translate(self, text, locale, raw_name, display, speed):
        payload = json.dumps({"text": text, "source": None, "target": locale})
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
                return  # superseded — skip UI updates
            self.root.after(0, lambda: self._translation_failed(
                "Translation timed out — models not downloaded yet (first use needs internet)",
                text, raw_name, display, speed))
            return
        if self.helper_proc is not proc:
            return  # superseded by a newer translate — skip UI updates
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
            self.root.after(0, lambda: self._translation_failed(msg, text, raw_name, display, speed))
            return
        translated = resp.get("text", "")
        src = resp.get("source", "")
        tgt = resp.get("target", "")
        if src == tgt:
            # helper no-op: text is already in the target language
            self.root.after(0, lambda: self._translation_noop(text, raw_name, display, speed, tgt))
        else:
            self.root.after(0, lambda: self._translation_success(
                translated, src, tgt, raw_name, display, speed))

    def _translation_success(self, translated, src, tgt, raw_name, display, speed):
        self._set_translation_box(translated)
        self.status_label.config(text=f"Translated from {src} to {tgt}")
        self._speak_text(translated, raw_name, display, speed)

    def _translation_noop(self, text, raw_name, display, speed, tgt):
        self._clear_translation_box()
        lang = dict(TRANSLATION_LOCALES).get(tgt, tgt)
        self.status_label.config(text=f"already {lang}")
        self._speak_text(text, raw_name, display, speed)

    def _translation_failed(self, msg, text, raw_name, display, speed):
        self._clear_translation_box()
        self.status_label.config(text=msg)
        self._speak_text(text, raw_name, display, speed)

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
        if self.current_proc and self.current_proc.poll() is None:
            self.current_proc.terminate()
        if self.helper_proc and self.helper_proc.poll() is None:
            self.helper_proc.terminate()
        self.root.destroy()


if __name__ == "__main__":
    if "--check" in sys.argv:
        missing_critical, missing_required, _ = check_dependencies()
        sys.exit(1 if (missing_critical or missing_required) else 0)

    missing_critical, missing_required, missing_external = check_dependencies()
    if missing_critical or missing_required:
        sys.exit(1)
    # external-only missing → continue launching (GUI works, degraded features)

    root = tk.Tk()
    SayGUI(root)
    root.mainloop()
