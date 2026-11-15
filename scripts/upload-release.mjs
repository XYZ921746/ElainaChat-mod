// 把打包产物上传到 GitHub Releases（建 Release + 传附件），不依赖 gh CLI。
//
// ── 为什么用 curl 而不是 Node fetch ──────────────────────────────────────
//
// 本机 Node 的 fetch 报 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`（Node 不自带系统 CA 库，
// 而这个仓库没有配 NODE_EXTRA_CA_CERTS）。curl 用系统证书库，实测正常。
//
// `--ssl-no-revoke` 是给中间人加速器（hosts 把 github 指向本机代理）留的：
// 它只跳过"查吊销列表"，证书链本身仍然校验 —— 与 `-k` / `rejectUnauthorized:false`
// 不是一回事。没有加速器的机器上这个参数也无害。
//
// ── 凭据从哪来 ───────────────────────────────────────────────────────────
//
// 从 git 的凭据管理器读（`git credential fill`），不把 token 写进命令行历史。
// 读到的 token 必须**缓存**：一次上传会发 4+ 个请求，逐个去读会反复唤醒
// 凭据管理器、反复弹登录框（用户明明早就登录了）。
// 另外 `git credential fill` 不能设 timeout —— 凭据管理器首次响应可能要几十秒，
// 超时会被误报成"拿不到 token"。只保留 `GIT_TERMINAL_PROMPT=0` 防真挂起。
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//
//   node scripts/upload-release.mjs --tag v2.1.1 --notes notes.md \
//        --assets dist/Elinachat-mod-2.1.1.apk,dist/Windows/out/elaina-Setup.exe
//   node scripts/upload-release.mjs --tag v2.1.1 --notes notes.md --dry-run
//
//   不带 --assets 时从 dist/ 收集 *.apk / *.zip / *.exe。
//   Release 已存在则复用；同名附件先删再传（否则 GitHub 返回 422）。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 默认仓库从 git remote 推出来：写死 owner/repo 会在仓库改名后静默传到错误的地方 */
function repoFromRemote() {
    try {
        const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8', cwd: ROOT }).trim();
        const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
        if (m) return m[1] + '/' + m[2];
    } catch { /* 没有 remote 时交给 --repo */ }
    return '';
}

const args = process.argv.slice(2);
const argValue = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
const repo = argValue('--repo') || repoFromRemote();
if (!repo) {
    console.error('无法从 remote.origin.url 推出仓库，请用 --repo owner/name 指定');
    process.exit(1);
}
const tag = argValue('--tag') || '';
const notesFile = argValue('--notes');
const assetsArg = argValue('--assets');

if (!tag) {
    console.error('缺少 --tag（例：--tag v2.1.1）');
    process.exit(1);
}

let cachedToken = null;
function ghToken() {
    if (cachedToken) return cachedToken;
    const envToken = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
    if (envToken) { cachedToken = envToken; return cachedToken; }
    try {
        const out = execFileSync('git', ['credential', 'fill'], {
            input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        const m = out.match(/password=(.*)/);
        cachedToken = m ? m[1].trim() : '';
    } catch {
        cachedToken = '';
    }
    return cachedToken;
}

function api(method, endpoint, { body, contentType } = {}) {
    const token = ghToken();
    if (!token) throw new Error('拿不到 GitHub token（git credential fill 失败）');
    const url = endpoint.startsWith('http') ? endpoint : 'https://api.github.com' + endpoint;
    const curlArgs = ['-s', '--ssl-no-revoke', '-X', method, '-H', 'Authorization: Bearer ' + token,
        '-H', 'User-Agent: elainachat-release', '-H', 'Accept: application/vnd.github+json'];
    let tmpFile = null;
    if (body !== undefined) {
        curlArgs.push('-H', 'Content-Type: ' + (contentType || 'application/json'));
        // 说明正文可能很长且含中文：写临时文件走 --data-binary，避免命令行转义与长度限制。
        tmpFile = path.join(os.tmpdir(), 'gh-api-' + Date.now() + '.json');
        writeFileSync(tmpFile, typeof body === 'string' ? body : JSON.stringify(body));
        curlArgs.push('--data-binary', '@' + tmpFile);
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

function uploadAsset(uploadUrl, filePath, fileName, contentType) {
    const token = ghToken();
    const url = uploadUrl.replace('{?name,label}', '') + '?name=' + encodeURIComponent(fileName);
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

/** 按扩展名给 Content-Type；APK 用安卓包类型，exe/zip 用二进制流 */
function contentTypeFor(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.apk')) return 'application/vnd.android.package-archive';
    if (lower.endsWith('.zip')) return 'application/zip';
    return 'application/octet-stream';
}

// ============================================================ 收集产物
const files = [];
if (assetsArg) {
    for (const rel of assetsArg.split(',').map((s) => s.trim()).filter(Boolean)) {
        const p = path.resolve(ROOT, rel);
        if (!existsSync(p) || !statSync(p).isFile()) {
            console.error('产物不存在：' + p);
            process.exit(1);
        }
        const name = path.basename(p);
        // 附件名只收纯 ASCII：中文名经「Windows 命令行 → curl → GitHub API」会变残缺（实测）。
        if (/[^\x20-\x7E]/.test(name)) {
            console.error('附件名含非 ASCII 字符：' + name);
            process.exit(1);
        }
        files.push({ name, path: p, size: statSync(p).size, contentType: contentTypeFor(name) });
    }
} else {
    const dir = path.join(ROOT, 'dist');
    const names = existsSync(dir) ? readdirSync(dir) : [];
    for (const f of names) {
        if (!/\.(apk|zip|exe)$/i.test(f)) continue;
        const p = path.join(dir, f);
        if (!statSync(p).isFile()) continue;
        files.push({ name: f, path: p, size: statSync(p).size, contentType: contentTypeFor(f) });
    }
}

if (!files.length) {
    console.error('没有可上传的产物（用 --assets 指定，或把产物放进 dist/）');
    process.exit(1);
}

const notes = notesFile ? readFileSync(path.resolve(ROOT, notesFile), 'utf8') : '';
if (!notes) {
    console.error('缺少 --notes（发版说明文件），不自动编说明：下载页的文案必须与本次产物一致');
    process.exit(1);
}

console.log('════════ GitHub Releases 上传 ════════');
console.log('  仓库: ' + repo);
console.log('  tag : ' + tag);
console.log('  模式: ' + (dryRun ? '试运行（不实际上传）' : '实际上传'));
console.log('\n  待上传 ' + files.length + ' 个文件：');
let totalSize = 0;
for (const f of files) {
    totalSize += f.size;
    console.log(`    ${f.name.padEnd(46)} ${(f.size / 1048576).toFixed(2)} MB`);
}
console.log(`    ${'合计'.padEnd(46)} ${(totalSize / 1048576).toFixed(2)} MB`);

if (dryRun) { console.log('\n（试运行结束，未上传）'); process.exit(0); }

// ============================================================ 找或建 Release
console.log('\n── 查找 Release ──');
const rel = api('GET', `/repos/${repo}/releases/tags/${tag}`);
let release = null;
if (rel.status === 200) {
    release = JSON.parse(rel.text);
    console.log('  已存在（id=' + release.id + '），复用');
} else if (rel.status === 404) {
    console.log('  不存在，创建新 Release');
    const create = api('POST', `/repos/${repo}/releases`, {
        body: { tag_name: tag, name: tag, body: notes, draft: false, prerelease: false },
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

// ============================================================ 传附件
console.log('\n── 上传附件 ──');
let uploaded = 0, failed = 0;
for (const f of files) {
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
