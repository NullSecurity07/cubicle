import type { Room, Stage } from '../../shared/model.ts';
import type { Reach } from './settings.ts';
import type { Api, Chat, Membership } from './telegram.ts';

// A day of talking to eight people in one chat is one long stream, and the founder said so. A Telegram group with
// Topics on is the same company laid out as rooms: a topic each, one for the company itself, and nothing to type
// before saying something — where you write is who you are talking to.
export const NO_TOPICS = 'This group does not have Topics switched on yet. Open the group\'s settings, turn Topics on, then send me the code again.';
export const NO_RIGHTS = 'I am in the group, but I am not allowed to make the topics. In the group\'s settings, make me an administrator and switch on "Manage topics", then send me the code again.';
export const READY = 'This is the company now. Everybody has a topic of their own — write in one and you are talking to them. Everything I would have told you goes in Company.';
export const COMPANY = 'Company';
// Telegram's own cap on what a topic may be called.
const NAME = 128;

export const topicName = (room: Room) => `${room.name}${room.role ? ` · ${room.role}` : ''}`.slice(0, NAME);
export const isForum = (chat: Chat) => (chat.type === 'supergroup' || chat.type === 'group') && chat.is_forum === true;
export const isGroup = (chat: Chat) => chat.type === 'supergroup' || chat.type === 'group';

// The group, kept in step with the stage. Everything it knows lives in the settings file, so a restart walks back
// into the same rooms rather than making a second set of them.
export function createTopics(deps: { api: Api; reach: Reach }) {
  const held = () => deps.reach.read().then((one) => one.group);

  // Whatever the stage says, said in Telegram: a new person gets a topic, a renamed one has theirs renamed, and
  // somebody taken off the stage has theirs closed rather than deleted — what was said in it is still theirs.
  async function sync(stage: Stage): Promise<string | null> {
    const group = await held();
    if (!group) return null;
    let trouble: string | null = null;
    const change = async (work: () => Promise<void>) => {
      try { await work(); } catch (error) { trouble = /not enough rights|CHAT_ADMIN/i.test((error as Error).message) ? NO_RIGHTS : (error as Error).message; }
    };
    if (!group.company) await change(async () => { group.company = (await deps.api.topic(group.chatId, COMPANY)).message_thread_id; });
    for (const room of stage.rooms) {
      const name = topicName(room);
      const known = group.topics[room.id];
      if (!known) await change(async () => { group.topics[room.id] = { threadId: (await deps.api.topic(group.chatId, name)).message_thread_id, name }; });
      else if (known.name !== name) await change(async () => { await deps.api.renameTopic(group.chatId, known.threadId, name); known.name = name; });
      if (trouble) break;
    }
    for (const [roomId, topic] of Object.entries(group.topics)) {
      if (stage.rooms.some((room) => room.id === roomId)) continue;
      await change(async () => { await deps.api.closeTopic(group.chatId, topic.threadId); });
      delete group.topics[roomId];
    }
    await deps.reach.save((one) => { one.group = { ...group, ...(trouble ? { trouble } : { trouble: undefined }) }; });
    return trouble;
  }

  return {
    sync,
    // The founder sent the code inside the group. Only they can do this, and only in a group that is laid out as rooms.
    async pair(chat: Chat, stage: Stage): Promise<string> {
      if (!isForum(chat)) return NO_TOPICS;
      await deps.reach.save((one) => { one.group = { chatId: chat.id, title: chat.title ?? 'Your company', at: Date.now(), topics: {} }; });
      return (await sync(stage)) ?? READY;
    },
    // Taken out of the group, or demoted out of being able to do anything: the app stops believing it has a company there.
    async membership(event: Membership) {
      const group = await held();
      if (!group || event.chat.id !== group.chatId) return;
      const status = event.new_chat_member?.status;
      if (status === 'left' || status === 'kicked') await deps.reach.save((one) => { one.group = undefined; });
      else if (status === 'administrator' && event.new_chat_member?.can_manage_topics === false) await deps.reach.save((one) => { one.group = { ...group, trouble: NO_RIGHTS }; });
    },
    async forget() { await deps.reach.save((one) => { one.group = undefined; }); },
    // Where a person's own words go, and which person the founder is writing to when they write in a topic.
    threadFor: async (roomId: string) => (await held())?.topics[roomId]?.threadId,
    roomFor: async (threadId?: number) => {
      const group = await held();
      if (!group || !threadId) return undefined;
      return Object.entries(group.topics).find(([, topic]) => topic.threadId === threadId)?.[0];
    },
  };
}
