import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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

  /**
   * Also require a driving licence: it is read and cross-checked (personal number, name, date of
   * birth) against the ID card. Needs ID_BACK, LICENCE_FRONT and, optionally, LICENCE_BACK.
   */
  @IsOptional()
  @IsBoolean()
  requireDrivingLicence?: boolean;
}
