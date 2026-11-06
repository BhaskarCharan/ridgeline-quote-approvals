import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { API_URL, QuotesService } from './quotes.service';

/**
 * Adds `X-User-Id: <selected user>` to every request to the review API, and
 * only to that API, so the header never leaks to other hosts.
 *
 * Production: replaced by the identity provider's token (Authorization:
 * Bearer ...), which the backend verifies instead of trusting a header.
 */
export const userIdInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(API_URL)) return next(req);
  const userId = inject(QuotesService).currentUser();
  return next(userId ? req.clone({ setHeaders: { 'X-User-Id': userId } }) : req);
};
