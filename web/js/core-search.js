/* ============================================================================
 * 联网搜索：服务商清单与宽松解析（从 core.js 拆出）
 *
 * SEARCH_PROVIDERS / DEFAULT_SEARCH_PROVIDER / resolveSearchEndpoint /
 * parseLooseSearchPayload。纯数据与纯解析，无 state / DOM / 网络副作用。
 * ========================================================================== */
'use strict';

const SEARCH_PROVIDERS = Object.freeze({
    tavily: {
        label: 'Tavily',
        endpoint: 'https://api.tavily.com/search',
        keyHint: 'tvly-...',
        keyUrl: 'tavily.com',
        maxResultsLimit: 20,
        freeNote: '每月 1000 次（无需绑卡）。国内偶尔连接超时。',
        quotaHint: 'Tavily 免费额度是每月 1000 次。到 tavily.com 的 Dashboard 看本月用量；'
            + '额度按自然月重置，不是用完就永久没了。',
        buildBody: (query, opts) => ({
            query,
            search_depth: opts.depth === 'advanced' ? 'advanced' : 'basic',
            max_results: opts.maxResults,
            include_answer: true,
        }),
        buildHeaders: (key) => ({ 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }),
        parse: (payload) => ({
            answer: String(payload?.answer || ''),
            items: (Array.isArray(payload?.results) ? payload.results : []).map((r) => ({
                title: r?.title, url: r?.url, content: r?.content, date: '',
            })),
        }),
    },
    custom: {
        label: '自定义',
        // 端点由用户填，所以这里是函数而不是字符串 —— 见 resolveSearchEndpoint。
        endpoint: () => String(state.settings.searchCustomEndpoint || '').trim(),
        keyHint: '你的 Key',
        keyUrl: '',
        maxResultsLimit: 100,
        freeNote: '用你自己的搜索服务，额度与计费由那边决定。',
        quotaHint: '到你所用的搜索服务控制台查看额度。',
        // 请求体可覆盖：不同家字段名不一样（query / q、count / num / max_results）。
        //   留空时用一份"最常见的写法"，至少能跑通多数自建服务。
        buildBody: (query, opts) => {
            const tpl = String(state.settings.searchCustomBody || '').trim();
            if (tpl) {
                // 只做两个占位符替换，不做表达式求值 —— 这里的内容来自用户输入。
                const filled = tpl
                    .replace(/\{\{?query\}?\}/g, JSON.stringify(query).slice(1, -1))
                    .replace(/\{\{?count\}?\}/g, String(opts.maxResults));
                try { return JSON.parse(filled); } catch { /* 解析不了就退回默认体 */ }
            }
            return { query, count: opts.maxResults };
        },
        buildHeaders: (key) => {
            // 鉴权头可覆盖：有的家要 Authorization: Bearer，有的要 x-api-key，
            //   还有的要塞进 body。这里只覆盖**头**，body 走 buildBody。
            const style = String(state.settings.searchCustomAuth || 'bearer');
            if (style === 'x-api-key') return { 'x-api-key': key, 'Content-Type': 'application/json' };
            if (style === 'none') return { 'Content-Type': 'application/json' };
            const name = String(state.settings.searchCustomAuthHeader || 'Authorization').trim() || 'Authorization';
            const value = style === 'raw' ? key : 'Bearer ' + key;
            return { [name]: value, 'Content-Type': 'application/json' };
        },
        parse: (payload) => parseLooseSearchPayload(payload, String(state.settings.searchCustomResultsPath || '').trim()),
    },
});
/** 默认服务商：Tavily（唯一内置的一家，额度与计费都明确） */
const DEFAULT_SEARCH_PROVIDER = 'tavily';

/** 端点可能是字符串（内置）或函数（自定义源），统一在这里取。 */
function resolveSearchEndpoint(def) {
    const raw = typeof def?.endpoint === 'function' ? def.endpoint() : def?.endpoint;
    return String(raw || '').trim();
}

/**
 * 从"结构未知"的返回里找出结果数组与各字段。
 *
 * 为什么要这么宽松：自定义源可能是博查、Serper、自建服务或别的什么，
 *   字段名从 title/name 到 url/link 都有可能。要求用户手写 JSONPath 太劝退，
 *   而"找数组 + 按别名找字段"能覆盖绝大多数真实接口 —— 找错了也有
 *   resultsPath 这一个逃生口。
 *
 * @param {object} payload 解析后的 JSON
 * @param {string} pathHint 用户指定的结果数组路径（点号分隔），空则自动找
 */
function parseLooseSearchPayload(payload, pathHint) {
    const TITLE_KEYS = ['title', 'name', 'headline', 'subject'];
    const URL_KEYS = ['url', 'link', 'href', 'uri', 'sourceUrl'];
    const CONTENT_KEYS = ['content', 'text', 'snippet', 'summary', 'description', 'body', 'excerpt'];
    const DATE_KEYS = ['date', 'publishedDate', 'datePublished', 'published_date', 'published_at'];

    const pick = (obj, keys) => {
        for (const k of keys) {
            const v = obj?.[k];
            if (typeof v === 'string' && v.trim()) return v;
        }
        return '';
    };
    const readPath = (obj, path) => {
        let cur = obj;
        for (const seg of String(path || '').split('.').filter(Boolean)) {
            if (cur == null) return undefined;
            cur = Array.isArray(cur) && /^\d+$/.test(seg) ? cur[Number(seg)] : cur[seg];
        }
        return cur;
    };
    const looksLikeResult = (v) => v && typeof v === 'object'
        && (pick(v, URL_KEYS) || pick(v, TITLE_KEYS));

    let list = null;
    if (pathHint) {
        const v = readPath(payload, pathHint);
        if (Array.isArray(v)) list = v;
    }
    if (!list) {
        // 常见容器先按名字试（命中率最高，也最省事），再退回广度扫描。
        const candidates = [
            payload?.results, payload?.items, payload?.data, payload?.hits,
            payload?.organic, payload?.documents,
            payload?.data?.results, payload?.data?.items, payload?.data?.value,
            payload?.data?.webPages?.value, payload?.webPages?.value,
            payload?.response?.results, payload?.response?.docs,
        ];
        list = candidates.find((v) => Array.isArray(v) && v.some(looksLikeResult)) || null;
    }
    if (!list) {
        // 兜底：两层之内找第一个"看起来像结果"的数组。
        const scan = (node, depth) => {
            if (depth > 2 || !node || typeof node !== 'object') return null;
            for (const v of Object.values(node)) {
                if (Array.isArray(v) && v.some(looksLikeResult)) return v;
                if (v && typeof v === 'object') {
                    const found = scan(v, depth + 1);
                    if (found) return found;
                }
            }
            return null;
        };
        list = scan(payload, 0) || [];
    }
    return {
        answer: String(payload?.answer || payload?.data?.answer || '').trim(),
        items: list.filter(looksLikeResult).map((r) => ({
            title: pick(r, TITLE_KEYS),
            url: pick(r, URL_KEYS),
            content: pick(r, CONTENT_KEYS),
            date: pick(r, DATE_KEYS),
        })),
    };
}
// 密钥名清单。**加一个就要同步三处**（AGENTS.md D13 / 契约表 A21）：
//   ① 这里；② android-app 的 ByokSecretsPlugin.ALLOWED_NAMES（D10 已登记例外）；
//   ③ 开发文档 表 A11。漏了 ② 的表现是"手机上填好的 Key 退出应用就没了"——
//   因为 loadApiSecrets 读不到值会把内存里的 Key 覆盖成空串。

