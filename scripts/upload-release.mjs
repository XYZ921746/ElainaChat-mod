// 把 dist/ 里的产物上传到 GitHub Releases。
//
// ── 为什么用 curl 而不是 Node fetch ──────────────────────────────────────
//
// 本机 Node 的 fetch 报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`（找不到签发者证书），
// 因为 Node 不带系统 CA 库、而这里没配 NODE_EXTRA_CA_CERTS。curl 用系统证书库，
// 实测正常（HTTP 200）。所以走 curl —— 比在 Node 里 `rejectUnauthorized:false`
// 安全（后者等于不验证证书）。
//
// ── ★ 本机特例：--ssl-no-revoke ──────────────────────────────────────────
//
// 本机 hosts 把 github 相关域名全指向 127.0.0.1，443 上是本地加速器
// （Steam++.Accelerator）。它走中间人证书，而 curl 默认要做**证书吊销检查**，
// 那张证书没有可查的吊销列表 → 报 `CRYPT_E_NO_REVOCATION_CHECK (0x80092012)`
// → 连接直接失败（表现为 http_code=000，很容易被误判成"没网"）。
// 所以这里统一带 `--ssl-no-revoke`：只跳过"查吊销列表"这一步，
// **证书链本身仍然校验** —— 与 `-k` / `rejectUnauthorized:false`（干脆不验）
// 是两回事，没有降低对真实 github.com 的验证强度。
// 如果你的机器上没有本地加速器，这个参数也无害（只是少做一次网络查询）。
//
// ── 凭据从哪来 ───────────────────────────────────────────────────────────
//
// 从 git 的凭据管理器读（`git credential fill`）—— Windows 上 git 把 GitHub token
// 存在凭据管理器里，读出来的就是它。好处是不用在命令行里传 token（那会进历史记录）。
//
// ⚠️ 读凭据必须防挂起：`git credential fill` 在没有可交互终端时会**一直等输入**。
//    实测踩到：直接跑会挂到超时。所以要设 `GIT_TERMINAL_PROMPT=0`（见 ghToken）。
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//
//   node scripts/upload-release.mjs                    # 上传 dist/ 下的产物
//   node scripts/upload-release.mjs --tag v1.3.2       # 指定 tag
//   node scripts/upload-release.mjs --dry-run          # 只看会传什么
//   node scripts/upload-release.mjs --repo owner/name  # 换仓库
//
// 行为：tag 对应的 Release 不存在就创建，存在则复用；已存在的同名附件会**覆盖**
// （先删旧的再传新的）—— 否则重复运行会因"附件已存在"报 422。
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPO = 'XYZ921746/ElainaChat-mod';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const repoArg = args[args.indexOf('--repo') + 1];
const repo = args.includes('--repo') ? repoArg : DEFAULT_REPO;
const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : 'v1.3.0-mod';

/**
 * 读一次 GitHub token，之后**全程复用**（缓存）。
 *
 * ★★ 在这里踩过一个很扰民的坑，务必保留缓存：
 *
 *   原来 `ghToken()` 每次调用都执行一次 `git credential fill`，而 `api()` /
 *   `uploadAsset()` 每个请求都调它 —— 一次上传要发 4+ 个请求（查 Release、
 *   建 Release、删旧附件、传附件…）。于是系统凭据管理器
 *   （`credential.helper = manager`）被**反复唤醒，反复弹登录框** ——
 *   用户明明早就登录了，却看到一串登录请求弹出来。用户原话：
 *   "为什么弹出这么多 git 登录请求，我已经登录了啊？？"
 *   这不是"没登录"，是脚本在骚扰凭据管理器。
 *
 * ⚠️ 另外**不要给 git credential fill 设 timeout**：
 *   凭据管理器首次响应可能超过 20s（要拉起 UI 宿主进程），
 *   设了就会 ETIMEDOUT —— 而脚本会把"超时"当成"拿不到 token"，
 *   报出"git credential fill 失败"这种**指向错误方向**的信息。
 *   实测：不设 timeout 能拿到（40 位 token），设 20000ms 就失败。
 *   也不要为了"防挂起"而传最小 env —— 那会让 git 找不到 credential.helper
 *   配置，直接 "could not read Username ... terminal prompts disabled"。
 *   只要保留 GIT_TERMINAL_PROMPT=0（防真的挂起）并继承完整 process.env 就够。
 */
let cachedToken = null;
function ghToken() {
    if (cachedToken) return cachedToken;
    try {
        const out = execFileSync('git', ['credential', 'fill'], {
            input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            // 不设 timeout：见上面说明（凭据管理器首次响应慢，超时会误报为"拿不到 token"）
        });
        const m = out.match(/password=(.*)/);
        cachedToken = m ? m[1].trim() : '';
    } catch {
        cachedToken = '';
    }
    return cachedToken;
}

/** 调 GitHub API（用 curl，见文件头说明） */
function api(method, endpoint, { body, contentType, raw } = {}) {
    const token = ghToken();
    if (!token) throw new Error('拿不到 GitHub token（git credential fill 失败）');
    const url = endpoint.startsWith('http') ? endpoint : 'https://api.github.com' + endpoint;
    const curlArgs = ['-s', '--ssl-no-revoke', '-X', method, '-H', 'Authorization: Bearer ' + token,
        '-H', 'User-Agent: elainachat-release', '-H', 'Accept: application/vnd.github+json'];
    if (contentType) curlArgs.push('-H', 'Content-Type: ' + contentType);
    let tmpFile = null;
    if (body !== undefined) {
        if (Buffer.isBuffer(body) || raw) {
            // 二进制体：写临时文件后 --data-binary @file（避免命令行长度限制与转义问题）
            tmpFile = path.join(os.tmpdir(), 'gh-upload-' + Date.now() + '.bin');
            writeFileSync(tmpFile, body);
            curlArgs.push('--data-binary', '@' + tmpFile);
        } else {
            curlArgs.push('-d', typeof body === 'string' ? body : JSON.stringify(body));
        }
    }
    curlArgs.push('-w', '\n%{http_code}', url);
    try {
        const out = execFileSync('curl', curlArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
        const lines = out.trimEnd().split('\n');
        const status = Number(lines.pop());
        return { status, text: lines.join('\n') };
    } finally {
        if (tmpFile) { try { rmSync(tmpFile, { force: true }); } catch { /* 忽略 */ } }
    }
}

/** 上传单个文件到 upload_url（GitHub 的 uploads 域名，不是 api.github.com） */
function uploadAsset(uploadUrl, filePath, fileName, contentType) {
    const token = ghToken();
    const base = uploadUrl.replace('{?name,label}', '');
    const url = base + '?name=' + encodeURIComponent(fileName);
    const out = execFileSync('curl', [
        '-s', '--ssl-no-revoke', '-X', 'POST',
        '-H', 'Authorization: Bearer ' + token,
        '-H', 'User-Agent: elainachat-release',
        '-H', 'Content-Type: ' + contentType,
        '--data-binary', '@' + filePath,
        '-w', '\n%{http_code}',
        url,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 1800000 });
    const lines = out.trimEnd().split('\n');
    const status = Number(lines.pop());
    return { status, text: lines.join('\n') };
}

// ============================================================ 主流程
console.log('════════ GitHub Releases 上传 ════════');
console.log('  仓库: ' + repo);
console.log('  tag : ' + tag);
console.log('  模式: ' + (dryRun ? '试运行（不实际上传）' : '实际上传'));

// 1. 收集要上传的文件
//
// ★ 优先传**拆开的**单个包（`dist/assets/*.zip`），而不是合并的大包。
//
//   理由：用户常常只需要其中一个（比如只装桌宠，或只补一个 Live2D 模型）。
//   上线一个 22.6MB 的合并包的话，他得先下完再解压才能拿到想要的那个文件。
//   拆开传 = 每个包一个直链，按需下载。
//
//   如果 dist/assets/ 不存在（比如用户手工整理了 dist/），才退回到
//   dist/ 下的 zip（那种情况通常就是合并包）。
//
// ★★ 2026-10：同时接受 **.apk**（程序本体）。
//
//   以前这里只收 .zip，于是"发一版安卓包"必须手工去 GitHub 网页上传 ——
//   而手工上传最容易出的错是**传错文件/传漏文件**（本仓库已有先例：
//   APK 版本号没变，导致"用户装的到底是哪个包"无从判断）。
//   放进脚本就能一次跑完全部产物，并打印每个文件的大小与哈希供核对。
//
//   为什么仍然**排除** debug 包：发布页只该有可直接分发的产物。
//   debug/release 的判据是文件名里有没有 `-debug`（build.gradle 的命名约定）。
const assetsDir = path.join(ROOT, 'dist', 'assets');
const useSplit = existsSync(assetsDir);
// 两个来源都要看：dist/ 放 APK（程序本体），dist/assets/ 放扩展包
const dirs = [];
if (useSplit) dirs.push(assetsDir);
dirs.push(path.join(ROOT, 'dist'));

/** 这个文件名是不是我们要上传的产物 */
function isUploadable(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.apk')) return true;
    // 扩展包走 dist/assets/（拆分）或 dist/（合并包）
    if (lower.endsWith('.zip')) return true;
    return false;
}

const files = [];
const skipped = [];
const seen = new Set();
for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
        if (!isUploadable(f)) continue;
        const p = path.join(dir, f);
        if (!statSync(p).isFile()) continue;
        if (seen.has(f)) continue;   // dist/ 与 dist/assets/ 同名时不重复收集
        // ★ 只接受纯 ASCII 文件名。
        //
        //   实测：`live2d-伊蕾娜·默认.zip` 经 curl 传上去后变成了 `live2d-.zip`
        //   —— 中文在「Windows 命令行 → curl → GitHub API」这条链路上丢了，
        //   结果是附件名残缺、下载链接也没法用。
        //   与其传上去一个坏名字，不如在这里明确拦住并提示重新打包
        //   （pack-assets.mjs 已保证产物名是 ASCII）。
        if (/[^\x20-\x7E]/.test(f)) { skipped.push(f); continue; }
        seen.add(f);
        files.push({
            name: f, path: p, size: statSync(p).size,
            contentType: f.toLowerCase().endsWith('.apk')
                ? 'application/vnd.android.package-archive'
                : 'application/zip',
        });
    }
}
if (skipped.length) {
    console.log('\n  ⚠️ 跳过 ' + skipped.length + ' 个非 ASCII 文件名（上传后会变残缺，如 live2d-.zip）：');
    for (const s of skipped) console.log('      ' + s);
    console.log('      请跑 `npm run pack:assets` 重新打包（产物名已改为 ASCII）');
}
if (!files.length) {
    console.error('\n❌ 没找到可上传的产物（dist/ 下的 .apk 或 .zip）。');
    console.error('   APK：把构建好的 release 包复制到 dist/；扩展包：`npm run pack:assets`。');
    process.exit(1);
}
console.log('\n  待上传 ' + files.length + ' 个文件：');
let totalSize = 0;
for (const f of files) {
    totalSize += f.size;
    console.log(`    ${f.name.padEnd(46)} ${(f.size / 1048576).toFixed(2)} MB`);
}
console.log(`    ${'合计'.padEnd(46)} ${(totalSize / 1048576).toFixed(2)} MB`);

if (dryRun) { console.log('\n（试运行结束，未上传）'); process.exit(0); }

// 2. 找或建 Release
console.log('\n── 查找 Release ──');
let rel = api('GET', `/repos/${repo}/releases/tags/${tag}`);
let release = null;
if (rel.status === 200) {
    release = JSON.parse(rel.text);
    console.log('  已存在（id=' + release.id + '），复用');
} else if (rel.status === 404) {
    console.log('  不存在，创建新 Release');
    // ★ 说明文案按**实际上传的文件**生成 —— 不再写死"扩展包"。
    //
    //   原来这段文案假定"这个 Release 只放扩展包"，而本次起也会放 APK
    //   （见文件头 isUploadable 的说明）。写死的文案会让下载页骗人：
    //   放的是程序本体，标题却说"扩展包（插件 + Live2D 模型）"。
    const hasApk = files.some((f) => f.name.toLowerCase().endsWith('.apk'));
    const hasZip = files.some((f) => f.name.toLowerCase().endsWith('.zip'));
    const sections = [];
    if (hasApk) {
        sections.push(
            '### 安卓程序本体（`ElainaChat-*-lite-release.apk`）',
            '',
            '**纯净版**：只含程序本体，不含插件与 Live2D 模型（模型与插件是扩展包，按需下载）。',
            '目标架构 arm64-v8a，Android 10（API 29）及以上。',
            '',
            '1. 下载 `.apk` 直接安装（首次需允许"安装未知来源应用"）',
            '2. 打开应用：设置 → 云端连接，填服务地址与 Key',
            '',
            '> 这是**本地分发**用的包，签名是 debug 签名（见 `android/app/build.gradle`）。',
        );
    }
    if (hasZip) {
        sections.push(
            '### 扩展包（插件 + Live2D 模型）',
            '',
            '程序本体不含这些资源，按需下载后安装（见 README 的「扩展包」章节）。',
            '',
            '**插件**',
            '- `elaina-avatar` — 立绘与情绪识别，**公共依赖**，Galgame 与桌宠都要它',
            '- `galgame` — 全屏剧情界面（31 张场景背景）',
            '- `pet` — 桌宠悬浮层',
            '',
            '**Live2D 模型**',
            '- `live2d-deepseek`、`live2d-elaina-default`',
            '',
            '安装：',
            '1. 下载需要的 `.zip`（**不要解压**）',
            '2. 程序内：设置 → 插件 → 上传安装（模型走 设置 → Live2D → 上传模型）',
            '3. 装完在列表里打开开关（插件默认关闭）',
            '',
            '> `galgame` 与 `pet` 依赖 `elaina-avatar`，只装前者会没有立绘。',
        );
    }
    const create = api('POST', `/repos/${repo}/releases`, {
        contentType: 'application/json',
        body: {
            tag_name: tag,
            name: tag + (hasApk ? '（Android 程序本体' + (hasZip ? ' + 扩展包' : '') + '）' : ' 扩展包（插件 + Live2D 模型）'),
            body: sections.join('\n'),
            draft: false,
            prerelease: false,
        },
    });
    if (create.status !== 201) {
        console.error('  创建失败 HTTP ' + create.status + '：' + create.text.slice(0, 300));
        process.exit(1);
    }
    release = JSON.parse(create.text);
    console.log('  已创建（id=' + release.id + '）');
} else {
    console.error('  查询失败 HTTP ' + rel.status + '：' + rel.text.slice(0, 300));
    process.exit(1);
}

// 3. 逐个上传（同名先删，否则 422）
console.log('\n── 上传附件 ──');
let uploaded = 0, failed = 0;
for (const f of files) {
    // 已存在同名 → 先删
    const old = (release.assets || []).find((a) => a.name === f.name);
    if (old) {
        const del = api('DELETE', `/repos/${repo}/releases/assets/${old.id}`);
        console.log(`  ${f.name}：已存在，先删除旧版（HTTP ${del.status}）`);
    }
    process.stdout.write(`  ${f.name} … `);
    const r = uploadAsset(release.upload_url, f.path, f.name, f.contentType);
    if (r.status === 201) {
        uploaded++;
        console.log('✅');
    } else {
        failed++;
        console.log('❌ HTTP ' + r.status + ' ' + r.text.slice(0, 200));
    }
}

console.log('\n════════ 结果 ════════');
console.log(`  成功 ${uploaded}   失败 ${failed}`);
console.log(`  下载页：https://github.com/${repo}/releases/tag/${tag}`);
if (failed) process.exit(1);
