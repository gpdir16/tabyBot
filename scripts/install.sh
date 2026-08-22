#!/usr/bin/env bash
# tabyAgent — install or update (Docker or local; Linux / macOS)
set -euo pipefail

INSTALLER_URL_DEFAULT="https://raw.githubusercontent.com/gpdir16/tabyAgent/main/scripts/install.sh"

# curl | bash: stdin is the script pipe (EOF for read). Re-run from a temp file with stdin = terminal.
bootstrap_tty_installer() {
    if [ -n "${TABYAGENT_INSTALL_REEXEC:-}" ]; then
        return 0
    fi
    if [ -t 0 ]; then
        return 0
    fi
    # Piped install with token already set — no interactive stdin needed
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || [ -n "${1:-}" ]; then
        return 0
    fi
    if [ ! -r /dev/tty ] 2>/dev/null; then
        echo "Error: This installer needs an interactive terminal." >&2
        echo "  TELEGRAM_BOT_TOKEN='your-token' curl -fsSL ${INSTALLER_URL_DEFAULT} | bash" >&2
        exit 1
    fi
    local url="${TABYAGENT_INSTALLER_URL:-${INSTALLER_URL_DEFAULT}}"
    local tmp
    tmp="$(mktemp -t tabyagent-install.XXXXXX.sh)"
    chmod 700 "${tmp}"
    if ! curl -fsSL "${url}" -o "${tmp}"; then
        rm -f "${tmp}"
        echo "Error: Could not download installer (${url})" >&2
        exit 1
    fi
    exec env TABYAGENT_INSTALL_REEXEC=1 bash "${tmp}" "$@" 0</dev/tty
}
bootstrap_tty_installer

REPO_OWNER="gpdir16"
IMAGE_DEFAULT="ghcr.io/${REPO_OWNER}/tabyagent:latest"
REPO_URL="https://github.com/${REPO_OWNER}/tabyAgent.git"
REPO_BRANCH="${TABYAGENT_REPO_BRANCH:-main}"
INSTALL_DIR="${TABYAGENT_HOME:-${HOME}/.tabyagent}"
APP_DIR="${INSTALL_DIR}/app"
USER_DATA_DIR="${INSTALL_DIR}/user"
TABYAGENT_CLI="${INSTALL_DIR}/tabyagent"
USER_BIN="${HOME}/.local/bin"
COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
ENV_FILE="${INSTALL_DIR}/.env"
LAUNCHD_LABEL="io.tabyagent"
BROWSER_USE_PIP_SPEC="${BROWSER_USE_PIP_SPEC:-browser-use==0.13.3}"

DOCKER_SHELL="docker"
TABYAGENT_LANG_RESOLVED=""

resolve_lang() {
    if [ -n "${TABYAGENT_LANG_RESOLVED}" ]; then
        return
    fi
    local lang="${TABYAGENT_LANG:-}"
    if [ -z "${lang}" ]; then
        case "${LANG:-${LC_ALL:-}}" in
            ko*|KO*) lang=ko ;;
            *) lang=en ;;
        esac
    fi
    case "${lang}" in
        ko|ko_KR|korean) TABYAGENT_LANG_RESOLVED=ko ;;
        *) TABYAGENT_LANG_RESOLVED=en ;;
    esac
}

is_ko() {
    resolve_lang
    [ "${TABYAGENT_LANG_RESOLVED}" = ko ]
}

usage() {
    cat <<EOF
Install or update tabyAgent.

  curl -fsSL ${INSTALLER_URL_DEFAULT} | bash

Optional:
  TELEGRAM_BOT_TOKEN='...' curl -fsSL ... | bash
  curl -fsSL ... | bash -s -- '1234567890:ABC...'
  TABYAGENT_MODE=docker|local  (default: docker, or prompt on first install; set explicitly to switch on update)
Language: TABYAGENT_LANG=ko|en  (default: en, or ko if LANG is Korean)
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

die_need_token() {
    if is_ko; then
        die "봇 토큰이 필요합니다. 예:
  curl -fsSL ... | bash -s -- 'BotFather토큰'
  TELEGRAM_BOT_TOKEN='BotFather토큰' curl -fsSL ... | bash"
    else
        die "Bot token required. Examples:
  curl -fsSL ... | bash -s -- 'your-bot-token'
  TELEGRAM_BOT_TOKEN='your-bot-token' curl -fsSL ... | bash"
    fi
}

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-y}"
    local hint reply

    if [ "${TABYAGENT_AUTO_INSTALL_DOCKER:-}" = "1" ]; then
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
        mode="$(grep '^TABYAGENT_MODE=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2-)"
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
    local updating="$1" mode="${TABYAGENT_MODE:-}"

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
            systemctl --user stop tabyagent.service 2>/dev/null || true
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
                systemctl --user disable --now tabyagent.service 2>/dev/null || true
                rm -f "${HOME}/.config/systemd/user/tabyagent.service"
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
                systemctl --user is-active --quiet tabyagent.service 2>/dev/null && return 0
                ;;
        esac
        if pgrep -f "${index_pattern}" >/dev/null 2>&1; then
            return 0
        fi
    else
        if docker_daemon_ok && ${DOCKER_SHELL} ps --filter name=tabyagent --format '{{.Names}}' 2>/dev/null | grep -qx tabyagent; then
            return 0
        fi
    fi
    if is_ko; then
        echo "⚠ tabyAgent가 아직 실행 중이 아닐 수 있습니다. 로그: ${INSTALL_DIR}/logs/"
        [ -f "${INSTALL_DIR}/logs/stderr.log" ] && tail -n 5 "${INSTALL_DIR}/logs/stderr.log" 2>/dev/null || true
    else
        echo "⚠ tabyAgent may not be running yet. Logs: ${INSTALL_DIR}/logs/"
        [ -f "${INSTALL_DIR}/logs/stderr.log" ] && tail -n 5 "${INSTALL_DIR}/logs/stderr.log" 2>/dev/null || true
    fi
    return 1
}

trim_token() {
    printf '%s' "$1" | tr -d '[:space:]'
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

validate_host_workspace_path() {
    local path="$1"
    [ -n "${path}" ] || return 1
    case "${path}" in
        /*) ;;
        *)
            if is_ko; then die "절대 경로를 입력하세요 (예: ${HOME}/my-project)."
            else die "Enter an absolute path (e.g. ${HOME}/my-project)."; fi
            ;;
    esac
    if [ ! -d "${path}" ]; then
        if is_ko; then die "폴더가 없습니다: ${path}"
        else die "Folder does not exist: ${path}"; fi
    fi
}

# Interactive host workspace (first install). Default: no connection.
prompt_host_workspace() {
    local mode="${1:-docker}" path reply

    if ! can_prompt_user; then
        return 0
    fi

    say_user ""
    if [ "${mode}" = local ]; then
        if is_ko; then
            say_user "추가 작업 폴더 (선택)"
            say_user "  기본 작업은 ${USER_DATA_DIR} 에서 합니다."
            say_user "  연결하면 PC 프로젝트 폴더를 에이전트가 사용할 수 있습니다."
            prompt_yes_no "추가 작업 폴더를 연결할까요?" n || return 0
            say_user ""
            say_user "⚠ 경고: 에이전트가 연결된 폴더의 파일을 수정할 수 있는 권한을 갖습니다."
            prompt_yes_no "그래도 연결하시겠습니까?" n || return 0
        else
            say_user "Extra project folder (optional)"
            say_user "  Default work stays in ${USER_DATA_DIR}."
            say_user "  If enabled, the agent can read/write a project folder on your PC."
            prompt_yes_no "Connect a project folder?" n || return 0
            say_user ""
            say_user "⚠ Warning: The agent will be able to modify files in that folder."
            prompt_yes_no "Continue anyway?" n || return 0
        fi
    elif is_ko; then
        say_user "호스트 폴더 연결 (선택)"
        say_user "  기본 작업은 컨테이너 안 /app/user 에서 합니다."
        say_user "  연결하면 PC 폴더가 /workspace 로 마운트됩니다 (필요할 때만 사용)."
        prompt_yes_no "호스트 폴더를 연결할까요?" n || return 0
        say_user ""
        say_user "⚠ 경고: 에이전트가 연결된 폴더의 파일을 수정할 수 있는 권한을 갖습니다."
        say_user "  이 설정이 활성화되면 더 이상 tabyAgent가 격리 상태가 아니게 됩니다."
        say_user "  연결된 폴더의 파일을 파괴, 유출할 가능성이 존재합니다."
        prompt_yes_no "그래도 연결하시겠습니까?" n || return 0
    else
        say_user "Host folder mount (optional)"
        say_user "  Default work stays in /app/user inside the container."
        say_user "  If enabled, a PC folder is mounted at /workspace (use only when needed)."
        prompt_yes_no "Connect a host folder?" n || return 0
        say_user ""
        say_user "⚠ Warning: The agent will be able to modify files in the mounted folder."
        say_user "  Enabling this ends tabyAgent's isolation from your host."
        say_user "  Connected files may be destroyed or leaked."
        prompt_yes_no "Continue anyway?" n || return 0
    fi

    while true; do
        if is_ko; then
            read_user_line reply "절대 경로 (예: ${HOME}/my-project): " || return 0
        else
            read_user_line reply "Absolute path (e.g. ${HOME}/my-project): " || return 0
        fi
        path="$(expand_user_path "${reply}")"
        [ -n "${path}" ] || continue
        case "${path}" in
            /*) ;;
            *)
                if is_ko; then say_user "절대 경로를 입력하세요."; else say_user "Enter an absolute path."; fi
                continue
                ;;
        esac
        if [ ! -d "${path}" ]; then
            if is_ko; then say_user "폴더가 없습니다: ${path}"; else say_user "Folder does not exist: ${path}"; fi
            continue
        fi
        break
    done

    HOST_WORKSPACE="${path}"
    export HOST_WORKSPACE
}

resolve_host_workspace() {
    local updating="$1" mode="${2:-docker}"

    if [ "${updating}" = true ]; then
        HOST_WORKSPACE="$(read_env_host_workspace)"
        if [ -n "${HOST_WORKSPACE:-}" ]; then
            local expanded
            expanded="$(expand_user_path "${HOST_WORKSPACE}")"
            if [ -d "${expanded}" ]; then
                HOST_WORKSPACE="${expanded}"
            else
                if is_ko; then echo "⚠ 작업 폴더가 없어 연결을 해제합니다: ${expanded}"
                else echo "⚠ Workspace folder missing, clearing: ${expanded}"; fi
                HOST_WORKSPACE=""
            fi
        fi
        export HOST_WORKSPACE
        return 0
    fi

    # First install: interactive prompt (default no). Ignore stray HOST_WORKSPACE in the shell.
    if can_prompt_user; then
        HOST_WORKSPACE=""
        export HOST_WORKSPACE
        prompt_host_workspace "${mode}"
        return 0
    fi

    # Non-interactive first install (piped curl | bash with token only).
    if [ -n "${HOST_WORKSPACE:-}" ]; then
        validate_host_workspace_path "$(expand_user_path "${HOST_WORKSPACE}")"
        HOST_WORKSPACE="$(expand_user_path "${HOST_WORKSPACE}")"
        export HOST_WORKSPACE
    fi
}

validate_token() {
    local token="$1"
    [ -n "${token}" ] || die_need_token
    case "${token}" in
        *:*) ;;
        *)
            if is_ko; then die "BotFather 토큰 전체(숫자:영문)를 붙여넣으세요."
            else die "Paste the full BotFather token (digits:letters)."; fi
            ;;
    esac
}

prompt_token() {
    local token prompt_line
    say_user ""
    if is_ko; then
        say_user "① Telegram @BotFather → /newbot"
        say_user "② HTTP API 토큰 전체 복사 (예: 1234567890:ABCdef...)"
        prompt_line="토큰 붙여넣기: "
    else
        say_user "1) Telegram @BotFather → /newbot"
        say_user "2) Copy the full HTTP API token (e.g. 1234567890:ABCdef...)"
        prompt_line="Paste token: "
    fi
    read_user_line token "${prompt_line}" || die_need_token
    token="$(trim_token "${token}")"
    [ -n "${token}" ] || die_need_token
    validate_token "${token}"
    printf '%s' "${token}"
}

write_compose() {
    local image="$1"
    local workspace_volumes="" workspace_env="" install_dir_escaped ws_escaped
    install_dir_escaped="$(yaml_escape_double "${INSTALL_DIR}")"
    if [ -n "${HOST_WORKSPACE:-}" ]; then
        ws_escaped="$(yaml_escape_double "${HOST_WORKSPACE}")"
        workspace_env=$'            WORKSPACE_ENABLED: "1"\n            WORKSPACE_DIR: /workspace\n            HOST_WORKSPACE: "'"${ws_escaped}"$'"\n'
        workspace_volumes=$'            - "'"${ws_escaped}"$':/workspace"\n'
    fi
    mkdir -p "${INSTALL_DIR}"
    cat >"${COMPOSE_FILE}" <<EOF
services:
    tabyagent:
        image: ${image}
        container_name: tabyagent
        env_file:
            - .env
        environment:
            TELEGRAM_BOT_TOKEN: \${TELEGRAM_BOT_TOKEN:-}
            TABYAGENT_MODE: docker
            TABYAGENT_HOME: "${install_dir_escaped}"
            TABYAGENT_DOCKER_SHELL: \${TABYAGENT_DOCKER_SHELL:-docker}
${workspace_env}        volumes:
            - tabyagent-user:/app/user
${workspace_volumes}        restart: unless-stopped

volumes:
    tabyagent-user:
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
    local token="$1" mode="${2:-docker}"
    local workspace="${HOST_WORKSPACE:-}"
    local version=""
    umask 077
    if [ "${mode}" = local ] && [ -f "${APP_DIR}/VERSION" ]; then
        version="$(tr -d '\n' <"${APP_DIR}/VERSION")"
    elif [ "${mode}" = local ] && [ -f "${ENV_FILE}" ]; then
        version="$(grep '^TABYAGENT_VERSION=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2-)"
        version="$(strip_env_scalar "${version}")"
    fi
    {
        printf 'TABYAGENT_MODE=%s\n' "${mode}"
        printf 'TELEGRAM_BOT_TOKEN=%s\n' "${token}"
        if [ "${mode}" = docker ]; then
            write_env_quoted TABYAGENT_DOCKER_SHELL "${DOCKER_SHELL}"
            write_env_quoted TABYAGENT_HOME "${INSTALL_DIR}"
        fi
        if [ "${mode}" = local ]; then
            write_env_quoted TABYAGENT_HOME "${INSTALL_DIR}"
            write_env_quoted APP_ROOT "${APP_DIR}"
            write_env_quoted USER_DIR "${USER_DATA_DIR}"
            write_env_quoted CODES_DIR "${APP_DIR}/codes"
            write_env_quoted CONFIG_DIR "${APP_DIR}/codes/config"
            write_env_quoted TABYAGENT_NODE "$(resolve_node_bin)"
            if [ -n "${version}" ]; then
                printf 'TABYAGENT_VERSION=%s\n' "${version}"
            fi
        fi
        if [ -n "${workspace}" ]; then
            write_env_quoted HOST_WORKSPACE "${workspace}"
            printf 'WORKSPACE_ENABLED=1\n'
            if [ "${mode}" = local ]; then
                write_env_quoted WORKSPACE_DIR "${workspace}"
            fi
        fi
    } >"${ENV_FILE}"
    chmod 600 "${ENV_FILE}"
}

read_env_token() {
    [ -f "${ENV_FILE}" ] || return 0
    # shellcheck disable=SC1090
    . "${ENV_FILE}"
    printf '%s' "${TELEGRAM_BOT_TOKEN:-}"
}

read_env_host_workspace() {
    [ -f "${ENV_FILE}" ] || return 0
    # shellcheck disable=SC1090
    . "${ENV_FILE}"
    printf '%s' "${HOST_WORKSPACE:-}"
}

pull_image() {
    local compose="$1" image="$2"
    local attempt=1 max_attempts=3

    if is_ko; then echo "==> 설치 파일 받는 중..."; else echo "==> Downloading tabyAgent..."; fi

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
· 계속 안 되면: https://github.com/gpdir16/tabyAgent/issues"
    else
        die "Could not download tabyAgent.
· Check your internet connection.
· Make sure Docker Desktop is running.
· Run the same install command again in a minute or two.
· Still stuck? https://github.com/gpdir16/tabyAgent/issues"
    fi
}

ensure_node() {
    local node_ver major

    if ! command -v node >/dev/null 2>&1; then
        if is_ko; then
            die "Node.js 22 이상이 필요합니다. https://nodejs.org 에서 설치하거나 TABYAGENT_MODE=docker 로 Docker 설치를 선택하세요."
        else
            die "Node.js 22+ is required. Install from https://nodejs.org or choose Docker with TABYAGENT_MODE=docker."
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
    url="https://github.com/${REPO_OWNER}/tabyAgent/archive/refs/heads/${REPO_BRANCH}.tar.gz"
    tmp="$(mktemp -t tabyagent-src.XXXXXX.tar.gz)"
    if is_ko; then echo "==> 소스 코드 받는 중..."; else echo "==> Downloading source..."; fi
    curl -fsSL "${url}" -o "${tmp}"
    rm -rf "${APP_DIR}"
    mkdir -p "${INSTALL_DIR}"
    tar -xzf "${tmp}" -C "${INSTALL_DIR}"
    rm -f "${tmp}"
    extracted="$(find "${INSTALL_DIR}" -maxdepth 1 -mindepth 1 -type d -name 'tabyAgent-*' | head -1)"
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
    local stealth_script
    if is_ko; then echo "==> Node.js 패키지 설치 중..."; else echo "==> Installing Node.js packages..."; fi
    (cd "${APP_DIR}" && npm install --omit=dev)

    if command -v python3 >/dev/null 2>&1; then
        if is_ko; then echo "==> browser-use 설치 중 (선택)..."; else echo "==> Installing browser-use (optional)..."; fi
        if python3 -m pip install --upgrade --user "${BROWSER_USE_PIP_SPEC}" 'uv' >/dev/null 2>&1 \
            || python3 -m pip install --upgrade --break-system-packages "${BROWSER_USE_PIP_SPEC}" 'uv' >/dev/null 2>&1; then
            if command -v browser-use >/dev/null 2>&1; then
                browser-use install >/dev/null 2>&1 || true
            fi
            stealth_script="${APP_DIR}/codes/skills/browser-use/install-stealth.sh"
            if [ -f "${stealth_script}" ]; then
                STEALTH_DIR="${APP_DIR}/codes/skills/browser-use" bash "${stealth_script}" || true
            fi
        elif is_ko; then
            echo "    (browser-use 스킵: Python/pip 없음 — 웹 브라우징 skill 제한될 수 있음)"
        else
            echo "    (browser-use skipped: no Python/pip — web browsing skill may be limited)"
        fi
    fi
}

write_tabyagent_cli() {
    cat >"${TABYAGENT_CLI}" <<'EOF'
#!/usr/bin/env bash
# tabyAgent CLI — manage an installed instance (~/.tabyagent)
set -euo pipefail

resolve_install_dir() {
    local source="${BASH_SOURCE[0]:-$0}"
    while [ -L "${source}" ]; do
        local dir target
        dir="$(cd "$(dirname "${source}")" && pwd)"
        target="$(readlink "${source}")"
        case "${target}" in
            /*) source="${target}" ;;
            *) source="${dir}/${target}" ;;
        esac
    done
    cd "$(dirname "${source}")" && pwd
}

INSTALL_DIR="$(resolve_install_dir)"
ENV_FILE="${INSTALL_DIR}/.env"
COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
USER_BIN="${HOME}/.local/bin/tabyagent"
LAUNCHD_LABEL="io.tabyagent"
APP_DIR="${INSTALL_DIR}/app"
LOG_DIR="${INSTALL_DIR}/logs"

load_env() {
    # shellcheck disable=SC1091
    [ -f "${ENV_FILE}" ] && set -a && . "${ENV_FILE}" && set +a
    export TABYAGENT_HOME="${TABYAGENT_HOME:-${INSTALL_DIR}}"
    export APP_ROOT="${APP_ROOT:-${INSTALL_DIR}/app}"
    export USER_DIR="${USER_DIR:-${INSTALL_DIR}/user}"
    export CODES_DIR="${CODES_DIR:-${APP_ROOT}/codes}"
    export CONFIG_DIR="${CONFIG_DIR:-${APP_ROOT}/codes/config}"
}

resolve_node() {
    local candidate
    if [ -n "${TABYAGENT_NODE:-}" ] && [ -x "${TABYAGENT_NODE}" ]; then
        printf '%s' "${TABYAGENT_NODE}"
        return 0
    fi
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
        [ -n "${candidate}" ] && [ -x "${candidate}" ] && printf '%s' "${candidate}" && return 0
    done
    return 1
}

require_node() {
    load_env
    NODE_BIN="$(resolve_node)" || {
        if is_ko; then echo "node를 찾을 수 없습니다. ${ENV_FILE} 에 TABYAGENT_NODE 를 설정하거나 설치를 다시 실행하세요." >&2
        else echo "node not found — set TABYAGENT_NODE in ${ENV_FILE} or re-run the installer." >&2; fi
        exit 1
    }
    INDEX_JS="${APP_ROOT}/codes/index.js"
    INDEX_PATTERN="$(regex_escape "${INDEX_JS}")"
}

resolve_lang() {
    local lang="${TABYAGENT_LANG:-}"
    if [ -z "${lang}" ]; then
        case "${LANG:-${LC_ALL:-}}" in
            ko*|KO*) lang=ko ;;
            *) lang=en ;;
        esac
    fi
    case "${lang}" in
        ko|ko_KR|korean) printf ko ;;
        *) printf en ;;
    esac
}

is_ko() {
    [ "$(resolve_lang)" = ko ]
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

read_install_mode() {
    load_env
    if [ -f "${ENV_FILE}" ]; then
        local mode
        mode="$(grep '^TABYAGENT_MODE=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2-)"
        mode="$(strip_env_scalar "${mode}" | tr '[:upper:]' '[:lower:]')"
        case "${mode}" in
            docker|local) printf '%s' "${mode}"; return 0 ;;
        esac
    fi
    if [ -f "${COMPOSE_FILE}" ]; then
        printf docker
        return 0
    fi
    if [ -d "${APP_DIR}/codes" ]; then
        printf local
        return 0
    fi
    return 1
}

docker_daemon_ok() {
    local shell="${TABYAGENT_DOCKER_SHELL:-docker}"
    if ${shell} info >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

compose_cmd() {
    local shell="${TABYAGENT_DOCKER_SHELL:-docker}"
    if ${shell} compose version >/dev/null 2>&1; then
        printf '%s compose' "${shell}"
    elif command -v docker-compose >/dev/null 2>&1; then
        [ "${shell}" = "sudo docker" ] && printf 'sudo docker-compose' || printf 'docker-compose'
    else
        return 1
    fi
}

regex_escape() {
    printf '%s' "$1" | sed 's/[][\\.*^$()+?{|}]/\\&/g'
}

print_help() {
    if is_ko; then
        cat <<'TAA_HELP_KO'
tabyAgent 명령줄 도구

사용법: tabyagent <명령> [인자]

명령:
  start              백그라운드에서 시작
  stop               중지
  restart            재시작
  status             실행 상태 확인
  logs               로그 보기 (실시간)
  approve <코드>     접근 코드 승인
  foreground         포그라운드 실행 (디버그)
  uninstall          tabyAgent 제거
  help               이 도움말

설치/업데이트:
  curl -fsSL https://raw.githubusercontent.com/gpdir16/tabyAgent/main/scripts/install.sh | bash

제거 시 사용자 데이터도 삭제: tabyagent uninstall --purge
TAA_HELP_KO
    else
        cat <<'TAA_HELP_EN'
tabyAgent command-line tool

Usage: tabyagent <command> [args]

Commands:
  start              Start in the background
  stop               Stop the agent
  restart            Restart the agent
  status             Show running status
  logs               Tail logs (follow)
  approve <code>     Approve an access code
  foreground         Run in foreground (debug)
  uninstall          Remove tabyAgent from this machine
  help               Show this help

Install/update:
  curl -fsSL https://raw.githubusercontent.com/gpdir16/tabyAgent/main/scripts/install.sh | bash

Remove user data too: tabyagent uninstall --purge
TAA_HELP_EN
    fi
}

not_installed_message() {
    local url="https://raw.githubusercontent.com/gpdir16/tabyAgent/main/scripts/install.sh"
    if is_ko; then
        echo "tabyAgent가 설치되어 있지 않습니다 (${INSTALL_DIR})." >&2
        echo "설치: curl -fsSL ${url} | bash" >&2
    else
        echo "tabyAgent is not installed (${INSTALL_DIR})." >&2
        echo "Install: curl -fsSL ${url} | bash" >&2
    fi
}

docker_service_start() {
    local compose
    compose="$(compose_cmd)" || {
        if is_ko; then echo "Docker Compose를 찾을 수 없습니다." >&2; else echo "Docker Compose not found." >&2; fi
        return 1
    }
    docker_daemon_ok || {
        if is_ko; then echo "Docker가 실행 중이 아닙니다." >&2; else echo "Docker is not running." >&2; fi
        return 1
    }
    (cd "${INSTALL_DIR}" && ${compose} -f "${COMPOSE_FILE}" up -d)
}

docker_service_stop() {
    local compose
    [ -f "${COMPOSE_FILE}" ] || return 0
    docker_daemon_ok || return 0
    compose="$(compose_cmd)" || return 0
    (cd "${INSTALL_DIR}" && ${compose} -f "${COMPOSE_FILE}" down 2>/dev/null) || true
}

docker_service_status() {
    local shell="${TABYAGENT_DOCKER_SHELL:-docker}"
    if docker_daemon_ok && ${shell} ps --filter name=tabyagent --format '{{.Names}}' 2>/dev/null | grep -qx tabyagent; then
        if is_ko; then echo "실행 중 (Docker 컨테이너 tabyagent)"; else echo "running (Docker container tabyagent)"; fi
        return 0
    fi
    if is_ko; then echo "실행 중 아님"; else echo "not running"; fi
    return 1
}

stop_local_runtime() {
    local index_pattern
    index_pattern="$(regex_escape "${APP_DIR}/codes/index.js")"
    case "$(uname -s)" in
        Darwin)
            launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
            ;;
        Linux)
            systemctl --user stop tabyagent.service 2>/dev/null || true
            ;;
    esac
    pkill -f "${index_pattern}" 2>/dev/null || true
}

local_service_start() {
    case "$(uname -s)" in
        Darwin)
            if launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
                launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}"
            else
                launchctl bootstrap "gui/$(id -u)" "${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist" \
                    || launchctl load "${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
            fi
            ;;
        Linux)
            systemctl --user start tabyagent.service
            ;;
        *)
            if is_ko; then echo "백그라운드 서비스를 지원하지 않는 OS입니다." >&2
            else echo "Unsupported OS for background service." >&2; fi
            return 1
            ;;
    esac
}

local_service_status() {
    require_node
    if pgrep -f "${INDEX_PATTERN}" >/dev/null 2>&1; then
        if is_ko; then echo "실행 중 (pid $(pgrep -f "${INDEX_PATTERN}" | head -1))"; else echo "running (pid $(pgrep -f "${INDEX_PATTERN}" | head -1))"; fi
        return 0
    fi
    if is_ko; then echo "실행 중 아님"; else echo "not running"; fi
    return 1
}

run_local_command() {
    local cmd="$1"
    shift
    case "${cmd}" in
        daemon|foreground|run)
            require_node
            exec "${NODE_BIN}" "${INDEX_JS}"
            ;;
        approve)
            require_node
            exec "${NODE_BIN}" "${APP_ROOT}/codes/cli.js" approve "$@"
            ;;
        start)
            local_service_start
            local_service_status || true
            ;;
        stop)
            stop_local_runtime
            if is_ko; then echo "중지됨"; else echo "stopped"; fi
            ;;
        restart)
            stop_local_runtime
            sleep 1
            local_service_start
            local_service_status || true
            ;;
        status)
            local_service_status
            ;;
        logs)
            tail -n 80 -f "${LOG_DIR}/stderr.log" 2>/dev/null || tail -n 80 -f "${LOG_DIR}/stdout.log" 2>/dev/null || {
                if is_ko; then echo "로그 없음"; else echo "no logs yet"; fi
            }
            ;;
        *)
            echo "Unknown command: ${cmd}" >&2
            print_help >&2
            exit 1
            ;;
    esac
}

uninstall_local_service() {
    stop_local_runtime
    case "$(uname -s)" in
        Darwin)
            rm -f "${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
            ;;
        Linux)
            if command -v systemctl >/dev/null 2>&1; then
                systemctl --user disable --now tabyagent.service 2>/dev/null || true
                rm -f "${HOME}/.config/systemd/user/tabyagent.service"
                systemctl --user daemon-reload 2>/dev/null || true
            fi
            ;;
    esac
}

confirm_uninstall() {
    local purge="$1" reply
    if [ "${TABYAGENT_UNINSTALL_YES:-}" = "1" ]; then
        return 0
    fi
    if is_ko; then
        echo "tabyAgent를 제거합니다: ${INSTALL_DIR}"
        [ "${purge}" = true ] && echo "  (--purge: Docker 볼륨·로컬 user 데이터도 삭제)"
        printf "계속할까요? [y/N] "
    else
        echo "This will remove tabyAgent from: ${INSTALL_DIR}"
        [ "${purge}" = true ] && echo "  (--purge: also deletes Docker volume and local user data)"
        printf "Continue? [y/N] "
    fi
    if [ -r /dev/tty ] 2>/dev/null; then
        IFS= read -r reply </dev/tty
    elif [ -t 0 ]; then
        IFS= read -r reply
    else
        if is_ko; then echo "비대화형 환경입니다. TABYAGENT_UNINSTALL_YES=1 을 설정하세요." >&2
        else echo "Non-interactive shell. Set TABYAGENT_UNINSTALL_YES=1 to confirm." >&2; fi
        return 1
    fi
    reply="$(printf '%s' "${reply}" | tr '[:upper:]' '[:lower:]')"
    [ "${reply}" = y ] || [ "${reply}" = yes ]
}

do_uninstall() {
    local purge=false arg
    shift
    while [ $# -gt 0 ]; do
        arg="$1"
        shift
        case "${arg}" in
            --purge|-p) purge=true ;;
            -h|--help)
                if is_ko; then
                    echo "사용법: tabyagent uninstall [--purge]"
                    echo "  --purge  Docker 볼륨·로컬 user/ 폴더까지 삭제"
                else
                    echo "Usage: tabyagent uninstall [--purge]"
                    echo "  --purge  Also remove Docker volume and local user/ data"
                fi
                exit 0
                ;;
            *)
                echo "Unknown option: ${arg}" >&2
                exit 1
                ;;
        esac
    done

    read_install_mode >/dev/null 2>&1 || {
        rm -f "${USER_BIN}" 2>/dev/null || true
        not_installed_message
        exit 1
    }

    confirm_uninstall "${purge}" || {
        if is_ko; then echo "취소됨."; else echo "Cancelled."; fi
        exit 0
    }

    local mode
    mode="$(read_install_mode)"

    if [ "${mode}" = docker ]; then
        if [ "${purge}" = true ]; then
            local compose
            compose="$(compose_cmd)" || true
            if [ -n "${compose:-}" ] && docker_daemon_ok; then
                (cd "${INSTALL_DIR}" && ${compose} -f "${COMPOSE_FILE}" down -v 2>/dev/null) || true
            fi
        else
            docker_service_stop
        fi
    else
        uninstall_local_service
    fi

    rm -f "${USER_BIN}" 2>/dev/null || true
    local dir="${INSTALL_DIR}"
    if [ "${purge}" = true ] && [ "${mode}" = local ] && [ -d "${INSTALL_DIR}/user" ]; then
        rm -rf "${INSTALL_DIR}/user"
    fi
    (
        sleep 0.3
        rm -rf "${dir}"
    ) &

    if is_ko; then
        echo "제거 완료."
        [ "${purge}" != true ] && [ "${mode}" = docker ] && echo "  (Docker 사용자 데이터 볼륨은 남아 있을 수 있습니다. 완전 삭제: tabyagent uninstall --purge)"
    else
        echo "Uninstall complete."
        [ "${purge}" != true ] && [ "${mode}" = docker ] && echo "  (Docker user-data volume may remain. Full removal: tabyagent uninstall --purge)"
    fi
}

run_docker_command() {
    local cmd="$1"
    shift
    local compose
    compose="$(compose_cmd)" || {
        if is_ko; then echo "Docker Compose를 찾을 수 없습니다." >&2; else echo "Docker Compose not found." >&2; fi
        exit 1
    }
    case "${cmd}" in
        start)
            docker_service_start
            docker_service_status || true
            ;;
        stop)
            docker_service_stop
            if is_ko; then echo "중지됨"; else echo "stopped"; fi
            ;;
        restart)
            docker_service_stop
            sleep 1
            docker_service_start
            docker_service_status || true
            ;;
        status)
            docker_service_status
            ;;
        logs)
            docker_daemon_ok || exit 1
            ${compose} -f "${COMPOSE_FILE}" logs -f --tail=80 tabyagent
            ;;
        approve)
            docker_daemon_ok || exit 1
            exec ${compose} -f "${COMPOSE_FILE}" exec -T tabyagent approve "$@"
            ;;
        foreground|run)
            docker_daemon_ok || exit 1
            exec ${compose} -f "${COMPOSE_FILE}" up
            ;;
        *)
            echo "Unknown command: ${cmd}" >&2
            print_help >&2
            exit 1
            ;;
    esac
}

main() {
    local command="${1:-help}"

    case "${command}" in
        help|-h|--help)
            print_help
            exit 0
            ;;
        uninstall)
            do_uninstall "$@"
            exit 0
            ;;
    esac

    if ! read_install_mode >/dev/null 2>&1; then
        not_installed_message
        exit 1
    fi

    local mode
    mode="$(read_install_mode)"

    if [ "${mode}" = local ]; then
        run_local_command "${command}" "$@"
        exit 0
    fi

    run_docker_command "${command}" "$@"
}

main "$@"
EOF
    chmod +x "${TABYAGENT_CLI}"
}

install_tabyagent_cli() {
    mkdir -p "${USER_BIN}"
    ln -sf "${TABYAGENT_CLI}" "${USER_BIN}/tabyagent"
    case ":${PATH}:" in
        *":${USER_BIN}:"*) ;;
        *)
            if is_ko; then
                echo "  PATH에 ${USER_BIN} 추가: export PATH=\"${USER_BIN}:\$PATH\""
            else
                echo "  Add ${USER_BIN} to PATH: export PATH=\"${USER_BIN}:\$PATH\""
            fi
            ;;
    esac
}

print_manage_hints() {
    echo ""
    if is_ko; then
        echo "관리 명령 (터미널을 닫아도 백그라운드에서 실행):"
        echo "  tabyagent status|stop|restart|logs|help"
        echo "  tabyagent uninstall"
        echo "  (디버그: tabyagent foreground)"
    else
        echo "Manage (runs in background — safe to close the terminal):"
        echo "  tabyagent status|stop|restart|logs|help"
        echo "  tabyagent uninstall"
        echo "  (Debug: tabyagent foreground)"
    fi
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
        <string>${TABYAGENT_CLI}</string>
        <string>daemon</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
        <key>TABYAGENT_NODE</key>
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
    local unit_file="${unit_dir}/tabyagent.service"
    local env_file_line="EnvironmentFile=${ENV_FILE}"
    local exec_start_line="ExecStart=${TABYAGENT_CLI} daemon"
    local workdir_line="WorkingDirectory=${APP_DIR}"
    if [[ "${ENV_FILE}" == *" "* ]]; then
        env_file_line="EnvironmentFile=\"${ENV_FILE}\""
    fi
    if [[ "${TABYAGENT_CLI}" == *" "* ]]; then
        exec_start_line="ExecStart=\"${TABYAGENT_CLI}\" daemon"
    fi
    if [[ "${APP_DIR}" == *" "* ]]; then
        workdir_line="WorkingDirectory=\"${APP_DIR}\""
    fi
    mkdir -p "${unit_dir}" "${INSTALL_DIR}/logs"
    cat >"${unit_file}" <<EOF
[Unit]
Description=tabyAgent Telegram bot
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
    systemctl --user enable --now tabyagent.service
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

print_local_service_hints() {
    print_manage_hints
}

install_local() {
    local token="$1" updating="$2"

    ensure_node
    mkdir -p "${INSTALL_DIR}" "${USER_DATA_DIR}"
    stop_local_runtime
    stop_docker_runtime
    resolve_host_workspace "${updating}" local
    update_local_source
    write_local_version
    install_local_deps
    write_tabyagent_cli
    install_tabyagent_cli
    write_env "${token}" local
    if is_ko; then echo "==> 실행 중..."; else echo "==> Starting..."; fi
    install_local_service
    ensure_systemd_linger
    verify_install local || true
    print_local_service_hints
}

deploy_tabyagent_docker() {
    local token="$1" image="$2" updating="$3" compose

    stop_local_runtime
    ensure_docker
    compose="$(compose_cmd)"
    resolve_host_workspace "${updating}" docker
    write_compose "${image}"
    write_tabyagent_cli
    install_tabyagent_cli
    write_env "${token}" docker
    cd "${INSTALL_DIR}"
    pull_image "${compose}" "${image}"
    if is_ko; then echo "==> 실행 중..."; else echo "==> Starting..."; fi
    ${compose} -f "${COMPOSE_FILE}" up -d
    verify_install docker || true
    print_manage_hints
}

main() {
    resolve_lang
    local token="${TELEGRAM_BOT_TOKEN:-}" image="${TABYAGENT_IMAGE:-${IMAGE_DEFAULT}}"

    if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
        usage
        exit 0
    fi

    if [ -n "${1:-}" ]; then
        token="$(trim_token "$1")"
    fi

    local updating=false
    if is_installed; then
        updating=true
        if is_ko; then echo "==> tabyAgent 업데이트 중..."; else echo "==> Updating tabyAgent..."; fi
        [ -n "${token}" ] || token="$(read_env_token)"
        [ -n "${token}" ] || die_need_token
    else
        if is_ko; then echo "==> tabyAgent 설치 중..."; else echo "==> Installing tabyAgent..."; fi
        if [ -z "${token}" ]; then
            token="$(prompt_token)"
        fi
    fi

    validate_token "${token}"

    local mode old_mode=""
    mode="$(resolve_install_mode "${updating}")"

    if [ "${updating}" = true ]; then
        old_mode="$(read_install_mode 2>/dev/null)" || old_mode=""
        if [ -n "${old_mode}" ] && [ "${old_mode}" != "${mode}" ]; then
            prepare_mode_switch "${old_mode}" "${mode}"
        fi
    fi

    if [ "${mode}" = local ]; then
        install_local "${token}" "${updating}"
    else
        deploy_tabyagent_docker "${token}" "${image}" "${updating}"
    fi

    echo ""
    if [ "${updating}" = true ]; then
        if is_ko; then echo "완료. tabyAgent 실행 중 (${mode})."; else echo "Done. tabyAgent is running (${mode})."; fi
    else
        if is_ko; then
            echo "설치 완료 (${mode}). Telegram에서 봇에게 /start 를 보내세요."
        else
            echo "Install complete (${mode}). Open your bot in Telegram and send /start."
        fi
    fi
}

main "$@"
