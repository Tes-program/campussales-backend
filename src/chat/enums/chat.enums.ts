export enum MessageType {
  TEXT = 'text',
  IMAGE = 'image',
  FILE = 'file',
  /** Server-generated (e.g. "This item has been sold"). Clients can't send it. */
  SYSTEM = 'system',
}

export enum MessageStatus {
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
}

export enum ConversationType {
  DIRECT = 'direct',
  PRODUCT_INQUIRY = 'product_inquiry',
}
