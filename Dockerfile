FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY dist ./dist
COPY migrations ./migrations
COPY scripts/service-fault-check.mjs ./scripts/service-fault-check.mjs
COPY scripts/service-fault-publish-notification.mjs ./scripts/service-fault-publish-notification.mjs
COPY scripts/service-fault-evidence-check.mjs ./scripts/service-fault-evidence-check.mjs
COPY scripts/service-fault-outbox-check.mjs ./scripts/service-fault-outbox-check.mjs
RUN echo '[]' > notify-rules.json
EXPOSE 3000 3002 3003 3004
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "const port=process.env.HTTP_PORT||3000; fetch('http://127.0.0.1:'+port+'/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/app.js"]
