import { expect, test } from '@playwright/test';

// The command bar, driven the way a founder types a long ask: key by key, fast, while the workspace search answers
// underneath and the mouse rests over the list, then Enter. Journey 15 saw React give up here with "Maximum update
// depth exceeded" and drop letters: the bar set state from an effect after every keystroke, a second render per letter.
test('the command bar keeps every letter of a long ask typed fast, with no update loop, and Enter runs what is typed', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.react-flow__node[data-id="marketing"]')).toBeVisible({ timeout: 30_000 });
  const input = page.getByRole('combobox', { name: 'Command or search' });
  await expect(async () => {
    await page.keyboard.press('Control+k');
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  // A resting mouse over where the list draws: every redraw moves a different row under it.
  await input.fill('a');
  const list = await page.getByRole('listbox', { name: 'Suggestions' }).boundingBox();
  await input.fill('');
  if (list) await page.mouse.move(list.x + 60, list.y + 30);

  const typed = `Pre-seed deck for PrintNear with the traction we have, the ask and the team;${' and keep it to ten slides'.repeat(10)}`;
  await input.pressSequentially(typed, { delay: 0 });
  // The workspace search lands, then more letters arrive on top of it.
  await page.waitForTimeout(500);
  await input.pressSequentially(' please now', { delay: 0 });
  await expect(input).toHaveValue(`${typed} please now`);

  // Then a short command typed at once and Enter straight after: it runs what is in the bar now.
  await input.press('Control+a');
  await input.pressSequentially('shortcuts', { delay: 0 });
  await input.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  expect(errors.filter((one) => /Maximum update depth/.test(one))).toEqual([]);
});
