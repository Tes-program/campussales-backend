import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
} from 'typeorm';

export class AddUsernameToUsers1695000000013 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add column as nullable first (existing rows have no username)
    await queryRunner.addColumn(
      'users',
      new TableColumn({
        name: 'username',
        type: 'varchar',
        isNullable: true,
      }),
    );

    // 2. Backfill existing rows: use the part before '@' in email as username
    await queryRunner.query(`
      UPDATE "users"
      SET "username" = CONCAT(
        SPLIT_PART("email", '@', 1),
        '_',
        LEFT("id"::text, 8)
      )
      WHERE "username" IS NULL
    `);

    // 3. Set column to NOT NULL now that all rows have a value
    await queryRunner.changeColumn(
      'users',
      'username',
      new TableColumn({
        name: 'username',
        type: 'varchar',
        isNullable: false,
        isUnique: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('users', 'username');
  }
}
