# 星云压力测试（XingYun Load Test）

> 基于 [AriaNg](https://github.com/mayswind/AriaNg)（aria2 的现代 Web 前端）二次开发，内置「循环下载」功能的下载工具。

> 基于 [AriaNg](https://github.com/mayswind/AriaNg)（aria2 的现代 Web 前端）二次开发，内置「循环下载」功能的下载工具。
>
> 给定一个或多个下载链接，反复下载 N 次；每次下载完成后自动删除本地文件，再继续下一次。支持自动开启（无人值守）、循环次数、完成后自动关机/休眠等控制，并具备实时状态监控、运行日志与统计。

---

## 一、它能做什么（核心特性）

- **循环下载**：下载 → 删除本地文件 → 等待 → 再下载，反复进行，用于带宽/链路压测、CDN 命中验证、无人值守跑批等场景。
- **多链接四种模式**（一行一个链接）：
  - **每个链接独立循环（默认）**：每个链接各自反复下载、互不等待，谁下完谁重下，适合大小文件混合。
  - **顺序下载**：一轮内每个链接各下一次，全部完成后进入下一轮。
  - **并发下载**：同一轮内同时下载多个链接。
  - **镜像来源**：多个链接当作同一文件的多个备用来源，只下一个文件。
- **循环次数**：可设具体次数（N≥1），或设为 `0` 表示「一直跑」直到手动停止。
- **完成后自动删除**：每次下载完成后删除磁盘文件，保证下一次是「全新下载」（否则 aria2 会秒完成）。
- **结束动作**：循环结束后可执行 无 / 关机 / 休眠 / 睡眠 / 注销 / 关闭 aria2 / **执行外部脚本**，并支持「仅成功后才执行」护栏。
- **自动开启**：辅助服务启动时若配置了 `autoStart`，即使不开浏览器也会自动开始（无人值守）。
- **状态监控**：大状态卡实时显示当前阶段、已完成/总次数、当前一轮的下载进度/速度/已用时间、最近错误。
- **运行日志**：每次起止、完成、删除、错误可滚动查看，支持 **TXT / CSV 一键导出**（CSV 带 UTF-8 BOM，Excel 可直接打开）。
- **运行历史与统计**：展示历史记录（时间、成功/失败轮次、下载量、耗时、结束原因）与汇总统计，可一键清空。
- **已完成轮次持久化**：全局计数写入本地文件，辅助服务重启后计数不归零、继续「第 N 次」。
- **删除白名单可视化**：页面内可增删「允许删除的文件夹」，保存后立即生效，防止误删系统盘。
- **一键打开下载文件夹**：直接在资源管理器中打开当前下载目录。
- **局域网避让（LAN Avoidance）**：循环前探测同网段其他在线设备，可三选一——等待对方离线再下载（默认）/ 对方在线时限速下载 / 直接下载仅记录。状态卡实时显示「N 台其他设备在线」。
- **浏览器通知**：循环结束/出错时给出提示。
- **国际化**：面板内置简体中文与英文（**默认英文**），可在「AriaNg 设置 → 语言」切换为简体中文。
- **内存盘「零磁盘写入」支持**：配合 `start-ram.bat` 与 ImDisk，把下载与运行状态放进内存盘，SSD 零磨损（见下文）。

---

## 二、为什么需要一个本地辅助进程（架构要点）

AriaNg 是纯前端网页，**不能直接删除你磁盘上的文件，也不能调用系统关机，且关掉标签页 JS 就停了**。所以「下载完删文件 + 自动关机」这两件事无法只靠网页完成。

为此本项目引入一个运行在本机的轻量辅助服务 **`loop-helper`（Node.js，零第三方依赖）**，由它负责：循环调度、删除文件、执行关机/休眠。AriaNg 网页只作为「配置面板 + 监控台」。

```
┌──────────────────────┐    REST(JSON, 含CORS)    ┌────────────────────────┐
│  浏览器 AriaNg 网页    │ ───────────────────────▶│  本机 loop-helper 服务   │
│  (循环下载面板:配置+监控)│◀─────────────────────── │  (Node.js, 零依赖)        │
└──────────────────────┘     状态/日志轮询(2s)     │ 循环引擎+删文件+关机+REST  │
                                                 └───────────┬────────────┘
                                                            │ aria2 JSON-RPC
                                                            ▼
                                                 ┌────────────────────────┐
                                                 │  aria2c (RPC :6800)     │
                                                 │  实际下载 → 写入磁盘      │
                                                 └────────────────────────┘
```

**关键好处**：引擎在本地，因此「即使关闭浏览器，循环仍继续」，满足自动开启/无人值守；删除与关机仅限本机、受白名单与确认保护。

---

## 三、目录结构

```
xingyun/
├── index.html                 # 预编译好的 AriaNg 单文件（最终给用户打开的）
├── start.bat                  # 一键启动：aria2 + loop-helper + 打开 AriaNg（需本机装 Node）
├── create-ramdisk.bat         # 创建内存盘（循环下载零磁盘写入，需 ImDisk + 管理员）
├── start-ram.bat              # 内存盘一键启动（建盘 + 启动全套服务，需管理员）
├── aria2-1.37.0-win-64bit-build1/  # 自带 aria2 Windows 版（aria2c.exe）
├── loop-helper/               # 本地辅助服务（核心）
│   ├── server.js              # 循环引擎 + 文件删除 + 关机 + REST API
│   ├── lan-probe.js           # 局域网设备探测（os + ping/arp，零依赖）
│   ├── package.json           # 零依赖，仅声明 node>=12
│   ├── loop-config.json       # 运行时生成：保存的循环配置
│   ├── helper-settings.json   # 运行时生成：删除白名单等设置
│   ├── loop-state.json        # 运行时生成：已完成轮次计数 + 已下载文件清单
│   ├── loop-history.json      # 运行时生成：运行历史（最近 100 条）
│   └── loop-log.txt           # 运行日志持久化文件
├── AriaNg-master/             # AriaNg 源码（改完需重新构建）
│   └── src/
│       ├── index.html         # 已加侧边栏「循环下载」入口与脚本登记
│       ├── views/loop-download.html   # 循环下载面板模板
│       ├── scripts/controllers/loop-download.js  # 循环下载控制器
│       └── langs/zh_Hans.txt  # 面板中文词条（[global] 段）
└── downloads/                 # 默认下载目录（首次启动自动创建）
```

---

## 四、快速开始

### 方式一：单文件 EXE 交付（最终用户 / 推荐）

> 把 **aria2c + loop-helper + AriaNg 前端 + Node 运行时** 打包成单个 `星云压力测试.exe`，对方电脑**无需安装任何东西**，双击即用。

1. 把 `星云压力测试.exe` 拷到任意位置，双击运行。
2. 首次自动把内置资源解压到 `<同目录>/_wuliao_runtime/`（含 `aria2c.exe`、`loop-helper/`、`index.html`），并拉起：
   - aria2 RPC：`http://localhost:6800`
   - 辅助服务：`http://localhost:18888`
   - 管理界面：`http://localhost:6688`（自动打开浏览器）
3. 界面**默认英文**；如需中文：进入「AriaNg 设置 → 语言」改为「简体中文」并保存（必要时 `Ctrl+F5` 强刷）。
4. 左侧「Loop / 循环下载」面板配置链接与次数，点「开始」。
5. **关闭 EXE 弹窗 = 停止所有服务**（aria2 与辅助服务一并退出）。

> 解压只需一次，之后启动会复用 `_wuliao_runtime`。

### 方式二：源码 / 开发运行（改过代码时）

需要先安装 [Node.js](https://nodejs.org)（≥12）。双击 `start.bat` 即可一键启动 aria2 + loop-helper 并打开 AriaNg 页面。

手动启动参考（排查问题时用）：

```bat
:: 1) 启动 aria2（开启 RPC，端口 6800）
aria2-1.37.0-win-64bit-build1\aria2c.exe ^
  --enable-rpc --rpc-listen-all=false --rpc-listen-port=6800 ^
  --rpc-allow-origin-all --rpc-secret= --dir="%cd%\downloads" --continue=true

:: 2) 启动辅助服务（可加环境变量）
set HELPER_PORT=18888
set ARIA2_HOST=127.0.0.1
set ARIA2_PORT=6800
set ALLOWED_ROOTS=D:\your\downloads    :: 强烈建议配置删除白名单
cd loop-helper
node server.js
```

辅助服务可用的环境变量：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `HELPER_PORT` | helper 监听端口 | `18888` |
| `ARIA2_HOST` / `ARIA2_PORT` | aria2 RPC 地址 | `127.0.0.1:6800` |
| `ARIA2_SECRET` | 若 aria2 启用了 `--rpc-secret`，在此填写 | 空 |
| `ALLOWED_ROOTS` | 逗号分隔的允许删除根目录（**强烈建议配置**，防误删） | 空（仅删 aria2 回报路径） |
| `PER_DOWNLOAD_TIMEOUT` | 单次下载超时毫秒（`0`=不限，防止卡死） | `0` |
| `ARIA2_DIR` | 覆盖下载目录（可指向内存盘，实现物理零写入） | `./downloads` |

启动后在 AriaNg 左侧应能看到 **Loop / 循环下载** 入口；首次请到「AriaNg 设置」确认 “Loop Download Helper URL = http://localhost:18888”。

---

## 五、功能详解

### 5.1 三步式「小学生也能用」面板

进页面第一眼是大状态卡（图标 + 大号文字 + 进度条 + 速度/已用时间）。配置拆成三步：

1. **粘链接**：粘贴一个或多个下载链接（每行一个）。
2. **选目录**：指定下载目录（开启删除时必填）。
3. **定次数**：给一键预设「只跑 1 次 / 跑 10 次 / 一直跑」，不必理解数字含义。

所有专业选项（并发、随机抖动、出错停止、通知、文件名、结束动作、脚本）收进「更多设置」折叠区；有风险的删除范围单独放「安全设置」。

### 5.2 循环状态机

```
idle →(start)→ downloading →(complete)→ deleting →(还有次数?)→ waiting →(sleep)→ downloading
                                                            └─(否)→ finished →(结束动作)→ idle
stop → stopped（用户停止，不执行结束动作）
```

- 下载完成判定：辅助服务轮询 aria2 `tellStatus` 的 `status`（`complete`/`error`/`removed`），稳健且与前端解耦。
- 删除安全：删除前校验路径必须落在白名单根目录内（或属于 aria2 回报路径），逐个文件删除，忽略「已不存在」错误。
- 同一时间只允许一个循环；已有任务运行时再次「开始」返回 409 拒绝。
- 防止卡死：提供 `PER_DOWNLOAD_TIMEOUT`，长时间卡在 0 速度不会无限等待。

### 5.3 局域网避让

反复下载会占满带宽、拖慢同网段其他设备（家人看视频、同事开会）。开启后，每轮下载前自动探测同网段其他在线设备（纯 Node 内置模块 + 系统 `ping` 全段 + 读 `arp` 表，零依赖；探测失败一律放行，绝不卡下载），可三选一：

- **等待对方离线后再下载（默认推荐）**：检测到其他设备在线就暂停，对方离线后自动恢复。
- **限速下载**：对方在线时给本轮下载附加 `max-download-limit`（默认 `1M`，可改如 `500K`），无人时满速。
- **直接下载（仅记录）**：不做避让，只在状态卡显示「N 台其他设备在线」。

面板里可设检测间隔、点「立即扫描」手动测一次（返回设备 IP/MAC）。

### 5.4 内存盘「零磁盘写入」

循环下载/删除会反复擦写 SSD。提供 `create-ramdisk.bat` / `start-ram.bat`（依赖免费 [ImDisk Toolkit](https://sourceforge.net/projects/imdisk-toolkit/)，需管理员）：把下载目录与辅助服务的工作目录放进内存盘，物理磁盘零写入、零磨损。

- `start-ram.bat`：建内存盘（默认 3G，可改）→ 排除 Defender 扫描与内容索引 → 设定 `ARIA2_DIR` / `LOOP_WORK_DIR` 指向内存盘 → 启动全套服务。
- 约定下载文件均 ≤ 2G 时最划算（内存盘大小建议 = 并发文件数 × 2G × 1.1，8G 内存勿超 ~5G）；内存盘重启/关机后清空，每次开机需重跑脚本。
- 也可手动 `set ARIA2_DIR=R:\downloads` 后运行 `start.bat`。

### 5.5 清空全部运行痕迹

一键「清空全部」：停止循环（等待引擎退出）→ 按已下载文件清单删除文件（含 `.aria2` 残留，逐一过白名单）→ 清零计数、清空历史/日志/任务列表，回到 idle。带确认弹窗。

### 5.6 关机 / 休眠实现（跨平台）

| endAction | Windows | 非 Windows |
| --- | --- | --- |
| shutdown 关机 | `shutdown /s /t 0` | `shutdown -h now` |
| hibernate 休眠 | `shutdown /h` | `systemctl hibernate` |
| sleep 睡眠 | `rundll32 powrprof.dll,SetSuspendState 0,1,0` | `systemctl suspend` |
| logout 注销 | `shutdown /l` | `gnome-session-quit --logout` |
| close-aria2 关 aria2 | aria2 `shutdown` RPC | 同左 |
| script 执行脚本 | 执行指定 `.bat/.cmd/.sh/.exe`（可传参，超时 5 分钟） | 同左 |

仅当循环成功完成，或 `endActionOnlyOnSuccess=false` 时才执行；`dryRun` 模式只记录不执行（先「测试关机」验证）。

---

## 六、REST API 速览（loop-helper）

基础地址：`http://localhost:18888`（可用 `HELPER_PORT` 改）。所有响应为 JSON，支持 CORS（反射请求 Origin，兼容 `file://`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 `{ ok:true, aria2:"host:port" }` |
| GET | `/api/lan/scan` | 手动触发局域网扫描，返回本机网段/网关/其他设备 IP·MAC |
| GET | `/api/loop/status` | 返回运行状态（阶段/次数/进度/速度/日志/局域网设备数…） |
| GET | `/api/loop/config` | 读取已保存的循环配置 |
| POST | `/api/loop/config` | 校验并保存循环配置到 `loop-config.json` |
| POST | `/api/loop/start` | 启动循环（会顺带保存配置；已运行返回 409） |
| POST | `/api/loop/stop?removeTask=true` | 停止；`removeTask=true` 同时移除当前任务 |
| POST | `/api/helper/shutdown?dryRun=true` | 关机验证（`dryRun` 默认仅记录不执行） |
| GET | `/api/loop/log/export?format=txt\|csv` | 导出全部日志（CSV 带 UTF-8 BOM） |
| POST | `/api/loop/log/clear` | 清空内存日志 |
| GET/POST | `/api/helper/settings` | 读取 / 更新删除白名单（立即生效，优先级高于 `ALLOWED_ROOTS` 环境变量） |
| POST | `/api/helper/open-folder` | 在资源管理器中打开目录（Windows `explorer` / macOS `open` / Linux `xdg-open`） |
| POST | `/api/loop/history/clear` | 清空运行历史（保留已完成轮次计数） |
| POST | `/api/loop/cleanup` | 清空全部运行痕迹（停止 + 删文件 + 清计数/历史/日志） |

**配置字段（`loopConfig`）** 关键项：`urls`(链接数组)、`dir`(下载目录)、`out`(可选文件名)、`maxCount`(次数,0=无限)、`intervalSeconds`(间隔秒)、`randomDelay`(随机抖动)、`deleteAfterComplete`(完成后删除)、`stopOnError`(出错停止)、`multiMode`(`independent`/`separate`/`concurrent`/`mirror`)、`endAction`/`endActionScript`/`endActionScriptArgs`/`endActionOnlyOnSuccess`、`notify`、`autoStart`、`lanCheckEnabled`/`lanMode`/`lanThrottleSpeed`/`lanCheckInterval`。

---

## 七、安全注意事项

- **删除白名单**：正式使用前强烈建议配置 `ALLOWED_ROOTS`（或页面「安全设置」），非白名单路径会被拒绝并记录日志（`delete-skipped`）。删除仅针对 aria2 回报的文件路径，且逐个文件校验。
- **关机护栏**：先用「测试关机」验证命令；默认「仅成功后才关机」；关机命令仅在 localhost 本地执行，外部无法触发。
- **跨域**：以 `file://` 打开 AriaNg 时，helper 已做 Origin 反射兼容；个别浏览器拦截时改用本地静态服务器（如 `npx serve` / `python -m http.server`）。使用 `星云压力测试.exe` 时界面走 `http://localhost:6688`，无此问题。
- **远程访问边界**：`loop-helper` 仅监听本机。若从手机/其他电脑访问 AriaNg，删除/关机动作仍发生在运行 aria2 的那台机器上，符合预期。

---

## 八、修改源码后如何重新构建

1. 改 `AriaNg-master/src` 后必须重新构建前端：
   ```bat
   cd AriaNg-master
   npm install
   gulp clean build-bundle
   ```
   产物在 `AriaNg-master/dist/`，将 `dist/index.html` 覆盖根目录 `index.html`（浏览器 `Ctrl+F5` 强刷）。
2. 改 `loop-helper/server.js` 只需**重启辅助服务**（重开 `星云压力测试.exe` 或重跑 `start.bat`），无需构建。
3. 重新打包 EXE：
   ```bat
   cd build
   npx --yes pkg@5.8.1 launcher.js --targets node18-win-x64 --assets "res/**/*" --output 星云压力测试.exe
   ```

> ⚠️ 新增 JS 控制器/服务文件**必须**在 `src/index.html` 的 `<!-- build:js js/aria-ng.min.js -->` 块内登记，否则不会打包进 bundle（典型症状：`{{ }}` 原样显示、控件点不动）。视图 `*.html` 与语言包会自动收集，无需登记。

> ⚠️ **文案占位符**：带参数的翻译键必须写双花括号 `{{name}}`（如 `Round {{current}}=第 {{current}} 次`），写单花括号不会被替换；且带参翻译键不要写在指令属性里，应在控制器 JS 中调用 `translate(key, params)`。

---

## 九、常见问题（FAQ）

**Q1：界面里看不到「循环下载」入口？**
根 `index.html` 是旧包，未含新面板。改过源码需按第八节重新构建并覆盖；若没改源码，确认用的是根目录 `index.html` 且辅助服务已启动。

**Q2：点「开始」后提示 helper 地址未配置？**
到「AriaNg 设置」填写 `http://localhost:18888`。

**Q3：以 `file://` 打开 AriaNg 调不通 helper？**
用 `星云压力测试.exe` 则界面走 `http://localhost:6688`，不存在此问题；源码模式下 helper 已做 Origin 反射兼容，若仍被拦，用本地静态服务器打开。

**Q4：删除文件没生效 / 误删风险？**
务必设置 `ALLOWED_ROOTS` 白名单；非白名单路径会被拒绝并记录。删除仅针对 aria2 回报的文件路径。

**Q5：关机没发生？**
先点「测试关机」验证命令；确认 `endAction` 正确且（默认）循环成功完成；`endActionOnlyOnSuccess=true` 时失败不会关机。

**Q6：关掉浏览器循环还在跑吗？**
在跑。引擎在本地 `loop-helper`，与浏览器无关。注意：关闭的是「浏览器」循环照跑；**关闭 `星云压力测试.exe` 窗口会连辅助服务一起停掉**。

**Q7：为什么跑满次数就停了？**
「定次数」里设定的次数就是上限。想一直跑，把次数填 `0`，或点一键预设「一直跑」。

**Q8：多个链接怎么处理？**
一行一个粘进第 1 步，会冒出「多个链接怎么处理」四选一：独立循环（默认）/ 顺序 / 并发 / 镜像。独立循环的「次数」指每个链接各自下载几遍（总次数 = 链接数 × 次数）。

**Q9：日志里有 `delete-skipped`？**
说明配了白名单，而下载目录不在白名单内。把该目录加进白名单（留空表示不限制）。

**Q10：循环次数 / 历史会随重启丢失吗？**
不会。全局「已完成轮次」存在 `loop-state.json`，重启后继续累加；运行历史存在 `loop-history.json`（最近 100 条）。持久化的是计数，正在下载的半成品任务不会断点续传。

**Q11：结束动作能跑我自己的脚本吗？**
「更多设置 → 全部结束后要做什么」选「执行外部脚本」，填脚本路径（`.bat/.cmd/.sh/.exe`）和可选参数。脚本工作目录为脚本所在目录，超时 5 分钟。

**Q12：界面是英文，想要中文？**
默认语言为英文。到「AriaNg 设置 → 语言」选「简体中文」并保存；若仍显示英文，多为浏览器缓存了旧语言设置，清掉站点数据或强刷即可。

**Q13：反复下载把网速拉满了？**
用面板里的「局域网避让」：勾选启用 → 三选一（等待离线 / 限速 / 直接下载）→ 可设检测间隔、点「立即扫描」。原理是 ping 整段 + 读 ARP，纯本地零依赖；探测失败自动放行。

---

## 十、已知限制 / 待办

- 单文件 `星云压力测试.exe` 打包依赖 GitHub 上的「补丁版 Node」二进制（约 64MB，境内镜像不托管），联网不便时可用项目内 Node + Windows 自带 `IExpress` 零下载兜底打包（每次启动解压到临时目录，运行时数据应固定写到 `%LOCALAPPDATA%\WuLiao`）。
- BT / 多文件任务的删除粒度验证、真实关机实跑验证等见工作记录待办清单。
- 循环引擎放在本地而非纯前端，受浏览器沙箱能力限制（浏览器不能删文件/关机/关页即停，已论证不可行）。
- aria2 断线时 v1 不自动恢复循环，需用户手动重启（避免失控）。

---

## 许可

`loop-helper` 以 MIT 许可证发布。AriaNg 与 aria2 各自遵循其上游许可证。
