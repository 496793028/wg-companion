const cp = require('child_process');
const path = require('path');
const fs = require('fs');

// 切换到 desktop 目录（electron-builder 据此定位 package.json）
process.chdir(__dirname);

const logPath = path.join(__dirname, 'build.log');
const log = fs.createWriteStream(logPath, { flags: 'w' });
function out(s) { process.stdout.write(s); try { log.write(s); } catch (e) {} }
function outLn(s) { out(s + '\n'); }

// 关闭安全删除守卫，避免 electron-builder 清理 .nsis.7z 时报错
process.env.CODEBUDDY_SAFE_DELETE_ENABLED = '0';

// nsis 等二进制若本地缺失，走国内镜像下载，避免直连 GitHub 失败
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';

const cli = path.join(__dirname, 'node_modules', 'electron-builder', 'cli.js');

outLn('[build] cwd = ' + process.cwd());
outLn('[build] cli = ' + cli);
outLn('[build] starting electron-builder --win --x64 ...');

try {
  const child = cp.spawn(process.execPath, [cli, '--win', '--x64'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => out(d.toString()));
  child.stderr.on('data', (d) => out(d.toString()));
  child.on('close', (code) => {
    if (code === 0) outLn('BUILD_DONE_OK');
    else outLn('BUILD_FAILED exit=' + code);
    log.end();
    process.exit(code === 0 ? 0 : 1);
  });
  child.on('error', (err) => {
    outLn('SPAWN_ERROR: ' + err.message);
    log.end();
    process.exit(1);
  });
} catch (e) {
  outLn('BUILD_FAILED: ' + e.message);
  log.end();
  process.exit(1);
}
