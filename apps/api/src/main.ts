import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { JwtModule } from '@nestjs/jwt';
import { SessionController, SessionProfileController, SessionGuard } from './identity';
import { TenantAdminController, TenantAdminService } from './tenant-admin';
import { AuthorizationService } from './authorization';
import { AppSchemaController, AppSchemaService } from './app-schema';
import { FileController, FileService, maxAttachmentBytes } from './files';
import { ApiTokenController, ApiTokenService } from './api-tokens';
import { CommentController, CommentService } from './comments';
import { CsvController, CsvService } from './csv';
import { RuntimeIndexController, RuntimeIndexService } from './runtime-indexes';
import { SearchService } from './search';
import { RecordQueryService } from './record-query';
import { WorkflowRuntimeController, WorkflowRuntimeService } from './workflow-runtime';
import { WorkflowDefinitionController, WorkflowDefinitionService } from './workflow-definitions';
import { RecordService, RecordsController } from './records';
import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { completeOpenApi } from './openapi';
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
  controllers: [HealthController, SessionController, SessionProfileController, AppSchemaController, RecordsController, WorkflowDefinitionController, WorkflowRuntimeController, TenantAdminController, FileController, CommentController, CsvController, ApiTokenController, RuntimeIndexController],
  providers: [AuthorizationService, SessionGuard, AppSchemaService, RecordService, RecordQueryService, WorkflowDefinitionService, WorkflowRuntimeService, TenantAdminService, FileService, SearchService, CommentService, CsvService, ApiTokenService, RuntimeIndexService],
})
class AppModule {}

async function main() {
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  adapter.getInstance().addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: maxAttachmentBytes },
    (_request, body, done) => done(null, body));
  const config = new DocumentBuilder().setTitle('SuzuBase').setVersion('1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Send a session JWT or an app token on supported app routes. Token administration requires a session.' }).build();
  SwaggerModule.setup('docs', app, () => completeOpenApi(SwaggerModule.createDocument(app, config)));
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void main();
