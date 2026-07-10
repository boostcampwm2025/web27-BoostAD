import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class QualityCampaignDto {
  @IsString()
  @MaxLength(100)
  campaignKey: string;

  @IsString()
  @MaxLength(255)
  title: string;

  @IsString()
  @MaxLength(2_000)
  content: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags: string[];
}

export class LoadQualityCampaignsDto {
  @IsString()
  @MaxLength(100)
  datasetVersion: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => QualityCampaignDto)
  campaigns: QualityCampaignDto[];
}

export class QualityContentDto {
  @IsString()
  @MaxLength(100)
  contentId: string;

  @IsString()
  @MaxLength(500)
  title: string;

  @IsString()
  @MaxLength(8_000)
  body: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  tags: string[];
}

export class ExtractQualityRankingsDto {
  @IsString()
  @MaxLength(100)
  sessionId: string;

  @IsString()
  @MaxLength(100)
  datasetVersion: string;

  @IsOptional()
  @IsIn(['dense_only'])
  retrievalMode?: 'dense_only';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  topK?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => QualityContentDto)
  contents: QualityContentDto[];
}

export class RestoreQualityCampaignsDto {
  @IsString()
  @MaxLength(100)
  sessionId: string;
}
