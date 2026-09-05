#!/bin/bash
# Template: Search and Extract
# Purpose: Search using camofox CLI and extract results
# Usage: ./search-and-extract.sh "search query" [engine]
# Engines: google, youtube, amazon, bing, reddit, duckduckgo, github, stackoverflow

set -euo pipefail

command -v camofox >/dev/null 2>&1 || { echo "Error: camofox not found. Install: npm install -g camofox-browser"; exit 1; }

QUERY="${1:?Usage: $0 \"search query\" [engine]}"
ENGINE="${2:-google}"
OUTPUT_FILE="${3:-./search_results.txt}"

VALID_ENGINES="google youtube amazon bing reddit duckduckgo github stackoverflow"
if ! echo "$VALID_ENGINES" | grep -qw "$ENGINE"; then
    echo "Error: Invalid engine '$ENGINE'"
    echo "Valid engines: $VALID_ENGINES"
    exit 1
fi

echo "=== Search and Extract ==="
echo "Query: $QUERY"
echo "Engine: $ENGINE"

# Start server if not running
camofox server start 2>/dev/null || true
sleep 1

camofox health >/dev/null 2>&1 || { echo "Error: camofox server not responding"; exit 1; }

# Perform search
echo "Searching..."
camofox search "$QUERY" --engine "$ENGINE"

# Wait for results
sleep 2
camofox wait networkidle

# Get results snapshot
echo "Extracting results..."
{
    echo "Search Query: $QUERY"
    echo "Engine: $ENGINE"
    echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "---"
    camofox snapshot
} > "$OUTPUT_FILE"

# Get links
echo ""
echo "Links found:"
camofox get-links

echo ""
echo "=== Search Complete ==="
echo "Results saved to: $OUTPUT_FILE"

# Cleanup
camofox close 2>/dev/null || true
