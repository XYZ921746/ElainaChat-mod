// AI 用浏览器（Chrome DevTools Protocol）的回归检查。
// 帧编解码是纯函数，穷举断言即可；安全边界（协议白名单 / 只认本机 / 用户开关）
// 前端可被绕过，必须钉在服务端。没装浏览器时按环境性跳过，不判红。
// 用法：node scripts/check-browser.mjs            跑全部
//       node scripts/check-browser.mjs 协议       只跑名字含该子串的用例
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { runChecks, ROOT } from './check-harness.mjs';
import { readHtmlAndStyles } from './frontend-sources.mjs';
import { extractFunction, extractTopLevelFunctions, extractVariable, makeVmSandbox, runClassicScripts } from './check-source.mjs';


/** agent 的全局脚本集合：搜索实现已拆到 agent-search.js，按 index.html 顺序拼接 */
const AGENT_SOURCES = ['agent-parse.js', 'agent.js', 'agent-search.js'].map((f) => path.join(ROOT, 'web', 'js', f));
function readAgentSources() {
    return AGENT_SOURCES.map((f) => readFileSync(f, 'utf8')).join('\n');
}

/** 用解码器吃一段字节，返回收到的消息列表（同步收集，便于断言） */
function decodeAll(chunks) {
    const messages = [];
    let closed = false;
    const decoder = createFrameDecoder({
        onMessage: (t) => messages.push(t),
        onClose: () => { closed = true; },
    });
    for (const c of chunks) decoder.push(c);
    return { messages, closed };
}

/** 按 RFC 6455 手搓一个**服务端→客户端**的帧（不掩码），用来喂解码器 */
function serverFrame(opcode, payload, { fin = true } = {}) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
    return Buffer.concat([header, data]);
}

/** 按函数名抠出完整函数声明：先配圆括号跳过参数表再配花括号（默认值 {} 与字符串 '}' 会带跑 naive 配对） */
const extractFnNamed = (source, name) => extractFunction(source, name, { required: false });


// 4. 服务端接线（源码断言：跨文件的安全边界只能这样钉）
async function caseWiring(c) {
    const httpapi = readFileSync(path.join(ROOT, 'server', 'internal', 'httpapi', 'browser.go'), 'utf8')
        + readFileSync(path.join(ROOT, 'server', 'internal', 'httpapi', 'server.go'), 'utf8');
    const browser = readFileSync(path.join(ROOT, 'server', 'internal', 'browser', 'browser.go'), 'utf8');
    const agent = readAgentSources();
    const tags = readFileSync(path.join(ROOT, 'web', 'js', 'agent-tags.js'), 'utf8');

    const wiring = [
        [httpapi, '/api/agent/browser', '服务端有 /api/agent/browser 路由'],
        [httpapi, 'isLocal(r)', '★ 浏览器接口只认本机（局域网设备一律拒绝）'],
        [httpapi, 'browserDenyReason', '关闭档下浏览器整块不可用'],
        [httpapi, 'browserEnabledByUser', '★ 服务端自己读设置里的开关（不信前端传来的）'],
        [httpapi, 'store.SettingsKey', '读设置走 Store 键（不自己拼 store.json 路径）'],

        [browser, '--remote-debugging-port=0', '★ 调试端口由内核分配（不写死，避免撞上用户自己的调试实例）'],
        [browser, '--remote-debugging-address=127.0.0.1', '★ 调试端口只绑回环'],
        [browser, 'os.MkdirTemp', '★ 独立临时 profile（不碰用户正在用的浏览器）'],
        [agent, "name: 'browser'", '前端注册了浏览器操作'],
        [agent, 'runAgentBrowserOperation', '有统一执行器'],
        [agent, 'agentBrowserEnabled', '执行器里再判一次用户开关（标签通道可绕过 available）'],
        [tags, "browser_action: '浏览器'", '工具名 → 中文标签名有映射'],
        [tags, "/^(浏览器|网页|打开网址)/", '标签分发锚定开头（不与电脑命令互吃）'],
    ];
    const missing = wiring.filter(([src, needle]) => !src.includes(needle)).map(([, needle, label]) => label || needle);
    c.ok(missing.length === 0, '★ 浏览器接线完整（路由 / 安全边界 / 注册 / 标签）', missing.join(' / '));

    c.ok(!/--remote-debugging-port=9\d{3}/.test(browser), '★ 没有写死调试端口');
    c.ok(/Scheme != "http" && u.Scheme != "https"/.test(browser), '★ 协议白名单只有 http/https');
    c.ok(!/file:\/\//.test(browser.replace(/\/\/.*$/gm, '')), 'browser.go 不主动使用 file:// 协议');
}


// 5. 联网搜索（Tavily）：纯函数部分
async function caseWebSearch(c) {
    const src = readAgentSources();
    // 装 agent-search.js 的整个顶层函数环境 + 两个截断常量：formatSearchResult 以后拆出 helper 也不用改
    const searchSrc = readFileSync(path.join(ROOT, 'web', 'js', 'agent-search.js'), 'utf8');
    const searchSandbox = makeVmSandbox({});
    vm.runInContext(
        [extractVariable(searchSrc, 'TAVILY_SNIPPET_MAX'), extractVariable(searchSrc, 'TAVILY_OUTPUT_MAX')].join('\n')
        + '\n' + extractTopLevelFunctions(searchSrc),
        searchSandbox,
        { filename: 'agent-search.js#format-env' },
    );
    const format = searchSandbox.formatSearchResult;
    const snippetMax = vm.runInContext('TAVILY_SNIPPET_MAX', searchSandbox);
    const outputMax = vm.runInContext('TAVILY_OUTPUT_MAX', searchSandbox);
    c.ok(typeof format === 'function', 'agent-search.js 里有可用的 formatSearchResult');

    {
        const text = format('测试', {
            answer: '这是一段摘要',
            items: [
                { title: '结果一', url: 'https://a.example/1', content: '内容一' },
                { title: '结果二', url: 'https://b.example/2', content: '内容二' },
            ],
        }, '某服务商');
        c.ok(text.includes('这是一段摘要'), '结果里带上 Tavily 的摘要');
        c.ok(text.includes('https://a.example/1') && text.includes('https://b.example/2'), '★ 每条结果都带网址（模型据此引用来源）', text);
        c.ok(text.includes('结果一') && text.includes('内容一'), '标题与摘要都出现');
    }

    {
        const text = format('测试', { items: [] }, '');
        c.ok(text.includes('没有搜到'), '★ 没结果时明确说出来（空串会让模型以为搜过了）', text);
    }

    // 单条摘要与总长度都要截断：不截会把提示词撑爆
    {
        const long = 'x'.repeat(5000);
        const text = format('测试', { items: [{ title: 't', url: 'https://a/', content: long }] }, '');
        c.ok(text.length <= outputMax + 40, '总长度被截断到上限附近', String(text.length));
        c.ok(snippetMax > 0 && snippetMax <= 1000, '单条摘要上限是个合理的小值', String(snippetMax));
    }

    // 缺字段要能容错（Tavily 偶尔不返回 title / content）
    {
        let threw = null;
        let text = '';
        try { text = format('测试', { items: [{ url: 'https://c.example/' }] }, ''); } catch (e) { threw = e; }
        c.ok(threw === null, '结果缺 title / content 时不抛异常', threw && threw.message);
        c.ok(text.includes('https://c.example/'), '缺标题时网址仍然给出');
    }

    c.ok(/name: 'web_search', tool: 'web_search'/.test(src), '注册表里有 web_search 操作');
    c.ok(/ElainaOps\.setExec\('web_search'/.test(src), 'web_search 挂了执行实现');
    c.ok(/tavilySearchEnabled !== true\) return false/.test(src), '★ 开关关着时不可用（注册表 available 判据）');
    c.ok(/searchApiKey_' \+ id/.test(src), '★ 没填 Key 时不可用（按当前服务商那一格判）');
    c.ok(/id === 'custom'/.test(src), '★ 自定义源还必须填了 https 端点才算可用');
    c.ok(/SEARCH_PROVIDERS/.test(readFileSync(path.join(ROOT, 'web', 'js', 'core-search.js'), 'utf8')),
        '★ 服务商清单在 core.js（执行器与设置页共用同一份）');
    const tags = readFileSync(path.join(ROOT, 'web', 'js', 'agent-tags.js'), 'utf8');
    c.ok(/web_search: '搜索'/.test(tags), '工具名 → 中文标签名有映射');
    c.ok(/\^\\(搜索\\|搜一下\\|联网搜索\\|查一下\\)/.test(tags) || /搜索\|搜一下\|联网搜索\|查一下/.test(tags),
        '标签分发认「搜索」并锚定开头');
}

// 6. 搜索服务商的请求体与响应解析（形状来自各家真实响应）
async function caseSearchProviders(c) {
    const src = readFileSync(path.join(ROOT, 'web', 'js', 'core-search.js'), 'utf8');
    const table = vm.runInContext(extractVariable(src, 'SEARCH_PROVIDERS') + '\n;SEARCH_PROVIDERS', makeVmSandbox({}));
    c.ok(table && Object.keys(table).length > 0, 'core.js 里有 SEARCH_PROVIDERS');
    const ids = Object.keys(table);
    // 内置只留 Tavily + custom 自定义源：防付费/额度不透明的服务商内置回来，也防自定义源被删
    c.ok(ids.length === 2 && ids.includes('tavily') && ids.includes('custom'),
        '★ 内置只剩 Tavily，另有 custom 自定义源', ids.join(','));
    for (const gone of ['exa', 'bocha', 'serper', 'brave']) {
        c.ok(!ids.includes(gone), '不内置 ' + gone + '（额度不透明 / 付费 / 被墙）');
    }
    for (const id of ids) {
        c.ok(Boolean(table[id].freeNote), id + ' 写明了额度（设置页要如实告诉用户）');
    }
    const dflt = (src.match(/const DEFAULT_SEARCH_PROVIDER = '([^']+)'/) || [])[1];
    c.ok(dflt === 'tavily', '★ 默认服务商是 Tavily（唯一内置的一家）', String(dflt));

    // 每一条都要有完整的五件套，缺一件就会在运行时炸
    const bad = [];
    for (const [id, def] of Object.entries(table)) {
        for (const k of ['label', 'endpoint', 'buildBody', 'buildHeaders', 'parse']) {
            if (!def[k]) bad.push(id + '.' + k);
        }
        const ep = typeof def.endpoint === 'function' ? 'https://x/' : String(def.endpoint || '');
        if (!/^https:\/\//.test(ep)) bad.push(id + '.endpoint 不是 https');
    }
    c.ok(bad.length === 0, '每家都有 label / endpoint / buildBody / buildHeaders / parse', bad.join(', '));

    const bodyOf = (id, q, o) => table[id].buildBody(q, o || { maxResults: 3, depth: 'basic' });
    c.ok(JSON.stringify(bodyOf('tavily', 'x', { maxResults: 3, depth: 'advanced' }))
        .includes('"search_depth":"advanced"'), 'tavily 请求体带 search_depth');
    c.ok(bodyOf('tavily', 'x').max_results === 3, 'tavily 用 max_results');

    const h = (id) => table[id].buildHeaders('KEY');
    c.ok(h('tavily').Authorization === 'Bearer KEY', 'tavily 用 Authorization: Bearer');

    const tavily = table.tavily.parse({ answer: 'A', results: [{ title: 'T', url: 'U', content: 'C' }] });
    c.ok(tavily.answer === 'A' && tavily.items[0].title === 'T' && tavily.items[0].url === 'U', 'tavily 响应解析');
}

// 7. 搜索失败的处置（额度用完算"这家用不了"，不算是查询写错了）
async function caseSearchFailure(c) {
    // 搜索实现住在 agent-search.js（与 agent.js 同属全局脚本，按 index.html 顺序加载）
    const agent = readAgentSources();
    const core = readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');

    c.ok(/SEARCH_SWITCHABLE_STATUS\s*=\s*new Set\(\[401, 402, 403, 429\]\)/.test(agent),
        '★ 额度用完（402）与 Key 失效 / 限流一起算"可以换一家"');
    c.ok(/status === 402/.test(agent), '402 有专门的解释文案');
    c.ok(/额度用完了/.test(agent), '★ 402 的提示是"额度用完了"而不是"检查 Base URL、模型名"');

    const fn = agent.slice(agent.indexOf('function describeSearchFailure'), agent.indexOf('async function searchOnProvider'));
    const m400 = fn.match(/if \(status === (\d+)\)/g) || [];
    c.ok(!/status === 400/.test(fn), '★ 400 不触发换家（换一家会掩盖真正的原因）');

    c.ok(/这次改用了/.test(agent), '★ 自动换家时在结果里说明换了谁、为什么');
    c.ok(/alternateSearchProviderId/.test(agent), '有"另一家有没有 Key"的判据');
    c.ok(/改用 .* 也不行/.test(agent), '两家都失败时把两边原因都给出来');
    c.ok(/searchOnProvider/.test(agent), '换家复用同一个执行函数（除 id 外条件不变）');

    const settings = readFileSync(path.join(ROOT, 'web', 'js', 'providers.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');
    const testFn = settings.slice(settings.indexOf('async function testTavilyConnection'), settings.indexOf('async function withSettingsTestButton'));
    c.ok(!/ClientApiError/.test(testFn), '★ 测试按钮不借用对话模型的错误文案（那里写的是"检查 Base URL、模型名"）');
    c.ok(/额度/.test(testFn), '测试失败时也解释额度问题');
}

// 7a. 自定义搜索源：宽松解析（不要求手写 JSONPath）
async function caseCustomSource(c) {
    const core = readFileSync(path.join(ROOT, 'web', 'js', 'core-search.js'), 'utf8');
    // 装 core.js 的整个顶层函数环境 + SEARCH_PROVIDERS 常量：parseLooseSearchPayload 拆出 helper 也不用改
    const searchSandbox = makeVmSandbox({});
    vm.runInContext(
        extractVariable(core, 'SEARCH_PROVIDERS') + '\n' + extractTopLevelFunctions(core),
        searchSandbox,
        { filename: 'core.js#search-env' },
    );
    const table = vm.runInContext('SEARCH_PROVIDERS', searchSandbox);
    const loose = vm.runInContext('parseLooseSearchPayload', searchSandbox);

    // 各家真实返回形状都要能认出来
    const cases = [
        ['tavily 形状', { answer: 'A', results: [{ title: 'T', url: 'U', content: 'C' }] }, 'T'],
        ['serper 形状', { organic: [{ title: 'T', link: 'L', snippet: 'S' }] }, 'T'],
        ['博查形状', { data: { webPages: { value: [{ name: 'N', url: 'U', summary: 'S' }] } } }, 'N'],
        ['data.results 形状', { data: { results: [{ headline: 'H', href: 'X', excerpt: 'E' }] } }, 'H'],
        ['hits 容器', { hits: [{ name: 'N', url: 'U', description: 'D' }] }, 'N'],
        ['response.docs 容器', { response: { docs: [{ title: 'T', uri: 'U', body: 'B' }] } }, 'T'],
    ];
    for (const [name, payload, expectTitle] of cases) {
        let got = null;
        try { got = loose(payload, ''); } catch (e) { got = { items: [], err: String(e.message) }; }
        c.ok(got.items.length === 1 && got.items[0].title === expectTitle,
            '★ 能认出' + name, JSON.stringify(got).slice(0, 140));
    }
    c.ok(loose({ results: [{ title: 'T', link: 'L' }] }, '').items[0].url === 'L', '★ 网址字段认 link（不只 url）');
    const byPath = loose({ a: { b: [{ title: 'X', url: 'Y' }] }, results: [{ title: 'WRONG', url: 'Z' }] }, 'a.b');
    c.ok(byPath.items[0].title === 'X', '★ 填了结果路径就按它取（覆盖自动识别）');

    for (const bad of [null, {}, { results: 'not-array' }, { results: [1, 2, 3] }]) {
        let threw = null;
        try { loose(bad, ''); } catch (e) { threw = e; }
        c.ok(!threw, '畸形返回不抛：' + JSON.stringify(bad));
    }
    c.ok(typeof table.custom.endpoint === 'function', 'custom 的端点由设置提供（函数）');
}

// 7b. 402 的排查方向必须按服务商给（新账号 ≠ 余额不足）
async function caseQuotaHint(c) {
    const core = readFileSync(path.join(ROOT, 'web', 'js', 'core-search.js'), 'utf8');
    const agent = readAgentSources();
    const settings = readFileSync(path.join(ROOT, 'web', 'js', 'providers.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');

    const table = vm.runInContext(extractVariable(core, 'SEARCH_PROVIDERS') + '\n;SEARCH_PROVIDERS', makeVmSandbox({}));
    for (const id of Object.keys(table)) {
        c.ok(Boolean(table[id].quotaHint), id + ' 有 quotaHint（402 时指向正确的排查方向）');
    }
    // 只写"去充值"会让用户的排查方向跑偏，所以每家的提示都要指向**这家**的落点。
    c.ok(/自然月/.test(table.tavily.quotaHint), '★ Tavily 的提示说明额度按自然月重置（不是用完就永久没了）');
    c.ok(/tavily\.com/.test(table.tavily.quotaHint), 'Tavily 的提示给出了看用量的地址');
    c.ok(Boolean(table.custom.quotaHint), '自定义源也有额度提示（额度由用户自己的服务决定）');
    for (const id of Object.keys(table)) {
        c.ok(!/\*\*/.test(table[id].quotaHint), id + ' 的 quotaHint 不含 markdown 记号（弹窗是纯文本）');
    }
    c.ok(/describeSearchFailure\(status, detail, def\)/.test(agent), '失败描述拿到服务商定义');
    c.ok(/describeSearchFailure\(status, detail, def\)/.test(settings), '测试按钮也传了服务商定义');
}


// 7e. 第三人称下的标签回填（白名单，不能把 markdown 链接吃进去）
async function caseThirdPersonTags(c) {
    const data = readFileSync(path.join(ROOT, 'web', 'js', 'roleplay.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'chat.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8');
    const tags = readFileSync(path.join(ROOT, 'web', 'js', 'agent-tags.js'), 'utf8');

    // 装真实环境：agent-tags.js 提供 window.ElainaTags.TAG_NAMES，data.js 整个顶层函数环境装进同一沙箱
    const tagSandbox = makeVmSandbox({});
    runClassicScripts([path.join(ROOT, 'web', 'js', 'agent-tags.js')], tagSandbox);
    vm.runInContext(extractTopLevelFunctions(data), tagSandbox, { filename: 'data.js#reply-tags' });
    const fn = tagSandbox.extractReplyTags;

    // 真正认识的标签必须保留（第一人称改写不带它们，丢了就"表现/操作全失效"）
    c.ok(fn('她笑了。[表情:开心]') === '[表情:开心]', '★ 认识的标签要保留');
    c.ok(fn('[操作:搜索 天气]') === '[操作:搜索 天气]', '操作标签要保留（标签通道靠它执行）');
    c.ok(fn('[表情：难过]') === '[表情：难过]', '全角冒号也认');
    c.ok(fn('<scene>森林</scene>') === '<scene>森林</scene>', 'scene 标签要保留');

    // 白名单之外的方括号必须一个都不取 —— 否则会被追加进正文且无人剥离
    c.ok(fn('参考[这个视频](https://b23.tv/a)') === '', '★ markdown 链接不吃进去（吃了会漏进正文）');
    c.ok(fn('见 [1] 和 [2]') === '', '★ 引用编号不吃进去');
    c.ok(fn('arr[0] 与 obj[key]') === '', '★ 数组下标不吃进去');
    c.ok(fn('【故事】正文【状态】栏') === '', '【故事】/【状态】不是标签');
    // 不能靠"name 后面跟冒号"就放行任意词：否则正文里的 [注意: …] 会被当成标签
    c.ok(fn('他说[注意: 这里很滑]') === '', '★ 白名单外的"词+冒号"也不认');

    // 白名单同源：data.js 要用 ElainaTags.TAG_NAMES，只有拿不到时才用字面量兜底
    c.ok(/window\.ElainaTags[\s\S]{0,80}TAG_NAMES/.test(data), '★ 标签名优先取自 ElainaTags（唯一清单）');
    c.ok(/TAG_NAMES/.test(tags), 'agent-tags.js 导出 TAG_NAMES');
}


// 7c. 会话自动取名（招呼语不该变成标题，手动改名不该被覆盖）
async function caseConversationNaming(c) {
    const ui = readFileSync(path.join(ROOT, 'web', 'js', 'conversations.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'ui.js'), 'utf8');
    const voice = readFileSync(path.join(ROOT, 'web', 'js', 'composer.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'voice.js'), 'utf8');

    const fnSrc = (name) => {
        const s = ui.indexOf('function ' + name + '(');
        if (s < 0) return '';
        let i = ui.indexOf('{', s), d = 0, e = i;
        for (; e < ui.length; e++) { if (ui[e] === '{') d++; else if (ui[e] === '}') { d--; if (!d) { e++; break; } } }
        return ui.slice(s, e);
    };
    // 装 ui.js 的整个顶层函数环境 + TRIVIAL_CONVERSATION_TEXT 常量
    const uiSandbox = makeVmSandbox({});
    vm.runInContext(
        extractVariable(ui, 'TRIVIAL_CONVERSATION_TEXT') + '\n' + extractTopLevelFunctions(ui),
        uiSandbox,
        { filename: 'ui.js#naming-env' },
    );
    const name = uiSandbox.autoNameConversation;

    // 招呼语不该变成标题 —— 否则侧栏会堆满一模一样的"你好"
    c.ok(name([{ role: 'user', text: '你好' }]) === '新对话', '★ 只说了"你好"时保持"新对话"');
    c.ok(name([{ role: 'user', text: '在吗' }]) === '新对话', '"在吗"同样不算内容');
    c.ok(name([{ role: 'user', text: 'hi' }]) === '新对话', '"hi" 同样不算内容');
    c.ok(name([
        { role: 'user', text: '你好' },
        { role: 'ai', text: '啊，你好。' },
        { role: 'user', text: '看看这个视频' },
    ]) === '看看这个视频', '★ 跳过招呼语，用后面那条有内容的');
    c.ok(name([{ role: 'user', text: '一二三四五六七八九十一二三四五' }]).endsWith('...'), '超长文本会截断');
    c.ok(name([{ role: 'user', text: '', imageDataUrl: 'data:image/png;base64,x' }]) === '图片对话', '纯图片给"图片对话"');

    // 手动改名不该被覆盖：refresh 的判据是"标题 == 去掉最后一条后的自动名"
    c.ok(/refreshAutoConversationTitle/.test(ui), '有 refreshAutoConversationTitle');
    c.ok(/previousAuto/.test(fnSrc('refreshAutoConversationTitle')), '★ 用"上一次的自动名"判定是否为自动标题');
    c.ok(/saveConversations\(\)/.test(fnSrc('refreshAutoConversationTitle')), '改名后落盘');
    // 三个发送入口共用 commitUserMessage，命名只在该处调用一次 —— 数"收尾函数被调几次"
    const commitCalls = (voice.match(/\n    commitUserMessage\(conversation, message/g) || []).length;
    c.ok(commitCalls === 3, '★ 三个发送入口都走同一套命名（文字 / 首屏 / 语音）', String(commitCalls));
    c.ok((voice.match(/refreshAutoConversationTitle\(conversation\)/g) || []).length === 1,
        '★ 自动命名只在 commitUserMessage 里调用一次（三个入口共用）',
        String((voice.match(/refreshAutoConversationTitle\(conversation\)/g) || []).length));
    c.ok(!/conversation\.title = autoNameConversation/.test(voice), '旧的一次性命名已全部替换');
}

// 8. 图片转述的开关（生效判据必须看开关，不能只看"填没填"）
async function caseVisionToggle(c) {
    const data = readFileSync(path.join(ROOT, 'web', 'js', 'roleplay.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'chat.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'data.js'), 'utf8');
    const core = readFileSync(path.join(ROOT, 'web', 'js', 'core-config.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'core.js'), 'utf8');
    const html = readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const settings = readFileSync(path.join(ROOT, 'web', 'js', 'providers.js'), 'utf8')
        + '\n' + readFileSync(path.join(ROOT, 'web', 'js', 'settings.js'), 'utf8');

    c.ok(/visionEnabled: false/.test(core), '默认关闭（主模型能看图时转述只会丢细节）');
    c.ok(!/settingVisionEnabled/.test(html), '★ 不再是开关（下拉选「不使用」即停）');
    c.ok(!/id="visionFields"/.test(html), '★ 不再有整体显隐的字段容器（下拉常驻）');
    c.ok(/不使用图片转述/.test(settings), '★ 下拉的空选项写明「不使用图片转述」');
    c.ok(/fillVisionSettings/.test(settings), '有统一的回填函数');
    c.ok(/visionEnabled === true/.test(data), '★ data.js 的形态归一仍认 visionEnabled');
    c.ok(/visionEnabled === true/.test(settings), '★ 生效判据仍读 visionEnabled（visionConfigured）');

    // 提示必须点名"主模型能识图时选「不使用」"
    const hasHint = /本来就支持查看图片/.test(settings) && /不使用/.test(html) && /建议/.test(settings);
    c.ok(hasHint, '★ 提示写明主模型能看图时选「不使用」');
}

// 8. 标签通道的解析（把中文标签翻成结构化参数）
async function caseTagParse(c) {
    // 整脚本装载 agent-parse.js（不是抠单个函数）：以后 parseBrowserTag 依赖同文件 helper 也不会假红。
    const sandbox = makeVmSandbox({ URL });
    runClassicScripts([path.join(ROOT, 'web', 'js', 'agent-parse.js')], sandbox);
    c.ok(typeof sandbox.parseBrowserTag === 'function', 'agent-parse.js 里有可用的 parseBrowserTag');
    if (typeof sandbox.parseBrowserTag !== 'function') return;
    const parse = sandbox.parseBrowserTag;

    const cases = [
        ['浏览器', 'snapshot', '只有"浏览器"三个字 = 看页面（最保守的一步）'],
        ['浏览器看页面', 'snapshot', '看页面'],
        ['浏览器关闭', 'close', '关闭'],
        ['浏览器回车', 'press_enter', '回车'],
        ['浏览器点击 3', 'click', '点击带编号'],
        ['浏览器点击[3]', 'click', '编号带方括号也认'],
        ['浏览器输入 3|你好', 'type', '输入带编号与文字'],
        ['浏览器打开 https://example.com/a', 'goto', '完整网址'],
        ['浏览器 example.com', 'goto', '不带协议的域名也收'],
    ];
    const bad = [];
    for (const [input, want] of cases) {
        const got = parse(input);
        if (!got || got.action !== want) bad.push(input + ' → ' + JSON.stringify(got));
    }
    c.ok(bad.length === 0, '★ 中文标签解析出正确的动作', bad.join('; '));

    const typed = parse('浏览器输入 3|你好世界');
    c.ok(typed && typed.ref === '3' && typed.text === '你好世界', '输入的文字原样带出来（含竖线后的全部内容）', JSON.stringify(typed));

    // 认不出来必须返回 null：猜默认动作会在用户只想看页面时突然弹出浏览器窗口
    const unknown = ['浏览器乱写的', '', '   '].map((t) => parse(t));
    c.ok(unknown.every((x) => x === null), '★ 认不出的标签返回 null（不猜默认动作）', JSON.stringify(unknown));
}

const only = process.argv[2];
const allCases = [
                { name: '服务端接线', fn: caseWiring },
    { name: '联网搜索', fn: caseWebSearch },
    { name: '搜索服务商', fn: caseSearchProviders },
    { name: '图片转述开关', fn: caseVisionToggle },
    { name: '搜索失败处置', fn: caseSearchFailure },
    { name: '额度提示', fn: caseQuotaHint },
    { name: '自定义搜索源', fn: caseCustomSource },
    { name: '会话自动取名', fn: caseConversationNaming },
        { name: '第三人称标签回填', fn: caseThirdPersonTags },
        { name: '标签通道解析', fn: caseTagParse },
    ];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: 'AI 上网（浏览器 CDP / 网址白名单 / 动作派发 / 联网搜索 / 端到端）',
    usage: 'node scripts/check-browser.mjs [用例名子串]',
    cases,
});

