@echo off
rem LaoCut free voice server (Windows). First run installs everything (~2 GB)
rem and downloads the voice model (~130 MB); later runs start at once.
cd /d "%~dp0"
set OPENVOICE=https://github.com/myshell-ai/OpenVoice/archive/74a1d147b17a8c3092dd5430504bd83ef6c7eb23.zip
if not exist .venv (
  py -3 -m venv .venv 2>nul || python -m venv .venv
)
if not exist .venv\Scripts\python.exe (
  echo Python not found. Install Python 3.11 from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^)
  pause
  exit /b 1
)
call .venv\Scripts\activate.bat
if not exist .venv\installed.txt (
  python -m pip install --upgrade pip
  pip install -r requirements.txt || goto fail
  pip install --no-deps %OPENVOICE% || goto fail
  echo ok> .venv\installed.txt
)
python server.py
pause
exit /b 0
:fail
echo Installation failed - check the internet connection and try again.
pause
exit /b 1
