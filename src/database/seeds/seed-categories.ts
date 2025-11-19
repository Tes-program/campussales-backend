// src/database/seeds/seed-categories.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { CategoriesService } from '../../categories/categories.service';
import { defaultCategories } from '../../categories/seeds/categories.seed';

async function seedCategories() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const categoriesService = app.get(CategoriesService);

  console.log('🌱 Seeding categories...');

  try {
    const createdCategories =
      await categoriesService.bulkCreate(defaultCategories);
    console.log(
      `✅ Successfully created ${createdCategories.length} categories`,
    );

    const allCategories = await categoriesService.findAll(true);
    console.log(`📊 Total categories in database: ${allCategories.length}`);

    allCategories.forEach((cat) => {
      console.log(`   - ${cat.name} (${cat.slug})`);
    });
  } catch (error) {
    console.error('❌ Error seeding categories:', error.message);
  }

  await app.close();
}

seedCategories();
