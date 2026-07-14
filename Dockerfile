# syntax=docker/dockerfile:1

FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS build
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

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/diagrid-dev-dashboard /diagrid-dev-dashboard
ENV DEVDASHBOARD_MODE=aspire
EXPOSE 8080
ENTRYPOINT ["/diagrid-dev-dashboard"]
