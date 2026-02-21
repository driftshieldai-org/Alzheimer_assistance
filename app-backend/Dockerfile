FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy the backend code
COPY . .

# Expose the port Express is running on
EXPOSE 5000

# Start the server
CMD ["node", "server.js"]
