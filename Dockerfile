# Étape 1 : construction de l'application
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Étape 2 : serveur web léger qui sert les fichiers statiques
FROM nginx:1.27-alpine
# Modèle traité au démarrage (résolveur DNS du conteneur pour les connecteurs)
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
# Serveur de l'IA locale (Ollama) derrière le relais /ia-locale ; facultatif
ENV OLLAMA_URL=http://ollama:11434
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --chmod=755 docker/15-ia-locale.envsh /docker-entrypoint.d/15-ia-locale.envsh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
