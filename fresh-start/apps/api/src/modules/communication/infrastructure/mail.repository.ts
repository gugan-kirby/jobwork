import { Injectable } from '@nestjs/common';
import type { MailMessage, RecordMailRequest } from '@jobwork/contracts';
import { DatabaseService } from '../../../platform/database/database.service';

interface MailRow {
  id: string;
  delivery_id: string;
  recipient: string;
  subject: string;
  body: string;
  created_at: Date;
}

/** `communication.mail_message`: mail kept instead of sent (F-CW.5, ADR-0009). */
@Injectable()
export class MailRepository {
  constructor(private readonly db: DatabaseService) {}

  /** One row per delivery: a worker retry after a lost reply is not a second message. */
  async record(mail: RecordMailRequest): Promise<'recorded' | 'already_recorded'> {
    const inserted = await this.db.pool.query(
      `INSERT INTO communication.mail_message (delivery_id, recipient, subject, body)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING id`,
      [mail.deliveryId, mail.to, mail.subject, mail.text],
    );
    return inserted.rowCount === 1 ? 'recorded' : 'already_recorded';
  }

  async latest(limit: number): Promise<MailMessage[]> {
    const rows = await this.db.pool.query<MailRow>(
      `SELECT id, delivery_id, recipient, subject, body, created_at
         FROM communication.mail_message
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [limit],
    );
    return rows.rows.map((r) => ({
      id: r.id,
      deliveryId: r.delivery_id,
      to: r.recipient,
      subject: r.subject,
      text: r.body,
      createdAt: r.created_at.toISOString(),
    }));
  }
}
