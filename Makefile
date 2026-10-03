# Makefile — StellarFlow backend task runner
#
# Issue #1085 introduces `make test`: a single command that runs the entire
# Pytest suite inside Docker against containerised PostgreSQL and Redis that
# match production versions. The same target is used locally and in CI, so a
# green local run implies a green CI run.
#
# Quick start:
#   make test              # full suite (unit + integration) in Docker
#   make test-unit         # unit tests only, no containers required
#   make test-integration  # integration + E2E only
#   make test-up           # start services, keep them running
#   make test-shell        # interactive shell inside the runner
#   make test-logs         # tail the runner output
#   make test-down         # stop and remove test volumes
#   make help              # list every target

SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE_FILE := docker-compose.test.yml
COMPOSE      := docker compose -f $(COMPOSE_FILE)
SERVICE      := test

# Pytest flags shared by every target. `-p no:cacheprovider` keeps the
# container filesystem read-only-ish and avoids stale state between runs.
PYTEST_FLAGS ?= -p no:cacheprovider

# Selectors for the two halves of the suite.
#   integration marker -> needs PostgreSQL + Redis
#   e2e path           -> the 5-layer release-readiness suite
INTEGRATION_PATH := tests/integration

.PHONY: help
help: ## Show this help
	@echo "StellarFlow backend — available targets:"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Common overrides:"
	@echo "  PYTEST_FLAGS='-k redis'   make test    # filter selection"
	@echo "  PYTEST_FLAGS='-x --lf'    make test    # fail fast, last failures"

# ---------------------------------------------------------------------------
# Test targets
# ---------------------------------------------------------------------------

.PHONY: test
# check-docker runs first so a missing Docker install produces one clear
# message instead of a wall of compose usage text.
test: check-docker reports-dir ## Run the full Pytest suite (unit + integration) in Docker
	@echo "==> Running full Pytest suite in Docker (postgres:16-alpine, redis:7-alpine)"
	@$(COMPOSE) run --rm $(SERVICE) \
		python -m pytest tests \
		$(PYTEST_FLAGS)
	@$(MAKE) --no-print-directory test-report

.PHONY: test-unit
test-unit: check-docker reports-dir ## Run unit tests only (no containers required)
	@echo "==> Running unit tests"
	@$(COMPOSE) run --rm $(SERVICE) \
		python -m pytest tests \
		--ignore=$(INTEGRATION_PATH) \
		$(PYTEST_FLAGS)

.PHONY: test-integration
test-integration: check-docker reports-dir ## Run integration + E2E tests against containerised services
	@echo "==> Running integration + E2E tests"
	@$(COMPOSE) run --rm $(SERVICE) \
		python -m pytest $(INTEGRATION_PATH) \
		$(PYTEST_FLAGS)

.PHONY: test-coverage
test-coverage: check-docker reports-dir ## Run the suite and enforce the coverage gate from pyproject.toml
	@echo "==> Running suite with coverage (fail_under=75)"
	@$(COMPOSE) run --rm $(SERVICE) \
		python -m pytest tests \
		--cov=app \
		--cov-report=term-missing \
		--cov-report=xml:/app/reports/coverage.xml \
		$(PYTEST_FLAGS)

.PHONY: test-up
test-up: ## Start the test services and leave them running
	@$(COMPOSE) up -d db redis
	@echo "==> Test services are up (db, redis). Run 'make test' or 'make test-shell'."

.PHONY: test-down
test-down: ## Stop the test services and remove their volumes
	@$(COMPOSE) down --volumes --remove-orphans
	@echo "==> Test services stopped and volumes removed."

.PHONY: test-shell
test-shell: ## Open an interactive shell inside the test runner
	@$(COMPOSE) run --rm $(SERVICE) /bin/bash

.PHONY: test-logs
test-logs: ## Tail the test runner logs
	@$(COMPOSE) logs -f $(SERVICE)

.PHONY: test-ps
test-ps: ## Show the state of the test services
	@$(COMPOSE) ps

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

.PHONY: test-report
test-report: ## Print a short summary of the last run's artefacts
	@if [ -f reports/release-readiness.md ]; then \
		echo; echo "==> Release readiness report (reports/release-readiness.md)"; \
		cat reports/release-readiness.md; \
	fi
	@if [ -f reports/coverage.xml ]; then \
		echo; echo "==> Coverage XML written to reports/coverage.xml"; \
	fi

.PHONY: reports-dir
reports-dir: ## Ensure the host reports/ directory exists and is writable by the runner
	@mkdir -p reports
	@# The runner is non-root (uid 1000) and writes release-readiness reports
	@# through a bind mount, so the host directory must be group/other writable.
	@chmod 0777 reports 2>/dev/null || true

.PHONY: check-docker
check-docker: ## Verify Docker and the Compose plugin are available
	@command -v docker >/dev/null 2>&1 || { \
		echo "ERROR: 'docker' not found in PATH."; \
		echo "       Install Docker Desktop, or run the suite natively with:"; \
		echo "         pip install -r requirements.txt && python -m pytest tests"; \
		exit 1; \
	}
	@docker compose version >/dev/null 2>&1 || { \
		echo "ERROR: the Docker Compose plugin is unavailable."; \
		echo "       Upgrade Docker Desktop or install compose-plugin."; \
		exit 1; \
	}
	@echo "==> Docker and Compose are available."
