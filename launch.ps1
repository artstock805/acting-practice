# 대사 연습 파트너 실행기 (Windows 10/11, 추가 설치 불필요)
# 1) 내장 PowerShell 서버를 숨김으로 띄우고  2) Edge/Chrome 앱 창으로 연 뒤  3) 창을 닫으면 서버를 끕니다.
# 마이크(음성 인식)는 file:// 에서 막히므로 http://localhost 로 엽니다.
$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$appMarker = 'data-app="acting-practice"'
$ports = 8765..8775   # 저장된 대본은 포트별로 따로 보관되므로 가능하면 8765를 씀

function Test-Port([int]$port) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true } catch { return $false }
}

function Test-OurServer([int]$port) {
    try { return (Invoke-WebRequest "http://localhost:$port/" -UseBasicParsing -TimeoutSec 2).RawContent -match [regex]::Escape($appMarker) } catch { return $false }
}

function Find-Browser {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    return $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

$server = $null
try {
    $port = $ports | Where-Object { (Test-OurServer $_) -or -not (Test-Port $_) } | Select-Object -First 1
    if (-not $port) { throw '사용 가능한 포트(8765~8775)를 찾지 못했습니다.' }
    $url = "http://localhost:$port/"

    if (-not (Test-OurServer $port)) {
        $serve = Join-Path $appDir 'serve.ps1'
        $server = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$serve`"", '-Port', $port -WindowStyle Hidden -PassThru
        $deadline = (Get-Date).AddSeconds(15)
        while (-not (Test-Port $port)) {
            if ($server.HasExited) { throw '로컬 서버가 바로 종료되었습니다. 보안 프로그램이 막고 있는지 확인해 주세요.' }
            if ((Get-Date) -gt $deadline) { throw "로컬 서버가 $port 포트에서 시작되지 않았습니다." }
            Start-Sleep -Milliseconds 200
        }
    }

    $browser = Find-Browser
    if ($browser) {
        # 전용 프로필을 쓰면 브라우저가 별도 프로세스로 떠서, 앱 창을 닫을 때 -Wait 가 끝남
        $profileDir = Join-Path $env:LOCALAPPDATA 'acting-practice-browser'
        Start-Process -FilePath $browser -ArgumentList "--app=$url", "--user-data-dir=`"$profileDir`"", '--window-size=1100,900', '--no-first-run', '--no-default-browser-check' -Wait
    } else {
        # Edge/Chrome이 없으면 기본 브라우저로 열고, 서버는 콘솔 창을 닫을 때까지 유지
        Start-Process $url
        if ($server) { Stop-Process -Id $server.Id -Force; $server = $null }
        & (Join-Path $appDir 'serve.ps1') -Port $port
    }
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show("대사 연습 파트너를 시작하지 못했습니다.`n`n$($_.Exception.Message)", '대사 연습 파트너') | Out-Null
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
