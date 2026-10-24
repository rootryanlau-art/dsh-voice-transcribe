#!/usr/bin/env python3
"""vstt_engine.py - offline speech-to-text engine for the DSH plugin `dsh-voice-transcribe`.

SenseVoice (sherpa-onnx, int8 ONNX, Chinese-first) by default; faster-whisper optional.
Nothing leaves the machine: no API key, no network at run time.

Commands
  doctor                      show engine / model / audio-device status
  file <media> [-o DIR]       transcribe an audio or video file (--json for machine output)
  mic [--seconds N]           dictation from the microphone: text to stdout + clipboard
  probe                       record 1 s from every input device and report the level
  bench <audio> --ref TEXT    CER + RTF comparison: sensevoice vs whisper

Engines
  sensevoice  sherpa-onnx, int8 ONNX, ~239 MB, Chinese-first (zh/yue/en/ja/ko)
  whisper     faster-whisper small int8 on CPU (legacy baseline, needs its own download)

Paths (all overridable, none hard-coded)
  VSTT_HOME          data root, default ~/.dsh/voice-transcribe
  VSTT_MODEL_DIR     SenseVoice directory, default <VSTT_HOME>/models/sense-voice
  VSTT_WHISPER_CACHE faster-whisper cache, default <VSTT_HOME>/models/whisper
  VSTT_FFMPEG        ffmpeg executable (otherwise ffmpeg on PATH is used for non-wav input)

Examples
  python vstt_engine.py file "C:\\path\\talk.m4a" --json
  python vstt_engine.py mic
  python vstt_engine.py bench test.wav --ref "我们明天下午在西湖边见面"
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PKG = ROOT.parent

# Every machine-specific path is resolved from the environment, never hard-coded:
#   VSTT_HOME          data root (default ~/.dsh/voice-transcribe)
#   VSTT_MODEL_DIR     SenseVoice dir (default <VSTT_HOME>/models/sense-voice)
#   VSTT_WHISPER_CACHE faster-whisper cache (default <VSTT_HOME>/models/whisper)
#   VSTT_FFMPEG        ffmpeg executable
_DATA = Path(os.environ.get("VSTT_HOME") or (Path.home() / ".dsh" / "voice-transcribe"))
DATA_DIR = _DATA
_bundled = PKG / "models" / "sense-voice"
MODEL_DIR = Path(
    os.environ.get("VSTT_MODEL_DIR")
    or (_bundled if _bundled.is_dir() else _DATA / "models" / "sense-voice")
)
WHISPER_CACHE = Path(os.environ.get("VSTT_WHISPER_CACHE") or (_DATA / "models" / "whisper"))
LOG_DIR = _DATA / "logs"
FFMPEG_CANDIDATES = [
    os.environ.get("VSTT_FFMPEG"),
    os.environ.get("VSTT_FFMPEG_LEGACY"),
    str(_DATA / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")),
    shutil.which("ffmpeg"),
]

try:  # keep Chinese readable when stdout is redirected
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- audio input
def find_ffmpeg() -> str:
    for c in FFMPEG_CANDIDATES:
        if c and Path(c).exists():
            return str(c)
    raise SystemExit("ffmpeg not found; set env VSTT_FFMPEG to an ffmpeg executable")


def to_wav16k(src: Path) -> Path:
    out = Path(tempfile.gettempdir()) / f"stt_{os.getpid()}_{int(time.time() * 1000)}.wav"
    cmd = [find_ffmpeg(), "-nostdin", "-y", "-i", str(src),
           "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", str(out)]
    p = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if p.returncode != 0 or not out.exists():
        raise SystemExit("ffmpeg failed:\n" + p.stderr.decode("utf-8", "replace")[-800:])
    return out


def read_wav16k(p: Path):
    import numpy as np
    with wave.open(str(p), "rb") as w:
        sr, nch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise SystemExit(f"expect 16-bit wav, got {sw * 8}-bit")
    a = np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0
    if nch > 1:
        a = a.reshape(-1, nch).mean(axis=1)
    if sr != 16000:
        raise SystemExit(f"expect 16k wav, got {sr}")
    return a


def load_audio(src: Path):
    if src.suffix.lower() == ".wav":
        try:
            return _wav_any(src)
        except Exception:
            pass
    tmp = to_wav16k(src)
    try:
        return read_wav16k(tmp)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _wav_any(src: Path):
    """Read a wav cheaply when it already is 16k mono 16-bit; else fall back."""
    with wave.open(str(src), "rb") as w:
        ok = (w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2)
    return read_wav16k(src) if ok else to_wav16k_fallback(src)


def to_wav16k_fallback(src: Path):
    tmp = to_wav16k(src)
    try:
        return read_wav16k(tmp)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------- segmentation
def segment_ranges(a, sr: int, max_len: float = 25.0, min_sil: float = 0.30,
                   floor_db: float = -40.0):
    """Energy VAD: return [(t0, t1)] seconds covering speech, gaps >= min_sil cut."""
    import numpy as np

    total = len(a) / sr
    if total <= max_len:
        return [(0.0, total)]

    hop = int(0.02 * sr)
    if len(a) < hop * 2:
        return [(0.0, total)]
    n = 1 + (len(a) - hop) // hop
    win = np.lib.stride_tricks.sliding_window_view(a, hop)[::hop][:n].astype("float64")
    db = 20.0 * np.log10(np.sqrt((win ** 2).mean(axis=1)) + 1e-12)
    peak = float(np.percentile(db, 95))
    thr = max(floor_db, peak - 28.0)
    voiced = db > thr

    segs, i = [], 0
    while i < len(voiced):
        if not voiced[i]:
            i += 1
            continue
        j, last, sil = i, i, 0
        while j < len(voiced):
            if voiced[j]:
                last, sil = j, 0
            else:
                sil += 1
                if sil * 0.02 >= min_sil:
                    break
            j += 1
        segs.append((max(0.0, i * hop / sr - 0.2), min(total, (last + 1) * hop / sr + 0.2)))
        i = j + 1

    out = []
    for t0, t1 in segs:
        if t1 - t0 < 0.2:
            continue
        while t1 - t0 > max_len:
            out.append((t0, t0 + max_len))
            t0 += max_len
        out.append((t0, t1))
    return out or [(0.0, total)]


# ---------------------------------------------------------------- engines
class Engine:
    name = "base"

    def transcribe(self, samples, sr: int) -> str:
        raise NotImplementedError


class SenseVoice(Engine):
    name = "sensevoice"

    def __init__(self, threads: int = 4, lang: str = "zh"):
        import sherpa_onnx

        model = MODEL_DIR / "model.int8.onnx"
        tokens = MODEL_DIR / "tokens.txt"
        if not model.exists() or not tokens.exists():
            raise SystemExit(f"model missing under {MODEL_DIR} (need model.int8.onnx + tokens.txt)")
        t0 = time.perf_counter()
        self.rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model), tokens=str(tokens), num_threads=threads,
            use_itn=True, language=lang,
        )
        self.load_s = time.perf_counter() - t0

    def transcribe(self, samples, sr: int) -> str:
        s = self.rec.create_stream()
        s.accept_waveform(sr, samples)
        self.rec.decode_stream(s)
        return (s.result.text or "").strip()


class Whisper(Engine):
    name = "whisper"

    def __init__(self, size: str = "small"):
        from faster_whisper import WhisperModel

        kw = dict(device="cpu", compute_type="int8")
        if WHISPER_CACHE.exists():
            kw["download_root"] = str(WHISPER_CACHE)
        t0 = time.perf_counter()
        self.m = WhisperModel(size, **kw)
        self.load_s = time.perf_counter() - t0

    def transcribe(self, samples, sr: int) -> str:
        segs, _ = self.m.transcribe(samples, language="zh", vad_filter=True, beam_size=5)
        return "".join(s.text for s in segs).strip()


def make_engine(name: str, **kw) -> Engine:
    if name == "whisper":
        return Whisper(**kw)
    return SenseVoice(**kw)


SILENCE_RMS = 0.002   # ~-54 dBFS; below this a chunk is treated as silence
TARGET_DBFS = -20.0   # AGC target loudness for speech
MAX_GAIN_DB = 60.0    # never amplify more than 1000x (noise would dominate)


PEAK_CEIL_DB = -1.0   # AGC never pushes the peak above this (prevents clipping)


def normalize_gain(a, sr: int):
    """Raise quiet speech toward TARGET_DBFS. Gain only, never attenuation.

    Loudness is measured on active frames only (silence skipped), and the gain is
    additionally capped by peak headroom: a clip whose RMS is dragged down by long
    pauses must not be amplified until the speech peaks clip.
    """
    import numpy as np

    if len(a) == 0:
        return a
    frame = int(0.03 * sr)
    n = (len(a) // frame) * frame
    if n <= 0:
        return a
    frames = a[:n].astype("float64").reshape(-1, frame)
    fr = np.sqrt((frames ** 2).mean(axis=1))
    # Speech loudness proxy = 95th percentile frame RMS. Mean over the whole clip is
    # dragged down by pauses; max over frames is hijacked by a single click.
    rms = float(np.percentile(fr, 95))
    # Robust peak: an isolated click (keystroke, desk bump) must not veto the gain.
    peak = float(np.percentile(np.abs(a), 99.9))
    if rms <= 1e-6 or peak <= 1e-6:
        return a
    gain_db = min(
        MAX_GAIN_DB,
        TARGET_DBFS - 20.0 * np.log10(rms),
        PEAK_CEIL_DB - 20.0 * np.log10(peak),
    )
    if gain_db <= 0.5:
        return a
    out = a * (10.0 ** (gain_db / 20.0))
    return np.clip(out, -1.0, 1.0).astype("float32")


def transcribe_segments(engine: Engine, a, sr: int) -> list[dict]:
    """Transcribe VAD-segmented audio; returns [{"start","end","text"}] in seconds.

    Timestamps let video tools line speech up with frames, so this is the primitive;
    transcribe_long() is just the plain-text projection of it.
    """
    import numpy as np

    if len(a) == 0:
        return []
    pre_rms = float(np.sqrt((a.astype("float64") ** 2).mean()))
    if pre_rms < 0.0005:  # digital silence (dither only): do not amplify, do not hallucinate
        log("[warn] recording is essentially silent - check mic input volume/unmute")
        return []
    a = normalize_gain(a, sr)
    out = []
    for t0, t1 in segment_ranges(a, sr):
        chunk = a[int(t0 * sr):int(t1 * sr)]
        if len(chunk) < int(0.2 * sr):
            continue
        if float(np.sqrt((chunk.astype("float64") ** 2).mean())) < SILENCE_RMS * 0.25:
            continue
        txt = engine.transcribe(chunk, sr).strip()
        if txt:
            out.append({"start": round(t0, 2), "end": round(t1, 2), "text": txt})
    return out


def transcribe_long(engine: Engine, a, sr: int) -> tuple[str, int]:
    segs = transcribe_segments(engine, a, sr)
    return "".join(s["text"] for s in segs), len(segs)


# ---------------------------------------------------------------- metrics
def strip_punct(s: str) -> str:
    import unicodedata

    out = []
    for ch in s.strip():
        cat = unicodedata.category(ch)
        if cat[0] in ("P", "S", "Z") or ch.isspace() or cat == "Cf":
            continue  # Cf covers BOM/zero-width chars leaking in from text files
        out.append(ch)
    return "".join(out)


def cer(ref: str, hyp: str) -> float:
    r, h = strip_punct(ref), strip_punct(hyp)
    if not r:
        return 0.0
    prev = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        cur = [i] + [0] * len(h)
        for j, hc in enumerate(h, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc))
        prev = cur
    return prev[-1] / len(r)


# ---------------------------------------------------------------- commands
def cmd_doctor(a):
    print(f"root          : {ROOT}")
    print(f"python        : {sys.version.split()[0]}")
    model = MODEL_DIR / "model.int8.onnx"
    print(f"sensevoice    : {'OK' if model.exists() else 'MISSING'} "
          f"{model.stat().st_size / 1e6:.0f} MB" if model.exists() else "sensevoice    : MISSING")
    for mod in ("sherpa_onnx", "numpy", "sounddevice", "pyperclip", "faster_whisper"):
        try:
            m = __import__(mod)
            print(f"{mod:<14}: {getattr(m, '__version__', 'ok')}")
        except Exception as e:
            print(f"{mod:<14}: MISSING ({e.__class__.__name__})")
    try:
        print(f"ffmpeg        : {find_ffmpeg()}")
    except SystemExit as e:
        print(f"ffmpeg        : {e}")
    try:
        import sounddevice as sd
        devs = sd.query_devices()
        default_in = sd.default.device[0]
        print("mic devices   :")
        for i, d in enumerate(devs):
            if d["max_input_channels"] <= 0:
                continue
            mark = " <- default" if i == default_in else ""
            print(f"  [{i:>2}] {d['name']}  ch={d['max_input_channels']}{mark}")
    except Exception as e:
        print(f"mic devices   : error {e}")


def cmd_file(a):
    src = Path(a.media)
    if not src.exists():
        raise SystemExit(f"no such file: {src}")
    t0 = time.perf_counter()
    audio = load_audio(src)
    dur = len(audio) / 16000.0
    engine = make_engine(a.engine, **({"size": a.model} if a.engine == "whisper" else {"lang": a.lang}))
    t1 = time.perf_counter()
    segs = transcribe_segments(engine, audio, 16000)
    text = "".join(s["text"] for s in segs)
    t2 = time.perf_counter()
    rtf = (t2 - t1) / dur if dur else 0.0
    if a.json:
        print(json.dumps({
            "engine": engine.name, "lang": a.lang, "duration": round(dur, 2),
            "rtf": round(rtf, 3), "segments": segs, "text": text,
        }, ensure_ascii=False))
    else:
        print(text)
    nseg = len(segs)
    log(f"[{engine.name}] dur={dur:.2f}s segs={nseg} load={t1 - t0:.2f}s "
        f"asr={t2 - t1:.2f}s rtf={rtf:.3f}")
    if a.out:
        outdir = Path(a.out)
        outdir.mkdir(parents=True, exist_ok=True)
        dst = outdir / (src.stem + ".stt.txt")
        dst.write_text(text + "\n", encoding="utf-8")
        log(f"written: {dst}")


def _db(x: float) -> float:
    import math

    return 20.0 * math.log10(max(float(x), 1e-9))


def _draw_meter(level: float, elapsed: float | None = None) -> None:
    """One-line live input meter on stderr, so stdout stays clean for the text."""
    db = _db(level)
    n = 24
    filled = int(round(max(0.0, min(1.0, (db + 60.0) / 60.0)) * n))
    bar = "=" * filled + "-" * (n - filled)
    tag = "silent" if db < -55 else ("speech" if db > -35 else "quiet")
    t = f" {elapsed:4.1f}s" if elapsed is not None else ""
    sys.stderr.write(f"\r  mic [{bar}] {db:6.1f} dBFS {tag:6s}{t}   ")
    sys.stderr.flush()


def _clear_meter() -> None:
    sys.stderr.write("\r" + " " * 64 + "\r")
    sys.stderr.flush()


def record_mic(seconds=None, device=None, meter: bool = True):
    import queue
    import threading

    import numpy as np
    import sounddevice as sd

    sr = 16000
    q: "queue.Queue" = queue.Queue()

    def cb(indata, frames, t, status):
        if status:
            log(f"[mic] {status}")
        q.put(indata.copy())

    with sd.InputStream(samplerate=sr, channels=1, dtype="float32", device=device, callback=cb):
        stop = threading.Event()
        if seconds:
            log(f"recording {seconds}s ...")
            timer = threading.Timer(float(seconds), stop.set)
            timer.start()
        else:
            input("按 Enter 开始录音 ...")
            log("录音中 —— 说完再按 Enter 停止")

            def waiter():
                try:
                    input()
                except EOFError:
                    pass
                stop.set()

            threading.Thread(target=waiter, daemon=True).start()
        chunks = []
        hold = 0.0
        last_draw = 0.0
        while not stop.is_set():
            try:
                blk = q.get(timeout=0.1)
            except queue.Empty:
                continue
            chunks.append(blk)
            hold = max(float(np.abs(blk).max()), hold * 0.88)
            now = time.time()
            if meter and now - last_draw >= 0.12:
                last_draw = now
                _draw_meter(hold, elapsed=sum(len(c) for c in chunks) / sr)
        if not seconds:
            stop.set()
    if meter:
        _clear_meter()
    if not chunks:
        return np.zeros(0, dtype="float32")
    return np.concatenate(chunks).reshape(-1).astype("float32")


def _log_mic(dur: float, peak_db: float, rms_db: float, text: str, dt: float) -> None:
    """Append one line per dictation so levels can be audited after the fact."""
    try:
        d = LOG_DIR
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "mic.log", "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} dur={dur:.2f}s "
                    f"peak={peak_db:.1f} rms={rms_db:.1f} asr={dt:.2f} "
                    f"chars={len(text)} text={text}\n")
    except Exception as e:
        log(f"[warn] cannot write mic log: {e}")


def cmd_mic(a):
    import numpy as np
    import pyperclip

    audio = record_mic(a.seconds, a.device, meter=not a.quiet)
    dur = len(audio) / 16000.0
    if dur < 0.3:
        raise SystemExit("nothing recorded")
    peak = float(np.abs(audio).max()) if len(audio) else 0.0
    rms = float(np.sqrt((audio.astype("float64") ** 2).mean()))
    peak_db, rms_db = _db(peak), _db(rms)
    if rms_db < -60.0:
        verdict = "几乎没声（录音时对着麦克风说话了吗？）"
    elif peak_db > -30.0:
        verdict = "电平良好"
    elif peak_db > -50.0:
        verdict = "偏小，已自动增益"
    else:
        verdict = "偏小，已自动增益（确认设备选对了）"
    log(f"[mic] 电平 peak={peak_db:.1f} dBFS rms={rms_db:.1f} dBFS - {verdict}")
    if peak < 0.002:
        log("[hint] capture is at noise-floor level - did you speak while it was "
            "recording? try 'stt.cmd probe' to pick another input device")
    elif peak > 0.98:
        log("[warn] capture is clipping - lower input volume or move back")
    engine = make_engine(a.engine, **({"size": a.model} if a.engine == "whisper" else {"lang": a.lang}))
    t0 = time.perf_counter()
    text, nseg = transcribe_long(engine, audio, 16000)
    dt = time.perf_counter() - t0
    if not text:
        log("no speech detected (mic too quiet or muted; try 'stt.cmd probe')")
        _log_mic(dur, peak_db, rms_db, "", dt)
        return
    print(text)
    log(f"[{engine.name}] dur={dur:.2f}s asr={dt:.2f}s rtf={dt / dur:.3f} segs={nseg}")
    _log_mic(dur, peak_db, rms_db, text, dt)
    try:
        pyperclip.copy(text)
        log("copied to clipboard")
    except Exception as e:
        log(f"clipboard failed: {e}")


def cmd_probe(a):
    """Record 1s from every input device and report level, so the right one is obvious."""
    import numpy as np
    import sounddevice as sd

    print(f"{'idx':>4}{'rms':>10}{'peak':>10}  name")
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] <= 0:
            continue
        try:
            rec = sd.rec(int(1.0 * 16000), samplerate=16000, channels=1,
                         dtype="float32", device=i)
            sd.wait()
            rec = rec.reshape(-1)
            rms = float(np.sqrt((rec.astype("float64") ** 2).mean()))
            peak = float(np.abs(rec).max())
            print(f"{i:>4}{rms:>10.5f}{peak:>10.3f}  {d['name']}")
        except Exception as e:
            print(f"{i:>4}{'ERR':>10}{'':>10}  {d['name']} ({e.__class__.__name__})")
    print("\npick the device with the highest rms while speaking, then: "
          "stt.cmd mic --device N")


def cmd_bench(a):
    src = Path(a.media)
    audio = load_audio(src)
    dur = len(audio) / 16000.0
    rows = []
    for eng in ("sensevoice", "whisper"):
        t0 = time.perf_counter()
        engine = make_engine(eng)
        load_s = time.perf_counter() - t0
        t1 = time.perf_counter()
        text, nseg = transcribe_long(engine, audio, 16000)
        dt = time.perf_counter() - t1
        rows.append((eng, cer(a.ref, text), dur and dt / dur, dt, load_s, text))
    print(f"\nref: {a.ref}\ndur: {dur:.2f}s\n")
    print(f"{'engine':<12}{'CER':>8}{'RTF':>8}{'asr_s':>8}{'load_s':>8}  text")
    for eng, c, rtf, dt, load_s, text in rows:
        print(f"{eng:<12}{c:>8.1%}{rtf:>8.3f}{dt:>8.2f}{load_s:>8.2f}  {text}")


def build_parser():
    p = argparse.ArgumentParser(prog="stt.py", description="offline Chinese speech-to-text")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="show status").set_defaults(func=cmd_doctor)

    f = sub.add_parser("file", help="transcribe a file")
    f.add_argument("media")
    f.add_argument("-o", "--out", default=None, help="output dir for <stem>.stt.txt")
    f.add_argument("--engine", choices=["sensevoice", "whisper"], default="sensevoice")
    f.add_argument("--lang", default="zh")
    f.add_argument("--model", default="small", help="whisper size when --engine whisper")
    f.add_argument("--json", action="store_true",
                   help="print one JSON object with segment start/end times (for video tools)")
    f.set_defaults(func=cmd_file)

    m = sub.add_parser("mic", help="dictation from microphone")
    m.add_argument("--seconds", type=float, default=None, help="fixed duration instead of Enter")
    m.add_argument("--device", default=None)
    m.add_argument("--quiet", action="store_true", help="no live level meter")
    m.add_argument("--engine", choices=["sensevoice", "whisper"], default="sensevoice")
    m.add_argument("--lang", default="zh")
    m.add_argument("--model", default="small")
    m.set_defaults(func=cmd_mic)

    b = sub.add_parser("bench", help="CER/RTF comparison")
    b.add_argument("media")
    b.add_argument("--ref", required=True, help="ground-truth text")
    b.set_defaults(func=cmd_bench)

    pr = sub.add_parser("probe", help="record 1s from each input device, report level")
    pr.set_defaults(func=cmd_probe)
    return p


def main(argv=None):
    a = build_parser().parse_args(argv)
    a.func(a)


if __name__ == "__main__":
    main()
