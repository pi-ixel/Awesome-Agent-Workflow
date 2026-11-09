param(
  [int]$ParentPid,
  [string]$Installer,
  [string]$Destination,
  [string]$Executable,
  [string]$Ready,
  [string]$Log,
  [string]$ExpectedSha256
)
$ErrorActionPreference = 'Stop'
function Write-UpdateLog([string]$Message) {
  Add-Content -LiteralPath $Log -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

function Get-InstallerSha256 {
  # The updater can inherit a PowerShell module path from a different host.
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($Installer)
    try {
      return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha256.Dispose()
  }
}

function Show-UpdateFailure([string]$Failure) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object Windows.Forms.Form
  $form.Text = 'AAW Desktop 更新'
  $form.ClientSize = New-Object Drawing.Size(520, 246)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.BackColor = [Drawing.Color]::FromArgb(24,24,24)
  $form.ForeColor = [Drawing.Color]::FromArgb(245,245,245)
  $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
  $form.Tag = 'Close'
  try { $form.Icon = [Drawing.Icon]::ExtractAssociatedIcon($Installer) } catch {}
  $heading = New-Object Windows.Forms.Label
  $heading.Text = '更新未完成'
  $heading.Font = New-Object Drawing.Font('Microsoft YaHei UI', 16, [Drawing.FontStyle]::Bold)
  $heading.ForeColor = [Drawing.Color]::FromArgb(239,178,169)
  $heading.SetBounds(24,24,472,36)
  $form.Controls.Add($heading)
  $description = New-Object Windows.Forms.Label
  $description.Text = "请重试，或打开日志查看原因。`n$Failure"
  $description.SetBounds(24,76,472,95)
  $description.ForeColor = [Drawing.Color]::FromArgb(181,181,181)
  $form.Controls.Add($description)
  $logs = New-Object Windows.Forms.Button
  $logs.Text = '查看日志'
  $logs.FlatStyle = 'Flat'
  $logs.SetBounds(24,194,100,32)
  $logs.Add_Click({ Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $Log + '"') })
  $form.Controls.Add($logs)
  $close = New-Object Windows.Forms.Button
  $close.Text = '关闭'
  $close.FlatStyle = 'Flat'
  $close.SetBounds(280,194,100,32)
  $close.Add_Click({ $form.Close() })
  $form.Controls.Add($close)
  $retry = New-Object Windows.Forms.Button
  $retry.Text = '重试'
  $retry.FlatStyle = 'Flat'
  $retry.UseVisualStyleBackColor = $false
  $retry.BackColor = [Drawing.Color]::FromArgb(245,245,245)
  $retry.ForeColor = [Drawing.Color]::FromArgb(23,23,23)
  $retry.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(245,245,245)
  $retry.FlatAppearance.MouseOverBackColor = [Drawing.Color]::White
  $retry.FlatAppearance.MouseDownBackColor = [Drawing.Color]::FromArgb(220,220,220)
  $retry.SetBounds(392,194,104,32)
  $retry.Add_Click({ $form.Tag = 'Retry'; $form.Close() })
  $form.Controls.Add($retry)
  foreach ($button in @($logs, $close)) {
    $button.UseVisualStyleBackColor = $false
    $button.BackColor = [Drawing.Color]::FromArgb(34,34,34)
    $button.ForeColor = [Drawing.Color]::FromArgb(245,245,245)
    $button.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(60,60,60)
    $button.FlatAppearance.MouseOverBackColor = [Drawing.Color]::FromArgb(48,48,48)
    $button.FlatAppearance.MouseDownBackColor = [Drawing.Color]::FromArgb(60,60,60)
  }
  $form.AcceptButton = $retry
  $form.CancelButton = $close
  $null = $form.ShowDialog()
  $result = $form.Tag
  $form.Dispose()
  return $result
}

$parentProcess = $null
$installed = $false
$started = $null
try {
  $parentProcess = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if ($parentProcess) { $null = $parentProcess.Handle }
  Write-UpdateLog 'Update helper ready; waiting for Desktop to exit.'
  [IO.File]::WriteAllText($Ready, 'ready')
  while ($true) {
    try {
      if ($parentProcess -and -not $parentProcess.WaitForExit(60000)) {
        throw '应用尚未退出，未开始安装。请关闭应用后重试。'
      }
      if (!$installed) {
        if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
          (Get-InstallerSha256) -ne $ExpectedSha256) {
          throw '安装包校验失败，请重新下载更新。'
        }
        # /D must be last and unquoted. The helper alone owns restart (no /R).
        Write-UpdateLog 'Starting verified installer.'
        $setup = Start-Process -FilePath $Installer -ArgumentList "/P /UPDATE /D=$Destination" -PassThru
        $setup.WaitForExit()
        Write-UpdateLog "Installer exit code: $($setup.ExitCode)"
        if ($setup.ExitCode -ne 0) { throw "安装未完成（退出码 $($setup.ExitCode)）。" }
        $installed = $true
      }
      if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
        $installed = $false
        throw '未找到安装后的程序，请重试安装。'
      }
      if (!$started -or $started.HasExited) {
        $started = Start-Process -FilePath $Executable -WorkingDirectory $Destination -PassThru
      }
      if (-not $started.WaitForInputIdle(30000)) { throw '安装已完成，但应用启动超时。' }
      $started.Refresh()
      if ($started.HasExited) { throw '安装已完成，但应用启动后退出。' }
      Write-UpdateLog "Desktop started; process $($started.Id) is accepting input."
      break
    } catch {
      $failure = $_.Exception.Message
      Write-UpdateLog "FAILED: $failure"
      if ((Show-UpdateFailure $failure) -ne 'Retry') { break }
    }
  }
} catch {
  $failure = $_.Exception.Message
  Write-UpdateLog "FAILED: $failure"
  # Restore access to the old application when the installer failed before replacing it.
  if ((!$parentProcess -or $parentProcess.HasExited) -and (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    Start-Process -FilePath $Executable -WorkingDirectory $Destination
  }
  $null = Show-UpdateFailure $failure
  exit 1
} finally {
  if (Test-Path -LiteralPath $Ready) { Remove-Item -LiteralPath $Ready -Force }
}
