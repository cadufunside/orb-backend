// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { EventEmitterModule } from '@nestjs/event-emitter';

// seus módulos
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { WebSocketModule } from './modules/websocket/websocket.module';

@Module({
  imports: [
    // Variáveis de ambiente globais (.env e/ou Variables do provedor)
    ConfigModule.forRoot({ isGlobal: true }),

    // ✅ TypeORM com suporte a DATABASE_URL (recomendado) e fallback por campos
    TypeOrmModule.forRootAsync({
      useFactory: () => {
        const isProd = process.env.NODE_ENV === 'production';
        const useSSL = process.env.DB_SSL === 'true';
        const url = process.env.DATABASE_URL; // ex.: postgres://user:pass@host:5432/dbname

        if (url) {
          return {
            type: 'postgres' as const,
            url,
            autoLoadEntities: true,
            synchronize: !isProd, // nunca sincronize em prod
            ssl: useSSL ? { rejectUnauthorized: false } : undefined,
          };
        }

        // Fallback por variáveis separadas
        return {
          type: 'postgres' as const,
          host: process.env.DATABASE_HOST || '127.0.0.1', // evita ::1
          port: parseInt(process.env.DATABASE_PORT || '5432', 10),
          username: process.env.DATABASE_USER || 'postgres',
          password: process.env.DATABASE_PASSWORD || 'postgres',
          database: process.env.DATABASE_NAME || 'orb_crm',
          autoLoadEntities: true,
          synchronize: !isProd,
          ssl: useSSL ? { rejectUnauthorized: false } : undefined,
        };
      },
    }),

    // ✅ Bull/Redis via env (opcional; remova se não usar filas)
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
      },
    }),

    EventEmitterModule.forRoot(),

    // seus módulos de features
    WhatsAppModule,
    WebSocketModule,
  ],
})
export class AppModule {}
