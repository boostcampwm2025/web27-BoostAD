import { Expose } from 'class-transformer';
import {
  IsString,
  IsArray,
  IsNumber,
  IsOptional,
  IsBoolean,
  Matches,
  // ValidateNested,
  // Min,
  // Max,
} from 'class-validator';

// export class BehaviorDataDto {
//   @Expose()
//   @IsOptional()
//   @IsNumber()
//   @Min(0)
//   dwellTime?: number;

//   @Expose()
//   @IsOptional()
//   @IsNumber()
//   @Min(0)
//   @Max(100)
//   scrollDepth?: number;

//   @Expose()
//   @IsOptional()
//   @IsNumber()
//   @Min(0)
//   copyCount?: number;
// }

export class RTBRequestDto {
  @Expose()
  @IsString()
  blogKey: string;

  @Expose()
  @IsString()
  postUrl: string;

  @Expose()
  @IsArray()
  @IsString({ each: true })
  tags: string[];

  @Expose()
  @IsOptional()
  @IsString()
  @Matches(/^ctx_[a-f0-9]{64}$/)
  contextId?: string;

  // 행동 데이터는 제외 -> 주석은 추후 리팩토링 시, 참고용으로 남겨둠
  // @Expose()
  // @ValidateNested()
  // @Type(() => BehaviorDataDto)
  // @IsOptional() // 표에서 Nullable이 Y
  // behaviorData?: BehaviorDataDto;

  @Expose()
  @IsOptional()
  @IsNumber()
  behaviorScore: number;

  @Expose()
  @IsOptional()
  @IsBoolean()
  isHighIntent: boolean;
}
