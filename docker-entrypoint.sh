#!/bin/sh
set -e
cd /app

# 브라우저 캐시는 이미지의 /opt/camoufox에 있고, /app/user/.cache/camoufox는
# 그곳을 가리키는 심볼릭 링크다. 볼륨/바인드 마운트로 링크가 없어진 경우 복구한다.
if [ ! -e /app/user/.cache/camoufox ] && [ -d /opt/camoufox ]; then
  mkdir -p /app/user/.cache
  ln -sfn /opt/camoufox /app/user/.cache/camoufox
fi

case "$1" in
  start|"")
    exec node codes/index.js
    ;;
  *)
    exec "$@"
    ;;
esac
