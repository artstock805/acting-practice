# 바탕화면과 시작 메뉴에 '대사 연습 파트너' 아이콘을 만듭니다. 제거: install.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$name = '대사 연습 파트너'
$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) "$name.lnk"),
    (Join-Path ([Environment]::GetFolderPath('Programs')) "$name.lnk")
)

try {
    if ($Uninstall) {
        $targets | Where-Object { Test-Path $_ } | ForEach-Object { Remove-Item $_ }
        $profileDir = Join-Path $env:LOCALAPPDATA 'acting-practice-browser'
        Write-Host "아이콘을 지웠습니다. 앱 창 설정(마이크 권한 등)도 지우려면 이 폴더를 삭제하세요: $profileDir"
        return
    }

    # 인터넷에서 받은 ZIP을 풀면 '차단됨' 표시가 붙어 실행이 막힐 수 있어 해제
    Get-ChildItem $appDir -Recurse -File | Unblock-File

    $shell = New-Object -ComObject WScript.Shell
    foreach ($path in $targets) {
        $lnk = $shell.CreateShortcut($path)
        $lnk.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
        $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $appDir 'launch.ps1')`""
        $lnk.WorkingDirectory = $appDir
        $lnk.IconLocation = "$(Join-Path $appDir 'assets\acting-practice.ico'),0"
        $lnk.WindowStyle = 7
        $lnk.Description = '대본을 넣으면 상대역을 읽어 주고 내 대사를 채점하는 연기 연습 앱'
        $lnk.Save()
    }
    Write-Host "설치 완료: 바탕화면과 시작 메뉴에 '$name' 아이콘을 만들었습니다."
    Write-Host '이 폴더를 옮기면 install.bat 을 다시 실행해 주세요.'
} catch {
    Write-Host "설치 실패: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
