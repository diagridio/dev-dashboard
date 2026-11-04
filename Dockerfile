# syntax=docker/dockerfile:1

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS build
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
