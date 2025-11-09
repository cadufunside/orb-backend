import { Module } from '@nestjs/common';
import { RealtimeGateway } from './websocket.gateway';

@Module({
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class WebSocketModule {}
