#!/bin/sh
set -e

# adapter-node needs to know its true public origin to validate the Origin header
# on POST form submissions (SvelteKit CSRF protection). Without it, form actions
# behind a proxy — or on any deployment where the request origin doesn't match —
# are rejected with a 403 "Cross-site POST form submissions are forbidden".
#
# The operator already tells us the public URL via LAUNCHPAD_BASE_URL, so reuse it
# as ORIGIN unless ORIGIN was set explicitly. For deployments behind a reverse
# proxy that rewrites scheme/host, PROTOCOL_HEADER/HOST_HEADER can be set instead.
if [ -z "${ORIGIN:-}" ] && [ -n "${LAUNCHPAD_BASE_URL:-}" ]; then
  export ORIGIN="${LAUNCHPAD_BASE_URL}"
fi

exec "$@"
