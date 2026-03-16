#!/bin/sh
# This script is the container's entrypoint.
# It generates a config file from an environment variable and then starts Nginx.

# Create a config.js file in the web root
echo "window.runtimeConfig = { BACKEND_URL: '${BACKEND_URL}' };" > /usr/share/nginx/html/config.js

echo "Generated config.js with backend URL: ${BACKEND_URL}"

echo "Starting Nginx..."
# Start Nginx in the foreground
nginx -g 'daemon off;'
