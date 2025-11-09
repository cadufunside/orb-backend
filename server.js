import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import { WebSocketServer } from 'ws';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const whatsappClients = new Map();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

function getClientData(sessionId) {
    if (!whatsappClients.has(sessionId)) {
        whatsappClients.set(sessionId, {
            client: null,
            status: 'disconnected',
            qrCode: null,
            wsClients: new Set()
        });
    }
    return whatsappClients.get(sessionId);
}

function broadcastToClients(sessionId, data) {
    const clientData = getClientData(sessionId);
    const message = JSON.stringify(data);
    clientData.wsClients.forEach(client => {
        if (client.readyState === 1) {
            client.send(message);
        }
    });
}

async function setupDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS chats (
        sessionId VARCHAR(255) NOT NULL,
        id VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        isGroup BOOLEAN,
        lastMessageBody TEXT,
        lastMessageTimestamp TIMESTAMPTZ,
        PRIMARY KEY (sessionId, id)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        sessionId VARCHAR(255) NOT NULL,
        id VARCHAR(255) PRIMARY KEY,
        chatId VARCHAR(255) NOT NULL,
        body TEXT,
        fromMe BOOLEAN,
        timestamp TIMESTAMPTZ,
        type VARCHAR(100),
        media_data TEXT,
        FOREIGN KEY (sessionId, chatId) REFERENCES chats(sessionId, id) ON DELETE CASCADE
      );
    `);
    
    await client.query('COMMIT');
    console.log('✅ Tabelas do banco de dados (Multi-Sessão) verificadas/criadas com sucesso!');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Erro ao criar tabelas. Verifique as permissões do seu DB:', e);
    throw e;
  } finally {
    client.release();
  }
}

async function saveMessageToDb(sessionId, client, message) {
  let dbClient;
  try {
    const chatId = message.fromMe ? message.to : message.from;
    const timestamp = new Date(message.timestamp * 1000);

    if (message.type === 'call_log' || message.type === 'e2e_notification' || !message.id || !chatId) {
      return;
    }

    dbClient = await pool.connect();
    await dbClient.query('BEGIN');

    const chat = await client.getChatById(chatId);
    await dbClient.query(
      `INSERT INTO chats (sessionId, id, name, isGroup)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sessionId, id) DO NOTHING`,
      [sessionId, chatId, chat.name || chat.id.user || 'Sem nome', chat.isGroup]
    );
    
    let mediaData = null;
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media) mediaData = `data:${media.mimetype};base64,${media.data}`;
      } catch (e) {
        console.error(`❌ Falha no download da mídia [${message.id._serialized}]: ${e.message}`);
      }
    }
    
    await dbClient.query(
      `INSERT INTO messages (sessionId, id, chatId, body, fromMe, timestamp, type, media_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [sessionId, message.id._serialized, chatId, message.body, message.fromMe, timestamp, message.type, mediaData]
    );

    const lastMessageBody = message.type === 'image' ? (message.body || '[Imagem]') : message.body;
    await dbClient.query(
      `UPDATE chats
       SET lastMessageBody = $1, lastMessageTimestamp = $2
       WHERE sessionId = $3 AND id = $4`,
      [lastMessageBody, timestamp, sessionId, chatId]
    );
    
    await dbClient.query('COMMIT');
  } catch (error) {
    if (dbClient) await dbClient.query('ROLLBACK');
    console.error(`❌ Erro ao salvar mensagem no BD para ${sessionId}: ${error.message}`);
  } finally {
    if (dbClient) dbClient.release();
  }
}

async function syncChatsWithDb(sessionId, client, chats) {
  let dbClient;
  try {
    console.log(`Syncing ${chats.length} chats for session ${sessionId}...`);
    dbClient = await pool.connect();
    await dbClient.query('BEGIN'); 

    for (const chat of chats) {
      if (!chat.id || chat.id.user === 'status') continue; 

      const lastMsg = chat.lastMessage;
      const lastMsgTime = lastMsg ? new Date(lastMsg.timestamp * 1000) : null;
      const lastMessageBody = lastMsg?.type === 'image' ? (lastMsg.body || '[Imagem]') : lastMsg?.body;

      await dbClient.query(
        `INSERT INTO chats (sessionId, id, name, isGroup, lastMessageBody, lastMessageTimestamp)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (sessionId, id) DO UPDATE SET
           name = EXCLUDED.name,
           lastMessageBody = COALESCE(EXCLUDED.lastMessageBody, chats.lastMessageBody),
           lastMessageTimestamp = COALESCE(EXCLUDED.lastMessageTimestamp, chats.lastMessageTimestamp)`,
        [
          sessionId,
          chat.id._serialized,
          chat.name || chat.id.user || 'Sem nome',
          chat.isGroup,
          lastMessageBody || null,
          lastMsgTime
        ]
      );
      
      if (client.info) {
          try {
              const messages = await chat.fetchMessages({ limit: 50 });
              for (const m of messages) {
                  await saveMessageToDb(sessionId, client, m);
              }
          } catch(e) {
             console.error(`❌ Falha ao buscar histórico de chat ${chat.id._serialized} para ${sessionId}: ${e.message}`);
          }
      }
    }
    await dbClient.query('COMMIT'); 
    console.log(`✅ Sincronização de chats e histórico concluída para ${sessionId}.`);
  } catch (error) {
    if (dbClient) await dbClient.query('ROLLBACK');
    console.error(`❌ Erro ao sincronizar chats para ${sessionId}: ${error.message}`);
  } finally {
    if (dbClient) dbClient.release();
  }
}

async function initializeWhatsApp(sessionId) {
    let clientData = getClientData(sessionId);

    if (clientData.client || clientData.status === 'initializing') {
        console.log(`⚠️ Sessão ${sessionId} já em progresso ou conectada.`);
        return;
    }
    
    console.log(`🔄 Inicializando WhatsApp Web.js para a sessão: ${sessionId}...`);
    clientData.status = 'initializing';
    broadcastToClients(sessionId, { type: 'status', status: clientData.status });
    clientData.qrCode = null;

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: sessionId
        }),
        puppeteer: {
            headless: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
                '--disable-gpu', '--disable-blink-features=AutomationControlled',
                '--window-size=1920,1080', '--lang=pt-BR,pt'
            ]
        }
    });

    clientData.client = client;

    client.on('qr', async (qr) => {
        console.log(`📱 QR Code gerado para ${sessionId}!`);
        clientData.status = 'qr_ready';
        try {
            clientData.qrCode = await qrcode.toDataURL(qr);
            broadcastToClients(sessionId, { type: 'qr', qr: clientData.qrCode });
        } catch (error) {
            console.error(`❌ Erro ao converter QR para ${sessionId}:`, error);
        }
    });

    client.on('authenticated', () => {
        console.log(`✅ WhatsApp autenticado para ${sessionId}!`);
        clientData.status = 'authenticated';
        broadcastToClients(sessionId, { type: 'authenticated' });
    });

    client.on('ready', async () => {
        console.log(`✅ WhatsApp pronto para ${sessionId}!`);
        clientData.status = 'ready';
        clientData.qrCode = null;
        broadcastToClients(sessionId, { type: 'ready' });

        try {
            const chats = await client.getChats();
            await syncChatsWithDb(sessionId, client, chats);
        } catch (error) {
            console.error(`❌ Erro ao pré-carregar chats para ${sessionId}:`, error);
        }
    });

    client.on('disconnected', (reason) => {
        console.log(`❌ WhatsApp desconectado para ${sessionId}: ${reason}`);
        clientData.status = 'disconnected';
        clientData.client = null;
        broadcastToClients(sessionId, { type: 'disconnected', reason });
    });

    client.on('message_create', async (message) => {
        try {
            await saveMessageToDb(sessionId, client, message);
            const chatId = message.fromMe ? message.to : message.from;
            
            let mediaData = null;
            if (message.hasMedia) {
                try {
                    const media = await message.downloadMedia();
                    if (media) mediaData = `data:${media.mimetype};base64,${media.data}`;
                } catch (e) {
                    console.error(`❌ Falha no download de mídia em message_create: ${e.message}`);
                }
            }
            
            broadcastToClients(sessionId, {
                type: 'message',
                chatId: chatId,
                message: {
                    id: message.id._serialized,
                    body: message.body,
                    fromMe: message.fromMe,
                    timestamp: message.timestamp * 1000,
                    type: message.type,
                    media_data: mediaData
                }
            });
        } catch (error) {
            console.error(`Erro ao processar message_create para ${sessionId}: ${error.message}`);
        }
    });

    try {
        await client.initialize();
        console.log(`🔄 Cliente ${sessionId} inicializado`);
    } catch (error) {
        console.error(`❌ Erro ao inicializar WhatsApp para ${sessionId}:`, error);
        clientData.status = 'error';
        clientData.client = null;
        broadcastToClients(sessionId, { type: 'error', message: error.message });
    }
}

async function startServer() {
  try {
    await setupDatabase();
    
    const server = app.listen(PORT, () => {
      console.log(`🚀 Backend rodando na porta ${PORT}`);
    });

    let wss = new WebSocketServer({ server, path: '/whatsapp' });
    console.log('✅ WebSocket Server criado');
    
    wss.on('connection', (ws, req) => {
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        const sessionId = urlParams.get('sessionId');

        if (!sessionId) {
            ws.send(JSON.stringify({ type: 'error', message: 'SESSION_ID é obrigatório.' }));
            ws.close(1008, 'SESSION_ID_REQUIRED');
            return;
        }

        const clientData = getClientData(sessionId);
        clientData.wsClients.add(ws);
        console.log(`✅ Cliente WS conectado para sessão: ${sessionId}. Status: ${clientData.status}`);
        
        ws.send(JSON.stringify({ type: 'status', status: clientData.status, sessionId: sessionId }));
        
        if (clientData.qrCode && clientData.status === 'qr_ready') {
            ws.send(JSON.stringify({ type: 'qr', qr: clientData.qrCode }));
        } else if (clientData.status === 'ready') {
            ws.send(JSON.stringify({ type: 'ready' }));
        }

        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                const client = clientData.client;
                const status = clientData.status;

                console.log(`📨 Mensagem WS recebida para ${sessionId}: ${data.type}`);
                
                switch (data.type) {
                    case 'request_qr':
                        if (!client || status === 'disconnected') await initializeWhatsApp(sessionId);
                        if (clientData.qrCode) ws.send(JSON.stringify({ type: 'qr', qr: clientData.qrCode }));
                        break;
                        
                    case 'get_chats':
                        if (status === 'ready') {
                            console.log(`Buscando chats do banco de dados para ${sessionId}...`);
                            const dbResult = await pool.query(
                                'SELECT * FROM chats WHERE sessionId = $1 ORDER BY lastMessageTimestamp DESC LIMIT 100',
                                [sessionId]
                            );
                            ws.send(JSON.stringify({ type: 'chats', chats: dbResult.rows }));
                        }
                        break;
                        
                    case 'get_messages':
                        if (status === 'ready') {
                            const chatId = data.chatId;
                            console.log(`Buscando mensagens para ${chatId} de ${sessionId}...`);
                            
                            try {
                                console.log(`... Sincronizando 200 últimas do WhatsApp para ${chatId}/${sessionId}`);
                                const chat = await client.getChatById(chatId);
                                const messages = await chat.fetchMessages({ limit: 200 });

                                for (const m of messages) {
                                    await saveMessageToDb(sessionId, client, m);
                                }
                                console.log(`... Sincronização concluída. Puxando histórico do DB.`);

                                const dbResult = await pool.query(
                                    'SELECT * FROM messages WHERE sessionId = $1 AND chatId = $2 ORDER BY timestamp ASC',
                                    [sessionId, chatId]
                                );

                                ws.send(JSON.stringify({ type: 'messages', chatId, messages: dbResult.rows }));

                            } catch (error) {
                                console.error(`❌ Erro ao buscar/sincronizar mensagens para ${sessionId}:`, error);
                                ws.send(JSON.stringify({ type: 'error', message: error.message }));
                            }
                        }
                        break;
                        
                    case 'send_message':
                        if (status === 'ready' && client) {
                            console.log(`Enviando mensagem para ${data.chatId} de ${sessionId}`);
                            const sentMessage = await client.sendMessage(data.chatId, data.message);
                            await saveMessageToDb(sessionId, client, sentMessage);
                            console.log('Mensagem enviada e salva no banco');
                        }
                        break;
                        
                    case 'disconnect':
                        if (client) {
                            console.log(`Recebido comando de desconexão para ${sessionId}...`);
                            await client.destroy();
                            clientData.status = 'disconnected';
                            clientData.qrCode = null;
                            clientData.client = null;
                            broadcastToClients(sessionId, { type: 'disconnected', reason: 'User request' });
                        }
                        break;
                }
            } catch (error) {
                console.error(`❌ Erro ao processar mensagem WS para ${sessionId}:`, error);
                ws.send(JSON.stringify({ type: 'error', message: error.message }));
            }
        });
        
        ws.on('close', () => {
            console.log(`❌ Cliente WebSocket desconectado para ${sessionId}`);
            clientData.wsClients.delete(ws);
        });
    });
  } catch (error) {
    console.error('❌ Falha fatal ao iniciar o servidor:', error);
    process.exit(1);
  }
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'ok',
      database: 'connected',
      timestamp: new Date().toISOString() 
    });
  } catch (dbError) {
    res.status(500).json({ status: 'error', database: 'disconnected', error: dbError.message });
  }
});

app.post('/api/oauth/facebook/token-exchange', async (req, res) => {
  try {
    const { code } = req.body;
    const response = await fetch(
      'https://graph.facebook.com/v18.0/oauth/access_token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.FB_APP_ID,
          client_secret: process.env.FB_APP_SECRET,
          redirect_uri: process.env.REDIRECT_URI,
          code: code
        })
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/oauth/google/token-exchange', async (req, res) => {
  try {
    const { code } = req.body;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const data = await response.json();
    res.json(data); 
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

process.on('unhandledRejection', (error) => console.error('Unhandled Rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught Exception:', error));

startServer();
