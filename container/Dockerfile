# computerd for the PiSession container. The computerd version must match
# @cloudflare/computer in package.json.
FROM --platform=linux/amd64 ghcr.io/cloudflare/computer-computerd-linux-x64:0.4.1 AS computerd

FROM --platform=linux/amd64 node:22-bookworm-slim

# git is for tools that read the repository (npm, test runners), as in
# Computer's agent examples. Pi commits with the workspace's git, in the
# Worker shell, which carries the identity; see PREAMBLE.

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2 ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# FUSE_MOUNT=auto uses real FUSE on Cloudflare Containers and the userspace
# shim under wrangler dev.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
# exec runs commands with bash, not dash, so `set -o pipefail` and
# PIPESTATUS work; see computerd's README.
ENV EXEC_SHELL=/bin/bash
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
