import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Cloud Run injeta PORT=8080. Railway injeta uma PORT própria.
  const port = Number(process.env.PORT) || 8080;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Server up on 0.0.0.0:${port}`);
}
bootstrap();
