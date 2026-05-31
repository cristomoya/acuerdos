FROM nginx:alpine

COPY frontend/public/ /usr/share/nginx/html/
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
RUN chmod -R 644 /usr/share/nginx/html/ && \
    find /usr/share/nginx/html/ -type d -exec chmod 755 {} \;

EXPOSE 80
