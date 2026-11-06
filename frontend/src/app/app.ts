import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { Quote, QuoteStatus, QuotesService, toApiError } from './quotes.service';

/** Users from approvers.csv, so the demo can switch identity. */
const USERS = [
  { id: 'S01', label: 'S01 · Maria Lopez (specialist)' },
  { id: 'S02', label: 'S02 · Kevin Tran (specialist)' },
  { id: 'S03', label: 'S03 · Jordan Price (specialist)' },
  { id: 'U01', label: 'U01 · Priya Nair (RM West)' },
  { id: 'U02', label: 'U02 · Tom Becker (RM Central)' },
  { id: 'U03', label: 'U03 · Alicia Moreno (RM East)' },
  { id: 'U04', label: 'U04 · Grant Holloway (Sales Ops Director)' },
  { id: 'U05', label: 'U05 · Dana Whitfield (VP Sales)' },
] as const;

const STATUS_LABELS: Record<QuoteStatus, string> = {
  pending_specialist: 'Pending specialist',
  pending_approver: 'Pending approver',
  approved: 'Approved',
  rejected: 'Rejected',
  duplicate: 'Duplicate',
};

interface Message {
  kind: 'error' | 'success';
  text: string;
}

/**
 * Quote inbox: pick who you are, see every quote with its routing and flags,
 * approve or reject. The UI deliberately lets anyone press the buttons: the
 * API decides who may act, and its 401/403/409 answers show up in the message
 * bar, which makes the rules visible in a demo.
 */
@Component({
  selector: 'app-root',
  imports: [CurrencyPipe, DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly api = inject(QuotesService);

  protected readonly users = USERS;
  protected readonly statusLabels = STATUS_LABELS;
  protected readonly currentUser = this.api.currentUser;

  protected readonly quotes = signal<Quote[]>([]);
  protected readonly loading = signal(false);
  /** Draft id with a request in flight, to disable its buttons. */
  protected readonly busyId = signal<string | null>(null);
  /** Draft id whose reject-reason input is open. */
  protected readonly rejectingId = signal<string | null>(null);
  protected readonly message = signal<Message | null>(null);

  constructor() {
    this.load();
  }

  protected selectUser(userId: string): void {
    this.currentUser.set(userId);
    this.rejectingId.set(null);
    this.message.set(null);
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.api.list().subscribe({
      next: (quotes) => {
        this.quotes.set(quotes);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.loading.set(false);
        this.showError(err);
      },
    });
  }

  protected approve(quote: Quote): void {
    this.act(quote, this.api.approve(quote), 'approved');
  }

  protected confirmReject(quote: Quote, reason: string): void {
    this.act(quote, this.api.reject(quote, reason.trim()), 'rejected');
  }

  protected isPending(quote: Quote): boolean {
    return quote.status === 'pending_specialist' || quote.status === 'pending_approver';
  }

  /** Mirrors the backend's rule only to highlight rows; the API stays the authority. */
  protected isMyTurn(quote: Quote): boolean {
    const user = this.currentUser();
    if (quote.status === 'pending_specialist') return user.startsWith('S') && user !== quote.preparedBy;
    if (quote.status === 'pending_approver') return quote.routing.approver_id === user;
    return false;
  }

  /** e.g. "U04 (backup for U02)" when the routed manager was out of office. */
  protected approverLabel(quote: Quote): string {
    const approver = quote.routing.approver_id;
    if (!approver) return quote.routing.status === 'specialist_only' ? 'Specialist only' : '—';
    const path = quote.approverPath;
    return path.length > 1 ? `${approver} (backup for ${path[0]})` : approver;
  }

  private act(quote: Quote, request: Observable<Quote>, verb: string): void {
    this.busyId.set(quote.draftId);
    this.message.set(null);
    request.subscribe({
      next: (updated) => {
        this.busyId.set(null);
        this.rejectingId.set(null);
        this.quotes.update((list) => list.map((q) => (q.draftId === updated.draftId ? updated : q)));
        this.message.set({
          kind: 'success',
          text: `${updated.draftId} ${verb} by ${this.currentUser()}: now ${STATUS_LABELS[updated.status]}.`,
        });
      },
      error: (err: unknown) => {
        this.busyId.set(null);
        this.showError(err);
        // A 409 means our copy is stale: refresh so the next click uses the current version.
        if (toApiError(err).status === 409) this.load();
      },
    });
  }

  private showError(err: unknown): void {
    const e = toApiError(err);
    const prefix = e.status ? `${e.status} ${e.code}` : e.code;
    this.message.set({ kind: 'error', text: `${prefix}: ${e.message}` });
  }
}
