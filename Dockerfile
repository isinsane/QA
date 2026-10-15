# syntax=docker/dockerfile:1

# Everything is built inside Docker: the server needs Docker and nothing
# else (no Node, no Go toolchain).
FROM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Every command, so the ops tools (set-password for the first admin,
# migrate, seed-demo) can be run inside the container too.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ ./cmd/...

FROM alpine:3.22
# tzdata: the business time zone (Settings) is loaded by name.
# ca-certificates: the QA API and eDesk are outbound HTTPS.
RUN apk add --no-cache ca-certificates tzdata wget \
    && adduser -D -u 10001 qa
WORKDIR /app
COPY --from=build /out/ /app/bin/
COPY --from=web /web/dist/ /app/web/
USER qa
# The API serves the web app from WEB_DIR on its own port and runs the
# database migrations (embedded in the binary) on start.
ENV PATH="/app/bin:${PATH}" \
    WEB_DIR=/app/web \
    HTTP_ADDR=:8080 \
    APP_ENV=prod
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["/app/bin/api"]
