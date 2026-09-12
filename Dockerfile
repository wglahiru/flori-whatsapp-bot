FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source code
COPY . .

# Default port
EXPOSE 10000

ENV PORT=10000

# Command to run
CMD [ "node", "server.js" ]
