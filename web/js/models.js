/* ============================================================================
 * 模型列表 / 组合框（从 init.js 拆出）
 *
 * 模型端点解析 / 列表拉取 / 组合框渲染 / 绑定 / 填充。
 * 依赖设置页 DOM 与 chat 请求（运行时才调用）。
 * ========================================================================== */
'use strict';

function modelsEndpointFor(baseUrl, apiFormat) {
    let base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('请先填写 API Base URL');
    // 用户可能把完整的功能地址整条粘进来（chat/completions、responses、messages），先剥掉再拼
    base = base.replace(/\/(?:chat\/completions|responses|messages)$/i, '');
    if (/\/models$/i.test(base)) return base;
    if (apiFormat === 'anthropic' && !/\/v\d+$/i.test(base)) return base + '/v1/models';
    return base + '/models';
}

/** 从模型列表响应里取模型名（OpenAI 与 Anthropic 的 `data[].id` 同构） */
function parseModelList(payload) {
    const raw = Array.isArray(payload?.data) ? payload.data : [];
    return raw
        .map(item => (typeof item === 'string' ? item : item?.id))
        .filter(Boolean)
        .map(String)
        .sort((a, b) => a.localeCompare(b));
}

// 聚合商（OpenRouter / NewAPI 系）的 /models 会带能力元数据，能直接读出"支不支持图片 / 工具"；
//   纯 OpenAI 兼容端点（如阿里云 MaaS）不带，就只能靠名字规则 + 探针（见本文件后半段）。
//   索引挂在函数属性上、而不是模块级 const：本仓库的检查脚本按"顶层函数"抽取代码运行，
//   const 不会被带过去，只有挂函数上才能"页面里能用、检查里也不炸"。
function modelCapabilityStore() {
    if (!modelCapabilityStore._map) modelCapabilityStore._map = new Map();
    return modelCapabilityStore._map;
}
function modelCapabilityKey(baseUrl, model) {
    return String(baseUrl || '').trim().replace(/\/+$/, '') + '|' + String(model || '').trim();
}

/** 从 /models 的一个条目里抽能力；认不出返回 null（绝不瞎猜）。 */
function capabilityFromModelItem(item) {
    if (!item || typeof item !== 'object') return null;
    const out = {};
    const arch = item.architecture || {};
    const inputs = arch.input_modalities || item.input_modalities || item.modalities;
    if (Array.isArray(inputs)) out.vision = inputs.map((x) => String(x).toLowerCase()).includes('image');
    const caps = item.capabilities || {};
    if (typeof caps.vision === 'boolean') out.vision = caps.vision;
    const params = Array.isArray(item.supported_parameters)
        ? item.supported_parameters.map((x) => String(x).toLowerCase()) : [];
    if (params.includes('tools') || params.includes('tool_choice') || params.includes('function_calling')) out.tools = true;
    if (typeof caps.function_calling === 'boolean') out.tools = caps.function_calling;
    if (typeof caps.tools === 'boolean') out.tools = caps.tools;
    return Object.keys(out).length ? out : null;
}

/** 把一次 /models 响应里的能力元数据收进索引（没有元数据的条目清掉旧值）。 */
function indexModelCapabilities(baseUrl, payload) {
    const raw = Array.isArray(payload?.data) ? payload.data : [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || !item.id) continue;
        const key = modelCapabilityKey(baseUrl, item.id);
        const caps = capabilityFromModelItem(item);
        const store = modelCapabilityStore();
        if (caps) store.set(key, caps);
        else store.delete(key);
    }
}

/** baseUrl + 模型名的能力结论 {vision?, tools?}；完全拿不到返回 null。 */
function capabilityForModel(baseUrl, model) {
    const hit = modelCapabilityStore().get(modelCapabilityKey(baseUrl, model));
    if (hit) return { ...hit };
    const guess = guessModelSupportsImage(model);
    return guess === true ? { vision: true } : null;
}

async function fetchModelList(baseUrl, apiKey, apiFormat) {
    const endpoint = modelsEndpointFor(baseUrl, apiFormat);
    const key = String(apiKey || '').trim();
    // Anthropic 的认证头是 x-api-key，不是 Authorization: Bearer —— 用错了会 401，
    // 而它只回 authentication_error，看不出是头用错了。
    // 但第三方中转（new-api 系）的 /v1/models 常常只认 Bearer，所以失败后**退一步再试**。
    // `limit=1000` 是 Anthropic 的上限（默认只回 20 条，不指定会静默截断）。
    const attempts = apiFormat === 'anthropic'
        ? [
            { url: endpoint + '?limit=1000', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
            { url: endpoint, headers: { Authorization: 'Bearer ' + key } }
        ]
        : [{ url: endpoint, headers: { Authorization: 'Bearer ' + key } }];
    let failure = null;
    for (const attempt of attempts) {
        let result;
        try {
            // 关键：走设备层，不要裸 fetch。
            // APK 的 WebView 里裸 fetch 会撞 CORS，而服务商并不都发 CORS 头 ——
            // 这正是「获取模型」在手机上一直失败的原因。
            result = await getJsonFromDevice(attempt.url, attempt.headers, 20000);
        } catch (error) {
            // 连不上 / 被中断：换一条路也一样，别白打第二次
            if (!failure) failure = error;
            break;
        }
        const models = result.ok ? parseModelList(result.payload) : [];
        if (models.length) {
            indexModelCapabilities(baseUrl, result.payload);
            return models;
        }
        if (!failure) {
            const fromPayload = result.payload?.error?.message || result.payload?.message || '';
            // 200 却拿回 HTML —— 这是"地址少了版本段"最典型的症状：请求打到了
            // 站点首页/网关页，而不是 API。说成"可能该服务不支持 /models"会把人
            // 引到完全错误的方向 —— 真正要改的是地址。
            // 实测：`https://newapi.gay/models` → text/html 首页；
            //       `https://newapi.gay/v1/models` 才是真接口。
            const looksHtml = /^\s*<(!doctype|html|head|body)/i.test(String(result.rawText || ''));
            const baseNoModels = endpoint.replace(/\/models$/, '');
            if (!result.ok) {
                failure = new Error(fromPayload || ('HTTP ' + result.status));
            } else if (looksHtml) {
                failure = new Error('接口返回的是网页（HTML），不是 API 响应'
                    + '\n· 实际请求：' + attempt.url
                    + '\n· 多半是 Base URL 少了版本段，试试：' + baseNoModels + '/v1'
                    + '\n  （OpenAI 兼容的 Base URL 惯例上就带 /v1，例如 https://api.deepseek.com/v1）');
            } else if (result.payload === null) {
                failure = new Error('接口返回的不是有效 JSON'
                    + '\n· 实际请求：' + attempt.url
                    + '\n· 原文开头：' + String(result.rawText || '(空)').slice(0, 120));
            } else {
                failure = new Error('接口返回的 JSON 里没有模型列表（data 为空）'
                    + '\n· 实际请求：' + attempt.url
                    + '\n· 如果这个服务确实有模型，可能是它的 /models 路径不同，或该账号下没有可用模型。');
            }
        }
        // 只有"这条路明显走不通"才换下一条。5xx / 超时换一条也一样失败。
        if (![401, 403, 404].includes(Number(result.status))) break;
    }
    throw failure || new Error('获取模型列表失败');
}
/**
 * 渲染组合框的候选列表。
 *
 * 用户要求（原话）："点右边三角显示模型列表，点击对应的模型直接替换模型上去。
 * 如果获取到的模型里有与填写的一样的，列表里就不显示名称，避免显示两个一模一样的。"
 *
 * 所以这里有一条**刻意**的规则：**当前输入框里的值不列进候选**。
 *   理由（用户明确说的）：那是"已经用着的那个"，再列一遍会看到两个一样的名字；
 *   而且点了也没有任何变化（值本来就等于它）。列表只为"换成别的"服务。
 *
 * @param {HTMLElement} listEl  浮层列表容器
 * @param {string[]} models     全部候选
 * @param {string} current      输入框当前值（会被排除）
 * @param {(m:string)=>void} onPick 选中回调
 */
function renderModelComboList(listEl, models, current, onPick) {
    if (!listEl) return;
    const cur = String(current || '').trim();
    // 排除与当前值相同的项（用户要求：避免显示两个一模一样的）
    const shown = models.filter((m) => m !== cur);
    listEl.innerHTML = '';
    if (!shown.length) {
        // 全部候选都等于当前值（或本来就没有）→ 给一句说明，
        // 否则用户点了三角看到一个空框，会以为功能坏了。
        const empty = document.createElement('div');
        empty.className = 'model-combo-empty';
        empty.textContent = models.length
            ? '列表里只有当前这个模型。'
            : '还没有拉到模型列表 —— 先点「获取模型」。';
        listEl.appendChild(empty);
        return;
    }
    for (const m of shown) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'model-combo-item';
        item.setAttribute('role', 'option');
        item.textContent = m;
        item.addEventListener('click', () => {
            onPick(m);
            closeModelCombo(listEl);
        });
        listEl.appendChild(item);
    }
}

/** 收起某个组合框的浮层 */
function closeModelCombo(listEl) {
    if (!listEl) return;
    listEl.classList.add('hidden');
    const combo = listEl.closest('.model-combo');
    if (combo) combo.classList.remove('is-open');
    const btn = combo && combo.querySelector('.model-combo-toggle');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

/**
 * 给一组「输入框 + 三角按钮 + 浮层列表 + 隐藏的 select」接上组合框行为。
 *
 * @param {object} cfg
 * @param {HTMLInputElement} cfg.input   真正取值的输入框
 * @param {HTMLButtonElement} cfg.toggle 右侧三角
 * @param {HTMLElement} cfg.list         浮层列表
 * @param {HTMLSelectElement} cfg.select 候选数据源（隐藏，沿用既有 id）
 */
function bindModelCombo({ input, toggle, list, select }) {
    if (!input || !toggle || !list || !select) return;

    /** 当前 select 里有哪些候选 */
    const candidates = () => [...select.options].map((o) => o.value);

    /** 用输入框的当前值刷新列表内容（排除同名项） */
    const refresh = () => renderModelComboList(list, candidates(), input.value, (m) => {
        input.value = m;
        select.value = m;
        // 改完要让宿主知道值变了（自动保存靠 change/input 事件）
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    toggle.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const willOpen = list.classList.contains('hidden');
        // 先关掉**其它**组合框（只允许一个展开）
        document.querySelectorAll('.model-combo-list').forEach((el) => {
            if (el !== list) closeModelCombo(el);
        });
        if (willOpen) {
            // 每次展开都重新渲染：输入框的值可能已经改了，
            //   而"排除同名项"依赖它 —— 不重渲染就会漏掉"刚刚变成同名"的那一项。
            refresh();
            list.classList.remove('hidden');
            const combo = list.closest('.model-combo');
            if (combo) combo.classList.add('is-open');
            toggle.setAttribute('aria-expanded', 'true');
        } else {
            closeModelCombo(list);
        }
    });

    // 点别处 / 按 Esc 收起
    document.addEventListener('click', (ev) => {
        if (list.classList.contains('hidden')) return;
        const combo = list.closest('.model-combo');
        if (combo && !combo.contains(ev.target)) closeModelCombo(list);
    });
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') closeModelCombo(list);
    });
    // 输入框的值变了 → 若列表正开着，同步刷新（"排除同名项"要跟着变）
    input.addEventListener('input', () => {
        if (!list.classList.contains('hidden')) refresh();
    });

    // 暴露给 populateModelSelect 用：拉到列表后立刻刷新浮层内容
    input.__modelComboRefresh = refresh;
}

async function populateModelSelect({ btn, input, select, baseUrl, apiKey, apiFormat, defaultModels }) {
    const old = btn.textContent;
    btn.textContent = '⏳ 获取中…';
    try {
        const models = await fetchModelList(baseUrl, apiKey, apiFormat);
        if (!models.length) throw new Error('接口未返回模型列表（data 为空），可能该服务不支持 /models');
        select.innerHTML = '';
        for (const m of models) {
            const o = document.createElement('option');
            o.value = m; o.textContent = m;
            select.appendChild(o);
        }
        // select **保持隐藏**：它只是候选数据源，不再是可见控件。
        //   可见的那个是右三角展开的浮层（见 bindModelCombo / renderModelComboList）——
        //   "输入的地方"与"下拉的地方"合成一处，避免输入框下方还挂着一个下拉框。
        //   所以这里**不要**取消 hidden。
        select.onchange = () => { input.value = select.value; };            // 必须把模型名**填进输入框** —— 真正发给服务商的是 input 的值
        // （见 readProviderSettingsForm），只填下拉框等于这个功能没生效。
        // 真实故障：Anthropic 下切格式时会自动填预设名 `claude-sonnet-4-20250514`，
        // 而它通常不在服务端真实返回的列表里。只在"输入框的值恰好就在列表里"
        // 时才回写下拉框选中项、从不写 input 的话，列表是拉到了，发出去的却还是
        // 那个不存在的预设名，一对话就 404。所以必须回写 input。
        // 四种情况分开处理（**顺序很重要**）：
        //   ① 输入框的值在列表里          → 原样保留。这一条必须放最前：
        //      预设名恰好有效时也该保留，否则会把用户当前用的模型
        //      悄悄换成列表里字母序第一个（如 claude-haiku），属于越权改动。
        //   ② 输入框为空                  → 填列表第一项（否则"拉到了但没选"，等于没用）
        //   ③ 输入框里是**预设默认值**     → 覆盖成列表第一项。那是切格式时应用自动填的，
        //                                   已证明不在真实列表里，留着必然 404。
        //   ④ 其它手填的值不在列表里       → **不覆盖**（可能是中转站的私有别名，
        //                                   用户是故意填的），但下拉框选中第一项，
        //                                   用户点一下即可换过去。
        const current = String(input.value || '').trim();
        const isStalePreset = Array.isArray(defaultModels) && defaultModels.includes(current);
        if (current && models.includes(current)) {
            select.value = current;
        } else if (!current || isStalePreset) {
            input.value = models[0];
            select.value = models[0];
        } else {
            select.value = models[0];
        }
        // 候选刚换了一批，立刻刷新浮层内容。
        //   注意**这里不需要展开列表** —— 用户点的是「获取模型」，
        //   他的意图是"把列表拉下来备用"，不是"现在就要选"。
        //   展开由右三角负责（见 bindModelCombo）。这也是用户要的分工：
        //   "点右边三角显示模型列表"。
        if (typeof input.__modelComboRefresh === 'function') input.__modelComboRefresh();
    } catch (err) {
        // 上面各分支已经给出**具体**原因（HTML 首页 / 非 JSON / data 为空 / HTTP 码）。
        // 这里只兜底浏览器层失败 —— 那种情况错误信息里只有一句 "Failed to fetch"，
        // 不说清的话用户会以为是地址或 Key 写错了。
        const detail = String(err?.message || err);
        const isNetwork = /Failed to fetch|NetworkError|Load failed/i.test(detail);
        showCustomAlert(
            '获取模型列表失败：' + detail
            + (isNetwork
                ? '\n\n这是**浏览器层面**的失败，不是地址或 Key 错。最常见的原因是服务商没发 CORS 响应头；'
                  + '\n用 启动.bat 打开页面会自动走本机中转绕开它，直接双击 index.html 则不走中转。'
                : '')
            + '\n\n拉不到列表不影响使用 —— 把模型名直接手填进上面的输入框即可。',
            '获取模型'
        );

    } finally {
        btn.textContent = old;
        try { if (typeof updateChatModelVisionHint === 'function') updateChatModelVisionHint(); } catch (e) { /* 提示刷新失败不影响列表 */ }
    }
}

// ===== 对话模型「是否支持图片」的识别 =====
// 为什么不能只看 /models 列表：OpenAI 兼容的 /models 通常只回 id，没有模态字段；
//   名字规则又会被自定义模型名 / 中转别名骗。所以给两种判据：
//     ① 名字规则（零成本，只作提示）；
//     ② 探针请求（发一张 1×1 小图实测，最可靠，结论缓存到设置里）。

/** 缓存键：同一个 baseUrl + 模型名才算同一次结论，换了任一个都作废。 */
function modelVisionCacheKey(baseUrl, model) {
    return String(baseUrl || '').trim().replace(/\/+$/, '') + '|' + String(model || '').trim();
}

/** 按模型名猜是否多模态。零成本但可能不准，只用来给提示，不作硬判据。 */
function guessModelSupportsImage(model) {
    const m = String(model || '').toLowerCase();
    if (!m) return null;
    if (/(?:^|[-_/])(?:vl|vision|omni)(?:$|[-_/0-9])/.test(m)) return true;
    if (/gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|claude-3|claude-4|gemini|glm-4v|qwen-vl|qwen2\.5-vl|qwen3-vl|internvl|llava|minicpm-v|pixtral|step-1v|ernie-4\.5-vl/.test(m)) return true;
    return null;
}

/**
 * 实测一个对话模型是否接受图片输入。返回 true / false / null（探测不了）。
 * 判定：HTTP 2xx → 接受；错误文本命中"不支持图片" → 不接受；其它（鉴权 / 网络 / 路径错） → null。
 */
async function probeModelImageSupport({ baseUrl, apiKey, apiFormat, model }) {
    const modelName = String(model || '').trim();
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base || !modelName) return null;
    const key = String(apiKey || '').trim();
    const fmt = apiFormat || 'openai-compatible';
    // 探针图：1×1 透明 PNG。写成本地常量而不是模块级 const —— 检查脚本只抽顶层函数。
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    let url; let headers; let body;
    if (fmt === 'anthropic') {
        url = /\/v\d+$/.test(base) ? base + '/messages' : base + '/v1/messages';
        headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
        body = { model: modelName, max_tokens: 1, messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
            { type: 'text', text: 'ok' }] }] };
    } else if (fmt === 'openai-responses') {
        url = /\/responses$/.test(base) ? base : base + '/responses';
        headers = { Authorization: 'Bearer ' + key };
        body = { model: modelName, max_output_tokens: 16, input: [{ role: 'user', content: [
            { type: 'input_image', image_url: dataUrl },
            { type: 'input_text', text: 'ok' }] }] };
    } else {
        url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
        headers = { Authorization: 'Bearer ' + key };
        body = { model: modelName, max_tokens: 1, messages: [{ role: 'user', content: [
            { type: 'text', text: 'ok' },
            { type: 'image_url', image_url: { url: dataUrl } }] }] };
    }
    let result;
    try {
        result = await postJsonFromDevice(url, body, headers, { timeoutMs: 20000 });
    } catch (err) {
        return null;
    }
    if (result && result.ok) return true;
    const msg = String(result?.payload?.error?.message || result?.payload?.message || result?.rawText || '');
    if (/not a multimodal|not multimodal|does not support (image|vision)|vision.*not supported|multimodal model|image.*not supported|invalid.{0,6}image|image.{0,6}invalid|不支持.{0,6}图片|无法.{0,6}图片/i.test(msg)) return false;
    return null;
}

/** 设置里缓存的"主模型能否收图"结论：true / false / null（未测或已过期）。 */
function cachedModelImageVerdict() {
    const key = modelVisionCacheKey(state.settings.baseUrl, state.settings.model);
    if (!state.settings.chatModelVisionKey || state.settings.chatModelVisionKey !== key) return null;
    if (state.settings.chatModelVision === true) return true;
    if (state.settings.chatModelVision === false) return false;
    return null;
}

/** 把探测结论写进设置并落盘（供手机操作判断用不用截图）。 */
function rememberModelImageVerdict(verdict, baseUrl, model) {
    state.settings.chatModelVision = verdict === true ? true : (verdict === false ? false : null);
    state.settings.chatModelVisionKey = verdict === null ? '' : modelVisionCacheKey(baseUrl, model);
    try { persistSettings(); } catch (e) { /* 缓存写不进不该挡住任何主流程 */ }
}

/** 刷新设置页那行"这个模型能不能收图"的提示。 */
function updateChatModelVisionHint() {
    const hint = document.getElementById('chatModelVisionHint');
    if (!hint) return;
    const baseUrl = document.getElementById('settingBaseUrl')?.value || '';
    const model = document.getElementById('settingChatModel')?.value || '';
    if (!String(model).trim()) { hint.textContent = ''; return; }
    const key = modelVisionCacheKey(baseUrl, model);
    const cached = (state.settings.chatModelVisionKey === key) ? state.settings.chatModelVision : null;
    // 判据优先级：探针实测 > 接口元数据 > 模型名规则。
    const meta = (typeof capabilityForModel === 'function') ? capabilityForModel(baseUrl, model) : null;
    const img = (cached === true) ? true
        : (cached === false) ? false
            : (meta && typeof meta.vision === 'boolean') ? meta.vision
                : (guessModelSupportsImage(model) === true ? true : null);
    const tool = (meta && typeof meta.tools === 'boolean') ? meta.tools : null;
    const mark = (v) => (v === true ? '✓' : (v === false ? '✗' : '？'));
    const parts = ['图片 ' + mark(img)];
    if (tool !== null) parts.push('工具 ' + mark(tool));
    let detail;
    if (cached === true) detail = '已实测能收图片，手机截图会直接给它看。';
    else if (cached === false) detail = '已实测收不了图片，手机会退回读控件树（想看画面请在下面配「视觉模型」）。';
    else if (meta && meta.vision === false) detail = '接口元数据说它只支持文本（收不了图片）。';
    else if (meta && meta.vision === true) detail = '接口元数据说它支持图片。';
    else if (img === true) detail = '按模型名看应该是多模态，建议点「检测图片能力」实测一下。';
    else detail = '点「检测图片能力」发一张 1×1 小图实测（几乎不耗 token）。';
    hint.textContent = '🧩 能力：' + parts.join(' · ') + ' —— ' + detail;
}

/** 手动探测：读当前表单 → 探针 → 写缓存 → 刷新提示。 */
async function detectChatModelVision() {
    const baseUrl = document.getElementById('settingBaseUrl')?.value || '';
    const apiKey = document.getElementById('settingApiKey')?.value || '';
    const apiFormat = document.getElementById('settingApiFormat')?.value || 'openai-compatible';
    const model = document.getElementById('settingChatModel')?.value || '';
    const hint = document.getElementById('chatModelVisionHint');
    const btn = document.getElementById('probeChatModelVisionBtn');
    if (!String(baseUrl).trim() || !String(model).trim()) {
        if (hint) hint.textContent = '先填好 API Base URL 与模型名，再点检测。';
        return;
    }
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '⏳ 检测中…'; }
    if (hint) hint.textContent = '正在发一个 1×1 小图探测…';
    let verdict = null;
    try { verdict = await probeModelImageSupport({ baseUrl, apiKey, apiFormat, model }); }
    catch (err) { verdict = null; }
    rememberModelImageVerdict(verdict, baseUrl, model);
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || '检测图片能力'; }
    updateChatModelVisionHint();
    if (verdict === null) showCustomAlert('没能判定这个模型是否支持图片（可能是网络 / 鉴权 / 路径问题）。\n\n可以先用着 —— 实际操作时应用也会自动判断；或检查地址与 Key 后再点一次。', '检测图片能力');
}

