// ⚡ BACKEND v55 - LOGS EXTREMOS PARA DEBUG
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
  console.log('========================================');
  console.log('🚀 BACKEND v55 - LOGS EXTREMOS');
  console.log('========================================');
  console.log('⚡ Port:', PORT);
  console.log('⚡ Time:', new Date().toISOString());
  console.log('⚡ Environment:', process.env.NODE_ENV || 'production');
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
  
  console.log('========================================');
  console.log('🗑️ DELETE REQUEST');
  console.log('SessionId:', sessionId);
  console.log('Existing clients:', Object.keys(whatsappClients));
  console.log('========================================');
  
  try {
    const client = whatsappClients[sessionId];
    
    if (client) {
      console.log('📌 Client found! Status:', client.status);
      
      if (client.whatsappClient) {
        console.log('🔨 Destroying WhatsApp client...');
        await client.whatsappClient.destroy();
        console.log('✅ WhatsApp client destroyed');
      } else {
        console.log('⚠️ No whatsappClient object');
      }
      
      delete whatsappClients[sessionId];
      console.log('✅ Deleted from memory');
    } else {
      console.log('⚠️ Client not found in memory');
    }
    
    console.log('📊 Remaining clients:', Object.keys(whatsappClients));
    console.log('========================================');
    
    res.json({ success: true, message: 'Session deleted' });
  } catch (error) {
    console.error('========================================');
    console.error('❌ DELETE ERROR:', error.message);
    console.error('Stack:', error.stack);
    console.error('========================================');
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/:sessionId/start', async (req, res) => {
  const { sessionId } = req.params;
  const { force } = req.body;
  
  console.log('========================================');
  console.log('📤 START REQUEST');
  console.log('SessionId:', sessionId);
  console.log('Force:', force);
  console.log('Existing clients:', Object.keys(whatsappClients));
  console.log('Time:', new Date().toISOString());
  console.log('========================================');
  
  try {
    const existingSession = whatsappClients[sessionId];
    
    if (existingSession) {
      console.log('⚠️ SESSION EXISTS!');
      console.log('Status:', existingSession.status);
      console.log('Has whatsappClient:', !!existingSession.whatsappClient);
      console.log('Has currentQR:', !!existingSession.currentQR);
      
      console.log('🔨 DESTROYING EXISTING SESSION...');
      
      if (existingSession.whatsappClient) {
        try {
          console.log('⏳ Calling destroy()...');
          await existingSession.whatsappClient.destroy();
          console.log('✅ destroy() completed');
        } catch (e) {
          console.error('❌ Error in destroy():', e.message);
          console.error('Stack:', e.stack);
        }
      } else {
        console.log('⚠️ No whatsappClient to destroy');
      }
      
      console.log('🗑️ Deleting from memory...');
      delete whatsappClients[sessionId];
      console.log('✅ Deleted from memory');
      
      console.log('⏳ Waiting 3 seconds for cleanup...');
      await new Promise(r => setTimeout(r, 3000));
      console.log('✅ Cleanup wait complete');
    } else {
      console.log('✅ No existing session found');
    }
    
    console.log('========================================');
    console.log('🆕 CREATING NEW SESSION');
    console.log('SessionId:', sessionId);
    console.log('Time:', new Date().toISOString());
    console.log('========================================');
    
    initWhatsApp(sessionId);
    
    console.log('========================================');
    console.log('✅ INIT CALLED');
    console.log('Clients after init:', Object.keys(whatsappClients));
    console.log('Returning success to frontend');
    console.log('========================================');
    
    res.json({ 
      success: true,
      message: 'Session started. Poll /status for QR code.',
      session_id: sessionId,
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error('========================================');
    console.error('❌ START ERROR');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    console.error('========================================');
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const client = whatsappClients[sessionId];
  
  console.log('========================================');
  console.log('📊 STATUS CHECK');
  console.log('SessionId:', sessionId);
  console.log('Client exists:', !!client);
  if (client) {
    console.log('Status:', client.status);
    console.log('Has QR:', !!client.currentQR);
    console.log('QR length:', client.currentQR?.length || 0);
    console.log('Has whatsappClient:', !!client.whatsappClient);
  }
  console.log('All clients:', Object.keys(whatsappClients));
  console.log('========================================');
  
  res.json({ 
    ready: client?.status === 'ready',
    status: client?.status || 'disconnected',
    qr_base64: client?.currentQR || null,
    timestamp: Date.now()
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
  console.log('========================================');
  console.log('🎬 INIT WHATSAPP START');
  console.log('SessionId:', sessionId);
  console.log('Time:', new Date().toISOString());
  console.log('========================================');
  
  try {
    console.log('📝 Creating session object in memory...');
    whatsappClients[sessionId] = {
      status: 'initializing',
      currentQR: null,
      whatsappClient: null
    };
    console.log('✅ Session object created');
    console.log('Current status:', whatsappClients[sessionId].status);

    console.log('🤖 Creating WhatsApp Client...');
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
    console.log('✅ Client object created');
    
    client.on('qr', async (qr) => {
      console.log('========================================');
      console.log('📱 QR CODE EVENT!');
      console.log('SessionId:', sessionId);
      console.log('QR length:', qr.length);
      console.log('Time:', new Date().toISOString());
      console.log('========================================');
      
      whatsappClients[sessionId].status = 'qr_ready';
      whatsappClients[sessionId].currentQR = await qrcode.toDataURL(qr, {
        errorCorrectionLevel: 'H',
        margin: 1,
        width: 400
      });
      
      console.log('✅ QR Code converted to base64');
      console.log('Base64 length:', whatsappClients[sessionId].currentQR.length);
      
      broadcast(sessionId, { event: 'qr', qr: whatsappClients[sessionId].currentQR });
      console.log('✅ QR Code broadcasted via WebSocket');
      console.log('========================================');
    });
    
    client.on('authenticated', () => {
      console.log('========================================');
      console.log('🔐 AUTHENTICATED EVENT');
      console.log('SessionId:', sessionId);
      console.log('========================================');
      
      whatsappClients[sessionId].status = 'authenticated';
      broadcast(sessionId, { event: 'authenticated' });
    });
    
    client.on('ready', () => {
      console.log('========================================');
      console.log('✅ READY EVENT!');
      console.log('SessionId:', sessionId);
      console.log('Time:', new Date().toISOString());
      console.log('========================================');
      
      whatsappClients[sessionId].status = 'ready';
      whatsappClients[sessionId].currentQR = null;
      broadcast(sessionId, { event: 'session.ready' });
    });
    
    client.on('message', async (message) => {
      console.log('📨 New message from:', message.from);
      
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
          console.error('❌ Media download error:', e.message);
        }
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
      console.log('✓ Message ACK:', ack, 'for', message.id._serialized);
      
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
      console.log('========================================');
      console.log('🔴 DISCONNECTED EVENT');
      console.log('SessionId:', sessionId);
      console.log('Reason:', reason);
      console.log('Time:', new Date().toISOString());
      console.log('========================================');
      
      if (whatsappClients[sessionId]) {
        if (whatsappClients[sessionId].whatsappClient) {
          whatsappClients[sessionId].whatsappClient.destroy().catch(e => {
            console.error('⚠️ Error destroying on disconnect:', e.message);
          });
        }
        delete whatsappClients[sessionId];
        console.log('✅ Session cleaned up');
      }
      
      broadcast(sessionId, { event: 'disconnected', reason });
      console.log('========================================');
    });
    
    console.log('💾 Storing client in session object...');
    whatsappClients[sessionId].whatsappClient = client;
    console.log('✅ Client stored');
    
    console.log('🚀 Calling client.initialize()...');
    await client.initialize();
    console.log('✅ client.initialize() completed');
    console.log('========================================');
    
  } catch (error) {
    console.error('========================================');
    console.error('❌ INIT WHATSAPP ERROR');
    console.error('SessionId:', sessionId);
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    console.error('========================================');
    
    if (whatsappClients[sessionId]) {
      whatsappClients[sessionId].status = 'error';
    }
    broadcast(sessionId, { event: 'error', message: error.message });
  }
}
