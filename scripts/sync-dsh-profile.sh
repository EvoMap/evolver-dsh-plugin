#!/usr/bin/env bash
set -euo pipefail

# pnpm installs this package into the profile as a hardlink snapshot, so file
# *additions* and *deletions* never reach node_modules and boot dies with
# ERR_MODULE_NOT_FOUND. Re-running `pnpm add` is not an option: the lockfile
# pins @deepseek-ai/dsh-llm >=0.1.5 and the registry only publishes 0.0.1-rc.1.

profile_name="${1:-dsh-tui}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile_dir="${DSH_HOME:-$HOME/.dsh}/profiles/$profile_name"
package_name="$(node -p "require('$repo_dir/package.json').name")"
link_path="$profile_dir/node_modules/$package_name"

if [ ! -e "$link_path" ]; then
  echo "not installed in profile '$profile_name': $link_path" >&2
  exit 1
fi

snapshot_dir="$(cd "$link_path" && pwd -P)"

if [ "$snapshot_dir" = "$repo_dir" ]; then
  echo "profile '$profile_name' already points at the source tree — nothing to sync"
  exit 0
fi

linked=0
pruned=0

for entry in $(node -p "require('$repo_dir/package.json').files.join('\n')"); do
  [ -d "$repo_dir/$entry" ] || continue

  (cd "$repo_dir/$entry" && find . -type d -print0) \
    | (cd "$snapshot_dir/$entry" && xargs -0 mkdir -p)

  while IFS= read -r -d '' file; do
    if [ ! -e "$snapshot_dir/$entry/$file" ] \
      || [ "$(stat -f %i "$repo_dir/$entry/$file")" != "$(stat -f %i "$snapshot_dir/$entry/$file")" ]; then
      ln -f "$repo_dir/$entry/$file" "$snapshot_dir/$entry/$file"
      linked=$((linked + 1))
    fi
  done < <(cd "$repo_dir/$entry" && find . -type f -print0)

  while IFS= read -r -d '' file; do
    if [ ! -e "$repo_dir/$entry/$file" ]; then
      rm -f "$snapshot_dir/$entry/$file"
      pruned=$((pruned + 1))
    fi
  done < <(cd "$snapshot_dir/$entry" && find . -type f -print0)
done

echo "synced $package_name -> $profile_name: $linked linked, $pruned pruned"
