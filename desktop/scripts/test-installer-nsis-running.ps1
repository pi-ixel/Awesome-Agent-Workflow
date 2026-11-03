$ErrorActionPreference='Stop'
$root=Join-Path $env:TEMP ('aaw-nsis-running-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$makensis=Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
$template=Get-Content (Join-Path $PSScriptRoot '../src-tauri/installer/installer.nsi') -Raw -Encoding UTF8
$function=[regex]::Match($template,'(?ms)^Function AawCheckRunningApp\r?\n.*?^FunctionEnd').Value
if (!$function) { throw 'Native check function not found' }
# No real installation: a marker proves that the check returned.
$source=@'
Unicode true
!include LogicLib.nsh
!include WinMessages.nsh
!include "Win\WinError.nsh"
!include "Win\RestartManager.nsh"
Name "AAW native process test"
OutFile "@ROOT@\check.exe"
RequestExecutionLevel user
!define MAINBINARYNAME "desktop"
!define ERROR_MORE_DATA 234
Var AawStage
Function AawReportStage
  FileOpen $9 "@ROOT@\stage.txt" w
  FileWrite $9 $AawStage
  FileClose $9
FunctionEnd
Function AawWriteLog
  Pop $8
  FileOpen $9 "@ROOT@\test.log" a
  FileSeek $9 0 END
  FileWrite $9 "$8$\r$\n"
  FileClose $9
FunctionEnd
@FUNCTION@
Section
  StrCpy $INSTDIR "@ROOT@"
  Call AawCheckRunningApp
  FileOpen $9 "@ROOT@\continued.txt" w
  FileWrite $9 "passed"
  FileClose $9
SectionEnd
'@
$source=$source.Replace('@ROOT@',$root).Replace('@FUNCTION@',$function)
[IO.File]::WriteAllText((Join-Path $root 'check.nsi'),$source,[Text.UTF8Encoding]::new($true))
& $makensis /V2 (Join-Path $root 'check.nsi')
if($LASTEXITCODE -ne 0){throw 'Native harness compile failed'}
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public static class AawNativePromptTest {
 delegate bool CB(IntPtr h,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumWindows(CB c,IntPtr p);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public static IntPtr Find(uint pid){IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);var cls=new StringBuilder(80);GetClassName(h,cls,80);if(owner==pid&&IsWindowVisible(h)&&cls.ToString()=="#32770")found=h;return true;},IntPtr.Zero);return found;}
}
"@
$blocker=$null;$check=$null
try {
  $check=Start-Process (Join-Path $root 'check.exe') -ArgumentList '/S' -PassThru -WindowStyle Hidden
  if(!$check.WaitForExit(10000) -or $check.ExitCode -ne 0 -or !(Test-Path (Join-Path $root 'continued.txt'))){throw 'No-blocker path failed'}
  Remove-Item -LiteralPath (Join-Path $root 'continued.txt')
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\ping.exe') -Destination (Join-Path $root 'desktop.exe')
  $blocker=Start-Process (Join-Path $root 'desktop.exe') -ArgumentList '-t 127.0.0.1' -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'ping.log')
  $check=Start-Process (Join-Path $root 'check.exe') -ArgumentList '/S' -PassThru -WindowStyle Hidden
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  $dialog=[IntPtr]::Zero
  do { $dialog=[AawNativePromptTest]::Find([uint32]$check.Id);if($dialog -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 100 } while([DateTime]::UtcNow -lt $deadline -and !$check.HasExited)
  if($dialog -eq [IntPtr]::Zero){throw 'Silent backend did not display native prompt'}
  # Cancel only this test installer, never an actual installer or Desktop.
  [void][AawNativePromptTest]::PostMessage($dialog,0x111,[IntPtr]2,[IntPtr]::Zero)
  if(!$check.WaitForExit(10000)){throw 'Cancel did not terminate silent backend'}
  if($check.ExitCode -eq 0 -or (Test-Path (Join-Path $root 'continued.txt'))){throw 'Cancel incorrectly continued installation'}
  if((Get-Content (Join-Path $root 'stage.txt') -Raw) -ne 'cancelled-running'){throw 'Cancel stage missing'}
  if($blocker.HasExited){throw 'Cancel terminated blocker'}
  'PASS: no-blocker continues; /S displays native prompt; cancel stops before install and preserves process'
  # Inject a native shutdown error into ONLY the disposable harness. The real
  # Restart Manager detection, dialogs, retry and installer control flow remain.
  $failureSource=$source.Replace('check.exe','failure.exe').Replace("System::Call 'RSTRTMGR::RmShutdown(p R0, i 0, p 0) i .r0'",'StrCpy $0 5')
  [IO.File]::WriteAllText((Join-Path $root 'failure.nsi'),$failureSource,[Text.UTF8Encoding]::new($true))
  & $makensis /V2 (Join-Path $root 'failure.nsi')
  if($LASTEXITCODE -ne 0){throw 'Failure harness compile failed'}
  $check=Start-Process (Join-Path $root 'failure.exe') -ArgumentList '/S' -PassThru -WindowStyle Hidden
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  do { $dialog=[AawNativePromptTest]::Find([uint32]$check.Id);if($dialog -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 100 } while([DateTime]::UtcNow -lt $deadline)
  if($dialog -eq [IntPtr]::Zero){throw 'Confirmation missing'}
  [void][AawNativePromptTest]::PostMessage($dialog,0x111,[IntPtr]1,[IntPtr]::Zero)
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  do { Start-Sleep -Milliseconds 100; $stage=Get-Content (Join-Path $root 'stage.txt') -Raw; $dialog=[AawNativePromptTest]::Find([uint32]$check.Id) } while(($stage -ne 'close-failed:5' -or $dialog -eq [IntPtr]::Zero) -and [DateTime]::UtcNow -lt $deadline)
  if($stage -ne 'close-failed:5' -or $dialog -eq [IntPtr]::Zero){throw 'Manual-exit failure prompt missing'}
  if($blocker.HasExited){throw 'Failed shutdown terminated blocker'}
  # Simulate manual exit of our disposable ping process, then native Retry.
  if($blocker.Path -ne (Join-Path $root 'desktop.exe')){throw 'Unexpected test process path'}
  Stop-Process -Id $blocker.Id
  [void]$blocker.WaitForExit(5000)
  [void][AawNativePromptTest]::PostMessage($dialog,0x111,[IntPtr]4,[IntPtr]::Zero)
  if(!$check.WaitForExit(10000) -or $check.ExitCode -ne 0 -or !(Test-Path (Join-Path $root 'continued.txt'))){throw 'Retry after manual exit failed'}
  'PASS: native shutdown error shows manual-exit prompt; Retry rechecks and continues after exit'
  "Evidence: $root"
} finally {
  foreach($testProcess in @($check,$blocker)) {
    if($testProcess -and !$testProcess.HasExited -and $testProcess.Path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){Stop-Process -Id $testProcess.Id}
  }
}
