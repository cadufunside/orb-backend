// ⚡ BACKEND v69 - SINGLETONLOCK FIX
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
console.log('🚀 BACKEND v69 - SINGLETONLOCK FIX');
console.log('========================================');

// Clean up ALL stale lock files on startup
function cleanupLockFiles(sessionId) {
  // Clean wwebjs auth folder
  const sessionPath = path.join('.wwebjs_auth', `session-${sessionId}`);
  const lockFile = path.join(sessionPath, 'SingletonLock');
  const socketFile = path.join(sessionPath, 'SingletonSocket');
  const cookieFile = path.join(sessionPath, 'SingletonCookie');
  
  [lockFile, socketFile, cookieFile].forEach(file => {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log(`Removed lock file: ${file}`);
      }
    } catch (e) {
      console.log(`Could not remove ${file}:`, e.message);
    }
  });

  // Clean /tmp chromium folders
  const tmpDir = '/tmp';
  try {
    const files = fs.readdirSync(tmpDir);
    files.forEach(file => {
      if (file.startsWith('chromium-') || file.startsWith('puppeteer_')) {
        const fullPath = path.join(tmpDir, file);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          console.log(`Cleaned tmp folder: ${fullPath}`);
        } catch (e) {
          console.log(`Could not clean ${fullPath}:`, e.message);
        }
      }
    });
  } catch (e) {
    console.log('Could not read /tmp:', e.message);
  }
}

// Check if client is actually usable
function isClientUsable(session) {
  if (!session || !session.client || !session.ready) return false;
  try {
    // Check if pupPage exists and is not closed
    if (!session.client.pupPage || session.client.pupPage.isClosed()) {
      console.log('Client page is closed, marking as not usable');
      session.ready = false;
      session.status = 'disconnected';
      return false;
    }
    return true;
  } catch (e) {
    console.log('Client check error:', e.message);
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
      retries: 0
    });
  }
  return sessions.get(sessionId);
}

// Health check - BOTH /health and /api/health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '69', sessions: sessions.size });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '69', sessions: sessions.size });
});

// Force restart session (cleanup and reinit)
app.post('/api/sessions/:sessionId/restart', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  console.log(`[${sessionId}] Force restart requested`);
  
  if (session?.client) {
    try {
      await session.client.destroy();
    } catch (e) {}
  }
  
  sessions.delete(sessionId);
  
  // Clean up lock files
  cleanupLockFiles(sessionId);
  
  // Clear caches
  for (const key of messageCache.keys()) {
    if (key.startsWith(sessionId)) messageCache.delete(key);
  }
  for (const key of profilePicCache.keys()) {
    if (key.startsWith(sessionId)) profilePicCache.delete(key);
  }
  
  res.json({ success: true, message: 'Session cleared, call /start to reconnect' });
});

// Start session with retry logic
app.post('/api/sessions/:sessionId/start', async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (session.client && session.ready) {
    return res.json({ success: true, status: 'ready' });
  }

  if (session.client && session.status === 'initializing') {
    return res.json({ success: true, status: session.status });
  }

  // Cleanup any existing broken client
  if (session.client) {
    try {
      await session.client.destroy();
    } catch (e) {}
    session.client = null;
  }
  
  // CRITICAL: Clean up lock files before starting
  cleanupLockFiles(sessionId);

  try {
    session.status = 'initializing';
    session.retries = (session.retries || 0) + 1;
    
    console.log(`[${sessionId}] Starting client (attempt ${session.retries})...`);
    
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
          '--single-process',
          '--disable-extensions',
          '--disable-software-rasterizer',
          '--disable-features=site-per-process',
          '--ignore-certificate-errors',
          '--ignore-ssl-errors'
        ],
        timeout: 120000,
        protocolTimeout: 120000
      },
      qrMaxRetries: 5,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10000
    });

    client.on('qr', async (qr) => {
      console.log(`[${sessionId}] QR Code generated`);
      session.qr = await qrcode.toDataURL(qr);
      session.status = 'qr_ready';
    });

    client.on('ready', () => {
      console.log(`[${sessionId}] Client ready!`);
      session.ready = true;
      session.status = 'ready';
      session.qr = null;
      session.info = client.info;
    });

    client.on('authenticated', () => {
      console.log(`[${sessionId}] Authenticated`);
      session.status = 'authenticated';
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
      session.client = null;
    });

    // Track message ACK updates in realtime
    client.on('message_ack', (msg, ack) => {
      const cacheKey = `${sessionId}_${msg.from || msg.to}`;
      const cached = messageCache.get(cacheKey);
      if (cached) {
        const msgIndex = cached.findIndex(m => m.id === msg.id._serialized);
        if (msgIndex !== -1) {
          cached[msgIndex].ack = ack;
        }
      }
    });

    session.client = client;
    
    // Initialize with timeout and error handling
    const initPromise = client.initialize();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Initialization timeout')), 90000)
    );

    Promise.race([initPromise, timeoutPromise])
      .then(() => {
        console.log(`[${sessionId}] Initialize completed`);
      })
      .catch(async (err) => {
        console.error(`[${sessionId}] Initialize failed:`, err.message);
        session.status = 'error';
        session.ready = false;
        try {
          await client.destroy();
        } catch (e) {}
        session.client = null;
        // Clean up locks on failure too
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

// Logout from WhatsApp (like WhatsApp Web disconnect)
app.post('/api/sessions/:sessionId/logout', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (session?.client) {
    try {
      await session.client.logout();
      console.log(`[${sessionId}] Logged out from WhatsApp`);
    } catch (e) {
      console.log(`[${sessionId}] Logout error:`, e.message);
    }
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
  
  if (!session?.ready) {
    return res.status(404).send('Session not ready');
  }

  try {
    // Check cache first
    const cacheKey = `${sessionId}_${jid}`;
    if (profilePicCache.has(cacheKey)) {
      const cached = profilePicCache.get(cacheKey);
      if (cached.expires > Date.now()) {
        return res.redirect(cached.url);
      }
    }

    const url = await session.client.getProfilePicUrl(jid);
    if (url) {
      // Cache for 1 hour
      profilePicCache.set(cacheKey, { url, expires: Date.now() + 3600000 });
      return res.redirect(url);
    }
    
    res.status(404).send('No profile pic');
  } catch (error) {
    res.status(404).send('Profile pic not found');
  }
});

// Get threads/chats
app.get('/api/sessions/:sessionId/threads', async (req, res) => {
  const { sessionId } = req.params;
  const { limit = 50 } = req.query;
  const session = sessions.get(sessionId);

  if (!session?.ready) {
    return res.status(400).json({ error: 'Session not ready', status: session?.status || 'unknown' });
  }

  // Check if client is still usable
  if (!isClientUsable(session)) {
    return res.status(400).json({ error: 'Session disconnected, please reconnect', status: 'disconnected' });
  }

  try {
    const chats = await session.client.getChats();
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
    // Mark session as disconnected on critical errors
    if (error.message?.includes('Session closed') || error.message?.includes('page has been closed')) {
      session.ready = false;
      session.status = 'disconnected';
      return res.status(400).json({ error: 'Session disconnected, please reconnect', status: 'disconnected' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Get messages with media URLs
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
    const chat = await session.client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit: parseInt(limit) });
    
    const messages = await Promise.all(msgs.map(async (msg) => {
      let mediaUrl = null;
      let mediaType = msg.type;
      
      // Download media and convert to base64 for images/audio
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            mediaUrl = `data:${media.mimetype};base64,${media.data}`;
            if (media.mimetype.startsWith('image/')) mediaType = 'image';
            else if (media.mimetype.startsWith('video/')) mediaType = 'video';
            else if (media.mimetype.startsWith('audio/')) mediaType = 'audio';
          }
        } catch (e) {
          console.log('Media download failed:', e.message);
        }
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

    // Cache messages
    const cacheKey = `${sessionId}_${chatId}`;
    messageCache.set(cacheKey, messages);

    res.json({ messages });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send text message
app.post('/api/sessions/:sessionId/messages/text', async (req, res) => {
  const { sessionId } = req.params;
  const { to, text } = req.body;
  const session = sessions.get(sessionId);

  if (!session?.ready) {
    return res.status(400).json({ error: 'Session not ready' });
  }

  try {
    const result = await session.client.sendMessage(to, text);
    res.json({ 
      success: true, 
      message_id: result.id._serialized,
      timestamp: result.timestamp
    });
  } catch (error) {
    console.error('Send text error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send media message
app.post('/api/sessions/:sessionId/messages/media', async (req, res) => {
  const { sessionId } = req.params;
  const { to, media_url, media_type, caption, filename } = req.body;
  const session = sessions.get(sessionId);

  if (!session?.ready) {
    return res.status(400).json({ error: 'Session not ready' });
  }

  try {
    let media;
    
    if (media_url.startsWith('data:')) {
      // Base64 data
      const matches = media_url.match(/^data:(.+);base64,(.+)$/);
      if (matches) {
        media = new MessageMedia(matches[1], matches[2], filename);
      }
    } else {
      // URL - download first
      media = await MessageMedia.fromUrl(media_url, { unsafeMime: true });
      if (filename) media.filename = filename;
    }

    const options = {};
    if (caption) options.caption = caption;
    if (media_type === 'audio') {
      options.sendAudioAsVoice = true;
    }

    const result = await session.client.sendMessage(to, media, options);
    res.json({ 
      success: true, 
      message_id: result.id._serialized,
      timestamp: result.timestamp
    });
  } catch (error) {
    console.error('Send media error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Download media by message ID
app.get('/api/sessions/:sessionId/media/:messageId', async (req, res) => {
  const { sessionId, messageId } = req.params;
  const session = sessions.get(sessionId);

  if (!session?.ready) {
    return res.status(400).json({ error: 'Session not ready' });
  }

  try {
    // Find message in cache or fetch
    let msg = null;
    for (const [key, messages] of messageCache.entries()) {
      if (key.startsWith(sessionId)) {
        const found = messages.find(m => m.id === messageId);
        if (found && found.media_url) {
          // Return cached media
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
    console.error('Get media error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Ready to accept WhatsApp connections!');
});
