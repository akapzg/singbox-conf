#!/usr/bin/env bash
# Worker Preview name for a branch: lowercase letters, digits and hyphens. Kept short because the
# preview URL is <name>-singbox-confgen.<subdomain>.workers.dev and a DNS label holds 63 chars.
set -euo pipefail
name=$(printf '%s' "${1:?branch}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//' | cut -c1-40 | sed -E 's/-+$//')
printf '%s\n' "${name:-branch}"
