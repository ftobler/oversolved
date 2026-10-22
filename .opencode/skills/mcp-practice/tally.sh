#!/usr/bin/env bash
# Fold the practice reports into one view: run outcomes, then every finding
# grouped by kind and symptom key, most frequent first, with the runs that hit it.
set -euo pipefail

repo="$(readlink -f "$(dirname "$(readlink -f "$0")")/../../..")"
runs="$repo/bugreports/mcp-practice"
shopt -s nullglob
reports=("$runs"/*/report.md)
claimed=("$runs"/*/)

echo "claimed: ${#claimed[@]}  reported: ${#reports[@]}"
((${#reports[@]})) || exit 0

echo
echo "outcomes:"
grep -h '^outcome:' "${reports[@]}" | sort | uniq -c | sort -rn

echo
echo "findings (count, kind, symptom key, runs):"
for report in "${reports[@]}"; do
  slug="$(basename "$(dirname "$report")")"
  awk -v slug="$slug" '
    /^- kind:/        { kind = $3 }
    /^- symptom key:/ { sub(/^- symptom key: */, ""); print kind "\t" $0 "\t" slug }
  ' "$report"
done | sort | awk -F'\t' '
  { key = $1 "\t" $2; n[key]++; who[key] = who[key] (who[key] ? ", " : "") $3 }
  END { for (k in n) printf "%4d\t%s\t%s\n", n[k], k, who[k] }
' | sort -rn
