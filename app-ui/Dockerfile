# Stage 1: Build the React application with Vite
FROM node:18-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Stage 2: Serve using Nginx
FROM nginx:alpine

# Copy the NGINX template file (instead of the static conf)
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Copy the built React files
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
#CMD ["/bin/sh", "-c", "echo \"window.env = { BACKEND_URL: '$BACKEND_URL' };\" > /usr/share/nginx/html/env-config.js && nginx -g 'daemon off;'"]
