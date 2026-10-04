#Requires -Version 5.1
<#
.SYNOPSIS
    Unregisters the YTM Practice Grabber native messaging host (what install.ps1 did).

.DESCRIPTION
        powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 [-RemoveConfig]

    Removes HKCU\Software\Google\Chrome\NativeMessagingHosts\com.jormki.ytm_grabber, the files
    install.ps1 generated next to this script (host.bat, com.jormki.ytm_grabber.json) and the
    host's list of folders it saved audio into (saved-folders.json).
    config.json is kept unless -RemoveConfig is given.

.PARAMETER RemoveConfig
    Also delete config.json.
#>
[CmdletBinding()]
param(
    [switch]$RemoveConfig
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$HostName = 'com.jormki.ytm_grabber'
$RegistryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

if (Test-Path -LiteralPath $RegistryKey) {
    Remove-Item -LiteralPath $RegistryKey -Recurse
    Write-Host "Removed $RegistryKey"
} else {
    Write-Host "Not registered: $RegistryKey does not exist"
}

$names = @('host.bat', "$HostName.json", 'saved-folders.json')
if ($RemoveConfig) { $names += 'config.json' }
foreach ($name in $names) {
    $path = Join-Path $PSScriptRoot $name
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Remove-Item -LiteralPath $path
        Write-Host "Removed $path"
    }
}
if (-not $RemoveConfig -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'config.json'))) {
    Write-Host 'Kept config.json (-RemoveConfig deletes it too)'
}
