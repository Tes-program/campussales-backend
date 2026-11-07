// Optional overrides for POST /api/products/drafts/:id/publish. The merged
// draft is then validated against CreateProductDto in the service.
import { UpdateProductDto } from './update-product.dto';

export class PublishDraftDto extends UpdateProductDto {}
