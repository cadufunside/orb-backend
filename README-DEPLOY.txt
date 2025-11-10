# Deploy DEFINITIVO

## Caminho A — Usando este Dockerfile no builder
- Coloque o `Dockerfile` na raiz do projeto (tem que existir `package.json`, `tsconfig.json` e `src/`).
- Se a rede continuar lenta, troque para `Dockerfile.npmmirror`.

## Caminho B — Build local e push de imagem (sem timeouts)
```bash
docker build -t seuuser/orb-backend:qr .
docker push seuuser/orb-backend:qr
```
Depois, na Railway/Cloud Run, aponte para essa imagem.
