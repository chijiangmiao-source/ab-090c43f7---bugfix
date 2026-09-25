FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 无第三方依赖，直接拷贝源码（含测试与验证脚本，供 verify 服务使用）
COPY package.json ./
COPY Dockerfile docker-compose.yml ./
COPY src ./src
COPY public ./public
COPY test ./test
COPY scripts ./scripts

# 端口可配置：PORT 环境变量（默认 8080）
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
