import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleStrategy } from './google.strategy';
import { SessionAuthGuard } from './session-auth.guard';

@Module({
  imports: [PassportModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, GoogleStrategy, SessionAuthGuard],
  exports: [AuthService, SessionAuthGuard],
})
export class AuthModule {}
