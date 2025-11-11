# Railway + Postgres + Inbox/Threads (REST + Webhooks + WS opcional)

1) Railway: adicione PostgreSQL (copie o DATABASE_URL).
2) Variables do serviço:
   PORT=8080
   SESSION_DIR=/data/sessions
   DATABASE_URL=<cole aqui>
   (opcionais) WEBHOOK_URL, WEBHOOK_SECRET
3) Build:
   - Build Type: Docker
   - Persistent Build Cache: ON
   - (Ásia) Build Arg: BUILD_NPM_REGISTRY=https://registry.npmmirror.com
4) Storage: Volume montado em /data (1–2 GB).
5) Healthcheck: /healthz

Endpoints principais:
- POST /api/sessions/:id/start
- GET  /api/sessions/:id/qr.png
- GET  /api/sessions/:id/status
- POST /api/sessions/:id/messages/text
- POST /api/sessions/:id/messages/media
- GET  /api/sessions/:id/threads?limit=20&before_ts=epoch_ms
- GET  /api/sessions/:id/threads/:jid/summary
- GET  /api/sessions/:id/messages/:jid/history?limit=50&before_id=123
- POST /api/sessions/:id/threads/:jid/read  { "last_read_id": 123 }

WS opcional: /ws (canal "session:<id>:contact:<jid>")
