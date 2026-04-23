import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveStudentLevelFromUserProfiles1773071112613
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('user_profiles', 'studentLevel');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_profiles" ADD COLUMN "studentLevel" character varying`,
    );
  }
}
