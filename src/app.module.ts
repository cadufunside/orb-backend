import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { WebSocketModule } from './modules/websocket/websocket.module';

@Module({
  imports: [
    // carrega variáveis do ambiente
    ConfigModule.forRoot({ isGlobal: true }),

    // *** USE APENAS DATABASE_URL ***
    TypeOrmModule.forRootAsync({
      useFactory: () => {
        const url = process.env.DATABASE_URL;
        if (!url) {
          // deixar explícito no log se a variável não chegou
          throw new Error('DATABASE_URL não definida no ambiente');
        }
        const useSSL =
          (process.env.DB_SSL || '').toLowerCase() === 'true' ||
          process.env.NODE_ENV === 'production';

        return {
          type: 'postgres',
          url,                         // <- Railway: ${ Postgres.DATABASE_URL }
          autoLoadEntities: true,
          synchronize: process.env.NODE_ENV !== 'production', // ajuste como quiser
          ssl: useSSL ? { rejectUnauthorized: false } : false,
        } as any;
      },
    }),

    // Redis/Bull (se não usar agora, pode remover)
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    }),

    EventEmitterModule.forRoot(),
    WhatsAppModule,
    WebSocketModule,
  ],
})
export class AppModule {}
