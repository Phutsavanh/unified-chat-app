# Unified Chat Inbox

เว็บแอปรวมแชทจาก WhatsApp, Facebook Messenger และ Instagram DM ไว้หน้าเดียว
มีระบบ login ของตัวเอง, หน้า Settings สำหรับเชื่อมต่อ Meta Graph API, และโหมด Demo
สำหรับทดลองใช้ UI ได้ทันทีโดยไม่ต้องรอ API จริง

## เริ่มใช้งาน

```bash
npm install
npm start
```

เปิดเบราว์เซอร์ไปที่ `http://localhost:3000`

ครั้งแรกที่เข้าใช้งาน ระบบจะพาไปหน้า **สมัครบัญชีแอดมิน** ให้ตั้ง username/password ของตัวเอง
(เป็นบัญชีแอดมินเดียวของระบบ) หลังจากนั้นทุกครั้งที่เข้าเว็บจะเจอหน้า login ตามปกติ

## ทดลองใช้งานแบบ Demo (ไม่ต้องมี API จริง)

1. Login เข้าระบบ
2. กด ⚙ ตั้งค่า / เชื่อมต่อ API
3. กด "โหลดข้อมูลตัวอย่าง (Demo)"
4. จะเห็นแชทตัวอย่างจาก WhatsApp / Messenger / Instagram ปรากฏในกล่องแชทรวมทันที

## เชื่อมต่อ API จริง (สำคัญ — ต้องมี Meta Business App)

**WhatsApp, Facebook Messenger และ Instagram ล้วนเป็นแพลตฟอร์มของ Meta** การรวมแชท
"จริง" ต้องทำผ่าน Meta Graph API อย่างถูกต้อง — ไม่มีวิธี login ด้วยบัญชีส่วนตัวแล้วให้โปรแกรม
อ่าน/ส่งข้อความแทนได้โดยไม่ผิดเงื่อนไขการใช้งาน (ToS) ของแต่ละแพลตฟอร์ม และบัญชีที่ใช้วิธี
ไม่เป็นทางการมีความเสี่ยงสูงที่จะถูกระบบตรวจจับแล้วระงับการใช้งาน

ขั้นตอนคร่าว ๆ:

1. สร้าง App ที่ [developers.facebook.com](https://developers.facebook.com) เลือกประเภท "Business"
2. เพิ่ม Product: **Messenger**, **Instagram**, **WhatsApp**
3. เชื่อม Facebook Page ของคุณกับ Instagram Business/Professional account
4. ไปที่หน้า Settings ในแอปนี้ กรอก:
   - `Page Access Token` (จากหน้า Messenger > Settings)
   - `Instagram Business Account ID`
   - `WhatsApp Phone Number ID` และ `Access Token` (จากหน้า WhatsApp > API Setup)
   - `Webhook Verify Token` — ตั้งค่าเองเป็นค่าอะไรก็ได้ แล้วใช้ค่าเดียวกันในขั้นตอนถัดไป
5. ตั้งค่า Webhook ในหน้า Meta App ให้ชี้ไปที่ URL ที่แอปนี้แสดงไว้ในหน้า Settings
   (รูปแบบ `https://<โดเมนของคุณ>/webhook`) — ตอนพัฒนาในเครื่องสามารถใช้
   [ngrok](https://ngrok.com) เพื่อเปิด URL ชั่วคราวที่เข้าถึงได้จากอินเทอร์เน็ต:
   ```bash
   ngrok http 3000
   ```
   แล้วเอา URL ที่ ngrok ให้มา + `/webhook` ไปตั้งในหน้า Meta App
6. Subscribe webhook fields ที่ต้องใช้: `messages` (สำหรับ Messenger/Instagram) และ
   `messages` (สำหรับ WhatsApp Business Account)
7. ขอ permission ที่ต้องใช้งานจริง (`pages_messaging`, `instagram_manage_messages`,
   `whatsapp_business_messaging`) ซึ่งสำหรับแอปที่ใช้งานกับคนอื่น (ไม่ใช่แค่ตัวเอง/ทีมทดสอบ)
   Meta จะต้องทำ **App Review** ก่อนใช้งานจริงกับผู้ใช้ทั่วไป

เมื่อตั้งค่าครบ ข้อความที่ลูกค้าทักเข้ามาในทั้ง 3 แพลตฟอร์มจะขึ้นในกล่องแชทรวมของแอปนี้
real-time และตอบกลับจากที่นี่ได้เลย

## LaoCut — ໂປຣແກຣມຕັດຕໍ່ວິດີໂອພາສາລາວ (`/editor.html`)

ໂປຣແກຣມຕັດຕໍ່ວິດີໂອໃນເບົາເຊີ ແບບດຽວກັບ CapCut. ເຂົ້າໃຊ້ໄດ້ທີ່ `http://localhost:3000/editor.html`
(ຫຼື ກົດປຸ່ມ 🎬 ໃນໜ້າ Inbox). ໃຊ້ບັນຊີແອດມິນດຽວກັນກັບ Inbox.

**ການຕັດຕໍ່**
- ນຳເຂົ້າວິດີໂອ / ຮູບ / ເພງ (ລາກວາງໄດ້). ໄຟລ໌ຢູ່ໃນເຄື່ອງເທົ່ານັ້ນ, ບໍ່ອັບໂຫຼດຂຶ້ນເຊີບເວີ
- Timeline 4 ແທຣັກ: ຂໍ້ຄວາມ, ຊັບໄຕເຕິ້ນ, ວິດີໂອຫຼັກ (ຕໍ່ກັນອັດຕະໂນມັດແບບ CapCut), ສຽງ/ເພງ
- ຕັດ (S), ລຶບ, ສຳເນົາ, ລາກຍ້າຍ/ລາກຂອບເພື່ອຕັດຫົວ-ທ້າຍ, ດູດຕິດຂອບຄລິບ, ຍົກເລີກ/ເຮັດຄືນ
- ອັດຕາສ່ວນຈໍ 16:9, 9:16 (TikTok), 1:1, 4:5 ແລະ ພື້ນຫຼັງມົວ
- ບັນທຶກໂປຣເຈັກອັດຕະໂນມັດໃນເບົາເຊີ (ປິດແລ້ວເປີດໃໝ່ກໍ່ຍັງຢູ່)
- ສົ່ງອອກເປັນ MP4/WebM ພ້ອມຊັບຝັງໃນວິດີໂອ, ຫຼື ສົ່ງອອກຊັບແຍກເປັນ .srt / .vtt

**ຮອງຮັບພາສາລາວ**
- ຟອນລາວ 4 ແບບ: Noto Sans Lao, Noto Sans Lao Looped, Noto Serif Lao, Phetsarath
- ຕັດແຖວຕາມຄຳລາວ (ພາສາລາວບໍ່ມີຍະຫວ່າງລະຫວ່າງຄຳ), ນັບຕົວອັກສອນລວມສະຫຼະ/ວັນນະຍຸດຢ່າງຖືກຕ້ອງ
- ແອນິເມຊັນພິມດີດທີ່ບໍ່ແຍກສະຫຼະອອກຈາກພະຍັນຊະນະ
- ເຄື່ອງມືແກ້ຂໍ້ຄວາມ: ແກ້ ໍ+າ → ຳ, ປ່ຽນ ຫນ/ຫມ → ໜ/ໝ, ເລກອາຣັບ ↔ ເລກລາວ (໑໒໓), ຊອກຫາ/ແທນທີ່
- ໜ້າຈໍທັງໝົດເປັນພາສາລາວ

**ຊັບອັດຕະໂນມັດ**
1. **ດ້ວຍ AI (Whisper)** — ຖອດຄວາມສຽງເວົ້າພາສາລາວ (ແລະ ອີກ 7 ພາສາ) ເປັນຊັບພ້ອມເວລາ.
   ຕ້ອງມີ OpenAI API Key: ຕັ້ງ `OPENAI_API_KEY` ໃນ `.env` ຫຼື ໃສ່ໃນ ⚙ ຂອງໂປຣແກຣມ.
   ສຽງຈະຖືກລວມຈາກ timeline ເປັນ 16 kHz ໃນເບົາເຊີ ແລ້ວສົ່ງຜ່ານເຊີບເວີ (Key ບໍ່ອອກໄປຫາເບົາເຊີ)
2. **ແປຊັບ (AI)** — ແປຊັບເປັນ English, ໄທ, ລາວ ແລະ ອື່ນໆ. ເລືອກໄດ້ວ່າຈະແທນທີ່ ຫຼື ສະແດງ
   ສອງພາສາ (ຄຳແປຢູ່ແຖວລຸ່ມ). ໃຊ້ Key ດຽວກັນ, ປ່ຽນໂມເດລໄດ້ດ້ວຍ `OPENAI_TRANSLATE_MODEL`
   (ຄ່າເລີ່ມຕົ້ນ `gpt-4o-mini`)
3. **ສຽງພາກ AI ພາສາລາວ** (ແຖບ 🎙 ສຽງພາກ) — ພິມຂໍ້ຄວາມແລ້ວໄດ້ສຽງພາກ, ຫຼື ພາກສຽງໃຫ້ທຸກແຖວຊັບ
   ແລະ ວາງໃຫ້ກົງເວລາ (ເລັ່ງສຽງອັດຕະໂນມັດຖ້າຍາວເກີນ, ຫຼຸດສຽງວິດີໂອເດີມ, ພາກຈາກແຖວຄຳແປກໍ່ໄດ້).
   ສຽງລາວແທ້ໃຊ້ **Microsoft Azure Speech** (ແກ້ວມະນີ — ຍິງ, ຈັນທະວົງ — ຊາຍ): ສ້າງ Speech resource
   ທີ່ portal.azure.com ແລ້ວໃສ່ Key + Region ໃນ ⚙ ຫຼື `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`
   (ແຜນຟຣີ 500,000 ຕົວອັກສອນ/ເດືອນ). ຫຼື ໃຊ້ OpenAI (Key ເດີມ, ແຕ່ສຳນຽງລາວບໍ່ເປັນທຳມະຊາດ)
4. **ຈັດເວລາຈາກບົດ (ບໍ່ຕ້ອງໃຊ້ AI)** — ວາງບົດເວົ້າ ແລ້ວໂປຣແກຣມຈະຈັບຈັງຫວະສຽງເວົ້າ ແລະ
   ວາງຊັບໃຫ້ຕາມຊ່ວງທີ່ເວົ້າ. ຖ້າບໍ່ມີບົດ ຈະສ້າງຊ່ອງວ່າງຕາມສຽງເວົ້າໃຫ້ພິມເອງ

> ແນະນຳ Chrome ຫຼື Edge ລຸ້ນໃໝ່ (ຕ້ອງການ `Intl.Segmenter`, `MediaRecorder` ແລະ Web Audio).
> ການສົ່ງອອກວິດີໂອໃຊ້ເວລາເທົ່າກັບຄວາມຍາວວິດີໂອ ແລະ ຕ້ອງເປີດແຖບໄວ້ຈົນສຳເລັດ.

## โครงสร้างโปรเจกต์

```
server.js              จุดเริ่มเซิร์ฟเวอร์ + session + socket.io
db.js                   ที่เก็บข้อมูลแบบไฟล์ JSON (ไม่ต้องติดตั้ง native module)
routes/auth.js          login / logout / เปลี่ยนรหัสผ่าน
routes/api.js           conversations / messages / settings / demo seed
routes/webhooks.js      รับ webhook จาก Meta (Messenger, Instagram, WhatsApp)
routes/editor.js        API ของโปรแกรมตัดต่อวิดีโอ (ถอดความ Whisper, แปลซับ, เสียงพากย์ AI)
services/tts.js         เรียก Azure Speech / OpenAI เพื่อสร้างเสียงพากย์
services/graph.js       เรียก Graph API เพื่อส่งข้อความออก
services/store.js       normalize ข้อมูลแชทจากทุกแพลตฟอร์มให้เป็นรูปแบบเดียวกัน + broadcast realtime
public/                 หน้าเว็บ (login, dashboard) และ CSS/JS ฝั่ง client
public/editor.html      โปรแกรมตัดต่อวิดีโอ LaoCut
public/js/editor/       timeline, ตัวเล่น/เรนเดอร์ canvas, ซับอัตโนมัติ, ตัดคำภาษาลาว, ส่งออก
```

## ข้อควรรู้ / ข้อจำกัดของเดโมนี้

- รองรับข้อความตัวอักษรเท่านั้น (ยังไม่รองรับรูปภาพ/ไฟล์/สติกเกอร์)
- เก็บข้อมูลเป็นไฟล์ `data/db.json` เหมาะกับการทดสอบ/ใช้งานคนเดียว หากจะใช้งานจริงกับทีม
  ควรเปลี่ยนไปใช้ฐานข้อมูลจริง (PostgreSQL/MySQL) และเก็บ secrets ใน secret manager
  แทนไฟล์ settings
- ควร deploy หลัง HTTPS (เช่น ผ่าน reverse proxy หรือ hosting ที่มี TLS) เพราะ Meta
  กำหนดให้ webhook URL ต้องเป็น HTTPS
