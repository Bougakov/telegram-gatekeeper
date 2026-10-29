# shellcheck shell=bash
# Shared helpers for the scripts in this folder. Sourced, not run.
set -euo pipefail
umask 077 # .state.env and temporary secret files are readable by you only

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { echo "Ошибка: $*" >&2; exit 1; }
info() { echo "› $*" >&2; }

need() {
  local t
  for t in "$@"; do command -v "$t" >/dev/null || die "не найдена программа $t — установите её (см. HOWTO, «Что понадобится»)"; done
}

# Prefer a wrangler from PATH (e.g. the nix dev shell), otherwise fetch it with npx.
wrangler() {
  if command -v wrangler >/dev/null; then
    command wrangler "$@"
  elif command -v npx >/dev/null; then
    npx --yes wrangler@4 "$@"
  else
    die "нужен Node.js 20+ (команда npx) или wrangler в PATH"
  fi
}

# config.env holds your settings; .state.env holds what the scripts found out or generated.
load_config() {
  [[ -f config.env ]] || die "нет config.env — скопируйте config.example.env в config.env и заполните"
  set -a
  # shellcheck source=/dev/null
  source ./config.env
  # shellcheck source=/dev/null
  [[ -f .state.env ]] && source ./.state.env
  set +a

  local v
  for v in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN WORKER_NAME GROUP; do
    [[ -n ${!v:-} ]] || die "в config.env не задан $v"
  done
  MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}
  REMOVE_AFTER_HOURS=${REMOVE_AFTER_HOURS:-48}
  OBFUSCATE_RATE=${OBFUSCATE_RATE:-0.25}
  PROMPT_THREAD_ID=${PROMPT_THREAD_ID:-}

  [[ $WORKER_NAME =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "WORKER_NAME: только строчные латинские буквы, цифры и дефис"
  [[ $GROUP =~ ^(@[A-Za-z0-9_]{4,}|-100[0-9]+)$ ]] || die "GROUP: @username группы или числовой ID вида -100…"
  [[ $MAX_ATTEMPTS =~ ^[1-9][0-9]*$ ]] || die "MAX_ATTEMPTS: целое число от 1"
  [[ $REMOVE_AFTER_HOURS =~ ^[1-9][0-9]*$ ]] || die "REMOVE_AFTER_HOURS: целое число часов от 1"
  [[ $OBFUSCATE_RATE =~ ^(0(\.[0-9]+)?|1(\.0+)?)$ ]] || die "OBFUSCATE_RATE: число от 0 до 1, например 0.25"
  [[ $PROMPT_THREAD_ID =~ ^[0-9]*$ ]] || die "PROMPT_THREAD_ID: число или пусто"
}

save_state() {
  local key=$1 val=$2
  touch .state.env
  { grep -v "^$key=" .state.env || true; printf '%s=%q\n' "$key" "$val"; } > .state.env.tmp
  mv .state.env.tmp .state.env
  printf -v "$key" '%s' "$val"
}

# Validate a questions file and print it as one line of JSON (the QUESTIONS secret).
validate_questions() {
  local file=$1 out
  [[ -f $file ]] || die "нет $file — скопируйте questions.example.json в $file и впишите свои вопросы"
  if cmp -s "$file" questions.example.json; then
    die "$file совпадает с примером — впишите свои вопросы и ответы"
  fi
  out=$(jq -c '
    def check($ok; $msg): if $ok then . else error($msg) end;
    check(type == "object"; "файл должен быть объектом { ... }")
    | check((.intro | type) == "string"; "intro: нужна строка")
    | check(.welcome == null or ((.welcome | type) == "string" and (.welcome | contains("{name}")));
        "welcome: строка, в которой есть {name}")
    | check((.questions | type) == "array" and (.questions | length) > 0; "questions: нужен непустой список")
    | reduce .questions[] as $q (.;
        check(($q.id | type) == "string" and ($q.id | length) > 0; "у каждого вопроса нужен id")
        | check(($q.text | type) == "string" and ($q.text | length) > 0; "вопрос \($q.id): нет text")
        | check(($q.answers | type) == "array" and ($q.answers | length) > 0 and all($q.answers[]; type == "string");
            "вопрос \($q.id): answers — непустой список строк")
        | check($q.kind == "free" or $q.kind == "digits"; "вопрос \($q.id): kind — free или digits")
        | check($q.kind != "digits" or
            (($q.length | type) == "number" and all($q.answers[]; test("^[0-9]+$") and length == $q.length));
            "вопрос \($q.id): для digits нужен length, и каждый ответ — ровно столько цифр"))
    | check(([.questions[].id] | length) == ([.questions[].id] | unique | length); "id вопросов повторяются")
  ' "$file" 2>&1) || die "$file: ${out#jq: error*: }"
  printf '%s' "$out"
}

# Telegram Bot API call with the token typed in this session: tg METHOD [JSON].
# The token goes through curl's config on stdin, so it never shows in the process list.
tg() {
  local r
  r=$(printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$BOT_TOKEN" "$1" |
    curl -sS -K - -H 'content-type: application/json' --data-binary "${2:-{\}}") ||
    die "нет связи с api.telegram.org"
  jq -e '.ok' <<<"$r" >/dev/null || die "Telegram $1: $(jq -r '.description // .' <<<"$r")"
  jq '.result' <<<"$r"
}

ask_token() {
  read -rsp "Токен бота от @BotFather (ввод не отображается): " BOT_TOKEN
  echo >&2
  [[ $BOT_TOKEN =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || die "это не похоже на токен бота"
}

# Call the bot's admin endpoint: worker PATH [BODY]. Authenticated with the webhook secret.
worker() {
  [[ -n ${WORKER_URL:-} && -n ${WEBHOOK_SECRET:-} ]] || die "бот ещё не развёрнут — запустите scripts/deploy.sh"
  printf '%s' "${2:-}" |
    curl -sS -X POST -H @<(printf 'X-Telegram-Bot-Api-Secret-Token: %s\n' "$WEBHOOK_SECRET") \
      --data-binary @- "$WORKER_URL/$1"
}

d1() {
  wrangler d1 execute "$WORKER_NAME" --remote --yes "$@"
}
