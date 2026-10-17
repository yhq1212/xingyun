@echo off
chcp 65001 >nul
title 创建内存盘（循环下载零磁盘写入）
cd /d "%~dp0"

REM ============================================================================
REM  适用前提：下载文件均 ≤ 2G（由用户约定）。在 8G 内存机器上，把下载目录放进
REM  内存盘后，循环下载/删除全在内存完成，物理磁盘（SSD）零写入、零磨损。
REM
REM  内存盘大小建议 = 并发文件数 × 2G × 1.1：
REM    1 个文件并发 → 2.5G；  2 个文件并发(默认 independent) → 4.4G；  更多则按比例加
REM  8G 内存请勿超过 ~5G（需给系统留约 3G）。
REM
REM  依赖：ImDisk Toolkit（免费）。未安装会提示下载地址。首次需「以管理员身份运行」
REM        以便加载内核驱动。
REM ============================================================================

set "RAM_SIZE=3G"
set "RAM_DRIVE=R:"
set "RAM_DIR=%RAM_DRIVE%\downloads"

where imdisk >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 imdisk 命令。
    echo         请先安装 ImDisk Toolkit: https://sourceforge.net/projects/imdisk-toolkit/
    echo         安装时勾选「RAM Disk 支持 / 驱动」。
    pause
    exit /b 1
)

echo [信息] 正在创建内存盘 %RAM_DRIVE% (大小 %RAM_SIZE%)，需管理员权限加载驱动...
imdisk -a -t vm -s %RAM_SIZE% -m %RAM_DRIVE% -p "/fs:ntfs /q /y"
if errorlevel 1 (
    echo [错误] 创建失败。请确认「以管理员身份运行」本脚本（ImDisk 需加载驱动）。
    pause
    exit /b 1
)

mkdir "%RAM_DIR%" 2>nul
echo.
echo ==========================================================
echo  内存盘已就绪: %RAM_DIR%
echo  用法（二选一）:
echo    1) 命令行:  set ARIA2_DIR=%RAM_DIR%  然后运行 start.bat
echo    2) 面板:    循环下载 → 第2步「下载目录」填  %RAM_DIR%
echo  注意: 内存盘重启/关机后清空，每次开机需重跑本脚本。
echo ==========================================================
echo.
pause
