import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';

/** The review API. The one place the backend URL is configured. */
export const API_URL = 'http://localhost:3000';

export type QuoteStatus = 'pending_specialist' | 'pending_approver' | 'approved' | 'rejected' | 'duplicate';

export interface ReviewFlag {
  /** Null when the flag concerns the whole quote. */
  line: number | null;
  reason: string;
}

/** The subset of the backend's Quote that the inbox shows. */
export interface Quote {
  draftId: string;
  customerId: string;
  preparedBy: string;
  status: QuoteStatus;
  version: number;
  approverPath: string[];
  routing: {
    status: 'specialist_only' | 'approver_required' | 'duplicate';
    net_total: number | null;
    effective_discount_pct: number | null;
    approver_id: string | null;
    specialist_review_flags: ReviewFlag[];
    duplicate_of: string | null;
  };
}

/** An API failure, normalised from the backend's `{ code, message, details }`. */
export interface ApiError {
  status: number;
  code: string;
  message: string;
}

/**
 * Talks to the review API and holds who the user is "signed in" as. The user
 * id lives here (not in the component) so the interceptor can read it for
 * every request.
 */
@Injectable({ providedIn: 'root' })
export class QuotesService {
  private readonly http = inject(HttpClient);

  /** Sent as X-User-Id by the interceptor. A stand-in for real sign-in. */
  readonly currentUser = signal('S01');

  list(): Observable<Quote[]> {
    return this.http.get<Quote[]>(`${API_URL}/quotes`);
  }

  /** Sends the version the user is looking at, so a stale screen gets a 409. */
  approve(quote: Quote): Observable<Quote> {
    return this.http.post<Quote>(`${API_URL}/quotes/${encodeURIComponent(quote.draftId)}/approve`, {
      version: quote.version,
    });
  }

  reject(quote: Quote, reason: string): Observable<Quote> {
    return this.http.post<Quote>(`${API_URL}/quotes/${encodeURIComponent(quote.draftId)}/reject`, {
      reason,
      version: quote.version,
    });
  }
}

/** Turn any HttpClient error into an ApiError for the message bar. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) {
      return { status: 0, code: 'network_error', message: `Cannot reach the API at ${API_URL}. Is the backend running?` };
    }
    const body: unknown = err.error;
    if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
      return { status: err.status, code: String(body.code), message: String(body.message) };
    }
    return { status: err.status, code: `http_${err.status}`, message: err.message };
  }
  return { status: 0, code: 'unknown_error', message: String(err) };
}
