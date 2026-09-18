# cubicle-sandbox: what the Engineer's shell.run gets. Node + pnpm + Astro preinstalled, plus a ready-made minimal
# Astro site (with node_modules) under /opt/templates/minimal so scaffolding and building work with NO network:
#   cp -a /opt/templates/minimal/. /work/Site/ && npm run build
#
# The plain static template is NOT baked in: the repo's own config/templates/ is bind-mounted read-only at
# /opt/cubicle-templates on every shell.run and ci.run, so /opt/cubicle-templates/static is there without a
# rebuild and an edit to it takes effect on the next call (ruling W4-8).
# Build: docker build -t cubicle-sandbox config/sandbox
FROM node:26-bookworm
RUN corepack enable && corepack prepare pnpm@11 --activate || npm install -g pnpm@11
RUN npm install -g astro@7 create-astro@latest
RUN mkdir -p /opt/templates && cd /opt/templates \
 && create-astro minimal --template minimal --yes --no-git --install \
 && cd minimal && npm run build && rm -rf dist \
 && chmod -R a+rwX /opt/templates
WORKDIR /work/Site
ENV CI=1 npm_config_update_notifier=false
CMD ["bash"]
