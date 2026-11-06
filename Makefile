.PHONY: bootstrap infra-up infra-down migrate typecheck lint test build verify py-bootstrap py-verify openapi-py go-verify sandbox-attacks

bootstrap:            ## install dependencies (Node 24, npm 11)
	npm ci

infra-up:             ## start local Postgres+pgvector, PgBouncer, Redis, Redpanda, MinIO, Temporal, ClamAV
	docker compose -f infra/docker-compose.yml up -d --wait

infra-down:
	docker compose -f infra/docker-compose.yml down

migrate: build        ## apply db/migrations as atlas_owner
	ATLAS_DATABASE_OWNER_URL=$${ATLAS_DATABASE_OWNER_URL:-postgres://atlas_owner:atlas_owner_dev@localhost:5432/atlas} npm run migrate

typecheck:
	npm run typecheck

lint:
	npm run lint && npm run format:check

test:
	npm test

build:
	npm run build

PY_SERVICES := services/llm-gateway services/parsing-svc services/cv-inference services/interview-svc

py-bootstrap:         ## install Python services (uv; Python 3.12 per .python-version)
	@for s in $(PY_SERVICES); do (cd $$s && uv sync --frozen) || exit 1; done

py-verify:            ## ruff, mypy --strict, pytest with coverage (≥ 85%) for every Python service
	@for s in $(PY_SERVICES); do \
	  pkg=$$(basename $$s | tr - _); \
	  (cd $$s && uv run ruff check src tests ../../packages/py-platform/src \
	    && uv run ruff format --check src tests ../../packages/py-platform/src \
	    && uv run mypy src tests && uv run pytest --cov=$$pkg --cov-fail-under=85) || exit 1; \
	done

openapi-py:           ## regenerate checked-in OpenAPI for Python services
	@for s in $(PY_SERVICES); do (cd $$s && uv run python -m $$(basename $$s | tr - _).openapi) || exit 1; done

verify: typecheck lint test build py-verify   ## the Definition-of-Done gate (MASTER_ORCHESTRATION_PROMPT §8)

GO ?= go
GO_SERVICES := services/sandbox-svc services/proctoring-svc

go-verify:            ## gofmt, vet, golangci-lint, race tests with coverage (>= 85%) for Go services; needs Postgres 16 at ATLAS_TEST_PG_URL
	@for s in $(GO_SERVICES); do \
	  (cd $$s && test -z "$$(gofmt -l .)" && $(GO) vet ./... && golangci-lint run ./... \
	    && $(GO) test -race -count=1 -coverpkg=./internal/... -coverprofile=coverage.out ./... \
	    && $(GO) tool cover -func=coverage.out | awk '/^total:/ { sub("%", "", $$3); print "coverage " $$3 "%"; if ($$3 + 0 < 85) exit 1 }') || exit 1; \
	done
	@cd packages/go-platform && test -z "$$(gofmt -l .)" && $(GO) vet ./... \
	  && golangci-lint run --config ../../services/sandbox-svc/.golangci.yml ./... \
	  && $(GO) test -race -count=1 -coverpkg=./... -coverprofile=coverage.out ./... \
	  && $(GO) tool cover -func=coverage.out | awk '/^total:/ { sub("%", "", $$3); print "go-platform coverage " $$3 "%"; if ($$3 + 0 < 85) exit 1 }'

sandbox-attacks:      ## attack corpus + golden programs against the real isolate sandbox (Linux/Docker)
	services/sandbox-svc/test/attacks/run.sh
