"""OmniVoice, kept warm for the app.

The app starts this once and talks to it in JSON lines. One line in is one thing to say; one line out is where the
recording went, or why there is none. Everything else it prints is a `{"line": ...}` for the card.

In:  {"say": text, "out": path, "design": instruct?, "ref": path?, "ref_text": text?, "language": id-or-name?}
Out: {"wav": path, "seconds": n} | {"error": sentence}

The first line out says where it runs: {"ready": true, "device": "cuda" | "cpu", "why": sentence}.
The weights live under HF_HOME, which the app points into its own cache.
"""

import json
import os
import sys
import threading
import time

MODEL = "k2-fsa/OmniVoice"
# The two weight files, read off the model page on 24 September 2026. Used only to say how far a download has got.
WEIGHT_BYTES = 2_450_344_112 + 805_665_628
# The words model that transcribes a reference nobody wrote down. The small one: a clone needs the words, not polish.
ASR = "openai/whisper-base"
# What the card must see before the weights will fit beside whatever else is on the graphics card.
NEEDS_VRAM = 2.4 * 1024**3


def say(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def line(text):
    say({"line": text})


def cached():
    try:
        from huggingface_hub import snapshot_download

        return snapshot_download(MODEL, local_files_only=True)
    except Exception:
        return None


def fetch():
    """Download once, saying how far along it is. The size is what the hub folder has grown to."""
    from huggingface_hub import snapshot_download

    home = os.environ.get("HF_HOME", "")
    line(f"getting OmniVoice ready: {WEIGHT_BYTES / 1e9:.1f} GB, once, into {home}")
    done = threading.Event()

    def watch():
        said = -1
        while not done.wait(2):
            got = 0
            for root, _dirs, files in os.walk(home):
                for name in files:
                    try:
                        got += os.path.getsize(os.path.join(root, name))
                    except OSError:
                        pass
            whole = min(100, int(got / WEIGHT_BYTES * 10) * 10)
            if whole > said:
                said = whole
                line(f"OmniVoice, {whole}%…")

    threading.Thread(target=watch, daemon=True).start()
    try:
        return snapshot_download(MODEL)
    finally:
        done.set()


def where():
    """The graphics card when there is one and room on it; otherwise the processor, which is slower and always there."""
    import torch

    asked = os.environ.get("STAGE_OMNIVOICE_DEVICE", "").strip().lower()
    if asked == "cpu":
        return "cpu", "the founder asked for the processor"
    if not torch.cuda.is_available():
        return "cpu", "there is no graphics card this can use"
    free, _total = torch.cuda.mem_get_info()
    if asked != "cuda" and free < NEEDS_VRAM:
        return "cpu", f"the graphics card has {free / 1024**3:.1f} GB free and this needs about {NEEDS_VRAM / 1024**3:.1f}"
    return "cuda", f"{free / 1024**3:.1f} GB free on the graphics card"


def reference(path):
    """A reference longer than twenty seconds is cut to its first fifteen: the model clones best from a few seconds."""
    import librosa
    import torch

    samples, rate = librosa.load(path, sr=None, mono=True)
    seconds = len(samples) / rate
    if seconds < 2:
        raise ValueError(f"the reference is {seconds:.1f} seconds long; a clone needs five to twenty")
    if seconds > 20:
        line(f"the reference is {round(seconds)} seconds; only its first fifteen are used")
        samples = samples[: int(rate * 15)]
    return torch.from_numpy(samples).unsqueeze(0), rate


def main():
    import soundfile
    import torch

    path = cached() or fetch()
    device, why = where()
    line(f"loading OmniVoice on the {'graphics card' if device == 'cuda' else 'processor'}…")
    from omnivoice import OmniVoice

    model = OmniVoice.from_pretrained(
        path,
        device_map="cuda:0" if device == "cuda" else "cpu",
        dtype=torch.float16 if device == "cuda" else torch.float32,
        asr_model_name=ASR,
        asr_device="cpu",
    )
    say({"ready": True, "device": device, "why": why})

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            ask = json.loads(raw)
            text = str(ask.get("say") or "").strip()
            if not text:
                raise ValueError("there is nothing to say")
            options = {"text": text}
            if ask.get("language"):
                options["language"] = str(ask["language"])
            if ask.get("ref"):
                if not ask.get("ref_text"):
                    line("listening to the reference to write down its words (the first time, a 290 MB download)…")
                options["ref_audio"] = reference(str(ask["ref"]))
                if ask.get("ref_text"):
                    options["ref_text"] = str(ask["ref_text"])
            elif ask.get("design"):
                options["instruct"] = str(ask["design"])
            started = time.time()
            audio = model.generate(**options)[0]
            out = str(ask["out"])
            soundfile.write(out, audio, model.sampling_rate, subtype="PCM_16")
            say({"wav": out, "seconds": len(audio) / model.sampling_rate, "took": time.time() - started})
        except Exception as error:  # the app hears every failure as a sentence, and the worker lives on
            words = str(error).strip().split("\n")[0][:300] or error.__class__.__name__
            say({"error": words})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        say({"error": f"OmniVoice could not start: {str(error).strip().splitlines()[0][:300] if str(error).strip() else error.__class__.__name__}"})
        sys.exit(1)
