import { crc32 } from 'node:zlib';
import { scriptedLlm } from '@meirakrish/llm-kit/testing';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PermanentIngestError } from './errors';
import { describeImage, IMAGE_LIMITS, IMAGE_PROMPT, prepareImage } from './image';

const solid = (width: number, height: number, format: 'png' | 'webp' = 'png') =>
  sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    [format]()
    .toBuffer();

describe('prepareImage', () => {
  it('fits large images within the max side as JPEG, and leaves small ones their size', async () => {
    const big = await sharp(await prepareImage(await solid(4000, 1000))).metadata();
    expect(big).toMatchObject({ format: 'jpeg', width: IMAGE_LIMITS.maxSide, height: 392 });

    const small = await sharp(await prepareImage(await solid(300, 200, 'webp'))).metadata();
    expect(small).toMatchObject({ format: 'jpeg', width: 300, height: 200 });
  });

  it('turns transparency white rather than black', async () => {
    const { data } = await sharp(await prepareImage(await solid(10, 10)))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
  });

  it('rejects files that are not images, and images over the pixel limit', async () => {
    await expect(prepareImage(new TextEncoder().encode('nope'))).rejects.toThrow(
      /could not be read/,
    );
    // A 1×1 PNG whose header claims 20,000 × 20,000 pixels (checksum fixed, so it decodes that far).
    const bomb = Buffer.from(await solid(1, 1));
    bomb.writeUInt32BE(20_000, 16);
    bomb.writeUInt32BE(20_000, 20);
    bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
    await expect(prepareImage(bomb)).rejects.toThrow(/too large/);
    await expect(prepareImage(bomb)).rejects.toBeInstanceOf(PermanentIngestError);
  });
});

describe('describeImage', () => {
  it('sends the prompt and the image as JPEG, and returns the trimmed text', async () => {
    const llm = scriptedLlm({
      stream: [['  Text in the image:\nnone\n', '\nDescription:\nGrey.  ']],
    });

    expect(await describeImage(llm, await solid(50, 50))).toBe(
      'Text in the image:\nnone\n\nDescription:\nGrey.',
    );
    const [system, human] = llm.calls[0]!.messages;
    expect(system!.content).toBe(IMAGE_PROMPT);
    const parts = human!.content as { type: string; image_url?: string }[];
    expect(parts.find((p) => p.type === 'image_url')?.image_url).toMatch(
      /^data:image\/jpeg;base64,\/9j\//,
    );
  });

  it('fails permanently when the model says nothing', async () => {
    await expect(
      describeImage(scriptedLlm({ stream: [['  ']] }), await solid(10, 10)),
    ).rejects.toThrow(/returned nothing/);
  });
});
