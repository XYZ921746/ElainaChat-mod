// 插件市场下载引擎：镜像地址 / 分片并发 / 流读取 / 完整性检查 / 探测超时 / 空闲超时。
'use strict';

    // 包下载镜像：索引写死 Pages 地址，而 Pages 在大陆链路时通时不通；只登记确定能取到包的域名，失败静默跳过。
    var MIRROR_PACKAGE_BASES = [
        'https://gcore.jsdelivr.net/gh/XYZ921746/web@main',
        'https://testingcf.jsdelivr.net/gh/XYZ921746/web@main',
    ];

    // 上次通的源（仅内存，不落盘）：链路状态一次会话里很稳定，从 Pages 重试会让不通时每个包白等一次超时。
    var lastGoodBase = '';

    // 镜像候选：上次通的源 → 原地址 → 其余镜像并去重；只认官方索引那两个源下的 store/packages/，自建源猜不出镜像路径。
    function packageMirrorUrls(url) {
        var s = String(url || '');
        var m = /^https:\/\/(?:xyz921746\.github\.io\/web|cdn\.jsdelivr\.net\/gh\/XYZ921746\/web@main)\/store\/packages\/([^/?#]+\.zip)(?:\?[^#]*)?$/i.exec(s);
        if (!m) return [url];
        var file = m[1];
        var bases = ['https://xyz921746.github.io/web'].concat(MIRROR_PACKAGE_BASES);
        var out = [];
        var push = function (u) { if (u && out.indexOf(u) < 0) out.push(u); };
        if (lastGoodBase) push(lastGoodBase + '/store/packages/' + file);   // 上次通的排第一
        push(s);                                                            // 原地址
        for (var i = 0; i < bases.length; i++) push(bases[i] + '/store/packages/' + file);
        return out;
    }

    function baseOfPackageUrl(u) {
        var m = /^(https:\/\/(?:xyz921746\.github\.io\/web|[a-z0-9-]+\.jsdelivr\.net\/gh\/XYZ921746\/web@main))\/store\/packages\//i.exec(String(u || ''));
        return m ? m[1] : '';
    }


    var SEGMENT_RETRIES = 3;
    /** 单片最小字节数：片数按体积算，但不让一个 1MB 的包被拆成几十个请求 */
    var MIN_SEGMENT_BYTES = 512 * 1024;
    /** 片数上限。每片一条独立 TCP 连接，太多会被对端限流，也白占移动端带宽 */
    var MAX_SEGMENTS = 16;

    // 分片数：Pages 对单条 TCP 流限速，多连接才跑得动；移动端少开（并发收益小，每条连接都占带宽与内存）。
    function segmentCountFor(sizeBytes) {
        if (!sizeBytes || sizeBytes <= 0) return 1;
        var bySize = Math.ceil(sizeBytes / MIN_SEGMENT_BYTES);
        var cap = (typeof IS_MOBILE_DEVICE !== 'undefined' && IS_MOBILE_DEVICE) ? 6 : MAX_SEGMENTS;
        return Math.max(1, Math.min(cap, bySize));
    }

    async function readStream(res, onBytes) {
        if (!res.body || typeof res.body.getReader !== 'function') {
            var buf = await res.arrayBuffer();
            onBytes(buf.byteLength);
            return buf;
        }
        var reader = res.body.getReader();
        var chunks = [];
        for (;;) {
            var step = await reader.read();
            if (step.done) break;
            chunks.push(step.value);
            onBytes(step.value.length);
        }
        return new Blob(chunks);
    }

    // 分片并发下载一个 zip，全部成功才返回；进度按总已收字节汇报，与分片完成顺序无关，否则进度条会来回跳。
    // total 必须已知：分片边界靠它算。
    async function downloadZipSegmented(url, total, onProgress, signal) {
        var n = segmentCountFor(total);
        var size = Math.ceil(total / n);
        var parts = new Array(n);
        var got = 0;
        var bump = function (bytes) {
            got += bytes;
            if (onProgress) onProgress(Math.min(got, total), total);
        };

        var fetchSegment = async function (i) {
            var start = i * size;
            var end = Math.min(total - 1, start + size - 1);
            var want = end - start + 1;
            var lastErr = null;
            for (var attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
                if (signal && signal.aborted) throw new Error('已停止');   // 停止后重试没有意义
                // 重试要先退回上次尝试已吐出的字节（重试会重读同一段），否则重试几次后进度会超过 100%。
                var before = 0;
                var wd = idleWatch(signal);
                try {
                    wd.kick();
                    var res = await fetch(url, {
                        cache: 'no-store',
                        headers: { Range: 'bytes=' + start + '-' + end },
                        signal: wd.signal,
                    });
                    if (res.status !== 206) {
                        // 200 = 服务端忽略了 Range，把整个文件当这一片发了回来：拼接会重复，放弃分片回退单流。
                        throw new Error('服务端不支持分片下载（HTTP ' + res.status + '）');
                    }
                    var blob = await readStream(res, function (b) { before += b; bump(b); wd.kick(); });
                    if (blob.size === want) { parts[i] = blob; return; }
                    bump(-before);
                    throw new Error('分片长度不符（期望 ' + want + '，实收 ' + blob.size + '）');
                } catch (e) {
                    bump(-before);   // before 为 0 时是无操作
                    lastErr = e;
                    // "不支持分片"是能力问题，重试没用，立刻上抛回退单流；超时 / 断连 / 长度不符才值得重试。
                    if (/不支持分片下载/.test(String(e && e.message))) throw e;
                } finally {
                    wd.done();
                }
            }
            throw lastErr || new Error('分片下载失败');
        };

        var tasks = [];
        for (var i = 0; i < n; i++) tasks.push(fetchSegment(i));
        await Promise.all(tasks);
        return new Blob(parts, { type: 'application/zip' });
    }

    // 客户端 zip 完整性快检：尾部 64KB 内找 EOCD 签名。分片路径在 Pages 这类源上只能信索引 sizeBytes，
    // 声明小了会拼出尾部截断的 zip；当场发现就换源重下，不把坏字节交给服务端解压才发现。
    async function blobLooksCompleteZip(blob) {
        try {
            var tail = blob.slice(Math.max(0, blob.size - 65536));
            var buf = new Uint8Array(await tail.arrayBuffer());
            for (var i = buf.length - 22; i >= 0; i--) {   // EOCD 定长 22 字节起
                if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return true;
            }
            return false;
        } catch (e) { return true; }   // 检查本身失败不拦下载（交给服务端解压兜底）
    }

    // 多源回退（顺序见 packageMirrorUrls）：并发解决单流限速，多源解决链路不通；sizeHint 是索引声明的体积，
    // 跨域读不到 Content-Range 的源靠它才能启用分片。每个源有独立的快速失败预算（探测成功即撤时限，之后交给 idleWatch）。
    async function downloadZip(url, sizeHint, onProgress, signal) {
        var urls = packageMirrorUrls(url);
        var lastErr = null;
        for (var i = 0; i < urls.length; i++) {
            if (signal && signal.aborted) throw new Error('已停止');
            try {
                var blob = await downloadZipFrom(urls[i], sizeHint, onProgress, signal);
                if (!(await blobLooksCompleteZip(blob))) {
                    if (onProgress) onProgress(0, 0);
                    throw new Error('下载结果不完整（zip 尾部缺失），换源重试');
                }
                // 记住这个源：同一次会话里后面的包直接从它开始，不必每个都先等一次超时
                var b = baseOfPackageUrl(urls[i]);
                if (b) lastGoodBase = b;
                return blob;
            } catch (e) {
                lastErr = e;
                if (onProgress) onProgress(0, 0);   // 换源重来，进度归零
            }
        }
        throw lastErr || new Error('下载失败');
    }

    var PROBE_TIMEOUT_MS = 8000;

    /** 给 fetch 套一个只在"拿到响应头"之前生效的时限；external 供用户「停止」掐断 */
    async function fetchWithProbeTimeout(url, opts, external) {
        var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        var timer = null;
        var o = Object.assign({}, opts);
        if (ctrl) {
            o.signal = ctrl.signal;
            if (external) {
                var trip = function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } };
                if (external.aborted) trip();
                else external.addEventListener('abort', trip, { once: true });
            }
            timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, PROBE_TIMEOUT_MS);
        } else if (external) {
            o.signal = external;
        }
        try {
            return await fetch(url, o);
        } finally {
            if (timer) clearTimeout(timer);   // 响应头已到 → 时限作废，传输不再被掐
        }
    }

    var IDLE_TIMEOUT_MS = 20000;

    // 无进展看门狗：浏览器 fetch 默认无超时，链路会出现"连得上但整条卡死"（响应头到了，传输体不再来字节）；
    // 用法是 fetch 前 kick() 起表、每收一段续命、读完 done() 撤表，超时 abort 让在途 read() 抛错交给既有重试/换源。
    function idleWatch(external) {
        var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        var timer = null;
        if (ctrl && external) {
            var trip = function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } };
            if (external.aborted) trip();
            else external.addEventListener('abort', trip, { once: true });
        }
        return {
            signal: ctrl ? ctrl.signal : (external || undefined),
            kick: function () {
                if (!ctrl) return;
                if (timer) clearTimeout(timer);
                timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }, IDLE_TIMEOUT_MS);
            },
            done: function () { if (timer) clearTimeout(timer); },
        };
    }

    // 单源下载：优先分片并发（多连接压过单流限速）。先发 1 字节 Range 探测，同时确认三件事：总长（分片边界靠它算）、
    // 服务端真的回 206（只看 Accept-Ranges 不够）、这一跳链路此刻通不通。总长有两个来源：Content-Range 响应头或
    // sizeHint（索引声明的 sizeBytes）——跨域响应读不到 Content-Range，只依赖它分片就永不启动。任何一步不成立都原样退回单流。
    async function downloadZipFrom(url, sizeHint, onProgress, signal) {
        var probe = null;
        var total = 0;
        try {
            probe = await fetchWithProbeTimeout(url, { cache: 'no-store', headers: { Range: 'bytes=0-0' } }, signal);
            if (probe.status === 206) {
                var m = /\/(\d+)\s*$/.exec(String(probe.headers.get('Content-Range') || ''));
                total = m ? Number(m[1]) : (sizeHint > 0 ? sizeHint : 0);
            } else if (probe.ok) {
                // 源不支持 Range（回了 200 整个文件）——响应体就是完整文件，直接当单流用掉，不再多发一次请求
                total = Number(probe.headers.get('Content-Length') || 0);
                var wd0 = idleWatch(signal);
                var got0 = 0;
                try {
                    wd0.kick();
                    var blob0 = await readStream(probe, function (b) {
                        wd0.kick();
                        got0 += b;
                        if (onProgress) onProgress(got0, total);
                    });
                    return new Blob([blob0], { type: 'application/zip' });
                } finally {
                    wd0.done();
                }
            }
        } catch (e) {
            if (signal && signal.aborted) throw new Error('已停止');   // 用户停止不算"探测失败"
            probe = null; /* 探测失败：走下面的单流，让它报真正的错 */
        }
        if (probe && probe.body && typeof probe.body.cancel === 'function') {
            try { await probe.body.cancel(); } catch (e) { /* 忽略 */ }
        }

        if (total > MIN_SEGMENT_BYTES && segmentCountFor(total) > 1) {
            if (signal && signal.aborted) throw new Error('已停止');
            try {
                return await downloadZipSegmented(url, total, onProgress, signal);
            } catch (e) {
                if (signal && signal.aborted) throw new Error('已停止');   // 停止不走回退，直接上抛
                // 分片走不通（源中途改口或所有分片都失败）就退回单流再试；不吞错——单流也失败时抛的是单流那个错
                if (onProgress) onProgress(0, 0);
            }
        }

        if (signal && signal.aborted) throw new Error('已停止');
        var wd = idleWatch(signal);
        try {
            wd.kick();
            var res = await fetch(url, { cache: 'no-store', signal: wd.signal });
            if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
            var total2 = Number(res.headers.get('Content-Length') || 0) || total || (sizeHint > 0 ? sizeHint : 0);
            var got = 0;
            var blob = await readStream(res, function (b) {
                wd.kick();
                got += b;
                if (onProgress) onProgress(got, total2);
            });
            return new Blob([blob], { type: 'application/zip' });
        } finally {
            wd.done();
        }
    }

