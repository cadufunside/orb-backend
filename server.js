// BACKEND COM PERSISTÊNCIA E CRIAÇÃO AUTOMÁTICA DE TABELAS
import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import { WebSocketServer } from 'ws';
import pg from 'pg';

// ============================================
// CONFIGURAÇÃO DO BANCO DE DADOS
// ============================================
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Puxa automático do Railway
  ssl: {
    rejectUnauthorized: false // Necessário para o Railway
  }
});

// ============================================
// NOVA FUNÇÃO: CRIAR TABELAS AUTOMATICAMENTE
// ============================================
async function setupDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // SQL para criar a tabela de chats
    await client.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        isGroup BOOLEAN,
        lastMessageBody TEXT,
        lastMessageTimestamp TIMESTAMPTZ
      );
    `);
    
    // SQL para criar a tabela de mensagens
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(255) PRIMARY KEY,
        chatId VARCHAR(255) REFERENCES chats(id),
        body TEXT,
        fromMe BOOLEAN,
        timestamp TIMESTAMPTZ,
        type VARCHAR(100)
      );
    `);
    
    // SQL para criar os índices (para velocidade)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);`);
    
    await client.query('COMMIT');
    console.log('✅ Tabelas do banco de dados verificadas/criadas com sucesso!');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Erro ao criar tabelas:', e);
    throw e; // Lança o erro para impedir o start se o BD falhar
  } finally {
    client.release();
  }
}


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// ============================================
// VARIÁVEIS GLOBAIS
// ============================================
let whatsappClient = null;
let currentQR = null;
let clientStatus = 'disconnected';
let sessionData = null;

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', async (req, res) => {
  try {
    // Testa a conexão com o banco
    await pool.query('SELECT 1');
    res.json({ 
      status: 'ok',
      database: 'connected',
      whatsapp: clientStatus,
      timestamp: new Date().toISOString() 
    });
  } catch (dbError) {
    res.status(500).json({
      status: 'error',
      database: 'disconnected',
      whatsapp: clientStatus,
      error: dbError.message
    });
  }
});

// ============================================
// ENDPOINTS REST (FALLBACK)
// ============================================
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

// ============================================
// WEBSOCKET (LIGADO AO BANCO DE DADOS)
// ============================================

let wss;
let wsClients = new Set();

async function startServer() {
  try {
    // 1. CRIA AS TABELAS DO BANCO PRIMEIRO
    await setupDatabase();
    
    // 2. SE O BANCO ESTIVER OK, INICIA O SERVIDOR
    const server = app.listen(PORT, () => {
      console.log(`🚀 Backend rodando na porta ${PORT}`);
      // 3. INICIA O WHATSAPP
      initializeWhatsApp().catch(err => console.error('Erro na inicialização automática:', err));
    });

    // 4. CONFIGURA O WEBSOCKET
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
                console.log(`Buscando mensagens do BD para ${chatId}`);
                const dbResult = await pool.query(
                  'SELECT * FROM messages WHERE chatId = $1 ORDER BY timestamp DESC LIMIT 50',
                  [chatId]
                );
                const orderedMessages = dbResult.rows.reverse(); 

                if (orderedMessages.length === 0) {
                  console.log(`... Banco vazio. Buscando no WhatsApp (backfill) para ${chatId}`);
                  const chat = await whatsappClient.getChatById(chatId);
                  const messages = await chat.fetchMessages({ limit: 50 });
                  for (const m of messages) {
                    await saveMessageToDb(m);
                  }
                  const newDbResult = await pool.query(
                    'SELECT * FROM messages WHERE chatId = $1 ORDER BY timestamp DESC LIMIT 50',
                    [chatId]
                  );
                  ws.send(JSON.stringify({ type: 'messages', chatId, messages: newDbResult.rows.reverse() }));
                } else {
                  ws.send(JSON.stringify({ type: 'messages', chatId, messages: orderedMessages }));
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
                await whatsappClient.destroy();
                whatsappClient = null;
                currentQR = null;
                clientStatus = 'disconnected';
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
    process.exit(1); // Desliga se o banco de dados falhar
  }
}


// ============================================
// FUNÇÕES AUXILIARES DO BANCO DE DADOS
// ============================================

async function saveMessageToDb(message) {
  try {
    const chatId = message.fromMe ? message.to : message.from;
    const timestamp = new Date(message.timestamp * 1000);

    await pool.query(
      `INSERT INTO messages (id, chatId, body, fromMe, timestamp, type)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [message.id._serialized, chatId, message.body, message.fromMe, timestamp, message.type]
    );

    await pool.query(
      `UPDATE chats
       SET lastMessageBody = $1, lastMessageTimestamp = $2
       WHERE id = $3`,
      [message.body, timestamp, chatId]
    );
  } catch (error) {
    console.error(`❌ Erro ao salvar mensagem no BD: ${error.message}`);
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

      await client.query(
        `INSERT INTO chats (id, name, isGroup, lastMessageBody, lastMessageTimestamp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           lastMessageBody = EXCLUDED.lastMessageBody,
           lastMessageTimestamp = EXCLUDED.lastMessageTimestamp`,
        [
          chat.id._serialized,
          chat.name || chat.id.user || 'Sem nome',
          chat.isGroup,
          lastMsg?.body || null,
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


// ============================================
// INICIALIZAR WHATSAPP (COM DISFARCES)
// ============================================

async function initializeWhatsApp() {
  try {
    if (whatsappClient || clientStatus === 'initializing') {
      console.log('⚠️ Inicialização já em progresso.');
      return;
    }

    console.log('🔄 Inicializando WhatsApp Web.js...');
    clientStatus = 'initializing';
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
  t   
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
            type: message.type
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
