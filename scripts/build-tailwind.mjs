#!/usr/bin/env node
// 把 Tailwind 工具类预生成为静态 CSS（web/css/tailwind.css）。
//
// 为什么需要这一步：应用不再在运行时加载 Tailwind 引擎，工具类必须事先生成好。
// 构建工具住在仓库外的工具目录（AGENTS.md D23：依赖与工具链不进仓库），
// 本脚本只负责定位 CLI、拼参数、清理临时文件；产物提交进 web/，分发链无需再跑构建。
//
// 用法：node scripts/build-tailwind.mjs
// 可用 ELAINA_TOOLS_DIR 覆盖工具目录根。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const toolsRoot = process.env.ELAINA_TOOLS_DIR || path.join(path.dirname(projectRoot), 'ElainaChat-tools');
const cliPath = path.join(toolsRoot, '09-tailwind', 'node_modules', 'tailwindcss', 'lib', 'cli.js');
const configPath = path.join(projectRoot, 'tailwind.config.js');
const outputPath = path.join(projectRoot, 'web', 'css', 'tailwind.css');

if (!existsSync(cliPath)) {
  console.error('找不到 Tailwind CLI：' + cliPath);
  console.error('请先在仓库外安装（D23）：');
  console.error('  mkdir -p "' + path.dirname(path.dirname(cliPath)) + '"');
  console.error('  cd "' + path.dirname(path.dirname(cliPath)) + '" && npm init -y && npm install tailwindcss@3.4.17');
  process.exit(1);
}
if (!existsSync(configPath)) {
  console.error('找不到配置文件：' + configPath);
  process.exit(1);
}

// CLI 的输入只需要三条指令；放临时目录，避免在 web/css/ 里混入非交付文件。
const tmpDir = mkdtempSync(path.join(tmpdir(), 'elaina-tailwind-'));
const inputPath = path.join(tmpDir, 'input.css');
writeFileSync(inputPath, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n', 'utf8');

try {
  const result = spawnSync(process.execPath, [
    cliPath,
    '-c', configPath,
    '-i', inputPath,
    '-o', outputPath,
    '--minify',
  ], { cwd: projectRoot, stdio: 'inherit' });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error('Tailwind CLI 退出码 ' + result.status);
    process.exit(result.status ?? 1);
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const size = statSync(outputPath).size;
console.log('已生成 web/css/tailwind.css（' + (size / 1024).toFixed(1) + ' KB）');
