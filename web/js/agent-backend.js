/* ============================================================================
 * Agent 实现方式 / 后端选择（从 agent.js 拆出）
 *
 * AGENT_BACKENDS / 后端探测 / 状态面板 / 手机与命令能力提示词。
 * 依赖 agent-phone.js 的 deviceBridge 与宿主 state / 弹窗（运行时才调用）。
 * ========================================================================== */
'use strict';

// ===== 实现方式（后端选择）=====
// 两种执行方式，能力与门槛不同。入口在「设置 → 能力 → 手机操作」里（不在侧边栏：
// 手机上侧边栏一收起，那里就进不去了），面板本身是一个独立弹窗（#backendPanel）。
// 状态由原生层 ElainaDevice.status() 提供；网页版没有原生层，统一显示「需要在 APK 里使用」。
// 只保留两种：**无障碍 + 模块**。
//   Shizuku 与 Root 本质是同一件事（adb / su 级权限），共同代价是
//   "每次重启要重新授权""授权即全局生效"；而需要的是"门槛低"（无障碍）
//   与"能力最强且不抢前台"（模块）这两个端点。
//   ⚠️ 白名单在 data.js 的迁移里有一份镜像，改这里必须同步改那边，
//   否则老用户选的 shizuku/root 会被当成合法值留下、而它已不对应任何实现方式。
const AGENT_BACKENDS = [
    {
        id: 'accessibility', name: '无障碍', tag: '免 root',
        desc: '用系统自带的无障碍服务点击、输入、读取界面。不用装任何东西，门槛最低；中文输入也只有它能可靠做到。截图（看图）需要 Android 11 及以上；Android 10 及以下只能读界面与点击、滑动、输入。',
        need: '系统设置 → 无障碍里开启本应用的服务'
    },
    {
        id: 'module', name: '模块', tag: '需要 KernelSU',
        desc: '刷入系统模块，后台静默操作：不抢前台、不被后台清理打断，能力最强。',
        need: '刷入 KernelSU 模块（本机 3070 端口有服务）'
    }
];

// 每个实现方式对应的「去设置 / 请求权限」引导。
// plugin/method 指向原生插件 ElainaDevice 上的真实方法：在场就真跳转 / 真弹授权框，
// 返回的说明（比如"没能拿到 root 权限，原因是…"）会直接展示给用户；
// 插件不在（网页版）时退化成下面的说明文字。代码只有一份，两种情况都给出可执行的下一步。
const AGENT_BACKEND_SETUP = {
    accessibility: {
        label: '去开启无障碍',
        plugin: 'ElainaDevice', method: 'openAccessibilitySettings',
        guide: [
            '1. 打开系统的「设置 → 无障碍」（部分机型叫「辅助功能」）',
            '2. 在已安装的服务里找到「ElainaChat Open 手机操作」',
            '3. 打开开关并按提示确认',
            '',
            '各厂商路径：小米在「更多设置 → 无障碍」；华为 / 荣耀在「辅助功能 → 无障碍」；OPPO / 一加在「系统设置 → 无障碍」。'
        ].join('\n')
    },
    module: {
        label: '怎么刷模块',
        guide: [
            '模块方式需要先在手机上刷入 KernelSU 模块，它会提供一个本地服务（默认 127.0.0.1:3070）。',
            '',
            '1. 确认手机已刷 KernelSU 并装好管理器',
            '2. 刷入模块后重启手机',
            '3. 回来点「重新检测」，状态会变成「已就绪」',
            '',
            '刷上之后 AI 可以后台静默操作手机，不抢占你正在用的界面，是几种方式里体验最好的。',
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

/**
 * 注入系统提示词的「手机操作」能力说明。
 *
 * 为什么必须有这一段：整个执行链路（标签解析 → 停止检查 → 授权 → 原生 exec → 结果回灌）
 * 早就是通的，但**提示词里从来没有告诉过模型它有能力操作手机** ——
 * LIVE2D_TAG_GUIDE 的【操作标签】只列了 7 个应用内操作，一个 `手机*` 都没有。
 * 模型不知道标签存在，就永远不会输出它，用户看到的现象正是"AI 好像不能操作手机"。
 *
 * 分三档，避免"告诉了却做不到"：
 *   · 没有原生设备层（网页版）→ 不注入。用户界面上也没有这块设置，提了只会让模型空谈。
 *   · 有设备层但没选实现方式 / 总开关关着 → 注入"未启用"说明，并**明确禁止输出标签**
 *     （那些标签会被 runAgentPhoneOperation 直接拒绝）。这样模型会去引导用户开设置，
 *     而不是编造"我操作好了"。
 *   · 可用 → 注入完整能力清单 + 工作方式 + 反幻觉约束。
 */
function agentPhoneSkillText() {
    if (!deviceBridge()) return '';
    const enabled = state.settings.agentPhoneEnabled !== false;
    // 不要求设置里预先选好实现方式：只要总开关开着、且**至少一条路就绪**，
    //   这一轮就可能操作手机 —— 两路都就绪时会先弹窗问用户"前台还是后台"
    //   （见 pickPhoneRunMode）。
    //   若在 backend 为空时注入"未启用、不要输出标签"，模型在"还没选默认方式"
    //   时会彻底不试，而弹窗机制恰恰是为这种状态准备的。
    const accReady = backendStatus.accessibility && backendStatus.accessibility.state === 'ready';
    const modReady = backendStatus.module && backendStatus.module.state === 'ready';
    const chosen = currentBackendId();
    const effective = (chosen === 'accessibility' && accReady) ? 'accessibility'
        : (chosen === 'module' && modReady) ? 'module'
            : (accReady ? 'accessibility' : (modReady ? 'module' : ''));
    const backend = effective;
    const bothReady = accReady && modReady;
    if (!enabled || !backend) {
        return '# Agent Skill：手机操作（当前未启用）\n'
            + '这台设备支持手机操作，但用户还没有在「设置 → 能力 → 手机操作」里选好「实现方式」'
            + (enabled ? '' : '，或「允许 AI 操作手机」总开关是关闭的') + '。\n'
            + '因此你现在**不能**操作手机，也**不要**输出 [操作:手机…] 标签（会被系统直接拒绝，等于白说）。\n'
            + '如果用户希望你操作手机，请如实说明还没有启用，并引导他去「设置 → 能力 → 手机操作」'
            + '点「选择实现方式」选一种（无障碍门槛最低），并确认「允许 AI 操作手机」已勾选。';
    }
    // 能力清单必须按实现方式区分：无障碍**做不到**「手机打开」与「手机命令」
    // （原生层会明确回失败）。提示词里把它俩写成通用能力，就会造成"说了却做不到"，
    // 模型反复尝试、用户看到一连串失败。
    // 但「模块」与「无障碍」是互通的、由 AI 看情况使用：
    //   只要**另一种方式也可用**，能力面就是两者的**并集** —— 原生侧会在
    //   "首选做不到这个动作"时自动换路并在结果里注明
    //   （见 ElainaShellPlugin 的 accessibilityCannotDo / annotateBackendSwap）。
    //   所以不能写成"⛔ 不支持手机打开/手机命令"：那会让模型**自我审查**，
    //   明明能做到的事却回用户一句"我做不到"。只有另一路确实不可用时才保留边界说明。
    const isAccessibility = backend === 'accessibility';
    // backendStatus 是 detectBackend 的探测结果（ready / unavailable / pending / checking）。
    // 还在 checking 时按"不可用"处理 —— 宁可保守，等探测完再放开能力面。
    const otherId = isAccessibility ? 'module' : 'accessibility';
    const otherReady = Boolean(backendStatus[otherId] && backendStatus[otherId].state === 'ready');
    const canOpenAndCommand = !isAccessibility || otherReady;
    // 提示词只留"索引 + 一句话用法"：标签清单（每条一行）＋ 能力边界 ＋ 反幻觉一句。
    //   详细用法（坐标怎么取、输入中文怎么处理、哪些操作问不问用户、工作区路径规则）
    //   移到注册表里 phone 的**说明书**，由 agent_help 用到时才下发（见本文件 setManual 段）。
    const lines = [
        '# Agent 能力：手机操作（当前方式：'
            + (bothReady ? '无障碍 / 模块（每次操作前由用户选）' : backendNameOf(backend)) + '）',
        '你可以操作这台安卓手机：读取界面、点击、滑动、输入文字、按键、截图'
            + (canOpenAndCommand ? '、打开应用、执行命令' : '') + '。',
        '可用标签（写在回复正文里，标签不会显示给用户）：',
        '· [操作:手机状态] —— 查询设备与当前后端状态',
        '· [操作:手机查看界面] —— 读取当前屏幕的控件树（含控件文字与可点击坐标）',
        '· [操作:手机截图] —— 截屏（需在「设置 → 模型 → 视觉模型」配好多模态模型，否则拿不到画面内容）',
        '· [操作:手机点击 x y] —— 点击坐标，例如 [操作:手机点击 540 1200]',
        '· [操作:手机滑动 x1 y1 x2 y2 [时长毫秒]] —— 例如 [操作:手机滑动 540 1600 540 800 300]',
        '· [操作:手机输入 文字] —— 向当前获得焦点的输入框输入文字',
        '· [操作:手机按键 返回|主页|回车|菜单|音量上|音量下] —— 按系统键',
        '· [操作:手机等待 毫秒] —— 等界面加载完再继续',
    ];
    if (canOpenAndCommand) {
        lines.push('· [操作:手机打开 包名] —— 启动应用，例如 [操作:手机打开 com.tencent.mm]');
        if (isAccessibility) {
            // 用户在「运行方式」弹窗里选了前台时，原生**不自动换路**
            //   （选了就该按选的走，见 ElainaShellPlugin 的 strict）。所以这里不能承诺
            //   "会自动改用模块" —— 那会让模型以为输出了就一定能成，然后白撞一次失败。
            lines.push('  （无障碍**做不到**这件事：前台运行时会直接失败并说明原因 —— '
                + '要启动应用就先用 [操作:手机查看界面] 找到图标再点坐标，'
                + '或请用户改选「后台运行（模块）」；用户已经选了后台时，你照常输出标签即可。）');
        }
    } else {
        // 边界说明只在"另一路也确实不可用"时才给 —— 见上面那段说明。
        lines.push('· ⛔ 当前**不支持** [操作:手机打开]（启动应用）'
            + ' —— 无障碍方式做不到这件事，而「模块」方式现在也没就绪。');
        lines.push('  要启动某个应用，请先用 [操作:手机查看界面] 找到它的图标，再点击图标坐标；'
            + '或请用户到「设置 → 能力 → 手机操作」把「模块」方式配置好（两种方式会自动互通）。');
        lines.push('· 按键也只支持「返回 / 主页 / 最近任务」三个，其它按键需要「模块」方式。');
    }
    // 手机命令：**两种方式现在都做不到**，所以在能力面上彻底不列它。
    //   无障碍本来就不执行命令；模块 0.8.x 把 root shell 直通端点（/api/shell）
    //   以安全为由删了，且没有等价替代 —— 这条能力已从"某一种方式做不到"
    //   变成"根本不存在"。仍然写在这里、而不是直接从提示词里删掉：
    //   模型可能从历史对话或用户的话里猜到标签名，留一句明确的"不支持"
    //   能让它当场改口给替代方案，而不是输出一条注定失败的命令。
    lines.push('· ⛔ **不支持** [操作:手机命令] —— 两种方式都做不到：'
        + '无障碍方式不执行任意命令；「模块」方式在新版里移除了 shell 直通端点（/api/shell）。'
        + '需要跑系统命令请改用电脑端，不要在回复里假装执行了。');
    if (bothReady) {
        // 两路都就绪 → 系统会在**真正操作屏幕前**弹窗让用户选前台/后台。
        //   必须把这件事告诉模型：否则它可能自己反问用户"你想用哪种方式"，
        //   或以为得先回设置里选 —— 那都是多余的，系统会处理。
        lines.push('· ⚙️ 这台设备**两种方式都可用**：每次要操作屏幕前，系统会先请用户选择'
            + '「前台运行（无障碍·看得见 AI 操作）」还是「后台运行（模块·静默不抢屏幕）」。'
            + '你照常输出标签即可 —— 不用自己选，也不要问用户这件事。'
            + '（读取信息、工作区文件、等待不需要选。）');
    }
    lines.push(
        '· [操作:手机列出文件 [路径]] —— 列出 Agent 工作区或已授权文件夹里的内容',
        '· [操作:手机读文件 路径] —— 读取文本文件内容',
        '· [操作:手机写文件 路径|内容] —— 写入文件（工作区内直接写；工作区外需用户已授权该文件夹）',
        '· [操作:手机删除文件 路径] —— 删除文件或目录（⚠️ 不可恢复）',
        '',
        '【可读取的信息】',
        ...phoneReadSkillLines(),
        '需要用户先在系统里授予对应权限；**没有授权时会明确报「没有权限」** —— 那时如实告诉用户去开启，'
            + '不要假装读到了。**列表里没出现的项**表示用户已在设置里关闭，**不要**尝试输出它（会被直接拒绝）。',
        '通知、短信、通讯录、日历是用户的**隐私数据**：只在真的需要时读，不要在回复里罗列无关细节。',
        '',
        '用法：一次只做一步，**先看再点、点完再确认** —— 不知道屏幕上有什么时先 [操作:手机查看界面]，'
            + '**不要凭猜测点坐标**；每次点击 / 滑动 / 输入之后都要再 [操作:手机查看界面] 确认界面变了，'
            + '没变就换控件或重读，不要在同一坐标上反复点。能按 id 点就写 [操作:手机按键 id:<资源id>]。'
            + '读不懂界面时用 [操作:手机截图]（会给画面描述 + 可点元素编号与坐标，照着坐标点，别从图片估像素）。'
            + '读到的控件清单是给你判断用的内部信息，**不要把清单原文 / id / 坐标原样贴给用户**，要说明就用自己的话概括。'
            + '回灌里说「不支持」就是当前方式的能力边界，**不要重复尝试**，'
            + '改用别的方式或如实告诉用户。⚠️ 只有真的输出了标签（或工具调用）才会执行，'
            + '结果一律以系统回灌为准 —— **绝不编造**"我已经点了/已经打开了/操作成功"。'
    );
    return lines.join('\n');
}

/**
 * 「读取信息」能力清单，**按隐私开关逐项过滤**。
 *
 * 为什么要在提示词这一层就过滤，而不是只说"不许用"：
 *   告诉模型一个能力存在、再要求它别用，它迟早会用（尤其是用户随口一句
 *   "帮我看看刚谁发消息了"）。直接从清单里拿掉，它连标签名都看不到。
 *   第二道闸在 runAgentPhoneOperation（关掉的会被明确拒绝）。
 */
function phoneReadSkillLines() {
    const all = [
        { action: '手机应用列表', line: '· [操作:手机应用列表] —— 已安装应用的包名与应用名（想启动某个应用但不知道包名时用它）' },
        { action: '手机通知', line: '· [操作:手机通知] —— 最近收到的通知（哪个应用、标题、内容）' },
        { action: '手机设备信息', line: '· [操作:手机设备信息] —— 电量、网络、前台应用等当前状态' },
        { action: '手机短信', line: '· [操作:手机短信 [条数]] —— 最近短信' },
        { action: '手机通讯录', line: '· [操作:手机通讯录 [关键词]] —— 联系人（可带姓名关键词筛选）' },
        { action: '手机日历', line: '· [操作:手机日历 [天数]] —— 近期日程' },
    ];
    const kept = all.filter((x) => phoneReadAllowed(x.action)).map((x) => x.line);
    // 全被关掉时不要留一个空标题
    if (!kept.length) return ['（用户已关闭全部"读取信息"权限，你现在没有这类能力。）'];
    return kept;
}

/**
 * 手机（APK）上给模型的「电脑侧不存在」说明 —— 用来**替代**电脑的文件/命令能力清单。
 *
 * 为什么必须在手机上显式说"没有电脑侧"：
 *   与 agentCommandSkillText 是同一个坑的两个方向 —— 那边是"注入了也做不到"，
 *   这里是"不说清它就乱答应"。
 *   实测：
 *   手机上仍注入了电脑的文件能力（"你可以读写**这台电脑**上的任意路径"），
 *   用户问"能不能在本机新建一个文件"，模型答
 *   "我能在本机新建文件……这台设备设置成了逐条确认模式" ——
 *   那全是**电脑**的说法，手机上根本没有 /api/agent/* 这套后端，做不到。
 *   手机能做的文件操作是 [操作:手机…] 那一套（Agent 工作区 / 用户已授权的文件夹），
 *   由 agentPhoneSkillText 按实现方式与开关状态注入 —— 这里只负责把"电脑那套"关掉，
 *   并明确告诉模型"别把电脑的说法拿来答手机的问题"。
 */
function agentComputerUnavailableSkillText() {
    return '# 电脑操作：本设备没有这一侧（当前在安卓手机 App 里运行）\n'
        + '你现在运行在**手机**上，**没有**"电脑"这一侧的能力：\n'
        + '· 不能读写电脑上的文件、不能查看电脑目录（[操作:列出文件/查看文件/保存文件] 会被直接拒绝）；\n'
        + '· 不能执行 PowerShell / cmd 命令（[操作:电脑命令] 会被直接拒绝）；\n'
        + '· 也**不要**提桌面、文档、下载这类电脑路径。\n'
        // ⚠️ 这里**不要**把手机那四个文件标签逐个列出来 ——
        //   手机操作没启用时，agentPhoneSkillText 是刻意"连标签名都不给"的
        //   （避免模型去试一个会被直接拒绝的能力）。这里列出来就会自相矛盾。
        + '手机上的文件操作走的是另一套 [操作:手机…] 标签 —— '
        + '**能不能用，以上面「手机操作」那一段为准**（它没给出写文件标签，就说明现在用不了）。\n'
        + '⚠️ 用户问"能不能在本机 / 这台设备上新建文件"这类问题时，按**手机**的能力如实回答：'
        + '上面「手机操作」那段给出了写文件标签就照它说，没给出就如实说明现在做不到，'
        + '**绝不**承诺"能读写这台电脑上的任意路径"。';
}

/**
 * 注入系统提示词的「电脑命令」能力说明。
 *
 * 为什么必须有这一段：和手机操作同一个坑 —— 执行链路早就通了，
 * 但提示词里不告诉模型标签存在，它就永远不会输出，用户看到的现象是
 * "AI 好像不能执行命令"。
 *
 * 三档模型下**一律注入**（不按档位决定要不要讲这个能力）：三档都能执行命令，
 *   区别只在"要不要问"，所以每一档都需要知道这个能力存在。
 *   提示词按档位改写"要不要确认"那一句 —— 否则模型会以为会被静默拒绝，
 *   或者反过来编造"命令已执行"。这是 agentPhoneSkillText 里同一条反幻觉约束。
 */
function agentCommandSkillText() {
    // APK 没有本机服务端（没有 /api/agent/exec），注入了也执行不了。
    // 必须用 IS_NATIVE_APP 而不是看协议 —— Capacitor 的 androidScheme 是 https，
    // 按协议判断会把 APK 当成网页版，于是注入一个用不了的能力（模型反复失败）。
    if (IS_NATIVE_APP) return '';
    // `off` 档：电脑操作整体关闭 —— 连能力都不该让模型看到（由 agentDisabledSkillText 说明）。
    if (agentAccessDisabled()) return '';
    const accessLabel = commandAccessLabel();
    // 提示词只留"索引 + 一句话用法"：标签与当前档位的确认规则 ＋ 反幻觉一句。
    //   详细用法（输出截断怎么办、不确定命令怎么写、删除类命令的注意事项）
    //   移到注册表里 pc_command 的**说明书**，由 agent_help 用到时才下发。
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

/**
 * 「电脑命令」当前档位数不数得清"要不要问"：命令通道的闸比文件通道更粗 ——
 *   `auto` 档下普通命令直接执行，只有危险命令才问；这一点与「禁止删除」那套不同，
 *   所以单独说一句，而不是复用 accessPhrase()。
 */
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

/**
 * `off` 档注入给模型的说明：电脑操作已关闭。
 *
 * 为什么必须显式注入、而不是"不注入能力就等于没有能力"：
 *   模型被用户直接要求"帮我写个文件"时，若提示词里没有任何关于电脑操作的说明，
 *   它既可能凭训练先验输出 [操作:保存文件 …]（然后被服务端拒绝，用户看到一次
 *   莫名其妙的失败），也可能反过来编造"我已经帮你写好了"。两种都要避免 ——
 *   所以明确告诉它"这个能力已被用户关闭"，并要求它如实说明、不要输出标签、不要编造。
 */
function agentDisabledSkillText() {
    if (!agentAccessDisabled()) return '';
    return '# 电脑操作：已关闭（用户的选择）\n'
        + '用户已在「设置 → 能力 → AI 权限」里选择「关闭」——你**不能**读取、写入或修改这台电脑上的任何文件，'
        + '不能查看目录或真实路径，也不能执行电脑命令（这些标签会被系统直接拒绝）。\n'
        // 先给**怎么说**，再给**不许怎么说**。
        //   只列禁止（"别说已经做了""别推给身体"）不够 —— 实测模型会继续换别的借口
        //   （"我是魔女不懂科技""我没有电脑""我手里是法杖不是键盘"），因为它手上没有一句能说的话。
        //   所以这里直接给它**唯一正确的那句话**：权限关着 + 怎么打开。这一句既真实，也符合她的说话方式。
        + '用户提出这类要求时，你要讲清的**只有两件事**：① 这台机器的电脑操作被关掉了（是你这边的权限设置，不是他的机器坏了）；'
        + '② 去「设置 → 能力 → AI 权限」打开就能用；他要是不想开，自己在桌面新建个 .txt 也一样。\n'
        + '⚠️ **用你自己的口吻说这两件事就行，不要逐字照搬上面这段说明** —— 那是给你的事实，不是台词。\n'
        + '⚠️ 说完这件事就够，不必展开解释。你**一直在用这台机器**（你们同处一室），\n'
        + '所以不要说"我不懂科技""我没有电脑""魔女不会用这种东西"——那是编出来的隔阂。\n'
        + '不要输出任何 [操作:…] 文件/命令标签，也**绝不要**把做不到的事说成已经做了。\n'
        // 这一条针对一种很具体的失败（用户实测）：关掉权限后，模型把"保存成功"写成了
        //   【AI 操作结果】✅ 已保存到：D:\… 这种格式 —— 因为它在历史对话里见过宿主插的这条。
        //   用户去桌面一看什么都没有，而这段话看起来**像系统回执**，比普通的编造更能骗过人。
        //   所以要点名禁止"照抄这个回执格式"，并且明确：那种回执只由系统在真的写成后产生。
        + '⚠️ **不要伪造系统回执。** 不要写「【AI 操作结果】」这个标题，也不要写「✅ 已保存到：…」「已创建」这类回执行 —— '
        + '它们看起来像系统给出的确认，但系统只会在**真的写成之后**才生成它们。你手写出来就是骗人。\n'
        + '想配合用户的心情可以理解，但只能说"要是有权限就好了""等你能开权限时我再帮你"，'
        + '**不能**用一句"好啦，搞定"把没做的事盖过去。\n'
        // ⚠️ 另一种很常见的躲避方式（实测）：模型把"做不到"归因到**世界观**上 ——
        //   "我没有实体双手""我是魔女不会念电子咒文""我坐旅店里没碰你的板子"。
        //   这既与设定矛盾（她与现代设备同处一室、本来就在用），
        //   也把"权限被关掉"这个**真实原因**换成了一个逃避的说法 —— 用户会以为是自己设备的问题。
        //   该说的只有一件事：权限关着，打开就能做。
        + '⚠️ **不要把"做不到"推到世界观或身体上**：不要说"我没有实体双手""魔女不会操作电脑"\n'
        + '  "我没碰你的板子"这类话。这台机器你本来就在用，原因**只有一个**：用户在设置里把它关掉了。\n'
        + '（应用内操作如视频通话、整理记忆、水印、背景等不受影响，照常可用。）';
}

/**
 * 刷新「设置 → 手机操作」里那块实现方式的显示。
 *
 * 注意：这里**只更新文字和徽标，不禁用任何东西**。
 * 实现方式只是"AI 走哪条路"的选择，下面的总开关和确认策略跟它无关，
 * 没选实现方式也照样能改 —— 把设置锁住只会让人以为坏了。
 */
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
            bridge.style.color = '#059669';
        } else {
            bridge.textContent = '原生设备层：不在（当前是网页版，手机操作只能在安卓版 App 里用）';
            bridge.style.color = '#b45309';
        }
    }
    if (!summary) return;
    if (!chosen) {
        summary.textContent = '还没有选择实现方式，AI 现在不能操作手机。点下面的「选择实现方式」选一种。';
        summary.style.color = '#b45309';
        return;
    }
    const st = backendStatus[chosen];
    const ready = st && st.state === 'ready';
    const checking = !st || st.state === 'checking';
    const stateWord = checking ? '检测中' : (ready ? '已就绪' : '现在还不能用');
    const detail = st && st.text ? '：' + st.text : '';
    summary.textContent = '当前实现方式：' + backendNameOf(chosen) + '（' + stateWord + detail + '）';
    summary.style.color = ready ? '#059669' : '#b45309';
}

/**
 * 设备状态只问原生一次，四个后端共用 —— 否则 status() 会被连问四遍，
 * 而它内部要 ping Shizuku、连一次 3070 网关，四遍纯属浪费。
 */
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

/** 探测某个后端当前是否可用 */
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
        // 走到这里说明原生层在场但 status() 没回答。
        // 别说成"网页版"——那会把人引到完全错的方向，如实报错。
        return { state: 'unavailable', text: '原生设备层没有响应，重启一下应用再试' };
    }
    // 网页版没有原生层。只有「模块」能真探测：它的网关在本机 3070，
    // no-cors 的 fetch 读不到响应内容，但"有没有响应"足够判断它在不在。
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
    // 网页版没有原生层，几种实现方式都探测不了，也不需要探测：
    // 「手机操作」只在安卓版 App 里可用（浏览器没有点击/输入屏幕的能力）。
    return { state: 'pending', text: '需要在安卓版 App 里使用' };
}

function backendStatusBadge(st) {
    const map = {
        ready: ['已就绪', 'color:#059669;background:#ecfdf5'],
        unavailable: ['不可用', 'color:#b45309;background:#fffbeb'],
        pending: ['仅 APK', 'color:#818cf8;background:#eef2ff'],
        checking: ['检测中', 'color:#818cf8;background:#eef2ff']
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

function renderBackendList() {
    const box = document.getElementById('backendList');
    if (!box) return;
    const cur = currentBackendId();
    const tip = cur ? '' :
        '<p class="text-[11px] leading-relaxed mb-2" style="color:#b45309;background:#fffbeb;border:1px solid #fef3c7;border-radius:12px;padding:8px 12px">还没有选择实现方式，AI 现在不能操作手机。选一种即可启用（需要该方式在你这台设备上可用）。</p>';
    box.innerHTML = tip + AGENT_BACKENDS.map((b) => {
        const active = b.id === cur;
        const setup = AGENT_BACKEND_SETUP[b.id];
        const st = backendStatus[b.id];
        // 状态说明来自原生层（"还没授权，点「请求 root 授权」"这种），
        // 必须显示出来 —— 手机上没法 hover，只给个"不可用"用户不知道该做什么
        const detail = (st && st.state !== 'checking' && st.text) ? escapeBackendText(st.text) : '';
        const detailColor = (st && st.state === 'ready') ? '#059669' : '#b45309';
        // 用 div 而不是 button：卡片里还要放「去设置」按钮，而 button 不能嵌套 button
        return '<div data-backend="' + b.id + '" role="button" tabindex="0"'
            + ' class="backend-card w-full text-left rounded-2xl border px-4 py-3 transition cursor-pointer' + (active ? ' is-active' : '') + '"'
            + ' style="border-color:' + (active ? '#f9a8d4' : '#e4e4f7') + ';background:' + (active ? 'rgba(253,242,248,.7)' : 'rgba(255,255,255,.7)') + '">'
            + '<div class="flex items-center gap-2">'
            + '<span class="text-sm font-semibold text-indigo-950">' + b.name + '</span>'
            + '<span style="font-size:10px;color:#818cf8;background:#eef2ff;padding:2px 6px;border-radius:7px;white-space:nowrap">' + b.tag + '</span>'
            + '<span class="ml-auto">' + backendStatusBadge(st) + '</span>'
            + '</div>'
            + (detail ? '<p class="text-[11px] mt-1 leading-relaxed" style="color:' + detailColor + '">' + detail + '</p>' : '')
            + '<p class="text-[11px] text-indigo-400 mt-1 leading-relaxed">' + b.desc + '</p>'
            + '<div class="flex items-center gap-2 mt-1">'
            + '<span class="text-[11px] text-indigo-300 leading-relaxed flex-1">需要：' + b.need + '</span>'
            + (setup ? '<button type="button" data-backend-setup="' + b.id + '" class="btn-secondary text-[11px] flex-shrink-0" style="padding:3px 10px">' + setup.label + '</button>' : '')
            + '</div>'
            + (active ? '<p class="text-[11px] font-semibold mt-1" style="color:#db2777">当前使用</p>' : '')
            + '</div>';
    }).join('');
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
    if (curEl) curEl.textContent = cur ? backendNameOf(cur) : '尚未选择';
}

function selectBackend(id) {
    if (!AGENT_BACKENDS.some((b) => b.id === id)) return;
    state.settings.agentBackend = id;
    persistSettings();
    syncBackendSummary();
    renderBackendList();
    console.log('[Agent] 实现方式已选为:', id);
    // 选了但还没就绪时提醒一句：直接告诉用户该点哪个按钮去授权。
    // 否则他会在对话里试半天，最后收到一句"你还不能用"的回灌。
    const st = backendStatus[id];
    // 只提醒"已经确定不可用"的情况。
    // checking 是面板刚打开、原生状态还没回来的窗口，这时候弹
    // 「它现在还不能用：检测中」纯属误报 —— 用户刚点完就被自己的界面否掉。
    if (st && st.state !== 'ready' && st.state !== 'checking') {
        const setupLabel = (AGENT_BACKEND_SETUP[id] || {}).label || '去设置';
        void showCustomAlert(
            '已选择「' + backendNameOf(id) + '」，但它现在还不能用：' + (st.text || '状态未知') +
            '\n\n点这张卡片右侧的「' + setupLabel + '」完成授权，然后点「重新检测」。',
            '还需要一步'
        );
    }
}

/**
 * 「去设置 / 请求权限」：原生插件在场就走真跳转（打开无障碍设置页、弹 root 授权框），
 * 并把原生返回的说明展示出来；否则弹出该方式的操作说明。
 * 网页版和 APK 两种情况都能给出可执行的下一步。
 */
async function openBackendSetup(id) {
    const cfg = AGENT_BACKEND_SETUP[id];
    if (!cfg) return;
    if (cfg.plugin && cfg.method) {
        const plugin = window.Capacitor?.Plugins?.[cfg.plugin]
            || (cfg.plugin === 'ElainaDevice' ? deviceBridge() : null);
        if (plugin && typeof plugin[cfg.method] === 'function') {
            try {
                const res = await plugin[cfg.method]();
                // 原生返回的文字必须展示：比如"没能拿到 root 权限：Permission denied"，
                // 那正是用户下一步该做什么的依据，吞掉的话这个按钮就等于没用
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
    // 必须先把原生状态缓存清掉。
    // 否则「重新检测」只是把界面重置成"检测中"，再拿回同一份旧数据 —— 看起来刷新了，其实没有。
    // 而授权流程恰恰是「点授权 → 点重新检测 → 状态变已就绪」，
    // 不清缓存这一步就永远是空的，用户会以为授权没成功。
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
    // 层级（100002，盖在设置之上）写在样式表的 #backendPanel 规则里，
    // 这里不设 style.zIndex —— .modal-overlay 上的 !important 会让内联值失效
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
// 浏览器那一块的「重新检测」：只在设置页打开时才会被点到，直接刷一次状态。
//   函数定义在 settings.js（与那块 UI 同一文件），这里只挂按钮 —— 挂载点跟着
//   「设置页的按钮都在 agent.js 里挂」这条既有惯例走。
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
document.getElementById('settingVisionEnabled')?.addEventListener('change', (ev) => {
    const on = Boolean(ev.target && ev.target.checked);
    const fields = document.getElementById('visionFields');
    if (fields) fields.classList.toggle('hidden', !on);
});
// 换服务商：先把**刚打进去还没保存**的 Key 收回它自己那格，再切 ——
//   否则"A 家填一半 → 想看 B 家 → 切回来"会发现 A 的 Key 没了。
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
syncBackendSummary();
// 预热「这台电脑的真实位置」（桌面/文档/下载…）。服务端要起一次 PowerShell 读注册表，
// 大约一两秒；提前拉一次，用户真让 AI 操作文件时提示词里就已经带着真实路径了。
// 等 DOMContentLoaded 再发，不在这里直接调用：这次探测要用的 fetchWithTimeout 定义在
// voice.js，而那个文件排在 agent.js 之后（顺序见 index.html）。此刻它还不存在，调用会在
// 发起请求之前就抛错并被 core.js 的 catch 吞掉 —— 预热白跑一趟，真实路径只能等到第一条
// 消息拼提示词时现取（那次 6 秒超时一旦赶不上 PowerShell 冷启动，这一轮提示词里就干脆
// 没有路径，AI 只能按惯例猜 C:\Users\<用户名>\Desktop）。DCL 在所有同步脚本执行完之后
// 触发，那时整条链路都就绪。
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void detectAgentRoots(), { once: true });
} else {
    void detectAgentRoots();
}
document.getElementById('backendPanelClose')?.addEventListener('click', closeBackendPanel);
document.getElementById('backendPanel')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'backendPanel') closeBackendPanel();
});


