# Saltline Arena match server — small runtime image with one static-ish binary.
FROM rust:1-slim AS build
WORKDIR /src
COPY . .
RUN cargo build --release --bin arena-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 arena && mkdir -p /data && chown arena /data
COPY --from=build /src/target/release/arena-server /usr/local/bin/arena-server
USER arena
ENV PORT=8790 DATABASE_URL=sqlite:///data/arena.db RUST_LOG=info
EXPOSE 8790
CMD ["arena-server"]
