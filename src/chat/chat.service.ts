import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { SendMessageDto } from './dto/send-message.dto';
import {
  FilterConversationsDto,
  ConversationFilter,
} from './dto/filter-conversations.dto';
import { FilterMessagesDto } from './dto/filter-messages.dto';
import { MessageType, ConversationType } from './enums/chat.enums';
import { NotificationsService } from '../notifications/notifications.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import {
  AppError,
  rateLimited,
  ValidationFailed,
  notFound,
} from '../common/errors/app-errors';
import { ErrorCode } from '../common/errors/error-codes';
import {
  iso,
  LegacyProduct,
  messageView,
  MessageRow,
  MessageView,
  MessageViewContext,
  PublicUser,
} from './chat-views';
import { scanMessage, SCAM_REVIEW_THRESHOLD } from './scam-signals';
import { appendMessage, isUniqueViolation } from './message-writer';
import { chatEvents } from './chat-events';
import { ChatPresence } from './chat-presence';
import { MessageAttachment } from './entities/message.entity';
import { parseCloudinaryUrl, cloudinaryUrl } from '../uploads/cloudinary-url';
import { UPLOAD_RULES } from '../uploads/upload-rules';
import { chatMetrics } from './chat-metrics';
import { writeJson } from '../common/observability/json-logger';
import { hashUserId } from '../common/observability/redact';
import { currentContext } from '../common/observability/request-context';
import { logRequests } from '../common/observability/timing.middleware';

export const CHAT_LIMITS = {
  messageMaxLength: 1000,
  messagesPerMinute: 30,
  newConversationsPerHour: 10,
  attachmentsPerMessage: 4,
  /** "Delete for everyone" window. */
  deleteForEveryoneMs: 10 * 60_000,
  historyPageSize: 30,
  listPageSize: 20,
} as const;

const NO_PRODUCT = '00000000-0000-0000-0000-000000000000';

/** Everything a request needs about one conversation, in one query. */
interface ConversationContext {
  id: string;
  lastSeq: number;
  closedAt: Date | null;
  myReadSeq: number;
  myDeliveredSeq: number;
  clearedSeq: number | null;
  otherId: string | null;
  otherReadSeq: number;
  otherDeliveredSeq: number;
  blocked: boolean;
  users: Map<string, PublicUser | null>;
}

interface ListRow {
  id: string;
  type: ConversationType;
  productId: string | null;
  productTitle: string | null;
  productImageUrl: string | null;
  productPrice: number | null;
  closedAt: Date | null;
  closedReason: string | null;
  createdAt: Date;
  lastSeq: string;
  unreadCount: number;
  archived: boolean;
  muted: boolean;
  sortAt: Date;
  sortKey: string;
  lastReadSeq: string;
  otherId: string | null;
  otherReadSeq: string | null;
  otherDeliveredSeq: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  lastActiveAt: Date | null;
  presenceVisible: boolean | null;
  pTitle: string | null;
  pPrice: number | null;
  pStatus: string | null;
  pDeletedAt: Date | null;
  pExists: boolean;
  lmId: string | null;
  lmSeq: string | null;
  lmContent: string | null;
  lmType: MessageType | null;
  lmSenderId: string | null;
  lmCreatedAt: Date | null;
  lmDeletedAt: Date | null;
  lmAttachments: MessageAttachment[] | null;
}

export interface SendMeta {
  via: 'http' | 'socket';
  requestId?: string;
}

export interface SendResult {
  message: MessageView;
  /** false when the clientMessageId was already used: the original is returned. */
  created: boolean;
}

const notInChat = () => new AppError(ErrorCode.CONVERSATION_NOT_FOUND);

const rowsOf = <T>(raw: unknown): T[] =>
  (Array.isArray((raw as unknown[])[0]) ? (raw as T[][])[0] : raw) as T[];

const MESSAGE_COLUMNS = `m.id, m."conversationId", m.seq, m."clientMessageId", m."senderId", m.content, m.type,
  m.attachments, m."replyToId", m."productId", m.flags, m."deletedAt", m."createdAt"`;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly notificationsService: NotificationsService,
    private readonly rateLimit: RateLimitService,
    private readonly presence: ChatPresence,
    private readonly config: ConfigService,
  ) {}

  // ─── conversations ──────────────────────────────────────────────────

  /**
   * One conversation per (buyer, seller, product) and one general
   * conversation per pair when there is no product. Find-or-create, safe
   * against concurrent calls (the unique pair+product index decides).
   */
  async createConversation(
    userId: string,
    dto: { participantId: string; productId?: string },
  ): Promise<{ conversation: ConversationItem; isExisting: boolean }> {
    if (userId === dto.participantId) {
      throw new ValidationFailed(
        { participantId: "You can't start a chat with yourself." },
        "You can't start a chat with yourself.",
      );
    }
    const [[other], product] = await Promise.all([
      this.ds.query<Array<{ id: string; blocked: boolean }>>(
        `SELECT u.id, EXISTS (SELECT 1 FROM "user_blocks" ub
                  WHERE (ub."blockerId" = $1 AND ub."blockedId" = u.id)
                     OR (ub."blockerId" = u.id AND ub."blockedId" = $1)) AS blocked
           FROM "users" u WHERE u.id = $2`,
        [userId, dto.participantId],
      ),
      dto.productId ? this.listingSnapshot(dto.productId) : null,
    ]);
    if (!other) throw notFound("We couldn't find that person.");
    if (other.blocked) throw new AppError(ErrorCode.BLOCKED);
    if (product && ![userId, dto.participantId].includes(product.sellerId)) {
      throw new ValidationFailed(
        { productId: 'This item belongs to someone else.' },
        'This item belongs to someone else.',
      );
    }
    const [lo, hi] = [userId, dto.participantId].sort();
    const productId = product?.productId ?? null;

    const existing = await this.findPairConversation(lo, hi, productId);
    if (existing) {
      return {
        conversation: await this.getConversation(existing, userId),
        isExisting: true,
      };
    }

    const limit = await this.rateLimit.consume(
      RateLimitService.key('chat-new', userId),
      CHAT_LIMITS.newConversationsPerHour,
      3_600_000,
    );
    if (!limit.allowed) {
      throw rateLimited(
        "You've started a lot of chats in the last hour. Please try again a bit later.",
        limit.retryAfterSeconds,
      );
    }

    const createdId = await this.ds.transaction(async (m) => {
      const inserted = rowsOf<{ id: string }>(
        await m.query(
          `INSERT INTO "conversations" ("type", "userLowId", "userHighId", "productId", "productTitle", "productImageUrl", "productPrice")
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            productId
              ? ConversationType.PRODUCT_INQUIRY
              : ConversationType.DIRECT,
            lo,
            hi,
            productId,
            product?.productTitle ?? null,
            product?.productImageUrl ?? null,
            product?.productPrice ?? null,
          ],
        ),
      );
      if (!inserted[0]) return null;
      await m.query(
        `INSERT INTO "conversation_participants" ("conversationId", "userId", "lastMessageAt")
         VALUES ($1, $2, now()), ($1, $3, now())`,
        [inserted[0].id, userId, dto.participantId],
      );
      return inserted[0].id;
    });

    if (!createdId) {
      // Lost a race with a parallel create: return the winner.
      const winner = await this.findPairConversation(lo, hi, productId);
      if (!winner) throw new Error('Conversation create conflict');
      return {
        conversation: await this.getConversation(winner, userId),
        isExisting: true,
      };
    }

    const conversation = await this.getConversation(createdId, userId);
    this.notifyNewConversation(userId, dto.participantId, createdId).catch(
      (err: Error) =>
        this.logger.error(
          `New conversation notification failed: ${err.message}`,
        ),
    );
    return { conversation, isExisting: false };
  }

  async findExistingConversation(
    userId: string,
    participantId: string,
    productId?: string,
  ): Promise<ConversationItem | null> {
    const [lo, hi] = [userId, participantId].sort();
    const id = await this.findPairConversation(lo, hi, productId ?? null);
    return id ? this.getConversation(id, userId) : null;
  }

  private async findPairConversation(
    lo: string,
    hi: string,
    productId: string | null,
  ): Promise<string | null> {
    const [row] = await this.ds.query<Array<{ id: string }>>(
      `SELECT id FROM "conversations"
        WHERE "userLowId" = $1 AND "userHighId" = $2
          AND COALESCE("productId", $4::uuid) = COALESCE($3::uuid, $4::uuid)
        ORDER BY "createdAt" LIMIT 1`,
      [lo, hi, productId, NO_PRODUCT],
    );
    return row?.id ?? null;
  }

  /**
   * The conversation list in one query (no N+1): the other participant,
   * listing, last visible message (LATERAL on the seq index), unread count
   * (stored), sorted by last message with a keyset cursor.
   */
  async listConversations(userId: string, f: FilterConversationsDto) {
    const limit = f.limit ?? CHAT_LIMITS.listPageSize;
    const cursor = f.cursor ? decodeCursor(f.cursor) : null;
    const params: unknown[] = [userId, limit + 1];
    const where: string[] = [
      `me."userId" = $1`,
      // "Delete chat" hides it until a new message arrives.
      `(me."clearedSeq" IS NULL OR c."lastSeq" > me."clearedSeq")`,
      NOT_BLOCKED,
    ];
    where.push(
      f.archived === 'true' ? `me."archived" = true` : `me."archived" = false`,
    );
    if (f.filter === ConversationFilter.UNREAD)
      where.push(`me."unreadCount" > 0`);
    if (cursor) {
      params.push(cursor.t, cursor.i);
      where.push(
        `(me."lastMessageAt", c.id) < ($${params.length - 1}::timestamp, $${params.length}::uuid)`,
      );
    } else if (f.page && f.page > 1) {
      params.push((f.page - 1) * limit);
    }
    const offset =
      !cursor && f.page && f.page > 1 ? `OFFSET $${params.length}` : '';
    const rows = await this.ds.query<ListRow[]>(
      `${LIST_SELECT}
        WHERE ${where.join(' AND ')}
        ORDER BY me."lastMessageAt" DESC, c.id DESC
        LIMIT $2 ${offset}`,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const items = page.map((r) => this.listItem(r));
    const totalUnread = await this.getTotalUnreadCount(userId);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ t: last.sortKey, i: last.id }),
            ).toString('base64url')
          : null,
      totalUnread,
      // legacy (one release)
      data: items,
      page: f.page ?? 1,
      limit,
    };
  }

  async getConversation(id: string, userId: string): Promise<ConversationItem> {
    const [row] = await this.ds.query<ListRow[]>(
      `${LIST_SELECT} WHERE me."userId" = $1 AND c.id = $2`,
      [userId, id],
    );
    if (!row) throw notInChat();
    return this.listItem(row);
  }

  private listItem(r: ListRow) {
    const name =
      [r.firstName, r.lastName].filter(Boolean).join(' ').trim() ||
      r.username ||
      null;
    const showPresence = !!r.presenceVisible;
    const lastSeq = Number(r.lastSeq);
    const productStatus = !r.productId
      ? null
      : !r.pExists || r.pDeletedAt
        ? 'deleted'
        : (r.pStatus ?? 'active');
    const lmDeleted = !!r.lmDeletedAt;
    return {
      id: r.id,
      participant: r.otherId
        ? {
            id: r.otherId,
            username: r.username,
            name,
            avatar: r.avatar ?? null,
            lastActiveAt: showPresence ? iso(r.lastActiveAt) : null,
            online: showPresence ? this.presence.isOnline(r.otherId) : null,
          }
        : null,
      product: r.productId
        ? {
            id: r.productId,
            title: r.pTitle ?? r.productTitle,
            cover: r.productImageUrl,
            price: r.pPrice ?? r.productPrice,
            status: productStatus,
          }
        : null,
      lastMessage: r.lmId
        ? {
            id: r.lmId,
            seq: Number(r.lmSeq),
            text: lmDeleted ? null : r.lmContent,
            type: r.lmType,
            senderId: r.lmSenderId,
            hasAttachments: !lmDeleted && (r.lmAttachments ?? []).length > 0,
            deleted: lmDeleted,
            createdAt: iso(r.lmCreatedAt),
          }
        : null,
      unreadCount: r.unreadCount,
      lastSeq,
      lastReadSeq: Number(r.lastReadSeq),
      otherReadSeq: Number(r.otherReadSeq ?? 0),
      otherDeliveredSeq: Number(r.otherDeliveredSeq ?? 0),
      archived: r.archived,
      muted: r.muted,
      closed: !!r.closedAt,
      closedReason: r.closedReason ?? null,
      updatedAt: iso(r.sortAt),
      createdAt: iso(r.createdAt),
      // ── legacy (one release) ──
      type: r.type,
      otherUser: r.otherId
        ? {
            id: r.otherId,
            username: r.username,
            profile:
              r.firstName !== null
                ? {
                    firstName: r.firstName,
                    lastName: r.lastName,
                    profilePictureUrl: r.avatar ?? null,
                  }
                : null,
          }
        : null,
      listing: r.productId
        ? {
            productId: r.productId,
            title: r.productTitle,
            coverImageUrl: r.productImageUrl,
            priceAtStart: r.productPrice,
          }
        : null,
    };
  }

  async updateSettings(
    conversationId: string,
    userId: string,
    dto: { archived?: boolean; muted?: boolean },
  ) {
    const res = rowsOf<{ conversationId: string }>(
      await this.ds.query(
        `UPDATE "conversation_participants"
            SET "archived" = COALESCE($3, "archived"), "muted" = COALESCE($4, "muted")
          WHERE "conversationId" = $1 AND "userId" = $2 RETURNING "conversationId"`,
        [conversationId, userId, dto.archived ?? null, dto.muted ?? null],
      ),
    );
    if (!res[0]) throw notInChat();
    return this.getConversation(conversationId, userId);
  }

  /**
   * "Delete chat": for this user only. Messages so far are hidden from them
   * and the chat leaves their list until a new message arrives. The other
   * person keeps everything.
   */
  async clearConversation(conversationId: string, userId: string) {
    const res = rowsOf<{ userId: string }>(
      await this.ds.query(
        `UPDATE "conversation_participants" p
            SET "clearedSeq" = c."lastSeq", "unreadCount" = 0,
                "lastReadSeq" = GREATEST(p."lastReadSeq", c."lastSeq"),
                "lastDeliveredSeq" = GREATEST(p."lastDeliveredSeq", c."lastSeq")
           FROM "conversations" c
          WHERE c.id = $1 AND p."conversationId" = $1 AND p."userId" = $2
         RETURNING p."userId"`,
        [conversationId, userId],
      ),
    );
    if (!res[0]) throw notInChat();
    await this.emitUnread(userId, conversationId, 0);
  }

  // ─── messages ───────────────────────────────────────────────────────

  /** Participant check, receipts, block state and both public profiles in one query. */
  private async context(
    conversationId: string,
    userId: string,
  ): Promise<ConversationContext> {
    const [r] = await this.ds.query<
      Array<{
        id: string;
        lastSeq: string;
        closedAt: Date | null;
        myReadSeq: string;
        myDeliveredSeq: string;
        clearedSeq: string | null;
        otherId: string | null;
        otherReadSeq: string | null;
        otherDeliveredSeq: string | null;
        blocked: boolean;
        myUsername: string;
        myFirst: string | null;
        myLast: string | null;
        myAvatar: string | null;
        oUsername: string | null;
        oFirst: string | null;
        oLast: string | null;
        oAvatar: string | null;
      }>
    >(
      `SELECT c.id, c."lastSeq", c."closedAt",
              me."lastReadSeq" AS "myReadSeq", me."lastDeliveredSeq" AS "myDeliveredSeq", me."clearedSeq",
              o."userId" AS "otherId", o."lastReadSeq" AS "otherReadSeq", o."lastDeliveredSeq" AS "otherDeliveredSeq",
              EXISTS (SELECT 1 FROM "user_blocks" ub
                       WHERE (ub."blockerId" = $2 AND ub."blockedId" = o."userId")
                          OR (ub."blockerId" = o."userId" AND ub."blockedId" = $2)) AS blocked,
              mu.username AS "myUsername", mp."firstName" AS "myFirst", mp."lastName" AS "myLast", mp."profilePictureUrl" AS "myAvatar",
              ou.username AS "oUsername", op."firstName" AS "oFirst", op."lastName" AS "oLast", op."profilePictureUrl" AS "oAvatar"
         FROM "conversations" c
         JOIN "conversation_participants" me ON me."conversationId" = c.id AND me."userId" = $2
         LEFT JOIN "conversation_participants" o ON o."conversationId" = c.id AND o."userId" <> $2
         JOIN "users" mu ON mu.id = $2
         LEFT JOIN "user_profiles" mp ON mp."userId" = mu.id
         LEFT JOIN "users" ou ON ou.id = o."userId"
         LEFT JOIN "user_profiles" op ON op."userId" = ou.id
        WHERE c.id = $1`,
      [conversationId, userId],
    );
    if (!r) throw notInChat();
    const pub = (
      id: string,
      username: string | null,
      first: string | null,
      last: string | null,
      avatar: string | null,
    ): PublicUser => ({
      id,
      username: username ?? '',
      profile:
        first !== null
          ? {
              firstName: first,
              lastName: last ?? '',
              profilePictureUrl: avatar ?? null,
            }
          : null,
    });
    const users = new Map<string, PublicUser | null>([
      [userId, pub(userId, r.myUsername, r.myFirst, r.myLast, r.myAvatar)],
    ]);
    if (r.otherId)
      users.set(
        r.otherId,
        pub(r.otherId, r.oUsername, r.oFirst, r.oLast, r.oAvatar),
      );
    return {
      id: r.id,
      lastSeq: Number(r.lastSeq),
      closedAt: r.closedAt,
      myReadSeq: Number(r.myReadSeq),
      myDeliveredSeq: Number(r.myDeliveredSeq),
      clearedSeq: r.clearedSeq === null ? null : Number(r.clearedSeq),
      otherId: r.otherId,
      otherReadSeq: Number(r.otherReadSeq ?? 0),
      otherDeliveredSeq: Number(r.otherDeliveredSeq ?? 0),
      blocked: !!r.blocked,
      users,
    };
  }

  private viewCtx(
    ctx: ConversationContext,
    viewerId: string,
  ): MessageViewContext {
    return {
      viewerId,
      otherReadSeq: ctx.otherReadSeq,
      otherDeliveredSeq: ctx.otherDeliveredSeq,
      myReadSeq: ctx.myReadSeq,
      users: ctx.users,
    };
  }

  /**
   * History, newest last, stable by seq.
   *  - default / beforeSeq: the `limit` messages before beforeSeq (older
   *    pages: pass nextCursor as beforeSeq).
   *  - afterSeq: resume after a reconnect, the messages after afterSeq,
   *    oldest first (hasMore: call again with the last seq).
   * Loading the thread marks the viewer's received messages delivered.
   */
  async getMessages(
    conversationId: string,
    userId: string,
    f: FilterMessagesDto,
  ) {
    const limit = f.limit ?? CHAT_LIMITS.historyPageSize;
    const ctx = await this.context(conversationId, userId);
    const floor = ctx.clearedSeq ?? 0;
    const resume = f.afterSeq !== undefined;
    let rows: Array<MessageRow & { hidden: boolean }>;
    if (resume) {
      rows = await this.ds.query(
        `SELECT ${MESSAGE_COLUMNS},
                EXISTS (SELECT 1 FROM "message_hides" h WHERE h."messageId" = m.id AND h."userId" = $2) AS hidden
           FROM "messages" m
          WHERE m."conversationId" = $1 AND m.seq > GREATEST($3::bigint, $4::bigint)
          ORDER BY m.seq ASC LIMIT $5`,
        [conversationId, userId, f.afterSeq, floor, limit + 1],
      );
    } else {
      const before = f.beforeSeq ?? Number.MAX_SAFE_INTEGER;
      const offset =
        !f.beforeSeq && f.page && f.page > 1 ? (f.page - 1) * limit : 0;
      rows = await this.ds.query(
        `SELECT ${MESSAGE_COLUMNS},
                EXISTS (SELECT 1 FROM "message_hides" h WHERE h."messageId" = m.id AND h."userId" = $2) AS hidden
           FROM "messages" m
          WHERE m."conversationId" = $1 AND m.seq > $3::bigint AND m.seq < $4::bigint
          ORDER BY m.seq DESC LIMIT $5 OFFSET $6`,
        [conversationId, userId, floor, before, limit + 1, offset],
      );
    }
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    if (!resume) pageRows.reverse();

    const vctx = this.viewCtx(ctx, userId);
    await this.loadExtras(pageRows, vctx);
    const items = pageRows.map((m) => messageView(m, vctx));

    // Loading the thread counts as delivery of everything in it.
    if (ctx.myDeliveredSeq < ctx.lastSeq) {
      this.markDelivered(conversationId, userId, ctx.lastSeq).catch(
        () => undefined,
      );
    }

    const oldest = items[0]?.seq;
    const newest = items[items.length - 1]?.seq;
    return {
      items,
      hasMore,
      /** Older page: GET ...?beforeSeq=nextCursor (null when there is nothing older). */
      nextCursor: !resume && hasMore && oldest ? oldest : null,
      /** Resume page: GET ...?afterSeq=nextAfterSeq while hasMore. */
      nextAfterSeq: resume ? (newest ?? f.afterSeq ?? 0) : null,
      lastSeq: ctx.lastSeq,
      lastReadSeq: ctx.myReadSeq,
      otherReadSeq: ctx.otherReadSeq,
      otherDeliveredSeq: ctx.otherDeliveredSeq,
      // legacy (one release)
      data: items,
      limit,
      page: f.page ?? 1,
    };
  }

  /** Reply previews and legacy product cards for a page, in two batched queries at most. */
  private async loadExtras(rows: MessageRow[], vctx: MessageViewContext) {
    const replyIds = [
      ...new Set(rows.map((r) => r.replyToId).filter(Boolean)),
    ] as string[];
    const productIds = [
      ...new Set(rows.map((r) => r.productId).filter(Boolean)),
    ] as string[];
    const [replies, products]: [MessageRow[], LegacyProduct[]] =
      await Promise.all([
        replyIds.length
          ? this.ds.query<MessageRow[]>(
              `SELECT ${MESSAGE_COLUMNS} FROM "messages" m WHERE m.id = ANY($1::uuid[])`,
              [replyIds],
            )
          : Promise.resolve([] as MessageRow[]),
        productIds.length
          ? this.ds.query<LegacyProduct[]>(
              `SELECT p.id, p.title, p.price::int AS price,
                    COALESCE((SELECT json_agg(json_build_object('id', i.id, 'imageUrl', i."imageUrl", 'isPrimary', i."isPrimary")
                                              ORDER BY i."isPrimary" DESC, i."sortOrder")
                                FROM "product_images" i WHERE i."productId" = p.id), '[]') AS images
               FROM "products" p WHERE p.id = ANY($1::uuid[])`,
              [productIds],
            )
          : Promise.resolve([] as LegacyProduct[]),
      ]);
    vctx.replies = new Map(replies.map((r) => [r.id, r]));
    vctx.products = new Map(products.map((p) => [p.id, p]));
  }

  /**
   * Send a message. Needs only the conversation id and the sender: the
   * server knows the other participant. Idempotent on clientMessageId.
   * Errors: CONVERSATION_NOT_FOUND, BLOCKED, TOO_LONG, VALIDATION_FAILED,
   * RATE_LIMITED.
   */
  async sendMessage(
    conversationId: string,
    senderId: string,
    dto: SendMessageDto,
    meta: SendMeta = { via: 'http' },
  ): Promise<SendResult> {
    const started = process.hrtime.bigint();
    const requestId = meta.requestId ?? currentContext()?.requestId;
    try {
      const result = await this.doSend(conversationId, senderId, dto);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (result.created) chatMetrics.sent(ms);
      if (logRequests())
        writeJson(
          'info',
          'chat.send',
          {
            requestId,
            via: meta.via,
            user: hashUserId(senderId),
            conversationId,
            seq: result.message.seq,
            created: result.created,
            durationMs: Math.round(ms * 10) / 10,
          },
          'Chat',
        );
      return result;
    } catch (e) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const res = (e as AppError).getResponse?.() as
        | { code?: string }
        | undefined;
      const status = (e as AppError).getStatus?.() ?? 500;
      const code = res?.code ?? 'SERVER_ERROR';
      chatMetrics.sendError(code, status >= 500);
      if (status >= 500 || logRequests())
        writeJson(
          status >= 500 ? 'error' : 'warn',
          'chat.send failed',
          {
            requestId,
            via: meta.via,
            user: hashUserId(senderId),
            conversationId,
            code,
            durationMs: Math.round(ms * 10) / 10,
            ...(status >= 500 ? { error: (e as Error).message } : {}),
          },
          'Chat',
        );
      throw e;
    }
  }

  private async doSend(
    conversationId: string,
    senderId: string,
    dto: SendMessageDto,
  ): Promise<SendResult> {
    const ctx = await this.context(conversationId, senderId);
    if (ctx.blocked) throw new AppError(ErrorCode.BLOCKED);

    const textField = dto.text !== undefined ? 'text' : 'content';
    const legacyType = dto.type?.toLowerCase() as MessageType | undefined;
    if (legacyType === MessageType.SYSTEM) {
      throw new ValidationFailed({ type: 'Choose text or image.' });
    }
    if (legacyType === MessageType.FILE) {
      throw new ValidationFailed({ type: 'Only photos can be sent.' });
    }
    const raw = dto.text ?? dto.content;
    const text = typeof raw === 'string' ? raw.trim() : '';
    const urls = [
      ...(dto.attachments ?? []).map((a) => a.url),
      ...(dto.attachmentUrl ? [dto.attachmentUrl] : []),
    ];
    if (Array.from(text).length > CHAT_LIMITS.messageMaxLength) {
      const msg = `Messages can be up to ${CHAT_LIMITS.messageMaxLength} characters.`;
      throw new AppError(ErrorCode.TOO_LONG, msg, { [textField]: msg });
    }
    if (!text && !urls.length) {
      throw new ValidationFailed({ [textField]: 'Type a message.' });
    }
    if (urls.length > CHAT_LIMITS.attachmentsPerMessage) {
      throw new ValidationFailed({
        attachments: 'Send up to 4 photos at a time.',
      });
    }

    const vctx = this.viewCtx(ctx, senderId);
    if (dto.clientMessageId) {
      const existing = await this.findByClientId(
        conversationId,
        senderId,
        dto.clientMessageId,
      );
      if (existing) {
        await this.loadExtras([existing], vctx);
        return { message: messageView(existing, vctx), created: false };
      }
    }

    const limit = await this.rateLimit.consume(
      RateLimitService.key('chat-msg', senderId),
      CHAT_LIMITS.messagesPerMinute,
      60_000,
    );
    if (!limit.allowed) {
      throw rateLimited(
        "You're sending messages very fast. Please slow down.",
        limit.retryAfterSeconds,
      );
    }

    const attachments = urls.length
      ? await this.resolveAttachments(senderId, urls)
      : [];
    const flags = scanMessage(text);

    let appended;
    try {
      appended = await appendMessage(this.ds, {
        conversationId,
        senderId,
        clientMessageId: dto.clientMessageId ?? null,
        content: text,
        // Legacy clients sent type "image" with the photo URL as the text.
        type:
          attachments.length || legacyType === MessageType.IMAGE
            ? MessageType.IMAGE
            : MessageType.TEXT,
        attachments,
        replyToId: dto.replyToId ?? null,
        productId: dto.productId ?? null,
        flags,
      });
    } catch (e) {
      if (dto.clientMessageId && isUniqueViolation(e)) {
        const existing = await this.findByClientId(
          conversationId,
          senderId,
          dto.clientMessageId,
        );
        if (existing) {
          await this.loadExtras([existing], vctx);
          return { message: messageView(existing, vctx), created: false };
        }
      }
      throw e;
    }

    await this.loadExtras([appended.row], vctx);
    const message = messageView(appended.row, vctx);
    chatEvents.emit('message', {
      message,
      participants: appended.participants,
      savedAt: Date.now(),
    });
    if (flags.length) {
      this.reviewIfRepeatedSignals(senderId).catch(() => undefined);
    }
    return { message, created: true };
  }

  private async findByClientId(
    conversationId: string,
    senderId: string,
    clientMessageId: string,
  ): Promise<MessageRow | null> {
    const [row] = await this.ds.query<MessageRow[]>(
      `SELECT ${MESSAGE_COLUMNS} FROM "messages" m
        WHERE m."conversationId" = $1 AND m."senderId" = $2 AND m."clientMessageId" = $3`,
      [conversationId, senderId, clientMessageId],
    );
    return row ? { ...row, seq: Number(row.seq) } : null;
  }

  /**
   * Photos only: Cloudinary URLs in our cloud and chat folder (legacy
   * attachmentUrl may use any of our folders), uploaded and completed by the
   * sender through the signed upload (which checked JPEG/PNG/WebP and 3 MB).
   * Delivery URLs are transformed (f_auto, q_auto), which also strips
   * EXIF/GPS metadata; the stored original was already re-encoded by the
   * incoming transformation.
   */
  private async resolveAttachments(
    senderId: string,
    urls: string[],
  ): Promise<MessageAttachment[]> {
    const cloud = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const refs = urls.map((u) => parseCloudinaryUrl(u));
    const bad = () =>
      new ValidationFailed({
        attachments:
          "We couldn't attach this photo. Please choose it again (JPG, PNG or WebP, up to 3 MB).",
      });
    if (refs.some((r) => !r || r.cloudName !== cloud)) throw bad();
    const ids = refs.map((r) => r!.publicId);
    if (!ids.every((id) => id.startsWith('campussales/'))) throw bad();
    const rows = await this.ds.query<
      Array<{
        cloudinaryPublicId: string;
        version: number | null;
        width: number | null;
        height: number | null;
        mimetype: string;
      }>
    >(
      `SELECT "cloudinaryPublicId", version, width, height, mimetype FROM "uploads"
        WHERE "userId" = $1 AND "cloudinaryPublicId" = ANY($2::text[]) AND status = 'ready'`,
      [senderId, ids],
    );
    const byId = new Map(rows.map((r) => [r.cloudinaryPublicId, r]));
    return refs.map((ref, i) => {
      const up = byId.get(ref!.publicId);
      const format = (up?.mimetype ?? '').replace('image/', '');
      const okFormat = ['jpeg', 'jpg', 'png', 'webp'].includes(format);
      const isNew =
        i < urls.length && !!ref!.publicId.startsWith(UPLOAD_RULES.chatFolder);
      if (!up || !okFormat) throw bad();
      if (!isNew && !urls[i].includes('campussales/')) throw bad();
      const v = up.version ?? ref!.version;
      return {
        url: cloudinaryUrl(cloud!, ref!.publicId, v),
        thumbUrl: cloudinaryUrl(cloud!, ref!.publicId, v, { width: 400 }),
        ...(up.width ? { width: up.width } : {}),
        ...(up.height ? { height: up.height } : {}),
      };
    });
  }

  /**
   * Flags only: if one account sent flagged messages in more than 5
   * conversations in 24h, surface the account in the admin queue.
   */
  private async reviewIfRepeatedSignals(senderId: string): Promise<void> {
    const [row] = await this.ds.query<{ n: number }[]>(
      `SELECT count(DISTINCT "conversationId")::int AS n FROM "messages"
        WHERE "senderId" = $1 AND "flags" <> '[]'::jsonb
          AND "createdAt" > now() - ($2 || ' hours')::interval`,
      [senderId, String(SCAM_REVIEW_THRESHOLD.windowHours)],
    );
    if ((row?.n ?? 0) > SCAM_REVIEW_THRESHOLD.conversations) {
      await this.ds.query(
        `UPDATE "users" SET "needsReviewAt" = now(),
                "needsReviewReason" = 'Possible scam patterns in chat messages across many conversations'
          WHERE "id" = $1 AND "needsReviewAt" IS NULL`,
        [senderId],
      );
    }
  }

  /** Listing snapshot stored on the conversation (title, cover, price at the time). */
  private async listingSnapshot(productId: string) {
    const [p] = await this.ds.query<
      Array<{
        id: string;
        sellerId: string;
        title: string;
        price: number;
        cover: string | null;
      }>
    >(
      `SELECT p.id, p."sellerId", p.title, p.price::int AS price,
              (SELECT i."imageUrl" FROM "product_images" i WHERE i."productId" = p.id
                ORDER BY i."isPrimary" DESC, i."sortOrder" LIMIT 1) AS cover
         FROM "products" p WHERE p.id = $1 AND p."deletedAt" IS NULL`,
      [productId],
    );
    if (!p) throw notFound('This item is no longer available.');
    return {
      productId: p.id,
      sellerId: p.sellerId,
      productTitle: p.title,
      productImageUrl: p.cover,
      productPrice: Number(p.price),
    };
  }

  // ─── receipts and unread ────────────────────────────────────────────

  /**
   * Read receipt. Idempotent; never moves backwards. Recomputes the stored
   * unread count from the seq index (only messages after the new pointer).
   */
  async markRead(conversationId: string, userId: string, upToSeq?: number) {
    const rows = rowsOf<{
      before: string;
      lastReadSeq: string;
      unreadCount: number;
      otherId: string | null;
    }>(
      await this.ds.query(
        `WITH old AS (
           SELECT "lastReadSeq" FROM "conversation_participants" WHERE "conversationId" = $1 AND "userId" = $2
         ), target AS (
           SELECT LEAST(COALESCE($3::bigint, c."lastSeq"), c."lastSeq") AS seq FROM "conversations" c WHERE c.id = $1
         )
         UPDATE "conversation_participants" p SET
           "lastReadSeq" = GREATEST(p."lastReadSeq", target.seq),
           "lastDeliveredSeq" = GREATEST(p."lastDeliveredSeq", target.seq),
           "lastReadAt" = now(),
           "unreadCount" = (SELECT count(*)::int FROM "messages" m
                             WHERE m."conversationId" = $1 AND m."senderId" <> $2 AND m."deletedAt" IS NULL
                               AND m.seq > GREATEST(p."lastReadSeq", target.seq))
          FROM target, old
         WHERE p."conversationId" = $1 AND p."userId" = $2
        RETURNING old."lastReadSeq" AS before, p."lastReadSeq", p."unreadCount",
                  (SELECT o."userId" FROM "conversation_participants" o
                    WHERE o."conversationId" = $1 AND o."userId" <> $2 LIMIT 1) AS "otherId"`,
        [conversationId, userId, upToSeq ?? null],
      ),
    );
    const r = rows[0];
    if (!r) throw notInChat();
    const lastReadSeq = Number(r.lastReadSeq);
    if (lastReadSeq > Number(r.before) && r.otherId) {
      chatEvents.emit('status', {
        conversationId,
        toUserId: r.otherId,
        byUserId: userId,
        upToSeq: lastReadSeq,
        status: 'read',
      });
    }
    const totalUnread = await this.emitUnread(
      userId,
      conversationId,
      r.unreadCount,
    );
    return {
      conversationId,
      lastReadSeq,
      unreadCount: r.unreadCount,
      totalUnread,
    };
  }

  /** Delivery receipt (socket ack or thread load). Idempotent; never moves backwards. */
  async markDelivered(
    conversationId: string,
    userId: string,
    upToSeq: number,
  ): Promise<boolean> {
    const rows = rowsOf<{ lastDeliveredSeq: string; otherId: string | null }>(
      await this.ds.query(
        `UPDATE "conversation_participants" p
            SET "lastDeliveredSeq" = LEAST($3::bigint, c."lastSeq")
           FROM "conversations" c
          WHERE c.id = $1 AND p."conversationId" = $1 AND p."userId" = $2
            AND p."lastDeliveredSeq" < LEAST($3::bigint, c."lastSeq")
         RETURNING p."lastDeliveredSeq",
                   (SELECT o."userId" FROM "conversation_participants" o
                     WHERE o."conversationId" = $1 AND o."userId" <> $2 LIMIT 1) AS "otherId"`,
        [conversationId, userId, upToSeq],
      ),
    );
    const r = rows[0];
    if (!r) return false;
    if (r.otherId) {
      chatEvents.emit('status', {
        conversationId,
        toUserId: r.otherId,
        byUserId: userId,
        upToSeq: Number(r.lastDeliveredSeq),
        status: 'delivered',
      });
    }
    return true;
  }

  /** Pushes unread:update to the user's devices; returns the new total. */
  async emitUnread(
    userId: string,
    conversationId: string,
    unreadCount: number,
  ): Promise<number> {
    const total = await this.getTotalUnreadCount(userId);
    chatEvents.emit('unread', { userId, conversationId, unreadCount, total });
    return total;
  }

  /**
   * Unread across the user's visible chats: a sum over the stored counters
   * (no message scan). Chats with blocked users don't count.
   */
  async getUnread(userId: string) {
    const [row] = await this.ds.query<
      Array<{
        total: number;
        conversations: Array<{
          conversationId: string;
          unreadCount: number;
        }> | null;
      }>
    >(
      `SELECT COALESCE(sum(cp."unreadCount"), 0)::int AS total,
              json_agg(json_build_object('conversationId', cp."conversationId", 'unreadCount', cp."unreadCount")
                       ORDER BY cp."lastMessageAt" DESC) AS conversations
         FROM "conversation_participants" cp
        WHERE cp."userId" = $1 AND cp."unreadCount" > 0
          AND NOT EXISTS (SELECT 1 FROM "conversation_participants" o
                            JOIN "user_blocks" ub ON (ub."blockerId" = $1 AND ub."blockedId" = o."userId")
                                                  OR (ub."blockedId" = $1 AND ub."blockerId" = o."userId")
                           WHERE o."conversationId" = cp."conversationId" AND o."userId" <> $1)`,
      [userId],
    );
    return { total: row?.total ?? 0, conversations: row?.conversations ?? [] };
  }

  async getTotalUnreadCount(userId: string): Promise<number> {
    return (await this.getUnread(userId)).total;
  }

  // ─── deletes ────────────────────────────────────────────────────────

  /**
   * "me": hide one message for this user only (any message).
   * "everyone": the sender's own message within 10 minutes; everyone then
   * sees "Message deleted". Nothing is hard-deleted (kept for reports and
   * the retention period, see docs/chat.md).
   */
  async deleteMessage(
    conversationId: string,
    messageId: string,
    userId: string,
    scope: 'me' | 'everyone' = 'me',
  ): Promise<MessageView> {
    const ctx = await this.context(conversationId, userId);
    const [m] = await this.ds.query<MessageRow[]>(
      `SELECT ${MESSAGE_COLUMNS} FROM "messages" m WHERE m.id = $1 AND m."conversationId" = $2`,
      [messageId, conversationId],
    );
    if (!m) throw notFound("We couldn't find that message.");
    const vctx = this.viewCtx(ctx, userId);

    if (scope === 'me') {
      await this.ds.query(
        `INSERT INTO "message_hides" ("userId", "messageId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, messageId],
      );
      return messageView({ ...m, hidden: true }, vctx);
    }

    if (m.senderId !== userId || m.type === MessageType.SYSTEM) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'You can only delete your own messages for everyone.',
      );
    }
    if (m.deletedAt) return messageView(m, vctx);
    const rows = rowsOf<MessageRow>(
      await this.ds.query(
        `UPDATE "messages" m SET "deletedAt" = now()
          WHERE m.id = $1 AND m."deletedAt" IS NULL
            AND m."createdAt" > now() - ($2 || ' milliseconds')::interval
         RETURNING ${MESSAGE_COLUMNS}`,
        [messageId, String(CHAT_LIMITS.deleteForEveryoneMs)],
      ),
    );
    if (!rows[0]) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Messages can be deleted for everyone within 10 minutes of sending.',
      );
    }
    const view = messageView(rows[0], vctx);
    // It no longer counts as unread for the other person.
    const dec = rowsOf<{ userId: string; unreadCount: number }>(
      await this.ds.query(
        `UPDATE "conversation_participants" SET "unreadCount" = GREATEST("unreadCount" - 1, 0)
          WHERE "conversationId" = $1 AND "userId" <> $2 AND "lastReadSeq" < $3 AND "unreadCount" > 0
         RETURNING "userId", "unreadCount"`,
        [conversationId, userId, m.seq],
      ),
    );
    chatEvents.emit('message-updated', {
      userIds: [userId, ...(ctx.otherId ? [ctx.otherId] : [])],
      message: messageView(rows[0]),
    });
    for (const d of dec) {
      this.emitUnread(d.userId, conversationId, d.unreadCount).catch(
        () => undefined,
      );
    }
    return view;
  }

  async searchMessages(
    conversationId: string,
    userId: string,
    searchTerm: string,
    page = 1,
    limit = 20,
  ) {
    const ctx = await this.context(conversationId, userId);
    const term = `%${searchTerm.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.ds.query<MessageRow[]>(
      `SELECT ${MESSAGE_COLUMNS} FROM "messages" m
        WHERE m."conversationId" = $1 AND m.seq > $2::bigint AND m."deletedAt" IS NULL
          AND m.content ILIKE $3
          AND NOT EXISTS (SELECT 1 FROM "message_hides" h WHERE h."messageId" = m.id AND h."userId" = $4)
        ORDER BY m.seq DESC LIMIT $5 OFFSET $6`,
      [
        conversationId,
        ctx.clearedSeq ?? 0,
        term,
        userId,
        limit,
        (page - 1) * limit,
      ],
    );
    const vctx = this.viewCtx(ctx, userId);
    rows.reverse();
    await this.loadExtras(rows, vctx);
    const data = rows.map((m) => messageView(m, vctx));
    return { items: data, data, page, limit };
  }

  // ─── presence settings ──────────────────────────────────────────────

  async getSettings(userId: string) {
    const [r] = await this.ds.query<Array<{ v: boolean }>>(
      `SELECT "chatPresenceVisible" AS v FROM "users" WHERE id = $1`,
      [userId],
    );
    return { showPresence: r?.v ?? true };
  }

  async updateChatSettings(userId: string, showPresence?: boolean) {
    if (showPresence !== undefined) {
      await this.ds.query(
        `UPDATE "users" SET "chatPresenceVisible" = $2 WHERE id = $1`,
        [userId, showPresence],
      );
    }
    return this.getSettings(userId);
  }

  /** Whether `viewerId` may see `userId`'s presence: they share a chat, aren't blocked, and it's allowed. */
  async presenceVisibleTo(
    viewerId: string,
    userIds: string[],
  ): Promise<Array<{ userId: string; lastActiveAt: string | null }>> {
    if (!userIds.length) return [];
    const rows = await this.ds.query<
      Array<{ id: string; lastActiveAt: Date | null }>
    >(
      `SELECT u.id, u."lastActiveAt" FROM "users" u
        WHERE u.id = ANY($2::uuid[]) AND u."chatPresenceVisible" = true
          AND EXISTS (SELECT 1 FROM "conversation_participants" a
                        JOIN "conversation_participants" b ON b."conversationId" = a."conversationId"
                       WHERE a."userId" = $1 AND b."userId" = u.id)
          AND NOT EXISTS (SELECT 1 FROM "user_blocks" ub
                           WHERE (ub."blockerId" = $1 AND ub."blockedId" = u.id)
                              OR (ub."blockerId" = u.id AND ub."blockedId" = $1))`,
      [viewerId, userIds],
    );
    return rows.map((r) => ({
      userId: r.id,
      lastActiveAt: iso(r.lastActiveAt),
    }));
  }

  /** The other participant of a conversation, if `userId` is in it and not blocked (for typing). */
  async peerFor(
    conversationId: string,
    userId: string,
  ): Promise<string | null> {
    const [r] = await this.ds.query<
      Array<{ otherId: string; blocked: boolean }>
    >(
      `SELECT o."userId" AS "otherId",
              EXISTS (SELECT 1 FROM "user_blocks" ub
                       WHERE (ub."blockerId" = $2 AND ub."blockedId" = o."userId")
                          OR (ub."blockerId" = o."userId" AND ub."blockedId" = $2)) AS blocked
         FROM "conversation_participants" me
         JOIN "conversation_participants" o ON o."conversationId" = me."conversationId" AND o."userId" <> $2
        WHERE me."conversationId" = $1 AND me."userId" = $2`,
      [conversationId, userId],
    );
    return r && !r.blocked ? r.otherId : null;
  }

  async touchLastActive(userId: string): Promise<void> {
    await this.ds.query(
      `UPDATE "users" SET "lastActiveAt" = now() WHERE id = $1`,
      [userId],
    );
  }

  private async notifyNewConversation(
    initiatorId: string,
    recipientId: string,
    conversationId: string,
  ): Promise<void> {
    const [u] = await this.ds.query<Array<{ name: string | null }>>(
      `SELECT COALESCE(p."firstName", u.username) AS name FROM "users" u
         LEFT JOIN "user_profiles" p ON p."userId" = u.id WHERE u.id = $1`,
      [initiatorId],
    );
    await this.notificationsService.notifyNewConversation(
      recipientId,
      u?.name || 'Someone',
      conversationId,
    );
  }

  /** A fresh id for socket requests (HTTP requests already have one). */
  static requestId(): string {
    return randomUUID();
  }
}

export type ConversationItem = ReturnType<ChatService['listItem']>;

function decodeCursor(c: string): { t: string; i: string } | null {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString()) as {
      t?: unknown;
      i?: unknown;
    };
    if (
      typeof v.t === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$/.test(v.t) &&
      typeof v.i === 'string' &&
      /^[0-9a-f-]{36}$/i.test(v.i)
    )
      return { t: v.t, i: v.i };
  } catch {
    // fall through
  }
  throw new ValidationFailed({
    cursor: 'This page link has expired. Reload the list.',
  });
}

/** One row per conversation for viewer $1, everything the list needs. */
const LIST_SELECT = `
  SELECT c.id, c.type, c."productId", c."productTitle", c."productImageUrl", c."productPrice",
         c."closedAt", c."closedReason", c."createdAt", c."lastSeq",
         me."unreadCount", me."archived", me."muted", me."lastMessageAt" AS "sortAt",
         to_char(me."lastMessageAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "sortKey",
         me."lastReadSeq",
         o."userId" AS "otherId", o."lastReadSeq" AS "otherReadSeq", o."lastDeliveredSeq" AS "otherDeliveredSeq",
         u.username, pr."firstName", pr."lastName", pr."profilePictureUrl" AS avatar,
         u."lastActiveAt", u."chatPresenceVisible" AS "presenceVisible",
         p.title AS "pTitle", p.price::int AS "pPrice", p.status AS "pStatus", p."deletedAt" AS "pDeletedAt",
         (p.id IS NOT NULL) AS "pExists",
         lm.id AS "lmId", lm.seq AS "lmSeq", lm.content AS "lmContent", lm.type AS "lmType",
         lm."senderId" AS "lmSenderId", lm."createdAt" AS "lmCreatedAt", lm."deletedAt" AS "lmDeletedAt",
         lm.attachments AS "lmAttachments"
    FROM "conversation_participants" me
    JOIN "conversations" c ON c.id = me."conversationId"
    LEFT JOIN "conversation_participants" o ON o."conversationId" = c.id AND o."userId" <> me."userId"
    LEFT JOIN "users" u ON u.id = o."userId"
    LEFT JOIN "user_profiles" pr ON pr."userId" = u.id
    LEFT JOIN "products" p ON p.id = c."productId"
    LEFT JOIN LATERAL (
      SELECT m.id, m.seq, m.content, m.type, m."senderId", m."createdAt", m."deletedAt", m.attachments
        FROM "messages" m
       WHERE m."conversationId" = c.id AND m.seq > COALESCE(me."clearedSeq", 0)
         AND NOT EXISTS (SELECT 1 FROM "message_hides" h WHERE h."messageId" = m.id AND h."userId" = me."userId")
       ORDER BY m.seq DESC LIMIT 1
    ) lm ON true
  `;

/** Chats with blocked users (either direction) are hidden from the list. */
const NOT_BLOCKED = `NOT EXISTS (SELECT 1 FROM "user_blocks" ub
   WHERE (ub."blockerId" = me."userId" AND ub."blockedId" = o."userId")
      OR (ub."blockedId" = me."userId" AND ub."blockerId" = o."userId"))`;
