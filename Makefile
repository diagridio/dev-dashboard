.PHONY: web build test test-go test-web test-integration test-e2e tidy release-snapshot release-check

web:
	cd web && npm install && npm run build

build: web
	go build -o bin/dev-dashboard .

test-go:
	@if command -v gotestsum >/dev/null 2>&1; then gotestsum -- -tags unit -race ./...; else go test -tags unit -race ./...; fi

test-web:
	cd web && npm install && npm test

test: test-go test-web

test-integration:
	@if command -v gotestsum >/dev/null 2>&1; then gotestsum -- -tags integration -race ./...; else go test -tags integration -race ./...; fi

test-e2e:
	go test -tags e2e ./...

tidy:
	go mod tidy

release-snapshot:
	goreleaser release --snapshot --clean --skip=publish

release-check:
	goreleaser check
