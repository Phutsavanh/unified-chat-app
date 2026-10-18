#!/bin/bash
# LaoCut launcher for macOS / Linux: double-click (macOS) or run ./start.command
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "ບໍ່ພົບ Node.js — ກະລຸນາຕິດຕັ້ງຈາກ https://nodejs.org ກ່ອນ"
  (open https://nodejs.org || xdg-open https://nodejs.org) >/dev/null 2>&1
  read -r -p "ກົດ Enter ເພື່ອປິດ"
  exit 1
fi
[ -d node_modules ] || npm install --omit=dev
echo "LaoCut ກຳລັງເປີດ... ຢ່າປິດໜ້າຕ່າງນີ້ ຕອນໃຊ້ໂປຣແກຣມ"
(sleep 2; open http://localhost:3000/editor.html || xdg-open http://localhost:3000/editor.html) >/dev/null 2>&1 &
node server.js
