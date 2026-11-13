#!/usr/bin/env bash
# Descarga los archivos de DeepFilterNet3 (wasm + modelo) para servirlos desde
# nuestro propio dominio en vez del CDN de terceros. Ejecutar en la raiz del
# repo ANTES de construir la imagen. Es opcional: sin esto la app usa el CDN
# de la libreria y, si tampoco responde, cae a RNNoise.
set -euo pipefail
BASE=https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3
DEST="$(dirname "$0")/../packages/client/public/dfn3"
for f in v3/pkg/df_bg.wasm v3/models/DeepFilterNet3_onnx.tar.gz; do
  mkdir -p "$DEST/$(dirname "$f")"
  curl -fSL -o "$DEST/$f" "$BASE/$f"
  echo "ok $f ($(wc -c < "$DEST/$f") bytes)"
done
