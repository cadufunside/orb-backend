import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // se quiser menos barulho de log: logger: ['error', 'warn', 'log'],
  });

  // CORS liberado pro front/Socket.IO
  app.enableCors({ origin: true, credentials: true });

  // WebSocket/Socket.IO no mesmo servidor HTTP
  app.useWebSocketAdapter(new IoAdapter(app));

  // Pipes globais (opcional, mas recomendado)
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Porta/host: Railway precisa de 0.0.0.0
  const port = parseInt(process.env.PORT || '3001', 10);
  await app.listen(port, '0.0.0.0');

  Logger.log(`🚀 API up on http://0.0.0.0:${port}`, 'Bootstrap');
}
bootstrap();
