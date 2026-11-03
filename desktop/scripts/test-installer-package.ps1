param([Parameter(Mandatory=$true)][string]$RenderedNsi)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $RenderedNsi).Path
$desktopRoot = Split-Path $PSScriptRoot -Parent
$target = [IO.Path]::GetFullPath((Join-Path $desktopRoot 'src-tauri/target'))
if (!$source.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Use a rendered installer under src-tauri/target, never the production template.'
}
$output = Join-Path $target 'installer-package-smoke.exe'
$destination = Join-Path $target 'installer-package-smoke-app'
$fixture = Join-Path (Split-Path $source -Parent) 'installer-package-smoke.nsi'
$restartMarker = Join-Path $target 'installer-package-smoke-restart.txt'
$makensis = Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
$text = Get-Content -LiteralPath $source -Raw
$text = $text.Replace('!define PRODUCTNAME "AAW Desktop"', '!define PRODUCTNAME "AAW Package Smoke"')
$text = $text.Replace('com.aaw.desktop', 'com.aaw.package-smoke')
$text = [regex]::Replace($text, '(?m)^!define OUTFILE .*$', ('!define OUTFILE "' + $output + '"'))
# Exercise legacy /R without launching the user's real Desktop services.
$restartFunction = 'Function RunMainBinary' + "`n" + '  FileOpen $0 "' + $restartMarker + '" w' + "`n" + '  FileWrite $0 "restarted"' + "`n" + '  FileClose $0' + "`n" + 'FunctionEnd'
$text = [regex]::Replace($text, '(?s)Function RunMainBinary\r?\n.*?FunctionEnd', [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $restartFunction })
[IO.File]::WriteAllText($fixture, $text, [Text.UTF8Encoding]::new($true))
& $makensis /V2 $fixture
if ($LASTEXITCODE -ne 0) { throw 'Smoke installer compilation failed' }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Set-Content -LiteralPath (Join-Path $destination 'keep-data.txt') -Value 'preserve-me'
if (Test-Path -LiteralPath $restartMarker) { Remove-Item -LiteralPath $restartMarker }
foreach ($restart in @('', '/R')) {
  $process = Start-Process -FilePath $output -ArgumentList "/P /UPDATE /NS $restart /D=$destination" -PassThru
  if (!$process.WaitForExit(60000)) { throw "Installer did not finish; inspect process $($process.Id)" }
  if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
  if (!(Test-Path -LiteralPath (Join-Path $destination 'desktop.exe'))) { throw 'Missing installed executable' }
  if ((Get-Content -LiteralPath (Join-Path $destination 'keep-data.txt') -Raw).Trim() -ne 'preserve-me') { throw 'User data changed' }
  if ($restart -eq '' -and (Test-Path -LiteralPath $restartMarker)) { throw 'Unexpected setup-owned restart' }
}
if ((Get-Content -LiteralPath $restartMarker -Raw) -ne 'restarted') { throw 'Legacy /R did not restart' }
Write-Output 'PASS: real shared UI, silent backend, repeated overwrite, preserved data, legacy /R and helper-owned restart'
# The fixture has its own product identity, registry key and installation directory.
$uninstall = Start-Process -FilePath (Join-Path $destination 'uninstall.exe') -ArgumentList '/S /UPDATE' -PassThru -Wait
if ($uninstall.ExitCode -ne 0) { throw 'Smoke uninstall failed' }
