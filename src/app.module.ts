import { Module } from '@nestjs/common';
import { ShopifyReviewsController } from './shopify-reviews.controller';

@Module({ controllers: [ShopifyReviewsController] })
export class AppModule {}
