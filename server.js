// BACKEND COM PERSISTÊNCIA E CARGA DE HISTÓRICO (v9 - 100% LIMPO)
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
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ============================================
// FUNÇÃO: CRIAR TABELAS AUTOMATICAMENTE
// ============================================
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
        type VARCHAR(100)
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


// ============================================
// FUNÇÕES AUXILIARES DO BANCO DE DADOS
// ============================================

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

    // 1. Garante que o chat existe.
    const chat = await whatsappClient.getChatById(chatId);
    await client.query(
      `INSERT INTO chats (id, name, isGroup)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [chatId, chat.name || chat.id.user || 'Sem nome', chat.isGroup]
    );
    
    // 2. Salva a mensagem
    await client.query(
      `INSERT INTO messages (id, chatId, body, fromMe, timestamp, type)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`, // Ignora se a mensagem já existir
      [message.id._serialized, chatId, message.body, message.fromMe, timestamp, message.type]
    );

    // 3. Atualiza o chat com a última mensagem
    await client.query(
      `UPDATE chats
       SET lastMessageBody = $1, lastMessageTimestamp = $2
       WHERE id = $3`,
      [message.body, timestamp, chatId]
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
    broadcastToClients({ type: 'status', status: clientStatus });
    currentQR = null;
    
    whatsappClient = new Client({
      authStrategy: new LocalAuth({
        clientId: 'orb-crm-main-session'
