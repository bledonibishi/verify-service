import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateSessionDto {
  /** The calling system's own identifier for the user being verified. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  externalRef: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  /** ISO date, YYYY-MM-DD. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'birthDate must be YYYY-MM-DD' })
  birthDate?: string;
}
