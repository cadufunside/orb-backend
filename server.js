// BACKEND COM PERSISTÊNCIA NO BANCO DE DADOS (PostgreSQL) E DISFARCES
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
                const dbResult = await pool.query(
                  'SELECT
