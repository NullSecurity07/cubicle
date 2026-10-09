import { expect, test, type Page } from '@playwright/test';

// With no mail key, a person drafts and the founder sends: the draft is one press from their own Gmail, from the
// chat or from Needs you, and opening it is what takes it off the list. Nothing is sent by the app.
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

async function send(page: Page, room: string, text: string) {
  await expect(node(page, room).locator('.status--idle')).toBeVisible();
  await node(page, room).locator('.ask textarea').fill(text);
  await node(page, room).locator('.ask textarea').press('Enter');
  await expect(node(page, room).locator('.status--idle')).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  // Gmail itself is never reached: the tab the button opens gets a blank page.
  await page.context().route('https://mail.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Gmail</title>' }));
  await page.goto('/');
  await expect(node(page, 'marketing')).toBeVisible();
});

// Maya's conversation is shared with every other journey, so the drafts are taken back out of it.
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const chat = (await (await page.request.get('/api/rooms/marketing/chat')).json()) as { id: string; text: string }[];
  const from = chat.findIndex((message) => message.text.startsWith('/tool draft_email'));
  if (from >= 0) for (const message of chat.slice(from)) await page.request.delete(`/api/rooms/marketing/chat/${message.id}`);
  for (const entry of (await (await page.request.get('/api/attention')).json()) as { id: string; kind: string }[]) {
    // Cleared as opened, so the clean-up is not kept as the founder's no.
    if (entry.kind === 'mail-draft') await page.request.post(`/api/attention/${encodeURIComponent(entry.id)}/dismiss`, { data: { opened: true } });
  }
});

test('a drafted email opens in Gmail from the chat or from Needs you, and opening it clears it', async ({ page }) => {
  await send(page, 'marketing', '/tool draft_email {"to":"lead@example.com","subject":"Hello & welcome","body":"Hi there"}');
  const room = node(page, 'marketing');
  await expect(room.locator('.chip--ok summary').last()).toHaveText('Drafted email to lead@example.com');
  await expect(room.locator('.msg--assistant').last()).toContainText('Nothing was sent');
  // Until the founder opens it, the draft is only a filled-in link: it never says it is in their Gmail.
  const said = room.locator('.draft-open__said').last();
  await expect(said).toHaveText('Email drafted for you');
  const open = room.getByRole('link', { name: 'Open in Gmail' });
  await expect(open).toHaveAttribute('href', 'https://mail.google.com/mail/?view=cm&fs=1&to=lead%40example.com&su=Hello%20%26%20welcome&body=Hi%20there');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(room.getByRole('link', { name: 'Other mail app' })).toHaveAttribute('href', /^mailto:lead%40example\.com\?subject=Hello%20%26%20welcome&body=Hi%20there$/);

  const bell = page.getByRole('button', { name: /^Needs you/ });
  await expect(bell).toHaveAccessibleName('Needs you: 1 waiting');
  await bell.click();
  const needs = page.getByRole('dialog', { name: 'Needs you' });
  await expect(needs.locator('.needs__item--mail-draft')).toContainText('Maya has an email ready for you to send');
  await expect(needs.locator('.needs__item--mail-draft')).toContainText('Email to lead@example.com ready to send');
  await page.keyboard.press('Escape');

  // Pressing the chat's button opens Gmail in a new tab and takes the draft off the list.
  const [tab] = await Promise.all([page.waitForEvent('popup'), open.click()]);
  await expect(tab).toHaveURL(/mail\.google\.com\/mail\/\?view=cm/);
  await tab.close();
  await expect(bell).toHaveAccessibleName('Needs you: nothing waiting');
  await expect(said).toHaveText('Opened in Gmail');
  await expect(room.getByRole('link', { name: 'Open again' })).toBeVisible();

  // A second draft, opened from Needs you instead.
  await send(page, 'marketing', '/tool draft_email {"to":"other@example.com","subject":"Second","body":"Again"}');
  await expect(bell).toHaveAccessibleName('Needs you: 1 waiting');
  await bell.click();
  const entry = needs.locator('.needs__item--mail-draft');
  const [second] = await Promise.all([page.waitForEvent('popup'), entry.getByRole('link', { name: 'Open in Gmail' }).click()]);
  await expect(second).toHaveURL(/to=other%40example\.com/);
  await second.close();
  await expect(bell).toHaveAccessibleName('Needs you: nothing waiting');
  // Opened from Needs you, the chat says so too.
  await expect(room.locator('.draft-open__said').last()).toHaveText('Opened in Gmail');
});

// Journey 15: opening a draft in Gmail was logged as the founder saying no, and the same email drafted again was put
// to them as "You said no to this". Opening is acting on it; only Dismiss is a no.
test('opening a draft in Gmail is not a no, and Dismiss on Needs you is', async ({ page }) => {
  const draft = '/tool draft_email {"to":"chip-saidno@example.com","subject":"Intro to the chip test","body":"Hi"}';
  const room = node(page, 'marketing');
  await send(page, 'marketing', draft);
  const [tab] = await Promise.all([page.waitForEvent('popup'), room.getByRole('link', { name: 'Open in Gmail' }).last().click()]);
  await tab.close();
  const bell = page.getByRole('button', { name: /^Needs you/ });
  await expect(bell).toHaveAccessibleName('Needs you: nothing waiting');

  // The same draft again is fresh: drafted at once, with no "You said no".
  await send(page, 'marketing', draft);
  await expect(room.locator('.chip--ok summary').last()).toHaveText('Drafted email to chip-saidno@example.com');
  await expect(room.locator('.approval__title')).toHaveCount(0);

  // Dismiss on Needs you is the founder's no: the same email comes back asked, with the no quoted.
  await bell.click();
  const needs = page.getByRole('dialog', { name: 'Needs you' });
  await needs.locator('.needs__item--mail-draft').getByRole('button', { name: 'Dismiss' }).click();
  await expect(bell).toHaveAccessibleName('Needs you: nothing waiting');
  await page.keyboard.press('Escape');
  await expect(node(page, 'marketing').locator('.status--idle')).toBeVisible();
  await node(page, 'marketing').locator('.ask textarea').fill(draft);
  await node(page, 'marketing').locator('.ask textarea').press('Enter');
  await expect(room.locator('.approval__title').last()).toHaveText(/^You said no to this on \d{1,2} \w{3}\. Ask again\?$/);
  await room.getByRole('button', { name: "Don't" }).last().click();
  await expect(node(page, 'marketing').locator('.status--idle')).toBeVisible({ timeout: 20_000 });
});

// Journey 19: "I will check on those details and come back to you" was refused as a claim about VAT, and after the
// founder pressed Allow on the gate the same body was refused again.
test('an honest "I will check" drafts at once, and a body the founder allowed is not refused again', async ({ page }) => {
  const room = node(page, 'marketing');
  const to = 'honest-check@example.com';
  const subject = 'Re: your questions';
  const honest = 'Hi Tom,\n\nRegarding your old Android phone and VAT separately: I will check on those details and come back to you.\n\nBest,\nAlex Hart';
  await send(page, 'marketing', `/tool draft_email ${JSON.stringify({ to, subject, body: honest })}`);
  await expect(room.locator('.chip--ok summary').last()).toHaveText(`Drafted email to ${to}`);

  // A body that says the product shows VAT, with nothing on record, is refused.
  const claim = 'Hi Tom,\n\nThe quote shows VAT on its own line.\n\nBest,\nAlex Hart';
  await send(page, 'marketing', `/tool draft_email ${JSON.stringify({ to, subject: 'Re: VAT', body: claim })}`);
  await expect(room.locator('.msg--assistant').last()).toContainText('says something about VAT');

  // Dismiss on Needs you is a no; the same email asked again comes with the gate, and the founder's Allow drafts it.
  const bell = page.getByRole('button', { name: /^Needs you/ });
  await bell.click();
  const needs = page.getByRole('dialog', { name: 'Needs you' });
  await needs.locator('.needs__item--mail-draft').getByRole('button', { name: 'Dismiss' }).click();
  await page.keyboard.press('Escape');
  await expect(room.locator('.status--idle')).toBeVisible();
  await room.locator('.ask textarea').fill(`/tool draft_email ${JSON.stringify({ to, subject, body: claim })}`);
  await room.locator('.ask textarea').press('Enter');
  await expect(room.locator('.approval__title').last()).toHaveText(/^You said no to this on/);
  await room.getByRole('button', { name: 'Allow' }).last().click();
  await expect(room.locator('.status--idle')).toBeVisible({ timeout: 20_000 });
  await expect(room.locator('.chip--ok summary').last()).toHaveText(`Drafted email to ${to}`);
});
