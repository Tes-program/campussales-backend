import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { defaultUniversities } from '../../universities/seeds/universities.seed';
import { UniversitiesService } from '../../universities/universities.service';

async function seedUniversities() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const universitiesService = app.get(UniversitiesService);

  console.log('🌱 Seeding universities...');
  try {
    const createdUniversities =
      await universitiesService.createMany(defaultUniversities);

    console.log(
      `✅ Successfully created ${createdUniversities.length} universities`,
    );
  } catch (error) {
    console.error('❌ Error seeding universities:', error.message);
  }

  await app.close();
}

seedUniversities().catch((error) => {
  console.error('Failed to seed universities:', error);
  process.exit(1);
});
