$ErrorActionPreference = 'Stop'
$global:handoffTest_events = [Collections.Generic.List[string]]::new()
$testRoot = Join-Path $PSScriptRoot '../src-tauri/target/helper-test'
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$global:handoffTest_readyPath = Join-Path $testRoot 'ready'
$global:handoffTest_installer = Join-Path $testRoot 'installer.exe'
[IO.File]::WriteAllBytes($global:handoffTest_installer, [Text.Encoding]::ASCII.GetBytes('abc'))
$installerHash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
$global:handoffTest_parent = [pscustomobject]@{Handle=1; HasExited=$false}
$global:handoffTest_parent | Add-Member ScriptMethod WaitForExit { param($timeout) if (!(Test-Path -LiteralPath $global:handoffTest_readyPath)) { throw 'missing acknowledgement before wait' }; $global:handoffTest_events.Add('parent-exited'); $this.HasExited=$true; return $true }
function Get-Process { param($Id, $ErrorAction) return $global:handoffTest_parent }
function Get-FileHash { throw 'Hashing must work without the PowerShell utility module' }
function Start-Process {
 param($FilePath,$ArgumentList,[switch]$PassThru,$WorkingDirectory)
 if ($FilePath -eq $global:handoffTest_installer) {
   if (!$global:handoffTest_parent.HasExited) { throw 'installer launched before parent exit' }
   if ($ArgumentList -ne '/P /UPDATE /D=C:\AAW Desktop') { throw 'incorrect arguments' }
   $global:handoffTest_events.Add('installer-started')
   $fake=[pscustomobject]@{ExitCode=$global:handoffTest_exitCode}
   $global:handoffTest_exitCode = 0
   $fake | Add-Member ScriptMethod WaitForExit { $global:handoffTest_events.Add('installer-finished') }
   return $fake
 }
 $global:handoffTest_events.Add('desktop-restarted')
 $fake = [pscustomobject]@{Id=100; HasExited=$false}
 $fake | Add-Member ScriptMethod WaitForInputIdle { param($timeout) return $true }
 $fake | Add-Member ScriptMethod Refresh {}
 return $fake
}
$exe=Join-Path $testRoot 'desktop.exe'
Set-Content -LiteralPath $exe -Value 'test'
$source = Get-Content "$PSScriptRoot/../src-tauri/src/update_handoff.ps1" -Raw -Encoding UTF8
$scriptPath = Join-Path $testRoot 'handoff-under-test.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw $errors[0] }
$ui = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Show-UpdateFailure' }, $true)
$stub = 'function Show-UpdateFailure { param($Failure) $global:handoffTest_events.Add("failure"); if ($global:handoffTest_retry) { $global:handoffTest_retry = $false; return "Retry" }; return "Close" }'
$source = $source.Substring(0,$ui.Extent.StartOffset) + $stub + $source.Substring($ui.Extent.EndOffset)
[IO.File]::WriteAllText($scriptPath,$source,(New-Object Text.UTF8Encoding($true)))
$global:handoffTest_exitCode = 0
& $scriptPath -ParentPid 1 -Installer $global:handoffTest_installer -Destination 'C:\AAW Desktop' -Executable $exe -Ready $global:handoffTest_readyPath -Log (Join-Path $testRoot 'install.log') -ExpectedSha256 $installerHash
if (($global:handoffTest_events -join ',') -ne 'parent-exited,installer-started,installer-finished,desktop-restarted') { throw 'wrong handoff sequence' }
if (Test-Path -LiteralPath $global:handoffTest_readyPath) { throw 'stale ready file' }
'PASS: acknowledgement, parent exit, installer wait, restart, path with spaces, cleanup'
$global:handoffTest_events.Clear()
& $scriptPath -ParentPid 1 -Installer $global:handoffTest_installer -Destination 'C:\AAW Desktop' -Executable $exe -Ready $global:handoffTest_readyPath -Log (Join-Path $testRoot 'install.log') -ExpectedSha256 ('b' * 64)
if (($global:handoffTest_events -join ',') -ne 'parent-exited,failure') { throw 'tampered package must not run or restart' }
'PASS: failed verification shows failure UI and never starts installer'
$global:handoffTest_events.Clear()
$global:handoffTest_exitCode = 2
$global:handoffTest_retry = $true
& $scriptPath -ParentPid 1 -Installer $global:handoffTest_installer -Destination 'C:\AAW Desktop' -Executable $exe -Ready $global:handoffTest_readyPath -Log (Join-Path $testRoot 'install.log') -ExpectedSha256 $installerHash
if (($global:handoffTest_events -join ',') -ne 'parent-exited,installer-started,installer-finished,failure,parent-exited,installer-started,installer-finished,desktop-restarted') { throw 'retry must wait for installer success before restart' }
'PASS: failed installation can retry; failed attempt never launches Desktop'
