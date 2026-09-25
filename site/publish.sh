#!/usr/bin/env bash
# Puts the website on Cloudflare Pages, under the project name "cubicle" unless PAGES_PROJECT says otherwise.
#
#   site/publish.sh           deploy the page, its stylesheet, its script and its pictures
#   site/publish.sh --check   only list the account's Pages projects, to prove the token works; changes nothing
#
# It reads CLOUDFLARE_PAGES_TOKEN (or else CLOUDFLARE_API_TOKEN) and CLOUDFLARE_ACCOUNT_ID from the .env at the top of the repository (a worktree
# borrows the main checkout's) and nothing else from that file. Only the files a visitor needs are uploaded: the
# README, this script and the screenshots folder stay here.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$repo/.git")
project=${PAGES_PROJECT:-cubicle}

env_file=${CUBICLE_ENV:-}
for candidate in "$repo/.env" "$(dirname "$common")/.env"; do
  if [[ -z $env_file && -f $candidate ]]; then env_file=$candidate; fi
done

# One value out of the .env, without running the file as a script.
value() { [[ -n $env_file ]] && grep -E "^$1=" "$env_file" | tail -n 1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
# A token of its own for Pages when there is one, so the pictures' Workers AI token can stay as narrow as it is.
pages_token=${CLOUDFLARE_PAGES_TOKEN:-$(value CLOUDFLARE_PAGES_TOKEN || true)}
export CLOUDFLARE_API_TOKEN=${pages_token:-${CLOUDFLARE_API_TOKEN:-$(value CLOUDFLARE_API_TOKEN || true)}}
export CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-$(value CLOUDFLARE_ACCOUNT_ID || true)}
if [[ -z $CLOUDFLARE_API_TOKEN || -z $CLOUDFLARE_ACCOUNT_ID ]]; then
  echo "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in ${env_file:-$repo/.env} first (see site/README.md)." >&2
  exit 1
fi

wrangler() { npx --yes wrangler "$@"; }

if [[ ${1:-} == --check ]]; then
  wrangler pages project list
  exit 0
fi

# A clean copy of what the page needs, so nothing else in the folder is ever published by accident.
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
cp "$here/index.html" "$here/style.css" "$here/theme.js" "$out/"
cp -r "$here/media" "$out/media"

# The first deploy creates the project; after that it is already there.
if ! wrangler pages project list 2>/dev/null | grep -qw "$project"; then
  wrangler pages project create "$project" --production-branch main
fi
wrangler pages deploy "$out" --project-name "$project" --branch main --commit-dirty=true
