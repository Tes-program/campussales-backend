import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url, body, params, query } = request;
    const userAgent = request.get('user-agent') || '';
    const ip = request.ip;
    const now = Date.now();

    // Log incoming request
    this.logger.log(
      `Incoming Request: ${method} ${url} - IP: ${ip} - User Agent: ${userAgent}`,
    );

    if (Object.keys(body).length > 0) {
      // Don't log sensitive data like passwords
      const sanitizedBody = this.sanitizeData(body);
      this.logger.debug(`Request Body: ${JSON.stringify(sanitizedBody)}`);
    }

    if (Object.keys(params).length > 0) {
      this.logger.debug(`Request Params: ${JSON.stringify(params)}`);
    }

    if (Object.keys(query).length > 0) {
      this.logger.debug(`Request Query: ${JSON.stringify(query)}`);
    }

    return next.handle().pipe(
      tap((data) => {
        const response = context.switchToHttp().getResponse();
        const { statusCode } = response;
        const responseTime = Date.now() - now;

        this.logger.log(
          `Outgoing Response: ${method} ${url} ${statusCode} - ${responseTime}ms`,
        );

        if (data) {
          this.logger.debug(`Response Data: ${JSON.stringify(data)}`);
        }
      }),
      catchError((error) => {
        const responseTime = Date.now() - now;
        
        this.logger.error(
          `Request Failed: ${method} ${url} - ${responseTime}ms`,
          error.stack,
        );

        return throwError(() => error);
      }),
    );
  }

  private sanitizeData(data: any): any {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const sensitiveFields = [
      'password',
      'passwordHash',
      'currentPassword',
      'newPassword',
      'confirmPassword',
      'token',
      'refreshToken',
      'accessToken',
      'resetToken',
    ];

    const sanitized = { ...data };

    for (const key of Object.keys(sanitized)) {
      if (sensitiveFields.includes(key)) {
        sanitized[key] = '***REDACTED***';
      } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = this.sanitizeData(sanitized[key]);
      }
    }

    return sanitized;
  }
}
