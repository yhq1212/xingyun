@echo off
chcp 65001 >nul
title 循环下载 · 内存盘一键启动
cd /d "%~dp0"

REM ============================================================================
REM  一键启动：建内存盘(≤2G 文件专用) + 启动 aria2 / loop-helper / AriaNg
REM  效果：下载与删除、以及辅助服务的状态/日志/历史，全在内存完成，物理磁盘(SSD)零写入。
REM  需「以管理员身份运行」（ImDisk 要加载驱动、Defender 排除需管理员）；本脚本会自动提权。
REM
REM  可调：RAM_SIZE 内存盘大小（建议 = 并发文件数 × 2G × 1.1，8G 内存勿超 ~5G）
REM ============================================================================

set "RAM_SIZE=3G"
set "RAM_DRIVE=R:"
set "RAM_DIR=%RAM_DRIVE%\downloads"
set "RAM_WORK=%RAM_DRIVE%\wuliao"

REM ---- 自动提权（若尚未管理员）----
fltmc >nul 2>&1
if errorlevel 1 (
    echo [信息] 需要管理员权限（加载内存盘驱动 + Defender 排除），正在提权...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

REM ---- 依赖检查 ----
where imdisk >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 imdisk。请先安装 ImDisk Toolkit:
    echo         https://sourceforge.net/projects/imdisk-toolkit/  （安装时勾选驱动）
    pause
    exit /b 1
)

REM ---- 建内存盘（已存在则跳过）----
imdisk -l 2>nul | find "%RAM_DRIVE%" >nul
if errorlevel 1 (
    echo [信息] 正在创建内存盘 %RAM_DRIVE% (大小 %RAM_SIZE%)...
    imdisk -a -t vm -s %RAM_SIZE% -m %RAM_DRIVE% -p "/fs:ntfs /q /y"
    if errorlevel 1 (
        echo [错误] 内存盘创建失败，可能驱动未就绪，请重试或以管理员运行。
        pause
        exit /b 1
    )
) else (
    echo [信息] 内存盘 %RAM_DRIVE% 已存在，跳过创建。
)
mkdir "%RAM_DIR%" 2>nul
mkdir "%RAM_WORK%" 2>nul

REM ---- 排除系统对内存盘的扫描/索引（进一步降低开销）----
echo [信息] 正在把 %RAM_DRIVE% 加入 Windows Defender 排除项...
powershell -Command "try { Add-MpPreference -ExclusionPath '%RAM_DRIVE%' -ErrorAction Stop; Write-Host '  Defender 排除已添加' } catch { Write-Host '  Defender 排除跳过(可能已存在或非 Defender)' }" 2>nul
echo [信息] 正在对内存盘目录关闭“内容索引”...
attrib +I "%RAM_DIR%" 2>nul
attrib +I "%RAM_WORK%" 2>nul

REM ---- 设定环境变量并启动 ----
set "ARIA2_DIR=%RAM_DIR%"
set "ARIA2_DISK_CACHE=64M"
set "LOOP_WORK_DIR=%RAM_WORK%"

echo [信息] 下载目录   = %ARIA2_DIR%   (物理零写入)
echo [信息] 辅助工作目录 = %LOOP_WORK_DIR%  (状态/日志/历史零写入)
echo [信息] 即将启动 aria2 / loop-helper / AriaNg ...
echo.
call start.bat
