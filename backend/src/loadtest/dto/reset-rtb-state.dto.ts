import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class ResetRtbStateDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  campaignIds?: string[];

  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @IsOptional()
  @IsBoolean()
  clearLogs?: boolean;

  @IsOptional()
  @IsBoolean()
  clearAuxRedisKeys?: boolean;

  @IsOptional()
  @IsBoolean()
  drainBidlogQueue?: boolean;
}
