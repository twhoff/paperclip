#!/usr/bin/env bash
# Sync local master with upstream (paperclipai/paperclip) and push to fork (origin)
set -euo pipefail

git fetch upstream
git checkout master
git merge upstream/master
git push origin master

echo "Fork synced with upstream."
