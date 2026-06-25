.PHONY: web build test test-go test-web tidy

web:
	cd web && npm install && npm run build

build: web
	go build -o bin/dev-dashboard .

test-go:
	go test -tags unit -race ./...

test-web:
	cd web && npm install && npm test

test: test-go test-web

tidy:
	go mod tidy
