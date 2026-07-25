FROM ghcr.io/cloudflare/workspace-wsd-linux-x64:0.0.0-alpha.7 AS wsd
FROM debian:stable-slim
ARG SUPERMEMORY_URL=https://github.com/supermemoryai/supermemory/releases/download/server-v0.0.2/supermemory-server-linux-x64
ARG SUPERMEMORY_SHA256=8bf394690807b37786d22a61d3ee64212b7ae82374894e754856134ca60761b4
RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2t64 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "$SUPERMEMORY_URL" -o /usr/local/bin/supermemory-server \
 && echo "$SUPERMEMORY_SHA256  /usr/local/bin/supermemory-server" | sha256sum -c - \
 && chmod +x /usr/local/bin/supermemory-server
COPY --from=wsd /usr/local/bin/wsd /usr/local/bin/wsd
ENV PORT=8080 MOUNT_POINT=/workspace FUSE_MOUNT=auto
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/wsd"]
