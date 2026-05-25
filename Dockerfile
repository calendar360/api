FROM node:18-alpine
WORKDIR /usr/src/app
COPY . .
RUN npm ci --only=production
EXPOSE 4000
CMD ["node","src/server.js"]
