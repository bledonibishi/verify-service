import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MaxLength(254)
  email: string;

  @IsString()
  @MaxLength(256)
  password: string;
}

export class DecisionDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  /** Required when rejecting: the tenant is told why. */
  // Validated after trimming, so padding can't satisfy the length rule; blank counts as absent
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}
