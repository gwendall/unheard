# One-shot jobs that put public data in the bucket, next to the flight history: the gazetteer
# (scripts/places-build.ts) and the map (scripts/map-job.ts). Its own image: the daily flight job (history-job.Dockerfile) knows
# nothing of it. The command is given to `fly machine run`, nothing here runs by itself. Node 22
# strips the types; the aws4fetch version is the one in package.json.
FROM node:22-slim
WORKDIR /app
COPY lib/history.ts lib/places.ts lib/
COPY scripts/history-job.ts scripts/places-build.ts scripts/map-job.ts scripts/
RUN echo '{"private":true,"type":"module"}' > package.json && npm install --no-audit --no-fund aws4fetch@1.0.20
