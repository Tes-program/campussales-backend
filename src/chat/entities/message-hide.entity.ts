import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** "Delete for me": the message stays for the other participant. */
@Entity('message_hides')
export class MessageHide {
  @PrimaryColumn('uuid')
  userId: string;

  @PrimaryColumn('uuid')
  messageId: string;

  @CreateDateColumn()
  createdAt: Date;
}
