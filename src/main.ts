import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const port = Number(process.env.PORT) || 8080; // usa a PORT da plataforma
  await app.listen(port, '0.0.0.0');
}
bootstrap();
