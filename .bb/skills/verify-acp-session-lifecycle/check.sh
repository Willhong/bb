#!/usr/bin/env bash
# Model-check the ACP session lifecycle model. Usage: check.sh [CheckName ...]
# Exit 0 only when every requested check passes. Prints the failing steps.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
TLA_VERSION="v1.7.4"
TLA_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
jar="${TLA2TOOLS_JAR:-$HOME/.local/share/tlaplus/$TLA_VERSION/tla2tools.jar}"
if [ ! -f "$jar" ]; then
  echo "tla2tools.jar $TLA_VERSION not found at $jar" >&2
  echo "install: mkdir -p \"$(dirname "$jar")\" && gh release download $TLA_VERSION -R tlaplus/tlaplus -p tla2tools.jar -D \"$(dirname "$jar")\"" >&2
  exit 2
fi
actual="$(shasum -a 256 "$jar" | cut -d' ' -f1)"
[ "$actual" = "$TLA_SHA256" ] || { echo "tla2tools.jar checksum mismatch: $actual" >&2; exit 2; }

checks=("$@")
[ ${#checks[@]} -gt 0 ] || checks=(NoOrphan StopDuringRebuild StopDuringFreshStart)
meta="$(mktemp -d)"; trap 'rm -rf "$meta"' EXIT
status=0
for check in "${checks[@]}"; do
  out="$meta/$check.out"
  set +e
  java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -config "$here/model/$check.cfg" \
    -metadir "$meta/$check" -workers 1 -deadlock "$here/model/AcpSessionLifecycle.tla" >"$out" 2>&1
  code=$?
  set -e
  states="$(grep -Eo '[0-9]+ distinct states found' "$out" | tail -1 || true)"
  if [ $code -eq 0 ]; then
    echo "PASS $check ($states)"
  else
    status=1
    violated="$(grep -Eo 'Invariant [A-Za-z]+ is violated' "$out" | head -1 || true)"
    echo "FAIL $check: ${violated:-TLC exit $code, see below}"
    if [ -n "$violated" ]; then
      echo "  steps:"
      grep -Eo '^State [0-9]+: <[A-Za-z]+' "$out" | sed -E 's/^State ([0-9]+): <(.*)/    \1. \2/'
      echo "  last state:"
      awk '/^State [0-9]+:/{buf=""} /^\/\\/{buf=buf"    "$0"\n"} END{printf "%s", buf}' "$out"
    else
      tail -20 "$out"
    fi
  fi
done
exit $status
