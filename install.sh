#!/usr/bin/env bash
# 一键安装/更新：把脱敏源码铺到本机 OpenCode 目录（REDACTED_ROOT → $HOME）
# 用法：bash install.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIB_MAIN="$HOME/.opencode/v2lib"
LIB_CFG="$HOME/.config/opencode/v2lib"
PLUGINS="$HOME/.config/opencode/plugins"
mkdir -p "$LIB_MAIN" "$LIB_CFG" "$PLUGINS"

install_one() { # $1=源文件 $2=目标文件
  sed "s#REDACTED_ROOT#$HOME#g" "$1" > "$2"
}

for f in "$HERE"/src/*.ts; do
  b="$(basename "$f")"
  case "$b" in
    tg-bridge-v2.ts|auto-continue-v2.ts) install_one "$f" "$PLUGINS/$b" ;;
    *) install_one "$f" "$LIB_MAIN/$b"; install_one "$f" "$LIB_CFG/$b" ;;
  esac
done

echo "installed: modules -> $LIB_MAIN (+ $LIB_CFG) ; entries -> $PLUGINS"
echo "重启 opencode serve，或 touch $PLUGINS/tg-bridge-v2.ts 触发热重载后生效"
