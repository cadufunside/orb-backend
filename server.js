// ⚡ BACKEND v39 - PROTEÇÃO CONTRA RACE CONDITIONS
import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

let whatsappClients = {};
let wsClients = {};

// ✅ HELPER PARA GARANTIR QUE O CLIENTE EXISTE
function ensureClientExists(sessionId) {
  if (!whatsappClients[sessionId]) {
    whatsappClients[sessionId] = {
      status: 'disconnected',
      currentQR: null,
      whatsappClient: null
    };
  }
  return whatsappClients[sessionId];
}

// ✅ HELPER PARA ATUALIZAR STATUS COM SEGURANÇA
function updateClientStatus(sessionId, status) {
  const client = ensureClientExists(sessionId);
  client.status = status;
  console.log(`📊 Status [${sessionId}]: ${status}`);
}

// ✅ FUNÇÃO PARA ADICIONAR LOGO AO QR CODE
async function generateQRWithLogo(qrText) {
  try {
    const qrDataUrl = await qrcode.toDataURL(qrText, {
      errorCorrectionLevel: 'H',
      margin: 1,
      width: 400,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    return qrDataUrl;
  } catch (error) {
    console.error('❌ Erro ao gerar QR:', error);
    return await qrcode.toDataURL(qrText);
  }
}

// ✅ HEALTH CHECK
app.get('/api/health', (req, res) => {
  const sessionStatuses = {};
  Object.keys(whatsappClients).forEach(sessionId => {
    sessionStatuses[sessionId] = whatsappClients[sessionId]?.status || 'disconnected';
  });
  res.json({ status: 'ok', timestamp: Date.now(), sessions: sessionStatuses });
});

const server = app.listen(PORT, () => {
  console.log('🚀 Backend v39 rodando na porta', PORT);
  console.log('✅ Proteção contra race conditions ativa');
});

// ✅ WEBSOCKET SERVER
let wss;
try {
  wss = new WebSocketServer({ server, path: '/api/whatsapp' });
  console.log('✅ WebSocket pronto em /api/whatsapp');
  
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
    ws.send(JSON.stringify({ event: 'status', status: client?.status || 'disconnected' }));
    
    if (client?.currentQR && client?.status === 'qr_ready') {
      ws.send(JSON.stringify({ event: 'qr', qr: client.currentQR }));
    } else if (client?.status === 'ready') {
      ws.send(JSON.stringify({ event: 'session.ready' }));
    }
    
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

// ✅ DESTRUIR SESSÃO
app.delete('/api/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  console.log('🗑️ DELETE /api/sessions/' + sessionId);
  
  try {
    const client = whatsappClients[sessionId];
    
    if (!client) {
      return res.json({ success: true, message: 'Sessão não existe' });
    }
    
    if (client.whatsappClient) {
      try {
        await client.whatsappClient.destroy();
        console.log('✅ Cliente WhatsApp destruído');
      } catch (e) {
        console.error('⚠️ Erro ao destruir cliente:', e.message);
      }
    }
    
    delete whatsappClients[sessionId];
    broadcastToSession(sessionId, { event: 'session.destroyed' });
    
    res.json({ success: true, message: 'Sessão destruída' });
    
  } catch (error) {
    console.error('❌ Erro delete:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ INICIAR SESSÃO (com force)
app.post('/api/sessions/:sessionId/start', async (req, res) => {
  const { sessionId } = req.params;
  const { force } = req.body;
  console.log('📤 POST /api/sessions/' + sessionId + '/start', force ? '(FORCE)' : '');
  
  try {
    if (force && whatsappClients[sessionId]) {
      console.log('🔥 Force reconnect - destruindo sessão antiga...');
      const client = whatsappClients[sessionId];
      
      if (client.whatsappClient) {
        try {
          await client.whatsappClient.destroy();
        } catch (e) {
          console.error('⚠️ Erro ao destruir:', e.message);
        }
      }
      
      delete whatsappClients[sessionId];
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (whatsappClients[sessionId] && whatsappClients[sessionId].status !== 'disconnected') {
      return res.json({ 
        error: 'Sessão já existe',
        status: whatsappClients[sessionId].status,
        can_force: true
      });
    }
    
    await initializeWhatsApp(sessionId);
    
    let attempts = 0;
    while (attempts < 20) {
      await new Promise(resolve => setTimeout(resolve, 500));
      
      if (whatsappClients[sessionId]?.currentQR) {
        return res.json({ 
          qr_base64: whatsappClients[sessionId].currentQR,
          status: 'qr_ready'
        });
      }
      
      if (whatsappClients[sessionId]?.status === 'ready') {
        return res.json({ status: 'ready' });
      }
      
      attempts++;
    }
    
    return res.json({ error: 'Timeout aguardando QR Code' });
    
  } catch (error) {
    console.error('❌ Erro start:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ STATUS DA SESSÃO
app.get('/api/sessions/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const client = whatsappClients[sessionId];
  
  if (!client) {
    return res.json({ ready: false, status: 'disconnected' });
  }
  
  res.json({ 
    ready: client.status === 'ready',
    status: client.status,
    qr_base64: client.currentQR || null
  });
});

// ✅ BUSCAR CONVERSAS (THREADS)
app.get('/api/sessions/:sessionId/threads', async (req, res) => {
  const { sessionId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  
  try {
    const client = whatsappClients[sessionId];
    
    if (!client || client.status !== 'ready') {
      return res.status(400).json({ error: 'Sessão não conectada' });
    }
    
    const whatsappClient = client.whatsappClient;
    const chats = await whatsappClient.getChats();
    
    const threads = [];
    
    for (const chat of chats.slice(0, limit)) {
      let profilePicUrl = null;
      try {
        profilePicUrl = await chat.getProfilePicUrl();
      } catch (e) {}
      
      threads.push({
        jid: chat.id._serialized,
        name: chat.name || chat.id.user || 'Sem nome',
        is_group: chat.isGroup,
        unread_count: chat.unreadCount || 0,
        last_message: chat.lastMessage ? {
          text: chat.lastMessage.body || '',
          timestamp: chat.lastMessage.timestamp * 1000
        } : null,
        profile_pic_url: profilePicUrl
      });
    }
    
    threads.sort((a, b) => {
      const aTime = a.last_message?.timestamp || 0;
      const bTime = b.last_message?.timestamp || 0;
      return bTime - aTime;
    });
    
    res.json({ threads });
    
  } catch (error) {
    console.error('❌ Erro threads:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ BUSCAR HISTÓRICO DE MENSAGENS
app.get('/api/sessions/:sessionId/messages/:jid/history', async (req, res) => {
  const { sessionId, jid } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  
  try {
    const client = whatsappClients[sessionId];
    
    if (!client || client.status !== 'ready') {
      return res.status(400).json({ error: 'Sessão não conectada' });
    }
    
    const whatsappClient = client.whatsappClient;
    const chat = await whatsappClient.getChatById(jid);
    
    if (!chat) {
      return res.status(404).json({ error: 'Chat não encontrado' });
    }
    
    const messages = await chat.fetchMessages({ limit: limit });
    const formattedMessages = [];
    
    for (const msg of messages) {
      let mediaUrl = null;
      let mediaType = null;
      
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            mediaUrl = 'data:' + media.mimetype + ';base64,' + media.data;
            mediaType = media.mimetype;
          }
        } catch (e) {
          console.error('⚠️ Erro mídia:', e.message);
        }
      }
      
      formattedMessages.push({
        id: msg.id._serialized,
        text: msg.body || '',
        from_me: msg.fromMe,
        timestamp: msg.timestamp * 1000,
        type: msg.type,
        ack: msg.ack || 0,
        has_media: msg.hasMedia,
        media_url: mediaUrl,
        media_type: mediaType
      });
    }
    
    formattedMessages.sort((a, b) => a.timestamp - b.timestamp);
    res.json({ messages: formattedMessages });
    
  } catch (error) {
    console.error('❌ Erro messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ ENVIAR MENSAGEM DE TEXTO
app.post('/api/sessions/:sessionId/messages/text', async (req, res) => {
  const { sessionId } = req.params;
  const { to, text } = req.body;
  
  try {
    const client = whatsappClients[sessionId];
    
    if (!client || client.status !== 'ready') {
      return res.status(400).json({ error: 'Sessão não conectada' });
    }
    
    const whatsappClient = client.whatsappClient;
    const chatId = to.includes('@') ? to : to + '@c.us';
    
    const sentMsg = await whatsappClient.sendMessage(chatId, text);
    
    res.json({ 
      success: true,
      message_id: sentMsg.id._serialized,
      timestamp: sentMsg.timestamp * 1000
    });
    
  } catch (error) {
    console.error('❌ Erro send:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ INICIALIZAR WHATSAPP CLIENT - VERSÃO COM PROTEÇÃO
async function initializeWhatsApp(sessionId) {
  try {
    if (whatsappClients[sessionId] && whatsappClients[sessionId].whatsappClient) {
      console.log('⚠️ Cliente já existe e está sendo inicializado/já inicializado:', sessionId);
      return;
    }
    
    console.log('🔄 Init WhatsApp:', sessionId);
    
    // Garante que o objeto whatsappClients[sessionId] existe antes de usá-lo
    const clientState = ensureClientExists(sessionId);
    clientState.status = 'initializing';

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
        ]
      }
    });
    
    whatsappClient.on('qr', async (qr) => {
      console.log('📱 QR gerado');
      const client = ensureClientExists(sessionId); // Garante que o objeto ainda existe
      client.status = 'qr_ready';
      client.currentQR = await generateQRWithLogo(qr);
      broadcastToSession(sessionId, { 
        event: 'qr', 
        qr: client.currentQR 
      });
    });
    
    whatsappClient.on('authenticated', () => {
      console.log('✅ Autenticado');
      updateClientStatus(sessionId, 'authenticated'); // Usa o helper seguro
      broadcastToSession(sessionId, { event: 'authenticated' });
    });
    
    whatsappClient.on('ready', async () => {
      console.log('🎉 READY!');
      const client = ensureClientExists(sessionId); // Garante que o objeto ainda existe
      client.status = 'ready';
      client.currentQR = null;
      broadcastToSession(sessionId, { event: 'session.ready' });
    });
    
    whatsappClient.on('message', async (message) => {
      const chatId = message.from;
      
      let mediaUrl = null;
      let mediaType = null;
      
      if (message.hasMedia) {
        try {
          const media = await message.downloadMedia();
          if (media) {
            mediaUrl = 'data:' + media.mimetype + ';base64,' + media.data;
            mediaType = media.mimetype;
          }
        } catch (e) {
          console.error('⚠️ Erro mídia:', e.message);
        }
      }
      
      broadcastToSession(sessionId, {
        event: 'message.in',
        data: {
          from: chatId,
          id: message.id._serialized,
          text: message.body || '',
          from_me: message.fromMe,
          timestamp: message.timestamp * 1000,
          ack: message.ack || 0,
          has_media: message.hasMedia,
          media_url: mediaUrl,
          media_type: mediaType
        }
      });
    });
    
    whatsappClient.on('message_ack', async (message, ack) => {
      broadcastToSession(sessionId, {
        event: 'message.status',
        data: {
          id: message.id._serialized,
          from: message.from || message.to,
          ack: ack
        }
      });
    });
    
    whatsappClient.on('disconnected', (reason) => {
      console.log('🔴 Desconectado:', reason);
      if (whatsappClients[sessionId]) { // Adiciona verificação antes de deletar
        delete whatsappClients[sessionId];
      }
      broadcastToSession(sessionId, { event: 'disconnected', reason });
    });
    
    ensureClientExists(sessionId).whatsappClient = whatsappClient; // Garante que o objeto existe antes de atribuir
    await whatsappClient.initialize();
    console.log('✅ Cliente inicializado');
    
  } catch (error) {
    console.error('❌ Erro init:', error);
    if (whatsappClients[sessionId]) {
      whatsappClients[sessionId].status = 'error';
    }
    broadcastToSession(sessionId, { event: 'error', message: error.message });
  }
}

process.on('unhandledRejection', (error) => console.error('Unhandled:', error));
process.on('uncaughtException', (error) => console.error('Uncaught:', error));
