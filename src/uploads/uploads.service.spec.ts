import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { UploadsService } from './uploads.service';
import { CloudinaryClient } from './cloudinary.client';
import { Upload } from './entities/upload.entitiy';
import { UsersService } from '../users/user.service';
import { ValidationFailed } from '../common/errors/app-errors';

function png(w: number, h: number) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe('UploadsService.assertListingPhotoSizes (legacy multipart)', () => {
  let dir: string;
  const file = (name: string, buf: Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, buf);
    return { filename: name, path } as Express.Multer.File;
  };
  const service = (storage: string, cloud: Partial<CloudinaryClient> = {}) =>
    new UploadsService(
      {} as Repository<Upload>,
      { get: () => storage } as unknown as ConfigService,
      {} as UsersService,
      cloud as CloudinaryClient,
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cs-up-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lets big-enough local photos through', async () => {
    const a = file('a.png', png(800, 600));
    await expect(
      service('local').assertListingPhotoSizes([a]),
    ).resolves.toBeUndefined();
    expect(existsSync(a.path)).toBe(true);
  });

  it('rejects the request and removes every stored file when one photo is too small', async () => {
    const ok = file('ok.png', png(800, 600));
    const small = file('small.png', png(399, 300));
    const err = await service('local')
      .assertListingPhotoSizes([ok, small])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationFailed);
    expect((err as Error).message).toBe(
      'This photo is too small. Use one at least 400x300.',
    );
    expect(existsSync(ok.path)).toBe(false);
    expect(existsSync(small.path)).toBe(false);
  });

  it('lets a photo through when its size cannot be read', async () => {
    const odd = file('odd.png', Buffer.from('not really an image'));
    await expect(
      service('local').assertListingPhotoSizes([odd]),
    ).resolves.toBeUndefined();
  });

  it('uses Cloudinary sizes and deletes rejected Cloudinary files', async () => {
    const destroyed: string[] = [];
    const svc = service('cloudinary', {
      resource: (id: string) =>
        Promise.resolve({
          publicId: id,
          version: 1,
          format: 'jpg',
          bytes: 1,
          width: 200,
          height: 150,
          secureUrl: '',
        }),
      destroy: (ids: string[]) => {
        destroyed.push(...ids);
        return Promise.resolve();
      },
    });
    await expect(
      svc.assertListingPhotoSizes([
        { filename: 'campussales/1-x' } as Express.Multer.File,
      ]),
    ).rejects.toBeInstanceOf(ValidationFailed);
    expect(destroyed).toEqual(['campussales/1-x']);
  });
});
