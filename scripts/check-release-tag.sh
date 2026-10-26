#!/bin/bash
# check-release-tag.sh — fail loudly when a release tag violates the
# version contract, before it ships. Usage: ./scripts/check-release-tag.sh <tag>
# (e.g. ./scripts/check-release-tag.sh 2026.10.25-beta.1)
#
# Rules (same installer constraints as manifold's RELEASING.md):
#   1. The tag is the version, verbatim: package.json must already carry it.
#   2. Same-day rebuilds append -beta.N starting at beta.1 — beta.0 is
#      rejected by the installer's strict CalVer parser (sequence > 0).
#   3. CalVer dates are UTC: a 23:30 -0300 merge is already tomorrow.
set -u

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "usage: $0 <tag>" >&2
  exit 2
fi

PKG_VERSION="$(node -p "require('./package.json').version")"
if [[ "$PKG_VERSION" != "$TAG" ]]; then
  echo "FAIL: tag $TAG != package.json $PKG_VERSION — bump package.json first" >&2
  exit 1
fi

if [[ "$TAG" =~ -beta\.0$ ]]; then
  echo "FAIL: tag $TAG uses beta.0 — numbering starts at beta.1" >&2
  exit 1
fi

TAG_DATE="${TAG%%-*}"
TODAY_UTC="$(date -u +%Y.%m.%d)"
if [[ "$TAG_DATE" != "$TODAY_UTC" ]]; then
  echo "FAIL: tag date $TAG_DATE is not UTC today ($TODAY_UTC) — re-cut with today's date (tags are never rewritten)" >&2
  exit 1
fi

echo "release contract holds: $TAG"
