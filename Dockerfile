# The dev sandbox image: Debian Trixie with Node.js 24 and common build tools. Pinned by digest.
# A snapshot keeps the image it was taken from: sandboxes pick up a new image only after /reset.
FROM docker.io/library/node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         bash ca-certificates coreutils curl git openssh-client procps \
         python3 python3-venv python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

# The browser lives here, next to the terminal's files, not in the agent's own container. Playwright for
# Node and for Python at one version, so both use the same Chromium build under /opt/ms-playwright;
# `playwright install --with-deps` adds the libraries and fonts that build links against.
# `chromium` (also chromium-browser, google-chrome) is that build with --no-sandbox: commands run as root,
# and Chromium refuses to start as root without it.
ARG PLAYWRIGHT_VERSION=1.64.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
    && pip3 install --no-cache-dir --break-system-packages "playwright==${PLAYWRIGHT_VERSION}" \
    && apt-get update \
    && playwright install --with-deps chromium \
    && apt-get install -y --no-install-recommends fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache \
    && chrome="$(ls /opt/ms-playwright/chromium-*/chrome-linux*/chrome | head -1)" \
    && test -x "$chrome" \
    && printf '#!/bin/sh\nexec %s --no-sandbox --disable-dev-shm-usage "$@"\n' "$chrome" > /usr/local/bin/chromium \
    && chmod +x /usr/local/bin/chromium \
    && ln -s chromium /usr/local/bin/chromium-browser && ln -s chromium /usr/local/bin/google-chrome \
    && printf 'export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright\nexport NODE_PATH=/usr/local/lib/node_modules\n' > /etc/profile.d/browser.sh
# The browser has to work in the image as built, the way a command reaches it: a login shell, as root.
RUN bash -lc 'chromium --headless --dump-dom "data:text/html,<h1>browser-ok</h1>" 2>/dev/null | grep -q browser-ok' \
    && bash -lc 'python3 -c "from playwright.sync_api import sync_playwright as p; c=p().start(); b=c.chromium.launch(); g=b.new_page(); g.set_content(\"<h1>py-ok</h1>\"); assert g.pdf(); b.close(); c.stop()"' \
    && bash -lc "node -e \"require('playwright').chromium.launch().then(async b=>{const p=await b.newPage();await p.setContent('ok');await p.screenshot();await b.close()})\""

RUN mkdir -p /workspace
WORKDIR /root
CMD ["sleep", "infinity"]
