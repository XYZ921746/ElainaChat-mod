// Agent 实现方式 / 后端选择：AGENT_BACKENDS / 后端探测 / 状态面板 / 手机与命令能力提示词；依赖 agent-phone.js 的 deviceBridge 与宿主 state / 弹窗（运行时才调用）。
'use strict';

// 实现方式（后端选择）：入口在「设置 → 能力 → 手机操作」（手机上侧边栏一收起就进不去），面板是独立弹窗 #backendPanel。前台只有一个端点（无障碍），后台有三个端点（Shizuku / Root / 模块）；白名单在 data.js 的迁移里有一份镜像，改这里必须同步改那边，否则新选的 id 会在下次启动时被重置。
const AGENT_BACKENDS = [
    {
        id: 'accessibility', name: '无障碍', tag: '免 root', kind: 'foreground',
        desc: '用系统自带的无障碍服务点击、输入、读取界面。不用装任何东西，门槛最低；中文输入也只有它能可靠做到。截图（看图）需要 Android 11 及以上；Android 10 及以下只能读界面与点击、滑动、输入。',
        need: '系统设置 → 无障碍里开启本应用的服务'
    },
    {
        id: 'shizuku', name: 'Shizuku', tag: '免 root / 需激活', kind: 'background',
        desc: '通过 Shizuku 授权，在本机创建独立副屏：AI 在副屏操作，不抢你正在用的屏幕。非 root 可用；非 root 设备重启后要重新激活 Shizuku。由于系统限制，只有部分系统版本能正常使用——授权成功后点下方「检测副屏」确认这台设备行不行。',
        need: '安装 Shizuku 并完成激活（无线调试或 root 启动）'
    },
    {
        id: 'root', name: 'Root', tag: '需要 root', kind: 'background',
        desc: '用 root 权限创建独立副屏：不抢前台，Android 15 QPR2 / 16 都能用。需要手机已 root（Magisk / KernelSU / APatch），并在 root 管理器里给本应用授权。',
        need: '在 root 管理器里给本应用授予 su 权限'
    },
    {
        id: 'module', name: '模块', tag: '需要 KernelSU', kind: 'background',
        desc: '刷入 agent-mobile-use 系统模块，后台静默操作：不抢前台、不被后台清理打断。模块自带本地网关（默认 127.0.0.1:3070）。',
        need: '刷入 KernelSU 模块（本机 3070 端口有服务）'
    }
];

/** 后端属于前台还是后台；没登记的一律按前台处理，避免面板把未知项吞掉。 */
function backendKindOf(id) {
    const found = AGENT_BACKENDS.find((b) => b.id === id);
    return found ? found.kind : 'foreground';
}

/** 给设置摘要 / 面板标题用的完整名称：前台运行 · 无障碍、后台运行 · Root。 */
function backendDisplayName(id) {
    const found = AGENT_BACKENDS.find((b) => b.id === id);
    if (!found) return '';
    return (found.kind === 'background' ? '后台运行' : '前台运行') + ' · ' + found.name;
}

/** 探测结果是否已明确就绪；checking / unavailable / 缺项都按未就绪。 */
function backendIsReady(id) {
    return Boolean(backendStatus[id] && backendStatus[id].state === 'ready');
}

/** 当前探测结果里已经就绪的后台端点（按 AGENT_BACKENDS 的顺序）。 */
function readyBackgroundBackends() {
    return AGENT_BACKENDS.filter((b) => b.kind === 'background' && backendIsReady(b.id));
}

// 每个实现方式对应的「去设置 / 请求权限」引导。plugin/method 指向原生插件 ElainaDevice 上的真实方法：在场就真跳转、真弹授权框，返回的说明会直接展示给用户；插件不在（网页版）时退化成说明文字，两种情况都给出可执行的下一步。
const AGENT_BACKEND_SETUP = {
    accessibility: {
        label: '去开启无障碍',
        plugin: 'ElainaDevice', method: 'openAccessibilitySettings',
        guide: [
            '1. 打开系统的「设置 → 无障碍」（部分机型叫「辅助功能」）',
            '2. 在已安装的服务里找到「ElainaChat Mod 手机操作」',
            '3. 打开开关并按提示确认',
            '',
            '各厂商路径：小米在「更多设置 → 无障碍」；华为 / 荣耀在「辅助功能 → 无障碍」；OPPO / 一加在「系统设置 → 无障碍」。'
        ].join('\n')
    },
    shizuku: {
        label: '去授权 Shizuku',
        plugin: 'ElainaDevice', method: 'requestShizukuPermission',
        guide: [
            '1. 安装 Shizuku（应用商店或 Shizuku 官网）。',
            '2. 打开 Shizuku，按它的引导完成激活：',
            '   · 未 root：开发者选项 → 无线调试 → 配对，然后在 Shizuku 里启动；',
            '   · 已 root：在 Shizuku 里选择「通过 root 启动」。',
            '3. 回到本应用，点「去授权 Shizuku」，在弹窗里允许。',
            '4. 回来点「重新检测」。',
            '',
            '说明：非 root 设备重启后需要重新激活 Shizuku。由于系统限制，目前只有部分系统版本能正常建副屏 —— 授权成功后回到这里，点面板底部的「检测副屏」确认这台设备行不行。'
        ].join('\n')
    },
    root: {
        label: '去授权 Root',
        plugin: 'ElainaDevice', method: 'requestRootPermission',
        guide: [
            '1. 确认手机已 root（Magisk / KernelSU / APatch），并装好对应的管理器。',
            '2. 点「去授权 Root」，在 root 管理器弹窗里允许本应用。',
            '3. 回来点「重新检测」。',
            '',
            'Root 方式会在后台启动一个常驻 holder 进程创建副屏；不需要装 Shizuku 或模块。'
        ].join('\n')
    },
    module: {
        label: '怎么刷模块',
        guide: [
            '模块方式需要先在手机上刷入 KernelSU 模块 agent-mobile-use，它会提供一个本地服务（默认 127.0.0.1:3070）。',
            '',
            '1. 确认手机已刷 KernelSU 并装好管理器',
            '2. 刷入模块后重启手机',
            '3. 回来点「重新检测」，状态会变成「已就绪」',
            '',
            '刷上之后 AI 可以在独立副屏上后台操作，不抢占你正在用的界面。',
            '如果模块用的不是 3070 端口，需要改网关地址（目前只能改代码里的默认值）。'
        ].join('\n')
    }
};

const backendStatus = {};   // id -> { state, text }

/** 当前选定的实现方式；空字符串表示还没选过 */
function currentBackendId() {
    const id = state.settings.agentBackend || '';
    return AGENT_BACKENDS.some((b) => b.id === id) ? id : '';
}

function backendNameOf(id) {
    const found = AGENT_BACKENDS.find((b) => b.id === id);
    return found ? found.name : '';
}

/** 注入系统提示词的「手机操作」能力说明：不告诉模型它就永远不会输出标签，用户看到的现象正是「AI 好像不能操作手机」。分三档，避免「告诉了却做不到」。 */
function agentPhoneSkillText() {
    if (!deviceBridge()) return '';
    const enabled = state.settings.agentPhoneEnabled !== false;
    // 不要求设置里预先选好实现方式：只要总开关开着、且至少一条路就绪，这一轮就可能操作手机（多条路就绪时会先弹窗问前台还是后台）；若在 backend 为空时注入「未启用、不要输出标签」，模型在还没选默认方式时会彻底不试，而弹窗机制恰恰是为这种状态准备的。
    const ready = AGENT_BACKENDS.filter((b) => backendIsReady(b.id));
    const chosen = currentBackendId();
    let effective = (chosen && backendIsReady(chosen)) ? chosen : '';
    if (!effective) {
        const foreground = ready.find((b) => b.kind === 'foreground');
        const background = ready.find((b) => b.kind === 'background');
        effective = foreground ? foreground.id : (background ? background.id : '');
    }
    if (!enabled || !effective) {
        return '# Agent Skill：手机操作（当前未启用）\n'
            + '这台设备支持手机操作，但用户还没有在「设置 → 能力 → 手机操作」里选好「实现方式」'
            + (enabled ? '' : '，或「允许 AI 操作手机」总开关是关闭的') + '。\n'
            + '因此你现在**不能**操作手机，也**不要**尝试调用 phone_action 工具。\n'
            + '如果用户希望你操作手机，请如实说明还没有启用，并引导他去「设置 → 能力 → 手机操作」'
            + '点「选择实现方式」选一种（无障碍门槛最低），并确认「允许 AI 操作手机」已勾选。';
    }
    // 能力清单必须按实现方式区分：只有无障碍时不能发任意按键；有后台端点时按键面是全的。多条路都就绪时，能力面是并集（原生会在首选做不到时按用户选择换路）；写成「⛔ 不支持」会让模型自我审查，明明能做到却回「我做不到」。
    const backgroundReady = ready.filter((b) => b.kind === 'background');
    const canFullKeys = backgroundReady.length > 0;
    const choiceNeeded = ready.length > 1;
    // 提示词只留「索引 + 一句话用法」：标签清单 + 能力边界 + 反幻觉一句。详细用法（坐标怎么取、输入中文怎么处理、哪些操作问不问用户、工作区路径规则）移到注册表里 phone 的说明书，由 agent_help 用到时才下发。
    // 工具导向：phone_action 的 raw 参数就是操作原文（格式由工具 schema 描述），提示词只写策略与规则。
    const lines = [
        '# Agent 能力：手机操作（当前方式：'
            + (choiceNeeded ? '前台 / 后台由用户选' : backendNameOf(effective)) + '）',
        '通过 **phone_action** 工具操作这台安卓手机：读取界面、点击、滑动、输入文字、按键、截图、打开应用。',
        '工具的 raw 参数是操作原文（如「手机点击 540 1200」「手机查看界面」「手机输入 你好」），'
            + '系统解析并执行后把结果回灌给你。',
        '',
        '**可用操作**：',
        '· 手机状态 —— 查询设备与当前后端状态',
        '· 手机查看界面 —— 读取当前屏幕的控件树（含控件文字、可点击坐标与 #编号）',
        '· 手机截图 —— 截屏（需配置好多模态模型，否则拿不到画面内容）',
        '· 手机点击 x y [毫秒] —— 点击坐标；第三个参数 ≥400 表示长按',
        '· 手机滑动 x1 y1 x2 y2 [时长毫秒] —— 滑动',
        '· 手机输入 文字 —— 向当前获得焦点的输入框输入文字',
        '· 手机按键 返回|主页|回车|菜单|音量上|音量下 —— 按系统键',
        '· 手机等待 毫秒 —— 等界面加载完再继续',
        '· 手机打开 应用名或包名 —— 启动应用（写应用名就行，系统会解析成包名）',
    ];
    if (!canFullKeys) {
        lines.push('按键只支持「返回 / 主页 / 最近任务」三个；要发其他按键，需要先选「后台运行」（Shizuku / Root / 模块）。');
    }
    if (choiceNeeded) {
        lines.push('⚙️ 这台设备有多条可用路径：每次要操作屏幕前，系统会先请用户选择前台 / 后台；后台再选 Shizuku / Root / 模块。你照常调用工具即可。');
    }
    lines.push(
        '⚠️ 「手机命令」不开放：后台方式的系统命令只用于内部动作（启动应用、点击、读界面），不要输出手机命令标签。'
    );
    lines.push(
        '· 手机列出文件 [路径] —— 列出 Agent 工作区或已授权文件夹里的内容',
        '· 手机读文件 路径 —— 读取文本文件内容',
        '· 手机写文件 路径|内容 —— 写入文件（工作区内直接写；工作区外需用户已授权该文件夹）',
        '· 手机删除文件 路径 —— 删除文件或目录（⚠️ 不可恢复）',
        '',
        '【可读取的信息】',
        ...phoneReadSkillLines(),
        '需要用户先在系统里授予对应权限；**没有授权时会明确报「没有权限」** —— 那时如实告诉用户去开启，'
            + '不要假装读到了。',
        '通知、短信、通讯录、日历是用户的**隐私数据**：只在真的需要时读，不要在回复里罗列无关细节。',
        '',
        '用法：一次只做一步，**先看再点、点完再确认** —— 不知道屏幕上有什么时先调「手机查看界面」，'
            + '**不要凭猜测点坐标**；每次点击 / 滑动 / 输入之后，系统会把这一步的【界面变化】一并回灌，'
            + '**不需要**为了确认再单独读一次界面；变化里说「界面没有变化」就换控件或重读，不要在同一坐标上反复点。'
            + '⚠️ 正常界面**优先用元素引用**：清单里的 #编号 在 raw 里写「手机点击 #12」，'
            + '或「手机按键 id:<资源id>」；像素坐标只用于清单里没有目标、画布 / 游戏区域。'
            + '编号只对最近一次界面清单有效，界面变化后要重新查看界面。'
            + '⚠️ 执行期间**不要写解说、旁白或安抚** —— 这些中间话不会发给用户；'
            + '任务完成或确定做不成时，用 [完成] 开头写**一段**总结，不要再调用工具；'
            + '总结里不要写括号动作（如（摇了摇头）（叹了口气）），情绪用自然语气词表达。'
            + '读不懂界面时调「手机截图」（会给画面描述 + 可点元素编号与坐标，照着坐标点，别从图片估像素）。'
            + '⚠️ 清单会标注控件覆盖与无控件区域：目标在可读控件上直接用 #编号 / id；'
            + '落在无控件 / 混合区域时，再调「手机截图」看画面并按网格读坐标。'
            + '结果里说「画面持续变化，无法判断」时**不要猜**变化，先等一秒或重新截图。'
            + '⚠️ 用户让你操作手机（或说「继续」「接着玩」）而你还没做完时，每次回复**必须**调用 phone_action —— '
            + '只写「好的我会继续盯着」不调工具，什么都不会发生，任务就停在那了。'
            + '⚠️ 玩有画面的游戏按这个循环走：打开应用 → 截图（看画面拿到坐标）→ 按画面选一处可消除的位置 → '
            + '滑动 → 看回灌里的【界面变化 / 画面变化】→ 继续下一步，直到过关或用完步数。'
            + '⚠️ 打开应用**不要凭记忆猜包名**：不确定就写应用名，系统会按已安装应用解析；'
            + '打开后系统会核对前台，回灌里说「前台是 X，不是你要打开的 Y」就说明没打开成功，'
            + '别当成已打开，先调「手机应用列表」确认准确名称再重试。'
            + '⚠️ **消除类游戏的棋盘只能「滑动」不能「点击」**：滑动把方块换到相邻格，点击什么都不会发生。'
            + '⚠️ 坐标必须取**格子的正中心**：这类棋盘每格只有 80-100px 宽，差半格就点到隔壁格上，交换就落空了。'
            + '读坐标时先看清目标格的四条边，取中点；滑动的起点和终点都取格心，距离约 90px。'
            + '⚠️ 滑之前先在画面里找**确实能连成 3 个同色**的一对；连不成 3 个的交换会被游戏弹回。'
            + '如果连续两步操作后步数/分数都没变，换**另一对**，不要在同一处反复滑。'
            + '中途**不要**切回聊天应用。'
            + '读到的控件清单是给你判断用的内部信息，**不要把清单原文 / id / 坐标原样贴给用户**。'
            + '回灌里说「不支持」就是当前方式的能力边界，**不要重复尝试**，'
            + '改用别的方式或如实告诉用户。⚠️ 只有真的调用了工具才会执行，'
            + '结果一律以系统回灌为准 —— **绝不编造**"我已经点了/已经打开了/操作成功"。'
    );
    return lines.join('\n');
}

/** 「读取信息」能力清单。能不能真读到由系统权限决定（没给权限时原生层会如实回"没有权限"并告诉用户去哪开），
 *  所以清单本身不按开关裁剪 —— 少列一项就等于让模型以为"没这个能力"，而用户其实随时可以在系统里授予。 */
function phoneReadSkillLines() {
    return [
        '· 手机应用列表 —— 已安装应用的包名与应用名',
        '· 手机通知 —— 最近收到的通知（哪个应用、标题、内容）',
        '· 手机设备信息 —— 电量、网络、系统版本等设备概况（"我在哪个应用"看读界面的第一行，不必查它）',
        '· 手机短信 [条数] —— 最近短信',
        '· 手机通讯录 [关键词] —— 联系人',
        '· 手机日历 [天数] —— 近期日程',
    ];
}

/** 手机（APK）上给模型的「电脑侧不存在」说明 —— 用来替代电脑的文件 / 命令能力清单。不说清它就乱答应：手机上仍注入了电脑的文件能力时，用户问「能不能在本机新建文件」，模型答「我能在本机新建文件……设置成了逐条确认模式」，而手机页面没有转发 /api/agent/*（PC 命令是电脑侧语义，手机能力另走手机操作）。 */
function agentComputerUnavailableSkillText() {
    return '# 电脑操作：本设备没有这一侧（当前在安卓手机 App 里运行）\n'
        + '你现在运行在**手机**上，**没有**"电脑"这一侧的能力：\n'
        + '· 不能读写电脑上的文件、不能查看电脑目录（[操作:列出文件/查看文件/保存文件] 会被直接拒绝）；\n'
        + '· 不能执行 PowerShell / cmd 命令（[操作:电脑命令] 会被直接拒绝）；\n'
        + '· 也**不要**提桌面、文档、下载这类电脑路径。\n'
        // 这里不要把手机那四个文件标签逐个列出来 —— 手机操作没启用时 agentPhoneSkillText 是刻意「连标签名都不给」的，列出来就会自相矛盾。
        + '手机上的文件操作走的是另一套 [操作:手机…] 标签 —— '
        + '**能不能用，以上面「手机操作」那一段为准**（它没给出写文件标签，就说明现在用不了）。\n'
        + '⚠️ 用户问"能不能在本机 / 这台设备上新建文件"这类问题时，按**手机**的能力如实回答：'
        + '上面「手机操作」那段给出了写文件标签就照它说，没给出就如实说明现在做不到，'
        + '**绝不**承诺"能读写这台电脑上的任意路径"。';
}

/** 注入系统提示词的「电脑命令」能力说明：不告诉模型标签存在它就永远不会输出。三档模型下一律注入（三档都能执行命令，区别只在要不要问），提示词按档位改写「要不要确认」那一句，否则模型会编造「命令已执行」。 */
function agentCommandSkillText() {
    // APK 的 /api/agent/* 不在转发清单（Go 服务里有路由，但 PC 命令在手机上无意义），注入了也执行不了。必须用 IS_NATIVE_APP 而不是看协议 —— Capacitor 的 androidScheme 是 https，按协议判断会把 APK 当成网页版。
    if (IS_NATIVE_APP) return '';
    // `off` 档：电脑操作整体关闭 —— 连能力都不该让模型看到（由 agentDisabledSkillText 说明）。
    if (agentAccessDisabled()) return '';
    const accessLabel = commandAccessLabel();
    // 提示词只留「索引 + 一句话用法」：标签与当前档位的确认规则 + 反幻觉一句。详细用法移到注册表里 pc_command 的说明书，由 agent_help 用到时才下发。
    return '# Agent 能力：电脑命令（当前权限：' + accessLabel + '）\n'
        + '· [操作:电脑命令 <命令>] —— 在这台电脑上执行 PowerShell / cmd 命令并返回输出，'
        + '例如 [操作:电脑命令 dir]、[操作:电脑命令 git status]\n'
        + commandConfirmPhrase() + '\n'
        + '⚠️ 只有真的输出了标签（或工具调用）才会执行，结果一律以系统回灌为准 —— '
        + '**绝不编造**"我已经执行了/命令输出是…"。输出较长时会被截断，需要看别的部分就换一条更精确的命令。';
}

/** 当前权限档在「电脑命令」这一侧的称呼（与 accessPhrase 同源，只是命令侧少一点文件措辞） */
function commandAccessLabel() {
    const access = currentAgentAccess();
    return access === 'full' ? '完全访问' : (access === 'auto' ? '自动通过（禁止删除）' : '逐条确认');
}

/** 「电脑命令」当前档位数不数得清「要不要问」：命令通道的闸比文件通道更粗 —— auto 档下普通命令直接执行，只有危险命令才问；这一点与「禁止删除」那套不同，所以单独说一句，而不是复用 accessPhrase()。 */
function commandConfirmPhrase() {
    const access = currentAgentAccess();
    return access === 'full'
        ? '当前是「完全访问」模式：**命令直接执行，不会询问用户**（包括删除类命令），所以执行前自己确认命令是对的。'
        : (access === 'auto'
            ? '当前是「自动通过（禁止删除）」模式：普通命令直接执行；**危险命令（删除、格式化、改注册表、'
                + '关机、下载并执行、提权等）会让用户确认一次**。用户可能拒绝 —— 被拒绝时如实说明并换个更安全的思路。'
            : '当前是「逐条确认」模式：**每条命令执行前都会让用户确认**。用户可能拒绝 —— '
                + '被拒绝时如实说明并换个思路，不要反复重试同一条命令。');
}

/** off 档注入给模型的说明：电脑操作已关闭。模型被要求「帮我写个文件」时，若提示词里没有任何说明，它既可能凭先验输出标签（被服务端拒绝），也可能编造「我已经帮你写好了」；所以明确告知能力已被用户关闭，并要求如实说明、不要输出标签、不要编造。 */
function agentDisabledSkillText() {
    if (!agentAccessDisabled()) return '';
    return '# 电脑操作：已关闭（用户的选择）\n'
        + '用户已在「设置 → 能力 → AI 权限」里选择「关闭」——你**不能**读取、写入或修改这台电脑上的任何文件，'
        + '不能查看目录或真实路径，也不能执行电脑命令（这些标签会被系统直接拒绝）。\n'
        // 先给「怎么说」，再给「不许怎么说」：只列禁止不够 —— 模型会继续换别的借口（「我是魔女不懂科技」），因为它手上没有一句能说的话。所以直接给它唯一正确的那句话：权限关着 + 怎么打开。
        + '用户提出这类要求时，你要讲清的**只有两件事**：① 这台机器的电脑操作被关掉了（是你这边的权限设置，不是他的机器坏了）；'
        + '② 去「设置 → 能力 → AI 权限」打开就能用；他要是不想开，自己在桌面新建个 .txt 也一样。\n'
        + '⚠️ **用你自己的口吻说这两件事就行，不要逐字照搬上面这段说明** —— 那是给你的事实，不是台词。\n'
        + '⚠️ 说完这件事就够，不必展开解释。你**一直在用这台机器**（你们同处一室），\n'
        + '所以不要说"我不懂科技""我没有电脑""魔女不会用这种东西"——那是编出来的隔阂。\n'
        + '不要输出任何 [操作:…] 文件/命令标签，也**绝不要**把做不到的事说成已经做了。\n'
        // 这一条针对一种很具体的失败：关掉权限后，模型把「保存成功」写成【AI 操作结果】✅ 已保存到：D:\… 这种格式（历史对话里见过宿主插的这条），用户去桌面一看什么都没有。所以要点名禁止照抄这个回执格式，并明确那种回执只由系统在真的写成后产生。
        + '⚠️ **不要伪造系统回执。** 不要写「【AI 操作结果】」这个标题，也不要写「✅ 已保存到：…」「已创建」这类回执行 —— '
        + '它们看起来像系统给出的确认，但系统只会在**真的写成之后**才生成它们。你手写出来就是骗人。\n'
        + '想配合用户的心情可以理解，但只能说"要是有权限就好了""等你能开权限时我再帮你"，'
        + '**不能**用一句"好啦，搞定"把没做的事盖过去。\n'
        // 另一种常见的躲避方式：把「做不到」归因到世界观上（「我没有实体双手」「魔女不会念电子咒文」）—— 既与设定矛盾，也把「权限被关掉」这个真实原因换成了逃避的说法，用户会以为是自己设备的问题。
        + '⚠️ **不要把"做不到"推到世界观或身体上**：不要说"我没有实体双手""魔女不会操作电脑"\n'
        + '  "我没碰你的板子"这类话。这台机器你本来就在用，原因**只有一个**：用户在设置里把它关掉了。\n'
        + '（应用内操作如视频通话、整理记忆、水印、背景等不受影响，照常可用。）';
}

/** 刷新「设置 → 手机操作」里那块实现方式的显示。只更新文字和徽标，不禁用任何东西：实现方式只是「AI 走哪条路」的选择，下面的总开关和确认策略跟它无关，没选实现方式也照样能改 —— 把设置锁住只会让人以为坏了。 */
function syncBackendSummary() {
    const chosen = currentBackendId();
    const summary = document.getElementById('settingBackendSummary');
    const badge = document.getElementById('settingBackendBadge');
    const bridge = document.getElementById('settingBackendBridge');
    if (badge) badge.innerHTML = chosen ? backendStatusBadge(backendStatus[chosen]) : '';
    if (bridge) {
        // 这一行是拿来回答"为什么检测不到"的：是原生层没接上，还是还没授权
        if (deviceBridge()) {
            const info = backendDeviceInfo;
            bridge.textContent = '原生设备层：已连接'
                + (info && info.model ? `（${info.model} / Android ${info.android}）` : '');
            bridge.style.color = 'var(--rd-ok)';
        } else {
            bridge.textContent = '原生设备层：不在（当前是网页版，手机操作只能在安卓版 App 里用）';
            bridge.style.color = 'var(--rd-warn)';
        }
    }
    if (!summary) return;
    if (!chosen) {
        summary.textContent = '还没有选择运行方式，AI 现在不能操作手机。点下面的「选择实现方式」先选前台或后台。';
        summary.style.color = 'var(--rd-warn)';
        return;
    }
    const st = backendStatus[chosen];
    const ready = st && st.state === 'ready';
    const checking = !st || st.state === 'checking';
    const stateWord = checking ? '检测中' : (ready ? '已就绪' : '现在还不能用');
    const detail = st && st.text ? '：' + st.text : '';
    summary.textContent = '当前运行方式：' + backendDisplayName(chosen) + '（' + stateWord + detail + '）';
    summary.style.color = ready ? 'var(--rd-ok)' : 'var(--rd-warn)';
}

/** 设备状态只问原生一次，四个后端共用 —— 否则 status() 会被连问四遍，而它内部要 ping Shizuku、连一次 3070 网关。 */
let backendStatusCache = null;
let backendDeviceInfo = null;

async function fetchDeviceStatus(force) {
    const dev = deviceBridge();
    if (!dev || typeof dev.status !== 'function') return null;
    if (backendStatusCache && !force) return backendStatusCache;
    try {
        const st = await dev.status();
        backendStatusCache = st || {};
        backendDeviceInfo = {
            model: backendStatusCache.model || '',
            android: backendStatusCache.android || ''
        };
        return backendStatusCache;
    } catch (e) {
        console.warn('[Agent] 原生设备层状态查询失败:', e);
        backendStatusCache = null;
        return null;
    }
}

async function detectBackend(id) {
    // 原生设备层在场时，直接问它 —— 这是唯一准的来源（它能真的试 su、ping Shizuku）。
    const dev = deviceBridge();
    if (dev && typeof dev.status === 'function') {
        const st = await fetchDeviceStatus(false);
        if (st) {
            const item = st[id];
            if (item) {
                const detail = String(item.detail || '');
                return item.available
                    ? { state: 'ready', text: detail || '已就绪' }
                    : { state: 'unavailable', text: detail || '不可用' };
            }
            return { state: 'unavailable', text: '这个版本里没有这种实现方式' };
        }
        // 原生层在场但 status() 没回答：别说成「网页版」，那会把人引到完全错的方向，如实报错。
        return { state: 'unavailable', text: '原生设备层没有响应，重启一下应用再试' };
    }
    // 网页版没有原生层。只有「模块」能真探测：网关在本机 3070，no-cors 的 fetch 读不到内容，但「有没有响应」足够判断它在不在。
    if (id === 'module') {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 1500);
            await fetch('http://127.0.0.1:3070/api/status', { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
            clearTimeout(timer);
            return { state: 'ready', text: '已就绪' };
        } catch (e) {
            return { state: 'unavailable', text: '未检测到' };
        }
    }
    // 网页版没有原生层，几种实现方式都探测不了：「手机操作」只在安卓版 App 里可用（浏览器没有点击 / 输入屏幕的能力）。
    return { state: 'pending', text: '需要在安卓版 App 里使用' };
}

function backendStatusBadge(st) {
    const map = {
        ready: ['已就绪', 'color:var(--rd-ok);background:var(--rd-ok-soft)'],
        unavailable: ['不可用', 'color:var(--rd-warn);background:var(--rd-warn-bg)'],
        pending: ['仅 APK', 'color:var(--rd-accent);background:var(--rd-accent-soft)'],
        checking: ['检测中', 'color:var(--rd-accent);background:var(--rd-accent-soft)']
    };
    const pair = map[st && st.state] || map.checking;
    return '<span style="' + pair[1] + ';font-size:10px;padding:2px 7px;border-radius:7px;white-space:nowrap">' + pair[0] + '</span>';
}

/** 后端返回的说明文字直接来自原生层，插进 HTML 前统一转义 */
function escapeBackendText(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 面板当前展开的是哪一组：前台 / 后台。只影响面板视图，不写设置。 */
let backendPanelGroup = '';

const BACKEND_GROUPS = [
    { id: 'foreground', name: '前台运行', hint: '在你正在用的屏幕上操作（无障碍）' },
    { id: 'background', name: '后台运行', hint: '独立副屏，不抢你正在用的屏幕' }
];

function backendCardHtml(b, cur) {
    const active = b.id === cur;
    const setup = AGENT_BACKEND_SETUP[b.id];
    const st = backendStatus[b.id];
    // 状态说明来自原生层（「还没授权，点请求 root 授权」这种），必须显示出来 —— 手机上没法 hover，只给个「不可用」用户不知道该做什么。
    const detail = (st && st.state !== 'checking' && st.text) ? escapeBackendText(st.text) : '';
    const detailColor = (st && st.state === 'ready') ? 'var(--rd-ok)' : 'var(--rd-warn)';
    // 用 div 而不是 button：卡片里还要放「去设置」按钮，而 button 不能嵌套 button
    return '<div data-backend="' + b.id + '" role="button" tabindex="0"'
        + ' class="backend-card w-full text-left rounded-2xl border px-4 py-3 transition cursor-pointer' + (active ? ' is-active' : '') + '"'
        + ' style="border-color:' + (active ? 'var(--rd-accent-border)' : 'var(--rd-border)') + ';background:' + (active ? 'var(--rd-accent-soft)' : 'var(--rd-surface-2)') + '">'
        + '<div class="flex items-center gap-2">'
        + '<span class="text-sm font-semibold text-ink">' + b.name + '</span>'
        + '<span style="font-size:10px;color:var(--rd-accent);background:var(--rd-accent-soft);padding:2px 6px;border-radius:7px;white-space:nowrap">' + b.tag + '</span>'
        + '<span class="ml-auto">' + backendStatusBadge(st) + '</span>'
        + '</div>'
        + (detail ? '<p class="text-[11px] mt-1 leading-relaxed" style="color:' + detailColor + '">' + detail + '</p>' : '')
        + '<p class="text-[11px] text-dim mt-1 leading-relaxed">' + b.desc + '</p>'
        + '<div class="flex items-center gap-2 mt-1">'
        + '<span class="text-[11px] text-dim leading-relaxed flex-1">需要：' + b.need + '</span>'
        + (setup ? '<button type="button" data-backend-setup="' + b.id + '" class="btn-secondary text-[11px] flex-shrink-0" style="padding:3px 10px">' + setup.label + '</button>' : '')
        + '</div>'
        + (active ? '<p class="text-[11px] font-semibold mt-1" style="color:var(--rd-accent)">当前使用</p>' : '')
        + '</div>';
}

function renderBackendList() {
    const box = document.getElementById('backendList');
    if (!box) return;
    const cur = currentBackendId();
    if (!backendPanelGroup) backendPanelGroup = cur ? backendKindOf(cur) : 'foreground';
    const tip = cur ? '' :
        '<p class="text-[11px] leading-relaxed mb-2" style="color:var(--rd-warn);background:var(--rd-warn-bg);border:1px solid var(--rd-warn-border);border-radius:12px;padding:8px 12px">还没有选择运行方式，AI 现在不能操作手机。先选「前台运行」或「后台运行」，再选具体方式。</p>';
    const groupBar = '<div class="flex gap-2 mb-2">' + BACKEND_GROUPS.map((g) => {
        const active = g.id === backendPanelGroup;
        return '<button type="button" data-backend-group="' + g.id + '" class="flex-1 rounded-2xl border px-3 py-2 text-left transition"'
            + ' style="border-color:' + (active ? 'var(--rd-accent-border)' : 'var(--rd-border)') + ';background:' + (active ? 'var(--rd-accent-soft)' : 'var(--rd-surface-2)') + '">'
            + '<span class="text-sm font-semibold text-ink">' + g.name + '</span>'
            + '<span class="block text-[10px] text-dim mt-0.5">' + g.hint + '</span>'
            + '</button>';
    }).join('') + '</div>';
    const list = AGENT_BACKENDS.filter((b) => b.kind === backendPanelGroup);
    box.innerHTML = tip + groupBar + list.map((b) => backendCardHtml(b, cur)).join('');
    box.querySelectorAll('[data-backend-group]').forEach((el) => {
        el.addEventListener('click', () => {
            const group = el.getAttribute('data-backend-group');
            if (!group || group === backendPanelGroup) return;
            backendPanelGroup = group;
            renderBackendList();
        });
    });
    box.querySelectorAll('[data-backend]').forEach((el) => {
        const id = el.getAttribute('data-backend');
        el.addEventListener('click', (e) => {
            if (e.target && e.target.closest && e.target.closest('[data-backend-setup]')) return;   // 点设置按钮不算选中
            selectBackend(id);
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectBackend(id); }
        });
    });
    box.querySelectorAll('[data-backend-setup]').forEach((el) => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            void openBackendSetup(el.getAttribute('data-backend-setup'));
        });
    });
    const curEl = document.getElementById('backendCurrent');
    if (curEl) curEl.textContent = cur ? backendDisplayName(cur) : '尚未选择';
    // 「检测副屏」只在后台分组、且当前选中后台方式时出现：前台无障碍没有"建屏"这回事。
    const probeBtn = document.getElementById('backendProbeBtn');
    if (probeBtn) {
        const show = backendPanelGroup === 'background' && cur && backendKindOf(cur) === 'background';
        probeBtn.classList.toggle('hidden', !show);
    }
}

function selectBackend(id) {
    if (!AGENT_BACKENDS.some((b) => b.id === id)) return;
    state.settings.agentBackend = id;
    backendPanelGroup = backendKindOf(id);
    persistSettings();
    syncBackendSummary();
    renderBackendList();
    console.log('[Agent] 实现方式已选为:', id);
    // 选了但还没就绪时提醒一句：直接告诉用户该点哪个按钮去授权，否则他会在对话里试半天，最后收到一句「你还不能用」。
    const st = backendStatus[id];
    // 只提醒「已经确定不可用」的情况：checking 是面板刚打开、原生状态还没回来的窗口，这时候弹「检测中」纯属误报。
    if (st && st.state !== 'ready' && st.state !== 'checking') {
        const setupLabel = (AGENT_BACKEND_SETUP[id] || {}).label || '去设置';
        void showCustomAlert(
            '已选择「' + backendNameOf(id) + '」，但它现在还不能用：' + (st.text || '状态未知') +
            '\n\n点这张卡片右侧的「' + setupLabel + '」完成授权，然后点「重新检测」。',
            '还需要一步'
        );
    }
}

/** 「去设置 / 请求权限」：原生插件在场就走真跳转（打开无障碍设置页、弹 root 授权框），并把原生返回的说明展示出来；否则弹出该方式的操作说明。网页版和 APK 两种情况都能给出可执行的下一步。 */
async function openBackendSetup(id) {
    const cfg = AGENT_BACKEND_SETUP[id];
    if (!cfg) return;
    if (cfg.plugin && cfg.method) {
        const plugin = window.Capacitor?.Plugins?.[cfg.plugin]
            || (cfg.plugin === 'ElainaDevice' ? deviceBridge() : null);
        if (plugin && typeof plugin[cfg.method] === 'function') {
            try {
                const res = await plugin[cfg.method]();
                // 原生返回的文字必须展示：比如「没能拿到 root 权限：Permission denied」，那正是用户下一步该做什么的依据，吞掉这个按钮就等于没用
                const message = (res && res.text) ? String(res.text) : cfg.guide;
                await showCustomAlert(message, cfg.label);
                void refreshBackendStatus();
                return;
            } catch (e) {
                console.warn('[Agent] 原生设置跳转失败，改用说明:', e);
            }
        }
    }
    await showCustomAlert(cfg.guide, cfg.label);
}

async function refreshBackendStatus() {
    // 必须先把原生状态缓存清掉：否则「重新检测」只是把界面重置成「检测中」，再拿回同一份旧数据 —— 看起来刷新了，其实没有。而授权流程恰恰是「点授权 → 点重新检测 → 状态变已就绪」，不清缓存这一步就永远是空的，用户会以为授权没成功。
    backendStatusCache = null;
    AGENT_BACKENDS.forEach((b) => { backendStatus[b.id] = { state: 'checking', text: '检测中' }; });
    renderBackendList();
    syncBackendSummary();
    await Promise.all(AGENT_BACKENDS.map(async (b) => { backendStatus[b.id] = await detectBackend(b.id); }));
    renderBackendList();
    syncBackendSummary();
}

function openBackendPanel() {
    const el = document.getElementById('backendPanel');
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.add('flex');
    // 层级（100002，盖在设置之上）写在样式表的 #backendPanel 规则里，这里不设 style.zIndex —— .modal-overlay 上的 !important 会让内联值失效。
    renderBackendList();
    void refreshBackendStatus();
}

function closeBackendPanel() {
    const el = document.getElementById('backendPanel');
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('flex');
    // 关掉面板时刷新一次：用户可能刚在里面选了一种方式
    syncBackendSummary();
}

// 入口在「设置 → 手机操作」里（不在侧边栏 —— 手机上侧边栏收起后那里进不去）
document.getElementById('settingBackendChooseBtn')?.addEventListener('click', openBackendPanel);
document.getElementById('settingBackendRefreshBtn')?.addEventListener('click', () => { void refreshBackendStatus(); });
// 浏览器那一块的「重新检测」：只在设置页打开时才会被点到，直接刷一次状态；函数定义在 auth.js（与浏览器状态那块 UI 同一文件），这里只挂按钮。
// 联网搜索：开关切换要立刻反映到下面那块控件上（不等保存）
document.getElementById('settingTavilyEnabled')?.addEventListener('change', (ev) => {
    const on = Boolean(ev.target && ev.target.checked);
    const fields = document.getElementById('tavilyFields');
    if (fields) fields.classList.toggle('hidden', !on);
    if (typeof updateTavilyHint === 'function') updateTavilyHint();
});
document.getElementById('settingTavilyApiKey')?.addEventListener('input', () => {
    if (typeof updateTavilyHint === 'function') updateTavilyHint();
});
// 图片转述：开关切换立刻显隐下面的控件（与联网搜索同一套做法）
// 换服务商：先把刚打进去还没保存的 Key 收回它自己那格再切，否则「A 家填一半 → 想看 B 家 → 切回来」会发现 A 的 Key 没了。
document.getElementById('settingSearchProvider')?.addEventListener('change', () => {
    if (typeof stashCurrentSearchKey === 'function') stashCurrentSearchKey();
    if (typeof fillSearchProviderFields === 'function') fillSearchProviderFields();
    if (typeof updateTavilyHint === 'function') updateTavilyHint();
});
// 鉴权方式：只有"自定义头"才需要填头名称 —— 其余三档名字是固定的。
document.getElementById('settingSearchCustomAuth')?.addEventListener('change', () => {
    if (typeof updateCustomAuthRow === 'function') updateCustomAuthRow();
});
document.getElementById('testTavilyBtn')?.addEventListener('click', () => {
    if (typeof testTavilyConnection === 'function') void testTavilyConnection();
});
document.getElementById('settingBrowserRefreshBtn')?.addEventListener('click', () => {
    if (typeof refreshBrowserStatus === 'function') void refreshBrowserStatus();
});
document.getElementById('backendRefresh')?.addEventListener('click', () => { void refreshBackendStatus(); });
// 「检测副屏」：真建一次副屏，把这台设备能不能后台运行的原话告诉用户。
// 状态卡片只能写"可能不可用"——能否建 trusted 屏随版本与 ROM 变化，只有真试一次才算数。
let backendProbeBusy = false;
document.getElementById('backendProbeBtn')?.addEventListener('click', () => { void probeBackendDisplay(); });

async function probeBackendDisplay() {
    if (backendProbeBusy) return;
    const dev = deviceBridge();
    if (!dev || typeof dev.probeBackground !== 'function') return;
    const chosen = currentBackendId();
    const target = (chosen && backendKindOf(chosen) === 'background')
        ? chosen
        : (readyBackgroundBackends()[0] || {}).id || '';
    if (!target) {
        await showCustomAlert('先在上方选一个后台方式（Shizuku / Root），再点「检测副屏」。', '检测副屏');
        return;
    }
    backendProbeBusy = true;
    const btn = document.getElementById('backendProbeBtn');
    if (btn) { btn.disabled = true; btn.textContent = '检测中…'; }
    try {
        const res = await dev.probeBackground({ backend: target });
        const text = String((res && res.text) || '未知结果');
        backendStatus[target] = { state: (res && res.available) ? 'ready' : 'unavailable', text };
        renderBackendList();
        syncBackendSummary();
        await showCustomAlert(text, (res && res.available) ? '副屏可用' : '副屏不可用');
    } catch (e) {
        await showCustomAlert('检测失败：' + ShellDescribeError(e), '检测副屏');
    } finally {
        backendProbeBusy = false;
        if (btn) { btn.disabled = false; btn.textContent = '检测副屏'; }
    }
}

function ShellDescribeError(e) {
    const message = e && e.message ? e.message : String(e);
    return message.length > 200 ? message.slice(0, 200) + '…' : message;
}
syncBackendSummary();
// 预热「这台电脑的真实位置」（桌面 / 文档 / 下载…）。服务端要起一次 PowerShell 读注册表，大约一两秒；提前拉一次，用户真让 AI 操作文件时提示词里就已带着真实路径。
// 等 DOMContentLoaded 再发：这次探测要用的 fetchWithTimeout 定义在 voice.js（排在 agent.js 之后），此刻调用会在发请求前抛错并被 catch 吞掉；DCL 时整条链路都就绪。
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void detectAgentRoots(), { once: true });
} else {
    void detectAgentRoots();
}
document.getElementById('backendPanelClose')?.addEventListener('click', closeBackendPanel);
document.getElementById('backendPanel')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'backendPanel') closeBackendPanel();
});
