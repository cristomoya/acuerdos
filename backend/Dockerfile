FROM node:20-alpine

# python3 + odfpy + markdown-it + beautifulsoup4 + weasyprint for PDF/ODT export
RUN apk add --no-cache python3 py3-pip make g++ weasyprint fontconfig ttf-dejavu && \
    fc-cache -f && \
    pip3 install --break-system-packages odfpy markdown-it-py beautifulsoup4 pypdf
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY scripts/ ./scripts/

RUN mkdir -p /data/carpetas /data/plantillas &&     chown -R node:node /data /app &&     chmod -R 755 /app &&     chmod -R 777 /data &&     chmod +x /app/scripts/*.py

USER node
EXPOSE 3001

ENV NODE_ENV=production PORT=3001 \
    DB_PATH=/data/acuerdos.db \
    FILES_DIR=/data/carpetas \
    TEMPLATES_DIR=/data/plantillas

CMD ["node", "server.js"]
