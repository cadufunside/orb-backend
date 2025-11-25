// ⚡ BACKEND v70 - STABLE CHROMIUM
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const app = express();
app.use(cors({ origin: '*' }));
app.use(compression());
app.use(express.json({ limit: '50mb' }));

// In-memory storage
const sessions = new Map();
const messageCache = new Map();
const profilePicCache = new Map();

console.log('========================================');
console.log('🚀 BACKEND v70 - STABLE CHROMIUM');
console.log('========================================');

// Clean up lock files
function cleanupLockFiles(sessionId) {
  const sessionPath = path.join('.wwebjs_auth', `session-${sessionId}`);
  ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].forEach(file => {
    try {
      const filePath = path.join(sessionPath, file);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}
  });
}

// Check if client is usable - mais robusto
function isClientUsable(session) {
  if (!session || !session.client || !session.ready) return false;
  try {
    const page = session.client.pupPage;
    if (!page) return false;
    // Verifica se a página está fechada de forma segura
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      session.ready = false;
      session.status = 'disconnected';
      return false;
    }
    return true;
  } catch (e) {
    session.ready = false;
    session.status = 'disconnected';
    return false;
  }
}

// Get or create session
function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      client: null,
      qr: null,
      ready: false,
      status: 'disconnected',
      info: null,
      retries: 0,
      lastActivity: Date.now()
    });
  }
  return sessions.get(sessionId);
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', version: '70', sessions: sessions.size }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '70', sessions: sessions.size }));

// Restart session
app.post('/api/sessions/:sessionId/restart', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  console.log(`[${sessionId}] Force restart requested`);
  
  if (session?.client) {
    try { await session.client.destroy(); } catch (e) {}
  }
  
  sessions.delete(sessionId);
  cleanupLockFiles(sessionId);
  
  // Clear caches
  for (const key of messageCache.keys()) {
    if (key.startsWith(sessionId)) messageCache.delete(key);
  }
  for (const key of profilePicCache.keys()) {
    if (key.startsWith(sessionId)) profilePicCache.delete(key);
  }
  
  res.json({ success: true });
});

// Start session - PUPPETEER OTIMIZADO PARA RAILWAY
app.post('/api/sessions/:sessionId/start', async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (session.client && session.ready && isClientUsable(session)) {
    return res.json({ success: true, status: 'ready' });
  }

  if (session.client && session.status === 'initializing') {
    return res.json({ success: true, status: session.status });
  }

  // Cleanup any existing broken client
  if (session.client) {
    try { await session.client.destroy(); } catch (e) {}
    session.client = null;
  }
  
  cleanupLockFiles(sessionId);

  try {
    session.status = 'initializing';
    session.retries = (session.retries || 0) + 1;
    
    console.log(`[${sessionId}] Starting client (attempt ${session.retries})...`);
    
    // PUPPETEER ARGS OTIMIZADOS PARA RAILWAY/DOCKER
    const client = new Client({
      authStrategy: new LocalAuth({ 
        clientId: sessionId,
        dataPath: './.wwebjs_auth'
      }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-software-rasterizer',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--safebrowsing-disable-auto-update',
          '--disable-hang-monitor',
          '--disable-prompt-on-repost',
          '--disable-domain-reliability',
          '--disable-component-update',
          '--disable-breakpad',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
          '--enable-features=NetworkService,NetworkServiceInProcess',
          '--force-color-profile=srgb'
        ],
        timeout: 180000,
        protocolTimeout: 180000,
        dumpio: false
      },
      qrMaxRetries: 10,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10000,
      restartOnAuthFail: true
    });

    client.on('qr', async (qr) => {
      console.log(`[${sessionId}] QR Code generated`);
      session.qr = await qrcode.toDataURL(qr);
      session.status = 'qr_ready';
      session.lastActivity = Date.now();
    });

    client.on('ready', () => {
      console.log(`[${sessionId}] Client ready!`);
      session.ready = true;
      session.status = 'ready';
      session.qr = null;
      session.info = client.info;
      session.lastActivity = Date.now();
    });

    client.on('authenticated', () => {
      console.log(`[${sessionId}] Authenticated`);
      session.status = 'authenticated';
      session.lastActivity = Date.now();
    });

    client.on('auth_failure', () => {
      console.log(`[${sessionId}] Auth failed`);
      session.status = 'auth_failure';
      session.ready = false;
    });

    client.on('disconnected', (reason) => {
      console.log(`[${sessionId}] Disconnected:`, reason);
      session.status = 'disconnected';
      session.ready = false;
    });

    client.on('message_ack', (msg, ack) => {
      const cacheKey = `${sessionId}_${msg.from || msg.to}`;
      const cached = messageCache.get(cacheKey);
      if (cached) {
        const msgIndex = cached.findIndex(m => m.id === msg.id._serialized);
        if (msgIndex !== -1) cached[msgIndex].ack = ack;
      }
    });

    session.client = client;
    
    // Initialize
    client.initialize()
      .then(() => console.log(`[${sessionId}] Initialize completed`))
      .catch(async (err) => {
        console.error(`[${sessionId}] Initialize failed:`, err.message);
        session.status = 'error';
        session.ready = false;
        try { await client.destroy(); } catch (e) {}
        session.client = null;
        cleanupLockFiles(sessionId);
      });

    res.json({ success: true, status: 'initializing' });
  } catch (error) {
    console.error(`[${sessionId}] Start error:`, error);
    session.status = 'error';
    cleanupLockFiles(sessionId);
    res.status(500).json({ error: error.message });
  }
});

// Get session status
app.get('/api/sessions/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  // Verify client is still usable before reporting ready
  if (session.ready && !isClientUsable(session)) {
    session.ready = false;
    session.status = 'disconnected';
  }
  
  res.json({
    status: session.status,
    ready: session.ready,
    qr_base64: session.qr,
    info: session.info
  });
});

// Logout
app.post('/api/sessions/:sessionId/logout', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (session?.client) {
    try { await session.client.logout(); } catch (e) {}
  }
  
  res.json({ success: true });
});

// Delete session
app.delete('/api/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (session?.client) {
    try {
      await session.client.logout();
      await session.client.destroy();
    } catch (e) {}
  }
  
  sessions.delete(sessionId);
  cleanupLockFiles(sessionId);
  
  // Clear caches
  for (const key of messageCache.keys()) {
    if (key.startsWith(sessionId)) messageCache.delete(key);
  }
  for (const key of profilePicCache.keys()) {
    if (key.startsWith(sessionId)) profilePicCache.delete(key);
  }
  
  res.json({ success: true });
});

// Get profile picture
app.get('/api/sessions/:sessionId/profile-pic/:jid', async (req, res) => {
  const { sessionId, jid } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session?.ready || !isClientUsable(session)) {
    return res.status(404).send('Session not ready');
  }

  try {
    const cacheKey = `${sessionId}_${jid}`;
    if (profilePicCache.has(cacheKey)) {
      const cached = profilePicCache.get(cacheKey);
      if (cached.expires > Date.now()) {
        return res.redirect(cached.url);
      }
    }

    const url = await session.client.getProfilePicUrl(jid);
    if (url) {
      profilePicCache.set(cacheKey, { url, expires: Date.now() + 3600000 });
      return res.redirect(url);
    }
    
    res.status(404).send('No profile pic');
  } catch (error) {
    res.status(404).send('Profile pic not found');
  }
});

// Get threads/chats - COM RETRY
app.get('/api/sessions/:sessionId/threads', async (req, res) => {
  const { sessionId } = req.params;
  const { limit = 50 } = req.query;
  const session = sessions.get(sessionId);

  if (!session?.ready) {
    return res.status(400).json({ error: 'Session not ready', status: session?.status || 'unknown' });
  }

  if (!isClientUsable(session)) {
    return res.status(400).json({ error: 'Session disconnected', status: 'disconnected' });
  }

  try {
    session.lastActivity = Date.now();
    
    // Tenta até 3 vezes
    let chats = null;
    let lastError = null;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        chats = await session.client.getChats();
        break;
      } catch (e) {
        lastError = e;
        console.log(`[${sessionId}] getChats attempt ${attempt} failed:`, e.message);
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    if (!chats) {
      // Check if it's a critical error
      if (lastError?.message?.includes('Session closed') || lastError?.message?.includes('Target closed')) {
        session.ready = false;
        session.status = 'disconnected';
        return res.status(400).json({ error: 'Session disconnected', status: 'disconnected' });
      }
      throw lastError;
    }
    
    const threads = await Promise.all(
      chats.slice(0, parseInt(limit)).map(async (chat) => {
        let profilePic = null;
        try {
          profilePic = await session.client.getProfilePicUrl(chat.id._serialized);
        } catch {}

        return {
          jid: chat.id._serialized,
          name: chat.name || chat.id.user,
          is_group: chat.isGroup,
          unread_count: chat.unreadCount,
          last_message: chat.lastMessage ? {
            text: chat.lastMessage.body,
            timestamp: chat.lastMessage.timestamp * 1000,
            from_me: chat.lastMessage.fromMe
          } : null,
          profile_pic: profilePic
        };
      })
    );

    res.json({ threads });
  } catch (error) {
    console.error('Get threads error:', error);
    if (error.message?.includes('Session closed') || error.message?.includes('Target closed') || error.message?.includes('page has been closed')) {
      session.ready = false;
      session.status = 'disconnected';
      return res.status(400).json({ error: 'Session disconnected', status: 'disconnected' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Get messages - COM RETRY
app.get('/api/sessions/:sessionId/messages/:chatId/history', async (req, res) => {
  const { sessionId, chatId } = req.params;
  const { limit = 50 } = req.query;
  const session = sessions.get(sessionId);

  if (!session?.ready) {
    return res.status(400).json({ error: 'Session not ready', status: session?.status || 'unknown' });
  }

  if (!isClientUsable(session)) {
    return res.status(400).json({ error: 'Session disconnected', status: 'disconnected' });
  }

  try {
    session.lastActivity = Date.now();
    
    const chat = await session.client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit: parseInt(limit) });
    
    const messages = await Promise.all(msgs.map(async (msg) => {
      let mediaUrl = null;
      let mediaType = msg.type;
      
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            mediaUrl = `data:${media.mimetype};base64,${media.data}`;
            if (media.mimetype.startsWith('image/')) mediaType = 'image';
            else if (media.mimetype.startsWith('video/')) mediaType = 'video';
            else if (media.mimetype.startsWith('audio/')) mediaType = 'audio';
          }
        } catch (e) {}
      }

      return {
        id: msg.id._serialized,
        text: msg.body,
        caption: msg.caption || '',
        from_me: msg.fromMe,
        timestamp: msg.timestamp * 1000,
        ack: msg.ack,
        has_media: msg.hasMedia,
        media_url: mediaUrl,
        media_type: mediaType,
        mimetype: msg.mimetype || ''
      };
    }));

    const cacheKey = `${sessionId}_${chatId}`;
    messageCache.set(cacheKey, messages);

    res.json({ messages });
  } catch (error) {
    console.error('Get messages error:', error);
    if (error.message?.includes('Session closed') || error.message?.includes('Target closed')) {
      session.ready = false;
      session.status = 'disconnected';
      return res.status(400).json({ error: 'Session disconnected', status: 'disconnected' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Send text
app.post('/api/sessions/:sessionId/messages/text', async (req, res) => {
  const { sessionId } = req.params;
  const { to, text } = req.body;
  const session = sessions.get(sessionId);

  if (!session?.ready || !isClientUsable(session)) {
    return res.status(400).json({ error: 'Session not ready' });
  }

  try {
    session.lastActivity = Date.now();
    const result = await session.client.sendMessage(to, text);
    res.json({ success: true, message_id: result.id._serialized, timestamp: result.timestamp });
  } catch (error) {
    console.error('Send text error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send media
app.post('/api/sessions/:sessionId/messages/media', async (req, res) => {
  const { sessionId } = req.params;
  const { to, media_url, media_type, caption, filename } = req.body;
  const session = sessions.get(sessionId);

  if (!session?.ready || !isClientUsable(session)) {
    return res.status(400).json({ error: 'Session not ready' });
  }

  try {
    session.lastActivity = Date.now();
    let media;
    
    if (media_url.startsWith('data:')) {
      const matches = media_url.match(/^data:(.+);base64,(.+)$/);
      if (matches) media = new MessageMedia(matches[1], matches[2], filename);
    } else {
      media = await MessageMedia.fromUrl(media_url, { unsafeMime: true });
      if (filename) media.filename = filename;
    }

    const options = {};
    if (caption) options.caption = caption;
    if (media_type === 'audio') options.sendAudioAsVoice = true;

    const result = await session.client.sendMessage(to, media, options);
    res.json({ success: true, message_id: result.id._serialized, timestamp: result.timestamp });
  } catch (error) {
    console.error('Send media error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Download media
app.get('/api/sessions/:sessionId/media/:messageId', async (req, res) => {
  const { sessionId, messageId } = req.params;
  const session = sessions.get(sessionId);

  if (!session?.ready) {
    return res.status(400).json({ error: 'Session not ready' });
  }

  try {
    for (const [key, messages] of messageCache.entries()) {
      if (key.startsWith(sessionId)) {
        const found = messages.find(m => m.id === messageId);
        if (found?.media_url) {
          const base64Match = found.media_url.match(/^data:(.+);base64,(.+)$/);
          if (base64Match) {
            const buffer = Buffer.from(base64Match[2], 'base64');
            res.set('Content-Type', base64Match[1]);
            return res.send(buffer);
          }
        }
      }
    }
    
    res.status(404).json({ error: 'Media not found' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Ready to accept WhatsApp connections!');
});
