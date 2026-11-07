import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { User } from '../../src/users/entities/user.entity';
import { assertSafeTestDatabase } from './env';
import {
  EmailService,
  OutgoingEmail,
} from '../../src/common/services/email.service';

export async function createTestApp() {
  assertSafeTestDatabase();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  // Capture emails instead of sending them.
  const outbox: OutgoingEmail[] = [];
  const emailService = moduleRef.get(EmailService);
  emailService.send = (email: OutgoingEmail) => {
    outbox.push(email);
    return Promise.resolve(true);
  };
  const app: INestApplication = moduleRef.createNestApplication({
    logger: ['error'],
  });
  configureApp(app);
  await app.init();
  const ds = app.get(DataSource);
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });

  async function createUser(label = 'student', extra: Partial<User> = {}) {
    const suffix = randomUUID().slice(0, 8);
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        email: `${label}-${suffix}@test.campussales.ng`,
        username: `${label}_${suffix}`,
        passwordHash: 'not-a-real-hash',
        ...extra,
      }),
    );
    const token = jwt.sign({ sub: user.id, email: user.email });
    return { user, auth: { Authorization: `Bearer ${token}` } };
  }

  /** Waits for a background email (forgot-password sends asynchronously). */
  async function nextEmail(
    to: string,
    kind: OutgoingEmail['kind'],
    timeoutMs = 3000,
  ): Promise<OutgoingEmail> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = [...outbox]
        .reverse()
        .find((e) => e.to === to && e.kind === kind);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`No ${kind} email to ${to}`);
  }

  return { app, ds, createUser, outbox, nextEmail };
}
