/**
 * AriaNg 循环下载辅助服务 (loop-helper)
 *
 * 为什么需要它：
 *   AriaNg 是纯浏览器前端，受沙箱限制，无法直接删除本机文件、也无法关机/休眠。
 *   本服务运行在用户本机，负责三件事：
 *     1) 循环下载引擎：调用 aria2 JSON-RPC 反复添加/完成/删除同一(批)下载；
 *     2) 下载完成后删除本地文件（浏览器做不到）；
 *     3) 全部结束后执行“自动关机/休眠/注销/关闭 aria2”等收尾动作。
 *   AriaNg 网页只作为一个“配置 + 监控面板”通过 REST 与本服务通信。
 *
 * 依赖：Node.js 内置模块，零第三方依赖。
 * 启动：node server.js   （或双击项目根目录 start.bat）
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const childProcess = require('child_process');
const os = require('os');

// 原生零依赖局域网探测（ping 全段 + 解析 arp）
const lanProbe = require('./lan-probe');

// ===================== 配置（可用环境变量或命令行覆盖） =====================
const config = {
    // 本辅助服务监听端口
    port: parseInt(process.env.HELPER_PORT, 10) || 18888,
    // aria2 RPC 地址
    aria2Host: process.env.ARIA2_HOST || '127.0.0.1',
    aria2Port: parseInt(process.env.ARIA2_PORT, 10) || 6800,
    aria2Secret: process.env.ARIA2_SECRET || '',
    // 允许删除文件的根目录（逗号分隔）。为空时仅允许删除 aria2 任务中回报的文件路径。
    // 强烈建议填写，例如：D:\downloads，防止误删系统文件。
    // 可在网页面板的「安全设置」里可视化修改（写入 helper-settings.json，优先级高于环境变量）。
    allowedRoots: (process.env.ALLOWED_ROOTS || '').split(',').map(s => s.trim()).filter(Boolean),
    // 单次下载的轮询间隔(ms)与超时(ms)。超时 0 表示不超时。
    pollInterval: 1500,
    perDownloadTimeout: parseInt(process.env.PER_DOWNLOAD_TIMEOUT, 10) || 0,
    // 「执行外部脚本」结束动作的最大执行时间(ms)
    scriptTimeout: 300000
};

// 工作目录：高频/会话级文件（状态、历史、日志）默认与 server.js 同目录；
// 若设置 LOOP_WORK_DIR（如内存盘 R:\wuliao），这些文件改写到该目录，
// 使循环运行期间不在物理磁盘(SSD)上产生写操作。
// 配置(loop-config)/白名单(helper-settings)等需持久化的仍留在 __dirname。
const WORK_DIR = process.env.LOOP_WORK_DIR ? path.resolve(process.env.LOOP_WORK_DIR) : __dirname;
if (WORK_DIR !== __dirname) { try { fs.mkdirSync(WORK_DIR, { recursive: true }); } catch (e) { /* 忽略 */ } }

const CONFIG_FILE = path.join(__dirname, 'loop-config.json');
const SETTINGS_FILE = path.join(__dirname, 'helper-settings.json');
const STATE_FILE = path.join(WORK_DIR, 'loop-state.json');     // 已完成轮次（进程重启不丢；机器重启才清）
const HISTORY_FILE = path.join(WORK_DIR, 'loop-history.json'); // 运行历史 / 统计
const LOG_FILE = path.join(WORK_DIR, 'loop-log.txt');          // 运行日志（追加持久化，导出“全部”用）

// ===================== 循环任务状态 =====================
const state = {
    running: false,
    currentIteration: 0,
    maxCount: 0,
    phase: 'idle', // idle | downloading | deleting | waiting | finished | error | stopped
    currentGid: null,
    config: null,
    lastError: null,
    log: [],
    // 当前一轮的任务列表：{ gid, url, name, status, progress, speed, totalLength, completedLength }
    tasks: [],
    startedAt: null,
    finishedAt: null,
    // 已完成轮次（全局累计，重启后从 loop-state.json 恢复，不归零）
    completedRounds: 0,
    // 本次运行累计下载完成的文件完整路径（最多保留 500 条，供「清空全部」删除文件用）
    downloadedFiles: [],
    // 当前运行批次的临时统计（运行结束后写入 history）
    run: null,
    // 历史运行记录（最近 100 条，持久化到 loop-history.json）
    history: [],
    // 局域网避让状态（探测结果实时反映到面板）
    lanActive: false,        // 是否检测到“其他在线设备”
    lanDevices: 0,           // 其他在线设备数量（不含本机/网关）
    lanDetail: []            // 设备明细（IP/MAC），供面板展示
};
const persistedState = loadLoopState();
state.completedRounds = persistedState.completedRounds || 0;
state.downloadedFiles = Array.isArray(persistedState.downloadedFiles) ? persistedState.downloadedFiles : [];
state.history = loadHistory();

function pushLog(level, iteration, event, detail) {
    detail = (detail === undefined || detail === null) ? '' : String(detail);
    if (detail.length > 160) detail = detail.slice(0, 157) + '...';
    const entry = {
        time: new Date().toISOString(),
        level: level,
        iteration: iteration,
        event: event,
        detail: detail
    };
    state.log.push(entry);
    if (state.log.length > 200) state.log.shift();
    const msg = `[loop] ${entry.time} #${iteration || '-'} ${event} ${detail || ''}`;
    if (level === 'error') console.error(msg);
    else console.log(msg);
    appendLogToFile(entry);
}

function formatLogLine(e) {
    return `${e.time} #${e.iteration || '-'} ${e.level} ${e.event} ${e.detail}`;
}

// 异步追加到磁盘日志文件（失败忽略），供导出“全部”日志使用
function appendLogToFile(entry) {
    fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\r\n', () => {});
}

function buildLogText(entries) {
    entries = entries || state.log;
    const head = '# AriaNg 循环下载日志  导出时间: ' + new Date().toLocaleString();
    return [head].concat(entries.map(formatLogLine)).join('\r\n');
}

function buildLogCsv(entries) {
    entries = entries || state.log;
    const esc = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['time', 'iteration', 'level', 'event', 'detail'].map(esc).join(',')];
    for (const e of entries) {
        rows.push([e.time, e.iteration, e.level, e.event, e.detail].map(esc).join(','));
    }
    return '\ufeff' + rows.join('\r\n'); // BOM：让 Excel 正确识别 UTF-8
}

// 读取磁盘上的全部日志条目（JSON 行）；文件不存在时回退到内存
async function readAllLogEntries() {
    try {
        const raw = await fs.promises.readFile(LOG_FILE, 'utf8');
        const lines = raw.split(/\r?\n/).filter(Boolean);
        const arr = [];
        for (const ln of lines) {
            try { arr.push(JSON.parse(ln)); } catch (e) { /* 跳过损坏行 */ }
        }
        return arr;
    } catch (e) {
        return state.log.slice();
    }
}

// ===================== aria2 JSON-RPC 客户端 =====================
function aria2Call(method, params) {
    return new Promise((resolve, reject) => {
        const fullParams = config.aria2Secret
            ? ['token:' + config.aria2Secret].concat(params || [])
            : (params || []);

        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: 'loop-helper',
            method: 'aria2.' + method,
            params: fullParams
        });

        const options = {
            host: config.aria2Host,
            port: config.aria2Port,
            path: '/jsonrpc',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 15000
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) {
                        reject(new Error(json.error.message || 'aria2 error'));
                    } else {
                        resolve(json.result);
                    }
                } catch (e) {
                    reject(new Error('Invalid aria2 response: ' + data));
                }
            });
        });

        req.on('error', (e) => reject(new Error('aria2 request failed: ' + e.message)));
        req.on('timeout', () => { req.destroy(new Error('aria2 request timeout')); });
        req.write(body);
        req.end();
    });
}

function buildAddOptions(loopConfig, allowOut, extra) {
    const options = Object.assign({}, loopConfig.options || {});
    if (extra) Object.assign(options, extra);
    if (loopConfig.dir) options.dir = loopConfig.dir;
    // out 只在「单个任务」时可用：多任务并发时同名会互相覆盖
    if (loopConfig.out && allowOut) options.out = loopConfig.out;
    return options;
}

// ===================== 局域网避让闸门 =====================
// 在“开始一轮下载”之前调用：
//   - 未开启避让 → 直接放行；
//   - 开启且检测到其他设备在线：
//       mode=pause     → 反复等待直到对方离线（返回 proceed:false 表示被停止）；
//       mode=throttle  → 放行，并在 extra 里附加 max-download-limit 限速；
//       mode=ignore    → 放行（仅把探测结果显示在面板，不做任何避让）。
// 探测失败一律“fail-open”：放行且不计为其他设备，避免卡死下载。
async function lanPreDownload(loopConfig) {
    if (!loopConfig.lanCheckEnabled) {
        state.lanActive = false; state.lanDevices = 0; state.lanDetail = [];
        return { proceed: true, extra: {} };
    }
    const intervalMs = (parseInt(loopConfig.lanCheckInterval, 10) || 15) * 1000;
    let scan = null;
    while (state.running) {
        try {
            scan = await lanProbe.scanLan(true);
        } catch (e) {
            scan = { devices: [], others: 0, error: String(e && e.message || e) };
        }
        state.lanActive = (scan.others || 0) > 0;
        state.lanDevices = scan.others || 0;
        state.lanDetail = (scan.devices || []).filter(d => d.ip !== scan.selfIp && d.ip !== scan.gateway);
        if ((scan.others || 0) === 0) break;
        if (loopConfig.lanMode === 'pause') {
            state.phase = 'waiting';
            pushLog('info', state.currentIteration, 'lan-wait',
                '局域网检测到 ' + scan.others + ' 台其他设备在线，暂停下载，等待其离线');
            await sleepInterruptible(intervalMs);
        } else {
            break; // throttle / ignore：直接放行
        }
    }
    if (!state.running) {
        return { proceed: false, extra: {} };
    }
    let extra = {};
    if (scan && scan.others > 0 && loopConfig.lanMode === 'throttle') {
        extra['max-download-limit'] = loopConfig.lanThrottleSpeed || '1M';
    }
    return { proceed: true, extra: extra };
}

function tellStatus(gid) {
    return aria2Call('tellStatus', [gid]);
}

function removeDownloadResult(gid) {
    return aria2Call('removeDownloadResult', [gid]).catch(() => {});
}

function forceRemove(gid) {
    return aria2Call('forceRemove', [gid]).catch(() => {});
}

// ===================== 文件删除（安全校验） =====================
function isPathAllowed(filePath) {
    if (config.allowedRoots.length === 0) {
        // 未配置白名单时，仅允许删除 aria2 任务里回报的路径（已在调用处保证）
        return true;
    }
    const normalized = path.normalize(filePath).toLowerCase();
    return config.allowedRoots.some(root => {
        const r = path.normalize(root).toLowerCase();
        // 仅允许精确匹配目录，或落在目录之内（必须带路径分隔符，避免 "C:\a" 误匹配 "C:\ab\file" 之类前缀）
        return normalized === r || normalized.startsWith(r + path.sep);
    });
}

function deleteFileSafe(filePath) {
    return new Promise((resolve) => {
        if (!isPathAllowed(filePath)) {
            pushLog('error', state.currentIteration, 'delete-skipped',
                '路径不在允许删除范围内: ' + filePath);
            return resolve(false);
        }
        fs.unlink(filePath, (err) => {
            if (err && err.code !== 'ENOENT') {
                pushLog('error', state.currentIteration, 'delete-failed',
                    filePath + ' (' + err.message + ')');
                return resolve(false);
            }
            pushLog('info', state.currentIteration, 'deleted', '已删除 ' + path.basename(filePath));
            resolve(true);
        });
    });
}

async function deleteTaskFiles(gid) {
    try {
        const status = await tellStatus(gid);
        if (!status || !status.files) return;
        for (const f of status.files) {
            if (f.path) await deleteFileSafe(f.path);
        }
    } catch (e) {
        pushLog('error', state.currentIteration, 'delete-error', e.message);
    }
}

// 记录下载完成的文件完整路径（供「清空全部」删除；即使开启完成后删除也记录，尽量删 .aria2 控制文件等残留）
async function trackTaskFiles(gid) {
    try {
        const status = await tellStatus(gid);
        if (!status || !status.files) return;
        for (const f of status.files) {
            if (!f.path) continue;
            if (state.downloadedFiles.indexOf(f.path) < 0) state.downloadedFiles.push(f.path);
        }
        if (state.downloadedFiles.length > 500) {
            state.downloadedFiles.splice(0, state.downloadedFiles.length - 500);
        }
    } catch (e) { /* 忽略 */ }
}

// ===================== 收尾动作 =====================
function execAsync(cmd, options) {
    return new Promise((resolve) => {
        childProcess.exec(cmd, options, (err, stdout, stderr) => {
            resolve({ err: err, stdout: stdout, stderr: stderr });
        });
    });
}

function quoteArg(p) {
    return '"' + String(p).replace(/"/g, '\\"') + '"';
}

// 结束动作：执行外部脚本（.bat / .cmd / .sh / .exe 等），可带参数
async function runEndActionScript(loopConfig) {
    const script = (loopConfig.endActionScript || '').trim();
    if (!script) {
        pushLog('error', state.currentIteration, 'end-action-failed', '未配置外部脚本路径');
        return;
    }

    const args = (loopConfig.endActionScriptArgs || '').trim();
    const cmd = quoteArg(script) + (args ? ' ' + args : '');
    pushLog('info', state.currentIteration, 'end-action', '执行外部脚本: ' + path.basename(script));

    const result = await execAsync(cmd, {
        cwd: path.dirname(script),
        timeout: config.scriptTimeout,
        windowsHide: true
    });

    if (result.err) {
        pushLog('error', state.currentIteration, 'script-failed', result.err.message);
        return;
    }

    const out = (result.stdout || '').trim().replace(/\s+/g, ' ');
    pushLog('info', state.currentIteration, 'script-done', '脚本执行完成' + (out ? ': ' + out : ''));
}

function doEndAction(loopConfig, success) {
    const action = loopConfig.endAction || 'none';
    if (action === 'none') return Promise.resolve();
    if (!success && loopConfig.endActionOnlyOnSuccess) {
        pushLog('info', state.currentIteration, 'end-action-skipped', '仅在成功时执行且本次未成功');
        return Promise.resolve();
    }

    const isWin = process.platform === 'win32';
    let cmd = null;
    if (action === 'shutdown') {
        cmd = isWin ? 'shutdown /s /t 0' : 'shutdown -h now';
    } else if (action === 'hibernate') {
        cmd = isWin ? 'shutdown /h' : 'systemctl hibernate';
    } else if (action === 'sleep') {
        cmd = isWin ? 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0' : 'systemctl suspend';
    } else if (action === 'logout') {
        cmd = isWin ? 'shutdown /l' : 'gnome-session-quit --logout';
    } else if (action === 'script') {
        return runEndActionScript(loopConfig);
    } else if (action === 'close-aria2') {
        pushLog('info', state.currentIteration, 'end-action', '关闭 aria2');
        return aria2Call('shutdown', []).catch(() => {});
    }

    if (!cmd) return Promise.resolve();
    pushLog('info', state.currentIteration, 'end-action', cmd);
    try {
        childProcess.exec(cmd);
    } catch (e) {
        pushLog('error', state.currentIteration, 'end-action-failed', e.message);
    }
    return Promise.resolve();
}

// ===================== 主循环 =====================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 可中断等待：等待期间若循环被停止则提前返回（200ms 粒度），避免停止要等满一个间隔
function sleepInterruptible(ms) {
    const step = 200;
    let elapsed = 0;
    return new Promise(resolve => {
        const tick = () => {
            if (!state.running || elapsed >= ms) return resolve();
            const wait = Math.min(step, ms - elapsed);
            elapsed += wait;
            setTimeout(tick, wait);
        };
        tick();
    });
}

// 把 aria2 的任务状态写回前端可见的 task 对象（进度/速度/文件名）
function refreshTask(task, status) {
    if (!task || !status) return;
    task.status = status.status;
    task.totalLength = parseInt(status.totalLength, 10) || 0;
    task.completedLength = parseInt(status.completedLength, 10) || 0;
    task.speed = parseInt(status.downloadSpeed, 10) || 0;
    task.progress = task.totalLength > 0
        ? Math.min(100, Math.round(task.completedLength * 100 / task.totalLength)) : 0;
    if (status.files && status.files[0] && status.files[0].path) {
        task.name = path.basename(status.files[0].path);
    }
}

async function waitForComplete(task) {
    const gid = task.gid;
    const deadline = config.perDownloadTimeout > 0
        ? Date.now() + config.perDownloadTimeout : 0;
    const maxConsecutiveFails = 3; // 连续失败达到该次数即判定为 aria2 断线（按需求 4.8 暂停并记错误）
    let consecutiveFails = 0;

    while (true) {
        if (!state.running) return { status: 'stopped' };
        try {
            const status = await tellStatus(gid);
            if (!status) return { status: 'removed' };
            consecutiveFails = 0;
            refreshTask(task, status);
            if (status.status === 'complete') return { status: 'complete' };
            if (status.status === 'error' || status.status === 'removed') return { status: status.status };
        } catch (e) {
            // 短暂抖动重试；连续失败达到阈值则判定为 aria2 断线
            consecutiveFails++;
            if (consecutiveFails >= maxConsecutiveFails) {
                pushLog('error', state.currentIteration, 'aria2-disconnected',
                    '无法连接 aria2（已重试 ' + maxConsecutiveFails + ' 次）: ' + e.message);
                return { status: 'disconnected' };
            }
        }
        if (deadline > 0 && Date.now() > deadline) {
            return { status: 'timeout' };
        }
        await sleep(config.pollInterval);
    }
}

// 多链接处理模式：
//   mirror     → 所有链接作为同一个任务的多个来源（镜像，只下一个文件）
//   separate   → 每个链接一个任务，一个下完再下一个
//   concurrent → 每个链接一个任务，同一轮同时下载
function getMultiMode(loopConfig) {
    const m = loopConfig && loopConfig.multiMode;
    if (m === 'mirror' || m === 'separate' || m === 'concurrent' || m === 'independent') return m;
    // 兼容旧配置：只有 concurrent 布尔字段
    return (loopConfig && loopConfig.concurrent) ? 'concurrent' : 'mirror';
}

function newTask(gid, url) {
    return { gid: gid, url: url, name: '', status: 'active', progress: 0, speed: 0, totalLength: 0, completedLength: 0 };
}

// 执行一轮下载，返回 { tasks, results }；extra 为附加的 aria2 选项（如限速）
async function runRound(loopConfig, extra) {
    const urls = [].concat(loopConfig.urls || []);
    const mode = getMultiMode(loopConfig);
    const tasks = [];
    const results = [];

    // 单链接 / 镜像模式：一个任务（可含多个来源）
    if (urls.length === 1 || mode === 'mirror') {
        const gid = await aria2Call('addUri', [urls, buildAddOptions(loopConfig, urls.length === 1, extra)]);
        const t = newTask(gid, urls[0]);
        tasks.push(t);
        state.tasks = tasks;
        state.currentGid = gid;
        results.push(await waitForComplete(t));
        return { tasks: tasks, results: results };
    }

    if (mode === 'concurrent') {
        for (const u of urls) {
            const gid = await aria2Call('addUri', [[u], buildAddOptions(loopConfig, urls.length === 1, extra)]);
            tasks.push(newTask(gid, u));
        }
        state.tasks = tasks;
        state.currentGid = tasks[0].gid;
        const rs = await Promise.all(tasks.map(function (t) { return waitForComplete(t); }));
        return { tasks: tasks, results: rs };
    }

    // separate：顺序逐个下载，前一个失败且需要停止时不再继续
    for (const u of urls) {
        if (!state.running) break;
        const gid = await aria2Call('addUri', [[u], buildAddOptions(loopConfig, urls.length === 1, extra)]);
        const t = newTask(gid, u);
        tasks.push(t);
        state.tasks = tasks;
        state.currentGid = gid;
        const r = await waitForComplete(t);
        results.push(r);
        if (r.status !== 'complete' && loopConfig.stopOnError) break;
    }
    return { tasks: tasks, results: results };
}

// 独立循环模式：每个链接一个 worker，各自「下载 → 完成 → (删除) → 等待 → 重下」，互不等待。
// 谁下完谁就重新开始下一轮，不用等最慢的链接。返回是否全程无错误（用户停止不算错误）。
async function runIndependentLoop(loopConfig) {
    const urls = [].concat(loopConfig.urls || []);
    let success = true;
    const workers = urls.map(u => ({ url: u, iter: 0, task: null }));

    const syncTasks = function () {
        state.tasks = workers.map(w => w.task).filter(Boolean);
    };
    const syncIteration = function () {
        state.currentIteration = Math.max(0, Math.max.apply(null, workers.map(w => w.iter)));
    };
    const shortUrl = function (u) {
        return u.length > 60 ? u.slice(0, 57) + '...' : u;
    };

    const runWorker = async function (w) {
        while (state.running && (loopConfig.maxCount === 0 || w.iter < loopConfig.maxCount)) {
            let gid;
            // 局域网避让闸门：pause 模式会在此等待对方离线；throttle 模式返回限速 extra
            const lan = await lanPreDownload(loopConfig);
            if (!lan.proceed) break; // 等待期间被用户停止
            try {
                gid = await aria2Call('addUri', [[w.url], buildAddOptions(loopConfig, urls.length === 1, lan.extra)]);
            } catch (e) {
                state.lastError = e.message;
                const isConnError = /aria2 request failed|timeout|Invalid aria2 response|ECONNREFUSED|ENOTFOUND/i.test(e.message);
                pushLog('error', w.iter, isConnError ? 'aria2-disconnected' : 'add-failed',
                    '[' + shortUrl(w.url) + '] ' + e.message);
                if (isConnError || loopConfig.stopOnError) {
                    success = false; state.phase = 'error'; state.running = false;
                    break;
                }
                await sleepInterruptible(loopConfig.intervalSeconds * 1000 || 1000);
                continue;
            }

            w.iter++;
            syncIteration();
            pushLog('info', w.iter, 'download-start', '[' + shortUrl(w.url) + '] 开始第 ' + w.iter + ' 次下载');

            const t = newTask(gid, w.url);
            t.round = w.iter;
            w.task = t;
            syncTasks();
            state.currentGid = gid;

            const r = await waitForComplete(t);

            if (r.status === 'complete') {
                if (state.run) {
                    state.run.successRounds++;
                    state.run.totalBytes += (t.completedLength || 0);
                }
                state.completedRounds = (state.completedRounds || 0) + 1;
                await trackTaskFiles(gid);
                saveLoopState();
                pushLog('info', w.iter, 'download-complete',
                    '[' + path.basename(t.name || w.url) + '] 第 ' + w.iter + ' 次完成');
                if (loopConfig.deleteAfterComplete) {
                    state.phase = 'deleting';
                    await deleteTaskFiles(gid);
                    state.phase = 'downloading';
                }
                await removeDownloadResult(gid);
                w.task = null;
                syncTasks();
            } else if (r.status === 'stopped') {
                await forceRemove(gid).catch(() => {});
                await removeDownloadResult(gid).catch(() => {});
                w.task = null;
                syncTasks();
                break;
            } else if (r.status === 'disconnected') {
                state.lastError = 'aria2 连接断开';
                if (state.run) state.run.failedRounds++;
                await forceRemove(gid).catch(() => {});
                await removeDownloadResult(gid).catch(() => {});
                w.task = null;
                syncTasks();
                success = false; state.phase = 'error'; state.running = false;
                break;
            } else {
                // timeout / error / removed
                state.lastError = 'status=' + r.status;
                if (state.run) state.run.failedRounds++;
                pushLog('error', w.iter, 'download-failed',
                    '[' + path.basename(t.name || w.url) + '] 第 ' + w.iter + ' 次失败: ' + r.status);
                await forceRemove(gid).catch(() => {});
                await removeDownloadResult(gid).catch(() => {});
                w.task = null;
                syncTasks();
                if (loopConfig.stopOnError) {
                    success = false; state.phase = 'error'; state.running = false;
                    break;
                }
            }

            // 本链接下一轮前的等待（可被停止打断）
            if (state.running && (loopConfig.maxCount === 0 || w.iter < loopConfig.maxCount)) {
                let delay = (loopConfig.intervalSeconds || 0) * 1000;
                if (loopConfig.randomDelay) {
                    delay = Math.floor(delay * (0.5 + Math.random()));
                }
                if (delay > 0) await sleepInterruptible(delay);
            }
        }
    };

    state.phase = 'downloading';
    await Promise.all(workers.map(runWorker));
    return success;
}

async function runLoop(loopConfig) {
    // 归一化局域网避让配置（容错旧配置 / 缺省）
    loopConfig.lanCheckEnabled = !!loopConfig.lanCheckEnabled;
    loopConfig.lanMode = ['pause', 'throttle', 'ignore'].indexOf(loopConfig.lanMode) >= 0 ? loopConfig.lanMode : 'pause';
    loopConfig.lanThrottleSpeed = String(loopConfig.lanThrottleSpeed || '1M');
    loopConfig.lanCheckInterval = parseInt(loopConfig.lanCheckInterval, 10) || 15;

    state.running = true;
    state.config = loopConfig;
    state.currentIteration = 0;
    state.maxCount = loopConfig.maxCount || 0;
    state.lastError = null;
    state.phase = 'downloading';
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    state.tasks = [];
    state.lanActive = false;
    state.lanDevices = 0;
    state.lanDetail = [];

    const totalUrls = (loopConfig.urls || []).length;
    const multiMode = getMultiMode(loopConfig);
    const modeText = totalUrls > 1
        ? (multiMode === 'concurrent' ? '并发' : (multiMode === 'mirror' ? '镜像' : (multiMode === 'independent' ? '独立循环' : '顺序')))
        : '单个';
    pushLog('info', 0, 'loop-start',
        `链接 ${totalUrls} 个（${modeText}），共 ${loopConfig.maxCount === 0 ? '无限' : loopConfig.maxCount} 次，删除=${loopConfig.deleteAfterComplete ? '开' : '关'}，结束动作=${loopConfig.endAction}`);

    // 为本轮运行建立统计对象（结束后写入历史）
    state.run = {
        id: Date.now(),
        startedAt: state.startedAt,
        urlCount: totalUrls,
        maxCount: loopConfig.maxCount,
        deleteAfterComplete: loopConfig.deleteAfterComplete,
        endAction: loopConfig.endAction,
        multiMode: multiMode,
        dir: loopConfig.dir,
        successRounds: 0,
        failedRounds: 0,
        totalBytes: 0
    };

    let success = true;

    while (state.running && (loopConfig.maxCount === 0 || state.currentIteration < loopConfig.maxCount)) {
        // 独立循环模式：每个链接各自反复下载，不走下面的轮次逻辑
        if (totalUrls > 1 && multiMode === 'independent') {
            success = await runIndependentLoop(loopConfig);
            break;
        }
        state.currentIteration++;
        state.phase = 'downloading';
        state.tasks = [];

        // 局域网避让闸门：pause 模式会在此等待对方离线；throttle 模式返回限速 extra
        const lan = await lanPreDownload(loopConfig);
        if (!lan.proceed) break; // 等待期间被用户停止

        pushLog('info', state.currentIteration, 'download-start',
            '开始第 ' + state.currentIteration + ' 次下载' + (totalUrls > 1 ? '（' + totalUrls + ' 个文件）' : ''));

        let tasks;
        let results;
        try {
            const round = await runRound(loopConfig, lan.extra);
            tasks = round.tasks;
            results = round.results;
        } catch (e) {
            state.lastError = e.message;
            const isConnError = /aria2 request failed|timeout|Invalid aria2 response|ECONNREFUSED|ENOTFOUND/i.test(e.message);
            if (isConnError) {
                // 添加任务阶段就无法连接 aria2，按需求 4.8 直接暂停并记错误，等待手动重启
                pushLog('error', state.currentIteration, 'aria2-disconnected', '无法连接 aria2: ' + e.message);
                state.phase = 'error'; success = false;
                break;
            }
            pushLog('error', state.currentIteration, 'add-failed', e.message);
            if (loopConfig.stopOnError) { state.phase = 'error'; success = false; break; }
            await sleep(loopConfig.intervalSeconds * 1000 || 1000);
            continue;
        }

        const failed = results.filter(r => r.status !== 'complete');
        const firstFail = failed.length > 0 ? failed[0].status : null;

        if (failed.length === 0) {
            pushLog('info', state.currentIteration, 'download-complete',
                '第 ' + state.currentIteration + ' 次完成' + (tasks.length > 1 ? '（' + tasks.length + ' 个文件）' : ''));
            if (state.run) {
                state.run.successRounds++;
                for (const t of tasks) state.run.totalBytes += (t.completedLength || 0);
            }
            for (const t of tasks) await trackTaskFiles(t.gid);
            state.completedRounds = (state.completedRounds || 0) + 1;
            saveLoopState();
            if (loopConfig.deleteAfterComplete) {
                state.phase = 'deleting';
                for (const t of tasks) await deleteTaskFiles(t.gid);
            }
        } else if (firstFail === 'timeout') {
            pushLog('error', state.currentIteration, 'download-timeout', '第 ' + state.currentIteration + ' 次超时');
            if (state.run) state.run.failedRounds++;
            if (loopConfig.stopOnError) {
                state.phase = 'error'; success = false;
                for (const t of tasks) { await forceRemove(t.gid); await removeDownloadResult(t.gid); }
                break;
            }
        } else if (firstFail === 'stopped') {
            // 用户手动停止：不记为失败，清理当前任务后退出（phase/endReason 在循环末尾统一置为 stopped）
            for (const t of tasks) { await forceRemove(t.gid).catch(() => {}); await removeDownloadResult(t.gid).catch(() => {}); }
            break;
        } else if (firstFail === 'disconnected') {
            // aria2 断线：按需求 4.8 暂停并记错误，清理任务，等待用户手动重启
            state.lastError = 'aria2 连接断开';
            if (state.run) state.run.failedRounds++;
            state.phase = 'error'; success = false;
            for (const t of tasks) { await forceRemove(t.gid).catch(() => {}); await removeDownloadResult(t.gid).catch(() => {}); }
            break;
        } else {
            // error / removed
            state.lastError = 'status=' + firstFail;
            if (state.run) state.run.failedRounds++;
            pushLog('error', state.currentIteration, 'download-failed',
                '第 ' + state.currentIteration + ' 次失败: ' + firstFail +
                (failed.length > 1 ? '（' + failed.length + '/' + tasks.length + ' 个失败）' : ''));
            if (loopConfig.stopOnError) {
                state.phase = 'error'; success = false;
                for (const t of tasks) await removeDownloadResult(t.gid);
                break;
            }
        }

        for (const t of tasks) await removeDownloadResult(t.gid).catch(() => {});

        if (state.running && (loopConfig.maxCount === 0 || state.currentIteration < loopConfig.maxCount)) {
            let delay = (loopConfig.intervalSeconds || 0) * 1000;
            if (loopConfig.randomDelay) {
                delay = Math.floor(delay * (0.5 + Math.random()));
            }
            if (delay > 0) {
                state.phase = 'waiting';
                pushLog('info', state.currentIteration, 'waiting', '等待 ' + (delay / 1000) + ' 秒后进行下一次');
                await sleepInterruptible(delay);
            }
        }
    }

    let endReason = 'finished';
    if (!state.running) {
        if (!success) {
            // 独立循环模式下某个 worker 出错把 running 置 false：按错误收尾，而不是“用户停止”
            state.phase = 'error';
            pushLog('error', state.currentIteration, 'loop-finished', '循环因错误提前结束（已尝试 ' + state.currentIteration + ' 次）');
            endReason = 'error';
        } else {
            state.phase = 'stopped';
            pushLog('info', state.currentIteration, 'loop-stopped', '已被用户停止');
            endReason = 'stopped';
        }
    } else {
        state.running = false;
        if (!success) {
            state.phase = 'error';
            pushLog('error', state.currentIteration, 'loop-finished', '循环因错误提前结束（已尝试 ' + state.currentIteration + ' 次）');
            endReason = 'error';
        } else {
            state.phase = 'finished';
            pushLog('info', state.currentIteration, 'loop-finished', '循环结束，共 ' + state.currentIteration + ' 次');
            endReason = 'finished';
        }
        state.finishedAt = new Date().toISOString();
        await doEndAction(loopConfig, success);
    }
    finalizeRun(success, endReason);
    state.currentGid = null;
}

// ===================== 配置持久化 =====================
function loadConfigFile() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        return null;
    }
}

function saveConfigFile(cfg) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    } catch (e) {
        pushLog('error', 0, 'config-save-failed', e.message);
    }
}

// ===================== 辅助服务设置（可在页面可视化修改） =====================
function loadSettingsFile() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {
        return null;
    }
}

function saveSettingsFile(s) {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
        return true;
    } catch (e) {
        pushLog('error', 0, 'settings-save-failed', e.message);
        return false;
    }
}

function applySettings(s) {
    if (!s) return;
    if (Array.isArray(s.allowedRoots)) {
        config.allowedRoots = s.allowedRoots.map(x => String(x).trim()).filter(Boolean);
    }
}

function getSettings() {
    return { allowedRoots: config.allowedRoots.slice() };
}

// ===================== 已完成轮次 / 历史 持久化 =====================
function loadLoopState() {
    try {
        const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return (o && typeof o === 'object') ? o : {};
    } catch (e) {
        return {};
    }
}

function saveLoopState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            completedRounds: state.completedRounds || 0,
            downloadedFiles: (state.downloadedFiles || []).slice(-500)
        }, null, 2));
    } catch (e) { /* 忽略写入失败 */ }
}

function loadHistory() {
    try {
        const a = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        return Array.isArray(a) ? a : [];
    } catch (e) {
        return [];
    }
}

function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(state.history.slice(0, 100), null, 2));
    } catch (e) { /* 忽略写入失败 */ }
}

function computeHistoryStats(history) {
    const s = { runs: 0, rounds: 0, success: 0, failed: 0, bytes: 0, durationMs: 0 };
    for (const h of history) {
        s.runs++;
        s.rounds += (h.successRounds || 0) + (h.failedRounds || 0);
        s.success += h.successRounds || 0;
        s.failed += h.failedRounds || 0;
        s.bytes += h.totalBytes || 0;
        s.durationMs += h.durationMs || 0;
    }
    return s;
}

// 统计：基于已完成历史记录，并实时并入“正在进行的这一轮”，使统计卡片在循环进行中也会刷新
function buildLiveStats() {
    const s = computeHistoryStats(state.history);
    if (state.run && state.startedAt) {
        const runSuccess = state.run.successRounds || 0;
        const runFailed = state.run.failedRounds || 0;
        s.runs += 1;
        s.rounds += runSuccess + runFailed;
        s.success += runSuccess;
        s.failed += runFailed;
        s.bytes += state.run.totalBytes || 0;
        s.durationMs += Math.max(0, Date.now() - new Date(state.startedAt).getTime());
    }
    return s;
}

// 把当前这一轮（run）收尾并写入历史
function finalizeRun(success, endReason) {
    const run = state.run;
    if (!run) return;
    run.finishedAt = new Date().toISOString();
    run.durationMs = Math.max(0, Date.now() - new Date(run.startedAt).getTime());
    run.endReason = endReason || (success ? 'finished' : 'error');
    run.completedRounds = state.completedRounds || 0;
    state.history.unshift(run);
    if (state.history.length > 100) state.history.length = 100;
    saveHistory();
    state.run = null;
}

function validateConfig(cfg) {
    if (!cfg || !Array.isArray(cfg.urls) || cfg.urls.length === 0) {
        return 'urls 不能为空';
    }
    if (cfg.deleteAfterComplete && !cfg.dir) {
        return '开启“完成后删除本地文件”时必须指定下载目录 dir';
    }
    if (typeof cfg.maxCount !== 'number' || cfg.maxCount < 0) {
        return 'maxCount 必须是 >=0 的整数（0 表示无限次）';
    }
    if (typeof cfg.intervalSeconds !== 'number' || cfg.intervalSeconds < 0) {
        return 'intervalSeconds 必须是 >=0 的数字';
    }
    if (cfg.multiMode !== undefined && ['mirror', 'separate', 'concurrent', 'independent'].indexOf(cfg.multiMode) < 0) {
        return 'multiMode 只能是 mirror / separate / concurrent / independent';
    }
    if (cfg.lanCheckEnabled) {
        if (['pause', 'throttle', 'ignore'].indexOf(cfg.lanMode) < 0) {
            return 'lanMode 只能是 pause / throttle / ignore';
        }
    }
    if (cfg.endAction === 'script') {
        const script = String(cfg.endActionScript || '').trim();
        if (!script) {
            return '结束动作选择“执行外部脚本”时必须填写脚本路径';
        }
        if (!fs.existsSync(script)) {
            return '找不到外部脚本: ' + script;
        }
    }
    return null;
}

// ===================== HTTP REST 服务 =====================
function sendJson(res, status, obj, origin) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(obj));
}

function sendText(res, status, text, contentType, filename, origin) {
    const headers = {
        'Content-Type': contentType + '; charset=utf-8',
        'Access-Control-Allow-Origin': origin || '*'
    };
    if (filename) {
        headers['Content-Disposition'] = 'attachment; filename="' + filename + '"';
    }
    res.writeHead(status, headers);
    res.end(text);
}

function readBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); }
            catch (e) { resolve({}); }
        });
    });
}

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (req.method === 'OPTIONS') { sendJson(res, 204, {}, origin); return; }

    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
        if (p === '/api/health') {
            sendJson(res, 200, { ok: true, aria2: config.aria2Host + ':' + config.aria2Port }, origin);
            return;
        }

        // 局域网扫描（手动测试用）：返回本机网段内其他在线设备
        if (p === '/api/lan/scan' && req.method === 'GET') {
            try {
                const scan = await lanProbe.scanLan(true);
                sendJson(res, 200, {
                    ok: true,
                    selfIp: scan.selfIp,
                    gateway: scan.gateway,
                    others: scan.others || 0,
                    devices: (scan.devices || []).filter(d => d.ip !== scan.selfIp && d.ip !== scan.gateway)
                }, origin);
            } catch (e) {
                sendJson(res, 200, { ok: false, others: 0, devices: [], error: String(e && e.message || e) }, origin);
            }
            return;
        }

        if (p === '/api/loop/status') {
            const historyView = state.history.slice(0, 50);
            sendJson(res, 200, {
                running: state.running,
                currentIteration: state.currentIteration,
                maxCount: state.maxCount,
                completedRounds: state.completedRounds || 0,
                phase: state.phase,
                currentGid: state.currentGid,
                lastError: state.lastError,
                config: state.config,
                tasks: state.tasks,
                downloadedCount: (state.downloadedFiles || []).length,
                startedAt: state.startedAt,
                finishedAt: state.finishedAt,
                log: state.log.slice(-50),
                history: historyView,
                stats: buildLiveStats(),
                lanActive: state.lanActive,
                lanDevices: state.lanDevices,
                lanDetail: state.lanDetail
            }, origin);
            return;
        }

        if (p === '/api/loop/config' && req.method === 'GET') {
            sendJson(res, 200, loadConfigFile() || {}, origin);
            return;
        }

        if (p === '/api/loop/config' && req.method === 'POST') {
            const body = await readBody(req);
            const err = validateConfig(body);
            if (err) { sendJson(res, 400, { error: err }, origin); return; }
            saveConfigFile(body);
            sendJson(res, 200, { ok: true }, origin);
            return;
        }

        if (p === '/api/loop/start' && req.method === 'POST') {
            if (state.running) {
                sendJson(res, 409, { error: '循环任务已在运行中' }, origin);
                return;
            }
            const body = await readBody(req);
            const err = validateConfig(body);
            if (err) { sendJson(res, 400, { error: err }, origin); return; }
            saveConfigFile(body);
            // 不阻塞：异步执行
            runLoop(body).catch((e) => {
                state.phase = 'error';
                state.lastError = e.message;
                pushLog('error', state.currentIteration, 'loop-crash', e.message);
            });
            sendJson(res, 200, { ok: true, started: true }, origin);
            return;
        }

        if (p === '/api/loop/stop' && req.method === 'POST') {
            if (!state.running) {
                sendJson(res, 200, { ok: true, wasRunning: false }, origin);
                return;
            }
            state.running = false;
            const remove = url.searchParams.get('removeTask') === 'true';
            if (remove) {
                // 遍历本轮所有任务（含并发/多链接），逐个移除，避免残留
                const gids = (state.tasks && state.tasks.length)
                    ? state.tasks.map(t => t.gid)
                    : (state.currentGid ? [state.currentGid] : []);
                for (const gid of gids) {
                    await forceRemove(gid).catch(() => {});
                    await removeDownloadResult(gid).catch(() => {});
                }
            }
            sendJson(res, 200, { ok: true, wasRunning: true }, origin);
            return;
        }

        if (p === '/api/loop/log/clear' && req.method === 'POST') {
            state.log = [];
            try { fs.writeFileSync(LOG_FILE, ''); } catch (e) { /* 忽略 */ }
            sendJson(res, 200, { ok: true }, origin);
            return;
        }

        if (p === '/api/loop/history/clear' && req.method === 'POST') {
            state.history = [];
            saveHistory();
            sendJson(res, 200, { ok: true }, origin);
            return;
        }

        // 清空全部运行痕迹：停止循环 → 删除已下载的文件 → 清空计数 / 历史 / 日志
        if (p === '/api/loop/cleanup' && req.method === 'POST') {
            // 1) 若正在运行，先停止并移除活动任务，等待引擎退出（最多 15 秒）
            if (state.running) {
                state.running = false;
                const gids = (state.tasks && state.tasks.length)
                    ? state.tasks.map(t => t.gid)
                    : (state.currentGid ? [state.currentGid] : []);
                for (const gid of gids) {
                    await forceRemove(gid).catch(() => {});
                    await removeDownloadResult(gid).catch(() => {});
                }
                const deadline = Date.now() + 15000;
                while (state.run && Date.now() < deadline) await sleep(200);
            }

            // 2) 删除本服务记录的已下载文件（含 .aria2 控制文件残留）
            let deleted = 0;
            const files = (state.downloadedFiles || []).slice();
            for (const f of files) {
                if (await deleteFileSafe(f)) deleted++;
                const ctrl = f + '.aria2';
                try {
                    if (fs.existsSync(ctrl) && await deleteFileSafe(ctrl)) deleted++;
                } catch (e) { /* 忽略 */ }
            }

            // 3) 清空计数 / 历史 / 日志 / 任务列表，回到初始状态
            state.completedRounds = 0;
            state.downloadedFiles = [];
            saveLoopState();
            state.history = [];
            saveHistory();
            state.log = [];
            try { fs.writeFileSync(LOG_FILE, ''); } catch (e) { /* 忽略 */ }
            state.tasks = [];
            state.currentGid = null;
            state.currentIteration = 0;
            state.lastError = null;
            state.phase = 'idle';
            state.startedAt = null;
            state.finishedAt = null;
            state.run = null;
            state.lanActive = false;
            state.lanDevices = 0;
            state.lanDetail = [];

            pushLog('info', 0, 'cleanup', '已清空全部运行痕迹（删除文件 ' + deleted + ' 个，计数/历史/日志已重置）');
            sendJson(res, 200, { ok: true, deletedFiles: deleted }, origin);
            return;
        }

        if (p === '/api/helper/settings' && req.method === 'GET') {
            sendJson(res, 200, getSettings(), origin);
            return;
        }

        if (p === '/api/helper/settings' && req.method === 'POST') {
            const body = await readBody(req);
            const roots = Array.isArray(body.allowedRoots) ? body.allowedRoots : [];
            const cleaned = [];
            for (const r of roots) {
                const v = String(r).trim();
                if (!v) continue;
                if (!path.isAbsolute(v)) {
                    sendJson(res, 400, { error: '必须是绝对路径: ' + v }, origin);
                    return;
                }
                if (cleaned.indexOf(v) === -1) cleaned.push(v);
            }
            const updated = Object.assign({}, loadSettingsFile() || {}, { allowedRoots: cleaned });
            if (!saveSettingsFile(updated)) {
                sendJson(res, 500, { error: '设置保存失败' }, origin);
                return;
            }
            applySettings(updated);
            pushLog('info', 0, 'settings-updated',
                '删除白名单已更新为 ' + (cleaned.length ? cleaned.length + ' 个目录' : '无（仅限 aria2 回报路径）'));
            sendJson(res, 200, getSettings(), origin);
            return;
        }

        if (p === '/api/loop/log/export' && req.method === 'GET') {
            const format = (url.searchParams.get('format') || 'txt').toLowerCase();
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const entries = await readAllLogEntries();
            if (format === 'csv') {
                sendText(res, 200, buildLogCsv(entries), 'text/csv', 'loop-log-' + stamp + '.csv', origin);
            } else {
                sendText(res, 200, buildLogText(entries), 'text/plain', 'loop-log-' + stamp + '.txt', origin);
            }
            return;
        }

        if (p === '/api/helper/open-folder' && req.method === 'POST') {
            const body = await readBody(req);
            const target = String(body.path || '').trim();
            if (!target) { sendJson(res, 400, { error: '缺少 path' }, origin); return; }
            if (!fs.existsSync(target)) { sendJson(res, 404, { error: '目录不存在: ' + target }, origin); return; }
            try {
                if (!fs.statSync(target).isDirectory()) {
                    sendJson(res, 400, { error: '不是目录: ' + target }, origin);
                    return;
                }
            } catch (e) {
                sendJson(res, 400, { error: e.message }, origin);
                return;
            }
            const isWin = process.platform === 'win32';
            const cmd = isWin ? 'explorer ' + quoteArg(path.normalize(target))
                : (process.platform === 'darwin' ? 'open ' + quoteArg(target) : 'xdg-open ' + quoteArg(target));
            childProcess.exec(cmd, () => {});
            sendJson(res, 200, { ok: true }, origin);
            return;
        }

        if (p === '/api/helper/shutdown' && req.method === 'POST') {
            const dryRun = url.searchParams.get('dryRun') !== 'false';
            if (dryRun) {
                sendJson(res, 200, { ok: true, dryRun: true, note: '仅记录，不会真正关机' }, origin);
                pushLog('info', 0, 'shutdown-dryrun', '收到关机测试请求（dryRun）');
                return;
            }
            pushLog('info', 0, 'shutdown', '执行关机');
            doEndAction({ endAction: 'shutdown', endActionOnlyOnSuccess: false }, true);
            sendJson(res, 200, { ok: true }, origin);
            return;
        }

        sendJson(res, 404, { error: 'not found' }, origin);
    } catch (e) {
        sendJson(res, 500, { error: e.message }, origin);
    }
});

server.listen(config.port, () => {
    // 页面里保存过的设置优先（helper-settings.json），否则用环境变量 ALLOWED_ROOTS
    applySettings(loadSettingsFile());

    console.log('[loop-helper] 已启动: http://localhost:' + config.port);
    console.log('[loop-helper] aria2 RPC: ' + config.aria2Host + ':' + config.aria2Port +
        (config.aria2Secret ? ' (已设置 secret)' : ' (无 secret)'));
    console.log('[loop-helper] 允许删除根目录: ' + (config.allowedRoots.length ? config.allowedRoots.join(', ') : '(未限制，仅限 aria2 回报路径)'));

    // 自动开启：若上次保存的配置标记了 autoStart，则启动服务时自动开始循环
    const saved = loadConfigFile();
    if (saved && saved.autoStart) {
        console.log('[loop-helper] 检测到 autoStart，自动开始循环任务');
        const err = validateConfig(saved);
        if (!err) {
            runLoop(saved).catch((e) => {
                state.phase = 'error';
                state.lastError = e.message;
                pushLog('error', 0, 'loop-crash', e.message);
            });
        } else {
            console.error('[loop-helper] 自动启动配置无效: ' + err);
        }
    }
});
