#!/usr/bin/env sh
# =============================================================================
# Rorca Installer — curl -fsSL https://get.rorca.app/install.sh | sh
# =============================================================================
# Installs Rorca globally via npm. Requires Node.js 20+.
# Falls back to Docker-based install if Node.js is unavailable.
# =============================================================================
set -e

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

# ─── Branding ────────────────────────────────────────────────────────────────
echo ""
echo "${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo "${CYAN}║${RESET}  ${BOLD}Rorca — AI Spec Orchestration${RESET}                         ${CYAN}║${RESET}"
echo "${CYAN}║${RESET}  Turn plain-English briefs into executed code.          ${CYAN}║${RESET}"
echo "${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""

# ─── Command-line arguments ──────────────────────────────────────────────────
METHOD="auto"   # auto | npm | docker
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --npm)     METHOD="npm" ;;
        --docker)  METHOD="docker" ;;
        --dry-run) DRY_RUN=true ;;
        --help|-h)
            echo "Usage: curl -fsSL https://get.rorca.app/install.sh | sh [--npm|--docker]"
            echo ""
            echo "Options:"
            echo "  --npm      Force npm global install"
            echo "  --docker   Force Docker-based install"
            echo "  --dry-run  Show what would be installed without doing it"
            exit 0
            ;;
    esac
done

# ─── OS detection ────────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
    Linux)   OS_LABEL="Linux" ;;
    Darwin)  OS_LABEL="macOS" ;;
    MINGW*|MSYS*|CYGWIN*) OS_LABEL="Windows" ;;
    *)       OS_LABEL="$OS" ;;
esac
echo "${BOLD}Detected:${RESET} ${OS_LABEL}"

# ─── Check Node.js ───────────────────────────────────────────────────────────
have_node() {
    command -v node >/dev/null 2>&1 || return 1
    NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
    [ "$NODE_VERSION" -ge 20 ] 2>/dev/null
}

have_npm() {
    command -v npm >/dev/null 2>&1
}

have_docker() {
    command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

# ─── npm install path ────────────────────────────────────────────────────────
install_npm() {
    if ! have_node; then
        echo "${RED}✖ Node.js 20+ is required for npm install.${RESET}"
        echo ""
        echo "  Install Node.js: ${CYAN}https://nodejs.org${RESET}"
        echo "  Or use Docker:    ${CYAN}curl -fsSL https://get.rorca.app/install.sh | sh --docker${RESET}"
        exit 1
    fi

    if ! have_npm; then
        echo "${RED}✖ npm not found. Please install Node.js 20+ from https://nodejs.org${RESET}"
        exit 1
    fi

    echo ""
    echo "${BOLD}Installing Rorca globally via npm...${RESET}"
    echo ""

    if [ "$DRY_RUN" = true ]; then
        echo "  ${YELLOW}[dry-run]${RESET} Would run: npm install -g rorca"
        echo ""
        echo "${GREEN}✓ Dry run complete. Rorca would be installed.${RESET}"
        exit 0
    fi

    npm install -g rorca

    echo ""
    echo "${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}"
    echo "${GREEN}║${RESET}  ${BOLD}Rorca installed successfully!${RESET}                       ${GREEN}║${RESET}"
    echo "${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}"
    echo ""
    echo "  ${BOLD}Quick start:${RESET}"
    echo "    rorca start"
    echo ""
    echo "  This will:"
    echo "    • Auto-detect or start a PostgreSQL database"
    echo "    • Launch the Rorca dashboard at ${CYAN}http://localhost:5210${RESET}"
    echo ""
    echo "  ${BOLD}More commands:${RESET}"
    echo "    rorca --help"
    echo "    rorca doctor       # Health check"
    echo "    rorca tui          # Terminal UI"
    echo "    rorca forge \"<brief>\"  # Create a spec from a brief"
    echo ""
}

# ─── Docker install path ─────────────────────────────────────────────────────
install_docker() {
    if ! have_docker; then
        echo "${RED}✖ Docker is required but not running.${RESET}"
        echo "  Install Docker Desktop: ${CYAN}https://docker.com${RESET}"
        echo "  Or use npm:             ${CYAN}curl -fsSL https://get.rorca.app/install.sh | sh --npm${RESET}"
        exit 1
    fi

    echo ""
    echo "${BOLD}Installing Rorca via Docker...${RESET}"
    echo ""

    if [ "$DRY_RUN" = true ]; then
        echo "  ${YELLOW}[dry-run]${RESET} Would pull and run getrorca/rorca container"
        echo ""
        echo "${GREEN}✓ Dry run complete. Rorca would be installed via Docker.${RESET}"
        exit 0
    fi

    # Pull the image
    echo "  Pulling Rorca Docker image..."
    docker pull getrorca/rorca:latest

    echo ""
    echo "  Starting Rorca..."
    docker run -d \
        --name rorca \
        -p 5210:5210 \
        -p 3030:3030 \
        -v rorca-data:/data \
        -e DATABASE_URL=postgres://rorca:rorca@localhost:5432/rorca \
        --restart unless-stopped \
        getrorca/rorca:latest

    echo ""
    echo "${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}"
    echo "${GREEN}║${RESET}  ${BOLD}Rorca is running in Docker!${RESET}                        ${GREEN}║${RESET}"
    echo "${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}"
    echo ""
    echo "  Dashboard: ${CYAN}http://localhost:5210${RESET}"
    echo "  API:       ${CYAN}http://localhost:3030${RESET}"
    echo ""
    echo "  ${BOLD}Manage:${RESET}"
    echo "    docker logs rorca     # View logs"
    echo "    docker stop rorca     # Stop"
    echo "    docker start rorca    # Start again"
    echo ""
}

# ─── Helm install path ───────────────────────────────────────────────────────
install_helm() {
    echo ""
    echo "${BOLD}Installing Rorca via Helm...${RESET}"
    echo ""

    if [ "$DRY_RUN" = true ]; then
        echo "  ${YELLOW}[dry-run]${RESET} Would run: helm install rorca oci://ghcr.io/getrorca/helm/rorca"
        echo ""
        echo "${GREEN}✓ Dry run complete. Helm command shown above.${RESET}"
        exit 0
    fi

    echo "  ${BOLD}Helm install:${RESET}"
    echo ""
    echo "    helm repo add rorca https://getrorca.github.io/helm-charts"
    echo "    helm install rorca rorca/rorca \\"
    echo "      --set ingress.host=rorca.example.com \\"
    echo "      --set postgresql.auth.password=your-password"
    echo ""
    echo "  Or from OCI registry:"
    echo "    helm install rorca oci://ghcr.io/getrorca/helm/rorca \\"
    echo "      --set ingress.host=rorca.example.com"
    echo ""
    echo "  See ${CYAN}helm/rorca/values.yaml${RESET} for all options."
    echo ""
}

# ─── Main dispatch ───────────────────────────────────────────────────────────
if [ "$METHOD" = "npm" ]; then
    install_npm
elif [ "$METHOD" = "docker" ]; then
    install_docker
elif [ "$METHOD" = "helm" ]; then
    install_helm
else
    # Auto-detect best method: prefer npm if Node.js is available
    if have_node && have_npm; then
        install_npm
    elif have_docker; then
        echo "${YELLOW}Node.js 20+ not found. Falling back to Docker install.${RESET}"
        install_docker
    else
        echo "${RED}✖ Neither Node.js 20+ nor Docker found.${RESET}"
        echo ""
        echo "  ${BOLD}Choose an install method:${RESET}"
        echo ""
        echo "  ${CYAN}npm${RESET} (recommended):"
        echo "    Install Node.js 20+ from https://nodejs.org"
        echo "    Then: npm install -g rorca"
        echo ""
        echo "  ${CYAN}Docker${RESET}:"
        echo "    Install Docker from https://docker.com"
        echo "    Then: curl -fsSL https://get.rorca.app/install.sh | sh --docker"
        echo ""
        echo "  ${CYAN}Helm${RESET} (Kubernetes):"
        echo "    See https://github.com/getrorca/rorca/tree/main/helm/rorca"
        echo ""
        exit 1
    fi
fi

echo ""
echo "${BOLD}📚 Docs:${RESET}  https://github.com/getrorca/rorca"
echo "${BOLD}💬 Community:${RESET} https://github.com/getrorca/rorca/discussions"
echo ""
