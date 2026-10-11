--[[
	GameServer (Script) — วางไว้ใน ServerScriptService

	เกม Obby เก็บเหรียญ:
	  • leaderstats แสดง Coins และ Stage บนกระดานคะแนน
	  • เซฟข้อมูลผู้เล่นด้วย DataStore
	  • จุดเช็คพอยต์ (Workspace.Checkpoints) — ตั้งชื่อ Part เป็นเลข 1, 2, 3, ...
	  • เหรียญ (Workspace.Coins) — เก็บแล้วหายไปชั่วคราว แล้วเกิดใหม่
	  • พื้นลาวา (Workspace.KillParts) — แตะแล้วตาย
	  • ร้านค้า: ซื้อความเร็ว / กระโดดสูง ผ่าน RemoteEvent
]]

local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Config = require(ReplicatedStorage:WaitForChild("GameConfig"))

local playerStore = DataStoreService:GetDataStore("ObbyCoinData_v1")

-- RemoteEvents สำหรับคุยกับฝั่ง Client
local remotes = Instance.new("Folder")
remotes.Name = "Remotes"
remotes.Parent = ReplicatedStorage

local coinCollected = Instance.new("RemoteEvent")
coinCollected.Name = "CoinCollected"
coinCollected.Parent = remotes

local buyItem = Instance.new("RemoteFunction")
buyItem.Name = "BuyItem"
buyItem.Parent = remotes

local checkpointsFolder = workspace:WaitForChild("Checkpoints")
local coinsFolder = workspace:WaitForChild("Coins")
local killFolder = workspace:WaitForChild("KillParts")

-- เก็บอัปเกรดที่ซื้อแล้วของผู้เล่นแต่ละคน { [player] = { Speed = true, ... } }
local ownedUpgrades = {}

---------------------------------------------------------------------
-- ข้อมูลผู้เล่น
---------------------------------------------------------------------

local function getPlayerFromPart(hit)
	local character = hit:FindFirstAncestorOfClass("Model")
	if not character then
		return nil
	end
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if not humanoid or humanoid.Health <= 0 then
		return nil
	end
	return Players:GetPlayerFromCharacter(character), humanoid
end

local function applyUpgrades(player)
	local character = player.Character
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	if not humanoid then
		return
	end
	local owned = ownedUpgrades[player] or {}
	humanoid.WalkSpeed = owned.Speed and Config.Shop.Speed.Value or Config.DefaultWalkSpeed
	humanoid.UseJumpPower = true
	humanoid.JumpPower = owned.Jump and Config.Shop.Jump.Value or Config.DefaultJumpPower
end

local function spawnAtCheckpoint(player, character)
	local stage = player.leaderstats.Stage.Value
	local checkpoint = checkpointsFolder:FindFirstChild(tostring(stage))
	if checkpoint then
		local root = character:WaitForChild("HumanoidRootPart")
		-- รอหนึ่งเฟรมให้ Roblox วางตัวละครเสร็จก่อน แล้วค่อยย้าย
		task.wait()
		root.CFrame = checkpoint.CFrame + Vector3.new(0, 4, 0)
	end
end

local function loadData(player)
	local ok, data = pcall(function()
		return playerStore:GetAsync("player_" .. player.UserId)
	end)
	if not ok then
		warn("โหลดข้อมูลไม่สำเร็จ:", player.Name, data)
		data = nil
	end
	return data or { Coins = 0, Stage = 1, Upgrades = {} }
end

local function saveData(player)
	local stats = player:FindFirstChild("leaderstats")
	if not stats then
		return
	end
	local data = {
		Coins = stats.Coins.Value,
		Stage = stats.Stage.Value,
		Upgrades = ownedUpgrades[player] or {},
	}
	local ok, err = pcall(function()
		playerStore:SetAsync("player_" .. player.UserId, data)
	end)
	if not ok then
		warn("เซฟข้อมูลไม่สำเร็จ:", player.Name, err)
	end
end

Players.PlayerAdded:Connect(function(player)
	local data = loadData(player)
	if not player.Parent then
		return -- ผู้เล่นออกไปก่อนโหลดเสร็จ
	end

	local stats = Instance.new("Folder")
	stats.Name = "leaderstats"

	local coins = Instance.new("IntValue")
	coins.Name = "Coins"
	coins.Value = data.Coins or 0
	coins.Parent = stats

	local stage = Instance.new("IntValue")
	stage.Name = "Stage"
	stage.Value = data.Stage or 1
	stage.Parent = stats

	stats.Parent = player
	ownedUpgrades[player] = data.Upgrades or {}

	player.CharacterAdded:Connect(function(character)
		applyUpgrades(player)
		spawnAtCheckpoint(player, character)
	end)
	if player.Character then
		applyUpgrades(player)
		spawnAtCheckpoint(player, player.Character)
	end
end)

Players.PlayerRemoving:Connect(function(player)
	saveData(player)
	ownedUpgrades[player] = nil
end)

-- เซฟทุกคนตอนปิดเซิร์ฟเวอร์
game:BindToClose(function()
	if RunService:IsStudio() and not Config.SaveInStudio then
		return
	end
	for _, player in ipairs(Players:GetPlayers()) do
		task.spawn(saveData, player)
	end
	task.wait(3)
end)

-- เซฟอัตโนมัติเป็นระยะ
task.spawn(function()
	while true do
		task.wait(Config.AutoSaveInterval)
		for _, player in ipairs(Players:GetPlayers()) do
			task.spawn(saveData, player)
		end
	end
end)

---------------------------------------------------------------------
-- เช็คพอยต์
---------------------------------------------------------------------

local function setupCheckpoint(part)
	local number = tonumber(part.Name)
	if not number then
		warn("ชื่อเช็คพอยต์ต้องเป็นตัวเลข:", part:GetFullName())
		return
	end
	part.Touched:Connect(function(hit)
		local player = getPlayerFromPart(hit)
		if not player then
			return
		end
		local stage = player.leaderstats.Stage
		-- อนุญาตให้ข้ามได้ทีละด่านเท่านั้น กันการวาร์ปโกง
		if number == stage.Value + 1 then
			stage.Value = number
			player.leaderstats.Coins.Value += Config.CoinsPerStage
		end
	end)
end

for _, part in ipairs(checkpointsFolder:GetChildren()) do
	if part:IsA("BasePart") then
		setupCheckpoint(part)
	end
end

---------------------------------------------------------------------
-- พื้นลาวา
---------------------------------------------------------------------

local function setupKillPart(part)
	part.Touched:Connect(function(hit)
		local _, humanoid = getPlayerFromPart(hit)
		if humanoid then
			humanoid.Health = 0
		end
	end)
end

for _, part in ipairs(killFolder:GetDescendants()) do
	if part:IsA("BasePart") then
		setupKillPart(part)
	end
end

---------------------------------------------------------------------
-- เหรียญ
---------------------------------------------------------------------

local function setupCoin(coin)
	local active = true
	coin.CanCollide = false
	coin.Anchored = true

	coin.Touched:Connect(function(hit)
		if not active then
			return
		end
		local player = getPlayerFromPart(hit)
		if not player then
			return
		end
		active = false
		player.leaderstats.Coins.Value += Config.CoinValue
		coinCollected:FireClient(player, Config.CoinValue)

		coin.Transparency = 1
		task.delay(Config.CoinRespawnTime, function()
			coin.Transparency = 0
			active = true
		end)
	end)
end

local coins = {}
for _, coin in ipairs(coinsFolder:GetChildren()) do
	if coin:IsA("BasePart") then
		setupCoin(coin)
		table.insert(coins, { part = coin, base = coin.CFrame })
	end
end

-- หมุนเหรียญให้ดูสวย
RunService.Heartbeat:Connect(function()
	local t = os.clock()
	for _, info in ipairs(coins) do
		info.part.CFrame = info.base
			* CFrame.new(0, math.sin(t * 2) * 0.5, 0)
			* CFrame.Angles(0, t * 2, 0)
	end
end)

---------------------------------------------------------------------
-- ร้านค้า (ตรวจสอบทุกอย่างที่ฝั่ง Server เสมอ)
---------------------------------------------------------------------

buyItem.OnServerInvoke = function(player, itemName)
	local item = Config.Shop[itemName]
	if type(itemName) ~= "string" or not item then
		return false, "ไม่มีสินค้านี้"
	end
	local owned = ownedUpgrades[player]
	if not owned then
		return false, "กำลังโหลดข้อมูล"
	end
	if owned[itemName] then
		return false, "ซื้อไปแล้ว"
	end
	local coins = player.leaderstats.Coins
	if coins.Value < item.Price then
		return false, "เหรียญไม่พอ"
	end
	coins.Value -= item.Price
	owned[itemName] = true
	applyUpgrades(player)
	return true, "ซื้อ " .. item.DisplayName .. " สำเร็จ!"
end
