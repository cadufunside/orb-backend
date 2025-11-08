import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import * as QRCode from 'qrcode';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class WhatsAppService implements OnModuleInit {
  private client: Client;
  private qrCode: string;
  private isReady = false;
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(private eventEmitter: EventEmitter2) {}

  async onModuleInit() {
    this.initializeClient();
  }

  private initializeClient() {
    this.logger.log('🚀 Inicializando WhatsApp Web...');

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: process.env.WHATSAPP_SESSION_PATH || './whatsapp-sessions',
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      },
    });

    this.client.on('qr', async (qr) => {
      this.logger.log('📱 QR Code gerado!');
      this.qrCode = await QRCode.toDataURL(qr);
      this.eventEmitter.emit('whatsapp.qr', { qrCode: this.qrCode });
    });

    this.client.on('authenticated', () => {
      this.logger.log('✅ WhatsApp autenticado!');
      this.eventEmitter.emit('whatsapp.authenticated');
    });

    this.client.on('ready', () => {
      this.logger.log('🎉 WhatsApp conectado!');
      this.isReady = true;
      this.qrCode = null;
      this.eventEmitter.emit('whatsapp.ready');
    });

    this.client.on('message', async (message) => {
      this.logger.log(`📩 Mensagem de: ${message.from}`);
      this.eventEmitter.emit('whatsapp.message', {
        from: message.from,
        body: message.body,
        timestamp: message.timestamp,
      });
    });

    this.client.on('disconnected', (reason) => {
      this.logger.warn(`⚠️ Desconectado: ${reason}`);
      this.isReady = false;
      this.eventEmitter.emit('whatsapp.disconnected', { reason });
    });

    this.client.initialize();
  }

  async getQRCode(): Promise<string> {
    if (this.isReady) throw new Error('Já conectado');
    if (!this.qrCode) throw new Error('QR Code não gerado');
    return this.qrCode;
  }

  async sendMessage(to: string, message: string, mediaUrl?: string) {
    if (!this.isReady) throw new Error('WhatsApp não conectado');
    const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
    
    if (mediaUrl) {
      const media = await MessageMedia.fromUrl(mediaUrl);
      await this.client.sendMessage(chatId, media, { caption: message });
    } else {
      await this.client.sendMessage(chatId, message);
    }
    
    return { success: true };
  }

  async getStatus() {
    return { isConnected: this.isReady, hasQR: !!this.qrCode };
  }

  async disconnect() {
    await this.client.destroy();
    this.isReady = false;
  }
}
