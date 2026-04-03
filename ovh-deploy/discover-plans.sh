#!/usr/bin/env bash
set -euo pipefail

# ── OVH US — Discover VPS plan codes + config labels ─────────────────────────
# Usage:
#   export OVH_APP_KEY=xxx OVH_APP_SECRET=xxx OVH_CONSUMER_KEY=xxx
#   ./discover-plans.sh
#
# This script charges NOTHING. It creates a temporary cart, lists all available
# VPS plans and their required configuration labels, then deletes the cart.
# Run this first to get the exact values needed for order-vps.sh.
# ─────────────────────────────────────────────────────────────────────────────

API_URL="https://eu.api.ovh.com"
APP_KEY="${OVH_APP_KEY:?Missing OVH_APP_KEY}"
APP_SECRET="${OVH_APP_SECRET:?Missing OVH_APP_SECRET}"
CONSUMER_KEY="${OVH_CONSUMER_KEY:?Missing OVH_CONSUMER_KEY}"
OVH_SUBSIDIARY="${OVH_SUBSIDIARY:-IE}"

ovh_api() {
  local method="$1" path="$2" body="${3:-}"
  local ts; ts=$(curl -sf "$API_URL/1.0/auth/time")
  local sig_str="${APP_SECRET}+${CONSUMER_KEY}+${method}+${API_URL}/1.0${path}+${body}+${ts}"
  local sig="\$1\$$(printf '%s' "$sig_str" | openssl dgst -sha1 -hex | awk '{print $2}')"
  local args=(-sf -X "$method"
    -H "X-Ovh-Application: $APP_KEY"
    -H "X-Ovh-Timestamp: $ts"
    -H "X-Ovh-Signature: $sig"
    -H "X-Ovh-Consumer: $CONSUMER_KEY"
    -H "Content-Type: application/json"
  )
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" "$API_URL/1.0$path"
}

echo ""
echo "==> Verifying credentials..."
ME=$(ovh_api GET "/me")
echo "  ✓ $(echo "$ME" | jq -r '.firstname + " " + .name') — $(echo "$ME" | jq -r '.email')"

echo ""
echo "==> Creating temporary probe cart..."
CART=$(ovh_api POST "/order/cart" "{\"ovhSubsidiary\":\"$OVH_SUBSIDIARY\"}")
CART_ID=$(echo "$CART" | jq -r '.cartId')
echo "  ✓ Cart ID: $CART_ID"

echo ""
echo "==> Available VPS plans in US catalog:"
echo "────────────────────────────────────────────────────────────"
PLANS=$(ovh_api GET "/order/cart/$CART_ID/vps")
echo "$PLANS" | jq -r '.[] | "  planCode: \(.planCode)  duration: \(.duration)  price: \(.prices[]? | select(.capacityCode=="renew") | .price.text // "?")  \(.productName // "")"' 2>/dev/null | sort -u
echo ""
echo "  (Raw JSON saved to /tmp/ovh-vps-plans.json)"
echo "$PLANS" > /tmp/ovh-vps-plans.json

echo ""
echo "==> Adding first available plan to inspect configuration labels..."
FIRST_PLAN=$(echo "$PLANS" | jq -r '[.[] | select(.duration=="P1M")] | first | .planCode // .[0].planCode')
echo "  Using plan: $FIRST_PLAN"

ITEM=$(ovh_api POST "/order/cart/$CART_ID/vps" \
  "{\"duration\":\"P1M\",\"planCode\":\"$FIRST_PLAN\",\"pricingMode\":\"default\",\"quantity\":1}")
ITEM_ID=$(echo "$ITEM" | jq -r '.itemId')

echo ""
echo "==> Required configuration labels for this plan:"
echo "────────────────────────────────────────────────────────────"
CONFIG_REQS=$(ovh_api GET "/order/cart/$CART_ID/item/$ITEM_ID/requiredConfiguration")
echo "$CONFIG_REQS" | jq -r '.[] | "  label: \(.label)  required: \(.required)  fields: \(.fields // [] | join(", "))"' 2>/dev/null
echo ""
echo "  (Raw JSON saved to /tmp/ovh-vps-config-labels.json)"
echo "$CONFIG_REQS" > /tmp/ovh-vps-config-labels.json

echo ""
echo "==> Allowed values for each label:"
echo "────────────────────────────────────────────────────────────"
echo "$CONFIG_REQS" | jq -r '.[].label' | while read -r label; do
  echo "  [$label]"
  ALLOWED=$(ovh_api GET "/order/cart/$CART_ID/item/$ITEM_ID/configuration?label=$label" 2>/dev/null || echo "[]")
  echo "$ALLOWED" | jq -r '.[] | "    " + .' 2>/dev/null | head -20
done

echo ""
echo "==> Cleaning up probe cart..."
ovh_api DELETE "/order/cart/$CART_ID" > /dev/null 2>&1 || true
echo "  ✓ Cart deleted — nothing was ordered"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Full plan list:   /tmp/ovh-vps-plans.json"
echo "  Config labels:    /tmp/ovh-vps-config-labels.json"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "  Once you have the correct planCode and label values,"
echo "  update order-vps.sh and run it."
echo ""
