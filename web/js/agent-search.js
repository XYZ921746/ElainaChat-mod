// AI 联网搜索：服务商调用、失败分类、自动换家与结果格式化。与「浏览器」的分工：
// 搜索是一问一答地取资料，只发一次 API（更快更省）；浏览器要开窗口交互。
// 放在前端是因为 Key 是用户的（BYOK），/api/relay 只转发、不持有凭据，服务端不知道任何搜索服务商。

/** 搜索结果里单条摘要的截断长度 —— 太长会把提示词撑爆，模型也读不完 */
const TAVILY_SNIPPET_MAX = 500;
/** 一次搜索最多回灌多少字（含标题与网址） */
const TAVILY_OUTPUT_MAX = 6000;

// 把某家的响应整理成回灌给 AI 的一段话（各家的形状已由 SEARCH_PROVIDERS 的 parse 拍平）。
// 在客户端拼：两条通道拿到同一个字符串，形状才一致。结果里必须带网址，否则模型只能编一个。
function formatSearchResult(query, parsed, providerLabel) {
    const lines = [];
    const answer = String(parsed?.answer || '').trim();
    if (answer) lines.push('（搜索摘要）' + answer, '');
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    if (!items.length) {
        lines.push('没有搜到结果。可以换个说法再搜一次，或者直接告诉用户没找到。');
        return lines.join('\n');
    }
    lines.push('搜索「' + query + '」的结果' + (providerLabel ? '（' + providerLabel + '）' : '') + '：');
    items.forEach((r, i) => {
        const title = String(r?.title || '').trim() || '（无标题）';
        const url = String(r?.url || '').trim();
        const content = String(r?.content || '').replace(/\s+/g, ' ').trim().slice(0, TAVILY_SNIPPET_MAX);
        const date = String(r?.date || '').trim();
        lines.push('', (i + 1) + '. ' + title, url ? '   ' + url : '   （没有网址）',
            date ? '   （' + date + '）' : '', content ? '   ' + content : '');
    });
    let text = lines.join('\n');
    if (text.length > TAVILY_OUTPUT_MAX) text = text.slice(0, TAVILY_OUTPUT_MAX) + '\n…（结果更长，已截断）';
    return text;
}

/** 当前选中的搜索服务商（配置了不认识的 id 时回落到默认那家，不抛错） */
function currentSearchProvider() {
    const id = String(state.settings.searchProvider || '').trim();
    const def = SEARCH_PROVIDERS[id] || SEARCH_PROVIDERS[DEFAULT_SEARCH_PROVIDER];
    return { id: SEARCH_PROVIDERS[id] ? id : DEFAULT_SEARCH_PROVIDER, def };
}

// 哪些失败值得"换一家再试"。判据是"这家账号本身用不了"，而不是"这次请求写错了"：
// 401/403 Key 无效、402 额度用完、429 限流 —— 换一家能用。
// 400 之类不回退：那是请求构造的问题，换一家会以另一种方式失败，掩盖真正的原因。
const SEARCH_SWITCHABLE_STATUS = new Set([401, 402, 403, 429]);

// 失败原因翻译成一句用户能照做的话（不暴露内部字段名）。
// 带上 def 是因为 402 的原因各家不同（有的是 Key 花费上限而非余额不足），
// 这些话写在 SEARCH_PROVIDERS 的 quotaHint 里，只加通用文案会把用户指向错误的排查方向。
function describeSearchFailure(status, detail, def) {
    const tail = detail ? '：' + detail : '';
    const quota = (def && def.quotaHint) ? ' ' + def.quotaHint : '';
    if (status === 402) {
        return {
            hint: '额度用完了，或这个 Key 的花费上限被触发了。' + quota,
            switchable: true,
            tail,
        };
    }
    if (status === 401 || status === 403) {
        return { hint: 'Key 无效或没有权限，检查一下填的 Key', switchable: true, tail };
    }
    if (status === 429) {
        return { hint: '请求太频繁或额度用完了', switchable: true, tail };
    }
    if (status === 432 || status === 433) {
        return { hint: '当前套餐不支持这个参数，把搜索深度改成 basic 试试', switchable: false, tail };
    }
    return { hint: '', switchable: false, tail };
}

// 用指定的一家发一次搜索。单独拆出来让"换一家再试"复用同一段逻辑 ——
// 回退时除 id 外什么都不该变（同样的查询、条数与深度）。
// @returns {Promise<{ok:boolean, text:string, status:number, switchable:boolean}>}
async function searchOnProvider(id, query, maxResults, depth) {
    const def = SEARCH_PROVIDERS[id];
    if (!def) return { ok: false, text: '未知的搜索服务商：' + id, status: 0, switchable: false };
    const key = String(state.settings['searchApiKey_' + id] || '').trim();
    if (!key) {
        return {
            ok: false,
            status: 0,
            switchable: false,
            text: '还没有填 ' + def.label + ' 的 API Key。请在「设置 → 模型 → 对话优化 → 联网搜索」里填上。',
        };
    }
    // 自定义源的端点是用户填的，必须是 https —— Key 会随请求发出去。
    const endpoint = resolveSearchEndpoint(def);
    if (!endpoint) {
        return {
            ok: false, status: 0, switchable: false,
            text: '还没有填自定义搜索源的地址。请在「设置 → 模型 → 对话优化 → 联网搜索」里填上。',
        };
    }
    if (!/^https:\/\//i.test(endpoint)) {
        return {
            ok: false, status: 0, switchable: false,
            text: '自定义搜索源的地址必须以 https:// 开头（Key 会随请求发出去，明文 http 不安全）。',
        };
    }
    const capped = Math.max(1, Math.min(def.maxResultsLimit, maxResults));
    let result;
    try {
        result = await postJsonFromDevice(
            endpoint,
            def.buildBody(query, { maxResults: capped, depth }),
            def.buildHeaders(key),
            { timeoutMs: 30000 }
        );
    } catch (err) {
        // 连不上（国内网络常见）：这句要能让用户知道"下一步是换一家"，而不是去查 Key。
        return {
            ok: false,
            status: 0,
            switchable: true,
            text: def.label + ' 连不上：' + String((err && err.message) || err),
        };
    }
    // 有的家把业务错误放在 code 里、HTTP 200 也可能是失败；其余按状态码判。
    const bizCode = String(result.payload?.code || '').trim();
    const bizFailed = /^[45]\d\d$/.test(bizCode);
    if (!result.ok || bizFailed) {
        const detail = String(
            result.payload?.detail?.error || result.payload?.detail || result.payload?.error
            || result.payload?.message || result.rawText || ''
        ).slice(0, 300);
        const status = result.status || Number(bizCode) || 0;
        const info = describeSearchFailure(status, detail, def);
        return {
            ok: false,
            status,
            switchable: info.switchable,
            text: def.label + ' 搜索失败（HTTP ' + status + '）' + (info.hint ? '（' + info.hint + '）' : '') + info.tail,
        };
    }
    return { ok: true, text: formatSearchResult(query, def.parse(result.payload || {}), def.label), status: 0, switchable: false };
}

/** 另一家有 Key 的服务商（用于"这家用不了就换那家"）。没有则返回 '' */
function alternateSearchProviderId(primaryId) {
    for (const id of Object.keys(SEARCH_PROVIDERS)) {
        if (id === primaryId) continue;
        if (String(state.settings['searchApiKey_' + id] || '').trim()) return id;
    }
    return '';
}

// 真发一次搜索。服务商由设置决定，执行器只认 SEARCH_PROVIDERS 这张表。
// 失败一律返回 {ok:false, text}，不抛 —— 调用方要把原因原样回灌给模型。
// 自动换一家：主服务商账号本身用不了时，另一家也填了 Key 就直接再搜一次，并在结果开头
// 如实说明换了谁、为什么 —— 额度花在另一家账号上，不能悄悄换。
async function webSearchQuery(query) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, text: '没有给出要搜索的内容' };
    if (state.settings.tavilySearchEnabled !== true) {
        return { ok: false, text: '联网搜索没有打开。需要的话请在「设置 → 模型 → 对话优化 → 联网搜索」里打开。' };
    }
    const { id, def } = currentSearchProvider();
    const maxResults = Number(state.settings.tavilyMaxResults) || 5;
    const depth = state.settings.tavilySearchDepth === 'advanced' ? 'advanced' : 'basic';

    const first = await searchOnProvider(id, q, maxResults, depth);
    if (first.ok) return first;

    if (first.switchable) {
        const altId = alternateSearchProviderId(id);
        if (altId) {
            const alt = await searchOnProvider(altId, q, maxResults, depth);
            if (alt.ok) {
                const why = /额度/.test(first.text) ? '额度用完了' : (/连不上/.test(first.text) ? '连不上' : '用不了');
                return {
                    ok: true,
                    status: 0,
                    switchable: false,
                    text: '（' + def.label + ' ' + why + '，这次改用了 ' + SEARCH_PROVIDERS[altId].label + '）\n' + alt.text,
                };
            }
            // 两家都不行：把两边的原因都给出来，别让用户只看到后一家的（他可能只想修前一家）
            return { ok: false, text: first.text + '\n改用 ' + SEARCH_PROVIDERS[altId].label + ' 也不行：' + alt.text };
        }
    }
    return first;
}

// 执行一次「联网搜索」操作（两条通道共用），约定同 runAgentBrowserOperation：
// 工具通道由 runToolCalls 回灌 role:'tool'，标签通道自己插 + 续跑。
async function runAgentWebSearch(args, traceItem) {
    const query = String((args && args.query) || '').trim();
    const ownTrace = !traceItem;
    if (ownTrace) {
        traceItem = recordTurnTool({
            kind: 'search',
            title: '联网搜索',
            summary: query,
            args: JSON.stringify({ query }),
            state: 'running',
        });
    } else {
        updateTurnTool(traceItem, { kind: 'search', title: '联网搜索', summary: query });
    }
    if (!query) {
        const m = '没有给出要搜索的内容。请在 query 里写清楚要查什么。';
        updateTurnTool(traceItem, { state: 'error', result: m });
        return { ok: false, text: m };
    }
    const res = await webSearchQuery(query);
    if (!res.ok) {
        updateTurnTool(traceItem, { state: 'error', result: res.text });
        // 失败不插可见气泡就走工具通道；标签通道让角色自己解释（与文件操作同一条规则）
        if (ownTrace) await explainAgentFailure(res.text);
        return { ok: false, text: res.text };
    }
    const text = String(res.text || '');
    updateTurnTool(traceItem, {
        state: 'ok',
        result: text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断）' : text,
    });
    if (ownTrace) insertAgentResult(text, { continueLoop: true, asContext: true });
    return { ok: true, text };
}

