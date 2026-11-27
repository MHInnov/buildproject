#!/bin/sh
# Image tout-en-un : l'application (nginx, port 80 du conteneur, 7080 côté machine) et l'IA locale (Ollama)
# dans un seul conteneur. Le modèle est téléchargé au premier lancement, en arrière-plan : l'application
# est utilisable tout de suite, sans IA tant que le modèle n'est pas prêt.
set -e
MODEL="${IA_MODELE-qwen2.5vl:7b}"
HTML=/usr/share/nginx/html
STATUS="$HTML/ia-locale.json"

# Carte graphique NVIDIA visible (docker run --gpus all) ?
GPU=false
if [ -e /dev/nvidia0 ] || { command -v nvidia-smi > /dev/null 2>&1 && nvidia-smi -L > /dev/null 2>&1; }; then GPU=true; fi

status() { printf '{"model":"%s","gpu":%s,"status":"%s"}\n' "$MODEL" "$GPU" "$1" > "$STATUS"; }

# Relais nginx : même modèle de configuration que l'image légère, Ollama sur la même machine
export OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
NS=$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)
case "$NS" in *:*) NS="[$NS]" ;; "") NS=127.0.0.11 ;; esac
export NGINX_LOCAL_RESOLVERS="$NS"
envsubst '${OLLAMA_URL} ${NGINX_LOCAL_RESOLVERS}' < /etc/construprojet/nginx.conf.template > /etc/nginx/conf.d/default.conf

status demarrage
OLLAMA_HOST=127.0.0.1:11434 ollama serve > /var/log/ollama.log 2>&1 &

(
  until ollama list > /dev/null 2>&1; do sleep 1; done
  if [ -z "$MODEL" ]; then
    status sans-modele
  elif ollama list | awk 'NR > 1 { print $1 }' | grep -qx -e "$MODEL" -e "$MODEL:latest"; then
    status pret
  else
    echo "IA locale : téléchargement du modèle $MODEL (une seule fois, gardé dans le volume)…"
    status telechargement
    if ollama pull "$MODEL" > /var/log/ollama-pull.log 2>&1; then
      status pret
      echo "IA locale : modèle $MODEL prêt."
    else
      status erreur
      echo "IA locale : téléchargement de $MODEL impossible (voir /var/log/ollama-pull.log)."
    fi
  fi
) &

echo "Constru'Projet : http://localhost:7080 (IA locale : $MODEL, carte graphique : $GPU)"
exec nginx -g 'daemon off;'
