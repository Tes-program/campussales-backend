import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import type { Response } from 'express';
import { Repository } from 'typeorm';
import { frontendUrl } from '../auth/auth.config';
import { ProductStatus } from '../common/constants/listing';
import { Product } from '../products/entities/product.entity';
import { excerpt, orderedImages } from '../products/product-card';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

export const formatNaira = (n: number) =>
  `₦${Math.round(n).toLocaleString('en-NG')}`;

/**
 * Link previews for WhatsApp, X, Facebook, iMessage… Share links point here
 * (https://<api-host>/share/item/:id). Bots read the Open Graph tags; people
 * are redirected to the real page ({FRONTEND_URL}/item/:id). See docs/api.md
 * "Share previews" for routing options.
 */
@ApiExcludeController()
@Controller('share')
export class ShareController {
  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  landing() {
    const home = frontendUrl(this.config);
    return page({
      title: 'CampusSales: buy and sell on campus',
      description:
        'Textbooks, gadgets, furniture and more from students at your school.',
      url: `${home}/`,
      redirect: `${home}/`,
    });
  }

  @Get('item/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async item(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const home = frontendUrl(this.config);
    const p = isUUID(id)
      ? await this.products.findOne({ where: { id }, relations: ['images'] })
      : null;
    if (!p || p.status === ProductStatus.NEEDS_REVIEW) {
      res.status(404).setHeader('Cache-Control', 'public, max-age=60');
      return page({
        title: 'This item is no longer available | CampusSales',
        description: 'Browse other items from students on CampusSales.',
        url: `${home}/`,
        redirect: `${home}/`,
      });
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    const price = formatNaira(Number(p.price));
    const sold = p.status === ProductStatus.SOLD ? ' (sold)' : '';
    const url = `${home}/item/${p.id}`;
    return page({
      title: `${p.title}: ${price}${sold} | CampusSales`,
      description:
        excerpt(p.description) || `${p.title} for ${price} on CampusSales.`,
      url,
      redirect: url,
      image: orderedImages(p.images)[0]?.imageUrl,
      price: Number(p.price),
    });
  }
}

function page(o: {
  title: string;
  description: string;
  url: string;
  redirect: string;
  image?: string;
  price?: number;
}): string {
  const t = esc(o.title);
  const d = esc(o.description);
  const u = esc(o.url);
  const img = o.image ? esc(o.image) : '';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${u}">
<meta property="og:site_name" content="CampusSales">
<meta property="og:type" content="${o.price !== undefined ? 'product' : 'website'}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">
${img ? `<meta property="og:image" content="${img}">\n<meta name="twitter:image" content="${img}">` : ''}
${o.price !== undefined ? `<meta property="product:price:amount" content="${o.price}">\n<meta property="product:price:currency" content="NGN">` : ''}
<meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta http-equiv="refresh" content="0;url=${esc(o.redirect)}">
</head><body>
<p><a href="${esc(o.redirect)}">Continue to CampusSales</a></p>
<script>location.replace(${JSON.stringify(o.redirect).replace(/</g, '\\u003c')});</script>
</body></html>`;
}
