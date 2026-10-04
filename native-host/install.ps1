#Requires -Version 5.1
<#
.SYNOPSIS
    Registers the YTM Practice Grabber native messaging host with Google Chrome for the
    current user.

.DESCRIPTION
    Run it from this folder once, and again whenever this folder or Python moves:

        powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

    It finds Python 3.8 or newer, writes host.bat and com.jormki.ytm_grabber.json next to this
    script, points HKCU\Software\Google\Chrome\NativeMessagingHosts\com.jormki.ytm_grabber at
    that JSON file, and creates config.json from config.example.json when there is none (an
    existing config.json is never changed). No administrator rights are needed. Restart Chrome
    (or reload the extension) afterwards; uninstall.ps1 undoes it.

.PARAMETER ExtensionId
    The extension's ID as chrome://extensions shows it. The default is the ID that the
    manifest's "key" fixes.

.PARAMETER Python
    The python.exe to use, instead of searching for one (py -3, then python on PATH).
#>
[CmdletBinding()]
param(
    [string]$ExtensionId = 'mengelecikhhdpjdebjpokcmhdkhjobj',
    [string]$Python = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$HostName = 'com.jormki.ytm_grabber'
$Here = $PSScriptRoot
$HostScript = Join-Path $Here 'ytm_grabber_host.py'
$BatPath = Join-Path $Here 'host.bat'
$ManifestPath = Join-Path $Here "$HostName.json"
$ConfigPath = Join-Path $Here 'config.json'
$ExamplePath = Join-Path $Here 'config.example.json'

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    # Set-Content and Out-File -Encoding UTF8 in Windows PowerShell 5 start the file with a byte
    # order mark, which Chrome's JSON reader may reject.
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

function Test-Ascii([string]$Text) {
    return $Text -cmatch '^[\x00-\x7F]*\z'
}

function Get-PythonInfo([string]$Exe, [string[]]$Arguments = @()) {
    # Runs a candidate and asks for its real python.exe and version. The answer is printed as JSON,
    # which escapes every non-ASCII character, so the console code page cannot garble a path under
    # a user name with accented letters on its way back to PowerShell.
    $ErrorActionPreference = 'Continue'  # stderr from a native program must not stop the script
    $code = "import sys,json;print(json.dumps({'exe':sys.executable,'major':sys.version_info[0],'minor':sys.version_info[1]}))"
    try {
        $output = & $Exe @Arguments -c $code 2>$null
        if ($LASTEXITCODE -ne 0 -or $null -eq $output) { return $null }
        $info = (@($output) | Select-Object -Last 1) | ConvertFrom-Json
        $exe = [string]$info.exe
        $major = [int]$info.major
        $minor = [int]$info.minor
    } catch {
        return $null
    }
    if ($major -ne 3 -or $minor -lt 8) {
        Write-Warning "Skipping $exe`: Python $major.$minor is older than 3.8"
        return $null
    }
    if (-not $exe -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $null }
    return $exe
}

function Find-Python {
    if ($Python) {
        $exe = Get-PythonInfo -Exe $Python
        if (-not $exe) { throw "$Python is not a working Python 3.8 or newer." }
        return $exe
    }
    # 1. The py launcher; sys.executable gives the real python.exe behind it.
    if (Get-Command 'py.exe' -CommandType Application -ErrorAction SilentlyContinue) {
        $exe = Get-PythonInfo -Exe 'py.exe' -Arguments @('-3')
        if ($exe) { return $exe }
    }
    # 2. python.exe on PATH, in PATH order like `where.exe python` (but without where.exe's output
    #    passing through the console code page). The Microsoft Store's python.exe in
    #    ...\Microsoft\WindowsApps is a stub that opens the Store.
    foreach ($command in @(Get-Command 'python.exe' -CommandType Application -All -ErrorAction SilentlyContinue)) {
        if ($command.Path -like '*\Microsoft\WindowsApps\*') { continue }
        $exe = Get-PythonInfo -Exe $command.Path
        if ($exe) { return $exe }
    }
    return $null
}

function Find-OnPath([string]$Name) {
    # Like `where.exe <name>`: the first match on PATH, or $null.
    $command = @(Get-Command $Name -CommandType Application -All -ErrorAction SilentlyContinue) | Select-Object -First 1
    if ($command) { return [string]$command.Path }
    return $null
}

function Get-BatchPath([string]$Path) {
    # How host.bat names python.exe. cmd.exe reads a batch file in the console's OEM code page, so
    # a non-ASCII character in host.bat could come out as another one. A path under the user's
    # profile (where conda usually lives, below a user name that may have accented letters) is
    # written as %USERPROFILE%\..., which cmd.exe expands as Unicode when Chrome starts the host.
    # "%" must be doubled in a batch file, even between quotes.
    $profileDir = $env:USERPROFILE
    if (-not (Test-Ascii $Path) -and $profileDir -and
        $Path.StartsWith($profileDir + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $rest = $Path.Substring($profileDir.Length)
        if (Test-Ascii $rest) { return '%USERPROFILE%' + $rest.Replace('%', '%%') }
    }
    return $Path.Replace('%', '%%')
}

function Get-BatchBytes([string]$Text, [string]$PythonExe) {
    # "return ," keeps PowerShell from unrolling the byte array into the pipeline.
    if (Test-Ascii $Text) { return ,([System.Text.Encoding]::ASCII.GetBytes($Text)) }
    # Still non-ASCII (Python outside the profile, in a folder with such a name): write the file in
    # the system's OEM code page, which a new console - the hidden one Chrome starts cmd.exe in -
    # uses, and refuse if the path cannot be written in it. (Not "chcp 65001" with UTF-8: cmd.exe
    # re-reads a batch file as it runs and older versions misread it after a code page change.)
    $codePage = [int](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage' -Name 'OEMCP').OEMCP
    $encoding = [System.Text.Encoding]::GetEncoding($codePage)
    $bytes = $encoding.GetBytes($Text)
    if ($encoding.GetString($bytes) -cne $Text) {
        throw ("The path $PythonExe cannot be written in this system's console code page ($codePage). " +
            'Install Python in a folder whose path has only ASCII letters, or pass -Python with such a python.exe.')
    }
    return ,$bytes
}

function Read-Exactly([System.IO.Stream]$Stream, [int]$Count) {
    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $task = $Stream.ReadAsync($buffer, $offset, $Count - $offset)
        if (-not $task.Wait(30000)) { throw 'The host did not answer within 30 s.' }
        if ($task.Result -le 0) { throw 'The host exited without answering.' }
        $offset += $task.Result
    }
    return ,$buffer
}

function Test-NativeHost {
    # Sends one ping the way Chrome does (cmd.exe /d /s /c running host.bat) and returns the pong.
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $info.Arguments = '/d /s /c ""' + $BatPath + '" chrome-extension://' + $ExtensionId + '/"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($info)
    $stderr = $process.StandardError.ReadToEndAsync()  # read alongside, so that pipe cannot fill
    try {
        try {
            $body = [System.Text.Encoding]::UTF8.GetBytes('{"type":"ping"}')
            $stdin = $process.StandardInput.BaseStream
            $stdin.Write([System.BitConverter]::GetBytes([int32]$body.Length), 0, 4)  # little-endian
            $stdin.Write($body, 0, $body.Length)
            $stdin.Flush()
            $stdout = $process.StandardOutput.BaseStream
            $length = [System.BitConverter]::ToInt32((Read-Exactly $stdout 4), 0)
            $reply = [System.Text.Encoding]::UTF8.GetString((Read-Exactly $stdout $length))
        } catch {
            $message = $_.Exception.Message
            try { $process.StandardInput.Close() } catch { }
            [void]$process.WaitForExit(5000)
            $detail = ''
            if ($stderr.Wait(2000)) { $detail = $stderr.Result.Trim() }
            throw "$message $detail"
        }
        $process.StandardInput.Close()  # end of input: the host exits
        return $reply | ConvertFrom-Json
    } finally {
        if (-not $process.WaitForExit(15000)) { $process.Kill() }
    }
}

# --- Checks -------------------------------------------------------------------------------------

if ($ExtensionId -cnotmatch '^[a-p]{32}\z') {
    throw "Not an extension ID: '$ExtensionId'. It is 32 letters a to p, as chrome://extensions shows it."
}
foreach ($required in @($HostScript, $ExamplePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing $required. Run install.ps1 from the native-host folder of the repository." }
}

$pythonExe = Find-Python
if (-not $pythonExe) {
    throw 'No Python 3.8 or newer found (tried py -3 and python on PATH). Install Python, or pass -Python C:\path\to\python.exe.'
}
Write-Host "Python:   $pythonExe"

# --- host.bat -----------------------------------------------------------------------------------
# Chrome runs it through cmd.exe. Nothing in it may print to stdout, which carries the messages:
# "@echo off" comes first, and Python prints nothing but messages there.

$batText = "@echo off`r`n""$(Get-BatchPath $pythonExe)"" -u ""%~dp0ytm_grabber_host.py"" %*`r`n"
[System.IO.File]::WriteAllBytes($BatPath, [byte[]](Get-BatchBytes $batText $pythonExe))
Write-Host "Wrote     $BatPath"

# --- Host manifest ------------------------------------------------------------------------------

$manifest = [ordered]@{
    name            = $HostName
    description     = 'YTM Practice Grabber: runs yt-dlp for the extension'
    path            = $BatPath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
# ConvertTo-Json escapes the backslashes in the path.
Write-Utf8NoBom $ManifestPath (ConvertTo-Json -InputObject $manifest -Depth 3)
Write-Host "Wrote     $ManifestPath"

# --- Registry -----------------------------------------------------------------------------------

# Registry.SetValue creates the key (and any missing parent) and, with an empty value name, sets
# its default value: what Chrome reads.
$registryName = "HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\$HostName"
[Microsoft.Win32.Registry]::SetValue($registryName, '', $ManifestPath)
if ([Microsoft.Win32.Registry]::GetValue($registryName, '', $null) -cne $ManifestPath) {
    throw "Could not set the default value of $registryName."
}
Write-Host "Registered $registryName"

# --- config.json --------------------------------------------------------------------------------

if (Test-Path -LiteralPath $ConfigPath) {
    Write-Host "Kept      $ConfigPath (an existing config.json is never changed)"
} else {
    $example = Get-Content -LiteralPath $ExamplePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $config = [ordered]@{}
    foreach ($property in $example.PSObject.Properties) {
        $value = $property.Value
        if ($value -is [array]) { $value = @($value | ForEach-Object { [string]$_ }) }  # a plain array for ConvertTo-Json
        $config[$property.Name] = $value
    }
    $ytDlp = Find-OnPath 'yt-dlp.exe'
    if ($ytDlp) {
        $config['ytDlpPath'] = $ytDlp
    } else {
        Write-Warning "yt-dlp.exe is not on PATH: set ytDlpPath in $ConfigPath to its full path."
    }
    $ffmpeg = Find-OnPath 'ffmpeg.exe'
    if ($ffmpeg) {
        $config['ffmpegLocation'] = Split-Path -Parent $ffmpeg
    } else {
        Write-Warning "ffmpeg.exe is not on PATH: set ffmpegLocation in $ConfigPath to its folder (yt-dlp -x needs it)."
    }
    Write-Utf8NoBom $ConfigPath (ConvertTo-Json -InputObject $config -Depth 5)
    Write-Host "Wrote     $ConfigPath"
    Write-Host "          ytDlpPath      = $($config['ytDlpPath'])"
    Write-Host "          ffmpegLocation = $($config['ffmpegLocation'])"
}

# --- Self-test ----------------------------------------------------------------------------------

try {
    $pong = Test-NativeHost
    Write-Host "Test:     host $($pong.hostVersion), yt-dlp $($pong.ytDlpVersion), ffmpeg found: $($pong.ffmpegFound)"
    foreach ($problem in @($pong.problems)) { Write-Warning $problem }
} catch {
    Write-Warning "The host did not answer a test ping: $($_.Exception.Message)"
}

Write-Host ''
Write-Host "Done. Restart Chrome, then use the extension's options page: Test connection."
