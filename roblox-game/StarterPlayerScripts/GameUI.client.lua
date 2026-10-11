--[[
	GameUI (LocalScript) — วางไว้ใน StarterPlayer > StarterPlayerScripts

	สร้างหน้าจอ: ตัวนับเหรียญ, ข้อความด่าน, ป๊อปอัป "+1" และปุ่มร้านค้า
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local Config = require(ReplicatedStorage:WaitForChild("GameConfig"))
local remotes = ReplicatedStorage:WaitForChild("Remotes")
local coinCollected = remotes:WaitForChild("CoinCollected")
local buyItem = remotes:WaitForChild("BuyItem")

local player = Players.LocalPlayer
local stats = player:WaitForChild("leaderstats")
local coins = stats:WaitForChild("Coins")
local stage = stats:WaitForChild("Stage")

local gui = Instance.new("ScreenGui")
gui.Name = "GameUI"
gui.ResetOnSpawn = false
gui.Parent = player:WaitForChild("PlayerGui")

local function makeLabel(props)
	local label = Instance.new("TextLabel")
	label.BackgroundColor3 = Color3.fromRGB(25, 25, 35)
	label.BackgroundTransparency = 0.3
	label.TextColor3 = Color3.new(1, 1, 1)
	label.Font = Enum.Font.GothamBold
	label.TextScaled = true
	for key, value in pairs(props) do
		label[key] = value
	end
	Instance.new("UICorner", label).CornerRadius = UDim.new(0, 10)
	label.Parent = gui
	return label
end

local coinLabel = makeLabel({
	Size = UDim2.fromOffset(180, 45),
	Position = UDim2.new(0, 15, 0, 15),
	TextColor3 = Color3.fromRGB(255, 215, 0),
})
local stageLabel = makeLabel({
	Size = UDim2.fromOffset(180, 35),
	Position = UDim2.new(0, 15, 0, 65),
})

local function refresh()
	coinLabel.Text = "🪙 " .. coins.Value
	stageLabel.Text = "ด่าน " .. stage.Value
end
coins.Changed:Connect(refresh)
stage.Changed:Connect(refresh)
refresh()

-- ป๊อปอัปตอนเก็บเหรียญ
coinCollected.OnClientEvent:Connect(function(amount)
	local popup = makeLabel({
		Size = UDim2.fromOffset(80, 35),
		Position = UDim2.new(0, 200, 0, 20),
		BackgroundTransparency = 1,
		TextColor3 = Color3.fromRGB(255, 215, 0),
		Text = "+" .. amount,
	})
	local tween = TweenService:Create(popup, TweenInfo.new(0.8), {
		Position = UDim2.new(0, 200, 0, -20),
		TextTransparency = 1,
	})
	tween:Play()
	tween.Completed:Connect(function()
		popup:Destroy()
	end)
end)

---------------------------------------------------------------------
-- ร้านค้า
---------------------------------------------------------------------

local shopButton = Instance.new("TextButton")
shopButton.Size = UDim2.fromOffset(180, 40)
shopButton.Position = UDim2.new(0, 15, 0, 110)
shopButton.BackgroundColor3 = Color3.fromRGB(0, 170, 100)
shopButton.TextColor3 = Color3.new(1, 1, 1)
shopButton.Font = Enum.Font.GothamBold
shopButton.TextScaled = true
shopButton.Text = "🛒 ร้านค้า"
Instance.new("UICorner", shopButton).CornerRadius = UDim.new(0, 10)
shopButton.Parent = gui

local shopFrame = Instance.new("Frame")
shopFrame.Size = UDim2.fromOffset(260, 180)
shopFrame.AnchorPoint = Vector2.new(0.5, 0.5)
shopFrame.Position = UDim2.fromScale(0.5, 0.5)
shopFrame.BackgroundColor3 = Color3.fromRGB(25, 25, 35)
shopFrame.Visible = false
Instance.new("UICorner", shopFrame).CornerRadius = UDim.new(0, 12)
local layout = Instance.new("UIListLayout", shopFrame)
layout.Padding = UDim.new(0, 8)
layout.HorizontalAlignment = Enum.HorizontalAlignment.Center
layout.SortOrder = Enum.SortOrder.LayoutOrder
local padding = Instance.new("UIPadding", shopFrame)
padding.PaddingTop = UDim.new(0, 10)
shopFrame.Parent = gui

local message = Instance.new("TextLabel")
message.Size = UDim2.new(1, -20, 0, 30)
message.BackgroundTransparency = 1
message.TextColor3 = Color3.new(1, 1, 1)
message.Font = Enum.Font.Gotham
message.TextScaled = true
message.Text = "ใช้เหรียญซื้ออัปเกรด"
message.LayoutOrder = 100
message.Parent = shopFrame

local order = 0
for itemName, item in pairs(Config.Shop) do
	order += 1
	local button = Instance.new("TextButton")
	button.Size = UDim2.new(1, -20, 0, 50)
	button.BackgroundColor3 = Color3.fromRGB(60, 90, 200)
	button.TextColor3 = Color3.new(1, 1, 1)
	button.Font = Enum.Font.GothamBold
	button.TextScaled = true
	button.Text = item.DisplayName .. " — " .. item.Price .. " 🪙"
	button.LayoutOrder = order
	Instance.new("UICorner", button).CornerRadius = UDim.new(0, 8)
	button.Parent = shopFrame

	button.MouseButton1Click:Connect(function()
		local ok, result = buyItem:InvokeServer(itemName)
		message.Text = result
		message.TextColor3 = ok and Color3.fromRGB(0, 255, 120) or Color3.fromRGB(255, 90, 90)
	end)
end

shopButton.MouseButton1Click:Connect(function()
	shopFrame.Visible = not shopFrame.Visible
end)
