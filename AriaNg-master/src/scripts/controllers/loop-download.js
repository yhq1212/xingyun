(function () {
    'use strict';

    angular.module('ariaNg').controller('LoopDownloadController', ['$rootScope', '$scope', '$interval', '$timeout', '$http', '$filter', 'ariaNgCommonService', 'ariaNgLogService', 'ariaNgSettingService', 'aria2SettingService', function ($rootScope, $scope, $interval, $timeout, $http, $filter, ariaNgCommonService, ariaNgLogService, ariaNgSettingService, aria2SettingService) {
        var statusPromise = null;
        var lastPhase = null;

        var translate = function (key, params) {
            return params ? $filter('translate')(key, params) : $filter('translate')(key);
        };

        var defaultConfig = function () {
            return {
                urls: '',
                dir: '',
                out: '',
                options: {},
                maxCount: 10,
                intervalSeconds: 5,
                randomDelay: false,
                deleteAfterComplete: true,
                stopOnError: true,
                endAction: 'none',
                endActionScript: '',
                endActionScriptArgs: '',
                endActionOnlyOnSuccess: true,
                multiMode: 'independent',
                notify: true,
                autoStart: false,
                lanCheckEnabled: false,
                lanMode: 'pause',
                lanThrottleSpeed: '1M',
                lanCheckInterval: 15
            };
        };

        $scope.helperUrl = ariaNgSettingService.getLoopHelperUrl(); // 形如 http://localhost:18888
        $scope.loopConfig = defaultConfig();
        $scope.helperSettings = { allowedRoots: [] };
        $scope.status = { running: false, phase: 'idle', currentIteration: 0, maxCount: 0, tasks: [], log: [] };
        $scope.helperOffline = false;
        $scope.visibleLogs = [];
        $scope.testingShutdown = false;
        $scope.ui = { showAdvanced: false, showSafety: false, showHistory: false, newRoot: '', savingRoot: false, cleaningUp: false, showLan: false, scanningLan: false };
        $scope.lanScanResult = null;
        $scope.history = [];
        $scope.historyStats = {};

        var api = function (path) {
            return ($scope.helperUrl || '').replace(/\/+$/, '') + path;
        };

        var httpJson = function (method, path, body, callback, silent) {
            if (!$scope.helperUrl) {
                if (!silent) ariaNgCommonService.showError(translate('Helper not configured'));
                return;
            }
            var req = {
                method: method,
                url: api(path),
                headers: { 'Content-Type': 'application/json' }
            };
            if (body !== undefined) req.data = body;
            $http(req).then(function (resp) {
                callback && callback({ success: true, data: resp.data });
            }, function (resp) {
                callback && callback({ success: false, error: (resp.data && resp.data.error) || ('HTTP ' + resp.status), status: resp.status });
            });
        };

        $scope.togglePanel = function (name) {
            if (name === 'advanced') {
                $scope.ui.showAdvanced = !$scope.ui.showAdvanced;
            } else if (name === 'safety') {
                $scope.ui.showSafety = !$scope.ui.showSafety;
                if ($scope.ui.showSafety) {
                    $scope.loadSettings();
                }
            } else if (name === 'history') {
                $scope.ui.showHistory = !$scope.ui.showHistory;
            } else if (name === 'lan') {
                $scope.ui.showLan = !$scope.ui.showLan;
            }
        };

        // 局域网手动扫描（测试用）
        $scope.scanLanNow = function () {
            $scope.ui.scanningLan = true;
            $scope.lanScanResult = null;
            httpJson('GET', '/api/lan/scan', undefined, function (response) {
                $scope.ui.scanningLan = false;
                if (response.success && response.data) {
                    $scope.lanScanResult = response.data;
                } else {
                    ariaNgCommonService.showError(translate('LAN scan failed') + ': ' + (response.error || 'HTTP ' + response.status));
                }
            });
        };

        // ===================== 状态展示 =====================
        $scope.heroClass = function () {
            return 'loop-hero-' + ($scope.status.phase || 'idle');
        };

        $scope.heroIcon = function () {
            var map = {
                idle: 'fa-coffee',
                downloading: 'fa-cloud-download',
                deleting: 'fa-trash-o',
                waiting: 'fa-hourglass-half',
                finished: 'fa-check',
                error: 'fa-times',
                stopped: 'fa-stop'
            };
            return map[$scope.status.phase] || 'fa-info-circle';
        };

        $scope.taskCount = function () {
            return ($scope.status.tasks || []).length;
        };

        $scope.progressPercent = function () {
            var tasks = $scope.status.tasks || [];
            if (!tasks.length) {
                return 0;
            }
            var sum = 0;
            for (var i = 0; i < tasks.length; i++) {
                sum += (tasks[i].progress || 0);
            }
            return Math.round(sum / tasks.length);
        };

        $scope.currentSpeedText = function () {
            var tasks = $scope.status.tasks || [];
            var total = 0;
            for (var i = 0; i < tasks.length; i++) {
                total += (tasks[i].speed || 0);
            }
            if (total <= 0) {
                return '';
            }
            return $filter('readableVolume')(total) + '/s';
        };

        $scope.elapsedText = function () {
            if (!$scope.status.startedAt) {
                return '';
            }
            var start = new Date($scope.status.startedAt).getTime();
            var end = $scope.status.finishedAt ? new Date($scope.status.finishedAt).getTime() : new Date().getTime();
            var sec = Math.max(0, Math.floor((end - start) / 1000));
            var pad = function (n) { return (n < 10 ? '0' : '') + n; };
            var h = Math.floor(sec / 3600);
            var m = Math.floor((sec % 3600) / 60);
            var s = sec % 60;
            return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(s);
        };

        // ===================== 历史 / 统计 =====================
        $scope.historyDuration = function (ms) {
            ms = ms || 0;
            var total = Math.floor(ms / 1000);
            var pad = function (n) { return (n < 10 ? '0' : '') + n; };
            var h = Math.floor(total / 3600);
            var m = Math.floor((total % 3600) / 60);
            var s = total % 60;
            return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(s);
        };

        $scope.historyDate = function (iso) {
            if (!iso) return '';
            return $filter('date')(iso, 'MM-dd HH:mm');
        };

        // ===================== 状态卡 / 历史文本 =====================
        // 注意：带 {{参数}} 的翻译键不能直接写在 HTML 属性表达式里
        //（AngularJS 会先对属性内的 {{}} 做插值，把键 'Round {{current}}' 破坏成 'Round '），
        // 必须在 JS 里通过 translate(key, params) 取值。
        $scope.roundLabel = function () {
            var cfg = $scope.status.config || {};
            // 独立循环模式：展示累计完成的下载次数（每个链接各自循环，无“轮次”概念）
            if (cfg.multiMode === 'independent' && (cfg.urls || []).length > 1) {
                var done = $scope.status.completedRounds || 0;
                var links = (cfg.urls || []).length;
                if ($scope.status.maxCount > 0) {
                    return translate('Downloaded {{done}} of {{total}}', { done: done, total: links * $scope.status.maxCount });
                }
                return translate('Downloaded {{n}} times', { n: done });
            }
            var cur = $scope.status.running ? ($scope.status.completedRounds + 1) : ($scope.status.completedRounds || 0);
            if ($scope.status.maxCount > 0) {
                return translate('Round {{current}} of {{total}}', { current: cur, total: $scope.status.maxCount });
            }
            return translate('Round {{current}}', { current: cur });
        };

        $scope.historyRoundsLabel = function (h) {
            return translate('Completed {{s}} / failed {{f}}', { s: h.successRounds || 0, f: h.failedRounds || 0 });
        };

        $scope.linksLabel = function (n) {
            return translate('links {{n}}', { n: n });
        };

        $scope.taskDisplayName = function (t) {
            var name = t.name || t.url || '';
            return name.length > 56 ? name.slice(0, 53) + '...' : name;
        };

        $scope.taskStatusText = function (t) {
            var map = { active: 'Downloading', waiting: 'Waiting', paused: 'Paused', error: 'Error', removed: 'Stopped', complete: 'Finished' };
            return map[t.status] ? translate(map[t.status]) : '';
        };

        // 独立循环模式下，任务自身的第几轮
        $scope.taskRoundLabel = function (t) {
            return t.round ? translate('Round {{current}}', { current: t.round }) : '';
        };

        $scope.historyReason = function (reason) {
            if (reason === 'finished') return translate('Finished');
            if (reason === 'stopped') return translate('Stopped');
            if (reason === 'error') return translate('Error');
            return translate('Unknown');
        };

        $scope.clearHistory = function () {
            httpJson('POST', '/api/loop/history/clear', {}, function (response) {
                if (response.success) {
                    $scope.history = [];
                    $scope.historyStats = {};
                    ariaNgCommonService.showInfo(translate('Success'), translate('History cleared'));
                } else {
                    ariaNgCommonService.showError(translate('Clear failed') + ': ' + response.error);
                }
            });
        };

        // ===================== 浏览器通知 =====================
        var showBrowserNotification = function (text) {
            if (typeof Notification === 'undefined') {
                return;
            }
            try {
                if (Notification.permission === 'granted') {
                    new Notification('AriaNg - ' + translate('Loop Download'), { body: text });
                } else if (Notification.permission !== 'denied') {
                    Notification.requestPermission();
                }
            } catch (e) {
                // file:// 或未授权环境下可能不支持
                ariaNgLogService.warn('[LoopDownload] notification failed: ' + e.message);
            }
        };

        var checkNotify = function (data) {
            var phase = data.phase;
            if (lastPhase && lastPhase !== phase && $scope.loopConfig.notify) {
                if (phase === 'finished') {
                    showBrowserNotification(translate('Loop finished'));
                } else if (phase === 'error') {
                    showBrowserNotification(translate('Loop failed'));
                }
            }
            lastPhase = phase;
        };

        // ===================== 数据加载 =====================
        $scope.loadConfig = function () {
            httpJson('GET', '/api/loop/config', undefined, function (response) {
                if (response.success && response.data && Object.keys(response.data).length > 0) {
                    var cfg = angular.copy(defaultConfig());
                    angular.extend(cfg, response.data);
                    if (Array.isArray(cfg.urls)) {
                        cfg.urls = cfg.urls.join('\n');
                    }
                    // 兼容旧配置：没有 multiMode 时从 concurrent 推导
                    if (!cfg.multiMode) {
                        cfg.multiMode = cfg.concurrent ? 'concurrent' : 'mirror';
                    }
                    $scope.loopConfig = cfg;
                }
            }, true);
        };

        $scope.loadStatus = function () {
            httpJson('GET', '/api/loop/status', undefined, function (response) {
                if (response.success && response.data) {
                    $scope.helperOffline = false;
                    $scope.status = response.data;
                    $scope.visibleLogs = (response.data.log || []).slice().reverse();
                    $scope.history = response.data.history || [];
                    $scope.historyStats = response.data.stats || {};
                    checkNotify(response.data);
                    if (response.data.running && !statusPromise) {
                        startPolling();
                    }
                    if (!response.data.running && statusPromise) {
                        stopPolling();
                    }
                } else {
                    $scope.helperOffline = true;
                }
            }, true);
        };

        $scope.loadSettings = function () {
            httpJson('GET', '/api/helper/settings', undefined, function (response) {
                if (response.success && response.data) {
                    $scope.helperSettings = response.data;
                    if (!Array.isArray($scope.helperSettings.allowedRoots)) {
                        $scope.helperSettings.allowedRoots = [];
                    }
                }
            }, true);
        };

        var startPolling = function () {
            if (statusPromise) {
                return;
            }
            statusPromise = $interval(function () { $scope.loadStatus(); }, 1500);
        };

        var stopPolling = function () {
            if (statusPromise) {
                $interval.cancel(statusPromise);
                statusPromise = null;
            }
        };

        // ===================== 配置与启动 =====================
        var buildPayload = function () {
            var payload = angular.copy($scope.loopConfig);
            payload.urls = ariaNgCommonService.parseUrlsFromOriginInput(payload.urls);
            if (!payload.urls || payload.urls.length === 0) {
                ariaNgCommonService.showError(translate('Please enter at least one download link'));
                return null;
            }

            var maxCount = parseInt(payload.maxCount, 10);
            if (isNaN(maxCount) || maxCount < 0) {
                ariaNgCommonService.showError(translate('Please enter a valid rounds number'));
                return null;
            }
            payload.maxCount = maxCount;

            var interval = parseFloat(payload.intervalSeconds);
            payload.intervalSeconds = isNaN(interval) || interval < 0 ? 0 : interval;

            if (payload.multiMode !== 'mirror' && payload.multiMode !== 'separate' &&
                payload.multiMode !== 'concurrent' && payload.multiMode !== 'independent') {
                payload.multiMode = 'independent';
            }
            payload.concurrent = (payload.multiMode === 'concurrent'); // 兼容旧字段
            payload.endActionScript = payload.endActionScript || '';
            payload.endActionScriptArgs = payload.endActionScriptArgs || '';

            payload.lanCheckEnabled = !!payload.lanCheckEnabled;
            if (['pause', 'throttle', 'ignore'].indexOf(payload.lanMode) < 0) payload.lanMode = 'pause';
            payload.lanThrottleSpeed = String(payload.lanThrottleSpeed || '1M');
            payload.lanCheckInterval = parseInt(payload.lanCheckInterval, 10) || 15;

            if (payload.endAction === 'script' && !String(payload.endActionScript).trim()) {
                ariaNgCommonService.showError(translate('Please enter the script path'));
                return null;
            }

            return payload;
        };

        $scope.setCount = function (n) {
            $scope.loopConfig.maxCount = n;
        };

        // 当前填写的链接数量（用于决定是否显示“多链接怎么处理”）
        $scope.multiLinkCount = function () {
            var urls = ariaNgCommonService.parseUrlsFromOriginInput($scope.loopConfig.urls || '');
            return urls ? urls.length : 0;
        };

        $scope.onMultiModeChange = function (mode) {
            $scope.loopConfig.multiMode = mode;
        };

        $scope.saveConfig = function () {
            var payload = buildPayload();
            if (!payload) {
                return;
            }
            httpJson('POST', '/api/loop/config', payload, function (response) {
                if (response.success) {
                    ariaNgCommonService.showInfo(translate('Success'), translate('Settings saved'));
                } else {
                    ariaNgCommonService.showError(translate('Save failed') + ': ' + response.error);
                }
            });
        };

        $scope.startLoop = function () {
            var payload = buildPayload();
            if (!payload) {
                return;
            }
            if (payload.notify && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                try {
                    Notification.requestPermission();
                } catch (e) {
                    ariaNgLogService.warn('[LoopDownload] request notification permission failed: ' + e.message);
                }
            }
            httpJson('POST', '/api/loop/start', payload, function (response) {
                if (response.success) {
                    ariaNgCommonService.showInfo(translate('Success'), translate('Loop download started'));
                    $scope.loadStatus();
                    startPolling();
                } else {
                    ariaNgCommonService.showError(translate('Start failed') + ': ' + response.error);
                }
            });
        };

        $scope.stopLoop = function () {
            ariaNgCommonService.confirm(translate('Confirm'), translate('Stop loop confirm'), 'warning', function () {
                httpJson('POST', '/api/loop/stop?removeTask=true', {}, function () {
                    ariaNgCommonService.showInfo(translate('Success'), translate('Stop request sent'));
                    $timeout(function () { $scope.loadStatus(); }, 1000);
                });
            });
        };

        // 清空全部运行痕迹：停止循环 + 删除已下载文件 + 清空计数/历史/日志
        $scope.cleanupAll = function () {
            ariaNgCommonService.confirm(translate('Confirm'), translate('Cleanup all confirm'), 'warning', function () {
                $scope.ui.cleaningUp = true;
                httpJson('POST', '/api/loop/cleanup', {}, function (response) {
                    $scope.ui.cleaningUp = false;
                    if (response.success) {
                        ariaNgCommonService.showInfo(translate('Success'),
                            translate('Cleanup done') + (response.data && response.data.deletedFiles ? ' (' + response.data.deletedFiles + ')' : ''));
                        $scope.loadStatus();
                    } else {
                        ariaNgCommonService.showError(translate('Cleanup failed') + ': ' + response.error);
                    }
                });
            });
        };

        $scope.testShutdown = function () {
            $scope.testingShutdown = true;
            httpJson('POST', '/api/helper/shutdown?dryRun=true', {}, function () {
                $scope.testingShutdown = false;
                ariaNgCommonService.showInfo(translate('Success'), translate('Shutdown command is available'));
            });
        };

        $scope.openFolder = function () {
            var dir = $scope.loopConfig.dir;
            if (!dir) {
                ariaNgCommonService.showError(translate('Please set a save folder'));
                return;
            }
            httpJson('POST', '/api/helper/open-folder', { path: dir }, function (response) {
                if (!response.success) {
                    ariaNgCommonService.showError(translate('Open folder failed') + ': ' + response.error);
                }
            });
        };

        // ===================== 日志 =====================
        $scope.clearLog = function () {
            httpJson('POST', '/api/loop/log/clear', {}, function () {
                $scope.status.log = [];
                $scope.visibleLogs = [];
            });
        };

        $scope.exportLog = function (format) {
            if (!$scope.helperUrl) {
                ariaNgCommonService.showError(translate('Helper not configured'));
                return;
            }
            $http({
                method: 'GET',
                url: api('/api/loop/log/export?format=' + format),
                responseType: 'text'
            }).then(function (resp) {
                var text = resp.data || '';
                var isCsv = format === 'csv';
                var blob = new Blob([text], { type: isCsv ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
                var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                var link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = 'loop-log-' + stamp + (isCsv ? '.csv' : '.txt');
                document.body.appendChild(link);
                link.click();
                $timeout(function () {
                    URL.revokeObjectURL(link.href);
                    document.body.removeChild(link);
                }, 1000);
                ariaNgCommonService.showInfo(translate('Success'), translate('Log exported'));
            }, function () {
                ariaNgCommonService.showError(translate('Export failed'));
            });
        };

        // ===================== 安全设置（删除白名单） =====================
        var saveRoots = function (roots) {
            $scope.ui.savingRoot = true;
            httpJson('POST', '/api/helper/settings', { allowedRoots: roots }, function (response) {
                $scope.ui.savingRoot = false;
                if (response.success) {
                    $scope.helperSettings = response.data;
                    if (!Array.isArray($scope.helperSettings.allowedRoots)) {
                        $scope.helperSettings.allowedRoots = [];
                    }
                } else {
                    ariaNgCommonService.showError(translate('Save failed') + ': ' + response.error);
                    $scope.loadSettings();
                }
            });
        };

        $scope.addRoot = function () {
            var value = String($scope.ui.newRoot || '').trim();
            if (!value) {
                return;
            }
            var roots = ($scope.helperSettings.allowedRoots || []).slice();
            if (roots.indexOf(value) === -1) {
                roots.push(value);
            }
            $scope.ui.newRoot = '';
            saveRoots(roots);
        };

        $scope.removeRoot = function (index) {
            var roots = ($scope.helperSettings.allowedRoots || []).slice();
            roots.splice(index, 1);
            saveRoots(roots);
        };

        // ===================== 初始化 =====================
        $scope.loadConfig();
        $scope.loadStatus();
        $scope.loadSettings();

        $scope.$on('$destroy', function () {
            stopPolling();
        });
    }]);
}());
