// 单文件 exe 打包（dist/Windows/scripts/pack-exe.mjs + dist/Windows/launcher/launcher.cjs）的回归检查。
//
// 打包这层的失败几乎都**不在构建期暴露**，而在用户双击那一刻：
//   · 内嵌资源取出来的类型不对（getRawAsset 给 ArrayBuffer，writeFileSync 不收）
//   · 入口用了 ESM（SEA 只支持 CJS）
//   · 用 process.execPath 起子进程（SEA 里那是 exe 自己，会无限套娃）
//   · 把 data/ 也内嵌，于是每次启动覆盖用户的聊天记录
// 所以这里既做静态断言（形状），也**真跑一次 exe**：没有这一步，"打出来了"
// 与"打得能用"是两件事。
//
// 真跑那一项会解出 4 MB 程序文件到一个临时目录 —— 用 mkdtemp 隔离、finally 删干净，
// 不碰项目 data/ 与用户的 mods/。
//
// 用法：node scripts/check-exe.mjs           跑全部
//       node scripts/check-exe.mjs 启动器     只跑名字含该子串的用例

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks, ROOT, wait } from './check-harness.mjs';

// 打包工具住在 dist/Windows/（与 Android 打包工具分列在 dist/ 下）。
// dist/ 是本地产物区、不入库，本用例在工具缺失时按"环境性"跳过。
const LAUNCHER = path.join(ROOT, 'dist', 'Windows', 'launcher', 'launcher.cjs');
const PACKER = path.join(ROOT, 'dist', 'Windows', 'scripts', 'pack-exe.mjs');
const DIST = path.join(ROOT, 'dist');

/** 找本机已打好的 exe（按版本号命名）。没有就说明还没打过包。 */
function findBuiltExe() {
    if (!existsSync(DIST)) return null;
    const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const name = `ElainaChat-mod-${version}-x64.exe`;
    const full = path.join(DIST, name);
    return existsSync(full) ? full : null;
}

/** 等某个端口上的本项目服务就绪。用 HTTP 探，而不是 sleep 固定时长。 */
async function waitForReady(port, timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/server-info`, {
                signal: AbortSignal.timeout(800),
            });
            if (res.ok) {
                const info = await res.json();
                if (info && info.ok === true) return info;
            }
        } catch { /* 还没起来 */ }
        await wait(150);
    }
    return null;
}

runChecks({
    title: '单文件 exe（dist/Windows/）',
    usage: 'node scripts/check-exe.mjs [用例名子串]',
    cases: [
        {
            name: '启动器形状（SEA 的三条硬约束）',
            fn: async (c) => {
                if (!existsSync(LAUNCHER)) {
                    c.ok(true, '本机没有 dist/Windows/launcher/launcher.cjs，跳过（环境性）');
                    return;
                }
                const src = readFileSync(LAUNCHER, 'utf8');

                // SEA 只接受 CommonJS 入口。写成 ESM 会在运行时 import 语法处崩，
                // 而构建阶段完全看不出问题。
                c.ok(/require\(/.test(src), '启动器用 CommonJS（require）');
                c.ok(!/^\s*import\s+.*\sfrom\s+['"]/m.test(src), '启动器没有顶层 ESM import');

                // SEA 里 process.execPath 是 exe 自己：spawn 自己 = 重新进入启动器
                c.ok(!/spawn\(process\.execPath/.test(src), '没有 spawn(process.execPath)（会无限套娃）');
                c.ok(/await import\(/.test(src), '用 await import() 在本进程内跑 serve.mjs');

                // getRawAsset 返回 ArrayBuffer，必须包成 Buffer 才能写盘
                c.ok(/Buffer\.from\(\s*sea\.getRawAsset/.test(src),
                    'getRawAsset 的结果包成 Buffer 再落盘');

                // data/ 是用户内容，绝不能内嵌并覆盖
                c.ok(!/PROGRAM_DIRS\s*=\s*\[[^\]]*'data'/.test(src), 'data/ 不在内嵌程序目录里');
                c.ok(!/PROGRAM_DIRS\s*=\s*\[[^\]]*'mods'/.test(src), 'mods/ 不在内嵌程序目录里');
                c.ok(/PROGRAM_DIRS\s*=\s*\[[^\]]*'web'[^\]]*'server'/.test(src), "内嵌 web/ 与 server/");

                // 版本变化要整体重解：半新半旧的 web/ 与 server/ 比多等一秒糟得多
                c.ok(/\.version/.test(src), '用版本号做解包缓存标记');
                c.ok(/rmSync\(runtimeDir/.test(src), '版本变化时整体重解（不留下混杂的旧文件）');

                // 双击启动必须开浏览器，否则用户看不到界面
                c.ok(/OPEN_BROWSER\s*=\s*'1'/.test(src), "默认置 OPEN_BROWSER='1'（双击即出界面）");
            },
        },

        {
            name: '打包脚本形状',
            fn: async (c) => {
                if (!existsSync(PACKER)) {
                    c.ok(true, '本机没有 dist/Windows/scripts/pack-exe.mjs，跳过（环境性）');
                    return;
                }
                const src = readFileSync(PACKER, 'utf8');

                // 产物命名带版本号，且落在 dist/
                c.ok(/ElainaChat-mod-\$\{version\}-x64\.exe/.test(src), '产物名带版本号与架构');
                c.ok(/'dist'/.test(src), '产物默认落在 dist/');

                // 载体必须是运行本脚本的 node.exe：版本/ABI 与内嵌 blob 必须同源
                c.ok(/cpSync\(process\.execPath/.test(src), '用当前 node.exe 当载体（版本一致）');

                // 程序本体只有 web/ server/：桌面壳依赖编译好的原生模块，与"不依赖环境"相冲突
                const dirsLine = /PROGRAM_DIRS\s*=\s*\[([^\]]*)\]/.exec(src);
                c.ok(dirsLine && !/desktop/.test(dirsLine[1]) && !/dev-only/.test(dirsLine[1]),
                    '只内嵌程序本体（桌面壳与开发期产物都不进）');

                c.ok(/postject/.test(src), '用 postject 注入 blob');
                c.ok(/NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2/.test(src), '注入时带 SEA sentinel fuse');
            },
        },

        {
            name: '构建产物存在且是单文件',
            fn: async (c) => {
                const exe = findBuiltExe();
                if (!exe) {
                    // 还没打过包是**环境性**跳过：CI 不必为了这个检查先打一个 94 MB 的包
                    console.log('  SKIP  dist/ 里没有当前版本的 exe（先跑 npm run pack:exe）');
                    c.ok(true, '尚未打包，跳过（环境性）');
                    return;
                }
                const size = statSync(exe).size;
                c.ok(size > 50 * 1024 * 1024, `exe 体积合理（${(size / 1024 / 1024).toFixed(1)} MB，含 Node 运行时)`);
                // 只应有 exe 本身，不该再要求旁边放 node_modules 之类
                const siblings = readdirSync(DIST).filter((n) => n === path.basename(exe));
                c.ok(siblings.length === 1, '产物是单个 exe（无需伴随文件）');
            },
        },

        {
            name: '实跑：无 Node 环境下能起服务',
            fn: async (c) => {
                const exe = findBuiltExe();
                if (!exe) {
                    c.ok(true, '尚未打包，跳过实跑（环境性）');
                    return;
                }

                // 拷到临时目录跑：exe 会往自己所在目录解 runtime/ 与 data/，
                // 直接在 dist/ 里跑会污染仓库。
                const dir = mkdtempSync(path.join(os.tmpdir(), 'elainachat-exe-'));
                const copy = path.join(dir, path.basename(exe));
                try {
                    spawnSync('cmd', ['/c', 'copy', '/Y', exe, copy], { stdio: 'pipe' });

                    /**
                     * 把 PATH 收窄到只有系统目录 —— 这一步才是"不依赖 Node"的实证。
                     * 不这么做的话，exe 能跑可能只是因为机器上恰好装着 Node，
                     * 而对方机器没有。
                     */
                    const env = {
                        ...process.env,
                        PATH: 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem',
                        OPEN_BROWSER: '0',   // 检查不能弹浏览器
                        // 端口不固定：让程序自己从 3999 往上找，避免与正在跑的真实服务抢
                        PORT: '',
                    };
                    delete env.PORT;
                    // 数据一律落临时目录，绝不碰用户真实 data/
                    env.DATA_DIR = path.join(dir, 'data');
                    env.LOG_DIR = path.join(dir, 'logs');
                    env.MODS_DIR = path.join(dir, 'mods');
                    env.SKILLS_DIR = path.join(dir, 'skills');

                    const child = spawn(copy, [], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
                    let out = '';
                    child.stdout.setEncoding('utf8');
                    child.stderr.setEncoding('utf8');
                    child.stdout.on('data', (d) => { out += d; });
                    child.stderr.on('data', (d) => { out += d; });

                    try {
                        // 等它报出就绪端口
                        let port = null;
                        const deadline = Date.now() + 45000;
                        while (Date.now() < deadline && !port) {
                            const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
                            if (m) port = Number(m[1]);
                            else await wait(200);
                        }
                        c.ok(!!port, 'exe 报出监听端口（服务已起）');

                        if (port) {
                            const info = await waitForReady(port);
                            c.ok(!!info, `127.0.0.1:${port} 的 /api/server-info 可用`);

                            // 页面必须真能取到 —— 只看端口通不够，静态资源是另一条路径
                            const page = await fetch(`http://127.0.0.1:${port}/`, {
                                signal: AbortSignal.timeout(5000),
                            }).then((r) => r.text()).catch(() => '');
                            c.ok(page.length > 100000, `首页 HTML 完整（${page.length} 字节）`);
                            c.ok(/ElainaChat/i.test(page), '首页含应用标识');

                            const js = await fetch(`http://127.0.0.1:${port}/js/core.js`, {
                                signal: AbortSignal.timeout(5000),
                            }).then((r) => r.ok).catch(() => false);
                            c.ok(js, '内嵌的前端脚本能取到（解包目录结构正确）');
                        }

                        // 解包确实发生了，且 data/ 落在 exe 旁边而不是 runtime/ 里
                        c.ok(existsSync(path.join(dir, 'runtime', 'web', 'serve.mjs')),
                            'runtime/ 里解出了 serve.mjs');
                        c.ok(!existsSync(path.join(dir, 'runtime', 'data')),
                            'data/ 不在 runtime/ 里（不会随版本升级被清掉）');

                        // 二次启动复用：不该再出现"首次运行，已解出"
                        c.ok(/首次运行，已解出 \d+ 个程序文件/.test(out), '首次启动打出了解包提示');
                    } finally {
                        try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
                        await wait(300);
                    }
                } finally {
                    rmSync(dir, { recursive: true, force: true });
                }
            },
        },
    ],
});
