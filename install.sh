#!/usr/bin/env bash
set -euo pipefail
DST="${DSH_HOME:-$HOME/.dsh}/skills"
mkdir -p "$DST"
for d in skills/*/; do
  [ -f "$d/SKILL.md" ] || continue
  name="$(basename "$d")"
  cp -R "$d" "$DST/"
  echo "已安装：$name"
done
echo "完成。新建会话后，说「搭建知识体系框架」即可触发。"
