// 电脑命令执行 —— AI 在「全权限」模式下执行 PowerShell / cmd 命令：安全的（dir、Get-Date、git status）直接跑，危险的（删文件、改注册表、关机、下载并执行）必须用户点「允许」——
// 全拒会让能力没用，全放等于把电脑交给对话里可能出现的任意文本，分级是唯一可行的中间态。
// 安全边界：调用方必须限制 isLocalRequest（局域网设备绝不能执行宿主机命令）；approved 由服务端判定危险并强制要求，不能只信前端传来的"用户已同意"；外部进程必须有超时（否则一条 ping -t 挂死请求），输出必须截断（否则 dir /s C:\ 能把内存吃光）。
import { execFile } from 'node:child_process';

export const CMD_TIMEOUT = 30000;

export const MAX_OUTPUT = 20000;

/**
 * 危险命令规则表：每条 = { re, why }，命中任意一条即判为 dangerous、需要用户授权。
 * 用「黑名单 + 用户授权」而不是「白名单 + 放行」：白名单会让能力基本不可用；规则按「破坏力」而不是「命令名」组织 —— 同一个 rm 在 Windows 上叫 del / Remove-Item，按名字列举必漏。
 */
const DANGEROUS_RULES = [
    // 删除 / 覆盖
    { re: /\b(rm|rmdir|del|erase|rd)\b/i, why: '删除文件或目录' },
    { re: /\bRemove-Item\b/i, why: '删除文件或目录（PowerShell）' },
    { re: /\b(Format-Volume|format)\b/i, why: '格式化磁盘' },
    { re: /\b(Clear-Content|Set-Content)\b/i, why: '清空或覆盖文件内容' },
    { re: /\b(truncate|shred|wipe)\b/i, why: '销毁数据' },

    // 关机 / 重启 / 会话
    { re: /\b(shutdown|Restart-Computer|Stop-Computer)\b/i, why: '关机或重启电脑' },
    { re: /\b(logoff|tsdiscon)\b/i, why: '注销当前用户' },
    { re: /\bStop-Process\b|\btaskkill\b|\bkill(all)?\b/i, why: '强制结束进程' },

    // 权限 / 账户
    { re: /\b(runas|sudo|gsudo)\b/i, why: '提权执行' },
    { re: /\bnet\s+(user|localgroup)\b/i, why: '增删用户或改用户组' },
    { re: /\b(takeown|icacls|cacls|Set-Acl)\b/i, why: '修改文件权限或所有权' },
    { re: /\b(New-LocalUser|Add-LocalGroupMember|Set-LocalUser)\b/i, why: '创建或修改本地账户' },

    // 注册表 / 系统配置
    { re: /\breg\s+(add|delete|import|restore|copy|save)\b/i, why: '修改注册表' },
    // New-ItemProperty / Set-ItemProperty / Remove-ItemProperty 是注册表操作；New-Item 不在此表内以免误伤 —— 它最常用来建普通文件夹（AI 的「新建文件夹」正是它），破坏力上限是"多个空文件/目录"，不值得为它打断用户。
    { re: /\b(New-ItemProperty|Set-ItemProperty|Remove-ItemProperty)\b/i, why: '修改注册表' },
    { re: /\b(bcdedit|bootrec|diskpart)\b/i, why: '修改启动配置或磁盘分区' },
    { re: /\b(Set-ExecutionPolicy|sc\.exe|New-Service|Stop-Service|Start-Service)\b/i, why: '修改执行策略或系统服务' },

    // 下载并执行（供应链 / 远控最常见的落地方式）
    { re: /\b(Invoke-WebRequest|Invoke-RestMethod|curl|wget|certutil|bitsadmin)\b/i, why: '下载文件（可能被用于下载并执行）' },
    { re: /\b(iex|Invoke-Expression|Start-Process)\b/i, why: '动态执行代码或启动进程' },
    { re: /\b(EncodedCommand|-enc\b|-e\s+[A-Za-z0-9+/=]{40,})/i, why: '执行 Base64 编码的命令（常用于隐藏意图）' },

    // 管道直灌 shell
    { re: /\|\s*(bash|sh|zsh|powershell|pwsh|cmd|iex|Invoke-Expression)\b/i, why: '把内容通过管道直接交给解释器执行' },

    { re: /\b(mkfs|fdisk|dd)\b/i, why: '磁盘底层操作' },
    { re: /\bchkdsk\b.*\/f/i, why: '修复磁盘（会改动文件系统）' },

    // 网络配置
    { re: /\b(netsh|ipconfig)\b.*\b(set|release|renew|reset)\b/i, why: '修改网络配置' },
    { re: /\broute\s+(add|delete)\b/i, why: '修改路由表' },
];

/** 命令里出现"重定向到系统关键位置"这类写法 —— 单独一条，因为它不靠命令名判定：`echo x > C:\Windows\...` 用的全是无害命令，破坏力却很大 */
const DANGEROUS_TARGET = /(?:>>?|Out-File|Set-Content|Add-Content)\s*['"]?([A-Za-z]:\\|\\\\|\/(?:etc|bin|usr|boot|dev)\/)/i;

/** 判定一条命令的危险级别：risk 为 'dangerous' 时必须先取得用户授权（服务端强制）；返回 { risk: 'safe'|'dangerous', reasons } */
export function classifyCommand(command) {
    const text = String(command || '').trim();
    if (!text) return { risk: 'safe', reasons: [] };

    const reasons = [];
    for (const rule of DANGEROUS_RULES) {
        if (rule.re.test(text) && !reasons.includes(rule.why)) reasons.push(rule.why);
    }
    if (DANGEROUS_TARGET.test(text)) {
        const why = '把输出重定向到系统关键路径';
        if (!reasons.includes(why)) reasons.push(why);
    }
    return { risk: reasons.length ? 'dangerous' : 'safe', reasons };
}

export function availableShells() {
    if (process.platform === 'win32') return ['powershell', 'cmd'];
    return ['sh'];
}

/**
 * 把「shell 名 + 命令」翻译成 execFile 的 argv：命令始终作为单个 argv 元素传进去、绝不拼接字符串 —— 拼接会让 `; rm -rf /` 这类内容逃出命令本身的边界，作为 argv 传则 shell 只把它当"要执行的脚本文本"；
 * 用 execFile 而不是 exec 同理（后者会把整条命令交给 cmd /c 再解析一次，多一层可注入面）。
 * 输出编码：Windows 中文系统的 PowerShell / cmd 按 GBK（代码页 936）输出、Node 按 UTF-8 解码会全成乱码，所以两种 shell 都在命令前设 UTF-8（PowerShell 设 [Console]::OutputEncoding，cmd 用 chcp 65001，均与原命令分隔）。
 */
export function buildShellArgv(shell, command) {
    const cmd = String(command || '');
    if (shell === 'cmd') {
        return { file: 'cmd.exe', args: ['/d', '/s', '/c', `chcp 65001>nul & ${cmd}`] };
    }
    if (shell === 'sh') return { file: 'sh', args: ['-c', cmd] };
    // PowerShell：-NoProfile 避免加载用户 profile（里面可能有任意代码、输出也不稳定），-NonInteractive 避免它停下来等输入；编码设置包 try/catch —— 个别无控制台句柄的环境会抛 "handle is invalid"，编码退回 GBK（不比不修差），命令本身必须照常执行
    return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command',
            `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; ${cmd}`],
    };
}

/** 执行一条命令，不抛异常：失败也以 { ok:false } 返回，让上层把 stderr 原样回灌给 AI —— AI 需要看到真实报错才能自我纠正，抛异常会把它变成一句"执行失败"；options = { shell, cwd, timeoutMs } */
export function runCommand(command, options = {}) {
    const shell = availableShells().includes(options.shell) ? options.shell : availableShells()[0];
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : CMD_TIMEOUT;
    const { file, args } = buildShellArgv(shell, command);

    return new Promise((resolve) => {
        let child;
        try {
            child = execFile(file, args, {
                cwd: options.cwd || undefined,
                timeout: timeoutMs,
                windowsHide: true,
                maxBuffer: 8 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            resolve({ ok: false, code: null, stdout: '', stderr: String(err?.message || err), timedOut: false, truncated: false, shell });
            return;
        }

        let stdout = '';
        let stderr = '';
        let truncated = false;
        const collect = (which) => (chunk) => {
            const s = String(chunk);
            if (which === 'out') {
                if (stdout.length < MAX_OUTPUT) stdout += s;
                else truncated = true;
            } else {
                if (stderr.length < MAX_OUTPUT) stderr += s;
                else truncated = true;
            }
        };
        child.stdout?.on('data', collect('out'));
        child.stderr?.on('data', collect('err'));

        child.on('error', (err) => {
            resolve({ ok: false, code: null, stdout, stderr: stderr || String(err?.message || err), timedOut: false, truncated, shell });
        });
        child.on('close', (code, signal) => {
            const timedOut = signal === 'SIGTERM' && code === null;
            resolve({
                ok: code === 0,
                code: code === null ? null : code,
                stdout: clip(stdout, truncated),
                stderr: clip(stderr, truncated),
                timedOut,
                truncated,
                shell,
            });
        });
    });
}

function clip(text, truncated) {
    const s = String(text || '');
    if (s.length <= MAX_OUTPUT) return s;
    return s.slice(0, MAX_OUTPUT) + `\n…（输出超过 ${MAX_OUTPUT} 字符，已截断）`;
}

export function formatCommandResult(result) {
    const lines = [];
    lines.push(`shell：${result.shell}`);
    if (result.timedOut) lines.push('⚠️ 命令超时，已被强制结束。');
    else lines.push(`退出码：${result.code === null ? '（无，进程被信号结束）' : result.code}`);
    if (result.stdout) lines.push('', '--- 标准输出 ---', result.stdout.trimEnd());
    if (result.stderr) lines.push('', '--- 标准错误 ---', result.stderr.trimEnd());
    if (!result.stdout && !result.stderr) lines.push('', '（没有任何输出）');
    return lines.join('\n');
}

export const __test__ = { DANGEROUS_RULES, DANGEROUS_TARGET, clip };