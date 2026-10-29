// Telegram group gatekeeper: newcomers are muted on join and must answer
// a question only real members know, in a DM with the bot, before they can post.
//
// - Webhook auth + dedup; join -> mute -> welcome prompt; "joined" notices and anything
//   a pending user manages to post are deleted; users added by an admin skip the check.
// - DM question/answer: correct -> unmute + cleanup; MAX_ATTEMPTS wrong -> ban.
//   Leaving while pending keeps the attempt count.
// - Admin notices with approve/ban/unban buttons; manual admin actions in Telegram
//   (ban, unban, lifting the mute) are mirrored into the database.
// - Cron sweep: delete stale prompts before Telegram's 48 h deletion limit,
//   remove (ban + unban) members who never answered.

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  QUESTIONS: string; // JSON, see questions.example.json
  CHAT_ID: string;
  BOT_USERNAME: string;
  MAX_ATTEMPTS: string; // wrong answers before a permanent ban
  OBFUSCATE_RATE: string; // share of eligible letters swapped for Latin lookalikes; "0" disables
  PROMPT_TTL_SEC: string; // delete the group prompt after this long; must stay under 48 h
  REMOVE_AFTER_SEC: string; // remove members who have not answered after this long
  PROMPT_THREAD_ID?: string; // forum topic for the welcome prompt; empty = General
}

type User = { id: number; is_bot: boolean; first_name: string; last_name?: string };
type ChatMember = { status: string; user: User; is_member?: boolean };
type ChatMemberUpdated = {
  chat: { id: number };
  from: User;
  old_chat_member: ChatMember;
  new_chat_member: ChatMember;
};
type Message = {
  message_id: number;
  chat: { id: number; type: string };
  from?: User;
  text?: string;
  new_chat_members?: User[];
};
type CallbackQuery = { id: string; from: User; data?: string };
type Update = {
  update_id: number;
  message?: Message;
  chat_member?: ChatMemberUpdated;
  callback_query?: CallbackQuery;
};

type Row = {
  user_id: number;
  status: 'pending' | 'away' | 'verified' | 'banned';
  question_id: string | null;
  attempts: number;
  prompt_msg_id: number | null;
  dm_msg_ids: string;
  joined_at: number;
  name: string | null;
  admin_msgs: string;
};
type Button = { text: string; callback_data: string };

type Question =
  | { id: string; text: string; kind: 'free'; answers: string[] }
  | { id: string; text: string; kind: 'digits'; length: number; answers: string[] };
// welcome: group prompt, "{name}" is replaced with a mention of the newcomer.
type QuestionSet = { welcome?: string; intro: string; questions: Question[] };

const DEFAULT_WELCOME = 'Добро пожаловать, {name}! Чтобы писать в группе, ответьте на один вопрос.';
const ADMIN_APPROVED_DM = 'Администратор подтвердил вашу заявку. Теперь вы можете писать в группе.';

const MUTED = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

// Only letters that look identical in common fonts.
const TO_LATIN: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X',
};
// Applied after lowercasing an answer, so a Latin letter typed by mistake still matches.
const TO_CYRILLIC: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST') return new Response('Not found', { status: 404 });
    if (!secretMatches(req.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.WEBHOOK_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }

    const { pathname, origin } = new URL(req.url);
    if (pathname === '/setup') return Response.json(await setup(env, origin));
    if (pathname === '/sweep') return Response.json(await sweep(env));
    if (pathname === '/chat') return Response.json(await chatInfo(env, (await req.text()).trim()));
    if (pathname === '/debug') {
      const [id, action] = (await req.text()).trim().split(/\s+/);
      return Response.json(await debug(env, Number(id), action === 'release'));
    }
    if (pathname !== '/webhook') return new Response('Not found', { status: 404 });

    const update = (await req.json()) as Update;
    try {
      if (await isDuplicate(env, update.update_id)) return new Response('ok');
      await handleUpdate(env, update);
    } catch (e) {
      // Always answer 200: with max_connections=1 a failing update would otherwise
      // be retried and block every update behind it.
      console.error('update', update.update_id, e);
    }
    return new Response('ok');
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await sweep(env);
  },
};

// --- timeouts -------------------------------------------------------------

async function sweep(env: Env): Promise<{ prompts_deleted: number; removed: number }> {
  const now = nowSec();

  const stale = await env.DB.prepare(
    "SELECT * FROM members WHERE status = 'pending' AND prompt_msg_id IS NOT NULL AND joined_at <= ?1",
  ).bind(now - Number(env.PROMPT_TTL_SEC)).all<Row>();
  for (const row of stale.results) {
    await deletePrompt(env, row);
    await env.DB.prepare('UPDATE members SET prompt_msg_id = NULL WHERE user_id = ?1').bind(row.user_id).run();
  }

  const expired = await env.DB.prepare(
    "SELECT * FROM members WHERE status = 'pending' AND joined_at <= ?1",
  ).bind(now - Number(env.REMOVE_AFTER_SEC)).all<Row>();
  let removed = 0;
  for (const row of expired.results) {
    try {
      await removeUnanswered(env, row);
      removed++;
    } catch (e) {
      console.error('timeout removal', row.user_id, e);
    }
  }
  return { prompts_deleted: stale.results.length, removed };
}

// Ban + unban removes the member and leaves them free to rejoin via the link.
// Attempts carry over to the next join.
async function removeUnanswered(env: Env, row: Row): Promise<void> {
  await tg(env, 'banChatMember', { chat_id: env.CHAT_ID, user_id: row.user_id });
  await tg(env, 'unbanChatMember', { chat_id: env.CHAT_ID, user_id: row.user_id, only_if_banned: true });
  await deletePrompt(env, row);
  await env.DB.prepare(
    "UPDATE members SET status = 'away', prompt_msg_id = NULL, updated_at = ?2 WHERE user_id = ?1",
  ).bind(row.user_id, nowSec()).run();

  // Only reaches people who opened the bot's DM.
  if ((JSON.parse(row.dm_msg_ids) as number[]).length) {
    const link = await groupLink(env);
    await tgQuiet(env, 'sendMessage', {
      chat_id: row.user_id,
      text: 'Вы были удалены из группы, так как не ответили на вопрос вовремя. ' +
        `Вы можете вступить снова${link ? `: ${link}` : '.'}`,
    });
  }
  await notice(env, row.user_id, '⌛ Удалён(а) из группы: не ответил(а) на вопрос вовремя.');
}

function secretMatches(got: string | null, want: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(got ?? '');
  const b = enc.encode(want);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

async function isDuplicate(env: Env, updateId: number): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE meta SET value = ?1 WHERE key = 'last_update_id' AND value < ?1",
  ).bind(updateId).run();
  return r.meta.changes === 0;
}

async function handleUpdate(env: Env, u: Update): Promise<void> {
  if (u.chat_member) return onChatMember(env, u.chat_member);
  if (u.callback_query) return onCallback(env, u.callback_query);
  if (u.message?.chat.type === 'private') return onPrivate(env, u.message);
  if (u.message) return onGroupMessage(env, u.message);
}

// --- group events ---------------------------------------------------------

async function onGroupMessage(env: Env, msg: Message): Promise<void> {
  if (String(msg.chat.id) !== env.CHAT_ID) return;

  if (msg.new_chat_members) {
    await tgQuiet(env, 'deleteMessage', { chat_id: env.CHAT_ID, message_id: msg.message_id });
    return;
  }

  // Covers the moment between (re)joining and being muted.
  const status = msg.from && (await getRow(env, msg.from.id))?.status;
  if (status === 'pending' || status === 'away') {
    await tgQuiet(env, 'deleteMessage', { chat_id: env.CHAT_ID, message_id: msg.message_id });
  }
}

async function onChatMember(env: Env, cmu: ChatMemberUpdated): Promise<void> {
  if (String(cmu.chat.id) !== env.CHAT_ID) return;
  const user = cmu.new_chat_member.user;
  if (user.is_bot) return;

  const oldStatus = cmu.old_chat_member.status;
  const newStatus = cmu.new_chat_member.status;
  const wasMember = isMember(cmu.old_chat_member);
  const nowMember = isMember(cmu.new_chat_member);
  const row = await getRow(env, user.id);

  // Our own actions (mute, unmute, ban, unban) also arrive here and are already recorded.
  // Admin actions taken directly in Telegram are mirrored into the database.
  if (cmu.from.id !== botId(env) && cmu.from.id !== user.id && row) {
    const by = `${cmu.from.first_name} (вручную)`;
    if (newStatus === 'kicked' && row.status !== 'banned') {
      await markBanned(env, row, row.attempts);
      await notice(env, user.id, `⛔ Забанено: ${escapeHtml(by)}.`, [unbanButton(user.id)]);
      return;
    }
    if (oldStatus === 'kicked' && row.status === 'banned') {
      await markUnbanned(env, row);
      await notice(env, user.id, `↩️ Разбанено: ${escapeHtml(by)}. Может вступить без проверки.`);
      return;
    }
    if (oldStatus === 'restricted' && wasMember && nowMember && newStatus !== 'restricted' && row.status === 'pending') {
      await approve(env, row, ADMIN_APPROVED_DM);
      await notice(env, user.id, `✅ Одобрено: ${escapeHtml(by)}.`);
      return;
    }
  }

  if (wasMember && !nowMember) {
    if (row?.status === 'pending' && newStatus !== 'kicked') {
      // A mute that outlives membership makes Telegram refuse the invite link
      // ("group is not accessible"). Drop it; the rejoin mutes again.
      await unmute(env, user.id);
      await deletePrompt(env, row);
      await env.DB.prepare(
        "UPDATE members SET status = 'away', prompt_msg_id = NULL, updated_at = ?2 WHERE user_id = ?1",
      ).bind(user.id, nowSec()).run();
      await notice(env, user.id, '🚪 Вышел(а) из группы до проверки.');
    }
    return;
  }
  if (wasMember || !nowMember) return;
  if (row?.status === 'verified') return;

  if (cmu.from.id !== user.id && (await isAdmin(env, cmu.from.id))) {
    if (newStatus === 'restricted') await unmute(env, user.id);
    await setVerified(env, user.id, row, displayName(user));
    return;
  }

  await tg(env, 'restrictChatMember', {
    chat_id: env.CHAT_ID,
    user_id: user.id,
    permissions: MUTED,
    use_independent_chat_permissions: true,
  });

  if (row) await deletePrompt(env, row);
  const prompt = await tg(env, 'sendMessage', {
    chat_id: env.CHAT_ID,
    message_thread_id: env.PROMPT_THREAD_ID ? Number(env.PROMPT_THREAD_ID) : undefined,
    parse_mode: 'HTML',
    text: escapeHtml(loadQuestions(env).welcome ?? DEFAULT_WELCOME).replace('{name}', mention(user)),
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Ответить на вопрос', url: `https://t.me/${env.BOT_USERNAME}?start=verify` }],
      ],
    },
  });

  // attempts and question_id survive leaving and rejoining.
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO members (user_id, status, prompt_msg_id, joined_at, updated_at, name)
     VALUES (?1, 'pending', ?2, ?3, ?3, ?4)
     ON CONFLICT (user_id) DO UPDATE
       SET status = 'pending', prompt_msg_id = ?2, joined_at = ?3, updated_at = ?3, name = ?4`,
  ).bind(user.id, prompt.message_id, now, displayName(user)).run();

  const tries = maxAttempts(env) - (row?.attempts ?? 0);
  await notice(env, user.id, `🆕 Вступил(а) в группу, ожидает ответа на вопрос. Попыток: ${tries}.`, [
    { text: '✅ Одобрить', callback_data: `approve:${user.id}` },
    { text: '⛔ Забанить', callback_data: `ban:${user.id}` },
  ], true);
}

function isMember(m: ChatMember): boolean {
  if (m.status === 'restricted') return m.is_member === true;
  return m.status === 'creator' || m.status === 'administrator' || m.status === 'member';
}

async function isAdmin(env: Env, userId: number): Promise<boolean> {
  const m = await tg(env, 'getChatMember', { chat_id: env.CHAT_ID, user_id: userId });
  return m.status === 'creator' || m.status === 'administrator';
}

// Restore the group's default permissions rather than granting everything.
async function unmute(env: Env, userId: number): Promise<void> {
  const chat = await tg(env, 'getChat', { chat_id: env.CHAT_ID });
  await tg(env, 'restrictChatMember', {
    chat_id: env.CHAT_ID,
    user_id: userId,
    permissions: chat.permissions,
    use_independent_chat_permissions: true,
  });
}

async function setVerified(env: Env, userId: number, row: Row | null, name?: string): Promise<void> {
  if (row) await deletePrompt(env, row);
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO members (user_id, status, joined_at, updated_at, name)
     VALUES (?1, 'verified', ?2, ?2, ?3)
     ON CONFLICT (user_id) DO UPDATE
       SET status = 'verified', prompt_msg_id = NULL, dm_msg_ids = '[]', updated_at = ?2,
           name = COALESCE(?3, name)`,
  ).bind(userId, now, name ?? null).run();
}

async function markBanned(env: Env, row: Row, attempts: number): Promise<void> {
  await deletePrompt(env, row);
  await env.DB.prepare(
    "UPDATE members SET status = 'banned', attempts = ?2, prompt_msg_id = NULL, updated_at = ?3 WHERE user_id = ?1",
  ).bind(row.user_id, attempts, nowSec()).run();
}

// An unban is an admin vouching for the person: they can rejoin without the question.
async function markUnbanned(env: Env, row: Row): Promise<void> {
  await env.DB.prepare(
    "UPDATE members SET status = 'verified', attempts = 0, dm_msg_ids = '[]', updated_at = ?2 WHERE user_id = ?1",
  ).bind(row.user_id, nowSec()).run();
  const link = await groupLink(env);
  // Only reaches people who have opened the bot's DM before.
  await tgQuiet(env, 'sendMessage', {
    chat_id: row.user_id,
    text: `Блокировка снята администратором. Вы можете вступить в группу${link ? `: ${link}` : '.'}`,
  });
}

async function deletePrompt(env: Env, row: Row): Promise<void> {
  if (row.prompt_msg_id) {
    await tgQuiet(env, 'deleteMessage', { chat_id: env.CHAT_ID, message_id: row.prompt_msg_id });
  }
}

// --- DM conversation ------------------------------------------------------

async function onPrivate(env: Env, msg: Message): Promise<void> {
  if (!msg.from) return;
  const text = msg.text?.trim() ?? '';
  const isStart = text.startsWith('/start');
  const row = await getRow(env, msg.from.id);

  if (row?.status !== 'pending') {
    if (isStart) await send(env, msg.from.id, await notPendingText(env, msg.from.id, row));
    return;
  }

  await trackDm(env, row.user_id, msg.message_id);
  const q = await questionFor(env, row);
  if (isStart) {
    await say(env, row, `${loadQuestions(env).intro}\n\n${obfuscate(q.text, Number(env.OBFUSCATE_RATE))}`);
    return;
  }
  if (!text) {
    await say(env, row, 'Пожалуйста, ответьте текстовым сообщением.');
    return;
  }

  // Every text reply uses up a try; a malformed one also gets the expected format.
  const answer = canonical(q, text);
  if (answer !== null && q.answers.some((a) => canonical(q, a) === answer)) {
    await approve(env, row, 'Спасибо! Теперь вы можете писать в группе.');
    await notice(env, row.user_id, '✅ Проверка пройдена.');
    return;
  }

  const attempts = row.attempts + 1;
  if (attempts >= maxAttempts(env)) {
    await tg(env, 'banChatMember', { chat_id: env.CHAT_ID, user_id: row.user_id, revoke_messages: true });
    await markBanned(env, row, attempts);
    await send(env, row.user_id, 'Ответ неверный. К сожалению, доступ к группе закрыт.');
    await notice(env, row.user_id, `⛔ Бан после ${attempts} неверных ответов.`, [unbanButton(row.user_id)], true);
    return;
  }
  await env.DB.prepare('UPDATE members SET attempts = ?2, updated_at = ?3 WHERE user_id = ?1')
    .bind(row.user_id, attempts, nowSec()).run();
  const hint = answer === null && q.kind === 'digits' ? ` Ответ должен состоять из ${q.length} цифр.` : '';
  await say(env, row, `Неверно.${hint} Осталось попыток: ${maxAttempts(env) - attempts}.`);
}

async function notPendingText(env: Env, userId: number, row: Row | null): Promise<string> {
  if (row?.status === 'banned') return 'Доступ к группе закрыт.';
  const inGroup = row?.status === 'verified' ||
    (!row && isMember(await tg(env, 'getChatMember', { chat_id: env.CHAT_ID, user_id: userId })));
  return inGroup
    ? 'Вы уже участник группы, проверка не нужна.'
    : 'Сначала вступите в группу по ссылке, а затем нажмите кнопку «Ответить на вопрос» под приветствием.';
}

// Unmute a pending member, clear the DM conversation and leave one closing message.
async function approve(env: Env, row: Row, closingDm: string): Promise<void> {
  await unmute(env, row.user_id);
  const fresh = (await getRow(env, row.user_id))!;
  await setVerified(env, row.user_id, fresh);
  const dmIds = JSON.parse(fresh.dm_msg_ids) as number[];
  if (dmIds.length) await tgQuiet(env, 'deleteMessages', { chat_id: row.user_id, message_ids: dmIds });
  // A user approved by an admin may never have opened the DM.
  await tgQuiet(env, 'sendMessage', { chat_id: row.user_id, text: closingDm });
}

// --- admin notices and buttons ----------------------------------------------

function unbanButton(userId: number): Button {
  return { text: '↩️ Разбанить', callback_data: `unban:${userId}` };
}

// One notice per newcomer in every admin's DM. push=true replaces it with a fresh
// message (so admins get notified); otherwise the existing notice is edited in place.
async function notice(env: Env, userId: number, line: string, buttons: Button[] = [], push = false): Promise<void> {
  const row = await getRow(env, userId);
  if (!row) return;
  const text = `${userLink(userId, row.name)}\n${line}`;
  const reply_markup = { inline_keyboard: buttons.length ? [buttons] : [] };
  const prev = JSON.parse(row.admin_msgs) as [number, number][];

  if (!push && prev.length) {
    for (const [chat_id, message_id] of prev) {
      await tgQuiet(env, 'editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', reply_markup });
    }
    return;
  }

  for (const [chat_id, message_id] of prev) {
    await tgQuiet(env, 'editMessageReplyMarkup', { chat_id, message_id, reply_markup: { inline_keyboard: [] } });
  }
  const admins = (await tg(env, 'getChatAdministrators', { chat_id: env.CHAT_ID })) as ChatMember[];
  const sent: [number, number][] = [];
  for (const a of admins.filter((m) => !m.user.is_bot)) {
    try {
      const m = await tg(env, 'sendMessage', { chat_id: a.user.id, text, parse_mode: 'HTML', reply_markup });
      sent.push([a.user.id, m.message_id]);
    } catch (e) {
      // Admin has not pressed Start on the bot yet.
      console.warn('notice to admin', a.user.id, e);
    }
  }
  await env.DB.prepare('UPDATE members SET admin_msgs = ?2 WHERE user_id = ?1')
    .bind(userId, JSON.stringify(sent)).run();
}

async function onCallback(env: Env, cq: CallbackQuery): Promise<void> {
  const answer = (text?: string) => tgQuiet(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
  if (!(await isAdmin(env, cq.from.id))) return answer('Только для администраторов группы.');

  const [action, id] = (cq.data ?? '').split(':');
  const row = await getRow(env, Number(id));
  if (!row) return answer('Нет данных об этом пользователе.');
  const by = escapeHtml(cq.from.first_name);

  if (action === 'approve' && (row.status === 'pending' || row.status === 'away')) {
    if (row.status === 'pending') await approve(env, row, ADMIN_APPROVED_DM);
    else await setVerified(env, row.user_id, row);
    await notice(env, row.user_id, `✅ Одобрено: ${by}.`);
    return answer('Одобрено.');
  }
  if (action === 'ban' && row.status !== 'banned') {
    await tg(env, 'banChatMember', { chat_id: env.CHAT_ID, user_id: row.user_id, revoke_messages: true });
    await markBanned(env, row, row.attempts);
    await notice(env, row.user_id, `⛔ Забанено: ${by}.`, [unbanButton(row.user_id)]);
    return answer('Забанено.');
  }
  if (action === 'unban' && row.status === 'banned') {
    await tg(env, 'unbanChatMember', { chat_id: env.CHAT_ID, user_id: row.user_id, only_if_banned: true });
    await markUnbanned(env, row);
    await notice(env, row.user_id, `↩️ Разбанено: ${by}. Может вступить без проверки.`);
    return answer('Разбанено.');
  }
  return answer('Уже обработано.');
}

async function questionFor(env: Env, row: Row): Promise<Question> {
  const { questions } = loadQuestions(env);
  const assigned = questions.find((q) => q.id === row.question_id);
  if (assigned) return assigned;
  const q = questions[Math.floor(Math.random() * questions.length)];
  await env.DB.prepare('UPDATE members SET question_id = ?2 WHERE user_id = ?1').bind(row.user_id, q.id).run();
  return q;
}

function loadQuestions(env: Env): QuestionSet {
  return JSON.parse(env.QUESTIONS) as QuestionSet;
}

function maxAttempts(env: Env): number {
  return Number(env.MAX_ATTEMPTS) || 3;
}

// Reduces an answer to a comparable form, or null if it is not a valid attempt.
// Free answers containing a digit are compared by digits only, so "9-й" and "№9" equal "9".
function canonical(q: Question, s: string): string | null {
  let t = s.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/й/g, 'и');
  t = [...t].map((c) => TO_CYRILLIC[c] ?? c).join('').replace(/[^0-9а-я]/g, '');
  const digits = t.replace(/\D/g, '');
  if (q.kind === 'digits') return digits.length === q.length ? digits : null;
  return digits || t || null;
}

function obfuscate(s: string, rate: number): string {
  return [...s].map((c) => (TO_LATIN[c] && Math.random() < rate ? TO_LATIN[c] : c)).join('');
}

// Send a DM that is deleted once the user is verified.
async function say(env: Env, row: Row, text: string): Promise<void> {
  const m = await send(env, row.user_id, text);
  await trackDm(env, row.user_id, m.message_id);
}

async function send(env: Env, chatId: number, text: string) {
  return tg(env, 'sendMessage', { chat_id: chatId, text });
}

async function trackDm(env: Env, userId: number, messageId: number): Promise<void> {
  await env.DB.prepare("UPDATE members SET dm_msg_ids = json_insert(dm_msg_ids, '$[#]', ?2) WHERE user_id = ?1")
    .bind(userId, messageId).run();
}

// --- setup ----------------------------------------------------------------

async function setup(env: Env, origin: string) {
  await tg(env, 'setWebhook', {
    url: `${origin}/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'chat_member', 'callback_query', 'my_chat_member'],
    max_connections: 1,
    drop_pending_updates: true,
  });
  const me = await tg(env, 'getMe', {});
  const rights = await tg(env, 'getChatMember', { chat_id: env.CHAT_ID, user_id: me.id });
  const webhook = await tg(env, 'getWebhookInfo', {});
  return {
    bot: me.username,
    status_in_group: rights.status,
    can_delete_messages: rights.can_delete_messages ?? false,
    can_restrict_members: rights.can_restrict_members ?? false,
    questions: loadQuestions(env).questions.map((q) => q.id),
    webhook: { url: webhook.url, pending: webhook.pending_update_count, last_error: webhook.last_error_message },
  };
}

// Any chat by @username or ID: its numeric ID, forum mode and the bot's rights there.
async function chatInfo(env: Env, chatRef: string) {
  const chat = await tg(env, 'getChat', { chat_id: chatRef });
  const rights = await tg(env, 'getChatMember', { chat_id: chat.id, user_id: botId(env) }).catch((e) => String(e));
  return {
    id: chat.id,
    title: chat.title,
    type: chat.type,
    is_forum: chat.is_forum ?? false,
    join_by_request: chat.join_by_request ?? false,
    permissions: chat.permissions,
    bot: typeof rights === 'string' ? rights : {
      status: rights.status,
      can_delete_messages: rights.can_delete_messages ?? false,
      can_restrict_members: rights.can_restrict_members ?? false,
      can_manage_topics: rights.can_manage_topics ?? false,
    },
  };
}

// Telegram's and our view of one user, for diagnosing membership problems.
// release=true drops a leftover mute from someone who is no longer a member.
async function debug(env: Env, userId: number, release: boolean) {
  if (release) {
    const m = await tg(env, 'getChatMember', { chat_id: env.CHAT_ID, user_id: userId });
    if (m.status === 'restricted' && !m.is_member) await unmute(env, userId);
  }
  const chat = await tg(env, 'getChat', { chat_id: env.CHAT_ID });
  const member = await tg(env, 'getChatMember', { chat_id: env.CHAT_ID, user_id: userId }).catch((e) => String(e));
  return {
    chat: {
      username: chat.username ?? null,
      invite_link: chat.invite_link ?? null,
      join_by_request: chat.join_by_request ?? false,
      join_to_send_messages: chat.join_to_send_messages ?? false,
      permissions: chat.permissions,
    },
    member,
    row: await getRow(env, userId),
  };
}

// --- helpers --------------------------------------------------------------

async function getRow(env: Env, userId: number): Promise<Row | null> {
  return env.DB.prepare('SELECT * FROM members WHERE user_id = ?1').bind(userId).first<Row>();
}

function mention(u: User): string {
  return userLink(u.id, displayName(u));
}

function userLink(id: number, name: string | null): string {
  return `<a href="tg://user?id=${id}">${escapeHtml(name ?? `id ${id}`)}</a>`;
}

function displayName(u: User): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

async function groupLink(env: Env): Promise<string | undefined> {
  const chat = await tg(env, 'getChat', { chat_id: env.CHAT_ID });
  return chat.username ? `https://t.me/${chat.username}` : chat.invite_link;
}

// The numeric part of the token is the bot's own user ID.
function botId(env: Env): number {
  return Number(env.BOT_TOKEN.split(':')[0]);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function tg(env: Env, method: string, params: object): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = (await r.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}

// For best-effort calls (deleting messages that may already be gone or too old).
async function tgQuiet(env: Env, method: string, params: object): Promise<void> {
  try {
    await tg(env, method, params);
  } catch (e) {
    console.warn(e);
  }
}
