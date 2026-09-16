#!/usr/bin/env bash
# tabyBot — install or update (Docker or local; Linux / macOS)
set -euo pipefail

INSTALLER_URL_DEFAULT="https://raw.githubusercontent.com/gpdir16/tabyBot/main/scripts/install.sh"

# curl | bash: stdin is the script pipe (EOF for read). Re-run from a temp file with stdin = terminal.
bootstrap_tty_installer() {
    if [ -n "${TABYBOT_INSTALL_REEXEC:-}" ]; then
        return 0
    fi
    if [ -t 0 ]; then
        return 0
    fi
    if [ ! -r /dev/tty ] 2>/dev/null; then
        echo "Error: This installer needs an interactive terminal." >&2
        exit 1
    fi
    local url="${TABYBOT_INSTALLER_URL:-${INSTALLER_URL_DEFAULT}}"
    local tmp
    tmp="$(mktemp -t tabybot-install.XXXXXX.sh)"
    chmod 700 "${tmp}"
    if ! curl -fsSL "${url}" -o "${tmp}"; then
        rm -f "${tmp}"
        echo "Error: Could not download installer (${url})" >&2
        exit 1
    fi
    exec env TABYBOT_INSTALL_REEXEC=1 bash "${tmp}" "$@" 0</dev/tty
}
bootstrap_tty_installer

REPO_OWNER="gpdir16"
IMAGE_DEFAULT="ghcr.io/${REPO_OWNER}/tabybot:latest"
REPO_URL="https://github.com/${REPO_OWNER}/tabyBot.git"
REPO_BRANCH="${TABYBOT_REPO_BRANCH:-main}"
INSTALL_DIR="${TABYBOT_HOME:-${HOME}/.tabybot}"
APP_DIR="${INSTALL_DIR}/app"
USER_DATA_DIR="${INSTALL_DIR}/user"
COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
ENV_FILE="${INSTALL_DIR}/.env"
LAUNCHD_LABEL="io.tabybot"
CAMOFOX_VERSION="${CAMOFOX_VERSION:-2.4.7}"

DOCKER_SHELL="docker"
TABYBOT_LANG_RESOLVED=""

resolve_lang() {
    if [ -n "${TABYBOT_LANG_RESOLVED}" ]; then
        return
    fi
    local lang="${TABYBOT_LANG:-}"
    if [ -z "${lang}" ]; then
        case "${LANG:-${LC_ALL:-}}" in
            ko*|KO*) lang=ko ;;
            *) lang=en ;;
        esac
    fi
    case "${lang}" in
        ko|ko_KR|korean) TABYBOT_LANG_RESOLVED=ko ;;
        *) TABYBOT_LANG_RESOLVED=en ;;
    esac
}

is_ko() {
    resolve_lang
    [ "${TABYBOT_LANG_RESOLVED}" = ko ]
}

usage() {
    cat <<EOF
Install or update tabyBot.

  curl -fsSL ${INSTALLER_URL_DEFAULT} | bash

Optional:
  TABYBOT_MODE=docker|local  (default: docker, or prompt on first install; set explicitly to switch on update)
Language: TABYBOT_LANG=ko|en  (default: en, or ko if LANG is Korean)
EOF
}

die() {
    if is_ko; then
        echo "오류: $*" >&2
    else
        echo "Error: $*" >&2
    fi
    exit 1
}

can_prompt_user() {
    [ -r /dev/tty ] 2>/dev/null || [ -t 0 ]
}

say_user() {
    if [ -w /dev/tty ] 2>/dev/null; then
        printf '%s\n' "$@" >/dev/tty
    else
        printf '%s\n' "$@"
    fi
}

read_user_line() {
    local __var_name="$1"
    local prompt="${2:-}"
    local line

    if [ -r /dev/tty ] 2>/dev/null; then
        [ -n "${prompt}" ] && printf '%s' "${prompt}" >/dev/tty
        IFS= read -r line </dev/tty
    elif [ -t 0 ]; then
        [ -n "${prompt}" ] && printf '%s' "${prompt}"
        IFS= read -r line
    else
        return 1
    fi
    printf -v "${__var_name}" '%s' "${line}"
}

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-y}"
    local hint reply

    if [ "${TABYBOT_AUTO_INSTALL_DOCKER:-}" = "1" ]; then
        return 0
    fi
    if ! can_prompt_user; then
        return 1
    fi

    if [ "${default}" = y ]; then hint="Y/n"; else hint="y/N"; fi

    while true; do
        if ! read_user_line reply "${prompt} [${hint}] "; then
            return 1
        fi
        reply="$(printf '%s' "${reply}" | tr '[:upper:]' '[:lower:]')"
        [ -z "${reply}" ] && reply="${default}"
        case "${reply}" in
            y|yes) return 0 ;;
            n|no) return 1 ;;
        esac
    done
}

docker_daemon_ok() {
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        DOCKER_SHELL="docker"
        return 0
    fi
    if command -v docker >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
        DOCKER_SHELL="sudo docker"
        return 0
    fi
    return 1
}

start_docker_daemon() {
    case "$(uname -s)" in
        Darwin)
            [ -d "/Applications/Docker.app" ] && open -a Docker >/dev/null 2>&1 || true
            ;;
        Linux)
            if command -v systemctl >/dev/null 2>&1; then
                if [ "$(id -u)" -eq 0 ]; then
                    systemctl start docker 2>/dev/null || true
                elif command -v sudo >/dev/null 2>&1; then
                    sudo systemctl start docker 2>/dev/null || true
                fi
            fi
            ;;
    esac
}

wait_for_docker() {
    local waited=0 max=180
    if is_ko; then echo "==> Docker가 준비될 때까지 기다리는 중..."; else echo "==> Waiting for Docker..."; fi
    while [ "${waited}" -lt "${max}" ]; do
        docker_daemon_ok && return 0
        sleep 3
        waited=$((waited + 3))
        [ $((waited % 15)) -eq 0 ] && start_docker_daemon
    done
    if is_ko; then
        die "Docker가 준비되지 않았습니다. Docker Desktop을 연 뒤 다시 실행하세요."
    else
        die "Docker is not ready. Start Docker Desktop, then run this installer again."
    fi
}

install_docker_linux() {
    if is_ko; then echo "==> Linux에 Docker 설치 중..."; else echo "==> Installing Docker on Linux..."; fi
    local script
    script="$(mktemp)"
    curl -fsSL https://get.docker.com -o "${script}"
    if [ "$(id -u)" -eq 0 ]; then
        sh "${script}"
    elif command -v sudo >/dev/null 2>&1; then
        sudo sh "${script}"
    else
        rm -f "${script}"
        die "sudo is required to install Docker."
    fi
    rm -f "${script}"
    if command -v systemctl >/dev/null 2>&1; then
        if [ "$(id -u)" -eq 0 ]; then systemctl enable --now docker 2>/dev/null || true
        else sudo systemctl enable --now docker 2>/dev/null || true; fi
    fi
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
        if ! id -nG "${USER}" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
            sudo usermod -aG docker "${USER}" 2>/dev/null || true
        fi
    fi
}

ensure_homebrew() {
    command -v brew >/dev/null 2>&1 && return 0
    if ! prompt_yes_no "$(if is_ko; then echo "Homebrew를 설치할까요?"; else echo "Install Homebrew now?"; fi)" y; then
        die "$(if is_ko; then echo "Docker Desktop을 설치한 뒤 다시 실행하세요."; else echo "Install Docker Desktop, then retry."; fi)"
    fi
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
    if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
    command -v brew >/dev/null 2>&1 || die "Homebrew not on PATH. Open a new terminal and retry."
}

install_docker_macos() {
    ensure_homebrew
    if is_ko; then echo "==> Docker Desktop 설치 중..."; else echo "==> Installing Docker Desktop..."; fi
    brew install --cask docker
    open -a Docker >/dev/null 2>&1 || true
}

install_docker_engine() {
    case "$(uname -s)" in
        Linux) install_docker_linux ;;
        Darwin) install_docker_macos ;;
        *) die "$(if is_ko; then echo "Linux/macOS만 지원합니다."; else echo "Linux and macOS only."; fi)" ;;
    esac
}

ensure_docker() {
    docker_daemon_ok && return 0
    if command -v docker >/dev/null 2>&1; then
        if is_ko; then echo "Docker가 꺼져 있습니다. 켜는 중..."; else echo "Docker is installed but not running. Starting..."; fi
        start_docker_daemon
        wait_for_docker && return 0
    fi
    if is_ko; then
        echo "Docker가 없습니다."
        prompt_text="지금 Docker를 설치할까요?"
    else
        echo "Docker is not installed."
        prompt_text="Install Docker now?"
    fi
    prompt_yes_no "${prompt_text}" y || die "$(if is_ko; then echo "Docker가 필요합니다."; else echo "Docker is required."; fi)"
    install_docker_engine
    wait_for_docker
}

compose_cmd() {
    if ${DOCKER_SHELL} compose version >/dev/null 2>&1; then
        echo "${DOCKER_SHELL} compose"
    elif command -v docker-compose >/dev/null 2>&1; then
        [ "${DOCKER_SHELL}" = "sudo docker" ] && echo "sudo docker-compose" || echo "docker-compose"
    else
        die "$(if is_ko; then echo "Docker Compose를 찾을 수 없습니다."; else echo "Docker Compose not found."; fi)"
    fi
}

is_installed() {
    [ -f "${ENV_FILE}" ] && return 0
    [ -f "${COMPOSE_FILE}" ] && return 0
    return 1
}

read_install_mode() {
    if [ -f "${ENV_FILE}" ]; then
        local mode
        mode="$(grep '^TABYBOT_MODE=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2-)"
        mode="$(strip_env_scalar "${mode}" | tr '[:upper:]' '[:lower:]')"
        case "${mode}" in
            docker|local) printf '%s' "${mode}"; return 0 ;;
        esac
    fi
    if [ -f "${COMPOSE_FILE}" ]; then
        printf 'docker'
        return 0
    fi
    if [ -d "${APP_DIR}/codes" ]; then
        printf 'local'
        return 0
    fi
    return 1
}

prompt_install_mode() {
    local reply

    if ! can_prompt_user; then
        printf 'docker'
        return 0
    fi

    say_user ""
    if is_ko; then
        say_user "실행 방식 선택"
        say_user "  1) Docker (권장) — 컨테이너에서 격리 실행"
        say_user "  2) 로컬 — Node.js로 PC에서 직접 실행 (Docker 불필요)"
        read_user_line reply "선택 [1/2] (기본 1): " || { printf 'docker'; return 0; }
    else
        say_user ""
        say_user "Choose runtime"
        say_user "  1) Docker (recommended) — isolated container"
        say_user "  2) Local — run Node.js directly on your machine (no Docker)"
        read_user_line reply "Choice [1/2] (default 1): " || { printf 'docker'; return 0; }
    fi

    reply="$(printf '%s' "${reply}" | tr '[:upper:]' '[:lower:]')"
    case "${reply}" in
        2|local|l) printf 'local' ;;
        *) printf 'docker' ;;
    esac
}

resolve_install_mode() {
    local updating="$1" mode="${TABYBOT_MODE:-}"

    mode="$(printf '%s' "${mode}" | tr '[:upper:]' '[:lower:]')"
    case "${mode}" in
        docker|local) printf '%s' "${mode}"; return 0 ;;
    esac

    if [ "${updating}" = true ]; then
        mode="$(read_install_mode)" || die "$(if is_ko; then echo "설치 정보를 찾을 수 없습니다."; else echo "Install metadata not found."; fi)"
        printf '%s' "${mode}"
        return 0
    fi

    prompt_install_mode
}

stop_docker_runtime() {
    local compose
    [ -f "${COMPOSE_FILE}" ] || return 0
    docker_daemon_ok || return 0
    compose="$(compose_cmd)"
    (cd "${INSTALL_DIR}" && ${compose} -f "${COMPOSE_FILE}" down 2>/dev/null) || true
}

regex_escape() {
    printf '%s' "$1" | sed 's/[][\\.*^$()+?{|}]/\\&/g'
}

stop_local_runtime() {
    local index_pattern
    index_pattern="$(regex_escape "${APP_DIR}/codes/index.js")"
    case "$(uname -s)" in
        Darwin)
            launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
            ;;
        Linux)
            systemctl --user stop tabybot.service 2>/dev/null || true
            ;;
    esac
    pkill -f "${index_pattern}" 2>/dev/null || true
}

uninstall_local_service() {
    stop_local_runtime
    case "$(uname -s)" in
        Darwin)
            rm -f "${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
            ;;
        Linux)
            if command -v systemctl >/dev/null 2>&1; then
                systemctl --user disable --now tabybot.service 2>/dev/null || true
                rm -f "${HOME}/.config/systemd/user/tabybot.service"
                systemctl --user daemon-reload 2>/dev/null || true
            fi
            ;;
    esac
}

prepare_mode_switch() {
    local from="$1" to="$2"
    [ "${from}" = "${to}" ] && return 0
    if is_ko; then echo "==> 실행 방식 변경: ${from} → ${to}"; else echo "==> Switching runtime: ${from} → ${to}"; fi
    if is_ko; then
        echo "  참고: Docker와 로컬은 사용자 데이터 위치가 다릅니다 (Docker volume vs ${USER_DATA_DIR})."
    else
        echo "  Note: Docker and local use different data locations (Docker volume vs ${USER_DATA_DIR})."
    fi
    stop_docker_runtime
    if [ "${from}" = "local" ] && [ "${to}" = "docker" ]; then
        uninstall_local_service
    else
        stop_local_runtime
        rm -f "${COMPOSE_FILE}"
    fi
}

ensure_systemd_linger() {
    [ "$(uname -s)" = Linux ] || return 0
    command -v loginctl >/dev/null 2>&1 || return 0
    if loginctl show-user "${USER}" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
        return 0
    fi
    if is_ko; then echo "==> 재부팅·로그아웃 후에도 실행되도록 linger 설정 중..."; else echo "==> Enabling systemd linger for reboot/logout survival..."; fi
    loginctl enable-linger "${USER}" 2>/dev/null || {
        if is_ko; then
            echo "⚠ linger 설정 실패 — 로그아웃 후 서비스가 중지될 수 있습니다: sudo loginctl enable-linger ${USER}"
        else
            echo "⚠ Could not enable linger — service may stop after logout: sudo loginctl enable-linger ${USER}"
        fi
    }
}

verify_install() {
    local mode="$1"
    local index_pattern
    sleep 2
    index_pattern="$(regex_escape "${APP_DIR}/codes/index.js")"
    if [ "${mode}" = local ]; then
        case "$(uname -s)" in
            Darwin)
                launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1 && return 0
                ;;
            Linux)
                systemctl --user is-active --quiet tabybot.service 2>/dev/null && return 0
                ;;
        esac
        if pgrep -f "${index_pattern}" >/dev/null 2>&1; then
            return 0
        fi
    else
        if docker_daemon_ok && ${DOCKER_SHELL} ps --filter name=tabybot --format '{{.Names}}' 2>/dev/null | grep -qx tabybot; then
            return 0
        fi
    fi
    if is_ko; then
        echo "⚠ tabyBot가 아직 실행 중이 아닐 수 있습니다. 로그: ${INSTALL_DIR}/logs/"
        [ -f "${INSTALL_DIR}/logs/stderr.log" ] && tail -n 5 "${INSTALL_DIR}/logs/stderr.log" 2>/dev/null || true
    else
        echo "⚠ tabyBot may not be running yet. Logs: ${INSTALL_DIR}/logs/"
        [ -f "${INSTALL_DIR}/logs/stderr.log" ] && tail -n 5 "${INSTALL_DIR}/logs/stderr.log" 2>/dev/null || true
    fi
    return 1
}

trim_path() {
    local p="$1"
    p="${p#"${p%%[![:space:]]*}"}"
    p="${p%"${p##*[![:space:]]}"}"
    printf '%s' "${p}"
}

strip_env_scalar() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [ "${value#\"}" != "${value}" ] && [ "${value%\"}" != "${value}" ]; then
        value="${value#\"}"
        value="${value%\"}"
    elif [ "${value#\'}" != "${value}" ] && [ "${value%\'}" != "${value}" ]; then
        value="${value#\'}"
        value="${value%\'}"
    fi
    printf '%s' "${value}"
}

expand_user_path() {
    local p
    p="$(trim_path "$1")"
    case "${p}" in
        "~") printf '%s' "${HOME}" ;;
        "~/"*) printf '%s' "${HOME}/${p#~/}" ;;
        *) printf '%s' "${p}" ;;
    esac
}


write_compose() {
    local image="$1"
    local install_dir_escaped
    install_dir_escaped="$(yaml_escape_double "${INSTALL_DIR}")"
    mkdir -p "${INSTALL_DIR}"
    cat >"${COMPOSE_FILE}" <<EOF
services:
    tabybot:
        image: ${image}
        container_name: tabybot
        environment:
            TABYBOT_WEB_TOKEN: \${TABYBOT_WEB_TOKEN:-}
            TABYBOT_MODE: docker
            TABYBOT_HOME: "${install_dir_escaped}"
            TABYBOT_DOCKER_SHELL: \${TABYBOT_DOCKER_SHELL:-docker}
            TABYBOT_PORT: \${TABYBOT_PORT:-8999}
            CAMOFOX_HOST: 127.0.0.1
            CAMOFOX_PORT: 9377
            CAMOFOX_AUTH_MODE: disabled
            CAMOFOX_HEADLESS: "false"
            CAMOFOX_HUMANIZE: "true"
            CAMOFOX_PROFILES_DIR: /app/user/camofox/profiles
            CAMOFOX_COOKIES_DIR: /app/user/camofox/cookies
            CAMOFOX_DOWNLOADS_DIR: /app/user/camofox/downloads
            CAMOFOX_TRACES_DIR: /app/user/camofox/traces
        volumes:
            - tabybot-user:/app/user
        restart: unless-stopped
        ports:
            - "\${TABYBOT_PORT:-8999}:8999"

volumes:
    tabybot-user:
EOF
}

write_env_quoted() {
    local key="$1" value="$2"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//\$/\\$}"
    printf '%s="%s"\n' "${key}" "${value}"
}

yaml_escape_double() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '%s' "${value}"
}

write_local_version() {
    [ -d "${APP_DIR}/.git" ] || return 0
    local version
    version="$(git -C "${APP_DIR}" describe --tags --always --dirty 2>/dev/null || true)"
    [ -n "${version}" ] || return 0
    printf '%s\n' "${version}" >"${APP_DIR}/VERSION"
}

write_env() {
    local mode="${1:-docker}"
    local version=""
    local existing_web_token="" existing_port=""
    umask 077
    if [ -f "${ENV_FILE}" ]; then
        existing_web_token="$(grep '^TABYBOT_WEB_TOKEN=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2-)"
        existing_web_token="$(strip_env_scalar "${existing_web_token}")"
        existing_port="$(grep '^TABYBOT_PORT=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2-)"
        existing_port="$(strip_env_scalar "${existing_port}")"
    fi
    if [ -n "${TABYBOT_WEB_TOKEN:-}" ]; then
        existing_web_token="${TABYBOT_WEB_TOKEN}"
    fi
    if [ -n "${TABYBOT_PORT:-}" ]; then
        existing_port="${TABYBOT_PORT}"
    fi
    if [ "${mode}" = local ] && [ -f "${APP_DIR}/VERSION" ]; then
        version="$(tr -d '\n' <"${APP_DIR}/VERSION")"
    elif [ "${mode}" = local ] && [ -f "${ENV_FILE}" ]; then
        version="$(grep '^TABYBOT_VERSION=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2-)"
        version="$(strip_env_scalar "${version}")"
    fi
    {
        printf 'TABYBOT_MODE=%s\n' "${mode}"
        if [ "${mode}" = docker ]; then
            write_env_quoted TABYBOT_DOCKER_SHELL "${DOCKER_SHELL}"
            write_env_quoted TABYBOT_HOME "${INSTALL_DIR}"
        fi
        if [ "${mode}" = local ]; then
            write_env_quoted TABYBOT_HOME "${INSTALL_DIR}"
            write_env_quoted APP_ROOT "${APP_DIR}"
            write_env_quoted USER_DIR "${USER_DATA_DIR}"
            write_env_quoted CODES_DIR "${APP_DIR}/codes"
            write_env_quoted CONFIG_DIR "${APP_DIR}/codes/config"
            write_env_quoted TABYBOT_NODE "$(resolve_node_bin)"
            write_env_quoted CAMOFOX_HOST "127.0.0.1"
            write_env_quoted CAMOFOX_PORT "9377"
            write_env_quoted CAMOFOX_AUTH_MODE "disabled"
            write_env_quoted CAMOFOX_HEADLESS "true"
            write_env_quoted CAMOFOX_HUMANIZE "true"
            write_env_quoted CAMOFOX_PROFILES_DIR "${USER_DATA_DIR}/camofox/profiles"
            write_env_quoted CAMOFOX_COOKIES_DIR "${USER_DATA_DIR}/camofox/cookies"
            write_env_quoted CAMOFOX_DOWNLOADS_DIR "${USER_DATA_DIR}/camofox/downloads"
            write_env_quoted CAMOFOX_TRACES_DIR "${USER_DATA_DIR}/camofox/traces"
            write_env_quoted PATH "$(npm prefix -g)/bin:${PATH}"
            if [ -n "${version}" ]; then
                printf 'TABYBOT_VERSION=%s\n' "${version}"
            fi
        fi
        if [ -n "${existing_web_token}" ]; then
            write_env_quoted TABYBOT_WEB_TOKEN "${existing_web_token}"
        fi
        if [ -n "${existing_port}" ]; then
            printf 'TABYBOT_PORT=%s\n' "${existing_port}"
        fi
    } >"${ENV_FILE}"
    chmod 600 "${ENV_FILE}"
}

pull_image() {
    local compose="$1" image="$2"
    local attempt=1 max_attempts=3

    if is_ko; then echo "==> 설치 파일 받는 중..."; else echo "==> Downloading tabyBot..."; fi

    while [ "${attempt}" -le "${max_attempts}" ]; do
        if ${compose} -f "${COMPOSE_FILE}" pull 2>/dev/null; then
            return 0
        fi
        if [ "${attempt}" -lt "${max_attempts}" ]; then
            if is_ko; then echo "    다시 시도 중 (${attempt}/${max_attempts})..."; else echo "    Retrying (${attempt}/${max_attempts})..."; fi
            sleep 5
        fi
        attempt=$((attempt + 1))
    done

    if ${DOCKER_SHELL} image inspect "${image}" >/dev/null 2>&1; then
        if is_ko; then echo "    (이미 받아 둔 파일 사용)"; else echo "    (using cached copy)"; fi
        return 0
    fi

    if is_ko; then
        die "설치 파일을 받지 못했습니다.
· Wi‑Fi/인터넷 연결을 확인하세요.
· Docker Desktop이 켜져 있는지 확인하세요.
· 1~2분 뒤 같은 설치 명령을 다시 실행해 보세요.
· 계속 안 되면: https://github.com/gpdir16/tabyBot/issues"
    else
        die "Could not download tabyBot.
· Check your internet connection.
· Make sure Docker Desktop is running.
· Run the same install command again in a minute or two.
· Still stuck? https://github.com/gpdir16/tabyBot/issues"
    fi
}

ensure_node() {
    local node_ver major

    if ! command -v node >/dev/null 2>&1; then
        if is_ko; then
            die "Node.js 22 이상이 필요합니다. https://nodejs.org 에서 설치하거나 TABYBOT_MODE=docker 로 Docker 설치를 선택하세요."
        else
            die "Node.js 22+ is required. Install from https://nodejs.org or choose Docker with TABYBOT_MODE=docker."
        fi
    fi

    node_ver="$(node -p 'process.versions.node' 2>/dev/null || true)"
    major="${node_ver%%.*}"
    if [ -z "${major}" ] || [ "${major}" -lt 22 ] 2>/dev/null; then
        if is_ko; then die "Node.js 22 이상이 필요합니다. 현재: ${node_ver:-unknown}"
        else die "Node.js 22+ required. Found: ${node_ver:-unknown}"; fi
    fi

    command -v npm >/dev/null 2>&1 || die "$(if is_ko; then echo "npm이 필요합니다."; else echo "npm is required."; fi)"
}

resolve_node_bin() {
    local node_bin
    node_bin="$(command -v node)"
    [ -n "${node_bin}" ] || die "$(if is_ko; then echo "node 실행 파일을 찾을 수 없습니다."; else echo "node executable not found."; fi)"
    printf '%s' "${node_bin}"
}

download_source_tarball() {
    local url tmp extracted
    url="https://github.com/${REPO_OWNER}/tabyBot/archive/refs/heads/${REPO_BRANCH}.tar.gz"
    tmp="$(mktemp -t tabybot-src.XXXXXX.tar.gz)"
    if is_ko; then echo "==> 소스 코드 받는 중..."; else echo "==> Downloading source..."; fi
    curl -fsSL "${url}" -o "${tmp}"
    rm -rf "${APP_DIR}"
    mkdir -p "${INSTALL_DIR}"
    tar -xzf "${tmp}" -C "${INSTALL_DIR}"
    rm -f "${tmp}"
    extracted="$(find "${INSTALL_DIR}" -maxdepth 1 -mindepth 1 -type d -name 'tabyBot-*' | head -1)"
    [ -n "${extracted}" ] || die "$(if is_ko; then echo "소스 압축 해제에 실패했습니다."; else echo "Failed to extract source archive."; fi)"
    mv "${extracted}" "${APP_DIR}"
}

update_local_source() {
    if [ -d "${APP_DIR}/.git" ] && command -v git >/dev/null 2>&1; then
        if is_ko; then echo "==> 소스 코드 업데이트 중..."; else echo "==> Updating source..."; fi
        git -C "${APP_DIR}" fetch origin "${REPO_BRANCH}" 2>/dev/null || git -C "${APP_DIR}" fetch origin 2>/dev/null || true
        git -C "${APP_DIR}" reset --hard "origin/${REPO_BRANCH}" 2>/dev/null \
            || git -C "${APP_DIR}" reset --hard "origin/main" 2>/dev/null \
            || git -C "${APP_DIR}" pull --ff-only 2>/dev/null \
            || download_source_tarball
        return 0
    fi

    if [ -d "${APP_DIR}/codes" ]; then
        download_source_tarball
        return 0
    fi

    if command -v git >/dev/null 2>&1; then
        if is_ko; then echo "==> 저장소 클론 중..."; else echo "==> Cloning repository..."; fi
        rm -rf "${APP_DIR}"
        git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${APP_DIR}" 2>/dev/null \
            || git clone --depth 1 "${REPO_URL}" "${APP_DIR}"
        return 0
    fi

    download_source_tarball
}

install_local_deps() {
    if is_ko; then echo "==> Node.js 패키지 설치 중..."; else echo "==> Installing Node.js packages..."; fi
    (cd "${APP_DIR}" && npm install --omit=dev)

    if is_ko; then echo "==> CamoFox 스텔스 브라우저 설치 중..."; else echo "==> Installing CamoFox stealth browser..."; fi
    npm install --global "camofox-browser@${CAMOFOX_VERSION}"
}

install_launchd_service() {
    local plist="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
    local node_bin
    node_bin="$(resolve_node_bin)"
    mkdir -p "${INSTALL_DIR}/logs" "${HOME}/Library/LaunchAgents"
    cat >"${plist}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>set -a; . "$1"; exec "$2" "$3"</string>
        <string>tabybot</string>
        <string>${ENV_FILE}</string>
        <string>${node_bin}</string>
        <string>${APP_DIR}/codes/index.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
        <key>TABYBOT_NODE</key>
        <string>${node_bin}</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${APP_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${INSTALL_DIR}/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/logs/stderr.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
    if ! launchctl bootstrap "gui/$(id -u)" "${plist}" 2>/dev/null; then
        launchctl load "${plist}" 2>/dev/null || die "$(if is_ko; then echo "백그라운드 서비스 등록 실패. 로그: ${INSTALL_DIR}/logs/"; else echo "Failed to register background service. Logs: ${INSTALL_DIR}/logs/"; fi)"
    fi
    launchctl enable "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
    launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
}

install_systemd_user_service() {
    local unit_dir="${HOME}/.config/systemd/user"
    local unit_file="${unit_dir}/tabybot.service"
    local env_file_line="EnvironmentFile=${ENV_FILE}"
    local node_bin="$(resolve_node_bin)"
    local exec_start_line="ExecStart=${node_bin} ${APP_DIR}/codes/index.js"
    local workdir_line="WorkingDirectory=${APP_DIR}"
    if [[ "${ENV_FILE}" == *" "* ]]; then
        env_file_line="EnvironmentFile=\"${ENV_FILE}\""
    fi
    if [[ "${APP_DIR}" == *" "* ]]; then
        exec_start_line="ExecStart=${node_bin} \"${APP_DIR}/codes/index.js\""
        workdir_line="WorkingDirectory=\"${APP_DIR}\""
    fi
    mkdir -p "${unit_dir}" "${INSTALL_DIR}/logs"
    cat >"${unit_file}" <<EOF
[Unit]
Description=tabyBot agent
After=network-online.target

[Service]
Type=simple
${env_file_line}
${exec_start_line}
${workdir_line}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now tabybot.service
}

install_local_service() {
    case "$(uname -s)" in
        Darwin) install_launchd_service ;;
        Linux)
            if command -v systemctl >/dev/null 2>&1; then
                install_systemd_user_service
            else
                die "$(if is_ko; then echo "systemd가 필요합니다. Linux에서는 systemd 사용자 서비스를 지원합니다."; else echo "systemd is required for local install on Linux."; fi)"
            fi
            ;;
        *) die "$(if is_ko; then echo "Linux/macOS만 지원합니다."; else echo "Linux and macOS only."; fi)" ;;
    esac
}

install_local() {
    local updating="$1"

    ensure_node
    mkdir -p "${INSTALL_DIR}" "${USER_DATA_DIR}"
    stop_local_runtime
    stop_docker_runtime
    update_local_source
    write_local_version
    install_local_deps
    write_env local
    if is_ko; then echo "==> 실행 중..."; else echo "==> Starting..."; fi
    install_local_service
    ensure_systemd_linger
    verify_install local || true
}

deploy_tabybot_docker() {
    local image="$1" updating="$2" compose

    stop_local_runtime
    ensure_docker
    compose="$(compose_cmd)"
    write_compose "${image}"
    write_env docker
    cd "${INSTALL_DIR}"
    pull_image "${compose}" "${image}"
    if is_ko; then echo "==> 실행 중..."; else echo "==> Starting..."; fi
    ${compose} -f "${COMPOSE_FILE}" up -d
    verify_install docker || true
}

main() {
    resolve_lang
    local image="${TABYBOT_IMAGE:-${IMAGE_DEFAULT}}"

    if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
        usage
        exit 0
    fi

    local updating=false
    if is_installed; then
        updating=true
        if is_ko; then echo "==> tabyBot 업데이트 중..."; else echo "==> Updating tabyBot..."; fi
    else
        if is_ko; then echo "==> tabyBot 설치 중..."; else echo "==> Installing tabyBot..."; fi
    fi

    local mode old_mode=""
    mode="$(resolve_install_mode "${updating}")"

    if [ "${updating}" = true ]; then
        old_mode="$(read_install_mode 2>/dev/null)" || old_mode=""
        if [ -n "${old_mode}" ] && [ "${old_mode}" != "${mode}" ]; then
            prepare_mode_switch "${old_mode}" "${mode}"
        fi
    fi

    if [ "${mode}" = local ]; then
        install_local "${updating}"
    else
        deploy_tabybot_docker "${image}" "${updating}"
    fi

    echo ""
    if [ "${updating}" = true ]; then
        if is_ko; then echo "완료. tabyBot 실행 중 (${mode})."; else echo "Done. tabyBot is running (${mode})."; fi
    else
        if is_ko; then
            echo "설치 완료 (${mode}). 브라우저에서 http://localhost:8999 를 여세요."
        else
            echo "Install complete (${mode}). Open http://localhost:8999 in your browser."
        fi
    fi
}

main "$@"
