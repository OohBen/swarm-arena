FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Auto/supervisor mode: staff any active expedition on the cloud DB.
# Requires OPENROUTER_API_KEY to be provided as an environment secret.
ENV SWARM_AUTO=1
CMD ["npx", "tsx", "src/index.ts", "--auto"]
