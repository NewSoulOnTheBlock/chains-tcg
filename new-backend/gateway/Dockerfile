# Gateway — nginx, the single ingress.
#
# Built rather than plain-mounted so the entrypoint hook is guaranteed
# executable regardless of the host checkout's file modes.
FROM nginx:1.27-alpine

# Rendered to /etc/nginx/nginx.conf by the stock entrypoint (envsubst).
COPY nginx.conf /etc/nginx/templates/nginx.conf.template
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx

# Sourced (not executed) by the entrypoint because of the .envsh suffix, so its
# export reaches the envsubst step that follows.
COPY docker-entrypoint.d/05-cors-allowlist.envsh /docker-entrypoint.d/05-cors-allowlist.envsh
RUN chmod +x /docker-entrypoint.d/05-cors-allowlist.envsh

# The nginx image already drops to the unprivileged `nginx` user for workers;
# the master needs to bind :8080 and write the pid file.
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1
