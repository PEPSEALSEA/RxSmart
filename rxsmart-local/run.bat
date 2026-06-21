@echo off
REM RxSmart — avoid python3.14t (free-threading); numpy/opencv wheels are incompatible
set "PY=E:\#PEPSEALSEA\Program File\Python314\python.exe"
if not exist "%PY%" set "PY=py -3.14"
cd /d "%~dp0"
echo Using Python: %PY%
"%PY%" -m pip install -r requirements.txt -q
"%PY%" main.py
