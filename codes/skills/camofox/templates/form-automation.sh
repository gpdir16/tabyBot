#!/bin/bash
# Template: Form Automation
# Purpose: Fill and submit web forms with snapshot-interact-verify pattern
# Usage: ./form-automation.sh <form-url>

set -euo pipefail

command -v camofox >/dev/null 2>&1 || { echo "Error: camofox not found. Install: npm install -g camofox-browser"; exit 1; }

FORM_URL="${1:?Usage: $0 <form-url>}"

echo "=== Form Automation ==="
echo "URL: $FORM_URL"

# Start server if not running
camofox server start 2>/dev/null || true
sleep 1

camofox health >/dev/null 2>&1 || { echo "Error: camofox server not responding"; exit 1; }

# Step 1: Navigate to form
echo "Opening form..."
camofox open "$FORM_URL"
camofox wait networkidle

# Step 2: Snapshot to discover form elements
echo ""
echo "Form structure:"
echo "---"
camofox snapshot
echo "---"

# Step 3: Fill form fields
# Customize these refs based on snapshot output above.
#
# Common patterns:
#   camofox fill '[e1]="John Doe"'           # Text input (ref e1)
#   camofox fill '[e2]="user@example.com"'   # Email input
#   camofox fill '[e3]="SecureP@ss123"'      # Password input
#   camofox select [e4] "Option Value"       # Dropdown
#   camofox click [e5]                       # Submit button
#
# Uncomment and modify:
# camofox fill '[e1]="Test User" [e2]="test@example.com"'
# camofox click [e3]

# Step 4: Wait for submission
# camofox wait networkidle

# Step 5: Verify result
echo ""
echo "Current state:"
camofox get-url
camofox snapshot

# Step 6: Capture evidence
camofox screenshot --output /tmp/form-result.png
echo "Screenshot saved: /tmp/form-result.png"

# Cleanup
camofox close 2>/dev/null || true
echo "Done"
