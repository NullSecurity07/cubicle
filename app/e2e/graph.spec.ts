import { expect, test, type Page } from '@playwright/test';

// Journeys share one workspace: this one starts from the four seed cards and puts them back when it is done.
async function tidy(page: Page) {
  const stage = await (await page.request.get('/api/stage')).json();
  const keep = new Set(['marketing', 'build', 'brand-doc', 'company-brief']);
  await page.request.put('/api/stage', { data: {
    rooms: stage.rooms.filter((room: { id: string }) => keep.has(room.id)).map((room: object) => ({ ...room, model: undefined })),
    docs: stage.docs.filter((doc: { id: string }) => keep.has(doc.id)), cards: [],
    wires: stage.wires.filter((wire: { id: string }) => wire.id === 'marketing-brand-doc'),
  } });
  await page.reload();
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible();
}

test('a coder card maps its folder: the steps show in its log, then one quiet line with the map and its report', async ({ page }) => {
  await page.goto('/');
  await tidy(page);
  await page.getByRole('button', { name: 'More cards' }).click();
  await page.getByRole('menuitem', { name: 'Add coder', exact: true }).click();
  const card = page.locator('.react-flow__node-project');
  // Nothing to map before there is a folder.
  await expect(card.getByRole('button', { name: 'Map folder' })).toBeDisabled();
  await card.getByLabel('Project folder').fill('/usr/share');
  await expect(card.locator('.card__name')).toHaveText('share');
  await page.waitForTimeout(600);

  // Fake mode maps a made-up folder of five pieces of code; the lines land on the card like the coder's steps.
  await card.getByRole('button', { name: 'Map folder' }).click();
  const log = card.locator('.coder__log');
  await expect(log.locator('.coder__line--tool').filter({ hasText: 'Rebuilt: 5 nodes, 7 edges, 2 communities' })).toBeVisible();
  await expect(log.locator('.coder__line--note').last()).toContainText('mapped · 5 nodes · 7 links · 2 groups');
  const line = card.locator('.coder__map');
  await expect(line).toContainText('Mapped just now · 5 nodes · 2 groups');
  await expect(card.getByRole('button', { name: 'Map folder' })).toBeEnabled();
  const id = (await card.getAttribute('data-id'))!;
  await expect(line.getByRole('link', { name: 'Open graph' })).toHaveAttribute('href', `/api/coder/${id}/graph.html`);
  const drawing = await page.request.get(`/api/coder/${id}/graph.html`);
  expect(drawing.status()).toBe(200);
  expect(drawing.headers()['content-security-policy']).toContain('sandbox');

  // The report opens the card large, on what Graphify found.
  await line.getByRole('button', { name: 'Report' }).click();
  const large = page.locator('.card--focused');
  await expect(large.locator('.coder__report')).toContainText('Graph Report - shop');
  await large.getByRole('button', { name: 'Back to the log' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.card--focused')).toHaveCount(0);

  // The counts are kept on the card in the saved stage.
  await expect.poll(async () => (await (await page.request.get('/api/stage')).json()).cards.find((one: { id: string }) => one.id === id)?.graph?.nodes).toBe(5);
  await tidy(page);
});
