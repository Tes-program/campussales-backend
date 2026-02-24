import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AlterUserProfiles1695000000014 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the 'department' column (not in entity)
    await queryRunner.dropColumn('user_profiles', 'department');

    // Add 'gender' enum column
    await queryRunner.addColumn(
      'user_profiles',
      new TableColumn({
        name: 'gender',
        type: 'enum',
        enum: ['Male', 'Female'],
        isNullable: true,
      }),
    );

    // Add 'universityName' column
    await queryRunner.addColumn(
      'user_profiles',
      new TableColumn({
        name: 'universityName',
        type: 'varchar',
        isNullable: true,
      }),
    );

    // Add 'interest' column (used as simple-array in entity)
    await queryRunner.addColumn(
      'user_profiles',
      new TableColumn({
        name: 'interest',
        type: 'text',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('user_profiles', 'interest');
    await queryRunner.dropColumn('user_profiles', 'universityName');
    await queryRunner.dropColumn('user_profiles', 'gender');

    // Re-add 'department' column
    await queryRunner.addColumn(
      'user_profiles',
      new TableColumn({
        name: 'department',
        type: 'varchar',
        isNullable: true,
      }),
    );
  }
}
