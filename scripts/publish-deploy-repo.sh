#!/usr/bin/env bash
# Publishes releases to the deploy repository: one commit per release holding exactly its
# -deploy.tar.gz, plus docker/deploy-repo/* and LICENSE. A stable release lands on main and on
# next, a prerelease on next alone, so both branches only fast-forward. Already-tagged releases
# are skipped, which makes a re-run and the backfill safe.
#
#   publish-deploy-repo.sh v3.6.1 [v3.7.0 ...]     oldest first
#
# GH_TOKEN writes to DEPLOY_REPO; SOURCE_GH_TOKEN reads SOURCE_REPO's releases. Commits go through
# createCommitOnBranch, which GitHub signs - a git push from here would land unverified.
set -euo pipefail

: "${DEPLOY_REPO:?}" "${SOURCE_REPO:?}" "${SOURCE_GH_TOKEN:?}" "${GH_TOKEN:?}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Empty for a missing branch. gh prints a 404's body to stdout, so the exit status decides.
head_of() {
  local sha
  sha="$(gh api "repos/${DEPLOY_REPO}/git/ref/heads/$1" --jq .object.sha 2>/dev/null)" && echo "$sha"
  return 0
}

# commit <branch> <staging> <message> - prints the commit the branch ends on.
commit() {
  local branch="$1" staging="$2" message="$3" head changes
  head="$(head_of "$branch")"
  [ -n "$head" ] || { echo "::error::${DEPLOY_REPO} has no ${branch} branch" >&2; return 1; }

  # path<TAB>blob sha, for both sides; equal blob shas mean nothing to send.
  gh api "repos/${DEPLOY_REPO}/git/trees/${head}?recursive=1" \
    --jq '.tree[] | select(.type == "blob") | "\(.path)\t\(.sha)"' | sort >"$work/remote"
  (cd "$staging" && find . -type f | sed 's#^\./##' | sort | while IFS= read -r path; do
    printf '%s\t%s\n' "$path" "$(git hash-object "$path")"
  done) >"$work/local"

  changes="$(jq -n \
    --rawfile remote "$work/remote" --rawfile local "$work/local" --arg staging "$staging" '
      def table(s): s | split("\n") | map(select(. != "") | split("\t") | {(.[0]): .[1]}) | add // {};
      table($remote) as $r | table($local) as $l
      | { additions: [$l | to_entries[] | select($r[.key] != .value) | .key],
          deletions: [$r | keys[] | select($l[.] == null) | {path: .}] }')"

  if [ "$(jq '(.additions | length) + (.deletions | length)' <<<"$changes")" = 0 ]; then
    echo "$head"
    return
  fi

  # Contents are base64, built by file so a large tree never lands on a command line.
  : >"$work/additions"
  for path in $(jq -r '.additions[]' <<<"$changes"); do
    jq -n --arg path "$path" --rawfile contents <(base64 -w0 "$staging/$path") \
      '{path: $path, contents: $contents}' >>"$work/additions"
  done

  jq -n \
    --arg repo "$DEPLOY_REPO" --arg branch "$branch" --arg head "$head" \
    --arg headline "${message%%$'\n'*}" --arg body "${message#*$'\n'}" \
    --argjson deletions "$(jq '.deletions' <<<"$changes")" \
    --slurpfile additions "$work/additions" '{
      query: "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
      variables: { input: {
        branch: { repositoryNameWithOwner: $repo, branchName: $branch },
        expectedHeadOid: $head,
        message: { headline: $headline, body: $body },
        fileChanges: { additions: $additions, deletions: $deletions } } } }' >"$work/request.json"

  gh api graphql --input "$work/request.json" --jq .data.createCommitOnBranch.commit.oid
}

for tag in "$@"; do
  if gh api "repos/${DEPLOY_REPO}/git/ref/tags/${tag}" >/dev/null 2>&1; then
    echo "${tag}: already published"
    continue
  fi

  staging="$work/${tag}"
  mkdir -p "$staging"
  if ! GH_TOKEN="$SOURCE_GH_TOKEN" gh release download "$tag" --repo "$SOURCE_REPO" \
    --pattern '*-deploy.tar.gz' --dir "$work/archive-${tag}"; then
    echo "::warning::${tag} has no deploy archive - not published"
    continue
  fi
  tar -xzf "$work/archive-${tag}"/*-deploy.tar.gz -C "$staging"
  cp "$root/docker/deploy-repo/README.md" "$root/docker/deploy-repo/.gitignore" "$root/LICENSE" "$staging/"

  # GitHub adds the blank line between headline and body itself.
  message="${tag}"$'\n'"https://github.com/${SOURCE_REPO}/releases/tag/${tag}"

  # The first prerelease has no next yet: it starts from main.
  if [ -z "$(head_of next)" ]; then
    gh api "repos/${DEPLOY_REPO}/git/refs" -f ref=refs/heads/next -f sha="$(head_of main)" >/dev/null
  fi

  case "$tag" in
    *-*)
      at="$(commit next "$staging" "$message")"
      ;;
    *)
      at="$(commit main "$staging" "$message")"
      commit next "$staging" "$message" >/dev/null
      ;;
  esac

  gh api "repos/${DEPLOY_REPO}/git/refs" -f ref="refs/tags/${tag}" -f sha="$at" >/dev/null
  echo "${tag}: published at ${at}"
done
