import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import { WebSocketServer } from 'ws';
import pg from 'pg';

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

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
        ack INTEGER 
      );
    `);
    await client.query('COMMIT');
    console.log('✅ Tabelas do banco de dados (Multi-Sessão) verificadas/criadas/migradas com sucesso!');
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

    let chat = null;
    try {
        chat = await client.getChatById(chatId);
    } catch (e) { /* Ignora se o cliente falhou */ }

    if (chat) {
      await dbClient.query(
        `INSERT INTO chats (sessionId, id, name, isGroup)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (sessionId, id) DO NOTHING`,
        [sessionId, chatId, chat.name || chat.id.user || 'Sem nome', chat.isGroup]
      );
    }
    
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
      `INSERT INTO messages (sessionId, id, chatId, body, fromMe, timestamp, type, media_data, ack)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET ack = EXCLUDED.ack`,
      [sessionId, message.id._serialized, chatId, message.body, message.fromMe, timestamp, message.type, mediaData, message.ack || 0]
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
    if (!error.message.includes('Session closed')) {
        console.error(`❌ Erro ao salvar mensagem no BD para ${sessionId}: ${error.message}`);
    }
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
             if (!e.message.includes('Session closed')) {
                 console.error(`❌ Falha ao buscar histórico de chat ${chat.id._serialized} para ${sessionId}: ${e.message}`);
             }
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
        return;
    }
    
    console.log(`🔄 Inicializando WhatsApp Web.js para a sessão: ${sessionId}...`);
    clientData.status = 'initializing';
    broadcastToClients(sessionId, { type: 'status', status: clientData.status });
    clientData.qrCode = null;

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: sessionId,
            // 🛑 CORREÇÃO CRÍTICA DE PERMISSÃO: Mudar o caminho para um diretório gravável
            dataPath: '/tmp/wwebjs-sessions' 
        }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
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
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            const chats = await client.getChats();
            await syncChatsWithDb(sessionId, client, chats); 

            const dbResult = await pool.query(
                'SELECT * FROM chats WHERE sessionId = $1 ORDER BY lastMessageTimestamp DESC LIMIT 100',
                [sessionId]
            );
            broadcastToClients(sessionId, { type: 'chats', chats: dbResult.rows });

        } catch (error) {
            if (!error.message.includes('Invariant Violation')) {
                console.error(`❌ Erro ao pré-carregar chats para ${sessionId}:`, error.message);
            }
        }
    });

    client.on('disconnected', (reason) => {
        console.log(`❌ WhatsApp desconectado para ${sessionId}: ${reason}`);
        clientData.status = 'disconnected';
        clientData.client = null;
        broadcastToClients(sessionId, { type: 'disconnected', reason });

        if (reason !== 'User request') { 
            setTimeout(() => {
                console.log('Tentando re-inicializar após desconexão...');
                initializeWhatsApp(sessionId);
            }, 5000); 
        }
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
                    console.error(`❌ Falha no download da mídia em message_create: ${e.message}`);
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
                    media_data: mediaData,
                    ack: message.ack || 0
                }
            });
        } catch (error) {
            console.error(`Erro ao processar message_create para ${sessionId}: ${error.message}`);
        }
    });

    client.on('message_ack', async (message, ack) => {
        let dbClient;
        try {
            dbClient = await pool.connect();
            await dbClient.query('UPDATE messages SET ack = $1 WHERE id = $2', [ack, message.id._serialized]);
        } catch (error) {
            console.error(`Erro ao atualizar ACK no DB: ${error.message}`);
        } finally {
            if (dbClient) dbClient.release();
        }

        broadcastToClients(sessionId, {
            type: 'message_status',
            id: message.id._serialized,
            ack: ack
        });
    });

    try {
        await client.initialize();
        console.log(`🔄 Cliente ${sessionId} inicializado`);
    } catch (error) {
        console.error(`❌ Erro ao inicializar WhatsApp para ${sessionId}:`, error.message);
        clientData.status = 'error';
        clientData.client = null;
        broadcastToClients(sessionId, { type: 'error', message: error.message });

        setTimeout(() => {
            console.log('Tentando re-inicializar após falha na inicialização...');
            initializeWhatsApp(sessionId);
        }, 5000); 
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
        const sessionId =
