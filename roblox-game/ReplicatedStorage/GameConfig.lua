--[[
	GameConfig (ModuleScript) — วางไว้ใน ReplicatedStorage
	ปรับตัวเลขต่าง ๆ ของเกมได้ที่นี่ที่เดียว
]]

return {
	CoinValue = 1, -- ได้กี่เหรียญต่อการเก็บหนึ่งครั้ง
	CoinRespawnTime = 10, -- วินาทีก่อนเหรียญเกิดใหม่
	CoinsPerStage = 5, -- โบนัสเมื่อผ่านด่าน

	DefaultWalkSpeed = 16,
	DefaultJumpPower = 50,

	AutoSaveInterval = 120, -- วินาที
	SaveInStudio = false, -- เปิดเป็น true ถ้าอยากทดสอบการเซฟใน Studio

	Shop = {
		Speed = { DisplayName = "วิ่งเร็ว", Price = 25, Value = 28 },
		Jump = { DisplayName = "กระโดดสูง", Price = 40, Value = 75 },
	},
}
