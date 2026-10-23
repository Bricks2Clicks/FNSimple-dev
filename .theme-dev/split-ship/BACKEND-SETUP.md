# Split shipping: backend setup (Flow, Zapier, Monday)

Status: documented only, not yet built. Theme side is live on fnsimple-dev.

## What the storefront produces

When a cart has at least one `One Week Item` product and one `Non Stock Item` product, the customer must choose:

| Choice | Cart attribute `Shipment preference` | Extra line item |
| --- | --- | --- |
| Split Shipping (+$5) | `Split shipping` | 1 x fee product, SKU `FNS-SPLIT-SHIP`, $5 |
| Ship Together (Free) | `Ship together` | none |

Both are on the order the moment it is created:

- The cart attribute becomes an order **note attribute** (admin: order page, "Additional details"; Admin API: `Order.customAttributes`).
- The fee is a normal **line item**.

Source of truth for fulfillment is the **fee line item**, not the attribute. A paid `FNS-SPLIT-SHIP` line means the customer paid to split. Accelerated checkouts (Shop Pay, Apple Pay, Google Pay) can drop cart attributes; the theme hides those buttons until a choice is saved, but the fee line is still the safer signal.

## 1. Fee product (admin, both stores)

- Set the fee variant SKU to `FNS-SPLIT-SHIP`.
- Keep: $5, not taxable, does not require shipping, inventory not tracked, vendor not `One Week Item` / `Non Stock Item`, unlisted.
- The theme uses the fee **variant id**, which differs per store. When the product is recreated on live, put the new variant id in `snippets/split-ship-fee-id.liquid` (the only place it lives).
  - Variant id: open the product in admin, add `.json` to the admin product URL, read `variants[0].id`.

## 2. Order metafield definition (admin)

Settings > Custom data > Orders > Add definition:

| Name | Namespace and key | Type | Validation |
| --- | --- | --- | --- |
| Shipment preference | `fns.shipment_preference` | Single line text | Limit to preset choices: `split`, `together` |

Notes:
- Line items cannot hold metafields. The Admin API `MetafieldOwnerType` enum (2026-10) has `ORDER`, `PRODUCT` and `PRODUCTVARIANT`, but no line item. Per-item routing uses each line item's own `vendor` and `sku`, which are already on the order.
- Order tags cannot be written at checkout; they can only be added after the order exists (Flow).

## 3. Flow workflow

Name: `Split shipping: tag and flag order`

1. **Trigger:** Order created.
2. **Condition A:** Order line items, at least one where SKU is equal to `FNS-SPLIT-SHIP`.
   - **Then:**
     - Action **Add order tags**: `split-shipment`
     - Action **Update order metafield**: namespace `fns`, key `shipment_preference`, value `split`
3. **Otherwise, condition B:** Order line items, at least one where Vendor is equal to `One Week Item`, **and** at least one where Vendor is equal to `Non Stock Item`.
   - **Then:**
     - Action **Add order tags**: `ship-together`
     - Action **Update order metafield**: namespace `fns`, key `shipment_preference`, value `together`
4. **Optional review check** (separate condition after A/B): Custom attributes, at least one where Key is `Shipment preference` and Value is `Split shipping`, **and** no line item with SKU `FNS-SPLIT-SHIP`.
   - **Then:** Add order tags `shipment-preference-review`

Check the exact condition and action labels in your Flow editor; they can be worded slightly differently from the above.

Orders that are not mixed get no tag and no metafield; they ship as one order as today.

## 4. Zapier to Monday

The Zap already sends every Shopify order to Monday. Add one field: **Split shipment** (Yes / No).

**How the Zap decides Split shipment = Yes** (use data present at order creation, so there is no race with Flow):

- Primary: any line item SKU equals `FNS-SPLIT-SHIP`.
- Backup: note attribute `Shipment preference` equals `Split shipping`.

Do not rely on the Flow tag or metafield in the Zap: a "new order" Zap can run before Flow has written them.

**Before building:** open a recent order in the existing Zap's sample data and confirm these fields are exposed:
- line item SKU and line item vendor
- note attributes (name and value)
- tags

Metafields are usually not included in Zapier's order data.

## 5. Monday cubby rules

| Split shipment | Cubbies | Which line items |
| --- | --- | --- |
| Yes | 2 | Cubby A: vendor `One Week Item`. Cubby B: vendor `Non Stock Item`. |
| No | 1 | All items. |

- Never assign the fee line (SKU `FNS-SPLIT-SHIP`) to a cubby; it does not ship.
- Vendor values are exact strings: `One Week Item`, `Non Stock Item`.

## 6. Message for Alex (ready to forward)

> Every order now carries the customer's shipping choice in data that is there from the moment the order is placed:
>
> 1. **Split orders contain a $5 "Split Shipping" line item with SKU `FNS-SPLIT-SHIP`.** This is the reliable signal: if the SKU is on the order, the customer paid to split.
> 2. **The order also records the choice as "Shipment preference: Split shipping" or "Ship together"** under Additional details.
> 3. **Each product line already carries its vendor** (`One Week Item` or `Non Stock Item`), which tells Monday which cubby each item belongs in.
>
> Zapier will pass a "Split shipment: Yes/No" field to Monday based on the SKU. Monday then assigns two cubbies for split orders (one-week items in one, non-stock items in the other) and one cubby otherwise.
>
> Shopify Flow also adds a `split-shipment` or `ship-together` tag and an order field (`fns.shipment_preference`) so staff can filter orders in Shopify. These are for people; the automation reads the SKU and vendors.
>
> Shopify does not support custom fields on individual line items, so line-level routing uses the vendor on each line rather than a separate field.

## 7. Optional later

- Packing slip and order confirmation email: print the preference only when the value is exactly `Split shipping` or `Ship together` (allowlist), never raw attribute text.
