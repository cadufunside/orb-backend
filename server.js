// ⚡ BACKEND v4.0 - COM FOTOS DE PERFIL E CAPTURA AO VIVO
import express from 'express';
import cors from 'cors';
import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode';
import { WebSocketServer } from 'ws';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => console.log('📊 PostgreSQL conectado!'));
pool.on('error', (err) => console.error('❌ Erro PostgreSQL:', err));

async function setupDatabase() {
  let client;
  try {
    console.log('🔄 Setup banco...');
    client = await pool.connect();
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        name TEXT,
        lastMessage TEXT,
        timestamp BIGINT,
        isGroup BOOLEAN DEFAULT FALSE,
        unreadCount INTEGER DEFAULT 0,
        profilePicUrl TEXT,
        createdAt TIMESTAMP DEFAULT NOW(),
        updatedAt TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chats_sessionid ON chats(sessionId)`);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        chatId TEXT NOT NULL,
        body TEXT,
        fromMe BOOLEAN DEFAULT FALSE,
        timestamp BIGINT,
        type TEXT DEFAULT 'chat',
        ack INTEGER DEFAULT 0,
        hasMedia BOOLEAN DEFAULT FALSE,
        mediaUrl TEXT,
        createdAt TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE
      )
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_sessionid ON messages(sessionId)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_chatid_timestamp ON messages(chatId, timestamp)`);
    
    console.log('✅ Database OK');
  } catch (error) {
    console.error('❌ Erro setup:', error);
    throw error;
  } finally {
    if (client) client.release();
  }
}

app.post('/api/db-cleanup', async (req, res) => {
  console.log('⚠️ LIMPEZA DB');
  let client;
  try {
    const authToken = req.headers['x-cleanup-token'];
    if (process.env.CLEANUP_TOKEN && authToken !== process.env.CLEANUP_TOKEN) {
      return res.status(403).json({ status: 'error', message: 'Token inválido' });
    }
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('DROP TABLE IF EXISTS messages CASCADE');
    await client.query('DROP TABLE IF EXISTS chats CASCADE');
    await client.query('COMMIT');
    await setupDatabase();
    console.log('🎉 LIMPEZA OK');
    res.json({ status: 'success', message: 'Tabelas limpas', timestamp: new Date().toISOString() });
  } catch (e) {
    if (client) await client.query('ROLLBACK');
    console.error('❌ FALHA:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  } finally {
    if (client) client.release();
  }
});

let whatsappClients = {};
let wsClients = {};

app.get('/health', (req, res) => {
  const sessionStatuses = {};
  Object.keys(whatsappClients).forEach(sessionId => {
    sessionStatuses[sessionId] = whatsappClients[sessionId]?.status || 'disconnected';
  });
  res.json({ status: 'ok', timestamp: Date.now(), sessions: sessionStatuses });
});

const server = app.listen(PORT, async () => {
  console.log('🚀 Backend porta ' + PORT);
  await setupDatabase();
  console.log('✅ Pronto para WhatsApp');
});

let wss;

try {
  wss = new WebSocketServer({ server, path: '/whatsapp' });
  console.log('✅ WebSocket pronto');
  
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const sessionId = url.searchParams.get('sessionId');
    
    console.log('📱 Cliente conectado:', sessionId);
    
    if (!sessionId) {
      ws.close(1008, 'sessionId obrigatório');
      return;
    }
    
    if (!wsClients[sessionId]) {
      wsClients[sessionId] = new Set();
    }
    wsClients[sessionId].add(ws);
    
    const client = whatsappClients[sessionId];
    ws.send(JSON.stringify({ type: 'status', status: client?.status || 'disconnected' }));
    
    if (client?.currentQR && client?.status === 'qr_ready') {
      ws.send(JSON.stringify({ type: 'qr', qr: client.currentQR }));
    } else if (client?.status === 'ready') {
      ws.send(JSON.stringify({ type: 'ready' }));
    }
    
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        
        switch (data.type) {
          case 'request_qr':
            if (!whatsappClients[sessionId]) {
              await initializeWhatsApp(sessionId);
            }
            const c = whatsappClients[sessionId];
            if (c?.currentQR) {
              ws.send(JSON.stringify({ type: 'qr', qr: c.currentQR }));
            } else if (c?.status === 'ready') {
              ws.send(JSON.stringify({ type: 'ready' }));
            }
            break;
          case 'get_chats':
            if (whatsappClients[sessionId]?.status === 'ready') {
              await handleGetChats(sessionId, ws);
            }
            break;
          case 'get_messages':
            if (whatsappClients[sessionId]?.status === 'ready') {
              await handleGetMessages(sessionId, data.chatId, data.limit || 100, data.offset || 0, ws);
            }
            break;
          case 'send_message':
            if (whatsappClients[sessionId]?.status === 'ready') {
              await handleSendMessage(sessionId, data.chatId, data.message, ws);
            }
            break;
          case 'disconnect':
            if (whatsappClients[sessionId]?.whatsappClient) {
              await whatsappClients[sessionId].whatsappClient.destroy();
              delete whatsappClients[sessionId];
            }
            break;
        }
      } catch (error) {
        console.error('❌ Erro:', error);
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    });
    
    ws.on('close', () => {
      console.log('🔌 Cliente desconectado:', sessionId);
      if (wsClients[sessionId]) {
        wsClients[sessionId].delete(ws);
        if (wsClients[sessionId].size === 0) {
          delete wsClients[sessionId];
        }
      }
    });
  });
} catch (error) {
  console.warn('⚠️ WebSocket erro:', error.message);
}

function broadcastToSession(sessionId, data) {
  const message = JSON.stringify(data);
  const clients = wsClients[sessionId];
  if (clients) {
    clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  }
}

async function handleGetChats(sessionId, ws) {
  try {
    console.log('📊 GET CHATS - DB');
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT * FROM chats WHERE sessionId = $1 ORDER BY timestamp DESC',
        [sessionId]
      );
      
      const chatList = result.rows.map(row => ({
        id: row.id,
        name: row.name,
        lastMessage: row.lastmessage,
        timestamp: parseInt(row.timestamp),
        isGroup: row.isgroup,
        unreadCount: row.unreadcount || 0,
        profilePicUrl: row.profilepicurl
      }));
      
      console.log('✅', chatList.length, 'chats enviados');
      ws.send(JSON.stringify({ type: 'chats', chats: chatList }));
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('❌ Erro:', error);
    ws.send(JSON.stringify({ type: 'error', message: error.message }));
  }
}

async function handleGetMessages(sessionId, chatId, limit, offset, ws) {
  try {
    console.log('📨 GET MESSAGES:', chatId, 'limit:', limit, 'offset:', offset);
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT * FROM messages WHERE sessionId = $1 AND chatId = $2 ORDER BY timestamp ASC LIMIT $3 OFFSET $4',
        [sessionId, chatId, limit, offset]
      );
      
      const messageList = result.rows.map(row => ({
        id: row.id,
        body: row.body,
        fromMe: row.fromme,
        timestamp: parseInt(row.timestamp),
        type: row.type,
        ack: row.ack || 0,
        hasMedia: row.hasmedia || false,
        mediaUrl: row.mediaurl
      }));
      
      console.log('✅', messageList.length, 'mensagens enviadas');
      ws.send(JSON.stringify({ type: 'messages', chatId, messages: messageList }));
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('❌ Erro:', error);
    ws.send(JSON.stringify({ type: 'error', message: error.message }));
  }
}

async function handleSendMessage(sessionId, chatId, messageText, ws) {
  try {
    const whatsappClient = whatsappClients[sessionId]?.whatsappClient;
    if (!whatsappClient) throw new Error('Cliente não encontrado');
    
    const sentMsg = await whatsappClient.sendMessage(chatId, messageText);
    console.log('✅ Mensagem enviada:', sentMsg.id._serialized);
    
    const message = {
      id: sentMsg.id._serialized,
      body: messageText,
      fromMe: true,
      timestamp: sentMsg.timestamp * 1000,
      type: 'chat',
      ack: sentMsg.ack || 0,
      hasMedia: false, // Assume false for plain text messages
      mediaUrl: null
    };
    
    const dbClient = await pool.connect();
    try {
      await dbClient.query(
        'INSERT INTO messages (id, sessionId, chatId, body, fromMe, timestamp, type, ack) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING',
        [message.id, sessionId, chatId, message.body, message.fromMe, message.timestamp, message.type, message.ack]
      );
      
      await dbClient.query(
        'UPDATE chats SET lastMessage = $1, timestamp = $2, updatedAt = NOW() WHERE id = $3 AND sessionId = $4',
        [message.body, message.timestamp, chatId, sessionId]
      );
    } finally {
      dbClient.release();
    }
    
    broadcastToSession(sessionId, { type: 'message', chatId, ...message });
    ws.send(JSON.stringify({ type: 'message_sent', chatId, success: true }));
  } catch (error) {
    console.error('❌ Erro send:', error);
    ws.send(JSON.stringify({ type: 'error', message: error.message }));
  }
}

async function initializeWhatsApp(sessionId) {
  try {
    if (whatsappClients[sessionId]) {
      console.log('⚠️ Cliente já existe');
      return;
    }
    
    console.log('🔄 Init WhatsApp:', sessionId);
    
    whatsappClients[sessionId] = {
      status: 'initializing',
      currentQR: null,
      whatsappClient: null
    };
    
    const whatsappClient = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
          // Removed some args that might cause issues or are less critical for basic operation
        ]
      }
    });
    
    whatsappClient.on('qr', async (qr) => {
      console.log('📱 QR gerado');
      whatsappClients[sessionId].status = 'qr_ready';
      whatsappClients[sessionId].currentQR = await qrcode.toDataURL(qr);
      broadcastToSession(sessionId, { type: 'qr', qr: whatsappClients[sessionId].currentQR });
    });
    
    whatsappClient.on('authenticated', () => {
      console.log('✅ Autenticado');
      whatsappClients[sessionId].status = 'authenticated';
      broadcastToSession(sessionId, { type: 'authenticated' });
    });
    
    whatsappClient.on('ready', async () => {
      console.log('🎉 READY!');
      whatsappClients[sessionId].status = 'ready';
      whatsappClients[sessionId].currentQR = null;
      broadcastToSession(sessionId, { type: 'ready' });
      
      // 🔥 SINCRONIZAR TODOS OS CHATS COM FOTOS E MENSAGENS RECENTES
      try {
        console.log('📊 Sincronizando chats + fotos + mensagens recentes...');
        const chats = await whatsappClient.getChats();
        const dbClient = await pool.connect();
        
        try {
          for (const chat of chats) {
            // 🔥 BUSCAR FOTO DE PERFIL
            let profilePicUrl = null;
            try {
              profilePicUrl = await chat.getProfilePicUrl();
            } catch (e) {
              console.warn(`⚠️ Sem foto de perfil para ${chat.name || chat.id._serialized}`);
            }
            
            await dbClient.query(
              `INSERT INTO chats (id, sessionId, name, lastMessage, timestamp, isGroup, unreadCount, profilePicUrl)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (id) DO UPDATE SET
                 name = EXCLUDED.name,
                 lastMessage = EXCLUDED.lastMessage,
                 timestamp = EXCLUDED.timestamp,
                 unreadCount = EXCLUDED.unreadCount,
                 profilePicUrl = EXCLUDED.profilePicUrl,
                 updatedAt = NOW()`,
              [
                chat.id._serialized,
                sessionId,
                chat.name || chat.id.user || 'Sem nome',
                chat.lastMessage?.body || '',
                chat.lastMessage?.timestamp * 1000 || Date.now(),
                chat.isGroup,
                chat.unreadCount || 0,
                profilePicUrl
              ]
            );
            
            // 🔥 SINCRONIZAR MENSAGENS RECENTES (últimas 100)
            try {
              const messages = await chat.fetchMessages({ limit: 100 });
              
              for (const msg of messages) {
                await dbClient.query(
                  `INSERT INTO messages (id, sessionId, chatId, body, fromMe, timestamp, type, ack, hasMedia)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                   ON CONFLICT (id) DO NOTHING`,
                  [
                    msg.id._serialized,
                    sessionId,
                    chat.id._serialized,
                    msg.body || '',
                    msg.fromMe,
                    msg.timestamp * 1000,
                    msg.type,
                    msg.ack || 0,
                    msg.hasMedia
                  ]
                );
              }
              
              console.log('💾', chat.name, '→', messages.length, 'mensagens sincronizadas');
            } catch (e) {
              console.error('⚠️ Erro ao buscar mensagens para chat:', chat.name, e.message);
            }
          }
        } finally {
          dbClient.release();
        }
        
        console.log('✅ Sincronização completa de chats e mensagens!');
      } catch (error) {
        console.error('❌ Erro durante sincronização inicial:', error);
      }
    });
    
    whatsappClient.on('message', async (message) => {
      const chatId = message.from;
      console.log('📨 Nova mensagem:', message.from, '→', message.body.substring(0, 30), '...');
      
      const dbClient = await pool.connect();
      try {
        await dbClient.query(
          `INSERT INTO messages (id, sessionId, chatId, body, fromMe, timestamp, type, ack, hasMedia)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            message.id._serialized,
            sessionId,
            chatId,
            message.body || '',
            message.fromMe,
            message.timestamp * 1000,
            message.type,
            message.ack || 0,
            message.hasMedia
          ]
        );
        
        // Update chat's last message and timestamp
        await dbClient.query(
          'UPDATE chats SET lastMessage = $1, timestamp = $2, updatedAt = NOW() WHERE id = $3 AND sessionId = $4',
          [message.body, message.timestamp * 1000, chatId, sessionId]
        );
      } finally {
        dbClient.release();
      }
      
      broadcastToSession(sessionId, {
        type: 'message',
        chatId: chatId,
        id: message.id._serialized,
        body: message.body,
        fromMe: message.fromMe,
        timestamp: message.timestamp * 1000,
        ack: message.ack || 0,
        hasMedia: message.hasMedia
      });
    });

    whatsappClient.on('message_ack', async (message, ack) => {
      console.log('✓ ACK atualizado:', message.id._serialized, '→', ack);
      
      const dbClient = await pool.connect();
      try {
        await dbClient.query(
          'UPDATE messages SET ack = $1 WHERE id = $2 AND sessionId = $3',
          [ack, message.id._serialized, sessionId]
        );
      } finally {
        dbClient.release();
      }
      
      broadcastToSession(sessionId, {
        type: 'message_status',
        id: message.id._serialized,
        chatId: message.from || message.to, // Use message.to for outgoing messages
        ack: ack
      });
    });
    
    whatsappClient.on('disconnected', (reason) => {
      console.log('🔴 Desconectado:', reason);
      delete whatsappClients[sessionId];
      broadcastToSession(sessionId, { type: 'disconnected', reason });
    });
    
    whatsappClients[sessionId].whatsappClient = whatsappClient;
    await whatsappClient.initialize();
    console.log('✅ Cliente inicializado');
    
  } catch (error) {
    console.error('❌ Erro init:', error);
    if (whatsappClients[sessionId]) {
      whatsappClients[sessionId].status = 'error';
    }
    broadcastToSession(sessionId, { type: 'error', message: error.message });
  }
}

process.on('unhandledRejection', (error) => console.error('Unhandled:', error));
process.on('uncaughtException', (error) => console.error('Uncaught:', error));
