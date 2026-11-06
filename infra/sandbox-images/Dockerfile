# Judge worker images (brick 9, PRD §2.2b). One image per language: the language's toolchain
# plus isolate and the judge-worker binary. Build with scripts/build.sh, which passes the pinned
# base image for each language. The release pipeline records each pushed image's digest in
# sandbox_languages.image_digest; workers refuse languages whose registry digest is not theirs.
#
# Base images are pinned by version here; Renovate pins them by digest in CI (`@sha256:…`).

ARG LANG_BASE=python:3.12.8-slim-bookworm

# --- isolate (cgroups v2), built from a pinned release -------------------------------------------
FROM debian:12.8-slim AS isolate
ARG ISOLATE_VERSION=v2.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential git ca-certificates libcap-dev libsystemd-dev pkg-config asciidoc-base \
 && git clone --depth 1 --branch "${ISOLATE_VERSION}" https://github.com/ioi/isolate.git /src \
 && make -C /src isolate isolate-cg-keeper \
 && make -C /src install PREFIX=/opt/isolate \
 && rm -rf /var/lib/apt/lists/*

# --- judge-worker --------------------------------------------------------------------------------
FROM golang:1.23.12-bookworm AS worker
WORKDIR /src
COPY packages/go-platform/ packages/go-platform/
COPY services/sandbox-svc/go.mod services/sandbox-svc/go.sum services/sandbox-svc/
RUN cd services/sandbox-svc && go mod download
COPY services/sandbox-svc/ services/sandbox-svc/
RUN cd services/sandbox-svc && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/judge-worker ./cmd/judge-worker

# --- language image ------------------------------------------------------------------------------
FROM ${LANG_BASE}
ARG EXTRA_PACKAGES=""
RUN if [ -n "${EXTRA_PACKAGES}" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ${EXTRA_PACKAGES} && rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=isolate /opt/isolate/ /usr/local/
COPY --from=isolate /src/default.cf /usr/local/etc/isolate
COPY --from=worker /out/judge-worker /usr/local/bin/judge-worker
COPY infra/sandbox-images/entrypoint.sh /usr/local/bin/judge-entrypoint
# The box root lives on tmpfs (an emptyDir with medium: Memory in Kubernetes), sized per box.
RUN chmod 0755 /usr/local/bin/judge-entrypoint \
 && sed -i 's#^box_root.*#box_root = /var/local/lib/isolate#' /usr/local/etc/isolate \
 && sed -i 's#^cg_root.*#cg_root = /sys/fs/cgroup/isolate.slice#' /usr/local/etc/isolate \
 && mkdir -p /var/local/lib/isolate /var/cache/atlas-judge
ENV ATLAS_JUDGE_ISOLATE_BIN=/usr/local/bin/isolate \
    ATLAS_JUDGE_CGROUP_ROOT=/sys/fs/cgroup/isolate.slice
ENTRYPOINT ["/usr/local/bin/judge-entrypoint"]
