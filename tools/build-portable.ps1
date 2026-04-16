param(
    [string]$OutputRoot = $(Join-Path (Split-Path -Parent $PSScriptRoot) 'dist')
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$portableRoot = Join-Path $OutputRoot '炸金花助手便携版'
$runtimeDir = Join-Path $projectRoot 'runtime\node'
$bundledNodePath = Join-Path $runtimeDir 'node.exe'

function Ensure-Directory([string]$path) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function Copy-Tree([string]$source, [string]$destination) {
    Ensure-Directory $destination
    Copy-Item -Path (Join-Path $source '*') -Destination $destination -Recurse -Force
}

Ensure-Directory $OutputRoot
Ensure-Directory $portableRoot
Ensure-Directory $runtimeDir

if (-not (Test-Path $bundledNodePath)) {
    $systemNode = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $systemNode) {
        throw '未找到可复制的 node.exe。请先在开发机安装 Node.js，或手动放入 runtime\node\node.exe。'
    }

    Copy-Item $systemNode.Source $bundledNodePath -Force
}

$filesToCopy = @(
    'app.js',
    'cards.js',
    'cmd-game.js',
    'getWinner.js',
    'index.js',
    'package.json',
    'package-lock.json',
    'README.md',
    'screen-card-helper.ps1',
    '屏幕识牌助手.ps1',
    '启动CMD游戏.cmd',
    '启动CMD游戏.vbs',
    '启动屏幕识牌助手.cmd',
    '启动屏幕识牌助手.vbs'
)

foreach ($relativePath in $filesToCopy) {
    $sourcePath = Join-Path $projectRoot $relativePath
    if (Test-Path $sourcePath) {
        Copy-Item $sourcePath (Join-Path $portableRoot $relativePath) -Force
    }
}

$dirsToCopy = @(
    'node_modules',
    'runtime',
    'screen-recognition'
)

foreach ($relativePath in $dirsToCopy) {
    $sourcePath = Join-Path $projectRoot $relativePath
    if (Test-Path $sourcePath) {
        Copy-Tree $sourcePath (Join-Path $portableRoot $relativePath)
    }
}

$readmePath = Join-Path $portableRoot '便携版说明.txt'
@"
双击“启动屏幕识牌助手.vbs”即可直接运行。

这个便携版已经内置：
- Node 运行时
- node_modules 依赖
- 屏幕识牌 UI

目标电脑通常不需要额外安装 Node.js。
如果识牌失败，请检查：
- 模板是否放在 screen-recognition\templates 目录
- 手牌区域和出牌点是否已经设置
"@ | Set-Content -Path $readmePath -Encoding UTF8

Write-Host "便携版已输出到：$portableRoot"
