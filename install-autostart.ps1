param(
    [string]$TaskName = "Merlin Worker",
    [string]$WorkerDir = (Split-Path -Parent $MyInvocation.MyCommand.Path),
    [string]$UserId = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = "Stop"

$startScript = Join-Path $WorkerDir "start-merlin-worker.cmd"
if (-not (Test-Path -LiteralPath $startScript)) {
    throw "start-merlin-worker.cmd not found at $startScript"
}

$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$startScript`"" `
    -WorkingDirectory $WorkerDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal `
    -UserId $UserId `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host "Scheduled task '$TaskName' installed for user $UserId."
Write-Host "It will start merlin-worker at user logon and restart it if it exits."
Write-Host "Important: Steam ticket generation depends on the logged-in Windows user session."
Write-Host "If you need it immediately after VPS boot, configure Windows auto-logon for this same user."
