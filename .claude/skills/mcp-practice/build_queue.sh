#!/usr/bin/env bash
# Regenerate scratch/mcp-practice/queue.tsv: one practice item per example
# source file, with the license of the collection it came from (read from that
# collection's SOURCE.md). Run from anywhere; queue paths are repo-relative.
set -euo pipefail

repo="$(readlink -f "$(dirname "$(readlink -f "$0")")/../../..")"
examples="scratch/code-cad-examples"
here="$repo/scratch/mcp-practice"
mkdir -p "$here" "$repo/bugreports/mcp-practice"

# Library internals and ML tooling, not models: nothing to rebuild there.
skip_collections='onshape-std-library-mirror|Fusion360GalleryDataset|Text2CAD|cad-recode'

{
  printf 'path\tlanguage\tlicense\n'
  for dir in "$repo/$examples"/*/*/; do
    collection="$(basename "$dir")"
    [[ "$collection" =~ ^($skip_collections)$ ]] && continue
    license="$(grep -m1 '^| \*\*License' "$dir/SOURCE.md" 2>/dev/null \
      | sed 's/.*| \*\*License\*\* | //; s/ |$//; s/\*\*//g' || true)"
    find "$dir" -type f \( -name '*.py' -o -name '*.scad' -o -name '*.kcl' \
        -o -name '*.tcl' -o -name '*.js' -o -name '*.jscad' -o -name '*.fs' \) \
      ! -name 'conf.py' ! -name 'setup.py' ! -name '__init__.py' ! -name 'test_*.py' \
      ! -path '*/node_modules/*' ! -path '*/tests/*' ! -path '*/test/*' \
      | sort | while read -r file; do
        printf '%s\t%s\t%s\n' "${file#"$repo"/}" "${file##*.}" "${license:-unknown}"
      done
  done
} > "$here/queue.tsv"

echo "$(($(wc -l < "$here/queue.tsv") - 1)) items -> $here/queue.tsv"
