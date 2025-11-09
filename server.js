// BACKEND COM PERSISTÊNCIA E CRIAÇÃO AUTOMÁTICA DE TABELAS
import express from 'express';
import cors from 'cors';
// Importação correta para whatsapp-web.js
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
        chatId VARCHAR(255) REFERENCES chats(id) ON DELETE CASCADE,
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
                // Busca as mensagens em ordem correta (ASC)
                const dbResult = await pool.query(
                  'SELECT * FROM messages WHERE chatId = $1 ORDER BY timestamp ASC LIMIT 100',
                  [chatId]
                );
                
                // Se não tiver no banco, busca no WhatsApp e salva (backfill)
                if (dbResult.rows.length === 0) {
                  console.log(`... Banco vazio. Buscando no WhatsApp (backfill) para ${chatId}`);
                  const chat = await whatsappClient.getChatById(chatId);
                  const messages = await chat.fetchMessages({ limit: 50 });
                  for (const m of messages) {
                    await saveMessageToDb(m);
                  }
                  // Busca de novo no banco após o backfill
                  const newDbResult = await pool.query(
                    'SELECT * FROM messages WHERE chatId = $1 ORDER BY timestamp ASC LIMIT 100',
                    [chatId]
                  );
                  ws.send(JSON.stringify({ type: 'messages', chatId, messages: newDbResult.rows }));
                } else {
                  // Envia as mensagens do banco
                  ws.send(JSON.stringify({ type: 'messages', chatId, messages: dbResult.rows }));
                }
              }
              break;
              
            case 'send_message':
              if (whatsappClient && clientStatus === 'ready') {
                console.log(`Enviando mensagem para ${data.chatId}`);
                const sentMessage = await whatsappClient.sendMessage(data.chatId, data.message);
                await saveMessageToDb(sentMessage); // Salva a mensagem enviada no banco
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
    process.exit(1); // Desliga se o banco de dados falhar
  }
}


// ============================================
// FUNÇÕES AUXILIARES DO BANCO DE DADOS
// ============================================

async function saveMessageToDb(message) {
  let client;
  try {
    const chatId = message.fromMe ? message.to : message.from;
    const timestamp = new Date(message.timestamp * 1000);

    // Ignora mensagens de status (ex: "chamada de voz perdida")
    if (message.type === 'call_log' || message.type === 'e2e_notification' || !message.body) {
      return;
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // 1. Garante que o chat existe. Se não, cria um.
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
        clientId: 'orb-crm-main-session' // ID Fixo para sessão estável
      }),
      puppeteer: {
        headless: true,
        // Disfarce de Navegador
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        // Argumentos "Invisíveis"
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--
