import { detectImageType } from './image-type';

describe('detectImageType', () => {
  it('detects jpeg, png and webp by magic bytes', () => {
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(
      detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
    ).toBe('image/png');
    expect(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('rejects other content', () => {
    expect(detectImageType(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(detectImageType(Buffer.from('<svg></svg>'))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});
