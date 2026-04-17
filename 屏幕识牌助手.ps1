Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeMouse {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@

[System.Windows.Forms.Application]::EnableVisualStyles()

$script:MouseLeftDown = 0x0002
$script:MouseLeftUp = 0x0004
$script:ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:StatePath = Join-Path $script:ProjectRoot 'screen-recognition\ui-state.json'
$script:NodeScriptPath = Join-Path $script:ProjectRoot 'screen-recognition\ui-recognize.js'
$script:TemplateBootstrapScriptPath = Join-Path $script:ProjectRoot 'screen-recognition\bootstrap-templates.js'
$script:AutoCollectScriptPath = Join-Path $script:ProjectRoot 'screen-recognition\auto-collect-material-sample.js'
$script:BundledNodePath = Join-Path $script:ProjectRoot 'runtime\node\node.exe'
$script:LatestScreenPath = Join-Path $script:ProjectRoot 'screen-recognition\latest-screen.png'
$script:RankTemplatesDir = Join-Path $script:ProjectRoot 'screen-recognition\templates\ranks'
$script:SuitTemplatesDir = Join-Path $script:ProjectRoot 'screen-recognition\templates\suits'
$script:LoopState = [PSCustomObject]@{
    Running = $false
    Busy = $false
    LastSeenSignature = $null
    LastActionSignature = $null
}
$script:HistoryLines = New-Object 'System.Collections.Generic.List[string]'

function Get-UiFont([float]$size, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular) {
    return New-Object System.Drawing.Font('Microsoft YaHei UI', $size, $style)
}

function Show-ErrorDialog([string]$message) {
    [System.Windows.Forms.MessageBox]::Show($message, '屏幕识牌助手', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}

function Show-WarningDialog([string]$message) {
    [System.Windows.Forms.MessageBox]::Show($message, '屏幕识牌助手', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
}

function Ensure-ParentDirectory([string]$filePath) {
    $parent = Split-Path -Parent $filePath
    if (-not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
}

function Get-SavedState {
    if (-not (Test-Path $script:StatePath)) {
        return $null
    }

    try {
        $content = Get-Content $script:StatePath -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($content)) {
            return $null
        }
        return $content | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Save-UiState($region, [int]$cardCount, $playButtonPoint) {
    Ensure-ParentDirectory $script:StatePath
    $jsonContent = [ordered]@{
        cardCount = $cardCount
        handRegion = $region
        playButtonPoint = $playButtonPoint
    } | ConvertTo-Json -Depth 5
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($script:StatePath, $jsonContent, $utf8NoBom)
}

function ConvertFrom-JsonCompat([string]$jsonText, [int]$Depth = 32) {
    $command = Get-Command ConvertFrom-Json -ErrorAction Stop
    if ($command.Parameters.ContainsKey('Depth')) {
        return ($jsonText | ConvertFrom-Json -Depth $Depth)
    }

    return ($jsonText | ConvertFrom-Json)
}

function Test-HasTemplates {
    $rankFiles = if (Test-Path $script:RankTemplatesDir) { Get-ChildItem $script:RankTemplatesDir -File | Where-Object { $_.Extension -match '^\.(png|jpg|jpeg|bmp)$' } } else { @() }
    $suitFiles = if (Test-Path $script:SuitTemplatesDir) { Get-ChildItem $script:SuitTemplatesDir -File | Where-Object { $_.Extension -match '^\.(png|jpg|jpeg|bmp)$' } } else { @() }
    return ($rankFiles.Count -gt 0 -and $suitFiles.Count -gt 0)
}

function Test-NodeInstalled {
    return -not [string]::IsNullOrWhiteSpace((Get-NodeCommandPath))
}

function Get-NodeCommandPath {
    if (Test-Path $script:BundledNodePath) {
        return $script:BundledNodePath
    }

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $nodeCommand) {
        return $nodeCommand.Source
    }

    return $null
}

function Join-OutputLines($value) {
    if ($null -eq $value) {
        return ''
    }
    if ($value -is [System.Array]) {
        return ($value -join [Environment]::NewLine)
    }
    return [string]$value
}

function Invoke-NodeJsonCommand([string]$nodeCommand, [string]$scriptPath, [string[]]$arguments, [int]$Depth = 32) {
    $stdoutPath = Join-Path $script:ProjectRoot 'screen-recognition\last-node-stdout.json'
    $stderrPath = Join-Path $script:ProjectRoot 'screen-recognition\last-node-stderr.log'
    $jsonOutPath = Join-Path $script:ProjectRoot 'screen-recognition\last-node-payload.json'
    Ensure-ParentDirectory $stdoutPath

    if (Test-Path $stdoutPath) { Remove-Item $stdoutPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path $stderrPath) { Remove-Item $stderrPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path $jsonOutPath) { Remove-Item $jsonOutPath -Force -ErrorAction SilentlyContinue }

    $effectiveArguments = @($arguments) + @('--json-out', $jsonOutPath)
    $stdout = & $nodeCommand $scriptPath @effectiveArguments 2> $stderrPath
    $exitCode = $LASTEXITCODE
    $stdoutText = Join-OutputLines $stdout
    $stderrText = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw -Encoding UTF8 } else { '' }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($stdoutPath, $stdoutText, $utf8NoBom)

    if ($exitCode -ne 0) {
        throw ((@($stderrText, $stdoutText) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine)
    }

    $jsonText = if (Test-Path $jsonOutPath) {
        Get-Content $jsonOutPath -Raw -Encoding UTF8
    } else {
        $stdoutText
    }
    $jsonText = $jsonText.Trim()
    if ([string]::IsNullOrWhiteSpace($jsonText)) {
        $stderrHint = if (-not [string]::IsNullOrWhiteSpace($stderrText)) { "`n错误日志：$stderrPath" } else { '' }
        throw ("识别器没有返回 JSON。标准输出：$stdoutPath`nJSON 输出：$jsonOutPath" + $stderrHint)
    }

    $firstBrace = $jsonText.IndexOf('{')
    $lastBrace = $jsonText.LastIndexOf('}')
    if ($firstBrace -ge 0 -and $lastBrace -gt $firstBrace) {
        $jsonText = $jsonText.Substring($firstBrace, $lastBrace - $firstBrace + 1)
    }

    try {
        return (ConvertFrom-JsonCompat -jsonText $jsonText -Depth $Depth)
    } catch {
        $stderrHint = if (-not [string]::IsNullOrWhiteSpace($stderrText)) { "`n错误日志：$stderrPath" } else { '' }
        throw ("JSON 解析失败：{0}`n标准输出：{1}`nJSON 输出：{2}{3}" -f $_.Exception.Message, $stdoutPath, $jsonOutPath, $stderrHint)
    }
}

function Format-RegionText($region) {
    if ($null -eq $region) {
        return '未设置'
    }
    return ('X={0},Y={1},W={2},H={3}' -f $region.x, $region.y, $region.width, $region.height)
}

function Format-PointText($point) {
    if ($null -eq $point) {
        return '未设置'
    }
    return ('X={0},Y={1}' -f $point.x, $point.y)
}

function Format-RankText([string]$rank) {
    if ([string]::IsNullOrWhiteSpace($rank)) {
        return ''
    }

    $normalized = $rank.Trim().ToUpper()
    if ($normalized -eq 'T') {
        return '10'
    }

    return $normalized
}

function Format-SuitText([string]$suit) {
    if ([string]::IsNullOrWhiteSpace($suit)) {
        return ''
    }

    switch ($suit.Trim().ToLower()) {
        's' { return '♠' }
        'h' { return '♥' }
        'd' { return '♦' }
        'c' { return '♣' }
        default { return $suit.Trim() }
    }
}

function Format-CardCodeForDisplay([string]$cardCode) {
    if ([string]::IsNullOrWhiteSpace($cardCode)) {
        return ''
    }

    $normalized = $cardCode.Trim()
    if ($normalized.Length -lt 2) {
        return $normalized
    }

    $rank = Format-RankText($normalized.Substring(0, $normalized.Length - 1))
    $suit = Format-SuitText($normalized.Substring($normalized.Length - 1))
    if ([string]::IsNullOrWhiteSpace($rank) -or [string]::IsNullOrWhiteSpace($suit)) {
        return $normalized
    }

    return ($rank + $suit)
}

function Format-CardListForDisplay($cards) {
    if ($null -eq $cards) {
        return '无'
    }

    return ((@($cards) | ForEach-Object { Format-CardCodeForDisplay $_ }) -join '  ')
}

function Update-RegionLabel([System.Windows.Forms.Label]$label, $region) {
    $label.Text = '区域：' + (Format-RegionText $region)
}

function Update-PlayPointLabel([System.Windows.Forms.Label]$label, $point) {
    $label.Text = '出牌点：' + (Format-PointText $point)
}

function Update-LoopToggleText([System.Windows.Forms.CheckBox]$toggle) {
    if ($toggle.Checked) {
        $toggle.Text = '停止挂机'
    } else {
        $toggle.Text = '连续挂机'
    }
}

function Update-InteractiveState(
    [System.Windows.Forms.ComboBox]$modeCombo,
    [System.Windows.Forms.CheckBox]$autoPlayCheckBox,
    [System.Windows.Forms.CheckBox]$loopToggle,
    [System.Windows.Forms.Button]$selectButton,
    [System.Windows.Forms.Button]$playPointButton,
    [System.Windows.Forms.Button]$recognizeButton,
    [System.Windows.Forms.Button]$openTemplatesButton,
    [System.Windows.Forms.Label]$footLabel,
    $currentRegion,
    $currentPlayPoint
) {
    $hasRegion = ($null -ne $currentRegion.Value)
    $hasPlayPoint = ($null -ne $currentPlayPoint.Value)
    $hasNode = Test-NodeInstalled
    $hasTemplates = Test-HasTemplates
    $isRunning = $script:LoopState.Running

    $modeCombo.Enabled = $true
    $selectButton.Enabled = $true
    $playPointButton.Enabled = $true
    $openTemplatesButton.Enabled = $true

    $recognizeButton.Enabled = $true
    $loopToggle.Enabled = $true
    $autoPlayCheckBox.Enabled = $true

    if (-not $hasNode) {
        $footLabel.Text = '缺少内置 Node 运行时。'
    } elseif (-not $hasTemplates) {
        $footLabel.Text = '未放模板，将使用内置识别。'
    } elseif (-not $hasRegion) {
        $footLabel.Text = '先框选手牌区域。'
    } elseif (-not $hasPlayPoint) {
        $footLabel.Text = '可先设置出牌点，再开启自动出牌。'
    } elseif ($isRunning) {
        $footLabel.Text = '挂机中：牌变了才再次出牌。'
    } else {
        $footLabel.Text = '已就绪。'
    }

    Update-LoopToggleText $loopToggle
}

function Ensure-NotRunning([string]$actionName) {
    if ($script:LoopState.Running) {
        Show-WarningDialog ("当前正在挂机。`n请先停止挂机，再进行 {0}。" -f $actionName)
        return $false
    }
    return $true
}

function Ensure-CanRecognize($currentRegion) {
    if (-not (Test-NodeInstalled)) {
        Show-WarningDialog '未检测到可用的 Node 运行时。`n请确认 runtime\node\node.exe 存在，或系统已安装 Node.js。'
        return $false
    }

    if ($null -eq $currentRegion.Value) {
        Show-WarningDialog '请先框选手牌区域。'
        return $false
    }

    return $true
}

function Ensure-CanAutoPlay($currentPlayPoint) {
    if ($null -eq $currentPlayPoint.Value) {
        Show-WarningDialog '已勾选自动出牌，但还没有设置出牌点。'
        return $false
    }

    return $true
}

function Get-SelectedCardCount([System.Windows.Forms.ComboBox]$modeCombo) {
    if ($modeCombo.SelectedIndex -eq 1) { return 5 }
    return 4
}

function Set-SelectedCardCount([System.Windows.Forms.ComboBox]$modeCombo, [int]$cardCount) {
    if ($cardCount -eq 5) { $modeCombo.SelectedIndex = 1 } else { $modeCombo.SelectedIndex = 0 }
}

function Format-CandidateLine($candidates) {
    if ($null -eq $candidates) { return '无' }
    return (($candidates | ForEach-Object {
        $label = if ($_.label -match '^[A23456789TJQK][shdc]$') {
            Format-CardCodeForDisplay $_.label
        } elseif ($_.label -match '^[shdc]$') {
            Format-SuitText $_.label
        } else {
            Format-RankText $_.label
        }
        '{0}:{1}' -f $label, $_.distance
    }) -join '    ')
}

function Add-History([string]$message) {
    $timestamp = Get-Date -Format 'HH:mm:ss'
    $script:HistoryLines.Add(('[{0}] {1}' -f $timestamp, $message))
    while ($script:HistoryLines.Count -gt 8) {
        $script:HistoryLines.RemoveAt(0)
    }
}

function Build-HandSignature($payload) {
    $cardCount = $payload.state.cardCount
    $codes = @($payload.result.recognized.cardCodes) -join '|'
    return ('{0}:{1}' -f $cardCount, $codes)
}

function Get-AverageConfidence($payload) {
    return [Math]::Round((($payload.result.recognized.cards | Measure-Object -Property confidence -Average).Average), 4)
}

function Update-Status([System.Windows.Forms.Label]$statusLabel, [string]$message) {
    $loopText = if ($script:LoopState.Running) { '挂机中' } else { '未挂机' }
    $statusLabel.Text = ('状态：{0} | {1}' -f $message, $loopText)
}

function Prompt-CardCodes([int]$cardCount) {
    $example = if ($cardCount -eq 5) { 'As Qh Jd 3d 9s' } else { 'As Qh Jd 3d' }
    return [Microsoft.VisualBasic.Interaction]::InputBox(("请输入当前实际牌面，共 {0} 张。`n示例：{1}" -f $cardCount, $example), '录入模板', $example)
}

function Invoke-TemplateBootstrap([int]$cardCount, $currentRegion) {
    $nodeCommand = Get-NodeCommandPath
    if ([string]::IsNullOrWhiteSpace($nodeCommand)) {
        throw '未检测到可用的 Node 运行时。'
    }

    Save-UiState $currentRegion.Value $cardCount $null
    $cardsInput = Prompt-CardCodes $cardCount
    if ([string]::IsNullOrWhiteSpace($cardsInput)) {
        return $null
    }

    return (Invoke-NodeJsonCommand -nodeCommand $nodeCommand -scriptPath $script:TemplateBootstrapScriptPath -arguments @('--region-file', $script:StatePath, '--card-count', $cardCount, '--cards', $cardsInput) -Depth 20)
}

function Invoke-AutoCollectMaterial([int]$cardCount, $currentRegion, $currentPlayPoint) {
    $nodeCommand = Get-NodeCommandPath
    if ([string]::IsNullOrWhiteSpace($nodeCommand)) {
        throw '未检测到可用的 Node 运行时。'
    }

    Save-UiState $currentRegion.Value $cardCount $currentPlayPoint.Value
    return (Invoke-NodeJsonCommand -nodeCommand $nodeCommand -scriptPath $script:AutoCollectScriptPath -arguments @('--region-file', $script:StatePath, '--card-count', $cardCount, '--attempts', '3', '--attempt-delay-ms', '180') -Depth 80)
}

function Prepare-ForScreenPick([System.Windows.Forms.Form]$form, [System.Windows.Forms.Label]$statusLabel, [string]$actionName) {
    Show-WarningDialog ("请在 2 秒内切回游戏窗口，然后开始{0}。" -f $actionName)
    Update-Status $statusLabel ('准备' + $actionName)
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
    Start-Sleep -Milliseconds 1800
}

function Select-ScreenRegion {
    $selectionForm = New-Object System.Windows.Forms.Form
    $selectionForm.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $selectionForm.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $virtualBounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $selectionForm.Location = New-Object System.Drawing.Point($virtualBounds.X, $virtualBounds.Y)
    $selectionForm.Size = New-Object System.Drawing.Size($virtualBounds.Width, $virtualBounds.Height)
    $selectionForm.TopMost = $true
    $selectionForm.BackColor = [System.Drawing.Color]::Black
    $selectionForm.Opacity = 0.18
    $selectionForm.ShowInTaskbar = $false
    $selectionForm.Cursor = [System.Windows.Forms.Cursors]::Cross
    $selectionForm.KeyPreview = $true

    $script:IsDragging = $false
    $script:DragStart = [System.Drawing.Point]::Empty
    $script:CurrentRect = New-Object System.Drawing.Rectangle(0, 0, 0, 0)
    $script:SelectedRect = $null

    $selectionForm.Add_KeyDown({ if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $selectionForm.Close() } })
    $selectionForm.Add_MouseDown({
        if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $script:IsDragging = $true
            $script:DragStart = $_.Location
            $script:CurrentRect = New-Object System.Drawing.Rectangle($_.Location.X, $_.Location.Y, 0, 0)
            $selectionForm.Invalidate()
        }
    })
    $selectionForm.Add_MouseMove({
        if ($script:IsDragging) {
            $left = [Math]::Min($script:DragStart.X, $_.Location.X)
            $top = [Math]::Min($script:DragStart.Y, $_.Location.Y)
            $width = [Math]::Abs($_.Location.X - $script:DragStart.X)
            $height = [Math]::Abs($_.Location.Y - $script:DragStart.Y)
            $script:CurrentRect = New-Object System.Drawing.Rectangle($left, $top, $width, $height)
            $selectionForm.Invalidate()
        }
    })
    $selectionForm.Add_MouseUp({
        if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left -and $script:IsDragging) {
            $script:IsDragging = $false
            if ($script:CurrentRect.Width -gt 5 -and $script:CurrentRect.Height -gt 5) {
                $script:SelectedRect = $script:CurrentRect
                $selectionForm.Close()
            }
        }
    })
    $selectionForm.Add_Paint({
        if ($script:CurrentRect.Width -gt 0 -and $script:CurrentRect.Height -gt 0) {
            $fillBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(55, 0, 170, 255))
            $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 0, 200, 255), 2)
            $_.Graphics.FillRectangle($fillBrush, $script:CurrentRect)
            $_.Graphics.DrawRectangle($pen, $script:CurrentRect)
            $fillBrush.Dispose()
            $pen.Dispose()
        }
    })

    $selectionForm.ShowDialog() | Out-Null
    if ($null -ne $script:SelectedRect) {
        return @{ x = [int]($script:SelectedRect.X + $selectionForm.Left); y = [int]($script:SelectedRect.Y + $selectionForm.Top); width = [int]$script:SelectedRect.Width; height = [int]$script:SelectedRect.Height }
    }
    return $null
}

function Select-ScreenPoint {
    $selectionForm = New-Object System.Windows.Forms.Form
    $selectionForm.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $selectionForm.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $virtualBounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $selectionForm.Location = New-Object System.Drawing.Point($virtualBounds.X, $virtualBounds.Y)
    $selectionForm.Size = New-Object System.Drawing.Size($virtualBounds.Width, $virtualBounds.Height)
    $selectionForm.TopMost = $true
    $selectionForm.BackColor = [System.Drawing.Color]::Black
    $selectionForm.Opacity = 0.10
    $selectionForm.ShowInTaskbar = $false
    $selectionForm.Cursor = [System.Windows.Forms.Cursors]::Cross
    $selectionForm.KeyPreview = $true
    $script:SelectedPoint = $null

    $selectionForm.Add_KeyDown({ if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $selectionForm.Close() } })
    $selectionForm.Add_MouseDown({
        if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $script:SelectedPoint = @{ x = [int]($_.X + $selectionForm.Left); y = [int]($_.Y + $selectionForm.Top) }
            $selectionForm.Close()
        }
    })

    $selectionForm.ShowDialog() | Out-Null
    return $script:SelectedPoint
}

function Build-RecognitionLog($payload) {
    $result = $payload.result
    $recognized = $result.recognized
    $strategy = $result.strategy
    $diagnostics = $payload.diagnostics
    $averageConfidence = Get-AverageConfidence $payload

    $lines = New-Object 'System.Collections.Generic.List[string]'
    if ($script:HistoryLines.Count -gt 0) {
        $lines.Add('最近：')
        foreach ($historyLine in $script:HistoryLines) { $lines.Add($historyLine) }
        $lines.Add('')
    }

    $lines.Add(('牌组：{0}' -f (Format-CardListForDisplay $recognized.cardCodes)))
    $lines.Add(('保留：{0}' -f (Format-CardListForDisplay $strategy.bestCards)))
    $lines.Add(('丢弃：{0}' -f (Format-CardListForDisplay $strategy.discardCards)))
    $lines.Add(('最优：{0}/{1}' -f $strategy.hand.nameZh, $strategy.hand.score))
    if ($recognized.recognitionBackend -eq 'hybrid-opencv' -or $recognized.recognitionMode -eq 'hybrid-opencv') {
        $lines.Add('识别：混合(OpenCV+模板)')
    } elseif ($recognized.recognitionBackend -eq 'python-opencv' -or $recognized.recognitionMode -eq 'python-opencv') {
        $lines.Add('识别：OpenCV')
    } elseif ($recognized.recognitionMode -eq 'template') {
        $lines.Add('识别：模板')
    } else {
        $lines.Add('识别：内置')
    }
    if ($recognized.uniquenessResolved) {
        $lines.Add(('纠偏：已自动修正 {0} 张重复/冲突牌' -f $recognized.uniquenessChangesCount))
    }
    if (-not [string]::IsNullOrWhiteSpace($recognized.fallbackReason)) {
        $lines.Add(('提示：{0}' -f $recognized.fallbackReason))
    }
    $lines.Add(('置信：{0}' -f $averageConfidence))
    if ($payload.debug.handRegionPreviewPath) { $lines.Add(('预览：{0}' -f $payload.debug.handRegionPreviewPath)) }
    if ($payload.clickPlan.playButtonPoint) { $lines.Add(('出牌点：{0}' -f (Format-PointText $payload.clickPlan.playButtonPoint))) }
    $lines.Add('')

    foreach ($card in $recognized.cards) {
        $rankConfidence = if ($null -ne $card.rankMatch.selectedConfidence) { $card.rankMatch.selectedConfidence } else { $card.rankMatch.confidence }
        $suitConfidence = if ($null -ne $card.suitMatch.selectedConfidence) { $card.suitMatch.selectedConfidence } else { $card.suitMatch.confidence }
        $lines.Add(('[{0}] {1} | 点数 {2}/{3} | 花色 {4}/{5} | 综合 {6}' -f $card.cardIndexHuman, (Format-CardCodeForDisplay $card.code), (Format-RankText $card.rank), $rankConfidence, (Format-SuitText $card.suit), $suitConfidence, $card.confidence))
    }

    $lines.Add('')
    $lines.Add('组合：')
    foreach ($combo in $diagnostics.combinations) {
        $lines.Add(('#{0} 保留 {1} | 丢弃 {2} | {3}/{4}' -f $combo.rank, (Format-CardListForDisplay $combo.selectedCards), (Format-CardListForDisplay $combo.discardedCards), $combo.hand.nameZh, $combo.hand.score))
    }

    return ($lines -join [Environment]::NewLine)
}

function Format-AutoCollectStatusText([string]$status) {
    switch ($status) {
        'imported' { return '已导入素材库' }
        'pending-review' { return '待人工确认' }
        default { return $status }
    }
}

function Build-AutoCollectLog($payload) {
    $recognized = if ($null -ne $payload.recognition) { $payload.recognition.recognized } else { $null }
    $strategy = if ($null -ne $payload.recognition) { $payload.recognition.strategy } else { $null }

    $lines = New-Object 'System.Collections.Generic.List[string]'
    if ($script:HistoryLines.Count -gt 0) {
        $lines.Add('最近：')
        foreach ($historyLine in $script:HistoryLines) { $lines.Add($historyLine) }
        $lines.Add('')
    }

    $lines.Add(('采集：{0}' -f (Format-AutoCollectStatusText $payload.status)))
    $lines.Add(('牌组：{0}' -f (Format-CardListForDisplay $payload.recognizedCards)))
    if ($null -ne $strategy) {
        $lines.Add(('保留：{0}' -f (Format-CardListForDisplay $strategy.bestCards)))
        $lines.Add(('丢弃：{0}' -f (Format-CardListForDisplay $strategy.discardCards)))
        $lines.Add(('最优：{0}/{1}' -f $strategy.hand.nameZh, $strategy.hand.score))
    }

    if ($null -ne $recognized) {
        if ($recognized.recognitionBackend -eq 'hybrid-opencv' -or $recognized.recognitionMode -eq 'hybrid-opencv') {
            $lines.Add('识别：混合(OpenCV+模板)')
        } elseif ($recognized.recognitionBackend -eq 'python-opencv' -or $recognized.recognitionMode -eq 'python-opencv') {
            $lines.Add('识别：OpenCV')
        } elseif ($recognized.recognitionMode -eq 'template') {
            $lines.Add('识别：模板')
        } else {
            $lines.Add('识别：内置')
        }
        if (-not [string]::IsNullOrWhiteSpace($recognized.fallbackReason)) {
            $lines.Add(('提示：{0}' -f $recognized.fallbackReason))
        }
    }

    if ($payload.handRegionDuplicate) {
        $lines.Add('去重：命中已有原始样本')
    }
    if ($payload.attemptsRequested -gt 1) {
        $attemptsCompleted = if ($null -ne $payload.attemptsCompleted) { $payload.attemptsCompleted } else { $payload.attemptsRequested }
        $lines.Add(('智能采集：请求 {0} 次，成功 {1} 次，采用第 {2} 次' -f $payload.attemptsRequested, $attemptsCompleted, $payload.selectedAttemptIndex))
    }
    if ($null -ne $payload.smartScore) {
        $lines.Add(('综合评分：{0}' -f $payload.smartScore))
    }
    if ($null -ne $payload.repair) {
        if ($payload.repair.changedCount -gt 0) {
            $lines.Add(('自动纠偏：已修正 {0} 张' -f $payload.repair.changedCount))
        }
        if ($payload.repair.autoImportRecommended) {
            $lines.Add('自动入库：已启用')
        }
        if ($payload.templatesSynced) {
            $lines.Add('模板同步：已写入 templates')
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($payload.reason) -and $payload.reason -ne 'confidence-ok') {
        $lines.Add(('结果：{0}' -f $payload.reason))
    }
    if ($null -ne $payload.averageConfidence) {
        $lines.Add(('平均置信：{0}' -f $payload.averageConfidence))
    }
    if ($null -ne $payload.minimumConfidence) {
        $lines.Add(('最低置信：{0}' -f $payload.minimumConfidence))
    }
    if (-not [string]::IsNullOrWhiteSpace($payload.savedHandRegionPath)) {
        $lines.Add(('样本：{0}' -f $payload.savedHandRegionPath))
    }
    if (-not [string]::IsNullOrWhiteSpace($payload.pendingManifestPath)) {
        $lines.Add(('待确认：{0}' -f $payload.pendingManifestPath))
    } elseif ($null -ne $payload.importResult -and -not [string]::IsNullOrWhiteSpace($payload.importResult.manifestPath)) {
        $lines.Add(('清单：{0}' -f $payload.importResult.manifestPath))
    }
    if (-not [string]::IsNullOrWhiteSpace($payload.updatedLatestHandRegionPath)) {
        $lines.Add(('预览：{0}' -f $payload.updatedLatestHandRegionPath))
    }

    return ($lines -join [Environment]::NewLine)
}

function Invoke-MouseClick($point) {
    [NativeMouse]::SetCursorPos([int]$point.x, [int]$point.y) | Out-Null
    Start-Sleep -Milliseconds 50
    [NativeMouse]::mouse_event($script:MouseLeftDown, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [NativeMouse]::mouse_event($script:MouseLeftUp, 0, 0, 0, [UIntPtr]::Zero)
}

function Invoke-ClickPlan([System.Windows.Forms.Form]$form, $payload, [System.Windows.Forms.Label]$statusLabel) {
    if ($null -eq $payload.clickPlan.playButtonPoint) {
        Show-ErrorDialog '请先设置出牌点。'
        return $false
    }

    $originalPosition = [System.Windows.Forms.Cursor]::Position
    try {
        Update-Status $statusLabel '自动出牌中'
        $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
        Start-Sleep -Milliseconds 220
        foreach ($point in $payload.clickPlan.cardClickPoints) {
            Invoke-MouseClick $point
            Start-Sleep -Milliseconds 120
        }
        Invoke-MouseClick $payload.clickPlan.playButtonPoint
        Start-Sleep -Milliseconds 150
        return $true
    } finally {
        [NativeMouse]::SetCursorPos($originalPosition.X, $originalPosition.Y) | Out-Null
        $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
        $form.Activate()
    }
}

function Get-RecognitionPayload([int]$cardCount, $currentRegion, $currentPlayPoint, [switch]$Quiet) {
    $nodeCommand = Get-NodeCommandPath
    if ([string]::IsNullOrWhiteSpace($nodeCommand)) {
        if (-not $Quiet) { Show-ErrorDialog '未检测到可用的 Node 运行时。' }
        return $null
    }
    if ($null -eq $currentRegion.Value) {
        if (-not $Quiet) { Show-ErrorDialog '请先框选手牌区域。' }
        return $null
    }

    Save-UiState $currentRegion.Value $cardCount $currentPlayPoint.Value
    return (Invoke-NodeJsonCommand -nodeCommand $nodeCommand -scriptPath $script:NodeScriptPath -arguments @('--region-file', $script:StatePath, '--output', $script:LatestScreenPath, '--card-count', $cardCount) -Depth 50)
}

function Process-RecognitionPayload([System.Windows.Forms.Form]$form, [System.Windows.Forms.Label]$statusLabel, [System.Windows.Forms.TextBox]$resultBox, [System.Windows.Forms.CheckBox]$autoPlayCheckBox, $payload, [bool]$fromLoop) {
    $signature = Build-HandSignature $payload
    $averageConfidence = Get-AverageConfidence $payload
    $resultBox.Text = Build-RecognitionLog $payload

    if (-not $fromLoop -and $averageConfidence -lt 0.62) {
        $previewHint = if ($payload.debug.handRegionPreviewPath) { "`n请检查预览图：" + $payload.debug.handRegionPreviewPath } else { '' }
        Show-WarningDialog ("当前识别置信度偏低，框选区域很可能不是四张牌区域，或者没有框到牌角。" + $previewHint)
    }

    if ($signature -ne $script:LoopState.LastSeenSignature) {
        Add-History ('新牌面：{0}' -f (Format-CardListForDisplay $payload.result.recognized.cardCodes))
        $script:LoopState.LastSeenSignature = $signature
        $resultBox.Text = Build-RecognitionLog $payload
    }

    $shouldAutoPlay = $autoPlayCheckBox.Checked
    if ($shouldAutoPlay -and $averageConfidence -ge 0.55 -and $signature -ne $script:LoopState.LastActionSignature) {
        $didPlay = Invoke-ClickPlan -form $form -payload $payload -statusLabel $statusLabel
        if ($didPlay) {
            $script:LoopState.LastActionSignature = $signature
            Add-History ('已出牌：保留 {0}' -f (Format-CardListForDisplay $payload.result.strategy.bestCards))
            $resultBox.Text = Build-RecognitionLog $payload
            Update-Status $statusLabel '已自动出牌'
            return
        }
    }

    if ($shouldAutoPlay -and $averageConfidence -lt 0.55 -and $fromLoop) {
        Update-Status $statusLabel '置信度偏低，已跳过'
        return
    }

    Update-Status $statusLabel '识别完成'
}

function Run-Recognition([System.Windows.Forms.Form]$form, [System.Windows.Forms.Label]$statusLabel, [System.Windows.Forms.TextBox]$resultBox, [System.Windows.Forms.ComboBox]$modeCombo, [System.Windows.Forms.CheckBox]$autoPlayCheckBox, $currentRegion, $currentPlayPoint, [switch]$Quiet) {
    $cardCount = Get-SelectedCardCount $modeCombo
    if ($autoPlayCheckBox.Checked -and $null -eq $currentPlayPoint.Value) {
        if (-not $Quiet) {
            Show-ErrorDialog '已勾选自动出牌，但还没有设置出牌点。'
        } else {
            Update-Status $statusLabel '未设置出牌点'
        }
        return
    }

    try {
        Update-Status $statusLabel '识别中'
        $payload = Get-RecognitionPayload -cardCount $cardCount -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint -Quiet:$Quiet
        if ($null -eq $payload) { return }
        Process-RecognitionPayload -form $form -statusLabel $statusLabel -resultBox $resultBox -autoPlayCheckBox $autoPlayCheckBox -payload $payload -fromLoop:$script:LoopState.Running
    } catch {
        Update-Status $statusLabel '识别失败'
        if (-not $Quiet) {
            Show-ErrorDialog ("识别失败：`n" + $_.Exception.Message)
        } else {
            Add-History '识别失败'
        }
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = '屏幕识牌助手'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(245, 248, 252)
$form.ClientSize = New-Object System.Drawing.Size(440, 398)
$form.Font = Get-UiFont 9

$workingArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location = New-Object System.Drawing.Point(($workingArea.Left + 10), ($workingArea.Bottom - $form.Height - 10))

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = '手牌识别'
$titleLabel.Font = Get-UiFont 11 ([System.Drawing.FontStyle]::Bold)
$titleLabel.AutoSize = $true
$titleLabel.Location = New-Object System.Drawing.Point(12, 12)
$form.Controls.Add($titleLabel)

$modeLabel = New-Object System.Windows.Forms.Label
$modeLabel.Text = '模式：'
$modeLabel.AutoSize = $true
$modeLabel.Location = New-Object System.Drawing.Point(12, 42)
$form.Controls.Add($modeLabel)

$modeCombo = New-Object System.Windows.Forms.ComboBox
$modeCombo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
[void]$modeCombo.Items.Add('4张选3张')
[void]$modeCombo.Items.Add('5张选3张')
$modeCombo.Size = New-Object System.Drawing.Size(112, 26)
$modeCombo.Location = New-Object System.Drawing.Point(58, 38)
$form.Controls.Add($modeCombo)

$autoPlayCheckBox = New-Object System.Windows.Forms.CheckBox
$autoPlayCheckBox.Text = '自动出牌'
$autoPlayCheckBox.AutoSize = $true
$autoPlayCheckBox.Location = New-Object System.Drawing.Point(186, 42)
$form.Controls.Add($autoPlayCheckBox)

$loopToggle = New-Object System.Windows.Forms.CheckBox
$loopToggle.Appearance = [System.Windows.Forms.Appearance]::Button
$loopToggle.Text = '连续挂机'
$loopToggle.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$loopToggle.Size = New-Object System.Drawing.Size(88, 24)
$loopToggle.Location = New-Object System.Drawing.Point(286, 39)
$form.Controls.Add($loopToggle)
Update-LoopToggleText $loopToggle

$regionLabel = New-Object System.Windows.Forms.Label
$regionLabel.Text = '区域：未设置'
$regionLabel.AutoSize = $false
$regionLabel.Size = New-Object System.Drawing.Size(416, 18)
$regionLabel.Location = New-Object System.Drawing.Point(12, 72)
$form.Controls.Add($regionLabel)

$playPointLabel = New-Object System.Windows.Forms.Label
$playPointLabel.Text = '出牌点：未设置'
$playPointLabel.AutoSize = $false
$playPointLabel.Size = New-Object System.Drawing.Size(416, 18)
$playPointLabel.Location = New-Object System.Drawing.Point(12, 92)
$form.Controls.Add($playPointLabel)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = '状态：待机 | 未挂机'
$statusLabel.AutoSize = $false
$statusLabel.Size = New-Object System.Drawing.Size(416, 18)
$statusLabel.Location = New-Object System.Drawing.Point(12, 112)
$form.Controls.Add($statusLabel)

$selectButton = New-Object System.Windows.Forms.Button
$selectButton.Text = '区域'
$selectButton.Size = New-Object System.Drawing.Size(76, 30)
$selectButton.Location = New-Object System.Drawing.Point(12, 138)
$form.Controls.Add($selectButton)

$playPointButton = New-Object System.Windows.Forms.Button
$playPointButton.Text = '出牌点'
$playPointButton.Size = New-Object System.Drawing.Size(76, 30)
$playPointButton.Location = New-Object System.Drawing.Point(94, 138)
$form.Controls.Add($playPointButton)

$recognizeButton = New-Object System.Windows.Forms.Button
$recognizeButton.Text = '识别'
$recognizeButton.Size = New-Object System.Drawing.Size(76, 30)
$recognizeButton.Location = New-Object System.Drawing.Point(176, 138)
$form.Controls.Add($recognizeButton)

$openTemplatesButton = New-Object System.Windows.Forms.Button
$openTemplatesButton.Text = '模板'
$openTemplatesButton.Size = New-Object System.Drawing.Size(76, 30)
$openTemplatesButton.Location = New-Object System.Drawing.Point(258, 138)
$form.Controls.Add($openTemplatesButton)

$bootstrapTemplatesButton = New-Object System.Windows.Forms.Button
$bootstrapTemplatesButton.Text = '录入模板'
$bootstrapTemplatesButton.Size = New-Object System.Drawing.Size(82, 30)
$bootstrapTemplatesButton.Location = New-Object System.Drawing.Point(346, 138)
$form.Controls.Add($bootstrapTemplatesButton)

$autoCollectButton = New-Object System.Windows.Forms.Button
$autoCollectButton.Text = '自动采集素材'
$autoCollectButton.Size = New-Object System.Drawing.Size(416, 30)
$autoCollectButton.Location = New-Object System.Drawing.Point(12, 174)
$form.Controls.Add($autoCollectButton)

$resultBox = New-Object System.Windows.Forms.TextBox
$resultBox.Multiline = $true
$resultBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
$resultBox.WordWrap = $false
$resultBox.ReadOnly = $true
$resultBox.Size = New-Object System.Drawing.Size(416, 146)
$resultBox.Location = New-Object System.Drawing.Point(12, 214)
$resultBox.BackColor = [System.Drawing.Color]::White
$resultBox.Font = Get-UiFont 9
$form.Controls.Add($resultBox)

$footLabel = New-Object System.Windows.Forms.Label
$footLabel.Text = '连续模式：牌变了才再次出牌。'
$footLabel.AutoSize = $false
$footLabel.Size = New-Object System.Drawing.Size(416, 18)
$footLabel.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 110)
$footLabel.Location = New-Object System.Drawing.Point(12, 368)
$form.Controls.Add($footLabel)

$currentRegion = [PSCustomObject]@{ Value = $null }
$currentPlayPoint = [PSCustomObject]@{ Value = $null }
$currentCardCount = [PSCustomObject]@{ Value = 4 }
$savedState = Get-SavedState
if ($null -ne $savedState) {
    if ($null -ne $savedState.handRegion) {
        $currentRegion.Value = $savedState.handRegion
        Update-RegionLabel $regionLabel $currentRegion.Value
    }
    if ($null -ne $savedState.playButtonPoint) {
        $currentPlayPoint.Value = $savedState.playButtonPoint
        Update-PlayPointLabel $playPointLabel $currentPlayPoint.Value
    }
    Set-SelectedCardCount $modeCombo $savedState.cardCount
    $currentCardCount.Value = [int]$savedState.cardCount
} else {
    Set-SelectedCardCount $modeCombo 4
    $currentCardCount.Value = 4
}

Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1200
$timer.Add_Tick({
    if (-not $script:LoopState.Running -or $script:LoopState.Busy) { return }
    $script:LoopState.Busy = $true
    try {
        Run-Recognition -form $form -statusLabel $statusLabel -resultBox $resultBox -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint -Quiet
    } finally {
        $script:LoopState.Busy = $false
    }
})

$modeCombo.Add_SelectedIndexChanged({
    if ($script:LoopState.Running) {
        Set-SelectedCardCount $modeCombo $currentCardCount.Value
        Show-WarningDialog '请先停止挂机，再切换模式。'
        return
    }

    $currentCardCount.Value = Get-SelectedCardCount $modeCombo
    Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
})

$autoPlayCheckBox.Add_Click({
    if ($script:LoopState.Running) {
        $autoPlayCheckBox.Checked = -not $autoPlayCheckBox.Checked
        Show-WarningDialog '请先停止挂机，再修改自动出牌设置。'
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
        return
    }

    if ($autoPlayCheckBox.Checked -and $null -eq $currentPlayPoint.Value) {
        $autoPlayCheckBox.Checked = $false
        Show-WarningDialog '请先设置出牌点，再开启自动出牌。'
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
    }
})

$selectButton.Add_Click({
    if (-not (Ensure-NotRunning '框选区域')) {
        return
    }

    Prepare-ForScreenPick -form $form -statusLabel $statusLabel -actionName '框选手牌区域'
    $region = Select-ScreenRegion
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $form.Activate()
    if ($null -ne $region) {
        $currentRegion.Value = $region
        Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value
        Update-RegionLabel $regionLabel $currentRegion.Value
        Update-Status $statusLabel '已保存区域'
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
    }
})

$playPointButton.Add_Click({
    if (-not (Ensure-NotRunning '设置出牌点')) {
        return
    }

    Prepare-ForScreenPick -form $form -statusLabel $statusLabel -actionName '设置出牌点'
    $point = Select-ScreenPoint
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $form.Activate()
    if ($null -ne $point) {
        $currentPlayPoint.Value = $point
        Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value
        Update-PlayPointLabel $playPointLabel $currentPlayPoint.Value
        Update-Status $statusLabel '已保存出牌点'
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
    }
})

$recognizeButton.Add_Click({
    if (-not (Ensure-NotRunning '识别')) {
        return
    }

    if (-not (Ensure-CanRecognize $currentRegion)) {
        return
    }

    if ($autoPlayCheckBox.Checked -and -not (Ensure-CanAutoPlay $currentPlayPoint)) {
        return
    }

    Run-Recognition -form $form -statusLabel $statusLabel -resultBox $resultBox -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
})

$loopToggle.Add_CheckedChanged({
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint

    if (-not $loopToggle.Checked) {
        if (-not $script:LoopState.Running) {
            return
        }
        $timer.Stop()
        $script:LoopState.Running = $false
        Update-Status $statusLabel '已停止挂机'
        Add-History '挂机停止'
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
        return
    }

    if (-not (Ensure-CanRecognize $currentRegion)) {
        $loopToggle.Checked = $false
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
        return
    }

    if ($autoPlayCheckBox.Checked -and -not (Ensure-CanAutoPlay $currentPlayPoint)) {
        $loopToggle.Checked = $false
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
        return
    }

    $script:LoopState.Running = $true
    $script:LoopState.Busy = $false
    $script:LoopState.LastSeenSignature = $null
    $script:LoopState.LastActionSignature = $null
    Add-History '挂机开始'
    Update-Status $statusLabel '挂机中'
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
    $timer.Start()
    Run-Recognition -form $form -statusLabel $statusLabel -resultBox $resultBox -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint -Quiet
})

$openTemplatesButton.Add_Click({
    $templatesRoot = Join-Path $script:ProjectRoot 'screen-recognition\templates'
    Ensure-ParentDirectory (Join-Path $templatesRoot 'placeholder.txt')
    Start-Process explorer.exe $templatesRoot
    Start-Sleep -Milliseconds 100
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
})

$bootstrapTemplatesButton.Add_Click({
    if (-not (Ensure-NotRunning '录入模板')) {
        return
    }

    if ($null -eq $currentRegion.Value) {
        Show-WarningDialog '请先框选手牌区域，再录入模板。'
        return
    }

    try {
        Update-Status $statusLabel '正在录入模板'
        $result = Invoke-TemplateBootstrap -cardCount (Get-SelectedCardCount $modeCombo) -currentRegion $currentRegion
        if ($null -eq $result) {
            Update-Status $statusLabel '已取消录入模板'
            return
        }
        Add-History ('模板已写入：' + (($result.written | ForEach-Object { $_.card }) -join ' '))
        Update-Status $statusLabel '模板录入完成'
        Show-WarningDialog '模板已写入。现在再点一次“识别”试试。'
    } catch {
        Update-Status $statusLabel '模板录入失败'
        Show-ErrorDialog ("模板录入失败：`n" + $_.Exception.Message)
    }
})

$autoCollectButton.Add_Click({
    if (-not (Ensure-NotRunning '自动采集素材')) {
        return
    }

    if (-not (Ensure-CanRecognize $currentRegion)) {
        return
    }

    try {
        Update-Status $statusLabel '正在采集素材'
        $payload = Invoke-AutoCollectMaterial -cardCount (Get-SelectedCardCount $modeCombo) -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
        if ($null -eq $payload) {
            Update-Status $statusLabel '采集已取消'
            return
        }

        $historyPrefix = if ($payload.status -eq 'imported') {
            if ($payload.selfHealImportTriggered) { '素材已自修入库' } else { '素材已入库' }
        } else { '素材待确认' }
        $dedupeSuffix = if ($payload.handRegionDuplicate) { '（已去重）' } else { '' }
        Add-History ('{0}{1}：{2}' -f $historyPrefix, $dedupeSuffix, (Format-CardListForDisplay $payload.recognizedCards))
        $resultBox.Text = Build-AutoCollectLog $payload

        if ($payload.status -eq 'imported') {
            if ($payload.selfHealImportTriggered) {
                Update-Status $statusLabel '素材已自修入库'
            } else {
                Update-Status $statusLabel '素材已入库'
            }
        } else {
            Update-Status $statusLabel '素材待确认'
            $manifestHint = if ($payload.pendingManifestPath) { "`n待确认文件：" + $payload.pendingManifestPath } else { '' }
            Show-WarningDialog ('本次采集已保存，但置信度不足，暂未自动入库。' + $manifestHint)
        }
    } catch {
        Update-Status $statusLabel '采集失败'
        Show-ErrorDialog ("自动采集素材失败：`n" + $_.Exception.Message)
    }
})

$form.Add_FormClosing({ $timer.Stop() })
$form.Add_Activated({
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
})
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
