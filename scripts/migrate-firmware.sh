#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/migrate-firmware.sh
#
# Downloads all KB1 firmware .bin files from the PocketMidi/KB1 GitHub
# releases and generates public/firmware/releases.json.
#
# Requirements: curl, jq
# Optional:     GITHUB_TOKEN env var to avoid rate-limiting (60 req/hr anon)
#
# Usage:
#   cd /path/to/kb1-flash
#   bash scripts/migrate-firmware.sh
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="PocketMidi/KB1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/../public/firmware"
RELEASES_JSON="$OUTPUT_DIR/releases.json"
API_BASE="https://api.github.com/repos/$REPO"

mkdir -p "$OUTPUT_DIR"

# Optional auth header – set GITHUB_TOKEN to avoid 60 req/hr rate limit
AUTH_HEADER=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH_HEADER="-H \"Authorization: token $GITHUB_TOKEN\""
    echo "Using GITHUB_TOKEN for authentication"
fi

api_get() {
    local url="$1"
    if [ -n "$AUTH_HEADER" ]; then
        curl -sfL -H "Authorization: token $GITHUB_TOKEN" \
             -H "Accept: application/vnd.github+json" \
             "$url"
    else
        curl -sfL -H "Accept: application/vnd.github+json" "$url"
    fi
}

echo "Fetching releases from $REPO..."
RELEASES=$(api_get "$API_BASE/releases?per_page=50")

RELEASE_COUNT=$(echo "$RELEASES" | jq 'length')
echo "Found $RELEASE_COUNT release(s)"

MANIFEST="[]"
DOWNLOADED=0
SKIPPED=0

while IFS= read -r release_json; do
    TAG=$(echo "$release_json" | jq -r '.tag_name')
    NAME=$(echo "$release_json" | jq -r '.name // .tag_name')
    DATE=$(echo "$release_json" | jq -r '.published_at | split("T")[0]')

    # Find first .bin asset that isn't a bootloader
    ASSET_JSON=$(echo "$release_json" | jq -c '
        .assets[]
        | select(.name | endswith(".bin"))
        | select(.name | contains("bootloader") | not)
    ' | head -1)

    if [ -z "$ASSET_JSON" ]; then
        echo "  $TAG: no .bin asset — skipping"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    FILENAME=$(echo "$ASSET_JSON" | jq -r '.name')
    DOWNLOAD_URL=$(echo "$ASSET_JSON" | jq -r '.browser_download_url')
    DEST="$OUTPUT_DIR/$FILENAME"

    if [ -f "$DEST" ]; then
        echo "  $TAG: $FILENAME already exists — skipping download"
    else
        echo "  $TAG: downloading $FILENAME ..."
        # -L follows redirects (GitHub assets redirect to CDN)
        curl -fL --progress-bar -o "$DEST" "$DOWNLOAD_URL"
    fi

    SIZE=$(wc -c < "$DEST" | tr -d ' ')

    ENTRY=$(jq -n \
        --arg version "$TAG" \
        --arg name "$NAME" \
        --arg date "$DATE" \
        --arg filename "$FILENAME" \
        --argjson size "$SIZE" \
        '{"version":$version,"name":$name,"date":$date,"filename":$filename,"size":$size}')

    MANIFEST=$(echo "$MANIFEST" | jq ". + [$ENTRY]")
    DOWNLOADED=$((DOWNLOADED + 1))
    echo "     → $SIZE bytes"

done < <(echo "$RELEASES" | jq -c '.[]')

# Sort newest first (releases come newest-first from API, so order is preserved)
echo "$MANIFEST" | jq '.' > "$RELEASES_JSON"

echo ""
echo "Migration complete"
echo "  Downloaded : $DOWNLOADED release(s)"
echo "  Skipped    : $SKIPPED release(s)"
echo "  Manifest   : $RELEASES_JSON"
