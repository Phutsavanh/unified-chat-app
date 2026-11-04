#!/usr/bin/env bash
# LaoCut free voice server (Mac / Linux). First run installs everything
# (~2 GB) and downloads the voice model (~130 MB); later runs start at once.
set -e
cd "$(dirname "$0")"
OPENVOICE=https://github.com/myshell-ai/OpenVoice/archive/74a1d147b17a8c3092dd5430504bd83ef6c7eb23.zip
PY=${PYTHON:-python3}
if [ ! -d .venv ]; then "$PY" -m venv .venv; fi
. .venv/bin/activate
if [ ! -f .venv/installed ]; then
  python -m pip install --upgrade pip
  pip install -r requirements.txt
  pip install --no-deps "$OPENVOICE"
  touch .venv/installed
fi
python server.py
