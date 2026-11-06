#!/bin/sh
# Builds one judge image per language from the repository root:
#   infra/sandbox-images/build.sh [registry/prefix]
# Prints "slug image@digest" lines for the release pipeline, which writes the digests into
# sandbox_languages.image_digest (images are referenced by digest, never by tag).
set -eu
cd "$(dirname "$0")/../.."
PREFIX="${1:-atlas/judge}"
# slug | base image | extra Debian packages
LANGS='
python|python:3.12.8-slim-bookworm|
java|eclipse-temurin:21.0.5_11-jdk-jammy|
cpp|gcc:13.3.0-bookworm|
c|gcc:13.3.0-bookworm|
node|node:22.12.0-bookworm-slim|
go|golang:1.23.12-bookworm|
'
echo "$LANGS" | while IFS='|' read -r slug base extra; do
  [ -n "$slug" ] || continue
  docker build -f infra/sandbox-images/Dockerfile \
    --build-arg LANG_BASE="$base" --build-arg EXTRA_PACKAGES="$extra" \
    -t "$PREFIX-$slug:build" . >&2
  echo "$slug $(docker image inspect --format '{{.Id}}' "$PREFIX-$slug:build")"
done
