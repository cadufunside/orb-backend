// backend/server.js
import express from 'express';
import cors from 'cors';
import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  credentials: true
}));

app.use(express.json());

let whatsappClient = null;
let currentQR = null;
let clientStatus = 'disconnected';
let sessionData = null;

// Health Check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    whatsapp: clientStatus,
    timestamp: new Date().toISOString() 
  });
});

// Gerar QR Code via HTTP
app.post('/api/whatsapp/qr', async (req, res) => {
  try {
    console.log('📱 Solicitação de QR Code via HTTP');
    
    if (!whatsappClient) {
      await initializeWhatsApp();
    }
    
    if (currentQR) {
      res.json({ 
        success: true, 
        qr: currentQR,
        status: clientStatus
      });
    } else {
      res.json({ 
        success: false, 
        message: 'QR Code sendo gerado...',
        status: clientStatus
      });
    }
  } catch (error) {
    console.error('❌ Erro ao gerar QR:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificar status via HTTP
app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    status: clientStatus,
    session: sessionData,
    hasClient: !!whatsappClient
  });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Backend rodando na porta ${PORT}`);
  console.log(`📱 WhatsApp endpoint: /api/whatsapp/qr`);
  console.log(`🔌 WebSocket endpoint: /whatsapp`);
});

let wss;
let wsClients = new Set();

try {
  wss = new WebSocketServer({ server, path: '/whatsapp' });
  console.log('✅ WebSocket Server criado');
  
  wss.on('connection', (ws) => {
    console.log('✅ Cliente WebSocket conectado');
    wsClients.add(ws);
    
    ws.send(JSON.stringify({
      type: 'status',
      status: clientStatus
    }));
    
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        console.log('📨 Mensagem WS recebida:', data.type);
        
        switch (data.type) {
          case 'request_qr':
            if (!whatsappClient) {
              await initializeWhatsApp();
            }
            if (currentQR) {
              ws.send(JSON.stringify({ type: 'qr', qr: currentQR }));
            }
            break;
            
          case 'send_message':
            if (whatsappClient) {
              await whatsappClient.sendMessage(data.chatId, data.message);
            }
            break;
            
          case 'disconnect':
            if (whatsappClient) {
              await whatsappClient.destroy();
              whatsappClient = null;
              currentQR = null;
              clientStatus = 'disconnected';
            }
            break;
        }
      } catch (error) {
        console.error('❌ Erro ao processar mensagem WS:', error);
        ws.send(JSON.stringify({
          type: 'error',
          message: error.message
        }));
      }
    });
    
    ws.on('close', () => {
      console.log('❌ Cliente WebSocket desconectado');
      wsClients.delete(ws);
    });
  });
} catch (error) {
  console.warn('⚠️ WebSocket não disponível:', error.message);
  console.log('📡 Usando apenas HTTP endpoints');
}

function broadcastToClients(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

async function initializeWhatsApp() {
  try {
    console.log('🔄 Inicializando WhatsApp Web.js...');
    
    if (whatsappClient) {
      console.log('⚠️ Cliente já existe, destruindo...');
      await whatsappClient.destroy();
    }
    
    clientStatus = 'initializing';
    currentQR = null;
    
    whatsappClient = new Client({
      authStrategy: new LocalAuth({
        clientId: 'orb-crm-' + Date.now()
      }),
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
      console.log('📱 QR Code gerado!');
      clientStatus = 'qr_ready';
      
      try {
        currentQR = await qrcode.toDataURL(qr);
        console.log('✅ QR convertido para base64');
        broadcastToClients({ type: 'qr', qr: currentQR });
      } catch (error) {
        console.error('❌ Erro ao converter QR:', error);
      }
    });
    
    whatsappClient.on('authenticated', () => {
      console.log('✅ WhatsApp autenticado!');
      clientStatus = 'authenticated';
      sessionData = { authenticated: true, timestamp: Date.now() };
      broadcastToClients({ type: 'authenticated', session: sessionData });
    });
    
    whatsappClient.on('ready', () => {
      console.log('✅ WhatsApp pronto!');
      clientStatus = 'ready';
      broadcastToClients({ type: 'ready' });
    });
    
    whatsappClient.on('loading_screen', (percent, message) => {
      console.log(`⏳ Carregando: ${percent}%`);
      broadcastToClients({ type: 'loading_screen', percent, message });
    });
    
    whatsappClient.on('disconnected', (reason) => {
      console.log(`❌ WhatsApp desconectado: ${reason}`);
      clientStatus = 'disconnected';
      currentQR = null;
      whatsappClient = null;
      broadcastToClients({ type: 'disconnected', reason });
    });
    
    whatsappClient.on('message', async (message) => {
      console.log('📨 Nova mensagem:', message.from);
    });
    
    await whatsappClient.initialize();
    console.log('🔄 Cliente inicializado');
    
  } catch (error) {
    console.error('❌ Erro ao inicializar WhatsApp:', error);
    clientStatus = 'error';
    currentQR = null;
    broadcastToClients({ type: 'error', message: error.message });
  }
}

app.post('/api/oauth/facebook/token-exchange', async (req, res) => {
  try {
    const { code } = req.body;
    const response = await fetch(
      'https://graph.facebook.com/v18.0/oauth/access_token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.FB_APP_ID,
          client_secret: process.env.FB_APP_SECRET,
          redirect_uri: process.env.REDIRECT_URI,
          code: code
        })
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/oauth/google/token-exchange', async (req, res) => {
  try {
    const { code } = req.body;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
