#!/usr/bin/env bash
# 批量/幂等注册 TG bot（不需要修改桥代码）。
#
# 输入：JSON 数组，或 {"bots":[...]}。每个 bot 至少需要 envFile，以及 id 或 username；
# username 会作为用户可见 label（@username），缺省 id 时也用它生成稳定内部 id。
# envFile 必须存在且含非空 TG_BOT_TOKEN。脚本一次性校验并合并多条记录，
# 原子写入 tg-bots.json（默认 $HOME/.config/opencode/tg-bots.json）。
#
# 用法：
#   add-bots.sh --file new-bots.json [--dry-run] [--reload]
#   add-bots.sh --file new-bots.json --registry /path/tg-bots.json
#
# 默认按键 id upsert；已有 bot 不会丢。--reload 在写入后调用 hotreload.sh，
# 让 tg-bridge-v2 的下一次 setup 重新读取 registry（桥本身已支持任意 bots[]）。
set -euo pipefail

FILE=""
REGISTRY="${TG_BOTS_PATH:-$HOME/.config/opencode/tg-bots.json}"
DRY_RUN=0
RELOAD=0

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --file|-f) FILE="${2:-}"; shift 2 ;;
    --registry) REGISTRY="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --reload) RELOAD=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 2 ;;
  esac
done

[ -n "$FILE" ] || { echo "missing --file" >&2; usage 2; }
[ -r "$FILE" ] || { echo "cannot read input: $FILE" >&2; exit 2; }

python3 - "$FILE" "$REGISTRY" "$DRY_RUN" <<'PY'
import json, os, re, sys, tempfile

src_path, reg_path, dry = sys.argv[1], os.path.expanduser(sys.argv[2]), sys.argv[3] == "1"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")
DEFAULT_ALLOWED = os.environ.get("TG_ALLOWED_CHAT", "")
DEFAULT_PUSH = os.environ.get("TG_PUSH_CHAT", "")

def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(2)

def read_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        die(f"invalid JSON {path}: {e}")

def env_value(path, key):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError as e:
        die(f"cannot read env file {path}: {e}")
    return ""

def write_env(path, token, allowed, push, label):
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tg-bot.", dir=parent, text=True)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(f"TG_BOT_TOKEN={token}\n")
        f.write(f"TG_ALLOWED_CHAT={allowed}\n")
        f.write(f"TG_PUSH_CHAT={push}\n")
        if label:
            f.write(f"TG_BOT_LABEL={label}\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)

def bots_of(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("bots", [])
    return None

new = bots_of(read_json(src_path, None))
if not isinstance(new, list) or not new:
    die("input must be a non-empty JSON array or {bots:[...]}")
existing = bots_of(read_json(reg_path, {"bots": []}))
if not isinstance(existing, list):
    die("existing registry has no bots array")

# One Telegram token = one poller. Two registry entries with the same token cause
# a permanent getUpdates 409 and the later bot silently receives nothing.
token_owner = {}
for b in existing:
    p = os.path.expanduser(str(b.get("envFile", "")))
    tok = env_value(p, "TG_BOT_TOKEN") if p else ""
    if tok:
        token_owner.setdefault(tok, str(b.get("id", "?")))

for b in new:
    if not isinstance(b, dict):
        die("every bot entry must be an object")
    bid = str(b.get("id", "")).strip().lower()
    username = str(b.get("username", "")).strip().lstrip("@")
    if not bid and username:
        bid = username.lower()
    bid = re.sub(r"[^a-z0-9_-]", "", bid)
    if not ID_RE.match(bid):
        die(f"invalid bot id: {bid!r} (use letters, digits, _ or -; 2-32 chars; or provide username)")
    b["id"] = bid
    label = str(b.get("label") or (f"@{username}" if username else bid))

    env = str(b.get("envFile", "")).strip()
    token = str(b.get("token", "")).strip()
    if not env and not token:
        die(f"bot {bid}: provide envFile or token")
    if not env:
        # /addbot names the file tg-<id>.env; tg-bot3.env and tg-3.env both work
        # for auto-discovery. Keep the same convention here.
        file_id = bid[3:] if bid.startswith("bot") and len(bid) > 3 else bid
        env = os.path.expanduser(f"~/.config/opencode/tg-bot{file_id}.env")
    env = os.path.expanduser(env)
    if not os.path.isabs(env):
        env = os.path.abspath(env)
    if token:
        if len(token) < 20 or ":" not in token:
            die(f"bot {bid}: token does not look like a BotFather token")
        if not dry:
            write_env(
                env,
                token,
                str(b.get("allowedChat") or DEFAULT_ALLOWED),
                str(b.get("pushChat") or DEFAULT_PUSH),
                label,
            )
    if not os.path.isfile(env) and not (dry and token):
        die(f"bot {bid}: envFile not found: {env}")
    tok = token if (dry and token) else env_value(env, "TG_BOT_TOKEN")
    if len(tok) < 20:
        die(f"bot {bid}: TG_BOT_TOKEN missing or too short in {env}")
    prev = token_owner.get(tok)
    if prev and prev != bid:
        die(f"bot {bid}: token is already used by {prev}; one token can only have one poller")
    token_owner[tok] = bid
    b["envFile"] = env
    b.setdefault("label", label)
    existing_ids = {str(x.get("id")) for x in existing}
    print(f"  {'+' if bid not in existing_ids else '='} {bid}  label={b['label']}  env={env}  token=set(len={len(tok)})")

by_id = {str(b.get("id")): i for i, b in enumerate(existing)}
for b in new:
    bid = str(b["id"])
    if bid in by_id:
        existing[by_id[bid]] = b
    else:
        by_id[bid] = len(existing)
        existing.append(b)

out = {"bots": existing}
text = json.dumps(out, ensure_ascii=False, indent=2) + "\n"
if dry:
    print(f"DRY-RUN: would write {reg_path} ({len(existing)} bots; no changes)")
    sys.exit(0)

parent = os.path.dirname(reg_path) or "."
os.makedirs(parent, exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix=".tg-bots.", dir=parent, text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, reg_path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
print(f"OK: {reg_path} -> {len(existing)} bots (atomic, mode=600)")
PY

if [ "$RELOAD" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  ENTRY="${HOME}/.config/opencode/plugins/tg-bridge-v2.ts"
  if [ -f "$ENTRY" ]; then
    touch "$ENTRY"
    echo "reloaded bridge entry: $ENTRY"
  else
    echo "NOTE: $ENTRY not found; restart/touch the plugin entry to apply" >&2
  fi
fi
