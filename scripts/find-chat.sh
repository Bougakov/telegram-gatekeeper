#!/usr/bin/env bash
# Show the numeric IDs of groups the bot has seen, for a private group without @username.
# Works before the first deploy only: once the webhook is set, Telegram stops
# handing updates to getUpdates.
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

need curl jq
ask_token

if [[ -n $(tg getWebhookInfo | jq -r .url) ]]; then
  die "вебхук уже подключён, поэтому Telegram не отдаёт события сюда. Используйте: scripts/bot.sh chat -100…"
fi

chats=$(tg getUpdates | jq -r '
  [.[] | (.message // .edited_message // .my_chat_member // .chat_member // empty).chat
       | select(.type != "private")]
  | unique_by(.id)[] | [.id, .type, .title] | @tsv')
if [[ -z $chats ]]; then
  die "бот пока не видел ни одной группы. Добавьте его в группу (или напишите там сообщение) и запустите снова"
fi
{ printf 'ID\tТИП\tНАЗВАНИЕ\n'; echo "$chats"; } | column -t -s $'\t'
echo >&2
info "Впишите нужный ID в GROUP в config.env. Тип должен быть supergroup."
