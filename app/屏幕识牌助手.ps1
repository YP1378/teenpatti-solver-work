Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
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
$script:BundledNodePath = Join-Path $script:ProjectRoot 'runtime\node\node.exe'
$script:LatestScreenPath = Join-Path $script:ProjectRoot 'screen-recognition\latest-screen.png'
$script:RankTemplatesDir = Join-Path $script:ProjectRoot 'screen-recognition\templates\ranks'
$script:SuitTemplatesDir = Join-Path $script:ProjectRoot 'screen-recognition\templates\suits'
$script:MaxHandRegionCount = 8
$script:LoopIntervalMs = 1200
$script:LoopState = [PSCustomObject]@{
    Running = $false
    Busy = $false
    StopRequested = $false
    CooldownUntil = [DateTime]::MinValue
    ActiveRecognition = $null
    LastSeenSignature = $null
    LastActionSignature = $null
}
$script:HistoryLines = New-Object 'System.Collections.Generic.List[string]'

function Get-UiFont([float]$size, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular) {
    return New-Object System.Drawing.Font('Microsoft YaHei UI', $size, $style)
}

function Get-UiSuitFont([float]$size, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular) {
    $resolvedSize = [Math]::Max($size, 11.0)
    return New-Object System.Drawing.Font('Georgia', $resolvedSize, ([System.Drawing.FontStyle]::Bold))
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

function Save-UiState($region, [int]$cardCount, $playButtonPoint, [bool]$jokerMode = $false, [int]$loopIntervalMs = 1200) {
    Ensure-ParentDirectory $script:StatePath
    $normalizedRegions = Get-HandRegionList $region
    $jsonContent = [ordered]@{
        cardCount = $cardCount
        handRegion = if ($normalizedRegions.Count -gt 0) { $normalizedRegions[0] } else { $null }
        handRegions = @($normalizedRegions)
        playButtonPoint = $playButtonPoint
        jokerMode = $jokerMode
        loopIntervalMs = $loopIntervalMs
    } | ConvertTo-Json -Depth 6
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($script:StatePath, $jsonContent, $utf8NoBom)
}

function Test-IsRegionObject($region) {
    if ($null -eq $region) {
        return $false
    }

    $propertyNames = @()
    if ($region -is [System.Collections.IDictionary]) {
        $propertyNames = @($region.Keys | ForEach-Object { [string]$_ })
    } else {
        $propertyNames = @($region.PSObject.Properties.Name)
    }

    foreach ($key in @('x', 'y', 'width', 'height')) {
        if ($propertyNames -notcontains $key) {
            return $false
        }
    }

    return $true
}

function Convert-ToRegionObject($region) {
    if (-not (Test-IsRegionObject $region)) {
        return $null
    }

    try {
        return [PSCustomObject][ordered]@{
            x = [int][Math]::Round([double]$region.x)
            y = [int][Math]::Round([double]$region.y)
            width = [int][Math]::Round([double]$region.width)
            height = [int][Math]::Round([double]$region.height)
        }
    } catch {
        return $null
    }
}

function Get-HandRegionList($regions) {
    if ($null -eq $regions) {
        return @()
    }

    $sourceItems = if (Test-IsRegionObject $regions) { @($regions) } else { @($regions) }
    $resolvedRegions = New-Object 'System.Collections.Generic.List[object]'
    foreach ($item in $sourceItems) {
        $normalizedRegion = Convert-ToRegionObject $item
        if ($null -ne $normalizedRegion) {
            $resolvedRegions.Add($normalizedRegion)
        }
    }

    $items = @($resolvedRegions.ToArray())
    if ($items.Count -gt $script:MaxHandRegionCount) {
        return $items[0..($script:MaxHandRegionCount - 1)]
    }

    return $items
}

function Get-HandRegionsFromState($state) {
    if ($null -eq $state) {
        return @()
    }

    if ($null -ne $state.handRegions) {
        return Get-HandRegionList $state.handRegions
    }

    if ($null -ne $state.handRegion) {
        return Get-HandRegionList @($state.handRegion)
    }

    if (Test-IsRegionObject $state) {
        return Get-HandRegionList @($state)
    }

    return @()
}

function Get-HandRegionCount($regions) {
    return @(Get-HandRegionList $regions).Count
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

function Convert-NodeJsonTextToObject([string]$jsonText, [string]$stdoutPath, [string]$jsonOutPath, [string]$stderrText, [int]$Depth = 32) {
    $jsonText = [string]$jsonText
    $jsonText = $jsonText.Trim()
    if ([string]::IsNullOrWhiteSpace($jsonText)) {
        $stderrHint = if (-not [string]::IsNullOrWhiteSpace($stderrText)) { "`n错误日志：$stderrText" } else { '' }
        throw ("识别器没有返回 JSON。标准输出：$stdoutPath`nJSON 输出：$jsonOutPath" + $stderrHint)
    }

    $firstBrace = $jsonText.IndexOf('{')
    $lastBrace = $jsonText.LastIndexOf('}')
    if ($firstBrace -ge 0 -and $lastBrace -gt $firstBrace) {
        $jsonText = $jsonText.Substring($firstBrace, $lastBrace - $firstBrace + 1)
    }

    return (ConvertFrom-JsonCompat -jsonText $jsonText -Depth $Depth)
}

function Stop-ActiveLoopRecognition() {
    $activeRecognition = $script:LoopState.ActiveRecognition
    if ($null -eq $activeRecognition) {
        return
    }

    try {
        if ($null -ne $activeRecognition.Process -and -not $activeRecognition.Process.HasExited) {
            $activeRecognition.Process.Kill()
            $activeRecognition.Process.WaitForExit(300)
        }
    } catch {
    } finally {
        if ($null -ne $activeRecognition.Process) {
            $activeRecognition.Process.Dispose()
        }
        $script:LoopState.ActiveRecognition = $null
        $script:LoopState.Busy = $false
    }
}

function Format-RegionText($region) {
    if ($null -eq $region) {
        return '未设置'
    }
    return ('X={0},Y={1},W={2},H={3}' -f $region.x, $region.y, $region.width, $region.height)
}

function Format-RegionSummaryText($regions) {
    $resolvedRegions = Get-HandRegionList $regions
    if ($resolvedRegions.Count -eq 0) {
        return '未设置'
    }

    $previewItems = @()
    for ($index = 0; $index -lt [Math]::Min($resolvedRegions.Count, 2); $index += 1) {
        $previewItems += ('#{0} {1}' -f ($index + 1), (Format-RegionText $resolvedRegions[$index]))
    }

    $summary = ('已设置 {0} 个' -f $resolvedRegions.Count)
    if ($previewItems.Count -gt 0) {
        $summary += '：' + ($previewItems -join ' | ')
    }
    if ($resolvedRegions.Count -gt 2) {
        $summary += ' ...'
    }

    return $summary
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
    switch ($normalized.ToLower()) {
        'joker' { return '王' }
        'black-joker' { return '小王' }
        'red-joker' { return '大王' }
    }

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

function Get-RecognitionEntries($payload) {
    if ($null -eq $payload) {
        return @()
    }

    if ($null -ne $payload.results) {
        return @($payload.results)
    }

    if ($null -ne $payload.result) {
        return @([PSCustomObject]@{
            regionIndex = 1
            handRegion = if ($null -ne $payload.state) { $payload.state.handRegion } else { $null }
            result = $payload.result
            diagnostics = $payload.diagnostics
            debug = $payload.debug
            clickPlan = $payload.clickPlan
        })
    }

    return @()
}

function Build-SingleRecognitionLog($entry, [int]$index, [int]$totalCount) {
    $result = $entry.result
    if ($null -eq $result) {
        return ''
    }

    $recognized = $result.recognized
    $strategy = $result.strategy
    $currentCards = if ($null -ne $strategy.inputCards -and @($strategy.inputCards).Count -gt 0) {
        $strategy.inputCards
    } else {
        $recognized.cardCodes
    }

    $lines = New-Object 'System.Collections.Generic.List[string]'
    $headerText = if ($totalCount -gt 1) { '区域 #{0}' -f $index } else { '区域' }
    $lines.Add(('{0}：{1}' -f $headerText, (Format-RegionText $entry.handRegion)))
    $lines.Add(('牌面：{0}' -f (Format-CardListForDisplay $currentCards)))

    $bestLine = ('最优：保留 {0}' -f (Format-CardListForDisplay $strategy.bestCards))
    $bestLine += ('  |  {0}' -f $strategy.hand.nameZh)
    if ($strategy.discardCards -and @($strategy.discardCards).Count -gt 0) {
        $bestLine += ('  |  丢弃 {0}' -f (Format-CardListForDisplay $strategy.discardCards))
    }
    $lines.Add($bestLine)

    if ((@($strategy.bestResolvedCards) -join '|') -ne (@($strategy.bestCards) -join '|')) {
        $lines.Add(('代入：{0}' -f (Format-CardListForDisplay $strategy.bestResolvedCards)))
    }

    return ($lines -join [Environment]::NewLine)
}

function Format-RecognitionSummaryForHistory($payload) {
    $entries = Get-RecognitionEntries $payload
    if ($entries.Count -eq 0) {
        return '无'
    }

    if ($entries.Count -eq 1) {
        return (Format-CardListForDisplay $entries[0].result.recognized.cardCodes)
    }

    return (($entries | ForEach-Object {
        '#{0} {1}' -f $_.regionIndex, (Format-CardListForDisplay $_.result.recognized.cardCodes)
    }) -join ' | ')
}

function Format-StrategySummaryForHistory($payload) {
    $entries = Get-RecognitionEntries $payload
    if ($entries.Count -eq 0) {
        return '无'
    }

    if ($entries.Count -eq 1) {
        return (Format-CardListForDisplay $entries[0].result.strategy.bestCards)
    }

    return (($entries | ForEach-Object {
        '#{0} {1}' -f $_.regionIndex, (Format-CardListForDisplay $_.result.strategy.bestCards)
    }) -join ' | ')
}

function Get-CardDisplayColor([string]$text) {
    if ([string]::IsNullOrWhiteSpace($text)) {
        return [System.Drawing.Color]::Black
    }

    if ($text.Contains('♥') -or $text.Contains('♦') -or $text.Contains('大王')) {
        return [System.Drawing.Color]::FromArgb(210, 45, 45)
    }

    return [System.Drawing.Color]::Black
}

function Append-ColoredResultText([System.Windows.Forms.RichTextBox]$resultBox, [string]$text, [System.Drawing.Color]$color, [System.Drawing.Font]$font = $null) {
    if ([string]::IsNullOrEmpty($text)) {
        return
    }

    if ($null -eq $font) {
        $font = $resultBox.Font
    }

    $start = $resultBox.TextLength
    $resultBox.AppendText($text)
    $resultBox.Select($start, $text.Length)
    $resultBox.SelectionColor = $color
    $resultBox.SelectionFont = $font
    $resultBox.Select($resultBox.TextLength, 0)
}

function Set-ResultBoxContent([System.Windows.Forms.RichTextBox]$resultBox, [string]$text) {
    $resultBox.SuspendLayout()
    try {
        $resultBox.Clear()
        if ([string]::IsNullOrEmpty($text)) {
            return
        }

        $pattern = [regex]'大王|小王|王|(10|[2-9AJQKA])([♠♥♦♣])|([♠♥♦♣])'
        $suitFont = Get-UiSuitFont ($resultBox.Font.Size + 2.0)
        $currentIndex = 0
        foreach ($match in $pattern.Matches($text)) {
            if ($match.Index -gt $currentIndex) {
                Append-ColoredResultText -resultBox $resultBox -text $text.Substring($currentIndex, $match.Index - $currentIndex) -color ([System.Drawing.Color]::Black)
            }

            $matchColor = Get-CardDisplayColor $match.Value
            if ($match.Groups[1].Success -and $match.Groups[2].Success) {
                Append-ColoredResultText -resultBox $resultBox -text $match.Groups[1].Value -color $matchColor
                Append-ColoredResultText -resultBox $resultBox -text $match.Groups[2].Value -color $matchColor -font $suitFont
            } elseif ($match.Value -eq '大王' -or $match.Value -eq '小王' -or $match.Value -eq '王') {
                Append-ColoredResultText -resultBox $resultBox -text $match.Value -color $matchColor
            } else {
                Append-ColoredResultText -resultBox $resultBox -text $match.Value -color $matchColor -font $suitFont
            }
            $currentIndex = $match.Index + $match.Length
        }

        if ($currentIndex -lt $text.Length) {
            Append-ColoredResultText -resultBox $resultBox -text $text.Substring($currentIndex) -color ([System.Drawing.Color]::Black)
        }

        $resultBox.Select($resultBox.TextLength, 0)
        $resultBox.ScrollToCaret()
    } finally {
        if ($null -ne $suitFont) {
            $suitFont.Dispose()
        }
        $resultBox.ResumeLayout()
    }
}

function Format-RegionListItemText([int]$index, $region) {
    return ('#{0}  {1}' -f ($index + 1), (Format-RegionText $region))
}

function Get-SelectedRegionIndex($currentRegion, [string]$actionName = '操作') {
    $regions = @(Get-HandRegionList $currentRegion.Value)
    if ($regions.Count -le 0) {
        Show-WarningDialog '请先添加区域。'
        return -1
    }

    $selectedIndex = -1
    if ($null -ne $script:RegionListBox -and $script:RegionListBox.SelectedIndex -ge 0) {
        $selectedIndex = [int]$script:RegionListBox.SelectedIndex
    } elseif ($null -ne $script:RegionSelectionState) {
        $selectedIndex = [int]$script:RegionSelectionState.Value
    }

    if ($selectedIndex -lt 0 -or $selectedIndex -ge $regions.Count) {
        Show-WarningDialog ("请先在区域列表里选中一个区域，再{0}。" -f $actionName)
        return -1
    }

    return $selectedIndex
}

function Update-RegionManagerState($currentRegion) {
    if ($null -eq $script:RegionListBox) {
        return
    }

    $regions = @(Get-HandRegionList $currentRegion.Value)
    $selectedIndex = if ($null -ne $script:RegionSelectionState) { [int]$script:RegionSelectionState.Value } else { -1 }
    if ($selectedIndex -lt 0 -or $selectedIndex -ge $regions.Count) {
        $selectedIndex = if ($regions.Count -gt 0) { 0 } else { -1 }
    }

    $script:RegionListBox.BeginUpdate()
    try {
        $script:RegionListBox.Items.Clear()
        for ($index = 0; $index -lt $regions.Count; $index += 1) {
            [void]$script:RegionListBox.Items.Add((Format-RegionListItemText -index $index -region $regions[$index]))
        }
    } finally {
        $script:RegionListBox.EndUpdate()
    }

    if ($selectedIndex -ge 0 -and $selectedIndex -lt $script:RegionListBox.Items.Count) {
        $script:RegionListBox.SelectedIndex = $selectedIndex
    } else {
        $script:RegionListBox.ClearSelected()
    }

    if ($null -ne $script:RegionSelectionState) {
        $script:RegionSelectionState.Value = $selectedIndex
    }

    if ($null -ne $script:RegionGroupBox) {
        $script:RegionGroupBox.Text = ('区域入口（{0}/{1}）' -f $regions.Count, $script:MaxHandRegionCount)
    }

    if ($null -ne $script:RegionManagerHintLabel) {
        if ($regions.Count -le 0) {
            $script:RegionManagerHintLabel.Text = '入口：点“加区域”开始，最多 8 个。'
        } elseif ($selectedIndex -ge 0 -and $selectedIndex -lt $regions.Count) {
            $script:RegionManagerHintLabel.Text = ('当前选中：#{0} | {1} | 新增沿用#1尺寸，改选中沿用当前尺寸。' -f ($selectedIndex + 1), (Format-RegionText $regions[$selectedIndex]))
        } else {
            $script:RegionManagerHintLabel.Text = ('已设置 {0} 个区域；继续添加时只需点左上角。' -f $regions.Count)
        }
    }

    $isRunning = $script:LoopState.Running
    if ($null -ne $script:AddRegionButton) {
        $script:AddRegionButton.Enabled = (-not $isRunning -and $regions.Count -lt $script:MaxHandRegionCount)
        $script:AddRegionButton.Text = if ($regions.Count -gt 0) { '加同尺寸' } else { '加区域' }
    }
    if ($null -ne $script:ReplaceRegionButton) {
        $script:ReplaceRegionButton.Enabled = (-not $isRunning -and $regions.Count -gt 0)
        $script:ReplaceRegionButton.Text = if ($regions.Count -gt 0) { '改位置' } else { '改选中' }
    }
    if ($null -ne $script:RemoveRegionButton) {
        $script:RemoveRegionButton.Enabled = (-not $isRunning -and $regions.Count -gt 0)
    }
    if ($null -ne $script:ClearRegionsButton) {
        $script:ClearRegionsButton.Enabled = (-not $isRunning -and $regions.Count -gt 0)
    }
    if ($null -ne $script:RegionListBox) {
        $script:RegionListBox.Enabled = ($regions.Count -gt 0)
    }
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
    $regionCount = Get-HandRegionCount $currentRegion.Value
    $hasRegion = ($regionCount -gt 0)
    $hasPlayPoint = ($null -ne $currentPlayPoint.Value)
    $hasNode = Test-NodeInstalled
    $hasTemplates = Test-HasTemplates
    $isRunning = $script:LoopState.Running

    $modeCombo.Enabled = $true
    $selectButton.Enabled = (-not $isRunning -and $regionCount -lt $script:MaxHandRegionCount)
    $playPointButton.Enabled = $true
    $openTemplatesButton.Enabled = $true

    $recognizeButton.Enabled = $true
    $loopToggle.Enabled = $true
    $autoPlayCheckBox.Enabled = $true
    if ($null -ne $script:JokerModeCheckBox) {
        $script:JokerModeCheckBox.Enabled = $true
    }

    $jokerEnabled = ($null -ne $script:JokerModeCheckBox -and $script:JokerModeCheckBox.Checked)

    if (-not $hasNode) {
        $footLabel.Text = '缺少内置 Node 运行时。'
    } elseif (-not $hasTemplates) {
        $footLabel.Text = '未放模板，将使用内置识别。'
    } elseif (-not $hasRegion) {
        $footLabel.Text = '先框选手牌区域。'
    } elseif ($regionCount -gt 1) {
        if ($autoPlayCheckBox.Checked) {
            $footLabel.Text = '多区域模式只识别展示，不支持自动出牌。'
        } elseif ($isRunning) {
            $footLabel.Text = ('挂机中：已设置 {0} 个区域，结果会汇总显示在日志窗口。' -f $regionCount)
        } else {
            $footLabel.Text = ('已设置 {0} 个区域，识别结果会汇总显示在日志窗口。' -f $regionCount)
        }
    } elseif (-not $hasPlayPoint) {
        $footLabel.Text = '可先设置出牌点，再开启自动出牌。'
    } elseif ($isRunning) {
        $footLabel.Text = if ($jokerEnabled) { '挂机中：牌变了才再次出牌；鬼牌赖子已启用。' } else { '挂机中：牌变了才再次出牌。' }
    } else {
        $footLabel.Text = if ($jokerEnabled) { '已就绪；鬼牌赖子已启用。' } else { '已就绪。' }
    }

    Update-LoopToggleText $loopToggle
    Update-RegionManagerState -currentRegion $currentRegion
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

    if ((Get-HandRegionCount $currentRegion.Value) -le 0) {
        Show-WarningDialog '请先框选手牌区域。'
        return $false
    }

    return $true
}

function Ensure-CanAutoPlay($currentPlayPoint, $currentRegion) {
    if ((Get-HandRegionCount $currentRegion.Value) -gt 1) {
        Show-WarningDialog '多区域模式下暂不支持自动出牌。`n请只保留 1 个区域，或先关闭自动出牌。'
        return $false
    }

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
    $entries = Get-RecognitionEntries $payload
    $regionSignatures = @($entries | ForEach-Object {
        '{0}:{1}' -f $_.regionIndex, (@($_.result.recognized.cardCodes) -join '|')
    })
    return ('{0}:{1}' -f $cardCount, ($regionSignatures -join '||'))
}

function Is-LoopCooldownActive() {
    return $script:LoopState.Running -and ([DateTime]::UtcNow -lt $script:LoopState.CooldownUntil)
}

function Request-LoopStop() {
    $script:LoopState.StopRequested = $true
    $script:LoopState.Running = $false
}

function Wait-WithUiPump([int]$milliseconds) {
    $remaining = [Math]::Max(0, $milliseconds)
    while ($remaining -gt 0) {
        [System.Windows.Forms.Application]::DoEvents()
        if ($script:LoopState.StopRequested) {
            return $false
        }

        $slice = [Math]::Min(40, $remaining)
        Start-Sleep -Milliseconds $slice
        $remaining -= $slice
    }

    [System.Windows.Forms.Application]::DoEvents()
    return (-not $script:LoopState.StopRequested)
}

function ConvertTo-ProcessArgument([string]$value) {
    if ($null -eq $value) {
        return '""'
    }

    return '"' + ($value -replace '"', '\"') + '"'
}

function Get-AverageConfidence($payload) {
    $allCards = @()
    foreach ($entry in (Get-RecognitionEntries $payload)) {
        $allCards += @($entry.result.recognized.cards)
    }

    if ($allCards.Count -eq 0) {
        return 0
    }

    $average = ($allCards | Measure-Object -Property confidence -Average).Average
    if ($null -eq $average) {
        return 0
    }

    return [Math]::Round([double]$average, 4)
}

function Update-Status([System.Windows.Forms.Label]$statusLabel, [string]$message) {
    $loopText = if ($script:LoopState.Running) { '挂机中' } else { '未挂机' }
    $statusLabel.Text = ('状态：{0} | {1}' -f $message, $loopText)
}

function Resolve-LoopIntervalMilliseconds($rawValue, [int]$fallback = 1200) {
    if ($null -eq $rawValue -or [string]::IsNullOrWhiteSpace([string]$rawValue)) {
        return $fallback
    }

    $resolvedValue = 0
    if (-not [int]::TryParse([string]$rawValue, [ref]$resolvedValue)) {
        throw '挂机间隔必须是毫秒整数。'
    }

    if ($resolvedValue -lt 200) {
        throw '挂机间隔不能小于 200 毫秒。'
    }

    if ($resolvedValue -gt 60000) {
        throw '挂机间隔不能大于 60000 毫秒。'
    }

    return $resolvedValue
}

function Apply-LoopIntervalValue([System.Windows.Forms.TextBox]$loopIntervalTextBox, [System.Windows.Forms.Timer]$timer, [switch]$Quiet) {
    try {
        $resolvedInterval = Resolve-LoopIntervalMilliseconds $loopIntervalTextBox.Text $script:LoopIntervalMs
        $script:LoopIntervalMs = $resolvedInterval
        $loopIntervalTextBox.Text = [string]$resolvedInterval
        if ($null -ne $timer) {
            $timer.Interval = $resolvedInterval
        }
        return $true
    } catch {
        if (-not $Quiet) {
            Show-WarningDialog $_.Exception.Message
        }
        $loopIntervalTextBox.Text = [string]$script:LoopIntervalMs
        return $false
    }
}

function Prepare-ForScreenPick([System.Windows.Forms.Form]$form, [System.Windows.Forms.Label]$statusLabel, [string]$actionName) {
    Show-WarningDialog ("请在 2 秒内切回游戏窗口，然后开始{0}。" -f $actionName)
    Update-Status $statusLabel ('准备' + $actionName)
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
    Start-Sleep -Milliseconds 1800
}

function Get-FixedSelectionRectangle([System.Windows.Forms.Form]$selectionForm, $referenceRegion, [System.Drawing.Point]$location) {
    if ($null -eq $referenceRegion) {
        return $null
    }

    $width = [Math]::Max(1, [int]$referenceRegion.width)
    $height = [Math]::Max(1, [int]$referenceRegion.height)
    $maxLeft = [Math]::Max(0, $selectionForm.ClientSize.Width - $width)
    $maxTop = [Math]::Max(0, $selectionForm.ClientSize.Height - $height)
    $left = [Math]::Min([Math]::Max([int]$location.X, 0), $maxLeft)
    $top = [Math]::Min([Math]::Max([int]$location.Y, 0), $maxTop)
    return New-Object System.Drawing.Rectangle($left, $top, $width, $height)
}

function Select-ScreenRegion($referenceRegion = $null) {
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
    $script:RegionPickReference = Convert-ToRegionObject $referenceRegion
    $script:RegionPickFixedMode = ($null -ne $script:RegionPickReference)
    $script:RegionPickIsDragging = $false
    $script:RegionPickDragStart = [System.Drawing.Point]::Empty
    $script:RegionPickCurrentRect = New-Object System.Drawing.Rectangle(0, 0, 0, 0)
    $script:RegionPickSelectedRect = $null

    $selectionForm.Add_KeyDown({
        if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
            $this.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
            $this.Close()
        }
    })
    $selectionForm.Add_MouseDown({
        if ($_.Button -ne [System.Windows.Forms.MouseButtons]::Left) {
            return
        }

        if ($script:RegionPickFixedMode) {
            $script:RegionPickCurrentRect = Get-FixedSelectionRectangle -selectionForm $this -referenceRegion $script:RegionPickReference -location $_.Location
            if ($null -ne $script:RegionPickCurrentRect -and $script:RegionPickCurrentRect.Width -gt 0 -and $script:RegionPickCurrentRect.Height -gt 0) {
                $script:RegionPickSelectedRect = $script:RegionPickCurrentRect
                $this.DialogResult = [System.Windows.Forms.DialogResult]::OK
                $this.Close()
            }
            return
        }

        $script:RegionPickIsDragging = $true
        $script:RegionPickDragStart = $_.Location
        $script:RegionPickCurrentRect = New-Object System.Drawing.Rectangle($_.Location.X, $_.Location.Y, 0, 0)
        $this.Capture = $true
        $this.Invalidate()
    })
    $selectionForm.Add_MouseMove({
        if ($script:RegionPickFixedMode) {
            $script:RegionPickCurrentRect = Get-FixedSelectionRectangle -selectionForm $this -referenceRegion $script:RegionPickReference -location $_.Location
            $this.Invalidate()
            return
        }

        if ($script:RegionPickIsDragging) {
            $left = [Math]::Min($script:RegionPickDragStart.X, $_.Location.X)
            $top = [Math]::Min($script:RegionPickDragStart.Y, $_.Location.Y)
            $width = [Math]::Abs($_.Location.X - $script:RegionPickDragStart.X)
            $height = [Math]::Abs($_.Location.Y - $script:RegionPickDragStart.Y)
            $script:RegionPickCurrentRect = New-Object System.Drawing.Rectangle($left, $top, $width, $height)
            $this.Invalidate()
        }
    })
    $selectionForm.Add_MouseUp({
        if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left -and $script:RegionPickIsDragging) {
            $script:RegionPickIsDragging = $false
            $this.Capture = $false
            if ($script:RegionPickCurrentRect.Width -gt 5 -and $script:RegionPickCurrentRect.Height -gt 5) {
                $script:RegionPickSelectedRect = $script:RegionPickCurrentRect
                $this.DialogResult = [System.Windows.Forms.DialogResult]::OK
                $this.Close()
            }
        }
    })
    if ($script:RegionPickFixedMode) {
        $selectionForm.Add_Shown({
            $cursorPosition = $this.PointToClient([System.Windows.Forms.Cursor]::Position)
            $script:RegionPickCurrentRect = Get-FixedSelectionRectangle -selectionForm $this -referenceRegion $script:RegionPickReference -location $cursorPosition
            $this.Invalidate()
        })
    }
    $selectionForm.Add_Paint({
        if ($script:RegionPickCurrentRect.Width -gt 0 -and $script:RegionPickCurrentRect.Height -gt 0) {
            $fillBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(55, 0, 170, 255))
            $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 0, 200, 255), 2)
            $_.Graphics.FillRectangle($fillBrush, $script:RegionPickCurrentRect)
            $_.Graphics.DrawRectangle($pen, $script:RegionPickCurrentRect)
            $fillBrush.Dispose()
            $pen.Dispose()
        }
    })

    $dialogResult = $selectionForm.ShowDialog()
    $selectedRect = $script:RegionPickSelectedRect
    $result = $null
    if ($dialogResult -eq [System.Windows.Forms.DialogResult]::OK -and $null -ne $selectedRect) {
        $result = [PSCustomObject][ordered]@{
            x = [int]($selectedRect.X + $selectionForm.Left)
            y = [int]($selectedRect.Y + $selectionForm.Top)
            width = [int]$selectedRect.Width
            height = [int]$selectedRect.Height
        }
    }

    $selectionForm.Dispose()
    $script:RegionPickReference = $null
    $script:RegionPickFixedMode = $false
    $script:RegionPickIsDragging = $false
    $script:RegionPickDragStart = [System.Drawing.Point]::Empty
    $script:RegionPickCurrentRect = New-Object System.Drawing.Rectangle(0, 0, 0, 0)
    $script:RegionPickSelectedRect = $null
    return $result
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
    $entries = Get-RecognitionEntries $payload
    if ($entries.Count -eq 0) {
        return ''
    }

    $blocks = New-Object 'System.Collections.Generic.List[string]'
    $workerCount = if ($null -ne $payload.execution -and $null -ne $payload.execution.workerCount) { [int]$payload.execution.workerCount } else { 1 }
    $durationMs = if ($null -ne $payload.execution -and $null -ne $payload.execution.durationMs) { [int]$payload.execution.durationMs } else { $null }
    $executionMode = if ($null -ne $payload.execution -and -not [string]::IsNullOrWhiteSpace([string]$payload.execution.mode)) { [string]$payload.execution.mode } else { 'unknown' }
    $header = ('共识别 {0} 个区域 | 并发线程：{1} | 模式：{2} 张选 3 张' -f $entries.Count, $workerCount, $payload.state.cardCount)
    $header += (' | 路径：{0}' -f $executionMode)
    if ($null -ne $durationMs) {
        $header += (' | 总耗时：{0} ms' -f $durationMs)
    }
    if ($null -ne $payload.execution -and $null -ne $payload.execution.acceleration) {
        $acceleration = $payload.execution.acceleration
        $openClText = if ($acceleration.openclEnabled) { 'OpenCL开' } elseif ($acceleration.openclAvailable) { 'OpenCL关' } else { 'OpenCL无' }
        $cudaText = if ($acceleration.cudaAvailable) { ('CUDA开({0})' -f $acceleration.cudaDeviceCount) } else { 'CUDA无' }
        $cpuThreadsText = if ($null -ne $acceleration.cpuThreads) { ('CPU线程：{0}' -f $acceleration.cpuThreads) } else { $null }
        $parts = @($openClText, $cudaText)
        if (-not [string]::IsNullOrWhiteSpace($cpuThreadsText)) {
            $parts += $cpuThreadsText
        }
        $header += (' | ' + ($parts -join ' | '))
    }
    $blocks.Add($header)
    for ($index = 0; $index -lt $entries.Count; $index += 1) {
        $block = Build-SingleRecognitionLog -entry $entries[$index] -index ($index + 1) -totalCount $entries.Count
        if (-not [string]::IsNullOrWhiteSpace($block)) {
            $blocks.Add($block)
        }
    }

    return ($blocks -join ([Environment]::NewLine + [Environment]::NewLine))
}


function Invoke-MouseClick($point) {
    [NativeMouse]::SetCursorPos([int]$point.x, [int]$point.y) | Out-Null
    if (-not (Wait-WithUiPump 50)) { return $false }
    [NativeMouse]::mouse_event($script:MouseLeftDown, 0, 0, 0, [UIntPtr]::Zero)
    if (-not (Wait-WithUiPump 40)) {
        [NativeMouse]::mouse_event($script:MouseLeftUp, 0, 0, 0, [UIntPtr]::Zero)
        return $false
    }
    [NativeMouse]::mouse_event($script:MouseLeftUp, 0, 0, 0, [UIntPtr]::Zero)
    return $true
}

function Invoke-ClickPlan([System.Windows.Forms.Form]$form, $payload, [System.Windows.Forms.Label]$statusLabel) {
    if ($null -eq $payload.clickPlan.playButtonPoint) {
        Show-ErrorDialog '请先设置出牌点。'
        return $false
    }

    if ($script:LoopState.StopRequested) {
        return $false
    }

    $originalPosition = [System.Windows.Forms.Cursor]::Position
    try {
        Update-Status $statusLabel '自动出牌中'
        $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
        if (-not (Wait-WithUiPump 220)) { return $false }
        foreach ($point in $payload.clickPlan.cardClickPoints) {
            if ($script:LoopState.StopRequested) { return $false }
            if (-not (Invoke-MouseClick $point)) { return $false }
            if (-not (Wait-WithUiPump 120)) { return $false }
        }
        if ($script:LoopState.StopRequested) { return $false }
        if (-not (Invoke-MouseClick $payload.clickPlan.playButtonPoint)) { return $false }
        if (-not (Wait-WithUiPump 150)) { return $false }
        return $true
    } finally {
        [NativeMouse]::SetCursorPos($originalPosition.X, $originalPosition.Y) | Out-Null
        $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
        if (-not $form.IsDisposed) {
            $form.Activate()
        }
    }
}

function Get-RecognitionPayload([int]$cardCount, $currentRegion, $currentPlayPoint, [switch]$Quiet) {
    $nodeCommand = Get-NodeCommandPath
    if ([string]::IsNullOrWhiteSpace($nodeCommand)) {
        if (-not $Quiet) { Show-ErrorDialog '未检测到可用的 Node 运行时。' }
        return $null
    }
    if ((Get-HandRegionCount $currentRegion.Value) -le 0) {
        if (-not $Quiet) { Show-ErrorDialog '请先框选手牌区域。' }
        return $null
    }

    $jokerMode = ($null -ne $script:JokerModeCheckBox -and $script:JokerModeCheckBox.Checked)
    Save-UiState $currentRegion.Value $cardCount $currentPlayPoint.Value $jokerMode $script:LoopIntervalMs
    return (Invoke-NodeJsonCommand -nodeCommand $nodeCommand -scriptPath $script:NodeScriptPath -arguments @('--region-file', $script:StatePath, '--output', $script:LatestScreenPath, '--card-count', $cardCount, '--allow-jokers', ($(if ($jokerMode) { 'true' } else { 'false' }))) -Depth 50)
}

function Process-RecognitionPayload([System.Windows.Forms.Form]$form, [System.Windows.Forms.Label]$statusLabel, [System.Windows.Forms.RichTextBox]$resultBox, [System.Windows.Forms.CheckBox]$autoPlayCheckBox, $payload, [bool]$fromLoop) {
    $signature = Build-HandSignature $payload
    $averageConfidence = Get-AverageConfidence $payload
    $recognizedRegionCount = @(Get-RecognitionEntries $payload).Count

    if ($fromLoop -and (-not $script:LoopState.Running -or $script:LoopState.StopRequested)) {
        Update-Status $statusLabel '已停止挂机'
        return
    }

    $shouldRefreshLog = (-not $fromLoop) -or ($signature -ne $script:LoopState.LastSeenSignature)
    if ($shouldRefreshLog) {
        Set-ResultBoxContent -resultBox $resultBox -text (Build-RecognitionLog $payload)
    }

    if (-not $fromLoop -and $averageConfidence -lt 0.62) {
        $previewPaths = if ($null -ne $payload.debug.handRegionPreviewPaths) { @($payload.debug.handRegionPreviewPaths) } elseif ($payload.debug.handRegionPreviewPath) { @($payload.debug.handRegionPreviewPath) } else { @() }
        $previewHint = if ($previewPaths.Count -gt 0) { "`n请检查预览图：" + ($previewPaths -join '、') } else { '' }
        $warningText = if ($recognizedRegionCount -gt 1) {
            '当前识别置信度偏低，可能有部分区域没有框到牌角。'
        } else {
            '当前识别置信度偏低，框选区域很可能不是四张牌区域，或者没有框到牌角。'
        }
        Show-WarningDialog ($warningText + $previewHint)
    }

    if ($signature -ne $script:LoopState.LastSeenSignature) {
        Add-History ('新牌面：{0}' -f (Format-RecognitionSummaryForHistory $payload))
        $script:LoopState.LastSeenSignature = $signature
    }

    $shouldAutoPlay = $autoPlayCheckBox.Checked -and ($recognizedRegionCount -eq 1)
    if ($shouldAutoPlay -and $averageConfidence -ge 0.55 -and $signature -ne $script:LoopState.LastActionSignature) {
        $didPlay = Invoke-ClickPlan -form $form -payload $payload -statusLabel $statusLabel
        if ($didPlay) {
            $script:LoopState.LastActionSignature = $signature
            $script:LoopState.CooldownUntil = [DateTime]::UtcNow.AddSeconds(2.8)
            Add-History ('已出牌：保留 {0}' -f (Format-StrategySummaryForHistory $payload))
            if ($shouldRefreshLog) {
                Set-ResultBoxContent -resultBox $resultBox -text (Build-RecognitionLog $payload)
            }
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

function Run-Recognition([System.Windows.Forms.Form]$form, [System.Windows.Forms.Label]$statusLabel, [System.Windows.Forms.RichTextBox]$resultBox, [System.Windows.Forms.ComboBox]$modeCombo, [System.Windows.Forms.CheckBox]$autoPlayCheckBox, $currentRegion, $currentPlayPoint, [switch]$Quiet) {
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

function Start-LoopRecognitionAsync([System.Windows.Forms.Form]$form, [System.Windows.Forms.Label]$statusLabel, [System.Windows.Forms.RichTextBox]$resultBox, [System.Windows.Forms.ComboBox]$modeCombo, [System.Windows.Forms.CheckBox]$autoPlayCheckBox, $currentRegion, $currentPlayPoint, [switch]$Quiet) {
    if (-not $script:LoopState.Running -or $script:LoopState.StopRequested -or $script:LoopState.Busy -or (Is-LoopCooldownActive)) {
        return
    }

    $nodeCommand = Get-NodeCommandPath
    if ([string]::IsNullOrWhiteSpace($nodeCommand)) {
        Update-Status $statusLabel '未检测到 Node'
        return
    }

    if ((Get-HandRegionCount $currentRegion.Value) -le 0) {
        Update-Status $statusLabel '未设置区域'
        return
    }

    $cardCount = Get-SelectedCardCount $modeCombo
    $jokerMode = ($null -ne $script:JokerModeCheckBox -and $script:JokerModeCheckBox.Checked)
    Save-UiState $currentRegion.Value $cardCount $currentPlayPoint.Value $jokerMode $script:LoopIntervalMs

    $stdoutPath = Join-Path $script:ProjectRoot 'screen-recognition\last-loop-node-stdout.json'
    $stderrPath = Join-Path $script:ProjectRoot 'screen-recognition\last-loop-node-stderr.log'
    $jsonOutPath = Join-Path $script:ProjectRoot 'screen-recognition\last-loop-node-payload.json'
    if (Test-Path $stdoutPath) { Remove-Item $stdoutPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path $stderrPath) { Remove-Item $stderrPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path $jsonOutPath) { Remove-Item $jsonOutPath -Force -ErrorAction SilentlyContinue }

    $argumentList = @(
        $script:NodeScriptPath,
        '--region-file', $script:StatePath,
        '--output', $script:LatestScreenPath,
        '--card-count', [string]$cardCount,
        '--allow-jokers', ($(if ($jokerMode) { 'true' } else { 'false' })),
        '--silent', 'true',
        '--json-out', $jsonOutPath
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodeCommand
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $startInfo.Arguments = (($argumentList | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join ' ')

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        $process.Dispose()
        throw '无法启动识别进程。'
    }

    $script:LoopState.Busy = $true
    Update-Status $statusLabel '挂机识别中'
    $script:LoopState.ActiveRecognition = [PSCustomObject]@{
        Process = $process
        StdoutPath = $stdoutPath
        StderrPath = $stderrPath
        JsonOutPath = $jsonOutPath
        Depth = 50
    }
}

function Complete-LoopRecognitionAsync([System.Windows.Forms.Form]$form, [System.Windows.Forms.Label]$statusLabel, [System.Windows.Forms.RichTextBox]$resultBox, [System.Windows.Forms.CheckBox]$autoPlayCheckBox) {
    $activeRecognition = $script:LoopState.ActiveRecognition
    if ($null -eq $activeRecognition) {
        return
    }

    $process = $activeRecognition.Process
    if ($null -eq $process) {
        $script:LoopState.ActiveRecognition = $null
        $script:LoopState.Busy = $false
        return
    }

    if (-not $process.HasExited) {
        return
    }

    try {
        $stdoutText = $process.StandardOutput.ReadToEnd()
        $stderrText = $process.StandardError.ReadToEnd()
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($activeRecognition.StdoutPath, $stdoutText, $utf8NoBom)
        [System.IO.File]::WriteAllText($activeRecognition.StderrPath, $stderrText, $utf8NoBom)

        if ($process.ExitCode -ne 0) {
            if ($script:LoopState.Running -and -not $script:LoopState.StopRequested) {
                Update-Status $statusLabel '挂机识别失败'
                Add-History ('挂机异常：' + ((@($stderrText, $stdoutText) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ' '))
            }
            return
        }

        $jsonText = if (Test-Path $activeRecognition.JsonOutPath) {
            Get-Content $activeRecognition.JsonOutPath -Raw -Encoding UTF8
        } else {
            $stdoutText
        }
        $payload = Convert-NodeJsonTextToObject -jsonText $jsonText -stdoutPath $activeRecognition.StdoutPath -jsonOutPath $activeRecognition.JsonOutPath -stderrText $stderrText -Depth $activeRecognition.Depth
        if (-not $form.IsDisposed) {
            Process-RecognitionPayload -form $form -statusLabel $statusLabel -resultBox $resultBox -autoPlayCheckBox $autoPlayCheckBox -payload $payload -fromLoop:$true
        }
    } finally {
        $process.Dispose()
        $script:LoopState.ActiveRecognition = $null
        $script:LoopState.Busy = $false
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
$form.ClientSize = New-Object System.Drawing.Size(760, 398)
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

$jokerModeCheckBox = New-Object System.Windows.Forms.CheckBox
$jokerModeCheckBox.Text = '鬼牌赖子'
$jokerModeCheckBox.AutoSize = $true
$jokerModeCheckBox.Location = New-Object System.Drawing.Point(92, 14)
$form.Controls.Add($jokerModeCheckBox)
$script:JokerModeCheckBox = $jokerModeCheckBox

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

$playPointLabel = New-Object System.Windows.Forms.Label
$playPointLabel.Text = '出牌点：未设置'
$playPointLabel.AutoSize = $false
$playPointLabel.Size = New-Object System.Drawing.Size(416, 18)
$playPointLabel.Location = New-Object System.Drawing.Point(12, 72)
$form.Controls.Add($playPointLabel)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = '状态：待机 | 未挂机'
$statusLabel.AutoSize = $false
$statusLabel.Size = New-Object System.Drawing.Size(326, 18)
$statusLabel.Location = New-Object System.Drawing.Point(12, 92)
$form.Controls.Add($statusLabel)

$selectButton = New-Object System.Windows.Forms.Button
$selectButton.Text = '加区域'
$selectButton.Size = New-Object System.Drawing.Size(64, 26)
$selectButton.Location = New-Object System.Drawing.Point(10, 250)
$form.Controls.Add($selectButton)

$playPointButton = New-Object System.Windows.Forms.Button
$playPointButton.Text = '出牌点'
$playPointButton.Size = New-Object System.Drawing.Size(76, 30)
$playPointButton.Location = New-Object System.Drawing.Point(12, 118)
$form.Controls.Add($playPointButton)

$recognizeButton = New-Object System.Windows.Forms.Button
$recognizeButton.Text = '识别'
$recognizeButton.Size = New-Object System.Drawing.Size(76, 30)
$recognizeButton.Location = New-Object System.Drawing.Point(94, 118)
$form.Controls.Add($recognizeButton)

$openTemplatesButton = New-Object System.Windows.Forms.Button
$openTemplatesButton.Text = '模板'
$openTemplatesButton.Size = New-Object System.Drawing.Size(76, 30)
$openTemplatesButton.Location = New-Object System.Drawing.Point(176, 118)
$form.Controls.Add($openTemplatesButton)

$loopIntervalLabel = New-Object System.Windows.Forms.Label
$loopIntervalLabel.Text = '间隔(ms)：'
$loopIntervalLabel.AutoSize = $false
$loopIntervalLabel.Size = New-Object System.Drawing.Size(82, 18)
$loopIntervalLabel.Location = New-Object System.Drawing.Point(346, 92)
$form.Controls.Add($loopIntervalLabel)

$loopIntervalTextBox = New-Object System.Windows.Forms.TextBox
$loopIntervalTextBox.Size = New-Object System.Drawing.Size(82, 30)
$loopIntervalTextBox.Location = New-Object System.Drawing.Point(346, 118)
$loopIntervalTextBox.TextAlign = [System.Windows.Forms.HorizontalAlignment]::Center
$loopIntervalTextBox.Text = [string]$script:LoopIntervalMs
$form.Controls.Add($loopIntervalTextBox)

$regionGroupBox = New-Object System.Windows.Forms.GroupBox
$regionGroupBox.Text = '区域入口（0/8）'
$regionGroupBox.Size = New-Object System.Drawing.Size(308, 350)
$regionGroupBox.Location = New-Object System.Drawing.Point(440, 12)
$form.Controls.Add($regionGroupBox)
$script:RegionGroupBox = $regionGroupBox

$regionListBox = New-Object System.Windows.Forms.ListBox
$regionListBox.Size = New-Object System.Drawing.Size(288, 220)
$regionListBox.Location = New-Object System.Drawing.Point(10, 22)
$regionListBox.HorizontalScrollbar = $true
$regionListBox.IntegralHeight = $false
$regionListBox.Font = Get-UiFont 8.5
$regionGroupBox.Controls.Add($regionListBox)
$script:RegionListBox = $regionListBox

$regionGroupBox.Controls.Add($selectButton)
$script:AddRegionButton = $selectButton

$replaceRegionButton = New-Object System.Windows.Forms.Button
$replaceRegionButton.Text = '改选中'
$replaceRegionButton.Size = New-Object System.Drawing.Size(64, 26)
$replaceRegionButton.Location = New-Object System.Drawing.Point(82, 250)
$regionGroupBox.Controls.Add($replaceRegionButton)
$script:ReplaceRegionButton = $replaceRegionButton

$removeRegionButton = New-Object System.Windows.Forms.Button
$removeRegionButton.Text = '删选中'
$removeRegionButton.Size = New-Object System.Drawing.Size(64, 26)
$removeRegionButton.Location = New-Object System.Drawing.Point(154, 250)
$regionGroupBox.Controls.Add($removeRegionButton)
$script:RemoveRegionButton = $removeRegionButton

$clearRegionsButton = New-Object System.Windows.Forms.Button
$clearRegionsButton.Text = '清空'
$clearRegionsButton.Size = New-Object System.Drawing.Size(64, 26)
$clearRegionsButton.Location = New-Object System.Drawing.Point(226, 250)
$regionGroupBox.Controls.Add($clearRegionsButton)
$script:ClearRegionsButton = $clearRegionsButton

$regionManagerHintLabel = New-Object System.Windows.Forms.Label
$regionManagerHintLabel.Text = '入口：点“加区域”开始，最多 8 个。'
$regionManagerHintLabel.AutoSize = $false
$regionManagerHintLabel.Size = New-Object System.Drawing.Size(288, 58)
$regionManagerHintLabel.Location = New-Object System.Drawing.Point(10, 286)
$regionManagerHintLabel.ForeColor = [System.Drawing.Color]::FromArgb(90, 90, 90)
$regionGroupBox.Controls.Add($regionManagerHintLabel)
$script:RegionManagerHintLabel = $regionManagerHintLabel

$script:RegionSelectionState = [PSCustomObject]@{ Value = -1 }

$resultBox = New-Object System.Windows.Forms.RichTextBox
$resultBox.Multiline = $true
$resultBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
$resultBox.WordWrap = $false
$resultBox.ReadOnly = $true
$resultBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$resultBox.DetectUrls = $false
$resultBox.Size = New-Object System.Drawing.Size(416, 186)
$resultBox.Location = New-Object System.Drawing.Point(12, 154)
$resultBox.BackColor = [System.Drawing.Color]::White
$resultBox.ForeColor = [System.Drawing.Color]::Black
$resultBox.Font = Get-UiFont 9
$form.Controls.Add($resultBox)

$footLabel = New-Object System.Windows.Forms.Label
$footLabel.Text = '连续模式：牌变了才再次出牌。'
$footLabel.AutoSize = $false
$footLabel.Size = New-Object System.Drawing.Size(736, 18)
$footLabel.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 110)
$footLabel.Location = New-Object System.Drawing.Point(12, 368)
$form.Controls.Add($footLabel)

$currentRegion = [PSCustomObject]@{ Value = @() }
$currentPlayPoint = [PSCustomObject]@{ Value = $null }
$currentCardCount = [PSCustomObject]@{ Value = 4 }
$savedState = Get-SavedState
if ($null -ne $savedState) {
    $savedRegions = Get-HandRegionsFromState $savedState
    if ($savedRegions.Count -gt 0) {
        $currentRegion.Value = $savedRegions
    }
    if ($null -ne $savedState.playButtonPoint) {
        $currentPlayPoint.Value = $savedState.playButtonPoint
        Update-PlayPointLabel $playPointLabel $currentPlayPoint.Value
    }
    Set-SelectedCardCount $modeCombo $savedState.cardCount
    $currentCardCount.Value = [int]$savedState.cardCount
    if ($null -ne $savedState.jokerMode) {
        $jokerModeCheckBox.Checked = [bool]$savedState.jokerMode
    }
    if ($null -ne $savedState.loopIntervalMs) {
        try {
            $script:LoopIntervalMs = Resolve-LoopIntervalMilliseconds $savedState.loopIntervalMs $script:LoopIntervalMs
        } catch {
            $script:LoopIntervalMs = 1200
        }
    }
} else {
    Set-SelectedCardCount $modeCombo 4
    $currentCardCount.Value = 4
}

$loopIntervalTextBox.Text = [string]$script:LoopIntervalMs

Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $script:LoopIntervalMs
$timer.Add_Tick({
    if ($null -ne $script:LoopState.ActiveRecognition) {
        Complete-LoopRecognitionAsync -form $form -statusLabel $statusLabel -resultBox $resultBox -autoPlayCheckBox $autoPlayCheckBox
        if ($null -ne $script:LoopState.ActiveRecognition) { return }
    }

    if (-not $script:LoopState.Running -or $script:LoopState.StopRequested -or $script:LoopState.Busy -or (Is-LoopCooldownActive)) { return }
    Start-LoopRecognitionAsync -form $form -statusLabel $statusLabel -resultBox $resultBox -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint -Quiet
})

$modeCombo.Add_SelectedIndexChanged({
    if ($script:LoopState.Running) {
        Set-SelectedCardCount $modeCombo $currentCardCount.Value
        Show-WarningDialog '请先停止挂机，再切换模式。'
        return
    }

    $currentCardCount.Value = Get-SelectedCardCount $modeCombo
    Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value $jokerModeCheckBox.Checked $script:LoopIntervalMs
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
})

$loopIntervalTextBox.Add_Leave({
    if (Apply-LoopIntervalValue -loopIntervalTextBox $loopIntervalTextBox -timer $timer) {
        Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value $jokerModeCheckBox.Checked $script:LoopIntervalMs
    }
})

$loopIntervalTextBox.Add_KeyDown({
    if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
        $_.SuppressKeyPress = $true
        if (Apply-LoopIntervalValue -loopIntervalTextBox $loopIntervalTextBox -timer $timer) {
            Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value $jokerModeCheckBox.Checked $script:LoopIntervalMs
        }
    }
})

$jokerModeCheckBox.Add_Click({
    if ($script:LoopState.Running) {
        $jokerModeCheckBox.Checked = -not $jokerModeCheckBox.Checked
        Show-WarningDialog '请先停止挂机，再修改鬼牌赖子设置。'
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
        return
    }

    Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value $jokerModeCheckBox.Checked $script:LoopIntervalMs
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
})

$autoPlayCheckBox.Add_Click({
    if ($script:LoopState.Running) {
        $autoPlayCheckBox.Checked = -not $autoPlayCheckBox.Checked
        Show-WarningDialog '请先停止挂机，再修改自动出牌设置。'
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
        return
    }

    if ($autoPlayCheckBox.Checked -and -not (Ensure-CanAutoPlay $currentPlayPoint $currentRegion)) {
        $autoPlayCheckBox.Checked = $false
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
    }
})

$regionListBox.Add_SelectedIndexChanged({
    if ($regionListBox.SelectedIndex -ge 0) {
        $script:RegionSelectionState.Value = [int]$regionListBox.SelectedIndex
    } else {
        $script:RegionSelectionState.Value = -1
    }
    Update-RegionManagerState -currentRegion $currentRegion
})

$selectButton.Add_Click({
    if (-not (Ensure-NotRunning '添加区域')) {
        return
    }

    $existingRegions = @(Get-HandRegionList $currentRegion.Value)
    if ($existingRegions.Count -ge $script:MaxHandRegionCount) {
        Show-WarningDialog ("当前已设置 {0} 个区域，已达到上限。`n请先删除不需要的区域，或先清空后重新添加。" -f $script:MaxHandRegionCount)
        return
    }

    $referenceRegion = if ($existingRegions.Count -gt 0) { $existingRegions[0] } else { $null }
    $actionName = if ($existingRegions.Count -gt 0) {
        ('点击第 {0} 个手牌区域的左上角（沿用第 1 个区域大小）' -f ($existingRegions.Count + 1))
    } else {
        ('框选第 {0} 个手牌区域' -f ($existingRegions.Count + 1))
    }
    Prepare-ForScreenPick -form $form -statusLabel $statusLabel -actionName $actionName
    $region = Select-ScreenRegion $referenceRegion
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $form.Activate()
    if ($null -ne $region) {
        $currentRegion.Value = @($existingRegions + @($region))
        $script:RegionSelectionState.Value = $currentRegion.Value.Count - 1
        Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value $jokerModeCheckBox.Checked $script:LoopIntervalMs
        Update-RegionManagerState -currentRegion $currentRegion
        $savedRegionCount = Get-HandRegionCount $currentRegion.Value
        Update-Status $statusLabel ('已保存区域（{0}/{1}）' -f $savedRegionCount, $script:MaxHandRegionCount)
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
    } else {
        Update-Status $statusLabel '未保存区域：已取消选择，或选区尺寸过小。'
    }
})

$replaceRegionButton.Add_Click({
    if (-not (Ensure-NotRunning '重框选中的区域')) {
        return
    }

    $selectedIndex = Get-SelectedRegionIndex -currentRegion $currentRegion -actionName '重框当前区域'
    if ($selectedIndex -lt 0) {
        return
    }

    $regions = @(Get-HandRegionList $currentRegion.Value)
    $referenceRegion = $regions[$selectedIndex]
    $actionName = if ($null -ne $referenceRegion) {
        ('点击第 {0} 个手牌区域新的左上角（沿用当前区域大小）' -f ($selectedIndex + 1))
    } else {
        ('重框第 {0} 个手牌区域' -f ($selectedIndex + 1))
    }
    Prepare-ForScreenPick -form $form -statusLabel $statusLabel -actionName $actionName
    $region = Select-ScreenRegion $referenceRegion
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $form.Activate()
    if ($null -ne $region) {
        $regions[$selectedIndex] = $region
        $currentRegion.Value = @($regions)
        $script:RegionSelectionState.Value = $selectedIndex
        Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value $jokerModeCheckBox.Checked $script:LoopIntervalMs
        Update-RegionManagerState -currentRegion $currentRegion
        Update-Status $statusLabel ('已替换区域 #{0}' -f ($selectedIndex + 1))
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
    } else {
        Update-Status $statusLabel ('未替换区域 #{0}：已取消选择，或选区尺寸过小。' -f ($selectedIndex + 1))
    }
})

$removeRegionButton.Add_Click({
    if (-not (Ensure-NotRunning '删除选中的区域')) {
        return
    }

    $selectedIndex = Get-SelectedRegionIndex -currentRegion $currentRegion -actionName '删除当前区域'
    if ($selectedIndex -lt 0) {
        return
    }

    $regions = New-Object 'System.Collections.Generic.List[object]'
    foreach ($region in @(Get-HandRegionList $currentRegion.Value)) {
        $regions.Add($region)
    }
    $regions.RemoveAt($selectedIndex)
    $currentRegion.Value = @($regions.ToArray())
    $remainingCount = $currentRegion.Value.Count
    $script:RegionSelectionState.Value = if ($remainingCount -gt 0) { [Math]::Min($selectedIndex, $remainingCount - 1) } else { -1 }
    Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value $jokerModeCheckBox.Checked $script:LoopIntervalMs
    Update-RegionManagerState -currentRegion $currentRegion
    Update-Status $statusLabel ('已删除区域 #{0}' -f ($selectedIndex + 1))
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
})

$clearRegionsButton.Add_Click({
    if (-not (Ensure-NotRunning '清空区域')) {
        return
    }

    if ((Get-HandRegionCount $currentRegion.Value) -le 0) {
        return
    }

    $clearChoice = [System.Windows.Forms.MessageBox]::Show(
        '确定要清空当前所有区域吗？',
        '屏幕识牌助手',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question
    )
    if ($clearChoice -ne [System.Windows.Forms.DialogResult]::Yes) {
        return
    }

    $currentRegion.Value = @()
    $script:RegionSelectionState.Value = -1
    Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value $jokerModeCheckBox.Checked $script:LoopIntervalMs
    Update-RegionManagerState -currentRegion $currentRegion
    Update-Status $statusLabel '已清空所有区域'
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
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
        Save-UiState $currentRegion.Value (Get-SelectedCardCount $modeCombo) $currentPlayPoint.Value $jokerModeCheckBox.Checked $script:LoopIntervalMs
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

    if ($autoPlayCheckBox.Checked -and -not (Ensure-CanAutoPlay $currentPlayPoint $currentRegion)) {
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
        Request-LoopStop
        Stop-ActiveLoopRecognition
        if ($script:LoopState.Busy) {
            Update-Status $statusLabel '正在停止挂机'
        } else {
            Update-Status $statusLabel '已停止挂机'
        }
        Add-History '挂机停止'
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
        return
    }

    if (-not (Ensure-CanRecognize $currentRegion)) {
        $loopToggle.Checked = $false
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
        return
    }

    if ($autoPlayCheckBox.Checked -and -not (Ensure-CanAutoPlay $currentPlayPoint $currentRegion)) {
        $loopToggle.Checked = $false
        Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
        return
    }

    $script:LoopState.Running = $true
    $script:LoopState.Busy = $false
    $script:LoopState.StopRequested = $false
    $script:LoopState.CooldownUntil = [DateTime]::MinValue
    $script:LoopState.LastSeenSignature = $null
    $script:LoopState.LastActionSignature = $null
    Add-History '挂机开始'
    Update-Status $statusLabel '挂机中'
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
    $timer.Start()
    Start-LoopRecognitionAsync -form $form -statusLabel $statusLabel -resultBox $resultBox -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint -Quiet
})

$openTemplatesButton.Add_Click({
    $templatesRoot = Join-Path $script:ProjectRoot 'screen-recognition\templates'
    Ensure-ParentDirectory (Join-Path $templatesRoot 'placeholder.txt')
    Start-Process explorer.exe $templatesRoot
    Start-Sleep -Milliseconds 100
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
})

$form.Add_FormClosing({
    $timer.Stop()
    Request-LoopStop
    Stop-ActiveLoopRecognition
})
$form.Add_Activated({
    Update-InteractiveState -modeCombo $modeCombo -autoPlayCheckBox $autoPlayCheckBox -loopToggle $loopToggle -selectButton $selectButton -playPointButton $playPointButton -recognizeButton $recognizeButton -openTemplatesButton $openTemplatesButton -footLabel $footLabel -currentRegion $currentRegion -currentPlayPoint $currentPlayPoint
})
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
