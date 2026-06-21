# RxSmart Local Pipeline — use standard Python 3.14 (NOT python3.14t free-threading)
$ErrorActionPreference = "Stop"

$Candidates = @(
    "E:\#PEPSEALSEA\Program File\Python314\python.exe",
    "py -3.14",
    "py -3.12",
    "py -3.11",
    "python"
)

$Python = $null
foreach ($candidate in $Candidates) {
    if ($candidate -match "^py ") {
        try {
            $ver = Invoke-Expression "$candidate -c `"import sys; print(sys.version)`"" 2>$null
            if ($LASTEXITCODE -eq 0 -and $ver -notmatch "free-threading") {
                $Python = $candidate
                break
            }
        } catch { continue }
    } elseif (Test-Path $candidate) {
        $ver = & $candidate -c "import sys; print(sys.version)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $ver -notmatch "free-threading") {
            $Python = $candidate
            break
        }
    }
}

if (-not $Python) {
    Write-Host "ERROR: Need standard CPython 3.11–3.14 (not python3.14t free-threading)." -ForegroundColor Red
    Write-Host "Install from https://www.python.org/downloads/ then run:" -ForegroundColor Yellow
    Write-Host "  pip install -r requirements.txt" -ForegroundColor Yellow
    exit 1
}

Set-Location $PSScriptRoot
Write-Host "Using: $Python" -ForegroundColor Cyan

if ($Python -match "^py ") {
    Invoke-Expression "$Python -m pip install -r requirements.txt -q"
    Invoke-Expression "$Python main.py"
} else {
    & $Python -m pip install -r requirements.txt -q
    & $Python main.py
}
