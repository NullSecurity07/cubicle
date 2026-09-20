import { expect, test, type Page } from '@playwright/test';

// One piece of work given away: Maya hands it to Dev, Dev does it with his own tools in his own room, and all that
// comes back to Maya is what he made of it.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

// The wire that makes them colleagues, drawn through the api: drawing wires by hand is the stage journey's business.
async function wireThem(page: Page) {
  type Wire = { id: string; from: string; to: string };
  const stage = await (await page.request.get('/api/stage')).json();
  if (!(stage.wires as Wire[]).some((wire) => wire.id === 'marketing-build')) {
    await page.request.put('/api/stage', { data: { ...stage, wires: [...stage.wires, { id: 'marketing-build', from: 'marketing', fromHandle: 'b', to: 'build', toHandle: 't' }] } });
    await page.reload();
    await expect(node(page, 'marketing')).toBeVisible();
  }
}

// A whole turn with a colleague's turn inside it takes longer than a plain one, so the wait is longer too.
async function send(page: Page, room: string, text: string) {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  await expect(node(page, room).locator('.status--idle')).toBeVisible({ timeout: 40_000 });
  return node(page, room).locator('.msg--assistant').last();
}

const broke: string[] = [];
test.beforeEach(async ({ page }) => {
  broke.length = 0;
  page.on('pageerror', (error) => broke.push(error.message));
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
});

// Every journey shares one workspace and this one runs first, so it puts the stage, the playbook and both
// conversations back as it found them: empty, with nothing learned and only the seed wire drawn.
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const stage = await (await page.request.get('/api/stage')).json();
  await page.request.put('/api/stage', { data: { ...stage, cards: [], wires: (stage.wires as { id: string }[]).filter((wire) => wire.id === 'marketing-brand-doc') } });
  for (const skill of (await (await page.request.get('/api/skills')).json()) as { id: string }[]) await page.request.delete(`/api/skills/${skill.id}`);
  for (const room of ['marketing', 'build']) {
    for (const message of (await (await page.request.get(`/api/rooms/${room}/chat`)).json()) as { id: string }[]) await page.request.delete(`/api/rooms/${room}/chat/${message.id}`);
  }
  expect(broke).toEqual([]);
});

test('work handed to a colleague is done in their own room, and only the summary comes back', async ({ page }) => {
  await wireThem(page);
  const reply = await send(page, 'marketing', '/tool delegate_task {"to":"Dev","goal":"Write the build notes down.\\n/tool write_file {\\"path\\":\\"delegation/notes.md\\",\\"text\\":\\"Two weeks for SSO.\\"}","context":"Keep it to one line."}');

  // The receipt says who it went to, in plain words, and opens on what came back.
  const chip = node(page, 'marketing').locator('.chip').last();
  await expect(chip.locator('summary')).toHaveText('Handed to Dev');
  await chip.locator('summary').click();
  await expect(chip).toContainText('Dev finished.');
  await expect(chip).toContainText('Dev did what was asked.');
  await expect(chip).toContainText('Changed: write_file');
  // What his tool actually said stayed with him: Maya got the hand-over, not everything he read and wrote.
  const said = reply.locator('.md');
  await expect(said).toContainText('Dev finished.');
  await expect(said).not.toContainText('Wrote 18 characters');
  await expect(said).not.toContainText('Two weeks for SSO.');

  // His room holds the whole of it: who asked, what they asked for, the call he made and what he said about it.
  const his = node(page, 'build');
  await expect(his.locator('.msg--colleague')).toContainText('Maya asked');
  await expect(his.locator('.msg--colleague')).toContainText('Write the build notes down.');
  await expect(his.locator('.msg--colleague')).toContainText('Keep it to one line.');
  const madeIt = his.locator('.chip').last();
  await expect(madeIt.locator('summary')).toHaveText('Saved delegation/notes.md');
  await madeIt.locator('summary').click();
  await expect(madeIt).toContainText('Wrote 18 characters.');
  await expect(his.locator('.msg--assistant').last()).toContainText('Dev did what was asked.');
  // The shape the hand-over travelled in is not left lying in his room for the founder to read.
  await expect(his.locator('.msg--assistant').last()).not.toContainText('"done"');

  await page.screenshot({ path: '.shots/delegation-handed-over.png' });

  // The file is really there, made by somebody the founder never spoke to this turn.
  expect(await (await page.request.get('/api/files/delegation/notes.md')).text()).toBe('Two weeks for SSO.');
});

test('nobody can be handed work without a wire, and the refusal says how to draw one', async ({ page }) => {
  const reply = await send(page, 'marketing', '/tool delegate_task {"to":"Dev","goal":"anything at all"}');
  await expect(reply).toContainText('no colleague called "Dev" is connected to your room');
  await expect(reply).toContainText('drawing a wire between them');
});
