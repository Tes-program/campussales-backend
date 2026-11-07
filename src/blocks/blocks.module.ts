import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { BlocksController } from './blocks.controller';
import { BlocksService } from './blocks.service';
import { UserBlock } from './user-block.entity';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([UserBlock, User])],
  controllers: [BlocksController],
  providers: [BlocksService],
  exports: [BlocksService],
})
export class BlocksModule {}
