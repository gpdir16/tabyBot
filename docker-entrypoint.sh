#!/bin/sh
set -e
cd /app

case "$1" in
  start|"")
    exec node codes/index.js
    ;;
  *)
    exec "$@"
    ;;
esac
