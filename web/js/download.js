/* ============================================================================
 * 插件市场下载引擎（从 mod-market.js 拆分）
 *
 * 镜像地址 / 分片并发 / 流读取 / 完整性检查 / 探测超时 / 空闲超时。
 * ========================================================================== */
'use strict';

    /**
     * 包下载镜像：把 GitHub Pages 的包地址映射到 jsDelivr 上。
     *
     * 为什么需要：索引里的 downloadUrl 写死是 Pages 地址，而 Pages 在大陆**整条链路
     *   时通时不通**（实测：同一天里单连接从 0.09 MB/s 掉到 20s 全超时，此时 jsDelivr
     *   的 gcore 镜像还有 0.45 MB/s）。分片并发解决的是"单流被限速"，解决不了
     *   "这条链路根本连不上" —— 两者必须都有。
     *
     * 注意 cdn.jsdelivr.net 实测对**包文件**连不上（索引能取、包不能），所以镜像
     * 只登记确定能取到包的域名，且失败要能安静跳过。
     */
    var MIRROR_PACKAGE_BASES = [
        'https://gcore.jsdelivr.net/gh/XYZ921746/web@main',
        'https://testingcf.jsdelivr.net/gh/XYZ921746/web@main',
    ];

    /**
     * 上一次哪个源是通的（模块级记忆，不落盘）。
     *
     * 为什么要记忆：链路状态在一次会话里很稳定 —— 要么 Pages 通、要么只有镜像通。
     *   每次下载都从 Pages 开始试的话，Pages 不通时**每个包**都要先白等一次超时
     *   （装一个带依赖的插件要等 N 次）。记住上次成功的那个，下次直接从它开始。
     *   只活在内存里：刷新页面就重新学习，不需要也不应该持久化。
     */
    var lastGoodBase = '';

    /**
     * 给一个包地址算镜像候选。
     *
     * 顺序：上次成功的源排第一 → 原地址 → 其余镜像，全部去重。
     *   只认「本站官方索引那两个源下的 store/packages/」—— 用户自建的商店源有
     *   自己的托管方式，猜不出镜像路径，硬套只会制造 404（那时只返回原地址）。
     */
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

    /** 这个地址属于哪个源（用于记录 lastGoodBase） */
    function baseOfPackageUrl(u) {
        var m = /^(https:\/\/(?:xyz921746\.github\.io\/web|[a-z0-9-]+\.jsdelivr\.net\/gh\/XYZ921746\/web@main))\/store\/packages\//i.exec(String(u || ''));
        return m ? m[1] : '';
    }


    var SEGMENT_RETRIES = 3;
    /** 单片最小字节数：片数按体积算，但不让一个 1MB 的包被拆成几十个请求 */
    var MIN_SEGMENT_BYTES = 512 * 1024;
    /** 片数上限。每片一条独立 TCP 连接，太多会被对端限流，也白占移动端带宽 */
    var MAX_SEGMENTS = 16;

    /**
     * 一个文件该拆几片。
     *
     * 为什么要拆：GitHub Pages 对**单条 TCP 流**限速到 ~0.1 MB/s（本机实测：10 MB 的
     *   立绘包单连接 115 s，32 并发 3.6 s,速率几乎随并发数线性增长）。浏览器自带的
     *   下载器默认多连接，所以"官网下得飞快、应用里慢成蜗牛"不是应用写错了，
     *   而是这里只开了**一条**流 —— 一个 7~10 MB 的素材包在这种链路上要等几分钟，
     *   还经常中途卡死。
     *
     * 为什么手机端少开：移动网络的并发收益远小于电脑，而每条连接都要占带宽与内存；
     *   按**能力**判断（IS_MOBILE_DEVICE），与 core.js 判断设备形态用的是同一个值，
     *   不另写一套 UA 嗅探。
     */
    function segmentCountFor(sizeBytes) {
        if (!sizeBytes || sizeBytes <= 0) return 1;
        var bySize = Math.ceil(sizeBytes / MIN_SEGMENT_BYTES);
        var cap = (typeof IS_MOBILE_DEVICE !== 'undefined' && IS_MOBILE_DEVICE) ? 6 : MAX_SEGMENTS;
        return Math.max(1, Math.min(cap, bySize));
    }

    /** 读一段 Range 响应体；进度由调用方按"已收字节"累积 */
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

    /**
     * 分片并发下载一个 zip，全部成功才返回（任何一片最终失败都让整次下载失败）。
     *
     * 进度按**总已收字节**汇报，与分片完成顺序无关 —— 否则进度条会来回跳。
     *
     * @param {string} url
     * @param {number} total 文件总字节数（必须已知，分片边界靠它算）
     * @param {function} onProgress
     */
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
                // 上一次尝试已经吐出的字节要退回去（重试会重读同一段），
                //   否则重试几次后进度会超过 100%
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
                        // 200 = 服务端忽略了 Range，把整个文件当这一片发了回来。
                        //   不能当分片用（拼接会重复），直接放弃分片方案回退单流。
                        throw new Error('服务端不支持分片下载（HTTP ' + res.status + '）');
                    }
                    var blob = await readStream(res, function (b) { before += b; bump(b); wd.kick(); });
                    if (blob.size === want) { parts[i] = blob; return; }
                    bump(-before);
                    throw new Error('分片长度不符（期望 ' + want + '，实收 ' + blob.size + '）');
                } catch (e) {
                    bump(-before);   // before 为 0 时是无操作
                    lastErr = e;
                    // "不支持分片"是能力问题，重试也没用 → 立刻上抛给调用方回退单流。
                    //   其它错误（超时/断连/长度不符）才值得重试。
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

    /**
     * 浏览器端 zip 完整性快检：文件尾部 64KB 内找 EOCD 签名（PK\x05\x06）。
     *
     * 为什么在客户端查：分片路径的总长在 Pages 这类源上只能信索引的 sizeBytes，
     *   索引声明小了会拼出**尾部截断**的 zip —— 不查的话要等上传完、服务端解压
     *   才报"unexpected end of file"，用户看不出是下载坏了还是插件坏了。
     *   在这里当场发现就换下一个源（jsDelivr 系能读到真实 Content-Range）重下。
     */
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

    /**
     * 下载一个 zip（多源回退）。
     *
     * 顺序由 packageMirrorUrls 决定（上次通的源 → 原地址 → 其余镜像）。
     *   并发解决"单流被限速"，多源解决"这条链路根本连不上" —— 两者互补，缺一不可：
     *   实测 Pages 会整条链路 20s 全超时，此时再多的并发也拿不到一个字节。
     *
     * sizeHint 是索引里声明的包体积（sizeBytes）：跨域读不到 Content-Range 的源
     *   （Pages）靠它才能启用分片，见 downloadZipFrom。
     *
     * signal 是用户「停止」的外部信号：已停止时不再尝试下一个源（否则每个源
     *   都要陪一次立刻失败的请求才轮到退出）。
     *
     * 每个源给一个**独立的快速失败预算**：源不通时我们希望尽快换下一个，而不是
     *   陪着它熬到默认超时（浏览器默认没有超时，一个死连接能挂几分钟）。用
     *   AbortController 给探测阶段加时限 —— 一旦探测成功（拿到 206 或 200），
     *   时限就撤掉，正常传输交给 idleWatch 的无进展超时保护。
     */
    async function downloadZip(url, sizeHint, onProgress, signal) {
        var urls = packageMirrorUrls(url);
        var lastErr = null;
        for (var i = 0; i < urls.length; i++) {
            if (signal && signal.aborted) throw new Error('已停止');
            try {
                var blob = await downloadZipFrom(urls[i], sizeHint, onProgress, signal);
                if (!(await blobLooksCompleteZip(blob))) {
                    // 截断的 zip 多半是这个源的总长取错了（见 blobLooksCompleteZip），
                    //   换下一个源整份重下，不把坏字节交给服务端
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

    /** 探测阶段的时限（毫秒）：源连不上时尽快换下一个，别陪着死连接熬 */
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

    /** 无进展超时（毫秒）：传输体这么久没收到任何新字节就中断这次 fetch */
    var IDLE_TIMEOUT_MS = 20000;

    /**
     * "收字节续命"的看门狗。
     *
     * 为什么需要：浏览器 fetch 默认没有超时，商店源链路会出现"连得上但整条卡死"
     *   （响应头已到、传输体一个字节都不再来）。探测时限只保到响应头，之后的
     *   单流/分片传输若不设看门狗，按钮会永远停在某个百分比，用户只能干等。
     *   用法：fetch 前调 kick() 起表，每收到一段数据 kick() 续命，读完 done() 撤表；
     *   超时触发 abort() 让进行中的 read() 以异常结束，交给调用方既有的重试/换源。
     *   external 是用户「停止」的外部信号，触发时同样掐断本次传输。
     *   AbortController 不可用的环境退化为无保护（与不接看门狗时一致）。
     */
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

    /**
     * 从**单个**地址下载一个 zip。
     *
     * 优先**分片并发**（见 segmentCountFor）：单流在这条链路上被限速，7~10 MB 的
     *   素材包要等几分钟；多开几条连接能把它压到几秒。
     *
     * 为什么先发一个 1 字节的 Range 请求而不是 HEAD：要同时确认三件事 ——
     *   ① 文件多大（分片边界靠它算）；② 服务端真的回 206（只看 Accept-Ranges
     *   声明不够，有的源声明了却回 200）；③ 这一跳链路此时通不通。
     *
     * 总长有两个来源：Content-Range 响应头，或调用方传入的 sizeHint（索引里声明
     *   的 sizeBytes）。跨域响应里 Content-Range 默认读不到 —— 它不在 CORS 安全
     *   响应头里，Pages 也不发 Access-Control-Expose-Headers（jsDelivr 系发）。
     *   只依赖这个头的话，分片在默认源上永远不会启动。分片边界自己算、长度自己
     *   校验（blob.size === want），sizeHint 不准时会明确失败并退回单流。
     *
     * 任何一步不成立（拿不到长度 / 非 206 / 体积太小）都**原样退回单流** ——
     *   对不支持的源是零风险，行为与不启用分片时一致。
     *
     * 为什么自己读流而不是 await res.blob()：要给用户看到进度 —— 一声不吭地等十几秒，
     *   用户会以为卡死了。拿不到 Content-Length（或环境不支持流式读取）时就退化成
     *   整体读，此时进度只显示已下载字节数。
     */
    async function downloadZipFrom(url, sizeHint, onProgress, signal) {
        // ① 探测：1 字节 Range。206 + Content-Range 才说明分片可用
        var probe = null;
        var total = 0;
        try {
            probe = await fetchWithProbeTimeout(url, { cache: 'no-store', headers: { Range: 'bytes=0-0' } }, signal);
            if (probe.status === 206) {
                // Content-Range: bytes 0-0/<total>
                var m = /\/(\d+)\s*$/.exec(String(probe.headers.get('Content-Range') || ''));
                total = m ? Number(m[1]) : (sizeHint > 0 ? sizeHint : 0);
            } else if (probe.ok) {
                // 源不支持 Range（回了 200 整个文件）—— 这个响应体就是完整文件，
                //   直接当单流用掉，不再多发一次请求
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
                // 分片走不通（源中途改口、或网络让所有分片都失败）→ 退回单流再试一次。
                //   不在这里吞错：单流也失败时抛出的是单流的错，那才是用户该看到的。
                if (onProgress) onProgress(0, 0);
            }
        }

        // ② 单流（原行为）：小包、不支持分片的源、或分片方案失败了
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

    /**
     * 把一个插件的依赖（含依赖的依赖）摊平成"先装依赖、后装本体"的安装顺序。
     *
     * 为什么要做这件事：依赖必须在**装本体之前**就位，否则本体装完直接拒绝加载
     *   （表现为"前置插件不可用"）。而用户看不出该装哪个 —— `elaina-avatar`
     *   这类资源包在列表里没有任何提示说"装 galgame 会用到它"。
     *   只提示"缺依赖、请先装上"等于把一步可自动完成的事推给用户。
     *
     * 顺序用**深度优先后序**：子依赖先入队，本体最后。这样安装包时它的依赖已经就位，
     *   装完 reload 一次就能直接生效，不会有"先失败再成功"的中间态。
     *
     * 已安装且版本不旧的依赖**不重复下载**（跳过），只装缺的那些。
     * 依赖环（a→b→a）用 visiting 集合挡住，不会死循环 —— 相互依赖本身就是坏数据，
     *   此时按"谁先遇到谁先装"处理，装完由 mods.js 的加载检查去报缺。
     *
     * @param {{id:string, depends?:string[]}} p1 目标插件
     * @param {Map<string,object>} byId 市场索引里全部插件（id → 条目）
     * @param {Map<string,object>} installed 本机已装（id → 条目）
     * @param {Set<string>} [visiting] 递归用的环检测集合
     * @returns {Array<{plugin:object, missingBehind:string[]}>} 安装顺序（依赖在前）
     */
    /* ── 下载悬浮窗（全局右下角）──────────────────────────────────────────
     *
     * 为什么要有：进度原先只画在「用户点的那颗按钮」上 —— 依赖包在按钮上永远
     *   看不见，一次装多个时更是长时间无变化；换源/重试期间界面完全静止，
     *   用户只能干等。悬浮窗按「一次安装点击 = 一行任务」展示：阶段、百分比、
     *   字节数、失败原因；钉在**应用**右下角而非市场弹窗里 —— 关掉市场去聊天
     *   也看得见，行上还能「停止」（中止这次安装）与「卸载」（装完反悔）。
     *
     * 任务表只活在内存：页面刷新即清空 —— 下载本就不能跨刷新续传，
     *   把已死的任务留在窗上是骗人。
     */

