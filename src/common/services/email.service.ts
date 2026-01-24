// src/common/services/email.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private transporter: nodemailer.Transporter;
  private readonly logger = new Logger(EmailService.name);

  constructor(private configService: ConfigService) {
    // Initialize email transporter
    const emailConfig = {
      host: this.configService.get('EMAIL_HOST') || 'smtp.gmail.com',
      port: this.configService.get('EMAIL_PORT') || 587,
      secure: false,
      auth: {
        user: this.configService.get('EMAIL_USER'),
        pass: this.configService.get('EMAIL_PASSWORD'),
      },
    };

    // Only create transporter if email credentials are provided
    if (emailConfig.auth.user && emailConfig.auth.pass) {
      this.transporter = nodemailer.createTransport(emailConfig);
    } else {
      this.logger.warn(
        'Email credentials not configured. Email functionality will be simulated.',
      );
    }
  }

  async sendPasswordResetEmail(
    email: string,
    resetToken: string,
    firstName?: string,
  ): Promise<void> {
    const frontendUrl =
      this.configService.get('FRONTEND_URL') || 'http://localhost:3000';
    const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

    const mailOptions = {
      from:
        this.configService.get('EMAIL_FROM') ||
        'CampusSales <noreply@campussales.com>',
      to: email,
      subject: 'Password Reset Request - CampusSales',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 5px 5px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
            .warning { background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🔐 Password Reset Request</h1>
            </div>
            <div class="content">
              <p>Hi ${firstName || 'there'},</p>
              
              <p>We received a request to reset your password for your CampusSales account.</p>
              
              <p>Click the button below to reset your password:</p>
              
              <div style="text-align: center;">
                <a href="${resetUrl}" class="button">Reset Password</a>
              </div>
              
              <p>Or copy and paste this link into your browser:</p>
              <p style="word-break: break-all; color: #4F46E5;">${resetUrl}</p>
              
              <div class="warning">
                <strong>⚠️ Security Notice:</strong>
                <ul>
                  <li>This link will expire in 1 hour</li>
                  <li>If you didn't request this, please ignore this email</li>
                  <li>Never share this link with anyone</li>
                </ul>
              </div>
              
              <p>Need help? Contact our support team.</p>
              
              <p>Best regards,<br>The CampusSales Team</p>
            </div>
            <div class="footer">
              <p>This is an automated email. Please do not reply.</p>
              <p>&copy; ${new Date().getFullYear()} CampusSales. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
        Password Reset Request
        
        Hi ${firstName || 'there'},
        
        We received a request to reset your password for your CampusSales account.
        
        Click this link to reset your password: ${resetUrl}
        
        This link will expire in 1 hour.
        
        If you didn't request this, please ignore this email.
        
        Best regards,
        The CampusSales Team
      `,
    };

    try {
      if (this.transporter) {
        await this.transporter.sendMail(mailOptions);
        this.logger.log(`Password reset email sent to ${email}`);
      } else {
        // Simulate sending email in development
        this.logger.log(
          `[SIMULATED] Password reset email would be sent to ${email}`,
        );
        this.logger.log(`Reset URL: ${resetUrl}`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to send password reset email to ${email}`,
        error,
      );
      throw new Error('Failed to send password reset email');
    }
  }

  async sendPasswordChangedEmail(
    email: string,
    firstName?: string,
  ): Promise<void> {
    const mailOptions = {
      from:
        this.configService.get('EMAIL_FROM') ||
        'CampusSales <noreply@campussales.com>',
      to: email,
      subject: 'Password Changed Successfully - CampusSales',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #10b981; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 5px 5px; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
            .warning { background-color: #fee2e2; border-left: 4px solid #ef4444; padding: 12px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>✅ Password Changed</h1>
            </div>
            <div class="content">
              <p>Hi ${firstName || 'there'},</p>
              
              <p>Your password has been successfully changed.</p>
              
              <div class="warning">
                <strong>⚠️ Didn't make this change?</strong>
                <p>If you didn't change your password, please contact our support team immediately and secure your account.</p>
              </div>
              
              <p>Best regards,<br>The CampusSales Team</p>
            </div>
            <div class="footer">
              <p>This is an automated email. Please do not reply.</p>
              <p>&copy; ${new Date().getFullYear()} CampusSales. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    };

    try {
      if (this.transporter) {
        await this.transporter.sendMail(mailOptions);
        this.logger.log(`Password changed notification sent to ${email}`);
      } else {
        this.logger.log(
          `[SIMULATED] Password changed email would be sent to ${email}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to send password changed email to ${email}`,
        error,
      );
      // Don't throw error here, just log it
    }
  }
}
