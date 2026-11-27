# Étape 1 : construction de l'application
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Image tout-en-un (docker build --target ia) : l'application et l'IA locale (Ollama) dans un seul conteneur.
#   docker run -d --name construprojet -p 7080:80 --gpus all -v construprojet-ia:/root/.ollama <image>
FROM ollama/ollama:latest AS ia
RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx gettext-base curl \
  && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/default \
  && ln -sf /dev/stdout /var/log/nginx/access.log && ln -sf /dev/stderr /var/log/nginx/error.log
ENV IA_MODELE=qwen2.5vl:7b \
    OLLAMA_KEEP_ALIVE=15m
COPY nginx.conf /etc/construprojet/nginx.conf.template
COPY --chmod=755 docker/ia-entrypoint.sh /usr/local/bin/construprojet-ia
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
VOLUME /root/.ollama
HEALTHCHECK CMD curl -fsS http://127.0.0.1/ > /dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/construprojet-ia"]
CMD []

# Image par défaut : serveur web léger qui sert les fichiers statiques (sans IA locale)
FROM nginx:1.27-alpine AS app
# Modèle traité au démarrage (résolveur DNS du conteneur pour les connecteurs)
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
# Serveur de l'IA locale (Ollama) derrière le relais /ia-locale ; facultatif
ENV OLLAMA_URL=http://ollama:11434
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --chmod=755 docker/15-ia-locale.envsh /docker-entrypoint.d/15-ia-locale.envsh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
