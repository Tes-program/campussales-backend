import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/entities/product.entity';
import { ShareController } from './share.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Product])],
  controllers: [ShareController],
})
export class ShareModule {}
