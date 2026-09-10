/**
 * The canonical `.env.example`. `cubicle init` writes this into the new vault, so a vault scaffolded
 * from an installed package does not depend on the repo checkout being present.
 * `packages/core/test/vault.test.ts` asserts it stays byte-identical to the repo-root `.env.example`.
 */
export const ENV_EXAMPLE = `# CUBICLE environment — copy to .env at the repo root. Never commit .env.
# Only free tiers. See SETUP.md for signup links; \`cubicle doctor\` checks each key.

# LLM providers (any subset; Ollama is the always-available local floor)
GEMINI_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=

# Outbound email (Brevo free plan)
BREVO_API_KEY=
BREVO_SENDER_EMAIL=

# Inbound email (Gmail app password over IMAP)
IMAP_HOST=imap.gmail.com
IMAP_USER=
IMAP_PASS=

# Site hosting (Cloudflare Pages free plan)
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=

# Payments (Stripe test-mode key first)
STRIPE_SECRET_KEY=

# Analytics (GoatCounter hosted, free for reasonable use)
GOATCOUNTER_CODE=
GOATCOUNTER_API_TOKEN=

# Daemon
CUBICLE_PORT=7411
CUBICLE_PLAN_MAX_AGE_DAYS=3   # a substantive plan younger than this, with work still open, is not rewritten every heartbeat
CUBICLE_VAULT=
CUBICLE_DBUS_ADDRESS=
`;
