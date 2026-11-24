#!/usr/bin/env sh
set -eu

usage() {
  echo "Usage: sh scripts/check-full.sh frontend|rust|docs|all"
  echo "Runs the selected full checks sequentially. These checks can use substantial memory."
}

case "${1:-}" in
  frontend|rust|docs|all) area="$1" ;;
  ""|-h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

frontend() {
  echo "→ frontend: lint, catalogs, typecheck, build and tests"
  pnpm lint
  pnpm i18n:types:check
  pnpm i18n:validate --locale zh-Hans
  pnpm build
  pnpm exec vitest run --maxWorkers=1
}

rust() {
  echo "→ rust: format, Clippy and tests with one compilation job"
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --jobs 1 -- -D warnings
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      OLEAFLY_EMBED_TEST_MANIFEST=1 cargo test --workspace --lib --jobs 1
      cargo test -p oleafly-cli --test cli --jobs 1
      ;;
    *)
      cargo test --workspace --all-targets --jobs 1
      ;;
  esac
}

docs() {
  echo "→ docs: build site"
  (cd docsite && pnpm build)
}

case "$area" in
  frontend) frontend ;;
  rust) rust ;;
  docs) docs ;;
  all) frontend; rust; docs ;;
esac
