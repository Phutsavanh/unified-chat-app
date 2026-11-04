"""LaoCut free voice server — voice cloning that runs on your own computer.

How a line is voiced:
  1. Base speech with a native Lao accent: Microsoft's free Edge "read aloud"
     voices (edge-tts, no account or key), or audio LaoCut sends in (for
     example from Azure Speech).
  2. OpenVoice V2's tone-colour converter (MIT licence, free for commercial
     use) changes the voice so it sounds like the cloned speaker, keeping
     the base speech's words and Lao pronunciation.

Only LaoCut (running on the same computer) talks to this server; it listens
on 127.0.0.1. Start it with start.bat (Windows) or ./start.sh (Mac/Linux).
"""
import os
import re
import sys
import tempfile
import threading
import types
import urllib.request
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("VOICE_DATA", HERE / "data"))
CKPT = DATA / "checkpoints" / "converter"
VOICES = DATA / "voices"
BASE_SES = DATA / "base_ses"
HF = "https://huggingface.co/myshell-ai/OpenVoiceV2/resolve/main/converter/"
HOST = os.environ.get("VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICE_PORT", "7861"))

# Free Microsoft neural voices used as the base speech (Lao first).
BASE_VOICES = {
    "lo-LA-KeomanyNeural": "ແກ້ວມະນີ — ຍິງ (ລາວ)",
    "lo-LA-ChanthavongNeural": "ຈັນທະວົງ — ຊາຍ (ລາວ)",
    "th-TH-PremwadeeNeural": "Premwadee — ຍິງ (ໄທ)",
    "th-TH-NiwatNeural": "Niwat — ຊາຍ (ໄທ)",
    "en-US-JennyNeural": "Jenny — ຍິງ (English)",
    "en-US-GuyNeural": "Guy — ຊາຍ (English)",
}
# Spoken once per base voice to measure its own tone colour.
REF_TEXT = {
    "lo": "ສະບາຍດີທຸກຄົນ ມື້ນີ້ອາກາດດີຫຼາຍ ພວກເຮົາຈະໄປທ່ຽວຕະຫຼາດເຊົ້າ ແລະ ກິນເຂົ້າປຽກນຳກັນ "
          "ຫຼັງຈາກນັ້ນຈະໄປຍ່າງຫຼິ້ນແຄມຂອງ ເບິ່ງຕາເວັນຕົກດິນທີ່ສວຍງາມ.",
    "th": "สวัสดีทุกคน วันนี้อากาศดีมาก เราจะไปเที่ยวตลาดเช้าและกินข้าวด้วยกัน แล้วไปเดินเล่นริมแม่น้ำโขง",
    "en": "Hello everyone. The weather is lovely today, so we are heading to the morning market, "
          "and later we will walk along the river to watch the sunset.",
}

app = FastAPI(title="LaoCut voice server")
state = {"converter": None, "device": None, "error": None, "loading": False}
model_lock = threading.Lock()


# ------------------------------------------------------------------ model
def download(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"Downloading {url}")

    def progress(blocks, size, total):
        if total > 0:
            print(f"\r  {min(100, blocks * size * 100 // total)}%", end="", flush=True)

    urllib.request.urlretrieve(url, tmp, progress)
    print()
    tmp.replace(dest)


def load_converter():
    for name in ("config.json", "checkpoint.pth"):
        if not (CKPT / name).exists():
            download(HF + name, CKPT / name)

    import torch
    import openvoice  # noqa: F401  (the package must exist before stubbing its submodule)

    # openvoice.api imports the Chinese/English text front-end for its own
    # TTS, which pulls in many packages. Only the converter is used here.
    text = types.ModuleType("openvoice.text")
    text.text_to_sequence = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("not used"))
    sys.modules["openvoice.text"] = text
    from openvoice.api import OpenVoiceBaseClass, ToneColorConverter

    class Converter(ToneColorConverter):
        # ToneColorConverter's own __init__ always loads the wavmark model;
        # set up the network directly instead.
        def __init__(self, config_path, device):
            OpenVoiceBaseClass.__init__(self, config_path, device=device)
            self.watermark_model = None
            self.version = getattr(self.hps, "_version_", "v1")

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    conv = Converter(str(CKPT / "config.json"), device=device)
    conv.load_ckpt(str(CKPT / "checkpoint.pth"))
    return conv, device


def ensure_model():
    if state["converter"] is not None:
        return state["converter"]
    with model_lock:
        if state["converter"] is None:
            state["loading"] = True
            try:
                state["converter"], state["device"] = load_converter()
                state["error"] = None
            except Exception as e:  # report it on /health instead of crashing
                state["error"] = f"{type(e).__name__}: {e}"
                raise
            finally:
                state["loading"] = False
    return state["converter"]


@app.on_event("startup")
def warm_up():
    # load in the background so /health answers right away
    threading.Thread(target=lambda: _try(ensure_model), daemon=True).start()


def _try(fn):
    try:
        fn()
    except Exception as e:
        print("Model failed to load:", e)


# ------------------------------------------------------------------ helpers
def voice_path(voice_id):
    if not re.fullmatch(r"[a-f0-9]{32}", voice_id or ""):
        raise HTTPException(400, "bad voice id")
    return VOICES / f"{voice_id}.pt"


def load_se(path):
    import torch
    return torch.load(path, map_location=state["device"])


async def edge_tts_to_file(text, voice, rate, path):
    import edge_tts
    communicate = edge_tts.Communicate(text, voice, rate=f"{int(rate):+d}%")
    await communicate.save(str(path))


async def base_se(voice):
    """Tone colour of a base voice, measured once from a reference paragraph."""
    path = BASE_SES / f"{voice}.pt"
    if path.exists():
        return load_se(path)
    conv = await run_in_threadpool(ensure_model)
    with tempfile.TemporaryDirectory() as tmp:
        ref = Path(tmp) / "ref.mp3"
        await edge_tts_to_file(REF_TEXT[voice[:2]], voice, 0, ref)
        BASE_SES.mkdir(parents=True, exist_ok=True)
        return await run_in_threadpool(locked, conv.extract_se, [str(ref)], str(path))


def locked(fn, *args, **kwargs):
    with model_lock:
        return fn(*args, **kwargs)


async def convert_file(src_path, voice_id, base_voice=None, tau=0.3):
    conv = await run_in_threadpool(ensure_model)
    tgt = load_se(voice_path(voice_id))
    src = None
    if base_voice in BASE_VOICES:
        try:
            src = await base_se(base_voice)
        except Exception as e:
            print("Base voice reference failed, measuring the clip itself:", e)
    if src is None:
        src = await run_in_threadpool(locked, conv.extract_se, [str(src_path)])
    out = Path(src_path).with_name("out.wav")
    await run_in_threadpool(locked, conv.convert, str(src_path), src, tgt, str(out), tau)
    return out.read_bytes()


async def save_upload(upload, folder, name):
    path = Path(folder) / name
    path.write_bytes(await upload.read())
    return path


# ------------------------------------------------------------------ API
@app.get("/health")
def health():
    return {
        "ok": True,
        "ready": state["converter"] is not None,
        "loading": state["loading"],
        "device": state["device"],
        "error": state["error"],
        "baseVoices": BASE_VOICES,
    }


@app.post("/voices")
async def create_voice(files: list[UploadFile] = File(...)):
    """Measures the speaker's tone colour from the samples and stores it."""
    if not files or len(files) > 10:
        raise HTTPException(400, "send 1-10 audio files")
    conv = await run_in_threadpool(ensure_model)
    voice_id = uuid.uuid4().hex
    VOICES.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for i, f in enumerate(files):
            ext = Path(f.filename or "").suffix.lower() or ".wav"
            paths.append(str(await save_upload(f, tmp, f"{i}{ext}")))
        try:
            await run_in_threadpool(locked, conv.extract_se, paths, str(voice_path(voice_id)))
        except Exception as e:
            raise HTTPException(400, f"could not read the audio ({e}); send WAV files")
    return {"id": voice_id}


@app.delete("/voices/{voice_id}")
def delete_voice(voice_id: str):
    voice_path(voice_id).unlink(missing_ok=True)
    return {"ok": True}


@app.post("/convert")
async def convert(audio: UploadFile = File(...), voice_id: str = Form(...),
                  base_voice: str = Form(""), tau: float = Form(0.3)):
    """Re-voices given speech (e.g. Azure Lao TTS) as the cloned speaker."""
    if not voice_path(voice_id).exists():
        raise HTTPException(404, "voice not found — clone it again")
    with tempfile.TemporaryDirectory() as tmp:
        src = await save_upload(audio, tmp, "src" + (Path(audio.filename or "").suffix or ".wav"))
        wav = await convert_file(src, voice_id, base_voice, min(1.0, max(0.1, tau)))
    return Response(wav, media_type="audio/wav")


class SpeakRequest(BaseModel):
    text: str
    voice_id: str = ""
    base_voice: str = "lo-LA-KeomanyNeural"
    rate: int = 0
    tau: float = 0.3


@app.post("/tts")
async def tts(req: SpeakRequest):
    """Free Microsoft base voice → cloned voice."""
    text = req.text.strip()
    if not text or len(text) > 3000:
        raise HTTPException(400, "text must be 1-3000 characters")
    if req.base_voice not in BASE_VOICES:
        raise HTTPException(400, "unknown base voice")
    if req.voice_id and not voice_path(req.voice_id).exists():
        raise HTTPException(404, "voice not found — clone it again")
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "base.mp3"
        try:
            await edge_tts_to_file(text, req.base_voice, max(-50, min(100, req.rate)), src)
        except Exception as e:
            raise HTTPException(502, f"Microsoft base voice failed ({e}); check the internet connection")
        if not req.voice_id:
            return Response(src.read_bytes(), media_type="audio/mpeg")
        wav = await convert_file(src, req.voice_id, req.base_voice, min(1.0, max(0.1, req.tau)))
    return Response(wav, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    print(f"LaoCut voice server: http://{HOST}:{PORT}  (data: {DATA})")
    uvicorn.run(app, host=HOST, port=PORT)
