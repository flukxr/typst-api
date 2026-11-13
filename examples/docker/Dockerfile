# Consumer-facing example image. The package itself never downloads Typst; the
# image pins an exact compiler release with a checksum so the build is
# reproducible. The launcher package @flukxr/typst-cli is deliberately not
# installed: discovery would prefer it over the verified binary on PATH. For
# other architectures or versions, use the same pinned pattern with the
# matching artifact.
#
# Build:   docker build -t typst-api-example examples/docker
# Run:     docker run --rm -v "$PWD:/work" -w /work typst-api-example
FROM node:22-alpine

RUN apk add --no-cache ca-certificates curl tar xz \
  && curl -sSLo /tmp/typst.tar.xz \
    https://github.com/typst/typst/releases/download/v0.15.1/typst-x86_64-unknown-linux-musl.tar.xz \
  && echo "A6D077D0A95EED5A2EBA715B2DAE06BE954F624CCBF85758A03F389DED33118C  /tmp/typst.tar.xz" | sha256sum -c - \
  && tar -xJf /tmp/typst.tar.xz -C /usr/local/bin --strip-components=1 \
  && rm /tmp/typst.tar.xz \
  && typst --version

WORKDIR /opt/typst-api-example
COPY compile.mjs ./
RUN npm init -y >/dev/null \
  && npm install @flukxr/typst-api --no-audit --no-fund

WORKDIR /work
ENTRYPOINT ["node", "/opt/typst-api-example/compile.mjs"]
