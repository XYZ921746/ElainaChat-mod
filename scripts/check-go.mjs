// Go 服务端的检查入口：编译、静态分析、单元/集成测试。
// 这是运行时真正在跑的那一份实现（启动脚本与打包都用 server/bin/elaina-server.exe），
// 其余检查模块覆盖前端回归；这里覆盖 Go 侧。
// 没有 Go 工具链的机器按环境性跳过（不判红）：检查脚本不该因为机器没装某套工具就整体失败。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runChecks, ROOT } from './check-harness.mjs';

const SERVER_DIR = path.join(ROOT, 'server');

function goAvailable() {
    const res = spawnSync('go', ['version'], { encoding: 'utf8', windowsHide: true });
    return !res.error && res.status === 0 ? String(res.stdout).trim() : '';
}

function run(cmd, args) {
    const res = spawnSync(cmd, args, {
        cwd: SERVER_DIR,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: process.env,
    });
    return {
        ok: res.status === 0,
        status: res.status,
        out: String(res.stdout || '') + String(res.stderr || ''),
        error: res.error,
    };
}

function tail(text, lines = 30) {
    const parts = String(text || '').trim().split(/\r?\n/);
    return parts.slice(-lines).join('\n');
}

function caseGo(probe) {
    return async (c) => {
        const version = goAvailable();
        if (!version) {
            c.ok(true, '环境性跳过：本机没有 Go 工具链（' + probe + '）');
            return;
        }
        if (probe === 'toolchain') {
            c.ok(true, '能找到 go 命令：' + version);
            return;
        }
        const args = probe === 'build' ? ['build', './...']
            : probe === 'vet' ? ['vet', './...']
                : ['test', './...'];
        const res = run('go', args);
        c.ok(res.ok, 'go ' + args.join(' ') + ' 全部通过', res.ok ? '' : tail(res.out, probe === 'test' ? 60 : 30));
    };
}

// 安卓原生工程与宿主同仓库（dist/Android/）；工作区被裁剪时可能没有，按环境性跳过。
function caseAndroidHost(c) {
    const appRoot = path.join(ROOT, 'dist', 'Android');
    const servicePath = path.join(appRoot, 'android', 'app', 'src', 'main', 'java',
        'com', 'elainachat', 'mod', 'ElainaNodeService.java');
    const gradlePath = path.join(appRoot, 'android', 'app', 'build.gradle');
    const syncPath = path.join(ROOT, 'dist', 'Android', 'scripts', 'sync-web.mjs');
    if (!existsSync(servicePath) || !existsSync(gradlePath) || !existsSync(syncPath)) {
        c.ok(true, '环境性跳过：本机没有 dist/Android 原生工程或 sync-web.mjs');
        return;
    }
    const service = readFileSync(servicePath, 'utf8');
    const gradle = readFileSync(gradlePath, 'utf8');
    const sync = readFileSync(syncPath, 'utf8');

    c.ok(service.includes('libelaina_server.so'), '服务宿主执行 Go 二进制（libelaina_server.so）');
    c.ok(service.includes('ProcessBuilder'), '服务宿主用 ProcessBuilder 启动二进制');
    c.ok(!/System\.loadLibrary\("node"\)/.test(service), '服务宿主不再加载 libnode');
    c.ok(gradle.includes('ELAINA_LOCAL_SERVER'), 'build.gradle 使用 ELAINA_LOCAL_SERVER 开关');
    c.ok(gradle.includes('jniLibsServer'), 'build.gradle 只收 jniLibsServer/（不重新打包历史 libnode）');
    c.ok(gradle.includes('useLegacyPackaging = true'), 'jniLibs 解压到 nativeLibraryDir 才能 exec');
    c.ok(sync.includes("GOOS: 'android'"), 'sync-web 交叉编译 Android 服务端');
    c.ok(!sync.includes('collectNodeHostFiles'), 'sync-web 不再把 web/nodejs 复制进 APK');
}

const only = process.argv[2];
const allCases = [
    { name: 'Go 工具链', fn: caseGo('toolchain') },
    { name: '编译通过', fn: caseGo('build') },
    { name: '静态分析', fn: caseGo('vet') },
    { name: '单元与集成测试', fn: caseGo('test') },
    { name: '安卓服务宿主', fn: caseAndroidHost },
];
const cases = only ? allCases.filter((x) => x.name.includes(only)) : allCases;

await runChecks({
    title: 'Go 服务端（编译 / vet / 测试 / 安卓宿主）',
    usage: 'node scripts/check-go.mjs [用例名子串]',
    cases,
});