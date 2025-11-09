import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { WebSocketModule } from './modules/websocket/websocket.module'; // Corrigido o nome

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const url = cfg.get<string>('DATABASE_URL');
        const ssl = cfg.get<string>('DB_SSL') === 'true';
        return {
          type: 'postgres',
          url,
          autoLoadEntities: true,
          synchronize: process.env.NODE_ENV !== 'production',
          ssl: ssl
            ? { rejectUnauthorized: false }
            : false,
        };
      },
    }),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        redis: {
          host: cfg.get<string>('REDIS_HOST') || 'localhost',
          port: Number(cfg.get<string>('REDIS_PORT') || 6379),
          password: cfg.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
    }),

    EventEmitterModule.forRoot(),
    WhatsAppModule,
    WebSocketModule,
  ],
})
export class AppModule {}
