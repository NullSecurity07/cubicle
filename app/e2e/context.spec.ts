import { expect, test, type Page } from '@playwright/test';

// What a person is offered is what their own room can use. The stage is left exactly as it was found, because every
// other journey starts from the seeded one.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

async function send(page: Page, room: string, text: string) {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  await expect(node(page, room).locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  return node(page, room).locator('.msg--assistant').last();
}

// A task board on the stage, wired to Maya, put there through the api: drawing wires is the stage journey's business.
async function boardWiredToMaya(page: Page) {
  type Wire = { id: string; from: string; to: string };
  const stage = await (await page.request.get('/api/stage')).json();
  const id = 'board-context';
  await page.request.put('/api/stage', { data: {
    ...stage,
    cards: [...(stage.cards ?? []), { kind: 'board', id, x: 980, y: 0, w: 720, h: 380 }],
    wires: [...(stage.wires as Wire[]), { id: `marketing-${id}`, from: 'marketing', fromHandle: 'r', to: id, toHandle: 'l' }],
  } });
  await page.reload();
  await expect(node(page, id)).toBeVisible();
}

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
});

// The stage, Maya's conversation and the playbook are shared with every other journey, so this one puts all three
// back as it found them: a receipt left in her room is a receipt the next journey counts.
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.startsWith('/tool list_tasks'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  for (const skill of (await (await page.request.get('/api/skills')).json()) as { id: string }[]) await page.request.delete(`/api/skills/${skill.id}`);
  expect(broke).toEqual([]);
});

test('a person reaches for the board only once the founder has wired one to them', async ({ page }) => {
  // Nothing on the stage but the seeded people and docs: the board tools were never put in front of Maya, so asking
  // for one does not even reach a tool. She answers in words, and there is no receipt to show.
  const alone = await send(page, 'marketing', '/tool list_tasks {}');
  await expect(alone).toContainText('Maya here.');
  await expect(alone.locator('.chip')).toHaveCount(0);

  await boardWiredToMaya(page);
  const wired = await send(page, 'marketing', '/tool list_tasks {}');
  await expect(wired.locator('.chip--ok summary')).toHaveText('Read the board');
  await expect(wired).toContainText('The board is empty.');
});
