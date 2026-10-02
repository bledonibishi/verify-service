import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OCR_PROVIDER, OcrProvider } from './ocr-provider';
import { TesseractProvider } from './tesseract.provider';

@Module({
  providers: [
    {
      provide: OCR_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): OcrProvider => {
        const name = config.get<string>('OCR_PROVIDER') ?? 'tesseract';
        if (name === 'tesseract') {
          return new TesseractProvider(config.get('TESSERACT_BIN') || 'tesseract', config.get('TESSERACT_LANG') || 'eng');
        }
        throw new Error(`Unknown OCR_PROVIDER "${name}"`);
      },
    },
  ],
  exports: [OCR_PROVIDER],
})
export class OcrModule {}
