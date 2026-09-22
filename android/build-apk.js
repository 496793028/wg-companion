const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = 'C:/Users/zhaokun/WorkBuddy/2026-09-07-14-32-29';
const build = path.join(root, '.workbuddy/build');
const android = path.join(root, 'wg-companion/android');

// 定位 JDK17 工具链
const jdkDir = fs.readdirSync(build).find((d) =>
  /^jdk-/.test(d) && fs.existsSync(path.join(build, d, 'bin/java.exe'))
);
if (!jdkDir) {
  console.error('JDK17 not found under', build);
  process.exit(1);
}
const javaHome = path.join(build, jdkDir);
const java = path.join(javaHome, 'bin/java.exe');

// 定位 Gradle 8.7 的 lib 目录
const gradleLib = path.join(build, 'gradle-8.7/lib');
if (!fs.existsSync(gradleLib)) {
  console.error('gradle lib not found:', gradleLib);
  process.exit(1);
}
const cp = gradleLib + '/*';

console.log('[apk] java    =', java);
console.log('[apk] gradle  =', path.join(build, 'gradle-8.7'));
console.log('[apk] project =', android);
try {
  console.log('[apk] local.properties =\n' + fs.readFileSync(path.join(android, 'local.properties'), 'utf8'));
} catch (e) {
  console.log('[apk] local.properties missing:', e.message);
}

const logPath = path.join(android, 'apk.log');
const log = fs.createWriteStream(logPath, { flags: 'w' });
function out(s) {
  process.stdout.write(s);
  try { log.write(s); } catch (e) {}
}

const args = [
  '-Dorg.gradle.java.home=' + javaHome,
  '-Dfile.encoding=UTF-8',
  '-cp', cp,
  'org.gradle.launcher.GradleMain',
  '--project-dir', android,
  'assembleDebug',
  '--no-daemon',
  '--stacktrace',
];
console.log('[apk] launching gradle assembleDebug ...');

const child = spawn(java, args, {
  env: { ...process.env, JAVA_HOME: javaHome, GRADLE_OPTS: '-Xmx2048m' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => out(d.toString()));
child.stderr.on('data', (d) => out(d.toString()));
child.on('close', (code) => {
  if (code === 0) {
    out('\nAPK_BUILD_DONE_OK\n');
    // 列出产物
    const outDir = path.join(android, 'app/build/outputs/apk/debug');
    try {
      for (const f of fs.readdirSync(outDir)) {
        const fp = path.join(outDir, f);
        if (/\.apk$/.test(f)) out('APK: ' + fp + ' (' + fs.statSync(fp).size + ')\n');
      }
    } catch (e) {
      out('APK list error: ' + e.message + '\n');
    }
  } else {
    out('\nAPK_BUILD_FAILED exit=' + code + '\n');
  }
  log.end();
  process.exit(code === 0 ? 0 : 1);
});
child.on('error', (err) => {
  out('\nAPK_SPAWN_ERROR: ' + err.message + '\n');
  log.end();
  process.exit(1);
});
