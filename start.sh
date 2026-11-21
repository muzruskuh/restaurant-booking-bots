#!/usr/bin/env bash
# Запуск для Render Web Service: health-сервер + оба бота параллельно.
set -e
echo "Starting health server + bots..."
node health.cjs &
HPID=$!
node bot-incoming.cjs &
PID1=$!
node bot-outgoing.cjs &
PID2=$!
echo "Running: health=$HPID incoming=$PID1 outgoing=$PID2"
# ждём любой процесс — если один упадёт, Render перезапустит сервис
wait -n 2>/dev/null || wait