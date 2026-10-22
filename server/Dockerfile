FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV KB_DATA_DIR=/data KB_PORT=8443
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 8443 41234/udp
USER node
CMD ["node", "src/index.js"]
