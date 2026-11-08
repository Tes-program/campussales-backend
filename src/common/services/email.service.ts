// src/common/services/email.service.ts
import { metrics, METRIC } from '../observability/metrics';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Kind of email, for logs and tests. Never contains the link. */
  kind: 'password_reset' | 'email_verification' | 'password_changed' | 'notice';
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

const maskEmail = (email: string) => {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain ?? ''}`;
};

/**
 * Transactional email. Templates are deliberately plain: one brand colour,
 * one button, the expiry time, an "ignore this" line, and direct links only
 * (no tracking redirects, no images, no external resources).
 *
 * Links and tokens are never logged. Delivery failures are logged with the
 * email kind and a masked address only.
 */
@Injectable()
export class EmailService {
  // @types/nodemailer is not installed, so Transporter is untyped here.
  private transporter: nodemailer.Transporter | undefined;
  private readonly logger = new Logger(EmailService.name);

  constructor(private configService: ConfigService) {
    const user = this.configService.get<string>('EMAIL_USER');
    const pass = this.configService.get<string>('EMAIL_PASSWORD');
    if (user && pass) {
      this.transporter = nodemailer.createTransport({
        host: this.configService.get('EMAIL_HOST') || 'smtp.gmail.com',
        port: Number(this.configService.get('EMAIL_PORT') || 587),
        secure: false,
        auth: { user, pass },
      });
    } else {
      this.logger.warn(
        'Email credentials not configured. Emails will be simulated.',
      );
    }
  }

  async sendPasswordResetEmail(
    to: string,
    resetUrl: string,
    expiresInMinutes: number,
    firstName?: string | null,
  ): Promise<boolean> {
    return this.send(
      this.render({
        to,
        kind: 'password_reset',
        subject: 'Reset your CampusSales password',
        firstName,
        lines: [
          'We got a request to reset the password for your CampusSales account.',
          `This link works once and expires in ${expiresInMinutes} minutes.`,
        ],
        button: { label: 'Reset password', url: resetUrl },
        footer:
          "If you didn't ask for this, ignore this email. Your password won't change.",
      }),
    );
  }

  async sendVerificationEmail(
    to: string,
    verifyUrl: string,
    expiresInHours: number,
    firstName?: string | null,
  ): Promise<boolean> {
    return this.send(
      this.render({
        to,
        kind: 'email_verification',
        subject: 'Confirm your email for CampusSales',
        firstName,
        lines: [
          'Welcome to CampusSales! Please confirm this is your email address.',
          `This link expires in ${expiresInHours} hours.`,
        ],
        button: { label: 'Confirm email', url: verifyUrl },
        footer:
          "If you didn't create a CampusSales account, ignore this email.",
      }),
    );
  }

  async sendPasswordChangedEmail(
    to: string,
    firstName?: string | null,
  ): Promise<boolean> {
    return this.send(
      this.render({
        to,
        kind: 'password_changed',
        subject: 'Your CampusSales password was changed',
        firstName,
        lines: [
          'Your password was changed, and you were signed out on your other devices.',
          "If this was you, there's nothing else to do.",
        ],
        footer:
          "If you didn't change your password, reset it from the login page right away and contact support.",
      }),
    );
  }

  /** Generic notice from our own templates (used by moderation in B4). */
  async sendNotice(
    to: string,
    subject: string,
    lines: string[],
    firstName?: string | null,
  ): Promise<boolean> {
    return this.send(
      this.render({
        to,
        kind: 'notice',
        subject,
        firstName,
        lines,
        footer: 'CampusSales Team',
      }),
    );
  }

  /** Overridable in tests. Never throws. */
  async send(email: OutgoingEmail): Promise<boolean> {
    const from =
      this.configService.get<string>('EMAIL_FROM') ||
      'CampusSales <noreply@campussales.com>';
    try {
      if (this.transporter) {
        await this.transporter.sendMail({
          from,
          to: email.to,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
        this.logger.log(`Sent ${email.kind} email to ${maskEmail(email.to)}`);
        metrics.count(METRIC.emailSent);
      } else {
        this.logger.log(
          `[SIMULATED] ${email.kind} email to ${maskEmail(email.to)}`,
        );
      }
      return true;
    } catch (error) {
      const e = error as {
        code?: string;
        name?: string;
        responseCode?: number;
      };
      metrics.count(METRIC.emailFailed);
      this.logger.error(
        `Failed to send ${email.kind} email to ${maskEmail(email.to)}: ${e.code ?? e.name ?? 'error'}${e.responseCode ? ` (${e.responseCode})` : ''}`,
      );
      return false;
    }
  }

  private render(o: {
    to: string;
    kind: OutgoingEmail['kind'];
    subject: string;
    firstName?: string | null;
    lines: string[];
    button?: { label: string; url: string };
    footer: string;
  }): OutgoingEmail {
    const hello = `Hi ${o.firstName ? escapeHtml(o.firstName) : 'there'},`;
    const paragraphs = o.lines
      .map((l) => `<p style="margin:0 0 16px">${escapeHtml(l)}</p>`)
      .join('');
    const button = o.button
      ? `<p style="margin:24px 0"><a href="${escapeHtml(o.button.url)}" style="background:#4F46E5;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;display:inline-block;font-weight:600">${escapeHtml(o.button.label)}</a></p>
         <p style="margin:0 0 16px;font-size:13px;color:#6b7280">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(o.button.url)}</span></p>`
      : '';
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827">
<p style="margin:0 0 24px;font-size:18px;font-weight:700;color:#4F46E5">CampusSales</p>
<p style="margin:0 0 16px">${hello}</p>${paragraphs}${button}
<p style="margin:24px 0 0;font-size:13px;color:#6b7280">${escapeHtml(o.footer)}</p>
</div></body></html>`;
    const text = [
      `Hi ${o.firstName ?? 'there'},`,
      '',
      ...o.lines,
      ...(o.button ? ['', `${o.button.label}: ${o.button.url}`] : []),
      '',
      o.footer,
      '',
      'CampusSales',
    ].join('\n');
    return { to: o.to, subject: o.subject, html, text, kind: o.kind };
  }
}
