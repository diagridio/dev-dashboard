# syntax=docker/dockerfile:1

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS build
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

FROM gcr.io/distroless/static:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
COPY --from=build /out/diagrid-dev-dashboard /diagrid-dev-dashboard
ENV DEVDASHBOARD_MODE=aspire
EXPOSE 8080
ENTRYPOINT ["/diagrid-dev-dashboard"]
