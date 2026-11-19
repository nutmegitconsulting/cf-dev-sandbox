# The dev sandbox image: Debian Trixie with Node.js 24 and common build tools. Pinned by digest.
# A snapshot keeps the image it was taken from: sandboxes pick up a new image only after /reset.
FROM docker.io/library/node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         bash ca-certificates coreutils curl git openssh-client procps \
         python3 python3-venv python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace
WORKDIR /root
CMD ["sleep", "infinity"]
