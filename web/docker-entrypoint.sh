#!/bin/sh
set -e

# Executed automatically by the official nginx image entrypoint through /docker-entrypoint.d/*.sh before nginx starts.
# Generate runtime config.js from environment variables. Each analytics provider has an independent variable;
# unset providers remain disabled, load no scripts, and send no external requests. Multiple providers may be enabled together.

# GA4 and Baidu IDs contain only letters, numbers, and hyphens. Remove other characters
# so quotes and similar values cannot break the JavaScript strings in config.js as a defense-in-depth measure.
sanitize_id() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9-'
}

GA4_ID=$(sanitize_id "${ANALYTICS_GA4_ID:-}")
BAIDU_ID=$(sanitize_id "${ANALYTICS_BAIDU_ID:-}")

# These values are public browser configuration. Restrict them to URL/JWT-safe characters so they
# cannot terminate the generated JavaScript strings. Backend service-role keys are never accepted here.
sanitize_url() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9:/?&=._~%-'
}

sanitize_public_key() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9._-'
}

assert_public_supabase_key() {
    key="$1"
    case "$key" in
      sb_secret_*)
        echo "Refusing to publish a Supabase secret key in browser runtime configuration" >&2
        exit 1
        ;;
    esac
    payload=$(printf '%s' "$key" | cut -d. -f2)
    if [ -n "$payload" ] && [ "$payload" != "$key" ]; then
        normalized=$(printf '%s' "$payload" | tr '_-' '/+')
        case $((${#normalized} % 4)) in
          2) normalized="${normalized}==" ;;
          3) normalized="${normalized}=" ;;
        esac
        decoded=$(printf '%s' "$normalized" | base64 -d 2>/dev/null || true)
        if printf '%s' "$decoded" | grep -Eq '"role"[[:space:]]*:[[:space:]]*"service_role"'; then
            echo "Refusing to publish a Supabase service-role JWT in browser runtime configuration" >&2
            exit 1
        fi
    fi
}

API_BASE_URL=$(sanitize_url "${API_BASE_URL:-}")
SUPABASE_URL=$(sanitize_url "${SUPABASE_URL:-}")
assert_public_supabase_key "${SUPABASE_ANON_KEY:-}"
SUPABASE_ANON_KEY=$(sanitize_public_key "${SUPABASE_ANON_KEY:-}")
case "${CLOUD_BACKEND_ENABLED:-false}" in
  1|true|TRUE|yes|YES) CLOUD_BACKEND_ENABLED=true ;;
  *) CLOUD_BACKEND_ENABLED=false ;;
esac

cat > /usr/share/nginx/html/config.js <<EOF
window.__RUNTIME_CONFIG__ = {
  ANALYTICS_GA4_ID: "${GA4_ID}",
  ANALYTICS_BAIDU_ID: "${BAIDU_ID}",
  CLOUD_BACKEND_ENABLED: "${CLOUD_BACKEND_ENABLED}",
  API_BASE_URL: "${API_BASE_URL}",
  SUPABASE_URL: "${SUPABASE_URL}",
  SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY}"
};
EOF
