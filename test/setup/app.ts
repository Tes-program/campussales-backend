import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { User } from '../../src/users/entities/user.entity';
import { assertSafeTestDatabase } from './env';

export async function createTestApp() {
  assertSafeTestDatabase();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({
    logger: ['error'],
  });
  configureApp(app);
  await app.init();
  const ds = app.get(DataSource);
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });

  async function createUser(label = 'student') {
    const suffix = randomUUID().slice(0, 8);
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        email: `${label}-${suffix}@test.campussales.ng`,
        username: `${label}_${suffix}`,
        passwordHash: 'not-a-real-hash',
      }),
    );
    const token = jwt.sign({ sub: user.id, email: user.email });
    return { user, auth: { Authorization: `Bearer ${token}` } };
  }

  return { app, ds, createUser };
}
