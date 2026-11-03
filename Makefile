ENV_FILE ?= .env

ifneq (,$(wildcard $(ENV_FILE)))
    include $(ENV_FILE)
    export $(shell sed 's/=.*//' $(ENV_FILE))
endif

COMPOSE = docker compose --env-file $(ENV_FILE)

.PHONY: all build rebuild up up-build down start stop restart re pause unpause \
        ps status logs logs-backend logs-frontend logs-db logs-nginx \
        logs-prometheus logs-grafana logs-node-exporter logs-postgres-exporter top \
        exec-backend exec-frontend exec-db exec-nginx exec-prometheus exec-grafana \
        images containers volumes networks prune \
        clean-data clean fclean check-env help


all: up

check-env:
	@if [ ! -f $(ENV_FILE) ]; then \
		echo "[Makefile] $(ENV_FILE) not found. Initializing from .env.example..."; \
		cp .env.example $(ENV_FILE); \
	fi

build: check-env
	@echo "[Makefile] Building service container images..."
	$(COMPOSE) build

rebuild: check-env
	@echo "[Makefile] Rebuilding service images from scratch (no cache)..."
	$(COMPOSE) build --no-cache

up: check-env
	@echo "[Makefile] Starting all Trenno services in background..."
	$(COMPOSE) up -d
	@echo ""
	@echo "=========================================================="
	@echo " Trenno is running securely over HTTPS!"
	@echo " Web Application : https://localhost:$(HTTPS_PORT)"
	@echo " Grafana Portal  : https://localhost:$(HTTPS_PORT)/grafana/"
	@echo " Prometheus UI   : https://localhost:$(HTTPS_PORT)/prometheus/"
	@echo "=========================================================="

up-build: check-env
	@echo "[Makefile] Building and starting all services in background..."
	$(COMPOSE) up --build -d
	@echo ""
	@echo "=========================================================="
	@echo " Trenno is running securely over HTTPS!"
	@echo " Web Application : https://localhost:$(HTTPS_PORT)"
	@echo " Grafana Portal  : https://localhost:$(HTTPS_PORT)/grafana/"
	@echo " Prometheus UI   : https://localhost:$(HTTPS_PORT)/prometheus/"
	@echo "=========================================================="

down: check-env
	@echo "[Makefile] Stopping and removing all containers and networks..."
	$(COMPOSE) down

start: check-env
	@echo "[Makefile] Starting existing stopped containers..."
	$(COMPOSE) start

stop: check-env
	@echo "[Makefile] Stopping running containers..."
	$(COMPOSE) stop

restart: check-env
	@echo "[Makefile] Restarting running containers..."
	$(COMPOSE) restart

re: down up

pause: check-env
	@echo "[Makefile] Pausing all containers..."
	$(COMPOSE) pause

unpause: check-env
	@echo "[Makefile] Unpausing all containers..."
	$(COMPOSE) unpause

ps: check-env
	$(COMPOSE) ps

status: ps

top: check-env
	$(COMPOSE) top

logs: check-env
	$(COMPOSE) logs -f

logs-backend: check-env
	$(COMPOSE) logs -f backend

logs-frontend: check-env
	$(COMPOSE) logs -f frontend

logs-db: check-env
	$(COMPOSE) logs -f db

logs-nginx: check-env
	$(COMPOSE) logs -f nginx

logs-prometheus: check-env
	$(COMPOSE) logs -f prometheus

logs-grafana: check-env
	$(COMPOSE) logs -f grafana

logs-node-exporter: check-env
	$(COMPOSE) logs -f node-exporter

logs-postgres-exporter: check-env
	$(COMPOSE) logs -f postgres-exporter

exec-backend: check-env
	$(COMPOSE) exec backend sh

exec-frontend: check-env
	$(COMPOSE) exec frontend sh

exec-db: check-env
	$(COMPOSE) exec db sh

exec-nginx: check-env
	$(COMPOSE) exec nginx sh

exec-prometheus: check-env
	$(COMPOSE) exec prometheus sh

exec-grafana: check-env
	$(COMPOSE) exec grafana sh

images:
	@echo "[Makefile] Docker images:"
	@docker images

containers:
	@echo "[Makefile] All Docker containers:"
	@docker ps -a

volumes:
	@echo "[Makefile] Docker volumes:"
	@docker volume ls

networks:
	@echo "[Makefile] Docker networks:"
	@docker network ls

prune:
	@echo "[Makefile] Pruning unused Docker system resources..."
	@docker system prune -af --volumes

clean: check-env
	@echo "[Makefile] Stopping containers and removing orphans..."
	$(COMPOSE) down --remove-orphans

clean-data: check-env
	@echo "[Makefile] Removing data volumes (db, uploads, certs, prometheus, grafana)..."
	@# Data lives in Docker named volumes now; down -v removes them while keeping images.
	$(COMPOSE) down -v --remove-orphans

fclean: clean
	@echo "[Makefile] Full teardown: removing images, volumes, and physical data..."
	$(COMPOSE) down -v --rmi all --remove-orphans
	$(MAKE) clean-data


help:
	@echo "Trenno Docker Management - Available Targets:"
	@echo ""
	@echo "Orchestration:"
	@echo "  make              - Ensure physical dirs and start services (default)"
	@echo "  make up           - Start services in background (-d)"
	@echo "  make up-build     - Rebuild and start services in background"
	@echo "  make down         - Stop and remove containers and network"
	@echo "  make start        - Start existing stopped containers"
	@echo "  make stop         - Stop running containers"
	@echo "  make restart      - Restart containers"
	@echo "  make re           - Down then up (restart stack)"
	@echo "  make pause        - Pause container execution"
	@echo "  make unpause      - Unpause container execution"
	@echo "  make build        - Build service images"
	@echo "  make rebuild      - Build service images without cache"
	@echo ""
	@echo "Monitoring & Logs:"
	@echo "  make ps / status  - List container statuses and health"
	@echo "  make top          - Display running processes in containers"
	@echo "  make logs         - Stream real-time logs for all services"
	@echo "  make logs-<svc>   - Stream logs for specific service (backend|frontend|db|nginx|prometheus|grafana|node-exporter|postgres-exporter)"
	@echo ""
	@echo "Interactive Shell:"
	@echo "  make exec-<svc>   - Open shell inside service (backend|frontend|db|nginx|prometheus|grafana)"
	@echo ""
	@echo "System & Inspection:"
	@echo "  make images       - List Docker images"
	@echo "  make containers   - List all Docker containers"
	@echo "  make volumes      - List Docker volumes"
	@echo "  make networks     - List Docker networks"
	@echo "  make prune        - Prune unused Docker images, containers, volumes"
	@echo ""
	@echo "Teardown:"
	@echo "  make clean        - Stop containers and remove orphans"
	@echo "  make clean-data   - Erase host physical volume data"
	@echo "  make fclean       - Remove containers, images, volumes, and physical data"
