#!/usr/bin/env python3
try:
    import tkinter as tk
    from tkinter import ttk, messagebox
except ImportError:
    tk = None
import subprocess, threading
import importlib, shutil, sys

# ── Startup dependency check ───────────────────────────────────────
CRITICAL_MODULES = ["tkinter"]
REQUIRED_MODULES = ["subprocess", "threading", "time"]
EXTERNAL_BINARIES = {"say": "speech output"}
INSTALL_HINTS = {
    "tkinter": "conda: `conda install -n py-opencode tk` | Homebrew: `brew install python-tk@3.14` | python.org: reinstall with 'Install Tk 8.6' checked",
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


class SayGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("say — Text to Speech")
        self.root.minsize(500, 0)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self.history: list[str] = []
        self.history_visible = False
        self.current_proc: subprocess.Popen | None = None

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

        self._speak_text(text, raw_name, display, speed)

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
