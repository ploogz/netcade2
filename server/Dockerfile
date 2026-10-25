FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
ENV PORT=8080 TRUST_PROXY=1 NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "server.js"]
