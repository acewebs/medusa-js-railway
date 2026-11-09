#!/usr/bin/env bash
#
# Creates the storage bucket for this project and wires its credentials into the
# three services that need them: both Medusa services upload to it, and the media
# proxy reads from it.
#
# Why this is not in .railway/railway.ts: as of Railway CLI 5.49.2, a bucket()
# declared there reports "applied" and then does not exist, leaving every S3_*
# reference resolving to an empty string. Medusa would fall back to the container
# filesystem and every upload would vanish on the next deploy. The CLI's own
# bucket command works, so the bucket is created here and the IaC file marks those
# variables preserve() so it will not overwrite them.
#
# Usage:  scripts/railway-bucket.sh [region]
#         region is one of sjc (US West), iad (US East), ams (EU West), sin (Asia
#         Pacific). It cannot be changed after the bucket is created.

set -euo pipefail

RAILWAY="${RAILWAY:-railway}"
# Defaults to the region declared in .railway/railway.ts. Keep them in step.
REGION="${1:-ams}"
SERVICES=("medusa-backend" "medusa-worker" "media-proxy")

if ! command -v "$RAILWAY" >/dev/null 2>&1; then
  echo "error: the railway CLI is not on PATH. See https://docs.railway.com/cli" >&2
  exit 1
fi

bucket_names() {
  "$RAILWAY" bucket list --json |
    python3 -c 'import json,sys; print("\n".join(b["name"] for b in json.load(sys.stdin)))'
}

# Not tolerated with `|| true`: if this listing fails, every pre-existing bucket
# looks new a moment later and the script would rename and rewire one of them.
if ! before="$(bucket_names)"; then
  echo "error: could not list the project's buckets. Check 'railway bucket list'." >&2
  exit 1
fi

echo "==> creating bucket"
"$RAILWAY" bucket create --region "$REGION"

# Railway generates the bucket's name and prints nothing machine readable, so the
# only way to learn it is to diff against what existed a moment ago.
after="$(bucket_names)"
new="$(comm -13 <(printf '%s\n' "$before" | sort) <(printf '%s\n' "$after" | sort))"
count="$(printf '%s\n' "$new" | grep -c .)"

if [ "$count" -eq 0 ]; then
  echo "error: no new bucket appeared. Check 'railway bucket list'." >&2
  exit 1
fi

# Someone else creating a bucket in this project at the same moment would leave
# two. Stop rather than guess, because the wrong guess rewires an unrelated
# bucket into these services.
if [ "$count" -gt 1 ]; then
  echo "error: $count new buckets appeared, so which one this created is ambiguous:" >&2
  printf '%s\n' "$new" >&2
  echo "Wire the right one in by hand, or delete the others and re-run." >&2
  exit 1
fi

name="$new"

# Match the name .railway/railway.ts declares, so a later `railway config apply`
# adopts this bucket rather than offering to delete it.
if [ "$name" != "Bucket" ]; then
  echo "==> renaming $name to Bucket"
  "$RAILWAY" bucket rename -b "$name" -n Bucket
  name="Bucket"
fi

for svc in "${SERVICES[@]}"; do
  echo "==> wiring $name into '$svc'"
  "$RAILWAY" variables --service "$svc" --skip-deploys \
    --set "S3_BUCKET=\${{$name.BUCKET}}" \
    --set "S3_ENDPOINT=\${{$name.ENDPOINT}}" \
    --set "S3_REGION=\${{$name.REGION}}" \
    --set "S3_ACCESS_KEY_ID=\${{$name.ACCESS_KEY_ID}}" \
    --set "S3_SECRET_ACCESS_KEY=\${{$name.SECRET_ACCESS_KEY}}"
done

echo
echo "Done. Redeploy the services to pick the variables up:"
for svc in "${SERVICES[@]}"; do
  echo "    railway redeploy --service '$svc'"
done
