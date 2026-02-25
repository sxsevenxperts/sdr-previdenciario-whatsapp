FROM nginx:alpine

# Copia o HTML estático para o nginx
COPY index.html /usr/share/nginx/html/index.html

# Configuração nginx simples
RUN echo 'server { \
    listen 80; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
