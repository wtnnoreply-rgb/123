FROM node:20
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-optional --legacy-peer-deps
COPY server.js ./
RUN mkdir -p /data/auth
ENV AUTH_DIR=/data/auth
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
