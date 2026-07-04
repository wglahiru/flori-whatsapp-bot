FROM ghcr.io/puppeteer/puppeteer:21.5.0

# Set working directory
WORKDIR /usr/src/app

# Copy package files
COPY --chown=pptruser:pptruser package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY --chown=pptruser:pptruser . .

# Expose port
EXPOSE 3001

# Environment variable for port
ENV PORT=3001

# Command to run
CMD [ "node", "server.js" ]
