// src/modules/websocket/websocket.gateway.ts
import {
  WebSocketGateway as WsGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

@WsGateway({ cors: { origin: '*' } })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(RealtimeGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`🔌 Cliente conectado: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`🔌 Cliente desconectado: ${client.id}`);
  }

  @OnEvent('whatsapp.qr')
  handleQRCode(payload: any) {
    this.server.emit('whatsapp:qr', payload);
  }

  @OnEvent('whatsapp.ready')
  handleReady() {
    this.server.emit('whatsapp:status', { status: 'connected' });
  }

  @OnEvent('whatsapp.message')
  handleMessage(payload: any) {
    this.server.emit('whatsapp:message', payload);
  }
}
