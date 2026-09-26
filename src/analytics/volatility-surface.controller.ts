// src/analytics/volatility-surface.controller.ts
import { Controller, Get } from '@nestjs/common';
import { VolatilitySurfaceService, VolatilitySurfaceMatrix } from './volatility-surface.service';

@Controller('api/v1/analytics')
export class VolatilitySurfaceController {
    constructor(private readonly volatilitySurfaceService: VolatilitySurfaceService) {}

    @Get('volatility-surface')
    async getVolatilitySurface(): Promise<VolatilitySurfaceMatrix[]> {
        return this.volatilitySurfaceService.getVolatilitySurface();
    }
}