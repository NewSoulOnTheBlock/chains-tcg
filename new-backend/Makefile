# Chains TCG secure backend
.DEFAULT_GOAL := help
SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: help env install build typecheck up up-auth down clean logs ps migrate migrate-status psql redis-cli smoke config

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

env: ## Create .env from .env.example with freshly generated secrets
	@if [ -f .env ]; then echo ".env already exists — refusing to overwrite"; exit 1; fi
	@cp .env.example .env
	@JWT=$$(openssl rand -hex 32); \
	 PGPW=$$(openssl rand -base64 24 | tr -d '=+/'); \
	 HMAC=$$(openssl rand -hex 32); \
	 sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=$$JWT|; \
	             s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$$PGPW|; \
	             s|^MATCH_RESULT_HMAC_SECRET=.*|MATCH_RESULT_HMAC_SECRET=$$HMAC|" .env && rm -f .env.bak
	@echo "Wrote .env with generated secrets. It is gitignored — keep it that way."

install: ## Install workspace dependencies
	npm install --no-audit --no-fund

build: ## Build @chains/shared then every service
	npm run build --workspace @chains/shared
	npm run build --workspaces --if-present

typecheck: ## tsc --noEmit across every workspace (shared is built first)
	npm run build --workspace @chains/shared
	npm run typecheck --workspaces --if-present

config: ## Validate docker-compose.yml
	$(COMPOSE) config -q && echo "docker-compose.yml OK"

up: ## Build and start the whole stack (gateway on :8080)
	$(COMPOSE) up --build -d

up-auth: ## Start only postgres, redis, migrate and auth
	$(COMPOSE) up -d --build postgres redis migrate auth

down: ## Stop everything, keep volumes
	$(COMPOSE) down --remove-orphans

clean: ## Stop everything and delete volumes (destroys the database)
	$(COMPOSE) down -v --remove-orphans

logs: ## Tail logs
	$(COMPOSE) logs -f --tail=100

ps: ## Show container status
	$(COMPOSE) ps

migrate: ## Apply pending migrations
	$(COMPOSE) run --rm migrate

migrate-status: ## Show applied/pending migrations
	$(COMPOSE) run --rm migrate node migrate.mjs --status

psql: ## Open a psql shell on the compose database
	$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-chains} -d $${POSTGRES_DB:-chains}

redis-cli: ## Open a redis-cli shell
	$(COMPOSE) exec redis redis-cli

smoke: ## Run the end-to-end auth flow against a running auth service
	node scripts/smoke-auth.mjs
