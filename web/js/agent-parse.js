/* ========================================================================
 * Agent 纯解析 / 格式化工具
 * ------------------------------------------------------------------------
 * 这里的函数只做**字符串变换**：不读 state、不碰 DOM、不发网络、不写存储。
 * 把它们单独放一个脚本，是为了让"解析/展示"这类无副作用逻辑能被单独测试，
 * 也让 agent.js 只保留真正有状态、有副作用的执行路径。
 *
 * 加载顺序：本文件必须在 agent.js **之前**加载（经典脚本的顶层函数/const
 * 会成为后续脚本可见的全局；agent.js 在运行期调用这些函数）。
 * ======================================================================== */

/** 手机操作动作名（parsePhoneOperation 用 startsWith 顺序匹配；长的项必须在前） */
const AGENT_PHONE_OPS = [
    '手机查看界面', '手机状态', '手机截图', '手机等待',
    '手机点击', '手机滑动', '手机输入', '手机按键', '手机打开', '手机命令',
    // 读取信息（受隐私开关控制）+ 工作区文件访问。
    //   ⚠️ 顺序有讲究：'手机应用列表' 必须排在 '手机查看界面' 之后，且任何
    //   前缀更短的项之前 —— parsePhoneOperation 用的是 startsWith 顺序匹配。
    //   这里没有互为前缀的项，但仍按"长的在前"排，将来加项时不容易踩。
    '手机应用列表', '手机通知', '手机设备信息',
    '手机通讯录', '手机日历', '手机短信',
    '手机列出文件', '手机读文件', '手机写文件', '手机删除文件',
];

/**
 * 回忆检索（recall_search）的日期/摘录工具：在**磁盘上的完整对话 + 日记**里找原文，
 * 只读、不产生任何副作用 —— 它是"上下文只带压缩记忆"这层设计的补门。
 */
function recallDateHintOf(input) {
    const t = String(input || '').trim();
    if (!t) return null;
    let m = t.match(/(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/);
    if (m) return { y: +m[1], m: +m[2], d: +m[3] };
    m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (m) return { m: +m[1], d: +m[2] };
    m = t.match(/^(\d{1,2})[-/.](\d{1,2})$/);
    if (m) return { m: +m[1], d: +m[2] };
    return null;
}

/** 日记日期串（"2026年8月11日" / "2026-08-11"）与用户给的日期提示是否同一天 */
function recallDiaryDateMatches(hint, dateStr) {
    if (!hint) return false;
    const t = String(dateStr || '');
    if (!t) return false;
    const pad = (n) => String(n).padStart(2, '0');
    if (hint.y != null) {
        return t.includes(`${hint.y}年${hint.m}月${hint.d}日`) || t.includes(`${hint.y}-${pad(hint.m)}-${pad(hint.d)}`);
    }
    return new RegExp(`${hint.m}\\s*月\\s*${hint.d}\\s*日?`).test(t)
        || t.includes(`${pad(hint.m)}-${pad(hint.d)}`);
}

/** 摘录：围绕关键词取一段，控制长度并压掉换行 */
function recallExcerpt(text, query, max) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const i = query ? t.toLowerCase().indexOf(String(query).toLowerCase()) : -1;
    const start = i > 40 ? Math.max(0, i - 40) : 0;
    return (start > 0 ? '…' : '') + t.slice(start, start + max) + (start + max < t.length ? '…' : '');
}

/** 把 [操作:手机…] 的正文解析成 { action, args }；认不出返回 null */
function parsePhoneOperation(text) {
    const s = String(text || '').trim();
    for (const action of AGENT_PHONE_OPS) {
        if (s.startsWith(action)) return { action, args: s.slice(action.length).trim() };
    }
    return null;
}

/** 手机操作 → 过程区里给人看的一句话 */
function describePhoneOperation(parsed) {
    const a = parsed.args;
    switch (parsed.action) {
        case '手机点击': return a ? '点击坐标：' + a : '点击（没有给出坐标）';
        case '手机滑动': return a ? '滑动：' + a : '滑动（没有给出坐标）';
        case '手机输入': return a ? '要输入的文字：' + a : '输入（没有给出文字）';
        case '手机按键': return a ? '按键：' + a : '按键（没有给出键名）';
        case '手机打开': return a ? '要打开的应用：' + a : '打开应用（没有给出包名）';
        case '手机等待': return a ? '等待 ' + a + ' 毫秒' : '等待';
        case '手机命令': return '要执行的命令：' + a;
        case '手机截图': return '截取当前屏幕画面';
        case '手机查看界面': return '读取当前界面的控件树';
        case '手机状态': return '查询设备与后端状态';
        // ---- 读取信息与工作区文件 ----
        case '手机应用列表': return '读取已安装应用列表';
        case '手机通知': return '读取最近的通知' + (a ? '（' + a + '）' : '');
        case '手机设备信息': return '读取设备与前台状态';
        case '手机短信': return '读取最近短信' + (a ? '（' + a + ' 条）' : '');
        case '手机通讯录': return '读取联系人' + (a ? '（筛选：' + a + '）' : '');
        case '手机日历': return '读取近期日程' + (a ? '（' + a + ' 天）' : '');
        case '手机列出文件': return a ? '列出：' + a : '列出 Agent 工作区';
        case '手机读文件': return a ? '读取：' + a : '读取文件（没有给出路径）';
        case '手机写文件': return a ? '写入：' + a.split('|')[0] : '写入文件（没有给出路径）';
        case '手机删除文件': return a ? '⚠️ 删除：' + a : '删除文件（没有给出路径）';
        default: return '';
    }
}

/**
 * 把一条**中文标签**（[操作:浏览器…]）翻成工具通道的结构化参数。
 *
 * 认不出来返回 null（调用方据此给一句可照做的写法），**不要**猜一个默认动作：
 *   猜成 open 会在用户只想看页面时突然弹出一个浏览器窗口。
 */
function parseBrowserTag(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    // 去掉「浏览器」前缀与可能的分隔符
    const rest = text.replace(/^(浏览器|网页|打开网址)\s*[:：]?\s*/, '').trim();
    // 只有「浏览器」三个字：等价于看页面（最保守、也最常用的一步）
    if (!rest) return { action: 'snapshot' };
    if (/^(看页面|快照|看看|当前页面|snapshot)$/i.test(rest)) return { action: 'snapshot' };
    if (/^(关闭|关掉|收起|close)$/i.test(rest)) return { action: 'close' };
    if (/^(回车|按回车|提交|enter|submit)$/i.test(rest)) return { action: 'press_enter' };
    // 点击：编号可能是 3、[3]、第3个
    const click = rest.match(/^(?:点击|点一下|点|click)\s*\[?\s*(\d+)\s*\]?$/i);
    if (click) return { action: 'click', ref: click[1] };
    // 输入：编号|文字（竖线是标签协议既有的分隔符，写文件的标签也是这个形状）
    const type = rest.match(/^(?:输入|填写|打字|type)\s*\[?\s*(\d+)\s*\]?\s*[|｜]\s*([\s\S]*)$/i);
    if (type) return { action: 'type', ref: type[1], text: type[2] };
    // 其余一律当网址（模型最常写的就是「浏览器打开 https://…」）
    const urlText = rest.replace(/^(打开|访问|去|goto|open)\s*/, '').trim();
    if (/^https?:\/\//i.test(urlText)) return { action: 'goto', url: urlText };
    // 不带协议的域名也收（模型经常写 example.com）。
    //   判据不是正则而是"能不能被 URL 解析出带点的主机名"：
    //   中文域名（例.com）与带端口的写法都能过，而"随便一句话"解析不出主机名。
    if (!/\s/.test(urlText) && urlText.includes('.')) {
        try {
            const u = new URL('https://' + urlText);
            if (u.hostname.includes('.') && u.hostname.length > 3) return { action: 'goto', url: u.toString() };
        } catch { /* 不是域名，落到 null */ }
    }
    return null;
}

/** 过程行里显示的参数摘要：只留真正要紧的那个值，别把整段正文塞进去 */
function summarizeBrowserArgs(args) {
    const a = args || {};
    if (a.url) return String(a.url);
    if (a.ref && a.text !== undefined) return '[' + a.ref + '] ← ' + String(a.text).slice(0, 80);
    if (a.ref) return '[' + a.ref + ']';
    return '';
}
