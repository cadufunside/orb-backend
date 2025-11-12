// ⚡ BACKEND v54 - CORREÇÃO DEFINITIVA DO "EXISTS"
import express from 'express';
import cors from 'cors';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

let whatsappClients = {};
let wsClients = {};

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

const server = app.listen(PORT, () => {
  console.log('🚀 Backend v52 running on port', PORT);
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
  
  console.log('🗑️ DELETE session:', sessionId);
  
  try {
    const client = whatsappClients[sessionId];
    if (client?.whatsappClient) {
      console.log('Destroying WhatsApp client...');
      await client.whatsappClient.destroy();
      console.log('✅ WhatsApp client destroyed');
    }
    delete whatsappClients[sessionId];
    console.log('✅ Session deleted from memory');
    res.json({ success: true, message: 'Session deleted' });
  } catch (error) {
    console.error('❌ Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/:sessionId/start', async (req, res) => {
  const { sessionId } = req.params;
  const { force } = req.body;
  
  console.log('📤 START session:', sessionId, '| force:', force);
  
  try {
    // SEMPRE DELETA PRIMEIRO SE EXISTIR (force ou não)
    const existingSession = whatsappClients[sessionId];
    
    if (existingSession) {
      console.log('⚠️ Session exists! Deleting...');
      
      if (existingSession.whatsappClient) {
        try {
          await existingSession.whatsappClient.destroy();
          console.log('✅ Client destroyed');
        } catch (e) {
          console.warn('⚠️ Error destroying:', e.message);
        }
      }
      
      delete whatsappClients[sessionId];
      console.log('✅ Session deleted from memory');
      
      // Aguarda 3 segundos para limpar completamente
      await new Promise(r => setTimeout(r, 3000));
    }
    
    // CRIA NOVA SESSÃO LIMPA
    console.log('🆕 Creating new session...');
    initWhatsApp(sessionId);
    
    // Retorna imediatamente - não espera QR
    console.log('✅ Session initialized, returning...');
    res.json({ 
      success: true,
      message: 'Session started. Poll /status for QR code.',
      session_id: sessionId
    });
    
  } catch (error) {
    console.error('❌ Start error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const client = whatsappClients[sessionId];
  
  res.json({ 
    ready: client?.status === 'ready',
    status: client?.status || 'disconnected',
    qr_base64: client?.currentQR || null
  });
});

app.get('/api/sessions/:sessionId/threads', async (req, res) => {
  const { sessionId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  
  try {
    const client = whatsappClients[sessionId];
    if (!client || client.status !== 'ready') {
      return res.status(400).json({ error: 'Not ready' });
    }
    
    const chats = await client.whatsappClient.getChats();
    const threads = [];
    
    for (const chat of chats.slice(0, limit)) {
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
    res.json({ threads });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:sessionId/messages/:jid/history', async (req, res) => {
  const { sessionId, jid } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  
  try {
    const client = whatsappClients[sessionId];
    if (!client || client.status !== 'ready') {
      return res.status(400).json({ error: 'Not ready' });
    }
    
    const chat = await client.whatsappClient.getChatById(jid);
    if (!chat) return res.status(404).json({ error: 'Not found' });
    
    const messages = await chat.fetchMessages({ limit });
    const formatted = [];
    
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
        } catch (e) {}
      }
      
      formatted.push({
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
    
    formatted.sort((a, b) => a.timestamp - b.timestamp);
    res.json({ messages: formatted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/:sessionId/messages/text', async (req, res) => {
  const { sessionId } = req.params;
  const { to, text } = req.body;
  
  try {
    const client = whatsappClients[sessionId];
    if (!client || client.status !== 'ready') {
      return res.status(400).json({ error: 'Not ready' });
    }
    
    const chatId = to.includes('@') ? to : to + '@c.us';
    const sent = await client.whatsappClient.sendMessage(chatId, text);
    
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
    
    res.json({ success: true, message_id: sent.id._serialized });
  } catch (error) {
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
    
    res.json({ success: true, message_id: sent.id._serialized });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function initWhatsApp(sessionId) {
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
      whatsappClients[sessionId].status = 'qr_ready';
      whatsappClients[sessionId].currentQR = await qrcode.toDataURL(qr, {
        errorCorrectionLevel: 'H',
        margin: 1,
        width: 400
      });
      broadcast(sessionId, { event: 'qr', qr: whatsappClients[sessionId].currentQR });
    });
    
    client.on('authenticated', () => {
      whatsappClients[sessionId].status = 'authenticated';
      broadcast(sessionId, { event: 'authenticated' });
    });
    
    client.on('ready', () => {
      whatsappClients[sessionId].status = 'ready';
      whatsappClients[sessionId].currentQR = null;
      broadcast(sessionId, { event: 'session.ready' });
    });
    
    client.on('message', async (message) => {
      let mediaUrl = null;
      let mediaType = null;
      
      if (message.hasMedia) {
        try {
          const media = await message.downloadMedia();
          if (media) {
            mediaUrl = 'data:' + media.mimetype + ';base64,' + media.data;
            mediaType = media.mimetype;
          }
        } catch (e) {}
      }
      
      broadcast(sessionId, {
        event: 'message.in',
        data: {
          from: message.from,
          id: message.id._serialized,
          text: message.body || '',
          from_me: message.fromMe,
          timestamp: message.timestamp * 1000,
          ack: message.ack || 0,
          has_media: message.hasMedia,
          media_url: mediaUrl,
          media_type: mediaType,
          contact_name: message._data?.notifyName || '',
          is_new: true
        }
      });
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
    
    client.on('disconnected', (reason) => {
      console.log('🔴 Disconnected:', sessionId, '| Reason:', reason);
      
      // LIMPA SESSÃO COMPLETAMENTE
      if (whatsappClients[sessionId]) {
        if (whatsappClients[sessionId].whatsappClient) {
          whatsappClients[sessionId].whatsappClient.destroy().catch(e => {
            console.warn('⚠️ Error destroying on disconnect:', e.message);
          });
        }
        delete whatsappClients[sessionId];
        console.log('✅ Session cleaned up after disconnect');
      }
      
      broadcast(sessionId, { event: 'disconnected', reason });
    });
    
    whatsappClients[sessionId].whatsappClient = client;
    await client.initialize();
  } catch (error) {
    console.error('Init error:', error);
    if (whatsappClients[sessionId]) {
      whatsappClients[sessionId].status = 'error';
    }
    broadcast(sessionId, { event: 'error', message: error.message });
  }
}
