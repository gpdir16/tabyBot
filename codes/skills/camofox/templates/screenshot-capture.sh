#!/bin/bash
# Template: Screenshot Capture
# Purpose: Navigate to URL and capture screenshots with options
# Usage: ./screenshot-capture.sh <url> [output-dir]

set -euo pipefail

command -v camofox >/dev/null 2>&1 || { echo "Error: camofox not found. Install: npm install -g camofox-browser"; exit 1; }

URL="${1:?Usage: $0 <url> [output-dir]}"
OUTPUT_DIR="${2:-./screenshots}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "=== Screenshot Capture ==="
echo "URL: $URL"
echo "Output: $OUTPUT_DIR/"

mkdir -p "$OUTPUT_DIR"

# Start server if not running
camofox server start 2>/dev/null || true
sleep 1

camofox health >/dev/null 2>&1 || { echo "Error: camofox server not responding"; exit 1; }

# Navigate
echo "Opening URL..."
camofox open "$URL"
camofox wait networkidle
sleep 1

# Get page info
TITLE=$(camofox get-url)
echo "Page loaded: $TITLE"

# Viewport screenshot
echo "Taking viewport screenshot..."
camofox screenshot --output "$OUTPUT_DIR/viewport_${TIMESTAMP}.png"

# Full page screenshot
echo "Taking full-page screenshot..."
camofox screenshot --full-page --output "$OUTPUT_DIR/fullpage_${TIMESTAMP}.png"

# Save page info
{
    echo "URL: $URL"
    echo "Final URL: $(camofox get-url)"
    echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo ""
    echo "Files:"
    echo "  Viewport: viewport_${TIMESTAMP}.png"
    echo "  Full page: fullpage_${TIMESTAMP}.png"
} > "$OUTPUT_DIR/capture_${TIMESTAMP}.txt"

echo ""
echo "=== Capture Complete ==="
echo "Files:"
ls -la "$OUTPUT_DIR/"*"${TIMESTAMP}"* 2>/dev/null

# Cleanup
camofox close 2>/dev/null || true
