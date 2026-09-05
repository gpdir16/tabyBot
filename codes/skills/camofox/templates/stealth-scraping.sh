#!/bin/bash
# Template: Stealth Scraping
# Purpose: Scrape a target URL with anti-detection geo preset and human-like timing
# Usage: ./stealth-scraping.sh <url> [preset]
# Presets: us-east, us-west, japan, uk, germany, vietnam, singapore, australia

set -euo pipefail

command -v camofox >/dev/null 2>&1 || { echo "Error: camofox not found. Install: npm install -g camofox-browser"; exit 1; }

URL="${1:?Usage: $0 <url> [preset]}"
PRESET="${2:-us-east}"
OUTPUT_DIR="${3:-./scraped}"

echo "=== Stealth Scraping ==="
echo "URL: $URL"
echo "Preset: $PRESET"

# Ensure output directory
mkdir -p "$OUTPUT_DIR"

# Start server if not running
camofox server start 2>/dev/null || true
sleep 1

# Health check
camofox health >/dev/null 2>&1 || { echo "Error: camofox server not responding"; exit 1; }

# Open URL (server applies anti-detection automatically via Camoufox engine)
echo "Opening with preset: $PRESET..."
camofox open "$URL" --geo "$PRESET"

# Human-like delay
sleep $((RANDOM % 3 + 2))

# Wait for page load
camofox wait networkidle
sleep 1

# Take snapshot
echo "Taking snapshot..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
camofox snapshot > "$OUTPUT_DIR/snapshot_${TIMESTAMP}.txt"

# Extract page text
echo "Extracting text..."
camofox get-text > "$OUTPUT_DIR/text_${TIMESTAMP}.txt"

# Take screenshot as evidence
camofox screenshot --output "$OUTPUT_DIR/screenshot_${TIMESTAMP}.png"

# Get current URL (may have redirected)
FINAL_URL=$(camofox get-url)
echo "Final URL: $FINAL_URL"

# Save metadata
cat > "$OUTPUT_DIR/metadata_${TIMESTAMP}.json" << METAEOF
{
  "url": "$URL",
  "final_url": "$FINAL_URL",
  "preset": "$PRESET",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "files": {
    "snapshot": "snapshot_${TIMESTAMP}.txt",
    "text": "text_${TIMESTAMP}.txt",
    "screenshot": "screenshot_${TIMESTAMP}.png"
  }
}
METAEOF

echo ""
echo "=== Scraping Complete ==="
echo "Output: $OUTPUT_DIR/"
ls -la "$OUTPUT_DIR/"

# Cleanup
camofox close 2>/dev/null || true
