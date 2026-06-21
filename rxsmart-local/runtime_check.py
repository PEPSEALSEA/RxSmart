"""
Preflight checks before importing numpy/opencv (which fail on free-threading builds).
"""
from __future__ import annotations

import sys


def ensure_standard_python() -> None:
    version = sys.version
    exe = sys.executable

    if "free-threading" in version or "free threading" in version.lower():
        print("=" * 60)
        print("  RxSmart — Python interpreter ไม่รองรับ")
        print("=" * 60)
        print()
        print("คุณใช้ python3.14t (free-threading build)")
        print("numpy / opencv ยังไม่มี wheel ที่เข้ากัน → import ล้มเหลว")
        print()
        print("แก้: ใช้ Python มาตรฐาน (ไม่มีตัว t) แทน เช่น")
        print(r'  E:\#PEPSEALSEA\Program File\Python314\python.exe main.py')
        print(r"  หรือ  .\run.ps1")
        print()
        print(f"ตอนนี้รันด้วย: {exe}")
        sys.exit(1)

    major, minor = sys.version_info[:2]
    if (major, minor) < (3, 9):
        print(f"ERROR: ต้องการ Python 3.9+ (ตอนนี้ {major}.{minor})")
        sys.exit(1)
