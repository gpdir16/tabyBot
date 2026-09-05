#!/bin/bash
# Template: Authenticated Session
# Purpose: Login using Auth Vault, save state, reuse for subsequent runs
# Usage: ./authenticated-session.sh <profile-name> <login-url>
#
# RECOMMENDED: Use Auth Vault to store credentials securely:
#   camofox auth save myprofile --url https://example.com/login
#   camofox auth load myprofile
#
# Two modes:
#   1. Discovery mode (default): Shows login form structure
#   2. Login mode: Uses Auth Vault saved credentials

set -euo pipefail

command -v camofox >/dev/null 2>&1 || { echo "Error: camofox not found. Install: npm install -g camofox-browser"; exit 1; }

PROFILE="${1:?Usage: $0 <profile-name> <login-url>}"
LOGIN_URL="${2:?Usage: $0 <profile-name> <login-url>}"

echo "=== Authenticated Session ==="
echo "Profile: $PROFILE"
echo "Login URL: $LOGIN_URL"

# Start server if not running
camofox server start 2>/dev/null || true
sleep 1

camofox health >/dev/null 2>&1 || { echo "Error: camofox server not responding"; exit 1; }

# Check if profile exists in Auth Vault
if camofox auth list 2>/dev/null | grep -q "$PROFILE"; then
    echo "Found saved profile: $PROFILE"
    echo "Loading credentials and logging in..."

    # Load auth profile (auto-navigates and fills credentials)
    camofox auth load "$PROFILE"

    # Wait for login to complete
    sleep 2
    camofox wait networkidle

    # Verify login succeeded
    CURRENT_URL=$(camofox get-url)
    if echo "$CURRENT_URL" | grep -qiE "login|signin|sign-in"; then
        echo "Warning: Still on login page. Login may have failed."
        echo "Current URL: $CURRENT_URL"
        camofox snapshot
        exit 1
    fi

    echo "Login successful!"
    echo "Current URL: $CURRENT_URL"
    camofox snapshot
else
    # Discovery mode: show form structure
    echo ""
    echo "Profile '$PROFILE' not found in Auth Vault."
    echo "Running discovery mode to show login form structure..."
    echo ""

    camofox open "$LOGIN_URL"
    camofox wait networkidle
    sleep 1

    echo "Login form structure:"
    echo "---"
    camofox snapshot
    echo "---"
    echo ""
    echo "Next steps:"
    echo "  1. Note the form field refs (e.g., e1=username, e2=password)"
    echo "  2. Save credentials to Auth Vault:"
    echo "     camofox auth save $PROFILE --url $LOGIN_URL"
    echo "     (then enter username/password when prompted)"
    echo "  3. Run this script again to auto-login"

    camofox close 2>/dev/null || true
fi
