import { Body, Controller, ForbiddenException, Get, Post, Query } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Shopify App Proxy backend (verified purchase reviews, per-order, with photos).
 * ENV: SHOP_DOMAIN (xyz.myshopify.com), SHOPIFY_CLIENT_ID, SHOPIFY_API_SECRET (= app Client secret),
 *      AUTO_APPROVE=true|false, MODERATE_IMAGES=true|false (true => photo wale review pehle pending), DEBUG=true|false
 * Scopes: read_orders, read_customers, read_products, read_metaobjects, write_metaobjects, write_files, write_app_proxy
 * Metaobject "product_reviews" fields: product, customer_id, author_name, rating, body, approved, order_id, images(list of files),
 *   review_date (Date)
 */
type Item = { orderId: string; orderName: string; productId: string; title: string };
type State = { purchased: Set<string>; delivered: Map<string, Item>; reviewed: Set<string>; name: string };

const MAX_IMAGES = 3;
const MAX_IMG_BYTES = 1_500_000;

@Controller('proxy/reviews')
export class ShopifyReviewsController {
  private readonly api = `https://${process.env.SHOP_DOMAIN}/admin/api/2025-07/graphql.json`;

  // ---------- Shopify signature check ----------
  private verify(q: Record<string, any>) {
    const { signature, ...rest } = q;
    if (!signature) throw new ForbiddenException('Bad signature');
    const msg = Object.keys(rest)
      .sort()
      .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
      .join('');
    const hash = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET!).update(msg).digest('hex');
    const a = Buffer.from(hash);
    const b = Buffer.from(String(signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new ForbiddenException('Bad signature');
    return rest.logged_in_customer_id ? String(rest.logged_in_customer_id) : null;
  }

  // ---------- Admin API token (client credentials, 24h) ----------
  private token = '';
  private tokenExp = 0;

  private async getToken() {
    if (this.token && Date.now() < this.tokenExp) return this.token;
    const res = await fetch(`https://${process.env.SHOP_DOMAIN}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SHOPIFY_CLIENT_ID!,
        client_secret: process.env.SHOPIFY_API_SECRET!,
      }),
    });
    const j: any = await res.json();
    if (!j.access_token) throw new Error('Token error: ' + JSON.stringify(j));
    this.token = j.access_token;
    this.tokenExp = Date.now() + 23 * 60 * 60 * 1000;
    return this.token;
  }

  private async gql(query: string, variables: any) {
    const res = await fetch(this.api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await this.getToken() },
      body: JSON.stringify({ query, variables }),
    });
    const json: any = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
  }

  // ---------- Customer ke purchased / delivered / reviewed ----------
  private async state(customerId: string): Promise<State> {
    const d = await this.gql(
      `query($q:String!,$c:ID!,$m:String!){
        customer(id:$c){ firstName lastName }
        orders(first:100, query:$q, sortKey:CREATED_AT, reverse:true){ nodes{
          id name cancelledAt
          lineItems(first:100){ nodes{ product{ id title } } }
          fulfillments{ displayStatus fulfillmentLineItems(first:100){ nodes{ lineItem{ product{ id title } } } } }
        } }
        metaobjects(type:"product_reviews", first:250, query:$m){ nodes{ fields{ key value } } }
      }`,
      { q: `customer_id:${customerId}`, c: `gid://shopify/Customer/${customerId}`, m: `fields.customer_id:${customerId}` },
    );

    const purchased = new Set<string>();
    const delivered = new Map<string, Item>(); // key: orderId|productId
    for (const o of d.orders.nodes) {
      if (o.cancelledAt) continue;
      for (const li of o.lineItems.nodes) if (li.product) purchased.add(li.product.id);
      for (const f of o.fulfillments || []) {
        if (f.displayStatus !== 'DELIVERED') continue;
        for (const fli of f.fulfillmentLineItems.nodes) {
          const p = fli.lineItem?.product;
          if (p) delivered.set(`${o.id}|${p.id}`, { orderId: o.id, orderName: o.name, productId: p.id, title: p.title });
        }
      }
    }
    const reviewed = new Set<string>();
    for (const m of d.metaobjects.nodes) {
      const f = (k: string) => m.fields.find((x: any) => x.key === k)?.value;
      if (f('product')) reviewed.add(`${f('order_id') || ''}|${f('product')}`);
    }
    const c = d.customer;
    const name = c ? `${c.firstName || 'Customer'} ${c.lastName ? c.lastName[0] + '.' : ''}`.trim() : 'Customer';
    return { purchased, delivered, reviewed, name };
  }

  private decide(s: State, productGid?: string) {
    const all = [...s.delivered.values()];
    const open = all.filter((i) => !s.reviewed.has(`${i.orderId}|${i.productId}`) && (!productGid || i.productId === productGid));
    if (open.length) return { status: 'ok', name: s.name, items: open };
    if (productGid) {
      if (!s.purchased.has(productGid)) return { status: 'no_purchase' };
      if (!all.some((i) => i.productId === productGid)) return { status: 'not_delivered' };
      return { status: 'reviewed' };
    }
    if (all.length) return { status: 'reviewed' };
    if (s.purchased.size) return { status: 'not_delivered' };
    return { status: 'no_purchase' };
  }

  // ---------- Photo -> Shopify Files ----------
  private async uploadImage(b64: string, idx: number): Promise<string> {
    const buf = Buffer.from(String(b64), 'base64');
    if (buf.length < 100 || buf.length > MAX_IMG_BYTES) throw new Error('Photo is too large (max ~1.5MB).');
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw new Error('Invalid photo format.');
    const filename = `review-${Date.now()}-${idx}.jpg`;

    const st = await this.gql(
      `mutation($i:[StagedUploadInput!]!){ stagedUploadsCreate(input:$i){ stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ message } } }`,
      { i: [{ filename, mimeType: 'image/jpeg', httpMethod: 'POST', resource: 'IMAGE' }] },
    );
    const target = st.stagedUploadsCreate.stagedTargets?.[0];
    if (!target) throw new Error(st.stagedUploadsCreate.userErrors?.[0]?.message || 'Upload target error');

    const form = new FormData();
    for (const p of target.parameters) form.append(p.name, p.value);
    form.append('file', new Blob([buf], { type: 'image/jpeg' }), filename);
    const up = await fetch(target.url, { method: 'POST', body: form });
    if (!up.ok) throw new Error('Photo upload failed (' + up.status + ')');

    const fc = await this.gql(
      `mutation($f:[FileCreateInput!]!){ fileCreate(files:$f){ files{ id } userErrors{ message } } }`,
      { f: [{ originalSource: target.resourceUrl, contentType: 'IMAGE', alt: 'Customer review photo' }] },
    );
    const id = fc.fileCreate.files?.[0]?.id;
    if (!id) throw new Error(fc.fileCreate.userErrors?.[0]?.message || 'File create error');
    return id;
  }

  // ---------- Endpoints ----------
  @Get('eligibility')
  async eligibility(@Query() q: any) {
    const customerId = this.verify(q);
    if (!customerId) return { status: 'login' };
    try {
      const s = await this.state(customerId);
      const gid = q.product_id ? `gid://shopify/Product/${q.product_id}` : undefined;
      return this.decide(s, gid);
    } catch (e: any) {
      console.error('eligibility error:', e?.message || e);
      return { status: 'error', detail: process.env.DEBUG === 'true' ? String(e?.message || e) : undefined };
    }
  }

  @Post('submit')
  async submit(
    @Query() q: any,
    @Body() b: { product_id: string; order_id?: string; rating: number; body: string; images?: string[] },
  ) {
    const customerId = this.verify(q);
    if (!customerId) return { ok: false, error: 'Please log in first.' };

    const rating = Math.round(Number(b.rating));
    const text = String(b.body || '').trim();
    if (!(rating >= 1 && rating <= 5)) return { ok: false, error: 'Invalid rating.' };
    if (text.length < 10 || text.length > 1000) return { ok: false, error: 'Review must be 10–1000 characters.' };
    const images = Array.isArray(b.images) ? b.images.slice(0, MAX_IMAGES) : [];

    const productGid = String(b.product_id).startsWith('gid://') ? String(b.product_id) : `gid://shopify/Product/${b.product_id}`;

    try {
      // Server-side dobara verify (frontend pe bharosa nahi)
      const s = await this.state(customerId);
      const decision: any = this.decide(s, productGid);
      if (decision.status !== 'ok') return { ok: false, error: 'You are not eligible to review this product.' };
      const item: Item | undefined = decision.items.find(
        (i: Item) => i.productId === productGid && (!b.order_id || i.orderId === b.order_id),
      );
      if (!item) return { ok: false, error: 'This purchase is not eligible for a review.' };

      const fileIds = await Promise.all(images.map((im, i) => this.uploadImage(im, i)));

      const approved = process.env.AUTO_APPROVE !== 'false' && !(fileIds.length && process.env.MODERATE_IMAGES === 'true');
      const fields: { key: string; value: string }[] = [
        { key: 'product', value: productGid },
        { key: 'order_id', value: item.orderId },
        { key: 'author_name', value: s.name },
        { key: 'rating', value: String(rating) },
        { key: 'body', value: text },
        { key: 'customer_id', value: customerId },
        { key: 'approved', value: approved ? 'true' : 'false' },
      ];
      if (fileIds.length) fields.push({ key: 'images', value: JSON.stringify(fileIds) });

      const create = (f: { key: string; value: string }[]) =>
        this.gql(
          `mutation($m:MetaobjectCreateInput!){ metaobjectCreate(metaobject:$m){ metaobject{ id handle } userErrors{ message } } }`,
          { m: { type: 'product_reviews', fields: f } },
        );
      const today = new Date().toISOString().slice(0, 10);
      let data = await create([...fields, { key: 'review_date', value: today }]);
      if (data.metaobjectCreate.userErrors?.length) {
        // review_date field abhi definition me nahi hai to bina date ke dobara try
        data = await create(fields);
      }
      const errs = data.metaobjectCreate.userErrors;
      if (errs?.length) return { ok: false, error: errs[0].message };

      return { ok: true, approved, review: { name: s.name, rating, body: text, handle: data.metaobjectCreate.metaobject?.handle } };
    } catch (e: any) {
      console.error('submit error:', e?.message || e);
      return { ok: false, error: process.env.DEBUG === 'true' ? String(e?.message || e) : 'Server error. Please try again later.' };
    }
  }

  @Get('list')
  async list(@Query() q: any) {
    if (q.signature && process.env.DEBUG !== 'true') {
      try {
        this.verify(q);
      } catch (err: any) {
        console.warn('Proxy signature check note for list endpoint:', err?.message);
      }
    }

    const rawId = String(q.product_id || '').trim();
    if (!rawId) return { ok: false, error: 'product_id is required', reviews: [], total: 0 };

    const productGid = rawId.startsWith('gid://') ? rawId : `gid://shopify/Product/${rawId}`;
    const numericId = rawId.replace(/^gid:\/\/shopify\/Product\//, '');

    try {
      const queryStr = `fields.product:'${productGid}'`;
      const gqlQueryWithRefs = `
        query($q: String!, $after: String) {
          metaobjects(type: "product_reviews", query: $q, first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              handle
              fields {
                key
                value
                references(first: 5) {
                  nodes {
                    ... on MediaImage {
                      id
                      image {
                        url
                        width
                        height
                      }
                    }
                    ... on GenericFile {
                      id
                      url
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const nodes: any[] = [];
      let after: string | null = null;
      let hasNextPage = true;
      let pages = 0;
      let useRefs = true;

      while (hasNextPage && pages < 4) {
        pages++;
        let data: any;
        if (useRefs) {
          try {
            data = await this.gql(gqlQueryWithRefs, { q: queryStr, after });
          } catch (e: any) {
            useRefs = false;
          }
        }

        if (!useRefs) {
          const gqlSimple = `
            query($q: String!, $after: String) {
              metaobjects(type: "product_reviews", query: $q, first: 250, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  handle
                  fields {
                    key
                    value
                  }
                }
              }
            }
          `;
          try {
            data = await this.gql(gqlSimple, { q: queryStr, after });
          } catch (e2) {
            // If fields.product query syntax fails, fallback to full-text search on GID
            data = await this.gql(gqlSimple, { q: `"${productGid}"`, after });
          }
        }

        const fetched = data?.metaobjects?.nodes || [];
        nodes.push(...fetched);
        hasNextPage = Boolean(data?.metaobjects?.pageInfo?.hasNextPage);
        after = data?.metaobjects?.pageInfo?.endCursor || null;
      }

      const reviews: any[] = [];
      const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      let sum = 0;
      const allPhotos: string[] = [];

      for (const n of nodes) {
        const getField = (k: string) => n.fields?.find((f: any) => f.key === k);
        const getVal = (k: string) => getField(k)?.value || '';

        const prod = getVal('product');
        if (prod && prod !== productGid && prod !== numericId && !prod.endsWith(`/${numericId}`)) {
          continue;
        }

        const approved = getVal('approved');
        if (approved !== 'true' && approved !== true) {
          continue;
        }

        let rating = parseInt(getVal('rating'), 10);
        if (isNaN(rating) || rating < 1) rating = 5;
        if (rating > 5) rating = 5;

        dist[rating] = (dist[rating] || 0) + 1;
        sum += rating;

        const imgsField = getField('images');
        const images: { thumb: string; full: string }[] = [];
        if (imgsField?.references?.nodes?.length) {
          for (const ref of imgsField.references.nodes) {
            const u = ref.image?.url || ref.url;
            if (u) {
              images.push({ thumb: u, full: u });
              if (allPhotos.length < 12) allPhotos.push(u);
            }
          }
        } else if (imgsField?.value) {
          try {
            const parsed = JSON.parse(imgsField.value);
            if (Array.isArray(parsed)) {
              for (const u of parsed) {
                if (typeof u === 'string' && u.startsWith('http')) {
                  images.push({ thumb: u, full: u });
                  if (allPhotos.length < 12) allPhotos.push(u);
                }
              }
            }
          } catch (_) {}
        }

        const orderId = getVal('order_id');
        const isVerified = Boolean(orderId && (orderId.includes('gid://shopify/Order') || orderId === 'verified'));

        reviews.push({
          id: n.id,
          author_name: getVal('author_name') || 'Customer',
          rating,
          body: getVal('body') || '',
          review_date: getVal('review_date') || '',
          verified: isVerified,
          images,
        });
      }

      reviews.sort((a, b) => {
        if (!a.review_date) return 1;
        if (!b.review_date) return -1;
        return b.review_date.localeCompare(a.review_date);
      });

      const total = reviews.length;
      const avg = total > 0 ? Math.round((sum / total) * 10) / 10 : 0;

      return {
        ok: true,
        total,
        average: avg,
        distribution: dist,
        photos: allPhotos,
        reviews,
      };
    } catch (e: any) {
      console.error('list reviews error:', e?.message || e);
      return { ok: false, error: e?.message || 'Server error', reviews: [], total: 0 };
    }
  }
}
