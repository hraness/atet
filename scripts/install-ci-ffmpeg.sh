#!/usr/bin/env bash

set -euo pipefail

if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  ffmpeg -version
  ffprobe -version
  exit 0
fi

readonly apt_mirror_file="/etc/apt/apt-mirrors.txt"
if [[ -f "$apt_mirror_file" ]]; then
  printf '%s\n' \
    'https://archive.ubuntu.com/ubuntu/ priority:1' \
    'https://security.ubuntu.com/ubuntu/ priority:2' \
    'http://azure.archive.ubuntu.com/ubuntu/ priority:3' \
    | sudo tee "$apt_mirror_file" >/dev/null
fi

readonly -a apt_network_options=(
  -o Acquire::Retries=2
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
)

sudo env DEBIAN_FRONTEND=noninteractive timeout --signal=TERM --kill-after=10s 180s \
  apt-get "${apt_network_options[@]}" update
sudo env DEBIAN_FRONTEND=noninteractive timeout --signal=TERM --kill-after=10s 600s \
  apt-get "${apt_network_options[@]}" install --yes --no-install-recommends ffmpeg

ffmpeg -version
ffprobe -version
