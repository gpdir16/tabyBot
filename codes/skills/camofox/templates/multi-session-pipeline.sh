#!/bin/bash
# Template: Multi-Session Pipeline
# Purpose: Run multiple browser sessions concurrently via API for parallel data collection
# Usage: ./multi-session-pipeline.sh <url1> <url2> [url3...]

set -euo pipefail

command -v camofox >/dev/null 2>&1 || { echo "Error: camofox not found. Install: npm install -g camofox-browser"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Error: curl not found"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "Error: jq not found. Install: brew install jq"; exit 1; }

if [ $# -lt 2 ]; then
    echo "Usage: $0 <url1> <url2> [url3...]"
    echo "Example: $0 https://site-a.com https://site-b.com https://site-c.com"
    exit 1
fi

BASE_URL="http://localhost:9377"
OUTPUT_DIR="./multi-session-output"
URLS=("$@")

echo "=== Multi-Session Pipeline ==="
echo "Sessions: ${#URLS[@]}"
echo "Output: $OUTPUT_DIR/"

mkdir -p "$OUTPUT_DIR"

# Start server if not running
camofox server start 2>/dev/null || true
sleep 1

# Health check
curl -sf "$BASE_URL/health" >/dev/null || { echo "Error: camofox server not responding at $BASE_URL"; exit 1; }

# Create sessions and open URLs
declare -a SESSION_IDS
for i in "${!URLS[@]}"; do
    USER_ID="session-$(( i + 1 ))"
    URL="${URLS[$i]}"
    SESSION_IDS+=("$USER_ID")
    
    echo "[$USER_ID] Opening: $URL"
    
    # Open tab in session
    curl -sf -X POST "$BASE_URL/tabs/open" \
        -H "Content-Type: application/json" \
        -d "{\"url\": \"$URL\", \"userId\": \"$USER_ID\"}" \
        > /dev/null
done

# Wait for all pages to load
echo "Waiting for pages to load..."
sleep 5

# Collect data from each session
echo ""
echo "Collecting data..."
for i in "${!SESSION_IDS[@]}"; do
    USER_ID="${SESSION_IDS[$i]}"
    URL="${URLS[$i]}"
    
    echo "[$USER_ID] Extracting data..."
    
    # Get tabs for this session
    TABS=$(curl -sf "$BASE_URL/tabs?userId=$USER_ID" 2>/dev/null || echo "[]")
    TAB_ID=$(echo "$TABS" | jq -r '.tabs[0].tabId // .tabs[0].targetId // empty')
    
    if [ -n "$TAB_ID" ]; then
        # Get snapshot
        SNAPSHOT=$(curl -sf "$BASE_URL/tabs/$TAB_ID/snapshot?userId=$USER_ID" 2>/dev/null || echo "")
        echo "$SNAPSHOT" > "$OUTPUT_DIR/${USER_ID}_snapshot.txt"
        
        # Take screenshot
        curl -sf "$BASE_URL/tabs/$TAB_ID/screenshot?userId=$USER_ID" \
            -o "$OUTPUT_DIR/${USER_ID}_screenshot.png" 2>/dev/null || true
        
        echo "[$USER_ID] Data saved"
    else
        echo "[$USER_ID] Warning: No tab found"
    fi
done

# Cleanup sessions
echo ""
echo "Cleaning up sessions..."
for USER_ID in "${SESSION_IDS[@]}"; do
    curl -sf -X DELETE "$BASE_URL/sessions/$USER_ID" > /dev/null 2>&1 || true
done

echo ""
echo "=== Pipeline Complete ==="
echo "Output directory: $OUTPUT_DIR/"
ls -la "$OUTPUT_DIR/"
