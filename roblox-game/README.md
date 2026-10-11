# Obby เก็บเหรียญ — สคริปต์เกม Roblox

เกมกระโดดข้ามด่าน (Obby) พร้อมระบบเก็บเหรียญ เช็คพอยต์ ลาวา ร้านค้า และเซฟข้อมูล

## ไฟล์และตำแหน่งที่ต้องวางใน Roblox Studio

| ไฟล์ | ประเภท | วางไว้ที่ |
|---|---|---|
| `ReplicatedStorage/GameConfig.lua` | **ModuleScript** ชื่อ `GameConfig` | ReplicatedStorage |
| `ServerScriptService/GameServer.server.lua` | **Script** | ServerScriptService |
| `StarterPlayerScripts/GameUI.client.lua` | **LocalScript** | StarterPlayer › StarterPlayerScripts |

## วิธีสร้างแผนที่

สร้าง **Folder** 3 อันใน `Workspace`:

1. **`Checkpoints`** — ใส่ Part ที่ตั้งชื่อเป็นเลข `1`, `2`, `3`, … ตามลำดับด่าน
   (Part `1` คือจุดเกิดเริ่มต้น) ตั้ง `Anchored = true`
2. **`Coins`** — ใส่ Part ทรงกระบอกสีทองเป็นเหรียญ (สคริปต์จะทำให้หมุนและเดินทะลุได้เอง)
3. **`KillParts`** — ใส่ Part สีแดง/ลาวา แตะแล้วตาย ตั้ง `Anchored = true`

## เปิดใช้การเซฟข้อมูล

Home › Game Settings › Security › เปิด **Enable Studio Access to API Services**
(ต้อง Publish เกมก่อน) ถ้าจะทดสอบการเซฟใน Studio ให้ตั้ง `SaveInStudio = true` ใน `GameConfig`

## ปรับแต่ง

แก้ค่าทั้งหมดได้ใน `GameConfig` เช่น จำนวนเหรียญ เวลาเกิดใหม่ ราคาของในร้าน
เพิ่มสินค้าใหม่ได้โดยเพิ่มรายการใน `Shop` แล้วเพิ่มการใช้งานใน `applyUpgrades` ของ `GameServer`
