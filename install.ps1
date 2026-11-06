# dsh-provider-badge 安装 / 卸载脚本（传统链接方式，可选）
#
# 推荐安装方式：Plugin Manager 的 install_bundle（本包已是 bundle，
# package.json 的 dsh.bundle.patch 指向 cordis.patch.yml）。本脚本面向本地开发、
# 旧版宿主与迁移场景：
#   - 默认只在当前 profile 自己的 node_modules 建 Junction，不复制文件；
#   - 创建失败直接报错（不再静默降级成陈旧副本）；
#   - 追加 / 移除 profile cordis.patch.yml 的 insert 条目：改前备份、写后校验、
#     失败自动回滚；备份只保留最近 5 份；
#   - -Uninstall 同时移除 Junction、patch 条目与 profile package.json 里的 link 依赖。
#
# 用法：
#   pwsh -NoProfile -File .\install.ps1
#   pwsh -NoProfile -File .\install.ps1 -Uninstall
# 可选参数：-ProfileDir <path> -DshHome <path> -LegacyShared
[CmdletBinding()]
param(
  [string]$PluginSource,
  [string]$ProfileDir,
  [string]$DshHome,
  [switch]$LegacyShared,
  [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-OptionalProperty {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function New-Backup {
  param([string]$FilePath, [string]$Tag)
  $backup = "$FilePath.bak-$Tag-" + (Get-Date -Format 'yyyyMMddHHmmssfff')
  Copy-Item -LiteralPath $FilePath -Destination $backup -Force
  $parent = Split-Path -Parent $FilePath
  $leaf = Split-Path -Leaf $FilePath
  Get-ChildItem -LiteralPath $parent -Filter "$leaf.bak-$Tag-*" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 5 |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  return $backup
}

function ConvertTo-NormalizedPath {
  param($Value)
  $text = [string]$Value
  $text = $text.Trim()
  if ($text.StartsWith('\\?\')) { $text = $text.Substring(4) }
  if ($text.StartsWith('Global\', [StringComparison]::OrdinalIgnoreCase)) { $text = $text.Substring(7) }
  if ($text.StartsWith('Local\', [StringComparison]::OrdinalIgnoreCase)) { $text = $text.Substring(6) }
  return $text.TrimEnd([char[]]@('\', '/'))
}

function Test-SameTarget {
  param($Target, [string]$Expected)
  if ($null -eq $Target) { return $false }
  $expectedPath = ConvertTo-NormalizedPath $Expected
  foreach ($item in @($Target)) {
    if ([string]::Equals((ConvertTo-NormalizedPath $item), $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Get-JunctionTargetPath {
  param($Target)
  if ($null -eq $Target) { return $null }
  # ForEach-Object 对单个元素会返回裸字符串，必须再套一层 @() 才稳定是数组（StrictMode 下 .Count 才安全）。
  $paths = @(@($Target) | ForEach-Object { ConvertTo-NormalizedPath $_ })
  if ($paths.Count -eq 0) { return $null }
  return [string]$paths[0]
}

function Get-ProfileBundleState {
  param([string]$ProfileDirPath, [string]$PackageName)
  $manifestPath = Join-Path $ProfileDirPath 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { return $false }
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  } catch {
    return $false
  }
  $dsh = Get-OptionalProperty $manifest 'dsh'
  $profile = Get-OptionalProperty $dsh 'profile'
  $bundles = Get-OptionalProperty $profile 'bundles'
  if ($null -eq $bundles) { return $false }
  foreach ($bundle in @($bundles)) {
    if ([string]$bundle -eq $PackageName) { return $true }
  }
  return $false
}

function New-PluginLink {
  param([string]$NodeModules, [string]$Name, [string]$Source)
  if (-not (Test-Path -LiteralPath $NodeModules)) {
    New-Item -ItemType Directory -Path $NodeModules -Force | Out-Null
  }
  $linkPath = Join-Path $NodeModules $Name
  if (Test-Path -LiteralPath $linkPath) {
    $item = Get-Item -LiteralPath $linkPath -Force
    $linkType = Get-OptionalProperty $item 'LinkType'
    $target = Get-OptionalProperty $item 'Target'
    if ($linkType -eq 'Junction' -and (Test-SameTarget $target $Source)) {
      Write-Host "-> link OK (already exists): $linkPath"
      return $false
    }
    if ($linkType -eq 'Junction') {
      $targetPath = Get-JunctionTargetPath $target
      $dangling = $targetPath -eq $null -or -not (Test-Path -LiteralPath $targetPath)
      if ($dangling) {
        Write-Host "-> 悬空 Junction（目标不存在：$targetPath）→ 删除重建：$linkPath"
        [IO.Directory]::Delete($linkPath)
      } else {
        throw "目标已存在但不是指向本插件的 Junction：$linkPath（请先手动删除再重跑）"
      }
    } else {
      throw "目标已存在且不是 Junction：$linkPath（为避免破坏已有文件，脚本不会删除它）"
    }
  }
  # 用 PowerShell 原生 cmdlet 建 Junction：不经过 cmd 解析，路径含 & % 等字符也安全。
  try {
    New-Item -ItemType Junction -Path $linkPath -Target $Source -ErrorAction Stop | Out-Null
  } catch {
    throw "创建 Junction 失败：$linkPath -> $Source（$($_.Exception.Message)）"
  }
  $created = Get-Item -LiteralPath $linkPath -Force
  $createdType = Get-OptionalProperty $created 'LinkType'
  $createdTarget = Get-OptionalProperty $created 'Target'
  if ($createdType -ne 'Junction' -or -not (Test-SameTarget $createdTarget $Source)) {
    throw "Junction 创建后校验失败：$linkPath"
  }
  Write-Host "-> junction created: $linkPath"
  return $true
}

function Remove-PluginLink {
  param([string]$NodeModules, [string]$Name, [string]$Source)
  $linkPath = Join-Path $NodeModules $Name
  if (-not (Test-Path -LiteralPath $linkPath)) {
    Write-Host "-> link 不存在，跳过：$linkPath"
    return
  }
  $item = Get-Item -LiteralPath $linkPath -Force
  $linkType = Get-OptionalProperty $item 'LinkType'
  $target = Get-OptionalProperty $item 'Target'
  if ($linkType -ne 'Junction') {
    Write-Host "-> 警告：$linkPath 不是 Junction（可能是目录或符号链接），未删除，请手工检查"
    return
  }
  if (-not (Test-SameTarget $target $Source)) {
    Write-Host "-> 警告：$linkPath 指向其它位置，未删除（当前目标：$(@($target) -join ', ')）"
    return
  }
  [IO.Directory]::Delete($linkPath)
  Write-Host "-> junction removed: $linkPath"
}

function Find-PatchEntryLine {
  param([string[]]$Lines, [string]$EntryId)
  for ($i = 0; $i -lt $Lines.Length; $i += 1) {
    $match = [regex]::Match($Lines[$i], '^[ \t]*-[ \t]+id:[ \t]*(?<id>\S+)[ \t]*$')
    if (-not $match.Success) { continue }
    $candidate = $match.Groups['id'].Value.Trim([char[]]@("'", '"'))
    if ($candidate -eq $EntryId) { return $i }
  }
  return -1
}

function Get-PatchEntryCount {
  param([string[]]$Lines, [string]$EntryId)
  $count = 0
  for ($i = 0; $i -lt $Lines.Length; $i += 1) {
    $match = [regex]::Match($Lines[$i], '^[ \t]*-[ \t]+id:[ \t]*(?<id>\S+)[ \t]*$')
    if (-not $match.Success) { continue }
    $candidate = $match.Groups['id'].Value.Trim([char[]]@("'", '"'))
    if ($candidate -eq $EntryId) { $count += 1 }
  }
  return $count
}

# 判断某个 id 条目是否位于顶层 `- insert:` 块内（可以是块内第 2+ 个子项）。
# 返回该块头所在行号；不在 insert 块内返回 -1。
# 顶层条目（行首无缩进）永远不算 insert 子项——例如 `- id: X` + `disabled:` 的 override。
function Find-InsertBlockStart {
  param([string[]]$Lines, [int]$EntryIndex)
  if ($EntryIndex -lt 0 -or $EntryIndex -ge $Lines.Length) { return -1 }
  if ($Lines[$EntryIndex] -notmatch '^\s') { return -1 }
  for ($i = $EntryIndex - 1; $i -ge 0; $i -= 1) {
    $line = $Lines[$i]
    if ($line.Trim().Length -eq 0) { continue }
    if ($line -match '^\s') { continue }
    if ($line.Trim() -eq '- insert:') { return $i }
    return -1
  }
  return -1
}

function Get-PatchRegistrationState {
  param([string]$PatchFile, [string]$EntryId)
  if (-not (Test-Path -LiteralPath $PatchFile)) { return 'absent' }
  $text = [IO.File]::ReadAllText($PatchFile)
  $lines = @($text -split "\r?\n")
  $count = Get-PatchEntryCount -Lines $lines -EntryId $EntryId
  if ($count -eq 0) { return 'absent' }
  if ($count -gt 1) { return 'duplicate' }
  $index = Find-PatchEntryLine -Lines $lines -EntryId $EntryId
  if ((Find-InsertBlockStart -Lines $lines -EntryIndex $index) -ge 0) { return 'registered' }
  return 'conflict'
}

function Install-PatchEntry {
  param([string]$PatchFile, [string]$EntryId, [string]$PackageName)
  $text = ''
  if (Test-Path -LiteralPath $PatchFile) {
    $text = [IO.File]::ReadAllText($PatchFile)
  }
  # 空 YAML 数组标记（[]）不能与追加的块共存，先去掉（只匹配独占一行的 []）。
  $text = [regex]::Replace($text, '(?m)^[ \t]*\[\][ \t]*\r?\n?', '')
  $lines = @($text -split "\r?\n")
  $count = Get-PatchEntryCount -Lines $lines -EntryId $EntryId
  if ($count -gt 1) {
    throw "profile patch 中已存在 $count 个 id: $EntryId 条目，请先手工清理：$PatchFile"
  }
  if ($count -eq 1) {
    $index = Find-PatchEntryLine -Lines $lines -EntryId $EntryId
    if ((Find-InsertBlockStart -Lines $lines -EntryIndex $index) -ge 0) {
      Write-Host "-> already registered in $PatchFile"
      return
    }
    throw "检测到 id: $EntryId 的条目但不在 insert 块中，请手工检查：$PatchFile"
  }

  $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $block = "- insert:$newline    - id: $EntryId$newline      name: '$PackageName'"
  $trimmed = $text.TrimEnd()
  $next = if ($trimmed.Length -eq 0) {
    $block + $newline
  } else {
    $trimmed + $newline + $newline + $block + $newline
  }

  $backup = $null
  if (Test-Path -LiteralPath $PatchFile) {
    $backup = New-Backup -FilePath $PatchFile -Tag 'provider-badge'
  }
  [IO.File]::WriteAllText($PatchFile, $next, [Text.UTF8Encoding]::new($false))

  $verifyLines = @($next -split "\r?\n")
  if ((Get-PatchEntryCount -Lines $verifyLines -EntryId $EntryId) -ne 1) {
    if ($null -ne $backup) { Copy-Item -LiteralPath $backup -Destination $PatchFile -Force }
    throw "写入 profile patch 后校验失败，已回滚：$PatchFile"
  }
  Write-Host "-> registered in $PatchFile"
}

function Uninstall-PatchEntry {
  param([string]$PatchFile, [string]$EntryId)
  if (-not (Test-Path -LiteralPath $PatchFile)) {
    Write-Host "-> patch 不存在，跳过：$PatchFile"
    return
  }
  $text = [IO.File]::ReadAllText($PatchFile)
  $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lines = @($text -split "\r?\n")
  $count = Get-PatchEntryCount -Lines $lines -EntryId $EntryId
  if ($count -eq 0) {
    Write-Host "-> $EntryId 未注册，跳过 patch 清理"
    return
  }
  if ($count -gt 1) {
    throw "profile patch 中存在多个 id: $EntryId 条目，请手工清理：$PatchFile"
  }

  $index = Find-PatchEntryLine -Lines $lines -EntryId $EntryId
  $insertIndex = Find-InsertBlockStart -Lines $lines -EntryIndex $index
  if ($insertIndex -lt 0) {
    throw "id: $EntryId 的条目不在 insert 块中，请手工删除：$PatchFile"
  }

  $blockEnd = $insertIndex + 1
  while ($blockEnd -lt $lines.Length) {
    $line = $lines[$blockEnd]
    if ($line.Trim().Length -ne 0 -and $line -notmatch '^\s') { break }
    $blockEnd += 1
  }

  $childIds = 0
  for ($i = $insertIndex + 1; $i -lt $blockEnd; $i += 1) {
    if ($lines[$i] -match '^\s+-[ \t]+id:') { $childIds += 1 }
  }

  $removeStart = $insertIndex
  $removeEnd = $blockEnd - 1
  if ($childIds -ne 1) {
    # 同一个 insert 块还含其它条目：只删本插件的 id + name 两行。
    $nameLine = $index + 1
    if ($nameLine -gt ($blockEnd - 1) -or $lines[$nameLine] -notmatch '^\s+name:') {
      throw "insert 块包含其它条目，且本条目不是预期的 id + name 两行，请手工删除：$PatchFile"
    }
    if (($nameLine + 1) -lt $blockEnd -and $lines[$nameLine + 1] -match '^\s{6,}\S') {
      throw "本条目还有额外字段，请手工删除：$PatchFile"
    }
    $removeStart = $index
    $removeEnd = $nameLine
  }

  $backup = New-Backup -FilePath $PatchFile -Tag 'provider-badge'
  $kept = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $lines.Length; $i += 1) {
    if ($i -ge $removeStart -and $i -le $removeEnd) { continue }
    $kept.Add($lines[$i])
  }
  $newText = ($kept -join $newline)
  $newText = [regex]::Replace($newText, '(\r?\n){3,}', "$newline$newline")
  if ($newText.Trim().Length -eq 0) {
    # 保持「空 YAML 数组」的合法形态，避免留下空文档。
    $newText = '[]' + $newline
  } elseif (-not $newText.EndsWith("`n")) {
    $newText += $newline
  }
  [IO.File]::WriteAllText($PatchFile, $newText, [Text.UTF8Encoding]::new($false))

  $verifyLines = @($newText -split "\r?\n")
  if ((Get-PatchEntryCount -Lines $verifyLines -EntryId $EntryId) -ne 0) {
    Copy-Item -LiteralPath $backup -Destination $PatchFile -Force
    throw "移除后校验失败，已回滚：$PatchFile"
  }
  Write-Host "-> removed from $PatchFile"
}

function Remove-ProfileDependency {
  param([string]$ProfileDirPath, [string]$PackageName)
  $manifestPath = Join-Path $ProfileDirPath 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { return }
  $text = [IO.File]::ReadAllText($manifestPath)
  $pattern = '(?m)^[ \t]*"' + [regex]::Escape($PackageName) + '"[ \t]*:[ \t]*"link:[^"]*"[ \t]*,?[ \t]*\r?\n?'
  $found = [regex]::Matches($text, $pattern)
  if ($found.Count -eq 0) {
    if ($text -match ('"' + [regex]::Escape($PackageName) + '"\s*:')) {
      Write-Host "-> 注意：profile package.json 中仍有 $PackageName 依赖（非 link 形式），请手工移除：$manifestPath"
    }
    return
  }
  $backup = New-Backup -FilePath $manifestPath -Tag 'provider-badge'
  $newText = [regex]::Replace($text, $pattern, '')
  $newText = [regex]::Replace($newText, ',(\s*[}\]])', '$1')
  try {
    $null = $newText | ConvertFrom-Json
  } catch {
    Copy-Item -LiteralPath $backup -Destination $manifestPath -Force
    throw "移除 link 依赖后 package.json 校验失败，已回滚：$manifestPath"
  }
  [IO.File]::WriteAllText($manifestPath, $newText, [Text.UTF8Encoding]::new($false))
  Write-Host "-> removed link dependency from $manifestPath"
}

# ---- 解析路径与包名 ----
if (-not $DshHome) {
  $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
if (-not $ProfileDir) {
  $desktopProfile = Join-Path $DshHome 'profiles\desktop'
  $ProfileDir = if (Test-Path -LiteralPath $desktopProfile) { $desktopProfile } else { Join-Path $DshHome 'profiles\web' }
}
if (-not $PluginSource) { $PluginSource = $PSScriptRoot }
$PluginSource = (Resolve-Path -LiteralPath $PluginSource).Path.TrimEnd([char[]]@('\', '/'))

if (-not (Test-Path -LiteralPath $ProfileDir)) {
  throw "profile 目录不存在：$ProfileDir"
}
$profilesDir = Split-Path -Parent $ProfileDir

$pkgPath = Join-Path $PluginSource 'package.json'
if (-not (Test-Path -LiteralPath $pkgPath)) { throw "缺少 package.json：$pkgPath" }
$pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
$name = [string](Get-OptionalProperty $pkg 'name')
if (-not $name -or $name -notmatch '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$') {
  throw "package.json 的 name 不合法：$name"
}

$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'

if ($Uninstall) {
  Write-Host "-> plugin : $name"
  Write-Host "-> profile: $ProfileDir"
  if (Get-ProfileBundleState -ProfileDirPath $ProfileDir -PackageName $name) {
    throw "该 profile 已把 $name 列入 dsh.profile.bundles（bundle 安装）。请用 plugin_manager remove_bundle 卸载；若同时残留手工链接，再运行本脚本 -Uninstall 清理。"
  }
  # 卸载要尽量做全：patch 清理失败不应阻断链接与依赖清理（否则留下半卸载状态）。
  $failures = New-Object System.Collections.Generic.List[string]
  try {
    Uninstall-PatchEntry -PatchFile $patchFile -EntryId $name
  } catch {
    $failures.Add("patch: $($_.Exception.Message)")
  }
  try {
    Remove-PluginLink -NodeModules (Join-Path $ProfileDir 'node_modules') -Name $name -Source $PluginSource
  } catch {
    $failures.Add("profile link: $($_.Exception.Message)")
  }
  $sharedModules = Join-Path $profilesDir 'node_modules'
  if (Test-Path -LiteralPath $sharedModules) {
    try {
      Remove-PluginLink -NodeModules $sharedModules -Name $name -Source $PluginSource
    } catch {
      $failures.Add("shared link: $($_.Exception.Message)")
    }
  }
  try {
    Remove-ProfileDependency -ProfileDirPath $ProfileDir -PackageName $name
  } catch {
    $failures.Add("dependency: $($_.Exception.Message)")
  }
  if ($failures.Count -gt 0) {
    throw ("卸载未完全成功：" + ($failures -join '；'))
  }
  Write-Host ''
  Write-Host '卸载完成。还需要的最后一步：重启 DSH，让宿主重新计算插件 bundle。'
  exit 0
}

# ---- 安装前校验包声明 ----
$dsh = Get-OptionalProperty $pkg 'dsh'
$client = Get-OptionalProperty $dsh 'client'
$platform = Get-OptionalProperty $client 'platform'
if ($platform -ne 'web') {
  throw "$name 缺少 dsh.client.platform = web 声明，DSH 客户端不会加载它"
}
$exports = Get-OptionalProperty $pkg 'exports'
if ($null -eq (Get-OptionalProperty $exports './client')) {
  throw "$name 缺少 exports['./client']，客户端模块系统找不到 bundle"
}
$bundle = Get-OptionalProperty $dsh 'bundle'
if ($null -eq (Get-OptionalProperty $bundle 'patch')) {
  Write-Host "-> 提示：package.json 未声明 dsh.bundle.patch，只能走本脚本的传统链接安装"
}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  throw '找不到 node，无法校验插件解析路径（DSH 环境通常自带 node）'
}

Write-Host "-> plugin : $name ($PluginSource)"
Write-Host "-> profile: $ProfileDir"

# ---- 0) 先检查 bundle 双注册与 patch 冲突，避免建了链接才发现无法注册 ----
if (Get-ProfileBundleState -ProfileDirPath $ProfileDir -PackageName $name) {
  throw "该 profile 已把 $name 列入 dsh.profile.bundles（已由 plugin_manager 作为 bundle 安装）。不要再手工注册；升级/卸载请用 plugin_manager。"
}
$registration = Get-PatchRegistrationState -PatchFile $patchFile -EntryId $name
if ($registration -eq 'duplicate') {
  throw "profile patch 中已存在多个 id: $name 条目，请先手工清理：$patchFile"
}
if ($registration -eq 'conflict') {
  throw "检测到 id: $name 的条目但不在 insert 块中，请手工检查：$patchFile"
}

$primaryModules = Join-Path $ProfileDir 'node_modules'
$sharedModules = Join-Path $profilesDir 'node_modules'

# ---- 1) Junction ----
$createdPrimary = New-PluginLink -NodeModules $primaryModules -Name $name -Source $PluginSource
$createdShared = $false
if ($LegacyShared) {
  $createdShared = New-PluginLink -NodeModules $sharedModules -Name $name -Source $PluginSource
}

try {
  # ---- 2) 解析校验：从 profile 目录解析，确认宿主能找到包 ----
  Push-Location -LiteralPath $ProfileDir
  try {
    $resolved = & node -e "process.stdout.write(require.resolve('$name/package.json'))" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $resolved) {
      throw "require.resolve('$name/package.json') 失败——DSH 将无法加载该插件"
    }
    Write-Host "-> resolvable: $resolved"
  } finally {
    Pop-Location
  }

  # ---- 3) 注册到 profile 的 cordis.patch.yml ----
  Install-PatchEntry -PatchFile $patchFile -EntryId $name -PackageName $name
} catch {
  # 注册失败时回滚本次刚建的链接，避免留下半安装状态。
  if ($createdPrimary) { Remove-PluginLink -NodeModules $primaryModules -Name $name -Source $PluginSource }
  if ($createdShared) { Remove-PluginLink -NodeModules $sharedModules -Name $name -Source $PluginSource }
  throw
}

Write-Host ''
Write-Host '安装完成。下一步：'
Write-Host '  1) 重启 DSH（侧栏账户行的「重启」按钮，或完全退出后重新打开）'
Write-Host '  2) 打开任意会话：输入框右下角、模型胶囊左侧应出现供应商灰色胶囊'
Write-Host '注意：'
Write-Host '  - 不要只刷新已打开的页面——宿主启动时才计算插件 bundle 的 rev。'
Write-Host '  - 若已通过 Plugin Manager 安装本 bundle，请勿再运行本脚本，避免同 id 重复注册；'
Write-Host '    迁移时先执行 .\install.ps1 -Uninstall，再用 install_bundle 安装。'
