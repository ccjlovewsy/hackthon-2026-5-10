FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7860

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 7860

CMD ["npm", "start"]
