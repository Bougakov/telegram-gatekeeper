#!/usr/bin/env bash
# Everyday commands for a deployed bot. Run without arguments for the list.
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

usage() {
  cat >&2 <<'EOF'
scripts/bot.sh КОМАНДА

  status          права бота в группе, вопросы, состояние вебхука
  chat [@группа]  ID, темы и права бота в группе (по умолчанию — GROUP из config.env)
  list            все записи в базе: кто ждёт проверки, кто прошёл, кто забанен
  user ID         что знают о пользователе Telegram и база
  release ID      снять оставшееся ограничение с человека, который уже вышел из группы
                  (если Telegram пишет ему «группа недоступна» при вступлении)
  reset ID        удалить запись о пользователе: при следующем вступлении — проверка с нуля
  sweep           сразу выполнить почасовую уборку (просроченные приветствия и удаления)
  questions       проверить questions.json и загрузить вопросы без полной переустановки
  logs            журнал бота в реальном времени (Ctrl+C — выход)
EOF
  exit 1
}

user_id() {
  [[ ${1:-} =~ ^[0-9]+$ ]] || die "нужен числовой ID пользователя (он есть в уведомлениях бота и в «list»)"
  printf '%s' "$1"
}

need curl jq
load_config

case ${1:-} in
  status) worker setup | jq . ;;
  chat) worker chat "${2:-$GROUP}" | jq . ;;
  list)
    d1 --json --command "SELECT user_id, name, status, question_id, attempts,
        datetime(joined_at, 'unixepoch') AS joined_utc FROM members ORDER BY joined_at DESC" |
      jq -r '["ID", "СТАТУС", "ОШИБОК", "ВОПРОС", "ВСТУПИЛ (UTC)", "ИМЯ"],
        (.[0].results[] | [.user_id, .status, .attempts, .question_id // "-", .joined_utc, .name // ""]) | @tsv' |
      column -t -s $'\t'
    ;;
  user)
    id=$(user_id "${2:-}")
    worker debug "$id" | jq .
    ;;
  release)
    id=$(user_id "${2:-}")
    worker debug "$id release" | jq .
    ;;
  reset)
    id=$(user_id "${2:-}")
    d1 --command "DELETE FROM members WHERE user_id = $id" >/dev/null
    info "Запись $id удалена."
    ;;
  sweep) worker sweep | jq . ;;
  questions)
    questions=$(validate_questions questions.json)
    printf '%s' "$questions" | wrangler secret put QUESTIONS >&2
    info "Загружено: $(jq -r '[.questions[].id] | join(", ")' <<<"$questions"). Новые вопросы — для новых вступающих."
    ;;
  logs) wrangler tail --format pretty ;;
  *) usage ;;
esac
