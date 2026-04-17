FROM node:22-bookworm-slim

SHELL ["/bin/bash", "-lc"]

ARG INSTALL_SDKMAN=1
ARG EXTRA_APT_PACKAGES="git"

ENV SDKMAN_DIR=/usr/local/sdkman

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl zip unzip gettext-base tini openssh-client ${EXTRA_APT_PACKAGES} \
    && rm -rf /var/lib/apt/lists/*

RUN if [ "$INSTALL_SDKMAN" = "1" ]; then \
      curl -fsSL https://get.sdkman.io | bash \
      && ln -sf "$SDKMAN_DIR/bin/sdkman-init.sh" /etc/profile.d/sdkman.sh \
      && printf '\n[[ -s %q ]] && source %q\n' "$SDKMAN_DIR/bin/sdkman-init.sh" "$SDKMAN_DIR/bin/sdkman-init.sh" >> /root/.bashrc ; \
    fi

RUN npm install -g openclaw@latest

WORKDIR /opt/openclaw

COPY openclaw.template.json /etc/openclaw/openclaw.template.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /root/.openclaw /workspace

VOLUME ["/root/.openclaw", "/workspace"]

EXPOSE 18789

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["openclaw", "gateway"]
