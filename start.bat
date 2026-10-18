@echo off
chcp 65001 >nul
title LaoCut
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo ບໍ່ພົບ Node.js — ກະລຸນາຕິດຕັ້ງຈາກ https://nodejs.org ກ່ອນ ແລ້ວເປີດໄຟລ໌ນີ້ໃໝ່
  start https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo ກຳລັງຕິດຕັ້ງ (ຄັ້ງທຳອິດເທົ່ານັ້ນ)...
  call npm install --omit=dev
)
echo LaoCut ກຳລັງເປີດ... ຢ່າປິດໜ້າຕ່າງນີ້ ຕອນໃຊ້ໂປຣແກຣມ
start "" http://localhost:3000/editor.html
node server.js
pause
