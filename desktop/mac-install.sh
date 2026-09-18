#!/bin/sh
# mac-install.sh — 在 macOS 上安装 / 修复 WG Companion
#
# 包体未做 Apple 开发者签名与公证，直接双击可能被 Gatekeeper 拦下
# （提示「已损坏」「无法验证开发者」或「无法打开」）。本脚本做三件事：
#   1) 解压（如果给的是 zip）并拷贝到 /Applications
#   2) 去掉隔离属性 xattr -dr com.apple.quarantine
#   3) 对包做一次本地 ad-hoc 重签名（Apple 芯片必需 —— 被改动过的包在 arm64 上
#      若签名失效会被系统直接拒绝启动）
#
# 用法：
#   sh mac-install.sh "WG Companion-1.2.0-mac.zip"        # Intel
#   sh mac-install.sh "WG Companion-1.2.0-arm64-mac.zip"  # Apple 芯片
#   sh mac-install.sh "/下载路径/WG Companion.app"
#
# 前置条件：brew install wireguard-tools   （提供 wg-quick，开合隧道时系统会弹管理员密码框）

set -e

SRC="${1:-}"
DEST="/Applications/WG Companion.app"

if [ -z "$SRC" ]; then
  echo "用法: sh mac-install.sh <zip 或 .app 的路径>" >&2
  exit 1
fi
if [ ! -e "$SRC" ]; then
  echo "找不到: $SRC" >&2
  exit 1
fi

WORK="$(mktemp -d)"
case "$SRC" in
  *.zip)
    echo "==> 解压 $SRC"
    unzip -q "$SRC" -d "$WORK"
    APP="$WORK/WG Companion.app"
    ;;
  *)
    APP="$SRC"
    ;;
esac
[ -d "$APP" ] || { echo "没有在包里找到 WG Companion.app" >&2; exit 1; }

echo "==> 关闭正在运行的旧实例（如有）"
pkill -f "WG Companion" 2>/dev/null || true

echo "==> 安装到 $DEST"
rm -rf "$DEST"
cp -R "$APP" "$DEST"

echo "==> 去除隔离属性（Gatekeeper）"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

if command -v codesign >/dev/null 2>&1; then
  echo "==> 本地 ad-hoc 重签名"
  codesign --force --deep --sign - "$DEST" 2>/dev/null \
    || echo "    （重签名未成功，若仍无法启动请改用手动方式：右键点 App → 打开 → 再点「打开」）"
fi

echo
echo "完成。启动："
echo "  open \"$DEST\""
echo
echo "提醒："
echo "  · 需先安装 wireguard-tools：brew install wireguard-tools"
echo "  · 首次开/关隧道时系统会弹出管理员密码确认框（wg-quick 提权），应用本身不常驻 root"
