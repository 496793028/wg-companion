#!/bin/sh
# mac-make-dmg.sh — 把 WG Companion 打成 .dmg（**需在任意一台 Mac 上执行**，hdiutil 是 macOS 独有工具）
#
# 用法（三选一）：
#   sh mac-make-dmg.sh "WG Companion-1.2.0-mac.zip"     # 从 zip 生成（最常见：Windows 上打好的包）
#   sh mac-make-dmg.sh "/path/to/WG Companion.app"      # 从 .app 生成
#   sh mac-make-dmg.sh                                   # 不带参数：在当前目录自动找 zip / app
#
# 产物：./WG Companion-<版本>-<架构>.dmg   （UDZO 只读压缩镜像，访达里拖拽安装）
#
# 说明：
#   · zip 里的符号链接 / 可执行位已由打包端保证；本脚本只是换个更"官方"的分发壳。
#   · DMG 与 zip 在 Gatekeeper 面前一视同仁：包体未签名时都需要绕过（见 RELEASE_NOTES 的 macOS 节）。

set -e

SRC="${1:-}"
VER=""
ARCH=""

# —— 找到 .app ——
WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT

resolve_app() {
  if [ -n "$SRC" ] && [ -d "$SRC" ] && [ "${SRC##*.}" = "app" ]; then
    APP="$SRC"; return
  fi
  if [ -n "$SRC" ] && [ -f "$SRC" ] && [ "${SRC##*.}" = "zip" ]; then
    WORK="$(mktemp -d)"
    echo "==> 解压 $SRC"
    unzip -q "$SRC" -d "$WORK"
    APP="$WORK/WG Companion.app"
    return
  fi
  # 未指定：当前目录自动找
  Z=$(ls -t *.zip 2>/dev/null | head -1 || true)
  A=$(ls -dt *.app 2>/dev/null | head -1 || true)
  if [ -n "$A" ]; then APP="$A"; return; fi
  if [ -n "$Z" ]; then WORK="$(mktemp -d)"; unzip -q "$Z" -d "$WORK"; APP="$WORK/WG Companion.app"; return; fi
  echo "错误：当前目录没找到 .zip 或 .app；用法：sh mac-make-dmg.sh <zip|app>" >&2
  exit 1
}
resolve_app
[ -d "$APP" ] || { echo "错误：没有找到 WG Companion.app" >&2; exit 1; }

# —— 读版本号与架构 ——
VER=$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null || echo "1.2.0")
BIN="$APP/Contents/MacOS/$(plutil -extract CFBundleExecutable raw "$APP/Contents/Info.plist" 2>/dev/null || echo 'WG Companion')"
case "$(file -b "$BIN")" in
  *arm64*)  ARCH="arm64" ;;
  *x86_64*) ARCH="x64" ;;
  *)        ARCH="" ;;
esac
OUT="WG Companion-${VER}${ARCH:+-$ARCH}.dmg"

echo "==> 生成 $OUT"
rm -f "$OUT"
hdiutil create -volname "WG Companion" -srcfolder "$APP" -ov -format UDZO -fs HFS+ -o "$OUT" >/dev/null

echo "==> 完成：$OUT ($(du -h "$OUT" | cut -f1))"
echo "分发时建议同时附上 desktop/mac-install.sh（未签名包首次打开需绕过 Gatekeeper）。"
