import { Expose } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class ContextObserveDto {
  @Expose()
  @IsString()
  blogKey: string;

  @Expose()
  @IsString()
  postUrl: string;

  @Expose()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @Expose()
  @IsOptional()
  @IsString()
  @MaxLength(50_000)
  body?: string;

  @Expose()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  tags: string[];
}
