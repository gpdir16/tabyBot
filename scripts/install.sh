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
    # -r 테스트는 tty가 없는 샌드박스에서도 참이 될 수 있다 — 실제로 열어본다.
    if ! (exec 3<>/dev/tty) 2>/dev/null; then
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
bootstrap_tty_installer "$@"

REPO_OWNER="gpdir16"
IMAGE_DEFAULT="ghcr.io/${REPO_OWNER}/tabybot:latest"
REPO_URL="https://github.com/${REPO_OWNER}/tabyBot.git"
# 빈 값이면 main()에서 .env의 저장값을 읽은 뒤 main으로 결정한다.
REPO_BRANCH="${TABYBOT_REPO_BRANCH:-}"
INSTALL_DIR="${TABYBOT_HOME:-${HOME}/.tabybot}"
APP_DIR="${INSTALL_DIR}/app"
USER_DATA_DIR="${INSTALL_DIR}/user"
COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
ENV_FILE="${INSTALL_DIR}/.env"
LAUNCHD_LABEL="io.tabybot"
CAMOFOX_VERSION="${CAMOFOX_VERSION:-2.4.7}"

DOCKER_SHELL="docker"
TABYBOT_LANG_RESOLVED=""
# sudo/cron 등 USER가 비어 있는 환경에서도 set -u로 죽지 않게 한다.
INSTALL_USER="${USER:-$(id -un 2>/dev/null || true)}"

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
  TABYBOT_PORT=8999          (host port; container always listens on 8999)
  TABYBOT_BIND=0.0.0.0       (host interface; default listens on all interfaces —
                              use 127.0.0.1 for this machine only)
  TABYBOT_REPO_BRANCH=main   (local-mode source branch; persisted for updates)
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
    # stdin 경로는 프롬프트 출력도 필요하므로 stdin/stdout 둘 다 터미널이어야 한다.
    [ -t 0 ] && [ -t 1 ] && return 0
    # -r/-w 테스트는 tty가 없는 샌드박스에서도 참이 될 수 있다 — 실제로 열어본다.
    (exec 3<>/dev/tty) 2>/dev/null
}

say_user() {
    # $( ) 캡처 안에서 불릴 때 stdout은 파이프다 — mode 같은 반환값을 오염시키지
    # 않게 /dev/tty로 보내고, tty도 stdout도 터미널이 아니면 조용히 삼킨다.
    if (exec 3<>/dev/tty) 2>/dev/null; then
        printf '%s\n' "$@" >/dev/tty 2>/dev/null || true
    elif [ -t 1 ]; then
        printf '%s\n' "$@"
    fi
}

read_user_line() {
    local __var_name="$1"
    local prompt="${2:-}"
    local line

    if (exec 3<>/dev/tty) 2>/dev/null; then
        if [ -n "${prompt}" ]; then printf '%s' "${prompt}" >/dev/tty 2>/dev/null || true; fi
        IFS= read -r line </dev/tty 2>/dev/null || return 1
    elif [ -t 0 ]; then
        # stdout이 $( ) 캡처면 -t 1이 거짓 — 캡처 오염 없이 프롬프트를 삼킨다.
        [ -n "${prompt}" ] && [ -t 1 ] && printf '%s' "${prompt}"
        IFS= read -r line || return 1
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
    if is_ko; then printf '==> Docker가 준비될 때까지 기다리는 중'; else printf '==> Waiting for Docker'; fi
    while [ "${waited}" -lt "${max}" ]; do
        if docker_daemon_ok; then
            printf '\n'
            return 0
        fi
        sleep 3
        waited=$((waited + 3))
        printf '.'
        [ $((waited % 30)) -eq 0 ] && printf ' %ds' "${waited}"
        [ $((waited % 15)) -eq 0 ] && start_docker_daemon
    done
    printf '\n'
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
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && [ -n "${INSTALL_USER}" ]; then
        if ! id -nG "${INSTALL_USER}" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
            sudo usermod -aG docker "${INSTALL_USER}" 2>/dev/null || true
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
        mode="$(env_file_value TABYBOT_MODE)"
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
        # 설치 메타데이터가 깨진 경우 죽지 말고 새 설치처럼 물어본다.
        if ! mode="$(read_install_mode)"; then
            mode="$(prompt_install_mode)"
        fi
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
    [ -n "${INSTALL_USER}" ] || return 0
    command -v loginctl >/dev/null 2>&1 || return 0
    if loginctl show-user "${INSTALL_USER}" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
        return 0
    fi
    if is_ko; then echo "==> 재부팅·로그아웃 후에도 실행되도록 linger 설정 중..."; else echo "==> Enabling systemd linger for reboot/logout survival..."; fi
    loginctl enable-linger "${INSTALL_USER}" 2>/dev/null || {
        if is_ko; then
            echo "⚠ linger 설정 실패 — 로그아웃 후 서비스가 중지될 수 있습니다: sudo loginctl enable-linger ${INSTALL_USER}"
        else
            echo "⚠ Could not enable linger — service may stop after logout: sudo loginctl enable-linger ${INSTALL_USER}"
        fi
    }
}

verify_install() {
    local mode="$1" waited=0 max=20 running=false
    local index_pattern
    index_pattern="$(regex_escape "${APP_DIR}/codes/index.js")"
    if is_ko; then printf '==> 실행 상태 확인 중'; else printf '==> Confirming startup'; fi
    while [ "${waited}" -lt "${max}" ]; do
        running=false
        if [ "${mode}" = local ]; then
            case "$(uname -s)" in
                Darwin)
                    if launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
                        running=true
                    fi
                    ;;
                Linux)
                    if systemctl --user is-active --quiet tabybot.service 2>/dev/null; then
                        running=true
                    fi
                    ;;
            esac
            if [ "${running}" = false ] && pgrep -f "${index_pattern}" >/dev/null 2>&1; then
                running=true
            fi
        elif docker_daemon_ok && ${DOCKER_SHELL} ps --filter name=tabybot --format '{{.Names}}' 2>/dev/null | grep -qx tabybot; then
            running=true
        fi
        if [ "${running}" = true ]; then
            printf '\n'
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
        printf '.'
    done
    printf '\n'
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

env_file_value() {
    # grep은 매치가 없으면 1을 반환한다 — || true가 없으면 pipefail+set -e 때문에
    # 키가 없을 때 스크립트가 아무 출력 없이 종료된다.
    # 키가 여러 줄이면 마지막 것을 쓴다 (손편집된 .env 대비).
    local key="$1"
    [ -f "${ENV_FILE}" ] || return 0
    grep "^${key}=" "${ENV_FILE}" 2>/dev/null | tail -1 | cut -d= -f2- || true
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
            TABYBOT_MODE: docker
            TABYBOT_HOME: "${install_dir_escaped}"
            TABYBOT_DOCKER_SHELL: \${TABYBOT_DOCKER_SHELL:-docker}
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
            - "\${TABYBOT_BIND:-0.0.0.0}:\${TABYBOT_PORT:-8999}:8999"

volumes:
    tabybot-user:
EOF
}

write_env_quoted() {
    # .env는 launchd에서 `set -a; . file`로 source되므로 ", $, ` 전부 이스케이프한다.
    local key="$1" value="$2"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//\$/\\$}"
    value="${value//\`/\\\`}"
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
    local existing_port="" existing_bind="" existing_host=""
    umask 077
    if [ -f "${ENV_FILE}" ]; then
        existing_port="$(env_file_value TABYBOT_PORT)"
        existing_port="$(strip_env_scalar "${existing_port}")"
        existing_bind="$(env_file_value TABYBOT_BIND)"
        existing_bind="$(strip_env_scalar "${existing_bind}")"
        existing_host="$(env_file_value TABYBOT_HOST)"
        existing_host="$(strip_env_scalar "${existing_host}")"
    fi
    if [ -n "${TABYBOT_PORT:-}" ]; then
        existing_port="${TABYBOT_PORT}"
    fi
    if [ -n "${TABYBOT_BIND:-}" ]; then
        existing_bind="${TABYBOT_BIND}"
    fi
    # 포트는 숫자만 통과 — .env가 손상돼도 깨진 값을 다시 쓰지 않는다.
    case "${existing_port}" in
        ''|*[!0-9]*) existing_port="" ;;
    esac
    case "${existing_bind}" in
        ''|*[!0-9A-Za-z.:-]*) existing_bind="" ;;
    esac
    # 로컬 모드에서 실제 리슨 주소는 TABYBOT_HOST다 — TABYBOT_BIND(도커용)도
    # 동일 의미로 받아들이고, 둘 다 없으면 외부 접속이 되도록 0.0.0.0을 기본값으로 쓴다.
    if [ -n "${TABYBOT_HOST:-}" ]; then
        existing_host="${TABYBOT_HOST}"
    elif [ -n "${TABYBOT_BIND:-}" ]; then
        existing_host="${TABYBOT_BIND}"
    elif [ -z "${existing_host}" ]; then
        existing_host="${existing_bind}"
    fi
    case "${existing_host}" in
        ''|*[!0-9A-Za-z.:-]*) existing_host="0.0.0.0" ;;
    esac
    if [ "${mode}" = local ] && [ -f "${APP_DIR}/VERSION" ]; then
        version="$(tr -d '\n' <"${APP_DIR}/VERSION")"
    elif [ "${mode}" = local ] && [ -f "${ENV_FILE}" ]; then
        version="$(env_file_value TABYBOT_VERSION)"
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
        if [ -n "${existing_port}" ]; then
            printf 'TABYBOT_PORT=%s\n' "${existing_port}"
        fi
        if [ "${mode}" = docker ]; then
            printf 'TABYBOT_BIND=%s\n' "${existing_bind:-0.0.0.0}"
        else
            write_env_quoted TABYBOT_HOST "${existing_host}"
        fi
        # 로컬 설치의 소스 브랜치를 기억해 업데이트가 같은 브랜치를 따라가게 한다.
        if [ -n "${REPO_BRANCH}" ] && [ "${REPO_BRANCH}" != "main" ]; then
            printf 'TABYBOT_REPO_BRANCH=%s\n' "${REPO_BRANCH}"
        fi
    } >"${ENV_FILE}"
    chmod 600 "${ENV_FILE}"
}

pull_image() {
    local compose="$1" image="$2"
    local attempt=1 max_attempts=3

    if is_ko; then echo "==> 설치 파일 받는 중..."; else echo "==> Downloading tabyBot..."; fi

    while [ "${attempt}" -le "${max_attempts}" ]; do
        # pull 출력을 그대로 보여준다 — 오래 걸리는 다운로드가 멈춘 것처럼 보이지 않게.
        if ${compose} -f "${COMPOSE_FILE}" pull; then
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
    # tty에서는 진행 표시줄을 보여준다 — 다운로드가 오래 걸릴 때 멈춰 보이지 않게.
    if [ -t 2 ]; then
        curl -fL --progress-bar "${url}" -o "${tmp}"
    else
        curl -fsSL "${url}" -o "${tmp}"
    fi
    # 압축 해제가 성공한 뒤에만 기존 app을 지운다 — 네트워크/아카이브 실패가
    # 설치본을 통째로 날리지 않게.
    mkdir -p "${INSTALL_DIR}"
    if ! tar -xzf "${tmp}" -C "${INSTALL_DIR}" 2>/dev/null; then
        rm -f "${tmp}"
        die "$(if is_ko; then echo "소스 압축 해제에 실패했습니다."; else echo "Failed to extract source archive."; fi)"
    fi
    rm -f "${tmp}"
    rm -rf "${APP_DIR}"
    extracted="$(find "${INSTALL_DIR}" -maxdepth 1 -mindepth 1 -type d -name 'tabyBot-*' | head -1)"
    [ -n "${extracted}" ] || die "$(if is_ko; then echo "소스 압축 해제에 실패했습니다."; else echo "Failed to extract source archive."; fi)"
    mv "${extracted}" "${APP_DIR}"
}

update_local_source() {
    if [ -d "${APP_DIR}/.git" ] && command -v git >/dev/null 2>&1; then
        if is_ko; then echo "==> 소스 코드 업데이트 중..."; else echo "==> Updating source..."; fi
        git -C "${APP_DIR}" fetch origin "${REPO_BRANCH}" || git -C "${APP_DIR}" fetch origin || true
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
        git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${APP_DIR}" \
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

lan_ip() {
    case "$(uname -s)" in
        Darwin)
            ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
            ;;
        Linux)
            # outbound 경로의 src가 실제 LAN 주소 — hostname -I는 docker 브리지 IP를
            # 먼저 줄 수 있어 폴백으로만 쓴다.
            ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}' \
                || hostname -I 2>/dev/null | awk 'NF {print $1; exit}' || true
            ;;
    esac
}

print_access_info() {
    local mode="$1" port bind default_bind ip primary secondary
    port="$(env_file_value TABYBOT_PORT)"
    port="$(strip_env_scalar "${port}")"
    port="${port:-8999}"
    if is_ko; then
        echo "  브라우저에서 http://localhost:${port} 를 여세요."
    else
        echo "  Open http://localhost:${port} in your browser."
    fi
    if [ "${mode}" = local ]; then
        default_bind="0.0.0.0"
        primary="TABYBOT_HOST"
        secondary="TABYBOT_BIND"
    else
        default_bind="0.0.0.0"
        primary="TABYBOT_BIND"
        secondary="TABYBOT_HOST"
    fi
    bind="$(env_file_value "${primary}")"
    bind="$(strip_env_scalar "${bind}")"
    if [ -z "${bind}" ]; then
        bind="$(env_file_value "${secondary}")"
        bind="$(strip_env_scalar "${bind}")"
    fi
    bind="${bind:-${default_bind}}"
    case "${bind}" in
        127.*|localhost|::1) return 0 ;;
        0.0.0.0|::|"")
            ip="$(lan_ip)" ;;
        *)
            ip="${bind}" ;;
    esac
    if [ -n "${ip}" ]; then
        if is_ko; then echo "  외부 접속: http://${ip}:${port}"; else echo "  LAN access: http://${ip}:${port}"; fi
    fi
    if is_ko; then
        echo "  ⚠ 외부 접속이 열려 있습니다(${bind}). 첫 접속 화면에서 계정을 만들어 로그인을 요구하는 걸 권장합니다."
    else
        echo "  ⚠ Reachable from your network (${bind}). Create an account on the first-visit screen to require sign-in."
    fi
}

main() {
    resolve_lang
    local image="${TABYBOT_IMAGE:-${IMAGE_DEFAULT}}"

    if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
        usage
        exit 0
    fi

    # 업데이트 시 이전 설치의 브랜치를 이어받는다 (환경 변수가 우선).
    if [ -z "${REPO_BRANCH}" ] && [ -f "${ENV_FILE}" ]; then
        REPO_BRANCH="$(env_file_value TABYBOT_REPO_BRANCH)"
        REPO_BRANCH="$(strip_env_scalar "${REPO_BRANCH}")"
    fi
    REPO_BRANCH="${REPO_BRANCH:-main}"

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
        if is_ko; then echo "설치 완료 (${mode})."; else echo "Install complete (${mode})."; fi
    fi
    print_access_info "${mode}"
}

main "$@"
