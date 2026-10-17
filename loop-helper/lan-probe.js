/**
 * 局域网设备探测（原生零依赖实现）
 *
 * 原理（与 npm `local-devices` 一致，但不引入任何第三方依赖）：
 *   1) 用 os.networkInterfaces() 找出本机私有 IPv4 网段；
 *   2) ping 整个子网，让系统 ARP 表填充活跃设备；
 *   3) 解析 `arp -a`(Windows) / `arp -n`(*nix)，得到 IP → MAC 清单；
 *   4) 剔除本机 IP 与网关，剩下的就是“其他在线设备”。
 *
 * 仅用 Node 内置模块 + 系统 ping/arp 命令，零第三方依赖，可随 loop-helper 直接打包。
 * 设计上“fail-open”：探测出错时返回 others=0，绝不因探测失败而卡住下载。
 */
'use strict';

const os = require('os');
const childProcess = require('child_process');

const isWin = process.platform === 'win32';

// 扫描结果缓存：避免每个下载轮次都全子网 ping（默认 20s 内复用）
let _cache = { ts: 0, data: null };
const CACHE_TTL = 20000;

function ipToInt(ip) {
    const p = ip.split('.');
    if (p.length !== 4) return null;
    return ((parseInt(p[0], 10) << 24) >>> 0) +
        ((parseInt(p[1], 10) << 16) >>> 0) +
        ((parseInt(p[2], 10) << 8) >>> 0) +
        (parseInt(p[3], 10) >>> 0);
}

function intToIp(n) {
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function isPrivate(ip) {
    const n = ipToInt(ip);
    if (n === null) return false;
    // 注意：JS 按位运算返回有符号 32 位整数，高位为 1 时结果为负，
    // 故需用 >>> 0 转回无符号后再与字面量比较（否则 192.168/172.16 段会误判）。
    // 10.0.0.0/8
    if ((n & 0xff000000) >>> 0 === 0x0a000000) return true;
    // 172.16.0.0/12
    if ((n & 0xfff00000) >>> 0 === 0xac100000) return true;
    // 192.168.0.0/16
    if ((n & 0xffff0000) >>> 0 === 0xc0a80000) return true;
    return false;
}

// 根据 IP + 子网掩码枚举该网段所有主机地址（不含网络地址与广播地址）
function enumerateHosts(ip, netmask) {
    const ipInt = ipToInt(ip);
    const maskInt = ipToInt(netmask);
    if (ipInt === null || maskInt === null) return [];
    if (maskInt === 0xffffffff) return []; // /32 单主机，无“其他设备”可言
    const netInt = (ipInt & maskInt) >>> 0;
    const bcastInt = (netInt | (~maskInt >>> 0)) >>> 0;
    const hosts = [];
    for (let h = netInt + 1; h < bcastInt; h++) {
        hosts.push(intToIp(h >>> 0));
    }
    return hosts;
}

function getGateway() {
    return new Promise((resolve) => {
        // route 在部分精简环境不在 PATH，netstat 更通用；两者都试一遍
        const cmds = isWin
            ? ['route print 0.0.0.0', 'netstat -rn']
            : ["ip route show default 2>/dev/null", "netstat -rn 2>/dev/null | grep '^0.0.0.0'", "netstat -rn 2>/dev/null | grep 'default'"];
        let i = 0;
        const tryNext = () => {
            if (i >= cmds.length) return resolve(null);
            const cmd = cmds[i++];
            childProcess.exec(cmd, { timeout: 5000 }, (err, stdout) => {
                if (err || !stdout) return tryNext();
                let m;
                if (isWin) {
                    m = stdout.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
                } else {
                    m = stdout.match(/default(?: via)?\s+(\d+\.\d+\.\d+\.\d+)/) ||
                        stdout.match(/^0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/m);
                }
                if (m) return resolve(m[1]);
                tryNext();
            });
        };
        tryNext();
    });
}

function ping(ip) {
    return new Promise((resolve) => {
        const cmd = isWin
            ? 'ping -n 1 -w 200 ' + ip
            : 'ping -c 1 -W 1 ' + ip;
        childProcess.exec(cmd, { timeout: 3000 }, () => resolve()); // 结果不重要，只为填充 ARP 表
    });
}

// 并发受限的 ping 全段
async function pingSweep(hosts, concurrency) {
    concurrency = concurrency || 32;
    let idx = 0;
    async function worker() {
        while (idx < hosts.length) {
            const ip = hosts[idx++];
            await ping(ip);
        }
    }
    const n = Math.min(concurrency, hosts.length || 1);
    await Promise.all(Array.from({ length: n }, worker));
}

function readArp() {
    return new Promise((resolve) => {
        const cmd = isWin ? 'arp -a' : 'arp -n';
        childProcess.exec(cmd, { timeout: 5000 }, (err, stdout) => {
            const map = {};
            if (!err && stdout) {
                const re = /(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2})/gi;
                let m;
                while ((m = re.exec(stdout)) !== null) {
                    map[m[1]] = m[2].toLowerCase();
                }
            }
            resolve(map);
        });
    });
}

async function doScan() {
    const ifaces = os.networkInterfaces();
    // 选取第一个“私有 IPv4、非回环、非 /32”网段（家庭/办公局域网）
    let chosen = null;
    for (const name of Object.keys(ifaces)) {
        for (const ni of ifaces[name]) {
            if (ni.family === 'IPv4' && !ni.internal && isPrivate(ni.address) && ni.netmask && ni.netmask !== '255.255.255.255') {
                chosen = ni;
                break;
            }
        }
        if (chosen) break;
    }
    if (!chosen) {
        return { devices: [], selfIp: null, gateway: null, others: 0 };
    }
    const selfIp = chosen.address;
    const gateway = await getGateway();
    const hosts = enumerateHosts(selfIp, chosen.netmask);
    await pingSweep(hosts);
    const arp = await readArp();
    const devices = hosts.map((ip) => ({ ip: ip, mac: arp[ip] || '', name: '' }))
        .filter((d) => d.mac || d.ip === gateway); // 网关即使没 MAC 也保留（用于排除）
    const others = devices.filter((d) => d.ip !== selfIp && d.ip !== gateway).length;
    return { devices: devices, selfIp: selfIp, gateway: gateway, others: others };
}

/**
 * 扫描局域网活跃设备。
 * @param {boolean} force 为 true 时忽略缓存强制重新扫描（测试/等待重检时用）
 * @returns {Promise<{devices:Array, selfIp:string, gateway:string, others:number}>}
 */
async function scanLan(force) {
    const now = Date.now();
    if (!force && _cache.data && now - _cache.ts < CACHE_TTL) {
        return _cache.data;
    }
    let data;
    try {
        data = await doScan();
    } catch (e) {
        data = { devices: [], selfIp: null, gateway: null, others: 0, error: String(e && e.message || e) };
    }
    _cache = { ts: now, data: data };
    return data;
}

module.exports = { scanLan, _resetCache: () => { _cache = { ts: 0, data: null }; } };
