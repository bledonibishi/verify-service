import {
  BadRequestException,
  Controller,
  HttpCode,
  Param,
  ParseEnumPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentKind } from '@prisma/client';
import { UploadsService } from './uploads.service';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Public endpoints, authorised only by the one-time token in the URL. */
@Controller('v1/upload/:token')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('submit')
  @HttpCode(200)
  submit(@Param('token') token: string) {
    return this.uploads.submit(token);
  }

  @Post('liveness')
  @HttpCode(200)
  startLiveness(@Param('token') token: string) {
    return this.uploads.startLiveness(token);
  }

  @Post(':kind')
  @HttpCode(204)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async upload(
    @Param('token') token: string,
    @Param('kind', new ParseEnumPipe(DocumentKind)) kind: DocumentKind,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    if (!file) throw new BadRequestException('Missing "file" field');
    await this.uploads.addDocument(token, kind, file.buffer);
  }
}
