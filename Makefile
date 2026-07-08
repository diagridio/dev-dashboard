.PHONY: web build lint lint-go lint-web hooks test test-go test-web test-integration test-e2e tidy release-snapshot release-check

web:
	cd web && npm install && npm run build

build: web
	go build -o bin/dev-dashboard .

lint: lint-go lint-web

lint-go:
	@test -z "$$(gofmt -l .)" || { echo "gofmt needed on:"; gofmt -l .; exit 1; }
	go vet -tags unit ./...

lint-web:
	cd web && npm install && npm run lint

hooks:
	@ln -sf ../../scripts/pre-commit .git/hooks/pre-commit
	@echo "Installed .git/hooks/pre-commit -> scripts/pre-commit"

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
