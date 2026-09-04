# SETUP — free accounts CUBICLE can use

Everything here is optional. With no keys at all the company still runs on Ollama, and every outbound tool records what it *would* have done under `.cubicle/mock/`. Add keys to `.env` at the repo root (never inside the vault), then run `pnpm cubicle doctor` to verify. **Confirm you are on the free plan before saving any key.**

| Service | What it powers | Env vars | Free basis (verified 2026-09-02) | Where to get it |
|---|---|---|---|---|
| Google Gemini | strong/medium/cheap models | `GEMINI_API_KEY` | Gemini 3.x flash models are "free of charge" in the Standard tier; RPM/RPD shown only in AI Studio → paste them into `config/providers.yaml` | https://aistudio.google.com/apikey → then https://aistudio.google.com/rate-limit |
| Groq | medium/cheap models | `GROQ_API_KEY` | free tier: 30 RPM / 1K RPD / 8K TPM on gpt-oss and qwen models | https://console.groq.com/keys |
| OpenRouter | fallback `:free` models | `OPENROUTER_API_KEY` | `:free` models, 20 RPM and 50 requests/day without purchased credits | https://openrouter.ai/keys |
| Ollama | local floor + embeddings | none | local; needs the first enabled `ollama` model in config/providers.yaml (`qwen2.5:7b`) and `nomic-embed-text` (`ollama pull …`) | https://ollama.com |
| Brevo | outbound email | `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, optional `BREVO_SENDER_NAME` | free plan (daily sending cap — confirm the current number at signup; the constitution's `max_emails_per_day` must stay below it) | https://app.brevo.com/settings/keys/api |
| Gmail (IMAP) | inbound replies | `IMAP_HOST=imap.gmail.com`, `IMAP_USER`, `IMAP_PASS` (an app password, not your login password) | free | https://myaccount.google.com/apppasswords (needs 2-step verification) |
| Cloudflare Pages | site hosting | `CLOUDFLARE_API_TOKEN` (Pages: Edit), `CLOUDFLARE_ACCOUNT_ID` | free plan: 500 builds/month, 100 projects | https://dash.cloudflare.com/profile/api-tokens · account id on the dashboard sidebar |
| Stripe | payment links | `STRIPE_SECRET_KEY` (start with a test key `sk_test_…`) | account is free; Stripe only takes a per-transaction fee when a customer pays | https://dashboard.stripe.com/test/apikeys |
| GoatCounter | analytics | `GOATCOUNTER_CODE` (your `<code>.goatcounter.com`), `GOATCOUNTER_API_TOKEN` | free hosted for "reasonable public usage" | https://www.goatcounter.com/signup → Settings → API tokens |

Not free, not used: Cerebras (30-day trial only), xAI (optional, key required).

## Local prerequisites (checked by `cubicle doctor`)

- Ollama running with `qwen2.5:7b` and `nomic-embed-text`
- Docker daemon, and the sandbox image: `docker build -t cubicle-sandbox config/sandbox` (or `pnpm cubicle doctor --build-sandbox`)
- Playwright Chromium: `pnpm --filter @cubicle/tools exec playwright install chromium` if the doctor says it is missing
- Tray app (Tauri): Rust (https://rustup.rs) and `sudo pacman -S --needed webkit2gtk-4.1 libappindicator-gtk3 librsvg base-devel`. `pnpm -r build` compiles the tray binary; `pnpm --filter @cubicle/app start` runs it.
