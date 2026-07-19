FROM node:22-bookworm-slim
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
         "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
         "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
         tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt update \
    && apt --yes --no-install-recommends install \
         docker-ce-cli \
         docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx
