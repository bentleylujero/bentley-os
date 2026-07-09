FROM node:22-alpine AS base
WORKDIR /usr/src/app

COPY package.json ./
RUN npm install

COPY . .

RUN npm run build

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["npm", "start"]
