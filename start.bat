@echo off
chcp 65001 >nul
title AriaNg 循环下载 一键启动
cd /d "%~dp0"

REM ============ 0. 找 Node（若不在 PATH，尝试常见安装路径） ============
where node >nul 2>&1
if not errorlevel 1 goto :node_ok
if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"
where node >nul 2>&1
if errorlevel 1 goto :no_node
:node_ok

REM ============ 1. 准备下载目录 ============
set "DOWNLOAD_DIR=%~dp0downloads"
REM 可用 ARIA2_DIR 覆盖下载目录（如指向内存盘 R:\downloads，实现物理零写入）
REM 约定下载文件均≤2G 时，8G 内存建 3~5G 内存盘最划算（物理零写入）；先用 create-ramdisk.bat 建盘
if not "%ARIA2_DIR%"=="" set "DOWNLOAD_DIR=%ARIA2_DIR%"
if not exist "%DOWNLOAD_DIR%" mkdir "%DOWNLOAD_DIR%"

REM ============ 2. 启动 aria2（开启 RPC） ============
set "ARIA2_EXE=%~dp0aria2-1.37.0-win-64bit-build1\aria2c.exe"
if not exist "%ARIA2_EXE%" goto :no_aria2

echo [信息] 正在启动 aria2 RPC 服务，端口 6800 ...
REM 减少循环下载场景的磁盘反复读写：
REM   --disk-cache        下载数据先缓存到内存再成批刷盘（可用 ARIA2_DISK_CACHE 覆盖，默认 256M）
REM   --file-allocation=none  不预分配磁盘空间，重下时不再先写一遍占位
REM   --auto-save-interval=0  下载过程中不再定时回写 .aria2 控制文件，只在完成时写一次
REM   --remote-time=false     不让 aria2 把服务端时间写回文件 mtime（省一次元数据写）
REM   --summary-interval=0    RPC 模式下不刷进度摘要到控制台
set "DISK_CACHE=256M"
if not "%ARIA2_DISK_CACHE%"=="" set "DISK_CACHE=%ARIA2_DISK_CACHE%"
start "aria2" /d "%DOWNLOAD_DIR%" "%ARIA2_EXE%" --enable-rpc --rpc-listen-port=6800 --rpc-allow-origin-all --continue=true --max-concurrent-downloads=5 --disk-cache=%DISK_CACHE% --file-allocation=none --auto-save-interval=0 --remote-time=false --summary-interval=0

REM ============ 3. 启动 loop-helper 辅助服务 ============
echo [信息] 正在启动 loop-helper 辅助服务，端口 18888 ...
set "HELPER_DIR=%~dp0loop-helper"
start "loop-helper" /d "%HELPER_DIR%" cmd /k "node server.js"

REM 等待服务就绪（用 ping 延时，兼容所有环境；timeout 在输入重定向时会报错）
ping -n 3 127.0.0.1 >nul

REM ============ 4. 打开 AriaNg 页面 ============
echo [信息] 正在打开 AriaNg 页面 ...
start "" "%~dp0index.html"

echo.
echo ==========================================================
echo  AriaNg 循环下载已启动
echo   - aria2  RPC : http://localhost:6800/jsonrpc
echo   - 辅助服务   : http://localhost:18888/api/health
echo   - 下载目录   : %DOWNLOAD_DIR%
echo  请在 AriaNg 左侧打开 Loop Download 面板进行配置
echo ==========================================================
pause
exit /b 0

:no_node
echo [错误] 未检测到 Node.js，请先安装 Node.js 并加入 PATH
echo        下载地址 https://nodejs.org
pause
exit /b 1

:no_aria2
echo [错误] 未找到 aria2c.exe: %ARIA2_EXE%
pause
exit /b 1
