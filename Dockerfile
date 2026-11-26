# syntax=docker/dockerfile:1

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
ARG VERSION=dev
ARG COMMIT=unknown
ARG DATE=unknown
RUN CGO_ENABLED=0 go build \
    -ldflags "-s -w \
    -X github.com/diagridio/dev-dashboard/pkg/version.Version=${VERSION} \
    -X github.com/diagridio/dev-dashboard/pkg/version.Commit=${COMMIT} \
    -X github.com/diagridio/dev-dashboard/pkg/version.Date=${DATE}" \
    -o /out/diagrid-dev-dashboard .

FROM gcr.io/distroless/static:nonroot@sha256:8ce6dd87e9823c5b48dcfb2c8604714ccb351ce59607327bcc4957448da279b5
COPY --from=build /out/diagrid-dev-dashboard /diagrid-dev-dashboard
ENV DEVDASHBOARD_MODE=aspire
# Marks this process as running in a container (compose container posture
# requires it, so a stray DEVDASHBOARD_APP_COUNT on a host can't trigger it).
ENV DEVDASHBOARD_IN_CONTAINER=true
EXPOSE 8080
ENTRYPOINT ["/diagrid-dev-dashboard"]
