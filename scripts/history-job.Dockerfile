# The flight history job (scripts/history-job.ts): only the job, the builder and the format, not the
# app. Node 22 strips the types; the aws4fetch version is the one in package.json.
FROM node:22-slim
WORKDIR /app
COPY lib/history.ts lib/
COPY scripts/history-index.ts scripts/history-job.ts scripts/
RUN echo '{"private":true,"type":"module"}' > package.json && npm install --no-audit --no-fund aws4fetch@1.0.20
CMD ["node", "scripts/history-job.ts"]
