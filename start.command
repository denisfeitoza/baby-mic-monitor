#!/bin/bash

# Vai para o diretório atual do script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "Encerrando instâncias anteriores do servidor..."
pkill -f "vite"
sleep 1

echo "Iniciando Mic Monitor Pro..."
# Agenda a abertura do navegador para daqui a 2 segundos
(sleep 2 && open http://localhost:5173/) &

# Inicia o servidor local e mantém o terminal aberto com os logs
npx vite
