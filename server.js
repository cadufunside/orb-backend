// ⚡ BACKEND v61 - ULTRA PERFORMANCE + PRESENÇA!
import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode';
import { WebSocketServer } from 'ws';
import compression from 'compression';

const app = express();
const PORT = process.env.PORT || 3000;

// ⚡ PERFORMANCE: Compressão GZIP
app.use(compression());

// ⚡ PERFORMANCE: CORS otimizado
app.use(cors({ origin: '*', credentials: true, maxAge: 86400 }));

// ⚡ PERFORMANCE: Limite de payload menor
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ⚡ PERFORMANCE: Cache em memória
let whatsappClients = {};
let wsClients = {};
let messagesCache = {}; // Cache de mensagens
let chatsCache = {}; // Cache de chats

// ⚡ PERFORMANCE: Limpa cache a cada 30 minutos
setInterval(() => {
  const now = Date.now();
  for (const sessionId in messagesCache) {
    if (now - messagesCache[sessionId].timestamp > 1800000) {
      delete messagesCache[sessionId];
    }
  }
  for (const sessionId in chatsCache) {
    if (now - chatsCache[sessionId].timestamp > 1800000) {
      delete chatsCache[sessionId];
    }
  }
}, 1800000);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

const server = app.listen(PORT, () => {
  console.log('========================================');
  console.log('🚀 BACKEND v61 - ULTRA PERFORMANCE + PRESENÇA');
  console.log('========================================');
  console.log('⚡ Port:', PORT);
  console.log('⚡ Time:', new Date().toISOString());
  console.log('⚡ Compression: ENABLED');
  console.log('⚡ Cache: ENABLED');
  console.log('========================================');
});

const wss = new WebSocketServer({ server, path: '/api/whatsapp' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const sessionId = url.searchParams.get('sessionId');
  
  if (!sessionId) {
    ws.close(1008, 'No sessionId');
    return;
  }
  
  console.log('📱 WS connected:', sessionId);
  
  if (!wsClients[sessionId]) wsClients[sessionId] = new Set();
  wsClients[sessionId].add(ws);
  
  const client = whatsappClients[sessionId];
  
  if (client) {
    ws.send(JSON.stringify({ event: 'status', status: client.status }));
    
    if (client.currentQR) {
      ws.send(JSON.stringify({ event: 'qr', qr: client.currentQR }));
    }
    
    if (client.status === 'ready') {
      ws.send(JSON.stringify({ event: 'session.ready' }));
    }
  }
  
  const ping = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ event: 'ping' }));
    }
  }, 30000);
  
  ws.on('close', () => {
    clearInterval(ping);
    if (wsClients[sessionId]) {
      wsClients[sessionId].delete(ws);
      if (wsClients[sessionId].size === 0) delete wsClients[sessionId];
    }
  });
  
  ws.on('error', () => clearInterval(ping));
});

function broadcast(sessionId, data) {
  const clients = wsClients[sessionId];
  if (clients) {
    const msg = JSON.stringify(data);
    clients.forEach(ws => {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch (e) {}
      }
    });
  }
}

app.delete('/api/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    const client = whatsappClients[sessionId];
    
    if (client?.whatsappClient) {
      await client.whatsappClient.destroy();
    }
    
    delete whatsappClients[sessionId];
    delete messagesCache[sessionId];
    delete chatsCache[sessionId];
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/:sessionId/start', async (req, res) => {
  const { sessionId } = req.params;
  
  console.log('🔵 START:', sessionId);
  
  try {
    const existingSession = whatsappClients[sessionId];
    
    if (existingSession?.whatsappClient) {
      await existingSession.whatsappClient.destroy();
      delete whatsappClients[sessionId];
      await new Promise(r => setTimeout(r, 2000));
    }
    
    initWhatsApp(sessionId);
    
    res.json({ success: true, session_id: sessionId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const client = whatsappClients[sessionId];
  
  res.json({ 
    ready: client?.status === 'ready',
    status: client?.status || 'disconnected',
    qr_base64: client?.currentQR || null,
    timestamp: Date.now()
  });
});

// ⚡ PERFORMANCE: Cache de threads
app.get('/api/sessions/:sessionId/threads', async (req, res) => {
  const { sessionId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  
  try {
    const client = whatsappClients[sessionId];
    if (!client || client.status !== 'ready') {
      return res.status(400).json({ error: 'Not ready' });
    }
    
    // Verifica cache (válido por 10 segundos)
    const cachedData = chatsCache[sessionId];
    if (cachedData && (Date.now() - cachedData.timestamp < 10000)) {
      console.log('✅ Using cached threads');
      return res.json({ threads: cachedData.threads });
    }
    
    console.log('📂 Loading threads from WhatsApp...');
    const startTime = Date.now();
    
    const chats = await client.whatsappClient.getChats();
    const threads = [];
    
    // ⚡ PERFORMANCE: Processa apenas o necessário
    const limitedChats = chats.slice(0, limit);
    
    for (const chat of limitedChats) {
      threads.push({
        jid: chat.id._serialized,
        name: chat.name || chat.id.user || 'Unknown',
        is_group: chat.isGroup,
        unread_count: chat.unreadCount || 0,
        last_message: chat.lastMessage ? {
          text: chat.lastMessage.body || '',
          timestamp: chat.lastMessage.timestamp * 1000
        } : null
      });
    }
    
    threads.sort((a, b) => (b.last_message?.timestamp || 0) - (a.last_message?.timestamp || 0));
    
    // Salva no cache
    chatsCache[sessionId] = {
      threads,
      timestamp: Date.now()
    };
    
    const duration = Date.now() - startTime;
    console.log(`✅ Threads loaded in ${duration}ms`);
    
    res.json({ threads });
  } catch (error) {
    console.error('❌ Threads error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ⚡ PERFORMANCE: Cache de mensagens + limite menor
app.get('/api/sessions/:sessionId/messages/:jid/history', async (req, res) => {
  const { sessionId, jid } = req.params;
  const limit = parseInt(req.query.limit) || 30; // Reduzido de 50 para 30
  
  try {
    const client = whatsappClients[sessionId];
    if (!client || client.status !== 'ready') {
      return res.status(400).json({ error: 'Not ready' });
    }
    
    const cacheKey = sessionId + ':' + jid;
    const cachedData = messagesCache[cacheKey];
    
    // Cache válido por 5 segundos
    if (cachedData && (Date.now() - cachedData.timestamp < 5000)) {
      console.log('✅ Using cached messages');
      return res.json({ messages: cachedData.messages });
    }
    
    console.log('📥 Loading messages from WhatsApp...');
    const startTime = Date.now();
    
    const chat = await client.whatsappClient.getChatById(jid);
    if (!chat) return res.status(404).json({ error: 'Not found' });
    
    const messages = await chat.fetchMessages({ limit });
    const formatted = [];
    
    // ⚡ PERFORMANCE: Processa mídias apenas se necessário
    for (const msg of messages) {
      const msgData = {
        id: msg.id._serialized,
        text: msg.body || '',
        from_me: msg.fromMe,
        timestamp: msg.timestamp * 1000,
        type: msg.type,
        ack: msg.ack || 0,
        has_media: msg.hasMedia,
        media_url: null,
        media_type: null
      };
      
      // Não baixa mídia automaticamente - só quando solicitado
      if (msg.hasMedia && msg.type === 'image') {
        msgData.media_placeholder = true;
      }
      
      formatted.push(msgData);
    }
    
    formatted.sort((a, b) => a.timestamp - b.timestamp);
    
    // Salva no cache
    messagesCache[cacheKey] = {
      messages: formatted,
      timestamp: Date.now()
    };
    
    const duration = Date.now() - startTime;
    console.log(`✅ Messages loaded in ${duration}ms`);
    
    res.json({ messages: formatted });
  } catch (error) {
    console.error('❌ Messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ⚡ PERFORMANCE: Envio otimizado
app.post('/api/sessions/:sessionId/messages/text', async (req, res) => {
  const { sessionId } = req.params;
  const { to, text } = req.body;
  
  try {
    const client = whatsappClients[sessionId];
    if (!client || client.status !== 'ready') {
      return res.status(400).json({ error: 'Not ready' });
    }
    
    const chatId = to.includes('@') ? to : to + '@c.us';
    
    console.log('📤 Sending:', to);
    const startTime = Date.now();
    
    const sent = await client.whatsappClient.sendMessage(chatId, text);
    
    const duration = Date.now() - startTime;
    console.log(`✅ Sent in ${duration}ms`);
    
    // Broadcast instantâneo
    broadcast(sessionId, {
      event: 'message.out',
      data: {
        id: sent.id._serialized,
        to: chatId,
        text: text,
        timestamp: sent.timestamp * 1000,
        ack: sent.ack || 1
      }
    });
    
    // Limpa cache para forçar atualização
    delete chatsCache[sessionId];
    
    res.json({ success: true, message_id: sent.id._serialized });
  } catch (error) {
    console.error('❌ Send error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/:sessionId/messages/media', async (req, res) => {
  const { sessionId } = req.params;
  const { to, caption, mediaData, mimetype, filename } = req.body;
  
  try {
    const client = whatsappClients[sessionId];
    if (!client || client.status !== 'ready') {
      return res.status(400).json({ error: 'Not ready' });
    }
    
    const chatId = to.includes('@') ? to : to + '@c.us';
    const media = new MessageMedia(mimetype, mediaData, filename);
    const sent = await client.whatsappClient.sendMessage(chatId, media, { caption: caption || '' });
    
    broadcast(sessionId, {
      event: 'message.out',
      data: {
        id: sent.id._serialized,
        to: chatId,
        text: caption || '[Media]',
        timestamp: sent.timestamp * 1000,
        ack: sent.ack || 1,
        has_media: true
      }
    });
    
    delete chatsCache[sessionId];
    
    res.json({ success: true, message_id: sent.id._serialized });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function initWhatsApp(sessionId) {
  console.log('🎬 INIT:', sessionId);
  
  try {
    whatsappClients[sessionId] = {
      status: 'initializing',
      currentQR: null,
      whatsappClient: null
    };

    const client = new Client({
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
    
    client.on('qr', async (qr) => {
      console.log('📱 QR generated');
      whatsappClients[sessionId].status = 'qr_ready';
      whatsappClients[sessionId].currentQR = await qrcode.toDataURL(qr, {
        errorCorrectionLevel: 'H',
        margin: 1,
        width: 400
      });
      
      broadcast(sessionId, { event: 'qr', qr: whatsappClients[sessionId].currentQR });
    });
    
    client.on('authenticated', () => {
      console.log('🔐 Authenticated:', sessionId);
      whatsappClients[sessionId].status = 'authenticated';
      broadcast(sessionId, { event: 'authenticated' });
    });
    
    client.on('ready', () => {
      console.log('✅ Ready:', sessionId);
      whatsappClients[sessionId].status = 'ready';
      whatsappClients[sessionId].currentQR = null;
      broadcast(sessionId, { event: 'session.ready' });
    });
    
    client.on('message', async (message) => {
      // ⚡ PERFORMANCE: Não baixa mídia automaticamente
      const msgData = {
        from: message.from,
        id: message.id._serialized,
        text: message.body || '',
        from_me: message.fromMe,
        timestamp: message.timestamp * 1000,
        ack: message.ack || 0,
        has_media: message.hasMedia,
        media_url: null,
        media_type: null,
        contact_name: message._data?.notifyName || '',
        is_new: true
      };
      
      broadcast(sessionId, { event: 'message.in', data: msgData });
      
      // Limpa cache
      delete messagesCache[sessionId + ':' + message.from];
      delete chatsCache[sessionId];
    });
    
    client.on('message_ack', (message, ack) => {
      broadcast(sessionId, {
        event: 'message.status',
        data: {
          id: message.id._serialized,
          from: message.from || message.to,
          ack: ack
        }
      });
    });
    
    // ⚡ PRESENCE: Atualização de status online/offline
    client.on('change_state', (state) => {
      console.log('🔄 State:', state);
    });
    
    // Monitora presença de contatos
    setInterval(async () => {
      try {
        const chats = await client.getChats();
        for (const chat of chats.slice(0, 20)) {
          if (!chat.isGroup) {
            const contact = await chat.getContact();
            if (contact) {
              broadcast(sessionId, {
                event: 'presence.update',
                data: {
                  jid: chat.id._serialized,
                  isOnline: contact.isOnline || false,
                  lastSeen: contact.lastSeen || null
                }
              });
            }
          }
        }
      } catch (e) {}
    }, 30000); // A cada 30 segundos
    
    client.on('disconnected', (reason) => {
      console.log('🔴 Disconnected:', sessionId, reason);
      
      if (whatsappClients[sessionId]?.whatsappClient) {
        whatsappClients[sessionId].whatsappClient.destroy().catch(() => {});
      }
      
      delete whatsappClients[sessionId];
      delete messagesCache[sessionId];
      delete chatsCache[sessionId];
      
      broadcast(sessionId, { event: 'disconnected', reason });
    });
    
    whatsappClients[sessionId].whatsappClient = client;
    
    await client.initialize();
    console.log('✅ Initialized:', sessionId);
    
  } catch (error) {
    console.error('❌ Init error:', error);
    
    if (whatsappClients[sessionId]) {
      whatsappClients[sessionId].status = 'error';
    }
    broadcast(sessionId, { event: 'error', message: error.message });
  }
}
