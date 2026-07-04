# RxSmart Local Pipeline - standard Python only (NOT python3.14t)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$PythonExe = $null
$PyTag = $null

$DirectPath = "E:\#PEPSEALSEA\Program File\Python314\python.exe"
if (Test-Path $DirectPath) {
    $ver = & $DirectPath -c "import sys; print(sys.version)"
    if ($ver -notmatch "free-threading") {
        $PythonExe = $DirectPath
    }
}

if (-not $PythonExe) {
    foreach ($tag in @("-3.14", "-3.12", "-3.11")) {
        $ver = & py $tag -c "import sys; print(sys.version)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $ver -notmatch "free-threading") {
            $PythonExe = "py"
            $PyTag = $tag
            break
        }
    }
}

if (-not $PythonExe) {
    Write-Host "ERROR: Need standard CPython 3.11-3.14 (not python3.14t free-threading)." -ForegroundColor Red
    Write-Host "Or run directly:" -ForegroundColor Yellow
    Write-Host '  & "E:\#PEPSEALSEA\Program File\Python314\python.exe" main.py' -ForegroundColor Yellow
    exit 1
}

if ($PythonExe -eq "py") {
    Write-Host "Using: py $PyTag" -ForegroundColor Cyan
    & py $PyTag -m pip install -r requirements.txt -q
    & py $PyTag main.py
} else {
    Write-Host "Using: $PythonExe" -ForegroundColor Cyan
    & $PythonExe -m pip install -r requirements.txt -q
    & $PythonExe main.py
}
