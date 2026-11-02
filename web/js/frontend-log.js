// 前端日志转发：把 error / warn / 未捕获异常发到服务端，显示在启动窗口里。
    (function () {
        if (window.__logRelayInstalled) return;
        window.__logRelayInstalled = true;

        var queue = [];
        var timer = null;

        function toText(args) {
            var parts = [];
            for (var i = 0; i < args.length; i++) {
                var a = args[i];
                try {
                    // 取 stack 而不只是 message：报错原因常常在调用链上（谁调的、参数是什么）
                    if (a instanceof Error) parts.push(a.stack || a.message);
                    else if (typeof a === 'object' && a !== null) parts.push(JSON.stringify(a));
                    else parts.push(String(a));
                } catch (e) { parts.push('[无法序列化]'); }
            }
            // 上限 2000 与服务端主日志一致：更短会把最关键的上游报错砍在半截
            // （`requestedModel":"Qwen3.8-` 就断了）。
            return parts.join(' ').slice(0, 2000);
        }

        function push(level, text) {
            if (!text) return;
            queue.push({ level: level, text: text, page: location.pathname + location.hash.slice(0, 20) });
            if (queue.length > 40) queue.splice(0, queue.length - 40);
            if (!timer) timer = setTimeout(flush, 1200);
        }

        function flush() {
            timer = null;
            if (!queue.length) return;
            var items = queue.splice(0, 20);
            try {
                var blob = new Blob([JSON.stringify({ items: items })], { type: 'application/json' });
                navigator.sendBeacon('/api/client-log', blob);
            } catch (e) { /* 上报失败就算了，绝不影响应用本身 */ }
        }

        var origError = console.error;
        console.error = function () { origError.apply(console, arguments); push('error', toText(arguments)); };
        var origWarn = console.warn;
        console.warn = function () { origWarn.apply(console, arguments); push('warn', toText(arguments)); };
        // console.debug 也转发（记为 DBUG）：pixi / Live2D 等第三方库会调，出问题时那些输出
        // 正是最需要看到的；服务端只在落盘级别为 DEBUG 时才写文件，平时不造成噪音。
        var origDebug = console.debug;
        if (typeof origDebug === 'function') {
            console.debug = function () { origDebug.apply(console, arguments); push('debug', toText(arguments)); };
        }

        // console.log 只转发 `[Mod:` 前缀的那几条：插件加载成功走 host.log() 落到 console.log，
        // 失败才有 [Mod:…] 的 error —— 不补这一段，"没有 mod 日志"既可能是成功也可能是
        // mods.js 压根没跑，两者在启动窗口里长得一模一样。
        // 不转发全部 console.log：宿主日志量大，全转会把启动窗口刷满、把真正的错误埋掉。
        var origLog = console.log;
        console.log = function () {
            origLog.apply(console, arguments);
            try {
                var first = arguments.length ? String(arguments[0]) : '';
                // host.log 打的是 '[Mod:<name>] …'；宿主自己的 Mod 生命周期日志也用这个前缀
                if (first.indexOf('[Mod:') === 0 || first.indexOf('[Mod]') === 0) {
                    push('info', toText(arguments));
                }
            } catch (e) { /* 绝不影响应用本身 */ }
        };

        window.addEventListener('error', function (e) {
            push('error', '未捕获异常: ' + (e.message || '') + '  @'
                + String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0));
        });
        window.addEventListener('unhandledrejection', function (e) {
            var r = e.reason;
            push('error', '未处理的 Promise 拒绝: ' + ((r && r.message) || String(r)));
        });
    })();
