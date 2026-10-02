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

## โครงสร้างโปรเจกต์

```
server.js              จุดเริ่มเซิร์ฟเวอร์ + session + socket.io
db.js                   ที่เก็บข้อมูลแบบไฟล์ JSON (ไม่ต้องติดตั้ง native module)
routes/auth.js          login / logout / เปลี่ยนรหัสผ่าน
routes/api.js           conversations / messages / settings / demo seed
routes/webhooks.js      รับ webhook จาก Meta (Messenger, Instagram, WhatsApp)
services/graph.js       เรียก Graph API เพื่อส่งข้อความออก
services/store.js       normalize ข้อมูลแชทจากทุกแพลตฟอร์มให้เป็นรูปแบบเดียวกัน + broadcast realtime
public/                 หน้าเว็บ (login, dashboard) และ CSS/JS ฝั่ง client
```

## ข้อควรรู้ / ข้อจำกัดของเดโมนี้

- รองรับข้อความตัวอักษรเท่านั้น (ยังไม่รองรับรูปภาพ/ไฟล์/สติกเกอร์)
- เก็บข้อมูลเป็นไฟล์ `data/db.json` เหมาะกับการทดสอบ/ใช้งานคนเดียว หากจะใช้งานจริงกับทีม
  ควรเปลี่ยนไปใช้ฐานข้อมูลจริง (PostgreSQL/MySQL) และเก็บ secrets ใน secret manager
  แทนไฟล์ settings
- ควร deploy หลัง HTTPS (เช่น ผ่าน reverse proxy หรือ hosting ที่มี TLS) เพราะ Meta
  กำหนดให้ webhook URL ต้องเป็น HTTPS
