import { ApiProperty } from '@nestjs/swagger';

export class UploadResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  filename: string;

  @ApiProperty()
  url: string;

  @ApiProperty()
  size: number;

  @ApiProperty()
  mimetype: string;
}

export class MultipleUploadResponseDto {
  @ApiProperty({ type: [UploadResponseDto] })
  files: UploadResponseDto[];

  @ApiProperty()
  message: string;
}
