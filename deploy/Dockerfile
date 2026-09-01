# 构建上下文为项目根目录（见 docker-compose.yml：context: ..），
# 因此 dist/ 与 deploy/nginx.conf 均从项目根目录取。
FROM nginx:1.27-alpine
COPY dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
