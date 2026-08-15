############################################
# Base Runtime
############################################
FROM node:22-bookworm-slim AS base
RUN apt update && apt install --yes --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    unzip \
    dumb-init \
    util-linux \
    python3 \
    make \
    g++ \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl --retry 5 --retry-all-errors --retry-delay 5 -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg \
    && gpg --dearmor -o /etc/apt/keyrings/docker.gpg /tmp/docker.gpg \
    && rm /tmp/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo \
         "deb [arch=\"$(dpkg --print-architecture)\" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
         \"$(. /etc/os-release && echo \"$VERSION_CODENAME\")\" stable" | \
         tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt update \
    && apt --yes --no-install-recommends install \
         docker-ce-cli \
         docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx

############################################
# Healthcheck Binary
############################################
FROM golang:1.21.4-bookworm AS build_healthcheck
WORKDIR /app
COPY ./extra/healthcheck.go ./extra/healthcheck.go
RUN go build -o ./extra/healthcheck ./extra/healthcheck.go

############################################
# Build
############################################
FROM base AS build
WORKDIR /app
COPY --chown=node:node  ./package.json ./package.json
COPY --chown=node:node  ./package-lock.json ./package-lock.json
RUN npm ci --omit=dev

############################################
# ⭐ Main Image
############################################
FROM base AS release
WORKDIR /app
RUN apt update \
    && apt install --yes --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node --from=build_healthcheck /app/extra/healthcheck /app/extra/healthcheck
COPY --from=build /app/node_modules /app/node_modules
COPY --chown=node:node  . .
RUN mkdir ./data


# It is just for safe, as by default, it is disabled in the latest Node.js now.
# Read more:
# - https://github.com/sagemathinc/cocalc/issues/6963
# - https://github.com/microsoft/node-pty/issues/630#issuecomment-1987212447
ENV UV_USE_IO_URING=0

VOLUME /app/data
EXPOSE 8612
HEALTHCHECK --interval=60s --timeout=30s --start-period=60s --retries=5 CMD extra/healthcheck
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["tsx", "./backend/index.ts"]

############################################
# Mark as Nightly
############################################
FROM release AS nightly
RUN npm run mark-as-nightly
