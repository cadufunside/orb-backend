import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { WebSocketModule } from './modules/websocket/websocket.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // Usa SOMENTE DATABASE_URL do Railway
    TypeOrmModule.forRootAsync({
      useFactory: () => {
        const url = process.env.DATABASE_URL;
        if (!url) {
          throw new Error('DATABASE_URL não definida no ambiente');
        }
        const useSSL =
          (process.env.DB_SSL || '').toLowerCase() === 'true' ||
          process.env.NODE_ENV === 'production';

        return {
          type: 'postgres',
          url,
          autoLoadEntities: true,
          // em produção, normalmente desligado
          synchronize: process.env.NODE_ENV !== 'production',
          ssl: useSSL ? { rejectUnauthorized: false } : false,
        } as any;
      },
    }),

    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    }),

    EventEmitterModule.forRoot(),
    WhatsAppModule,
    WebSocketModule,
    HealthModule,
  ],
})
export class AppModule {}
