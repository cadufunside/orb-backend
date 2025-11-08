import { Controller, Get, Post, Body } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsAppController {
  constructor(private whatsappService: WhatsAppService) {}

  @Get('status')
  async getStatus() {
    return this.whatsappService.getStatus();
  }

  @Post('generate-qr')
  async generateQR() {
    const qrCode = await this.whatsappService.getQRCode();
    return { qrCode, expiresIn: 30000 };
  }

  @Post('send-message')
  async sendMessage(@Body() body: any) {
    return this.whatsappService.sendMessage(
      body.to,
      body.message,
      body.mediaUrl,
    );
  }

  @Post('disconnect')
  async disconnect() {
    await this.whatsappService.disconnect();
    return { success: true };
  }
}
