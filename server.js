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

// *** MUDANÇA CRÍTICA: Função RÁPIDA (apenas lista de chats)
async function syncChatList(sessionId, client, chats) {
  let dbClient;
  try {
    console.log(`Syncing ${chats.length} chat headers for session ${sessionId} (FAST)...`);
    dbClient = await pool.connect();
    await dbClient.query('BEGIN'); 

    for (const chat of chats) {
      if (!chat.id || chat.id.user === 'status') continue; 

      const lastMsg = chat.lastMessage;
      const lastMsgTime = lastMsg ? new Date(lastMsg.timestamp * 1000) : null;
      const lastMessageBody = lastMsg?.type === 'image' ? (lastMsg.body || '[Imagem]') : lastMsg?.body;
      const chatIdSerialized = chat.id._serialized;
      
      await dbClient.query(
        `INSERT INTO chats (sessionId, id, name, isGroup, lastMessageBody, lastMessageTimestamp)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (sessionId, id) DO UPDATE SET
           name = EXCLUDED.name,
           lastMessageBody = COALESCE(EXCLUDED.lastMessageBody, chats.lastMessageBody),
           lastMessageTimestamp = COALESCE(EXCLUDED.lastMessageTimestamp, chats.lastMessageTimestamp)`,
        [
          sessionId,
          chatIdSerialized,
          chat.name || chat.id.user || 'Sem nome',
          chat.isGroup,
          lastMessageBody || null,
          lastMsgTime
        ]
      );
    }
    await dbClient.query('COMMIT'); 
    console.log(`✅ Sincronização de Chat Headers concluída para ${sessionId}.`);
  } catch (error) {
    if (dbClient) await dbClient.query('ROLLBACK');
    console.error(`❌ Erro ao sincronizar CHAT LIST para ${sessionId}: ${error.message}`);
  } finally {
    if (dbClient) dbClient.release();
  }
}

// *** MUDANÇA CRÍTICA: Função LENTA (histórico de mensagens) - Executada em background
async function backgroundMessageSync(sessionId, client, chats) {
    console.log(`🔄 Iniciando sincronização de mensagens em background para ${sessionId}. Isso pode levar tempo.`);
    for (const chat of chats) {
        if (!client.info || !client.isRegistered) return; // Parar se o cliente desconectar
        try {
            // Busca as últimas 50 mensagens por chat para histórico inicial
            const messages = await chat.fetchMessages({ limit: 50 });
            for (const m of messages) {
                await saveMessageToDb(sessionId, client, m);
            }
        } catch(e) {
            if (!e.message.includes('Session closed')) {
                // Silencia a maioria dos erros para não poluir o log, mas registra falhas graves
                // console.error(`❌ Falha ao buscar histórico de chat ${chat.id._serialized} para ${sessionId}: ${e.message}`);
            }
        }
    }
    console.log(`✅ Sincronização de histórico de mensagens em background finalizada para ${sessionId}.`);
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
            clientId: sessionId
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
            // Atraso de estabilização
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            const chats = await client.getChats();
            
            // 1. AÇÃO RÁPIDA: Sincroniza apenas a lista de chats (Sem mensagens)
            await syncChatList(sessionId, client, chats); 
            
            // 2. ENVIA OS CHATS PARA O FRONTEND IMEDIATAMENTE (Velocidade!)
            const dbResult = await pool.query(
                'SELECT * FROM chats WHERE sessionId = $1 ORDER BY lastMessageTimestamp DESC LIMIT 100',
                [sessionId]
            );
            broadcastToClients(sessionId, { type: 'chats', chats: dbResult.rows });

            // 3. AÇÃO LENTA: Inicia a sincronização de histórico em background (NÃO BLOQUEIA O FRONTEND)
            backgroundMessageSync(sessionId, client, chats); 

        } catch (error) {
            console.error(`❌ Erro ao pré-carregar/sincronizar chats para ${sessionId}:`, error.message);
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
        // ... (Lógica de message_create idêntica, apenas salva e envia) ...
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
            
            let chatName = null;
            try {
                const chat = await client.getChatById(chatId);
                chatName = chat.name || chat.id.user || 'Sem nome';
            } catch (e) { /* Ignorar falha */ }

            broadcastToClients(sessionId, {
                type: 'message',
                chatId: chatId,
                chatName: chatName,
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
        // Atualiza o ack no DB e envia para o Frontend
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
            // Envia os chats do DB assim que o Front se conecta se o robô estiver pronto
            (async () => {
                const dbResult = await pool.query(
                    'SELECT * FROM chats WHERE sessionId = $1 ORDER BY lastMessageTimestamp DESC LIMIT 100',
                    [sessionId]
                );
                ws.send(JSON.stringify({ type: 'chats', chats: dbResult.rows }));
            })();
        }

        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                const client = clientData.client;
                const status = clientData.status;

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
                            // *** MUDANÇA: Implementação de paginação para carregar histórico completo
                            const limit = data.limit || 50; 
                            const offset = data.offset || 0; 
                            
                            try {
                                const dbResult = await pool.query(
                                    'SELECT * FROM messages WHERE sessionId = $1 AND chatId = $2 ORDER BY timestamp DESC LIMIT $3 OFFSET $4',
                                    [sessionId, chatId, limit, offset]
                                );

                                ws.send(JSON.stringify({ 
                                    type: 'messages', 
                                    chatId, 
                                    messages: dbResult.rows.reverse(), // Mensagens em ordem ascendente (mais antiga primeiro)
                                    limit,
                                    offset 
                                }));
                                console.log(`✅ Histórico puxado do DB (limit ${limit}, offset ${offset}) para ${chatId}.`);

                            } catch (error) {
                                console.error(`❌ Erro ao buscar mensagens para ${sessionId}: ${error.message}`);
                                ws.send(JSON.stringify({ type: 'error', message: error.message }));
                            }
                        }
                        break;
                        
                    case 'send_message':
                        if (status === 'ready' && client) {
                            console.log(`Enviando mensagem para ${data.chatId} de ${sessionId}`);
                            const sentMessage = await client.sendMessage(data.chatId, data.message);
                            await saveMessageToDb(sessionId, client, sentMessage);
                            
                            broadcastToClients(sessionId, {
                                type: 'message',
                                chatId: data.chatId,
                                message: {
                                    id: sentMessage.id._serialized,
                                    body: sentMessage.body,
                                    fromMe: true,
                                    timestamp: sentMessage.timestamp * 1000,
                                    type: sentMessage.type,
                                    ack: sentMessage.ack || 0
                                }
                            });
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
                console.error(`❌ Erro ao processar mensagem WS: ${error.message}`);
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

// ... (Rotas OAuth omitidas por brevidade, mas devem permanecer no seu arquivo) ...

process.on('unhandledRejection', (error) => console.error(error));
process.on('uncaughtException', (error) => console.error(error));

startServer();
