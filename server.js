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

async function setupDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        isGroup BOOLEAN,
        lastMessageBody TEXT,
        lastMessageTimestamp TIMESTAMPTZ
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(255) PRIMARY KEY,
        chatId VARCHAR(255) REFERENCES chats(id) ON DELETE CASCADE,
        body TEXT,
        fromMe BOOLEAN,
        timestamp TIMESTAMPTZ,
        type VARCHAR(100),
        media_data TEXT
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);`);
    await client.query('COMMIT');
    console.log('✅ Tabelas do banco de dados verificadas/criadas com sucesso!');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Erro ao criar tabelas:', e);
    throw e;
  } finally {
    client.release();
  }
}


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

let whatsappClient = null;
let currentQR = null;
let clientStatus = 'disconnected';
let sessionData = null;

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'ok',
      database: 'connected',
      whatsapp: clientStatus,
      timestamp: new Date().toISOString() 
    });
  } catch (dbError) {
    res.status(500).json({ status: 'error', database: 'disconnected', whatsapp: clientStatus, error: dbError.message });
  }
});

app.post('/api/whatsapp/qr', async (req, res) => {
  try {
    console.log('📱 Solicitação de QR Code via HTTP');
    if (!whatsappClient && clientStatus !== 'initializing') {
      await initializeWhatsApp();
    }
    if (currentQR) {
      res.json({ success: true, qr: currentQR, status: clientStatus });
    } else {
      res.json({ success: false, message: 'QR Code sendo gerado...', status: clientStatus });
    }
  } catch (error) {
    console.error('❌ Erro ao gerar QR:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/status', (req, res) => {
  res.json({ status: clientStatus, session: sessionData });
});

let wss;
let wsClients = new Set();

async function startServer() {
  try {
    await setupDatabase();
    
    const server = app.listen(PORT, () => {
      console.log(`🚀 Backend rodando na porta ${PORT}`);
      initializeWhatsApp().catch(err => console.error('Erro na inicialização automática:', err));
    });

    wss = new WebSocketServer({ server, path: '/whatsapp' });
    console.log('✅ WebSocket Server criado');
    
    wss.on('connection', (ws) => {
      console.log('✅ Cliente WebSocket conectado');
      wsClients.add(ws);
      
      ws.send(JSON.stringify({ type: 'status', status: clientStatus }));
      
      if (currentQR && clientStatus === 'qr_ready') {
        ws.send(JSON.stringify({ type: 'qr', qr: currentQR }));
      } else if (clientStatus === 'ready') {
        ws.send(JSON.stringify({ type: 'ready' }));
      }
      
      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message);
          console.log('📨 Mensagem WS recebida:', data.type);
          
          switch (data.type) {
            case 'request_qr':
              if (!whatsappClient && clientStatus !== 'initializing') await initializeWhatsApp();
              if (currentQR) ws.send(JSON.stringify({ type: 'qr', qr: currentQR }));
              break;
              
            case 'get_chats':
              if (whatsappClient && clientStatus === 'ready') {
                console.log('Buscando chats do banco de dados...');
                const dbResult = await pool.query('SELECT * FROM chats ORDER BY lastMessageTimestamp DESC LIMIT 100');
                ws.send(JSON.stringify({ type: 'chats', chats: dbResult.rows }));
              }
              break;
              
            case 'get_messages':
              if (whatsappClient && clientStatus === 'ready') {
                const chatId = data.chatId;
                console.log(`Buscando mensagens para ${chatId}...`);
                
                try {
                  console.log(`... Sincronizando 200 últimas do WhatsApp para ${chatId}`);
                  const chat = await whatsappClient.getChatById(chatId);
                  const messages = await chat.fetchMessages({ limit: 200 });

                  for (const m of messages) {
                    await saveMessageToDb(m);
                  }
                  console.log(`... Sincronização de ${messages.length} mensagens concluída.`);

                  const dbResult = await pool.query(
                    'SELECT * FROM messages WHERE chatId = $1 ORDER BY timestamp ASC',
                    [chatId]
                  );

                  ws.send(JSON.stringify({ type: 'messages', chatId, messages: dbResult.rows }));

                } catch (error) {
                   console.error('❌ Erro ao buscar/sincronizar mensagens:', error);
                   ws.send(JSON.stringify({ type: 'error', message: error.message }));
                }
              }
              break;
              
            case 'send_message':
              if (whatsappClient && clientStatus === 'ready') {
                console.log(`Enviando mensagem para ${data.chatId}`);
                const sentMessage = await whatsappClient.sendMessage(data.chatId, data.message);
                await saveMessageToDb(sentMessage);
                console.log('Mensagem enviada e salva no banco');
              }
              break;
              
            case 'disconnect':
              if (whatsappClient) {
                console.log('Recebido comando de desconexão...');
                await whatsappClient.destroy();
                clientStatus = 'disconnected';
                currentQR = null;
                whatsappClient = null;
                broadcastToClients({ type: 'disconnected', reason: 'User request' });
              }
              break;
          }
        } catch (error) {
          console.error('❌ Erro ao processar mensagem WS:', error);
          ws.send(JSON.stringify({ type: 'error', message: error.message }));
        }
      });
      
      ws.on('close', () => {
        console.log('❌ Cliente WebSocket desconectado');
        wsClients.delete(ws);
      });
    });
  } catch (error) {
    console.error('❌ Falha fatal ao iniciar o servidor (provavelmente banco de dados):', error);
    process.exit(1);
  }
}


function broadcastToClients(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

async function saveMessageToDb(message) {
  let client;
  try {
    const chatId = message.fromMe ? message.to : message.from;
    const timestamp = new Date(message.timestamp * 1000);

    if (message.type === 'call_log' || message.type === 'e2e_notification' || !message.id || !chatId) {
      return;
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const chat = await whatsappClient.getChatById(chatId);
    await client.query(
      `INSERT INTO chats (id, name, isGroup)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [chatId, chat.name || chat.id.user || 'Sem nome', chat.isGroup]
    );
    
    let mediaData = null;
    if (message.hasMedia) {
      console.log(`... Mensagem [${message.id._serialized}] tem mídia. Fazendo download...`);
      try {
        const media = await message.downloadMedia();
        if (media) {
          mediaData = `data:${media.mimetype};base64,${media.data}`;
          console.log(`... Download da mídia [${message.id._serialized}] concluído.`);
        }
      } catch (e) {
        console.error(`❌ Falha no download da mídia [${message.id._serialized}]: ${e.message}`);
      }
    }
    
    await client.query(
      `INSERT INTO messages (id, chatId, body, fromMe, timestamp, type, media_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [message.id._serialized, chatId, message.body, message.fromMe, timestamp, message.type, mediaData]
    );

    const lastMessageBody = message.type === 'image' ? (message.body || '[Imagem]') : message.body;
    await client.query(
      `UPDATE chats
       SET lastMessageBody = $1, lastMessageTimestamp = $2
       WHERE id = $3`,
      [lastMessageBody, timestamp, chatId]
    );
    
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error(`❌ Erro ao salvar mensagem no BD: ${error.message}`);
  } finally {
    if (client) client.release();
  }
}

async function syncChatsWithDb(chats) {
  let client;
  try {
    console.log(`Syncing ${chats.length} chats with DB...`);
    client = await pool.connect();
    await client.query('BEGIN'); 

    for (const chat of chats) {
      if (!chat.id || chat.id.user === 'status') continue; 

      const lastMsg = chat.lastMessage;
      const lastMsgTime = lastMsg ? new Date(lastMsg.timestamp * 1000) : null;
      const lastMessageBody = lastMsg?.type === 'image' ? (lastMsg.body || '[Imagem]') : lastMsg?.body;

      await client.query(
        `INSERT INTO chats (id, name, isGroup, lastMessageBody, lastMessageTimestamp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           lastMessageBody = COALESCE(EXCLUDED.lastMessageBody, chats.lastMessageBody),
           lastMessageTimestamp = COALESCE(EXCLUDED.lastMessageTimestamp, chats.lastMessageTimestamp)`,
        [
          chat.id._serialized,
          chat.name || chat.id.user || 'Sem nome',
          chat.isGroup,
          lastMessageBody || null,
          lastMsgTime
        ]
      );
    }
    await client.query('COMMIT'); 
    console.log('✅ Sincronização de chats com BD concluída.');
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error(`❌ Erro ao sincronizar chats: ${error.message}`);
  } finally {
    if (client) client.release();
  }
}


async function initializeWhatsApp() {
  try {
    if (whatsappClient || clientStatus === 'initializing') {
      console.log('⚠️ Inicialização já em progresso.');
      return;
    }

    console.log('🔄 Inicializando WhatsApp Web.js...');
    clientStatus = 'initializing';
    broadcastToClients({ type: 'status', status: clientStatus });
    currentQR = null;
    
    whatsappClient = new Client({
      authStrategy: new LocalAuth({
        clientId: 'orb-crm-main-session' 
      }),
      puppeteer: {
        headless: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1920,1080',
          '--lang=pt-BR,pt'
        ]
      }
    });
    
    whatsappClient.on('qr', async (qr) => {
      console.log('📱 QR Code gerado!');
      clientStatus = 'qr_ready';
      try {
        currentQR = await qrcode.toDataURL(qr);
        broadcastToClients({ type: 'qr', qr: currentQR });
      } catch (error) {
        console.error('❌ Erro ao converter QR:', error);
      }
    });
    
    whatsappClient.on('authenticated', () => {
      console.log('✅ WhatsApp autenticado!');
      clientStatus = 'authenticated';
      sessionData = { authenticated: true, timestamp: Date.now() };
      broadcastToClients({ type: 'authenticated', session: sessionData });
    });
    
    whatsappClient.on('ready', async () => {
      console.log('✅ WhatsApp pronto!');
      clientStatus = 'ready';
      currentQR = null;
      broadcastToClients({ type: 'ready' });

      try {
        const chats = await whatsappClient.getChats();
        await syncChatsWithDb(chats);
      } catch (error) {
        console.error('❌ Erro ao pré-carregar chats:', error);
      }
    });
    
    whatsappClient.on('loading_screen', (percent, message) => {
      console.log(`⏳ Carregando: ${percent}%`);
      broadcastToClients({ type: 'loading_screen', percent, message });
    });
    
    whatsappClient.on('disconnected', (reason) => {
      console.log(`❌ WhatsApp desconectado: ${reason}`);
      clientStatus = 'disconnected';
      currentQR = null;
      whatsappClient = null;
      broadcastToClients({ type: 'disconnected', reason });

      setTimeout(() => {
        console.log('Tentando reconectar automaticamente...');
        initializeWhatsApp();
      }, 10000);
    });
    
    whatsappClient.on('message_create', async (message) => {
      try {
        await saveMessageToDb(message);
        const chatId = message.fromMe ? message.to : message.from;
        console.log('📨 Nova mensagem salva no BD para ' + chatId);

        broadcastToClients({
          type: 'message',
          chatId: chatId,
          message: {
            id: message.id._serialized,
            body: message.body,
            fromMe: message.fromMe,
            timestamp: message.timestamp * 1000,
            type: message.type,
            media_data: (message.hasMedia) ? `data:${(await message.downloadMedia()).mimetype};base64,${(await message.downloadMedia()).data}` : null
          }
        });
      } catch (error) {
        console.error(`Erro ao processar message_create: ${error.message}`);
      }
    });
    
    await whatsappClient.initialize();
    console.log('🔄 Cliente inicializado');
    
  } catch (error) {
    console.error('❌ Erro ao inicializar WhatsApp:', error);
    clientStatus = 'error';
    currentQR = null;
    whatsappClient = null; 
    broadcastToClients({ type: 'error', message: error.message });
  }
}

// ============================================
// OAUTH TOKEN EXCHANGE (CÓDIGO CORRIGIDO)
// ============================================
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

// Lidar com erros não tratados
process.on('unhandledRejection', (error) => console.error('Unhandled Rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught Exception:', error));

// INICIA O SERVIDOR
startServer();
