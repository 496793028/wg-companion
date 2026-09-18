/* build-mac2.js — 在 Windows 上产出**可启动**的 macOS 包（x64 / arm64）
 *
 * 为何不用 electron-builder：它有硬性限制「Build for macOS is supported only on macOS」，
 * 无法交叉打包；electron-packager 允许跨平台生成 .app，因此改用它。
 *
 * 三个关键点（缺一就会得到「能解压但起不来」的包）：
 *   1) asar：显式 --asar，把应用打成 app.asar（否则是未打包的 Resources/app 目录）。
 *   2) 可执行位：Windows 文件系统没有 Unix exec 位，Node 读出来一律 0666 —— 必须在写入
 *      zip 时**按路径显式判定** 0755，否则 Mac 上解压出来的 Mach-O 没有执行权限，双击无反应。
 *   3) 符号链接：Electron 的 framework 内部大量使用（Versions/Current、Resources 等），
 *      必须用 archive.symlink 原样保留；一旦被当作普通文件跟随，几百 MB 二进制会被重复打包
 *      且可能破坏 framework 结构。
 *
 * 用法：MAC_ARCH=x64|arm64  node build-mac2.js
 */
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

function loadArchiver() {
  const cands = [
    path.join(__dirname, 'node_modules', 'archiver'),
    'C:/Users/zhaokun/.workbuddy/binaries/node/workspace/node_modules/archiver',
  ];
  for (const c of cands) {
    try {
      const mod = require(c);
      const fn = typeof mod === 'function' ? mod : (mod.archiver || mod.create || mod.default);
      if (typeof fn === 'function') return fn;
    } catch (e) { /* try next */ }
  }
  throw new Error('archiver not found');
}
const archiver = loadArchiver();

process.chdir(__dirname);

const logPath = path.join(__dirname, 'build-mac.log');
const log = fs.createWriteStream(logPath, { flags: 'w' });
function outLn(s) { process.stdout.write(s + '\n'); try { log.write(s + '\n'); } catch (e) {} }

process.env.CODEBUDDY_SAFE_DELETE_ENABLED = '0';
/* darwin 的 Electron 本体走 npmmirror（GitHub 直连不可用）；已下载过的会命中本地缓存 */
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://registry.npmmirror.com/-/binary/electron/';

const ws = 'C:/Users/zhaokun/.workbuddy/binaries/node/workspace';
const packager = path.join(ws, 'node_modules/electron-packager/bin/electron-packager.js');
const desktop = __dirname;
const dist = path.join(desktop, '..', 'dist');
if (!fs.existsSync(dist)) fs.mkdirSync(dist, { recursive: true });

const ARCH = process.env.MAC_ARCH || 'x64';
const PRODUCT = 'WG Companion';
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
const appOut = path.join(dist, `${PRODUCT}-darwin-${ARCH}`);

outLn('[build-mac] cwd=' + process.cwd());
outLn('[build-mac] arch=' + ARCH + ' version=' + VERSION);
outLn('[build-mac] ELECTRON_MIRROR=' + process.env.ELECTRON_MIRROR);

const args = [
  packager, desktop, PRODUCT,
  '--platform=darwin', `--arch=${ARCH}`,
  '--out=' + dist,
  '--overwrite',
  '--asar',
  '--electron-version=31.7.7',
  '--app-version=' + VERSION,
  '--app-bundle-id=io.github.wgweb.companion',
  '--app-category=public.app-category.utilities',
  '--no-package-manager',
  '--ignore=node_modules',
  '--ignore=build-win.js', '--ignore=build-mac.js', '--ignore=build-mac2.js',
  '--ignore=build.log', '--ignore=build-mac.log',
  '--ignore=\\.git', '--ignore=dist',
];

const child = cp.spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', d => outLn(d.toString().trimEnd()));
child.stderr.on('data', d => outLn(d.toString().trimEnd()));
child.on('close', code => {
  if (code !== 0) { outLn('PACKAGER_FAILED exit=' + code); log.end(); process.exit(1); }
  outLn('PACKAGER_DONE');
  zipApp();
});

/* macOS 上可执行位必须在 zip 条目里保留：按路径判定（Windows 上无法依赖文件系统） */
function modeFor(rel) {
  if (/\/MacOS\//.test(rel)) return 0o755;                              // 主可执行 / Helper 可执行
  if (/\.(dylib|so)$/i.test(rel)) return 0o755;                         // 动态库
  if (/\.framework\/Versions\/[^/]+\/[^/.]+$/.test(rel)) return 0o755;  // framework 本体二进制
  return 0o644;
}

function addTree(archive, rootDir, destPrefix, stats) {
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      const name = destPrefix + '/' + r;
      if (ent.isSymbolicLink()) {
        let target = '';
        try { target = fs.readlinkSync(full); } catch (e) { continue; }
        archive.symlink(name, target, 0o777);
        stats.links++;
      } else if (ent.isDirectory()) {
        archive.append(Buffer.alloc(0), { name: name + '/', type: 'directory', mode: 0o755 });
        stats.dirs++;
        walk(full, r);
      } else {
        archive.file(full, { name, mode: modeFor(name) });
        stats.files++;
      }
    }
  };
  walk(rootDir, '');
}

function zipApp() {
  const appPath = path.join(appOut, PRODUCT + '.app');
  if (!fs.existsSync(appPath)) { outLn('APP_MISSING: ' + appPath); log.end(); process.exit(1); }

  /* 完整性校验：不产出「能下载但起不来」的包 */
  let bad = false;
  for (const [rel, min] of [
    ['Contents/Resources/app.asar', 1024],          // 打成 asar 的应用代码
    ['Contents/Info.plist', 64],
  ]) {
    const p = path.join(appPath, ...rel.split('/'));
    const ok = fs.existsSync(p);
    const sz = ok ? fs.statSync(p).size : 0;
    outLn('[verify] ' + (ok ? 'OK  ' : 'MISS') + ' ' + rel + ' (' + sz + ')');
    if (!ok || sz < min) bad = true;
  }
  /* 主可执行：macOS 上只是一个几十 KB 的启动器（重代码都在 Electron Framework.framework），
     所以**不能用文件大小判断**，要校验它确实是 Mach-O 可执行文件。 */
  const binPath = path.join(appPath, 'Contents', 'MacOS', PRODUCT);
  let binOk = false;
  try {
    const fd = fs.openSync(binPath, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head.readUInt32BE(0);
    binOk = [0xFEEDFACF, 0xCFFAEDFE, 0xFEEDFACE, 0xCEFAEDFE, 0xCAFEBABE, 0xBEBAFECA].includes(magic);
    outLn('[verify] ' + (binOk ? 'OK  ' : 'MISS') + ' Contents/MacOS/' + PRODUCT +
      ' (magic=0x' + magic.toString(16) + ', size=' + fs.statSync(binPath).size + ')');
  } catch (e) { outLn('[verify] MISS Contents/MacOS/' + PRODUCT + ' :: ' + e.message); }
  if (!binOk) bad = true;
  const fwDir = path.join(appPath, 'Contents', 'Frameworks');
  const fwCount = fs.existsSync(fwDir) ? fs.readdirSync(fwDir).length : 0;
  outLn('[verify] ' + (fwCount >= 4 ? 'OK  ' : 'MISS') + ' Contents/Frameworks entries=' + fwCount);
  if (fwCount < 4) bad = true;
  if (bad) { outLn('APP_INCOMPLETE: .app 不完整，已中止（不产出不可启动的包）'); log.end(); process.exit(1); }

  const zipName = path.join(dist, `${PRODUCT}-${VERSION}${ARCH === 'arm64' ? '-arm64' : ''}-mac.zip`);
  const outStream = fs.createWriteStream(zipName);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const stats = { files: 0, dirs: 0, links: 0 };
  archive.on('warning', e => outLn('ZIP_WARN: ' + e.message));
  archive.on('error', e => { outLn('ZIP_ERR: ' + e.message); log.end(); process.exit(1); });
  outStream.on('close', () => {
    outLn(`ZIP_DONE: ${zipName} (${archive.pointer()} bytes) files=${stats.files} dirs=${stats.dirs} symlinks=${stats.links}`);
    log.end();
    process.exit(0);
  });
  archive.pipe(outStream);
  addTree(archive, appPath, PRODUCT + '.app', stats);
  archive.finalize();
}
