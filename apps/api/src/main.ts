import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { JwtModule } from '@nestjs/jwt';
import { SessionController, SessionGuard } from './identity';
import { TenantAdminController, TenantAdminService } from './tenant-admin';
import { AuthorizationService } from './authorization';
import { AppSchemaController, AppSchemaService } from './app-schema';
import { FileController, FileService, maxAttachmentBytes } from './files';
import { SearchService } from './search';
import { RecordQueryService } from './record-query';
import { RecordService, RecordsController } from './records';
import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { checkDatabase } from '@suzubase/db';

@Controller()
class HealthController {

  @Get('health')
  async health() {
    try {
      await checkDatabase();
      return { status: 'ok', database: 'connected' };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}

@Module({
  imports: [JwtModule.register({
    secret: process.env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    signOptions: { algorithm: 'HS256', expiresIn: '1h', issuer: 'suzubase', audience: 'suzubase-session' },
    verifyOptions: { algorithms: ['HS256'], issuer: 'suzubase', audience: 'suzubase-session' },
  })],
  controllers: [HealthController, SessionController, AppSchemaController, RecordsController, TenantAdminController, FileController],
  providers: [AuthorizationService, SessionGuard, AppSchemaService, RecordService, RecordQueryService, TenantAdminService, FileService, SearchService],
})
class AppModule {}

async function main() {
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  adapter.getInstance().addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: maxAttachmentBytes },
    (_request, body, done) => done(null, body));
  const config = new DocumentBuilder().setTitle('SuzuBase').setVersion('0').addBearerAuth().build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config));
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void main();
