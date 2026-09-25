// The product's name lives here and nowhere else: every element marked data-name shows it, and the tab title ends
// with it. It is a working title, so renaming the site is one edit.
const NAME = 'Cubicle';

// The theme follows the system unless the visitor picked one; the pick is kept in this browser only.
const KEY = 'site-theme';
const root = document.documentElement;
const saved = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;

const current = () => root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

document.addEventListener('DOMContentLoaded', () => {
  document.title = `${NAME}: ${document.title}`;
  for (const element of document.querySelectorAll('[data-name]')) element.textContent = NAME;

  const toggle = document.querySelector('[data-theme-toggle]');
  const label = () => toggle.setAttribute('aria-label', `Switch to the ${current() === 'dark' ? 'light' : 'dark'} theme`);
  label();
  toggle.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* a private window keeps it for this visit only */ }
    label();
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', label);
});
