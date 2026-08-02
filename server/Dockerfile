# Multi-stage build → tiny distroless static binary.
# go.mod requires go >= 1.25 (raised by the pgx v5.9.2 bump); the distroless
# runtime stage is version-independent.
FROM golang:1.25 AS build
WORKDIR /src
COPY server/go.* ./
RUN go mod download
COPY server/ ./
# Build identifier stamped into the binary (main.version). The release workflow
# passes the git tag; plain builds default to "dev". Surfaced by the admin
# dashboard and compared against the latest GitHub release.
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -ldflags "-X main.version=${VERSION}" -o /journald ./cmd/journald

FROM gcr.io/distroless/static-debian12
COPY --from=build /journald /journald
EXPOSE 8080
# The updater's health gate waits on this: a release that fails to start, or
# fails to migrate, never reports healthy and gets rolled back automatically.
# Exec form and a subcommand of the binary itself, because distroless has no
# shell and no curl — /journald is the only executable in the image.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/journald", "healthcheck"]
ENTRYPOINT ["/journald"]
